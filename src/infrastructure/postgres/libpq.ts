/**
 * The PostgreSQL client tools (pg_dump for backups, pg_restore for restore.js, 2.46.0) and the
 * libpq environment they connect with. A URL or password never enters a tool's argv, where any
 * process on the machine can read it: the connection travels in the child's environment, which is
 * built from scratch rather than copied from process.env, so the bot's own settings (the Discord
 * token, MODMAIL_KEY) never reach the tool.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseIdentity } from "../../config/deployment.js";
import { Failure } from "../../domain/values.js";

/** Which tool is connecting, for pg_stat_activity's application_name. */
export type ClientApplication = "tarubot-backup" | "tarubot-restore";

/** One database to connect a tool to: its URL, the setting it came from, and its CA, if any. */
export interface ToolDatabase {
  readonly url: string;
  /** The setting's name, the only thing a refusal names. */
  readonly setting: string;
  /** The provider's CA certificate (PEM); empty or unset means none. */
  readonly ca: string | undefined;
}

/**
 * The sslmode values a URL may name: libpq's own, plus node-postgres's no-verify (encrypted, not
 * verified; libpq's require). Anything else is refused rather than passed on.
 */
const SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
  "no-verify",
];

/** The CA setting that goes with a URL setting, for refusals that need one. */
const caSetting = (setting: string): string =>
  setting === "RESTORE_DATABASE_URL"
    ? "RESTORE_DATABASE_CA_CERT (or DATABASE_CA_CERT)"
    : "DATABASE_CA_CERT";

/**
 * The child environment for one tool run: the URL's parts as libpq variables (decoded), a 10 s
 * connect timeout and the application name, plus only PATH, HOME and TMPDIR from this process.
 * `rootCert` is the path of the CA file when there is one: then verify-full, whatever TLS the URL
 * names, as the bot's own pool does (connection.ts). Refusals name the setting, never a value.
 *
 * Without a CA the tool must connect wherever the bot's driver (node-postgres) does, or a backup
 * fails, and with it every migrating start, where the bot itself connects fine. The URL never
 * reaches the tool (its parts travel as variables), so its TLS parameters are translated:
 * sslrootcert, sslcert and sslkey become PGSSLROOTCERT, PGSSLCERT and PGSSLKEY (the bot reads the
 * same files); node-postgres's no-verify becomes libpq's require, without a root certificate
 * (libpq verifies the chain whenever one is named, and no-verify verifies nothing); verify-full
 * with no sslrootcert checks against the system's roots (PGSSLROOTCERT=system: libpq 16 and later
 * with the image's CA bundle), where node-postgres uses Node's; verify-ca with no sslrootcert is
 * refused, as libpq can't check it against the system's roots. disable, allow, prefer and require
 * keep libpq's meaning, which never asks more of the server than node-postgres does (it reads
 * those as verify-full), and an absent sslmode leaves libpq's default.
 */
export function libpqEnvironment(
  database: ToolDatabase,
  application: ClientApplication,
  rootCert: string | null,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  // Refuses host, port, user and database parameters that would redirect the connection.
  const target = databaseIdentity(database.url, database.setting);
  let password: string;
  let tls: Record<"sslmode" | "sslrootcert" | "sslcert" | "sslkey", string | null>;
  try {
    const endpoint = new URL(database.url);
    password = decodeURIComponent(endpoint.password);
    const parameter = (name: string) => endpoint.searchParams.get(name) || null;
    tls = {
      sslmode: endpoint.searchParams.get("sslmode"),
      sslrootcert: parameter("sslrootcert"),
      sslcert: parameter("sslcert"),
      sslkey: parameter("sslkey"),
    };
  } catch {
    // A malformed escape: the error itself carries no value, but say only which setting.
    throw new Failure("configuration", `${database.setting} must be a PostgreSQL URL.`);
  }
  const { sslmode } = tls;
  if (rootCert === null && sslmode !== null && !SSL_MODES.includes(sslmode))
    throw new Failure("configuration", `${database.setting} names an sslmode libpq doesn't know.`);
  if (rootCert === null && sslmode === "verify-ca" && tls.sslrootcert === null)
    throw new Failure(
      "configuration",
      `${database.setting} names sslmode=verify-ca without sslrootcert, which pg_dump and pg_restore can't check against the system's roots. Set ${caSetting(database.setting)} to the provider's CA certificate, or name sslrootcert in the URL.`,
    );
  const environment: Record<string, string> = {
    PATH: inherited.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGDATABASE: target.name,
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: application,
  };
  // A URL without a user or password leaves libpq's own defaults, as node-postgres does.
  if (target.user) environment.PGUSER = target.user;
  if (password) environment.PGPASSWORD = password;
  for (const name of ["HOME", "TMPDIR"] as const) {
    const value = inherited[name];
    if (value) environment[name] = value;
  }
  if (rootCert !== null) {
    environment.PGSSLMODE = "verify-full";
    environment.PGSSLROOTCERT = rootCert;
    return environment;
  }
  if (tls.sslcert !== null) environment.PGSSLCERT = tls.sslcert;
  if (tls.sslkey !== null) environment.PGSSLKEY = tls.sslkey;
  if (sslmode === "no-verify") {
    environment.PGSSLMODE = "require";
    return environment;
  }
  if (sslmode !== null) environment.PGSSLMODE = sslmode;
  if (tls.sslrootcert !== null) environment.PGSSLROOTCERT = tls.sslrootcert;
  else if (sslmode === "verify-full") environment.PGSSLROOTCERT = "system";
  return environment;
}

/**
 * Run `use` with a tool's environment. A CA is written to a private file (a fresh 0700 directory
 * under the temporary directory, the file 0600), since libpq reads it only from a file, and removed
 * afterwards whatever `use` did. The managed manifests mount a small tmpfs at /tmp for it, as the
 * container's root filesystem is read-only.
 */
export async function withLibpq<T>(
  database: ToolDatabase,
  application: ClientApplication,
  use: (environment: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!database.ca) return await use(libpqEnvironment(database, application, null));
  const directory = await mkdtemp(join(tmpdir(), "tarubot-libpq-"));
  try {
    const rootCert = join(directory, "root.crt");
    await writeFile(rootCert, database.ca, { mode: 0o600, flag: "wx" });
    return await use(libpqEnvironment(database, application, rootCert));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One running client tool. Its standard error goes to this process's, never into a log record. */
export interface ToolProcess {
  /** The tool's standard output when it was asked for (pg_dump's archive), else null. */
  readonly stdout: ReadableStream<Uint8Array> | null;
  /** Its exit status; a signal counts as a failure. */
  readonly exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/**
 * Start a tool: with `stdin` it reads that stream and its output is left on this process's
 * (pg_restore); without, its output is piped back (pg_dump). Tests pass a double.
 */
export type RunTool = (
  command: readonly string[],
  options: { env: Readonly<Record<string, string>>; stdin?: ReadableStream<Uint8Array> },
) => ToolProcess;

/** The tool runner used outside tests. */
export const runTool: RunTool = (command, { env, stdin }) => {
  if (stdin) {
    const child = Bun.spawn([...command], { env, stdin, stdout: "inherit", stderr: "inherit" });
    return { stdout: null, exited: child.exited, kill: (signal) => child.kill(signal) };
  }
  const child = Bun.spawn([...command], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  return { stdout: child.stdout, exited: child.exited, kill: (signal) => child.kill(signal) };
};
