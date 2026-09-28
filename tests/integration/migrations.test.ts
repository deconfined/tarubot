/**
 * Migration rehearsals (005 through 010) in private PostgreSQL schemas, isolated from
 * persistence.test.ts's public schema: import/activation backfill, the new CHECKs, the
 * guest-application switch, the changelog columns, the status-notice columns, an empty database,
 * and the real migrate() runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import * as t from "../../src/infrastructure/postgres/schema.js";
import {
  Database,
  orm,
  SCHEMA_VERSION,
  SESSION_OPTIONS,
  WRITER_LEASE_LOCK,
} from "../../src/infrastructure/postgres/database.js";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "005_launch_access_policy.sql";
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Migration files in runner order; those before 005 form the schema-004 baseline it upgrades. */
async function migrationFiles(): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
}
async function baseline(): Promise<string[]> {
  return (await migrationFiles()).filter((name) => name < LAUNCH);
}
const migration = (name: string): Promise<string> => Bun.file(join(directory, name)).text();

/** Synthetic guilds covering every history the 005 backfill distinguishes. */
const guild = {
  /** Created by /setup and managed live, never imported: DevBot's shape. */
  devbot: "500001",
  /** Imported under 2.12.x and published, never activated (a rehearsal database). */
  pending: "500002",
  /** Imported and activated: effects on. */
  activated: "500003",
  /** Never imported and effects off, e.g. a guild row created before its first activation. */
  dormant: "500004",
  /** Imported, activated, then switched off again. */
  disabled: "500005",
};
const user = { approved: "600001", manual: "600002", imported: "600003", visitor: "600004" };

