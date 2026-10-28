/**
 * Restore from the encrypted offsite backups (2.46.0), run as a one-off container of the bot's own
 * image with the backup storage settings (credentials that can list and read):
 *
 *   docker compose run --rm -T tarubot bun dist/scripts/restore.js list [daily|monthly|env]
 *   docker compose run --rm -T tarubot bun dist/scripts/restore.js database KEY|latest < identity
 *   docker compose run --rm -T tarubot bun dist/scripts/restore.js settings KEY|latest < identity
 *
 * `list` prints keys and sizes, newest first. `database` restores a daily or monthly dump into the
 * empty database RESTORE_DATABASE_URL names (CA RESTORE_DATABASE_CA_CERT, else DATABASE_CA_CERT),
 * after the deployment guard's restore-target rules, the ones check-restore.js uses; it refuses a
 * target whose public schema already has tables. pg_restore runs as one transaction, so a failure
 * leaves the target empty. It then runs the two statements every restored database needs before a
 * bot starts on it, in one transaction: every web session is deleted (signed-in browsers sign in
 * again) and roles.self jobs the backup caught waiting are closed (RESTORED_ROLE_JOBS_SQL).
 * `settings` writes a decrypted settings copy (env/) to standard output. `latest` is the newest
 * daily dump, or the newest settings copy.
 *
 * The age identity (AGE-SECRET-KEY-1... lines; # comments allowed) is read from standard input
 * only, never from an argument or a setting, so it stays out of argv, the environment and logs.
 */
import { Decrypter } from "age-encryption";
import {
  DUMP_KEY,
  RESTORED_ROLE_JOBS_SQL,
  SETTINGS_KEY,
  storageSettings,
} from "../src/application/backups.js";
import {
  assertToolScope,
  databaseIdentity,
  type Environment,
  restoreCertificate,
  type ToolScope,
} from "../src/config/deployment.js";
import { Failure } from "../src/domain/values.js";
import {
  type BackupStorage,
  S3BackupStorage,
  type StoredObject,
} from "../src/infrastructure/backup/storage.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import {
  type RunTool,
  runTool,
  type ToolDatabase,
  type ToolProcess,
  withLibpq,
} from "../src/infrastructure/postgres/libpq.js";

export type RestoreGroup = "daily" | "monthly" | "env";

/** A parsed invocation. */
export type RestoreMode =
  | { kind: "list"; group: RestoreGroup | null }
  | { kind: "database" | "settings"; key: string | "latest" };

export const RESTORE_USAGE = [
  "Use: restore.js list [daily|monthly|env]",
  "     restore.js database KEY|latest   (the age identity on standard input)",
  "     restore.js settings KEY|latest   (the age identity on standard input)",
].join("\n");

/** Parse the command line strictly; a refusal is Failure("input") and the caller prints the usage. */
export function restoreArguments(argv: readonly string[]): RestoreMode {
  const [kind, target, ...rest] = argv;
  if (rest.length) throw new Failure("input", `Unexpected argument ${rest[0]}.`);
  if (kind === "list") {
    if (target === undefined) return { kind, group: null };
    if (target === "daily" || target === "monthly" || target === "env")
      return { kind, group: target };
    throw new Failure("input", "list takes daily, monthly or env.");
  }
  if (kind === "database" || kind === "settings") {
    if (target === undefined) throw new Failure("input", `${kind} needs a key or latest.`);
    const pattern = kind === "database" ? DUMP_KEY : SETTINGS_KEY;
    if (target !== "latest" && !pattern.test(target))
      throw new Failure(
        "input",
        kind === "database"
          ? "database takes a daily/ or monthly/ dump key, or latest."
          : "settings takes an env/ settings copy key, or latest.",
      );
    return { kind, key: target };
  }
  throw new Failure("input", kind === undefined ? "Name what to do." : `Unknown mode ${kind}.`);
}

/**
 * The deployment guard's view: a database restore touches DATABASE_URL's identity and the
 * RESTORE_DATABASE_URL target under check-restore.js's rules (a production target is tarubot on a
 * PITR fork or tarubot_restore beside the primary; staging, which resets in place, has none);
 * listing and settings copies touch no database. Exported so tests check exactly what is declared.
 */
export function restoreToolScope(mode: RestoreMode): ToolScope {
  return {
    tool: `restore ${mode.kind}`,
    guilds: [],
    discord: "none",
    databases: mode.kind === "database" ? ["DATABASE_URL", "RESTORE_DATABASE_URL"] : [],
  };
}

