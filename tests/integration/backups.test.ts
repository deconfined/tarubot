/**
 * A real backup and restore (2.46.0): pg_dump of a migrated database streamed through age into
 * storage (in memory, with S3's all-or-nothing contract), then restore.js's database restore with
 * pg_restore into a second, empty database, its closing statements included, and the settings
 * copy opened again. pg_dump refuses a server newer than itself, so this needs PostgreSQL client
 * tools at least as new as the test server: the image carries Alpine's postgresql18-client, so
 * the Docker test stage (bun run test:docker) runs it, and CI's Checks job installs PostgreSQL
 * 18's client from PGDG, so it runs there too; a host with older tools skips it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { RESTORED_ROLE_JOBS_SQL, takeBackup } from "../../src/application/backups.js";
import { Database, SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";
import { restoreDatabase, restoreSettings } from "../../scripts/restore.js";
import { MemoryStorage } from "../fixtures/backups.js";

const url = process.env.TEST_DATABASE_URL;
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

/** A client tool's major version, or null when it isn't installed. */
function clientMajor(tool: string): number | null {
  if (!Bun.which(tool)) return null;
  const output = Bun.spawnSync([tool, "--version"], { stdin: "ignore" }).stdout.toString();
  const major = /\b(\d+)(?:\.\d+)?/u.exec(output)?.[1];
  return major ? Number(major) : null;
}

/** Whether this machine's pg_dump and pg_restore can work against the test server. */
async function toolsMatch(): Promise<boolean> {
  if (!url) return false;
  const probe = new Database(url, "");
  try {
    const [row] = await probe.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    const server = Math.floor(Number(row?.version ?? 0) / 10000);
    const tools = [clientMajor("pg_dump"), clientMajor("pg_restore")];
    return tools.every((major) => major !== null && major >= server);
  } finally {
    await probe.close();
  }
}
const usable = await toolsMatch();

describe.skipIf(!usable)("a real backup restores into an empty database", () => {
  if (!url || !usable) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url, "");
  const SOURCE = "tarubot_backup_source_test";
  const TARGET = "tarubot_backup_target_test";
  const at = (name: string) => {
    const endpoint = new URL(url);
    endpoint.pathname = `/${name}`;
    return endpoint.toString();
  };
  let source: Database;
  let target: Database;
  let identity = "";
  let recipient = "";

  beforeAll(async () => {
    for (const name of [SOURCE, TARGET]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
    }
    source = new Database(at(SOURCE), "");
    target = new Database(at(TARGET), "");
    identity = await generateIdentity();
    recipient = await identityToRecipient(identity);
    await source.migrate(directory);
    // Invented rows, among them what a restore must close: a web session and a waiting role job.
    await source.query("INSERT INTO guilds (id) VALUES ('500001')");
    await source.query("INSERT INTO users (id) VALUES ('600001')");
    await source.query(
      `INSERT INTO web_sessions (token_hash, user_id, expires_at)
       VALUES ($1, '600001', now() + interval '1 day')`,
      ["a".repeat(64)],
    );
    await source.query(
      `INSERT INTO jobs (kind, guild_id, user_id, payload, dedupe_key, status) VALUES
         ('roles.self', '500001', '600001', '{"add":["700001"]}', 'self-roles:500001:600001', 'queued'),
         ('reconcile.guild', '500001', NULL, '{}', 'guild:500001', 'queued')`,
    );
  });
  afterAll(async () => {
    await source?.close();
    await target?.close();
    for (const name of [SOURCE, TARGET])
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close();
  });

  test("pg_dump, age and the upload, then pg_restore and the closing statements", async () => {
    const storage = new MemoryStorage();
    const stored = await takeBackup(
      {
        DATABASE_URL: at(SOURCE),
        BACKUP_STORAGE_ENDPOINT: "backups.example.org",
        BACKUP_STORAGE_ACCESS_KEY: "invented-access-key",
        BACKUP_STORAGE_SECRET_KEY: "invented-secret-key",
        BACKUP_STORAGE_REGION: "us-east-1",
        BACKUP_AGE_RECIPIENTS: recipient,
        MODMAIL_KEY: "invented-modmail-key",
      },
      { storage: () => storage, now: () => new Date("2026-11-01T03:00:00Z") },
    );
    expect(stored.daily.key).toBe("daily/tarubot-20261101T030000Z.dump.age");
    expect(stored.monthly?.bytes).toBe(stored.daily.bytes);
    expect([...storage.objects.keys()].sort()).toEqual([
      "daily/tarubot-20261101T030000Z.dump.age",
      "env/tarubot-env-20261101T030000Z.age",
      "monthly/tarubot-20261101T030000Z.dump.age",
    ]);

    const restored = await restoreDatabase({
      storage,
      key: stored.daily.key,
      identities: [identity],
      target: { url: at(TARGET), setting: "RESTORE_DATABASE_URL", ca: "" },
      db: target,
    });
    expect(restored).toMatchObject({ schema: SCHEMA_VERSION, webSessions: 1, roleJobs: 1 });
    // The restored database is one this build starts on, checksums included.
    await target.schema();
    // Every table's rows match, except the two the closing statements change.
    const tables = await source.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    expect(
      await target.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      ),
    ).toEqual(tables);
    for (const { tablename } of tables.filter(
      ({ tablename }) => !["jobs", "web_sessions"].includes(tablename),
    )) {
      const sql = `SELECT count(*)::text AS rows, md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS checksum FROM public."${tablename}" t`;
      expect({ tablename, rows: await target.query(sql) }).toEqual({
        tablename,
        rows: await source.query(sql),
      });
    }
    expect(await target.query("SELECT * FROM web_sessions")).toEqual([]);
    expect(
      await target.query("SELECT kind, status, payload, result FROM jobs ORDER BY kind"),
    ).toEqual([
      { kind: "reconcile.guild", status: "queued", payload: {}, result: null },
      // Closed by RESTORED_ROLE_JOBS_SQL; migration 012's trigger cleared the choice.
      { kind: "roles.self", status: "succeeded", payload: {}, result: { skipped: "restored" } },
    ]);
    expect(RESTORED_ROLE_JOBS_SQL).toContain("WHERE kind='roles.self'");

    // A second restore into the same, no longer empty, database is refused before pg_restore.
    await expect(
      restoreDatabase({
        storage,
        key: stored.daily.key,
        identities: [identity],
        target: { url: at(TARGET), setting: "RESTORE_DATABASE_URL", ca: "" },
        db: target,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // The settings copy opens to the settings the backup ran with.
    const settings = new TextDecoder().decode(
      await restoreSettings(storage, stored.env.key, [identity]),
    );
    expect(settings).toContain("MODMAIL_KEY='invented-modmail-key'");
    expect(settings).toContain(`DATABASE_URL='${at(SOURCE)}'`);
  });
});