describe.skipIf(!url)("migration 005 launch access policy", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  /** One rolled-back transaction whose unqualified migration SQL resolves inside a private schema. */
  async function rehearse(schema: string, body: (client: PoolClient) => Promise<void>) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // Schema names are fixed test constants; the migrations themselves stay unqualified.
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const file of await baseline()) await client.query(await migration(file));
      await body(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  /** Assert a CHECK violation without aborting the surrounding rehearsal transaction. */
  async function checkViolation(client: PoolClient, operation: () => Promise<unknown>) {
    await client.query("SAVEPOINT expected_violation");
    // Drizzle builders are thenables, so adopt them into a Promise; the driver error and its
    // SQLSTATE stay in `cause`.
    await expect(Promise.resolve(operation())).rejects.toMatchObject({ cause: { code: "23514" } });
    await client.query("ROLLBACK TO SAVEPOINT expected_violation");
  }

  test("migration 005 backfills the layout switch and grandfathering marker from import/activation history", async () => {
    await rehearse("m005_rehearsal", async (client) => {
      // Schema-004 rows use SQL: the Drizzle mappings already include the columns 005 adds.
      await client.query(
        `INSERT INTO guilds (id, member_role_id, guest_role_id, officer_role_id, leader_role_id,
           lobby_channel_id, officer_channel_id, access_policy_enabled, effects_enabled, revision)
         VALUES ($1, '700001', '700002', '700003', '700004', '700005', '700006', true, true, 11)`,
        [guild.devbot],
      );
      await client.query(
        "INSERT INTO guilds (id, effects_enabled, revision) VALUES ($1, false, 3), ($2, true, 4), ($3, false, 5), ($4, false, 6)",
        [guild.pending, guild.activated, guild.dormant, guild.disabled],
      );
      await client.query(
        `INSERT INTO audit (guild_id, action, target) VALUES
           ($1, 'migration.import', 'fingerprint'),
           ($2, 'migration.import', 'fingerprint'), ($2, 'activation', $2),
           ($3, 'migration.import', 'fingerprint'), ($3, 'activation', $3),
           ($4, 'config.set', 'guest_role_id')`,
        [guild.pending, guild.activated, guild.disabled, guild.devbot],
      );
      // Existing grants of every schema-004 provenance must survive the CHECK replacement.
      await client.query("INSERT INTO users (id) VALUES ($1), ($2), ($3), ($4)", [
        user.approved,
        user.manual,
        user.imported,
        user.visitor,
      ]);
      await client.query(
        "INSERT INTO guild_users (guild_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4), ($5, $6)",
        [guild.devbot, user.approved, user.manual, user.imported, guild.pending, user.visitor],
      );
      await client.query(
        `INSERT INTO guest_grants (guild_id, user_id, provenance, source_key) VALUES
           ($1, $2, 'approved', 'application:1'), ($1, $3, 'manual', 'manual:1'),
           ($1, $4, 'imported_guest', 'import:1')`,
        [guild.devbot, user.approved, user.manual, user.imported],
      );

      await client.query(await migration(LAUNCH));

      const store = orm(client);
      expect(
        await store
          .select({
            id: t.guilds.id,
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            at: t.guilds.guest_grandfathered_at,
            revision: t.guilds.revision,
          })
          .from(t.guilds)
          .orderBy(asc(t.guilds.id)),
      ).toEqual([
        // DevBot keeps today's layout, is never grandfathered, and keeps its revision.
        { id: guild.devbot, layout: true, marker: null, at: null, revision: 11n },
        { id: guild.pending, layout: false, marker: "pending", at: null, revision: 3n },
        { id: guild.activated, layout: false, marker: null, at: null, revision: 4n },
        { id: guild.dormant, layout: true, marker: null, at: null, revision: 5n },
        { id: guild.disabled, layout: false, marker: null, at: null, revision: 6n },
      ]);
      expect(
        (
          await store
            .select({ provenance: t.guestGrants.provenance })
            .from(t.guestGrants)
            .orderBy(asc(t.guestGrants.provenance))
        ).map((row) => row.provenance),
      ).toEqual(["approved", "imported_guest", "manual"]);
      // The migration writes no audit rows of its own.
      expect(await store.$count(t.auditEvents)).toBe(6);
      // Catalog probe: the replaced inline CHECK keeps its name and now admits 'grandfathered'.
      const definitions = await client.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'guest_grants'::regclass AND conname = 'guest_grants_provenance_check'",
      );
      expect(definitions.rows).toHaveLength(1);
      expect(definitions.rows[0]?.definition).toContain("'grandfathered'");

      // Grandfathered grants are accepted; unknown provenances are still refused. Plain SQL:
      // Drizzle's insert names every mapped column, including those 006 adds. The driver error
      // becomes the cause, as Drizzle's wrapper would carry it.
      const grant = (provenance: string, key: string) =>
        client
          .query(
            "INSERT INTO guest_grants (guild_id, user_id, provenance, source_key) VALUES ($1, $2, $3, $4)",
            [guild.pending, user.visitor, provenance, key],
          )
          .catch((error: unknown) => {
            throw new Error("Insert refused", { cause: error });
          });
      await grant("grandfathered", `grandfather:${guild.pending}:${user.visitor}`);
      await checkViolation(client, () => grant("bogus", `bogus:${guild.pending}:${user.visitor}`));
      // The marker admits only pending/completed, and the timestamp exists exactly when completed.
      const pending = eq(t.guilds.id, guild.pending);
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfather: sql`'started'` }).where(pending),
      );
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfather: "completed" }).where(pending),
      );
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfathered_at: new Date() }).where(pending),
      );
      const completedAt = new Date("2026-09-23T12:00:00Z");
      await store
        .update(t.guilds)
        .set({ guest_grandfather: "completed", guest_grandfathered_at: completedAt })
        .where(pending);
      expect(
        await store
          .select({ marker: t.guilds.guest_grandfather, at: t.guilds.guest_grandfathered_at })
          .from(t.guilds)
          .where(pending),
      ).toEqual([{ marker: "completed", at: completedAt }]);
    });
  });

  test("migration 005 is a no-op on an empty database and the column default keeps the layout on", async () => {
    await rehearse("m005_empty", async (client) => {
      // A multi-statement file yields one result per statement; flat() also accepts a single result.
      const results: QueryResult[] = [await client.query(await migration(LAUNCH))].flat();
      expect(
        results.filter((result) => result.command === "UPDATE").map((result) => result.rowCount),
      ).toEqual([0, 0]);
      // A row inserted without the switch takes the column defaults: layout on, no marker. Since
      // 2.35.0 the application never relies on that default: /config and /setup onboarding insert
      // new guilds with NEW_GUILD_ROW (layout off, CFG-07), and 2.35.0 has no migration.
      // Plain SQL: Drizzle's insert names every mapped column, including those later files add.
      const store = orm(client);
      await client.query("INSERT INTO guilds (id, effects_enabled) VALUES ($1, true)", [
        guild.devbot,
      ]);
      expect(
        await store
          .select({
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            at: t.guilds.guest_grandfathered_at,
          })
          .from(t.guilds),
      ).toEqual([{ layout: true, marker: null, at: null }]);
    });
  });

  test("Database.migrate upgrades a schema-004 database once and then skips every file by checksum", async () => {
    const schema = "m005_runner";
    const staged = await mkdtemp(join(tmpdir(), "tarubot-schema-004-"));
    // A second pool confined to the private schema through its startup options. Connection-string
    // options replace the pool's own, so the Database's UTC and statement-timeout settings are restated.
    const confined = new URL(url);
    confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${schema}`);
    const runner = new Database(confined.toString());
    try {
      // migrate() commits, so this schema is created fresh and always dropped afterwards.
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
      // Fail before migrating if the runner would resolve names anywhere but the private schema.
      expect(await runner.query("SELECT current_schema() AS schema")).toEqual([{ schema }]);
      for (const file of await baseline())
        await copyFile(join(directory, file), join(staged, file));
      await runner.migrate(staged);
      // A 2.13.0 build refuses a schema-004 database until the pending migration is applied.
      await expect(runner.schema()).rejects.toMatchObject({ code: "schema" });
      // check-restore --schema-version: this build can still verify a database at its earlier head
      // (the pre-migration restore rehearsal), against its own copy of that migration file.
      const previous = (await baseline()).at(-1) ?? "";
      await runner.schema(previous);
      await expect(runner.schema("../005_launch_access_policy.sql")).rejects.toMatchObject({
        code: "input",
      });
      await runner.query(
        `INSERT INTO guilds (id, member_role_id, guest_role_id, officer_role_id, leader_role_id,
           lobby_channel_id, officer_channel_id, access_policy_enabled, effects_enabled, revision)
         VALUES ($1, '700001', '700002', '700003', '700004', '700005', '700006', true, true, 11),
                ($2, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 3)`,
        [guild.devbot, guild.pending],
      );
      await runner.query(
        "INSERT INTO audit (guild_id, action, target) VALUES ($1, 'migration.import', 'fingerprint')",
        [guild.pending],
      );

      // 001-004 match their recorded checksums and are skipped; 005 and 006 run.
      await runner.migrate(directory);
      await runner.schema();
      // Once migrated, the earlier head no longer matches.
      await expect(runner.schema(previous)).rejects.toMatchObject({ code: "schema" });
      // The runner's own bookkeeping table has no ORM mapping; observe it directly.
      const history = "SELECT version, applied_at FROM schema_migrations ORDER BY version";
      const recorded = await runner.query<{ version: string; applied_at: Date }>(history);
      expect(recorded.map((row) => row.version)).toEqual(await migrationFiles());
      expect(recorded.at(-1)?.version).toBe(SCHEMA_VERSION);
      // A repeated run is a checksum-verified no-op: nothing is re-applied or re-recorded.
      await runner.migrate(directory);
      expect(await runner.query(history)).toEqual(recorded);
      expect(
        await runner.orm
          .select({
            id: t.guilds.id,
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            revision: t.guilds.revision,
          })
          .from(t.guilds)
          .orderBy(asc(t.guilds.id)),
      ).toEqual([
        { id: guild.devbot, layout: true, marker: null, revision: 11n },
        { id: guild.pending, layout: false, marker: "pending", revision: 3n },
      ]);
    } finally {
      await runner.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rm(staged, { recursive: true, force: true });
    }
  });
});

const SWITCH = "006_guest_application_switch.sql";

describe.skipIf(!url)("migration 006 guest-application switch", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  /** One rolled-back transaction at schema 005, in a private schema, before 006 runs. */
  async function rehearse(schema: string, body: (client: PoolClient) => Promise<void>) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const file of (await migrationFiles()).filter((name) => name < SWITCH))
        await client.query(await migration(file));
      await body(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  test("the switch starts on only where a review channel was open, never for a pending import", async () => {
    await rehearse("m006_rehearsal", async (client) => {
      // Schema-005 rows: DevBot's shape (a channel, never imported), an import awaiting activation
      // with its legacy channel (a 2.12.x import), an activated import with a channel, and a guild
      // with no channel.
      await client.query(
        `INSERT INTO guilds (id, guest_application_channel_id, guest_grandfather, guest_grandfathered_at, effects_enabled, revision)
         VALUES ($1, '800001', NULL, NULL, true, 13),
                ($2, '800002', 'pending', NULL, false, 7),
                ($3, '800003', 'completed', now(), true, 9),
                ($4, NULL, NULL, NULL, true, 4)`,
        [guild.devbot, guild.pending, guild.activated, guild.dormant],
      );
      // A schema-005 grant: /guest reset's new columns must leave it active.
      await client.query("INSERT INTO users (id) VALUES ($1)", [user.manual]);
      await client.query("INSERT INTO guild_users (guild_id, user_id) VALUES ($1, $2)", [
        guild.devbot,
        user.manual,
      ]);
      await client.query(
        "INSERT INTO guest_grants (guild_id, user_id, provenance, source_key) VALUES ($1, $2, 'manual', 'manual:1')",
        [guild.devbot, user.manual],
      );
      const results: QueryResult[] = [await client.query(await migration(SWITCH))].flat();
      expect(
        results.filter((result) => result.command === "UPDATE").map((result) => result.rowCount),
      ).toEqual([2]);
      const store = orm(client);
      expect(
        await store
          .select({
            id: t.guilds.id,
            enabled: t.guilds.guest_applications_enabled,
            channel: t.guilds.guest_application_channel_id,
            revision: t.guilds.revision,
          })
          .from(t.guilds)
          .orderBy(asc(t.guilds.id)),
      ).toEqual([
        { id: guild.devbot, enabled: true, channel: "800001", revision: 13n },
        { id: guild.pending, enabled: false, channel: "800002", revision: 7n },
        { id: guild.activated, enabled: true, channel: "800003", revision: 9n },
        { id: guild.dormant, enabled: false, channel: null, revision: 4n },
      ]);
      expect(
        await store
          .select({
            ended: t.guestGrants.ended_at,
            by: t.guestGrants.ended_by,
            why: t.guestGrants.ended_reason,
          })
          .from(t.guestGrants),
      ).toEqual([{ ended: null, by: null, why: null }]);
      // A guild created later takes the default: applications off until /setup onboarding or
      // /config turns them on. Raw SQL, because a Drizzle insert names every column of today's
      // mapping, including columns later migrations add (009's changelog columns), which this
      // schema-006 table lacks.
      await client.query("INSERT INTO guilds (id, effects_enabled) VALUES ($1, true)", [
        guild.disabled,
      ]);
      expect(
        (
          await store
            .select({ enabled: t.guilds.guest_applications_enabled })
            .from(t.guilds)
            .where(eq(t.guilds.id, guild.disabled))
        )[0],
      ).toEqual({ enabled: false });
    });
  });
});

const PROFILE_CHECKS = "007_profile_checks.sql";

describe.skipIf(!url)("migration 007 profile checks", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  test("existing characters keep today's behavior: both new columns start NULL", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA m007_rehearsal");
      await client.query("SET LOCAL search_path TO m007_rehearsal");
      for (const file of (await migrationFiles()).filter((name) => name < PROFILE_CHECKS))
        await client.query(await migration(file));
      // A schema-006 character with a refreshed profile, and one never refreshed.
      await client.query(
        `INSERT INTO characters (id, name, world, profile_at)
         VALUES ('35999242', 'Vanessa Wolfe', 'Diabolos', NULL),
                ('45286792', 'Refreshed Character', 'Diabolos', now())`,
      );
      await client.query(await migration(PROFILE_CHECKS));
      const rows = await client.query<{
        id: string;
        profile_retry_at: Date | null;
        profile_missing_at: Date | null;
      }>("SELECT id, profile_retry_at, profile_missing_at FROM characters ORDER BY id");
      expect(rows.rows).toEqual([
        { id: "35999242", profile_retry_at: null, profile_missing_at: null },
        { id: "45286792", profile_retry_at: null, profile_missing_at: null },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

const ISSUE_REPORTS = "008_issue_reports.sql";

describe.skipIf(!url)("migration 008 issue reports", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  test("the reports table accepts the four sources only, and indexes pending delivery", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA m008_rehearsal");
      await client.query("SET LOCAL search_path TO m008_rehearsal");
      for (const file of (await migrationFiles()).filter((name) => name <= ISSUE_REPORTS))
        await client.query(await migration(file));
      await client.query(
        "INSERT INTO issue_reports (fingerprint, source, title, body) VALUES ('a', 'trouble', 't', 'b')",
      );
      const [row] = (
        await client.query<{ occurrences: number; posted_occurrences: number }>(
          "SELECT occurrences, posted_occurrences FROM issue_reports",
        )
      ).rows;
      expect(row).toEqual({ occurrences: 1, posted_occurrences: 0 });
      const indexes = (
        await client.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname='m008_rehearsal' AND tablename='issue_reports' ORDER BY 1",
        )
      ).rows.map((index) => index.indexname);
      expect(indexes).toEqual([
        "issue_reports_guild_recent",
        "issue_reports_pending",
        "issue_reports_pkey",
        "issue_reports_user_recent",
      ]);
      await client.query("SAVEPOINT bad_source");
      await expect(
        client.query(
          "INSERT INTO issue_reports (fingerprint, source, title, body) VALUES ('b', 'other', 't', 'b')",
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT bad_source");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

const CHANGELOG_CHANNEL = "009_changelog_channel.sql";

describe.skipIf(!url)("migration 009 changelog channel", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  test("existing guilds keep posts off and their revision; a channel always has a valid baseline", async () => {
    const client = await db.pool.connect();
    /** Run a statement that must fail, inside a savepoint so the rehearsal continues. */
    const refused = async (statement: string, message: string) => {
      await client.query("SAVEPOINT refused");
      await expect(client.query(statement)).rejects.toThrow(message);
      await client.query("ROLLBACK TO SAVEPOINT refused");
    };
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA m009_rehearsal");
      await client.query("SET LOCAL search_path TO m009_rehearsal");
      for (const file of (await migrationFiles()).filter((name) => name < CHANGELOG_CHANNEL))
        await client.query(await migration(file));
      // A schema-008 guild at revision 13, like DevBot (a reserved #30 test guild ID).
      await client.query("INSERT INTO guilds (id, revision) VALUES ('666666666666666720', 13)");
      await client.query(await migration(CHANGELOG_CHANNEL));
      expect(
        (
          await client.query<{
            revision: bigint;
            changelog_channel_id: string | null;
            changelog_version: string | null;
          }>("SELECT revision, changelog_channel_id, changelog_version FROM guilds")
        ).rows,
      ).toEqual([{ revision: 13n, changelog_channel_id: null, changelog_version: null }]);
      // The version CHECK takes MAJOR.MINOR.PATCH with an optional prerelease, nothing else.
      for (const bad of ["latest", "2.25", "2.25.0+build", "02.25.0"])
        await refused(
          `UPDATE guilds SET changelog_version='${bad}'`,
          "guilds_changelog_version_check",
        );
      // changelog_baseline: a channel is never set without a version.
      await refused("UPDATE guilds SET changelog_channel_id='82001'", "changelog_baseline");
      await client.query(
        "UPDATE guilds SET changelog_channel_id='82001', changelog_version='2.25.0-rc.1'",
      );
      // Unsetting the channel keeps the version, which the CHECKs allow.
      await client.query("UPDATE guilds SET changelog_channel_id=NULL");
      expect(
        (await client.query<{ changelog_version: string }>("SELECT changelog_version FROM guilds"))
          .rows,
      ).toEqual([{ changelog_version: "2.25.0-rc.1" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

const STATUS_NOTICES = "010_status_notices.sql";

describe.skipIf(!url)("migration 010 status notices", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  test("existing members start never observed: the three new columns are NULL", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA m010_rehearsal");
      await client.query("SET LOCAL search_path TO m010_rehearsal");
      for (const file of (await migrationFiles()).filter((name) => name < STATUS_NOTICES))
        await client.query(await migration(file));
      // A schema-009 member row (guild_users references guilds and users), with the reserved #31
      // test guild ID.
      await client.query("INSERT INTO guilds (id) VALUES ('666666666666666740')");
      await client.query("INSERT INTO users (id) VALUES ('93100001')");
      await client.query(
        "INSERT INTO guild_users (guild_id, user_id, present, joined_at) VALUES ('666666666666666740', '93100001', true, now())",
      );
      await client.query(await migration(STATUS_NOTICES));
      expect(
        (
          await client.query<{
            status_state: unknown;
            status_since: Date | null;
            status_posting: unknown;
          }>("SELECT status_state, status_since, status_posting FROM guild_users")
        ).rows,
      ).toEqual([{ status_state: null, status_since: null, status_posting: null }]);
      // The types the bot writes: JSON documents and a database-clock instant, with no default.
      expect(
        (
          await client.query<{ column_name: string; data_type: string; column_default: null }>(
            "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_schema='m010_rehearsal' AND table_name='guild_users' AND column_name LIKE 'status%' ORDER BY column_name",
          )
        ).rows,
      ).toEqual([
        { column_name: "status_posting", data_type: "jsonb", column_default: null },
        {
          column_name: "status_since",
          data_type: "timestamp with time zone",
          column_default: null,
        },
        { column_name: "status_state", data_type: "jsonb", column_default: null },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe.skipIf(!url)("the migration guard (writer lease)", () => {
  if (!url) return;
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  test("pending migrations never run while a bot holds the writer lease; nothing pending ignores it", async () => {
    const schema = "migration_guard";
    const staged = await mkdtemp(join(tmpdir(), "tarubot-guard-"));
    const confined = new URL(url);
    confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${schema}`);
    const runner = new Database(confined.toString());
    // A separate session holds the lease the way a running bot does (a session advisory lock).
    const bot = await db.pool.connect();
    const head = "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1";
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
      for (const file of await baseline())
        await copyFile(join(directory, file), join(staged, file));
      // Nothing holds the lease yet: the baseline applies and reports the lease window.
      const first = await runner.migrate(staged);
      expect(first.applied).toEqual(await baseline());
      expect(first.leaseAcquiredAt).not.toBeNull();
      expect(first.committingAt).not.toBeNull();
      expect(Date.parse(first.leaseAcquiredAt ?? "")).toBeLessThanOrEqual(
        Date.parse(first.committingAt ?? ""),
      );

      await bot.query("SELECT pg_advisory_lock($1::bigint)", [WRITER_LEASE_LOCK]);
      const pid = (await bot.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      // Pending 005 and 006 wait out the bound, then refuse and name the holder; nothing changes.
      const refused = runner.migrate(directory, { writerWaitMs: 300, writerRetryMs: 50 });
      await expect(refused).rejects.toMatchObject({ code: "busy" });
      await expect(refused).rejects.toThrow(`database process ${pid}`);
      expect(await runner.query(head)).toEqual([{ version: (await baseline()).at(-1) }]);
      // With nothing pending the lease is never touched, so a pre-deploy job succeeds beside a bot.
      expect(await runner.migrate(staged, { writerWaitMs: 0 })).toEqual({
        applied: [],
        leaseAcquiredAt: null,
        committingAt: null,
      });

      // A bot that stops within the bound: the migration waits for it, then applies everything.
      const waiting = runner.migrate(directory, { writerWaitMs: 5000, writerRetryMs: 50 });
      await Bun.sleep(200);
      await bot.query("SELECT pg_advisory_unlock($1::bigint)", [WRITER_LEASE_LOCK]);
      const report = await waiting;
      expect(report.applied).toEqual((await migrationFiles()).filter((name) => name >= LAUNCH));
      expect(await runner.query(head)).toEqual([{ version: SCHEMA_VERSION }]);
      // The transaction-scoped lock ended at COMMIT: a bot can take the lease again at once.
      expect(
        (
          await bot.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS locked",
            [WRITER_LEASE_LOCK],
          )
        ).rows[0]?.locked,
      ).toBe(true);
    } finally {
      await bot.query("SELECT pg_advisory_unlock_all()");
      bot.release();
      await runner.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rm(staged, { recursive: true, force: true });
    }
  });
});