/** An X25519 age identity: its Bech32 body is 58 characters. */
const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/u;

/**
 * The identities in standard input's text: every line that isn't blank or a # comment. Refusals
 * never repeat a line, since any of them may be a key.
 */
export function ageIdentities(text: string): string[] {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length)
    throw new Failure(
      "input",
      "Pass the age identity (AGE-SECRET-KEY-1... lines) on standard input; it is never read from an argument or a setting.",
    );
  const invalid = lines.findIndex((line) => !IDENTITY.test(line));
  if (invalid >= 0)
    throw new Failure(
      "input",
      `Standard input's non-comment line ${invalid + 1} is not an age identity (AGE-SECRET-KEY-1...).`,
    );
  return lines;
}

/** Objects in one group whose keys are backup keys, newest first (the stamp sorts by time). */
export function newestFirst(objects: readonly StoredObject[], group: RestoreGroup): StoredObject[] {
  const pattern = group === "env" ? SETTINGS_KEY : DUMP_KEY;
  return objects
    .filter(({ key }) => key.startsWith(`${group}/`) && pattern.test(key))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** The object a key or `latest` names: latest is the newest daily dump or settings copy. */
export async function chooseObject(
  storage: BackupStorage,
  kind: "database" | "settings",
  key: string | "latest",
): Promise<StoredObject> {
  const group: RestoreGroup =
    key === "latest"
      ? kind === "database"
        ? "daily"
        : "env"
      : (key.split("/")[0] as RestoreGroup);
  const found = newestFirst(await storage.list(`${group}/`), group);
  const chosen = key === "latest" ? found[0] : found.find((object) => object.key === key);
  if (!chosen)
    throw new Failure(
      "not_found",
      key === "latest"
        ? `There is no ${group}/ backup in storage.`
        : `There is no ${key} in storage.`,
    );
  return chosen;
}

/** A decrypter for the given identities; age-encryption checks each one's encoding too. */
function decrypter(identities: readonly string[]): Decrypter {
  const result = new Decrypter();
  try {
    for (const identity of identities) result.addIdentity(identity);
  } catch {
    throw new Failure("input", "An identity on standard input is not a valid age identity.");
  }
  return result;
}

/** Open an object with the identities; refusals name the key, never the identity. */
async function open(
  storage: BackupStorage,
  key: string,
  identities: readonly string[],
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await decrypter(identities).decrypt(storage.get(key));
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(
      "input",
      `${key} could not be opened: it was not encrypted to an identity given on standard input, or it could not be read.`,
    );
  }
}

/** A settings copy's plaintext. */
export async function restoreSettings(
  storage: BackupStorage,
  key: string,
  identities: readonly string[],
): Promise<Uint8Array> {
  const plain = await open(storage, key, identities);
  try {
    return new Uint8Array(await new Response(plain).arrayBuffer());
  } catch {
    throw new Failure(
      "input",
      `${key} could not be read to the end or failed its integrity check.`,
    );
  }
}

/** What a database restore did. */
export interface RestoredDatabase {
  key: string;
  /** The target's host and database name (never its user or password). */
  target: string;
  /** The restored schema head (schema_migrations' newest version). */
  schema: string | null;
  /** Web sessions deleted, or null when the dump predates the table. */
  webSessions: number | null;
  /** roles.self jobs closed. */
  roleJobs: number;
}

/**
 * The statements every restored database needs before a bot starts on it, in one transaction:
 * delete every web session (a restored row could sign a browser back in as someone it no longer
 * should be), and close the roles.self jobs the backup caught waiting.
 */
export async function closeRestoredDatabase(
  db: Pick<Database, "transaction">,
): Promise<{ webSessions: number | null; roleJobs: number }> {
  return await db.transaction(async (client) => {
    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.web_sessions') IS NOT NULL AS present",
    );
    const webSessions = table.rows[0]?.present
      ? ((await client.query("DELETE FROM web_sessions")).rowCount ?? 0)
      : null;
    const roleJobs = (await client.query(RESTORED_ROLE_JOBS_SQL)).rowCount ?? 0;
    return { webSessions, roleJobs };
  });
}

/**
 * Restore one dump into an empty target. pg_restore reads the decrypted stream as one transaction
 * and stops at the first error; if the download or decryption fails part-way, pg_restore is killed
 * before it can reach the end of its input, so it never commits a partial restore.
 */
export async function restoreDatabase(input: {
  storage: BackupStorage;
  key: string;
  identities: readonly string[];
  target: ToolDatabase;
  /** A connection to the same target, for the emptiness check and the closing statements. */
  db: Pick<Database, "query" | "transaction">;
  runTool?: RunTool;
}): Promise<RestoredDatabase> {
  const identity = databaseIdentity(input.target.url, input.target.setting);
  const where = `${identity.host}/${identity.name}`;
  const tables = await input.db.query<{ tables: number }>(
    "SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'",
  );
  if ((tables[0]?.tables ?? 0) > 0)
    throw new Failure(
      "conflict",
      `${input.target.setting} (${where}) already has tables in its public schema; restore into an empty database.`,
    );
  const plain = await open(input.storage, input.key, input.identities);
  const reader = plain.getReader();
  const state = { child: null as ToolProcess | null, broken: false };
  const archive = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // Killed before it sees the end of its input, so its one transaction never commits.
        state.broken = true;
        state.child?.kill("SIGKILL");
        controller.error(error);
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
  const status = await withLibpq(input.target, "tarubot-restore", async (env) => {
    const command = [
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
      // The database by name only (conninfo-quoted); the connection comes from the environment.
      `--dbname=dbname='${identity.name.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`,
    ];
    let child: ToolProcess;
    try {
      child = (input.runTool ?? runTool)(command, { env, stdin: archive });
    } catch {
      throw new Failure("unavailable", "pg_restore could not be started.");
    }
    state.child = child;
    if (state.broken) child.kill("SIGKILL");
    return await child.exited;
  });
  if (state.broken)
    throw new Failure(
      "incomplete",
      `${input.key} could not be read to the end or failed its integrity check; pg_restore was stopped, so ${where} is still empty.`,
    );
  if (status !== 0)
    throw new Failure(
      "incomplete",
      `pg_restore exited with status ${status}; it ran as one transaction, so ${where} is still empty.`,
    );
  const closed = await closeRestoredDatabase(input.db);
  const head = await input.db.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  );
  return { key: input.key, target: where, schema: head[0]?.version ?? null, ...closed };
}

/** The storage restore.js reads, from the backup storage settings alone. */
function storage(env: Environment): BackupStorage {
  const settings = storageSettings(env);
  if (settings === null)
    throw new Failure(
      "configuration",
      "BACKUP_STORAGE_ENDPOINT is empty; restore.js needs the backup storage settings.",
    );
  if ("problems" in settings)
    throw new Failure(
      "configuration",
      `These backup storage settings are missing or invalid: ${settings.problems.join(", ")}.`,
    );
  return new S3BackupStorage(settings.storage);
}

if (import.meta.main) {
  let mode: RestoreMode;
  try {
    mode = restoreArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : "Unreadable arguments."}\n${RESTORE_USAGE}`,
    );
    process.exit(2);
  }
  // Both databases (for a restore) must belong to this env's deployment profile first.
  assertToolScope(process.env, restoreToolScope(mode));
  const bucket = storage(process.env);
  if (mode.kind === "list") {
    for (const group of mode.group ? [mode.group] : (["daily", "monthly", "env"] as const))
      for (const { key, size } of newestFirst(await bucket.list(`${group}/`), group))
        console.log(`${key}\t${size}`);
  } else {
    const identities = ageIdentities(await Bun.stdin.text());
    const { key } = await chooseObject(bucket, mode.kind, mode.key);
    if (mode.kind === "settings")
      process.stdout.write(await restoreSettings(bucket, key, identities));
    else {
      const url = process.env.RESTORE_DATABASE_URL ?? "";
      const ca = restoreCertificate(process.env);
      const db = new Database(url, ca ?? "");
      try {
        const restored = await restoreDatabase({
          storage: bucket,
          key,
          identities,
          target: { url, setting: "RESTORE_DATABASE_URL", ca },
          db,
        });
        console.log(
          `Restored ${restored.key} into ${restored.target}; schema head ${restored.schema ?? "none"}.`,
        );
        console.log(
          `Closed for a restore: ${restored.webSessions ?? 0} web session(s) deleted${restored.webSessions === null ? " (no web_sessions table)" : ""}, ${restored.roleJobs} waiting roles.self job(s) closed.`,
        );
      } finally {
        await db.close();
      }
    }
  }
}
