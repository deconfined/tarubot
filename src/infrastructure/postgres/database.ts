/** PostgreSQL boundary: exact decoding, short transactions, schema checks, and shared writes. */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type { PoolClient, QueryResultRow } from "pg";
import { secretSetting } from "../../config/secrets.js";
import { Failure } from "../../domain/values.js";
import { postgresConnection } from "./connection.js";

// OID 20 covers balances, sequences, and counts; Number would silently lose large integers.
pg.types.setTypeParser(20, (value) => BigInt(value));
/** Both a transaction client and the pool can execute these parameterized helper operations. */
export type Connection = pg.Pool | PoolClient;
export type Orm = NodePgDatabase<typeof schema>;
const sessions = new WeakMap<Connection, Orm>();
/** Bind ORM operations to the exact pool/client supplied, preserving transaction and lock scope. */
export function orm(connection: Connection): Orm {
  let instance = sessions.get(connection);
  if (!instance) {
    instance = drizzle(connection, { schema });
    sessions.set(connection, instance);
  }
  return instance;
}
/** The newest migration this build requires; startup and tools refuse any other applied head. */
export const SCHEMA_VERSION = "011_web_sessions.sql";
/** Numbered migration filenames, as stored in schema_migrations.version. */
export const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

/**
 * Session advisory lock key that makes one bot process the database's only writer (amendment C3).
 * It is distinct from the transaction locks for migrations (714882490), character claims (714882491)
 * and legacy import (714882492). The lifecycle holds it for a bot's lifetime; migrate() takes it
 * for the migration transaction whenever a migration is pending. The probe is on the site's
 * operations page (site/src/content/docs/deploy/operations.md).
 */
export const WRITER_LEASE_LOCK = 714882494;

/** Only pg_locks identifies a lock's holder; a single bigint key is classid 0, objid key, objsubid 1. */
export const WRITER_LEASE_HOLDER = `SELECT pid FROM pg_locks
  WHERE locktype = 'advisory' AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = 0 AND objid = $1::bigint::oid AND objsubid = 1`;

/** How long migrate() waits for a stopping bot to release the writer lease, and how often it retries. */
export interface MigrateOptions {
  writerWaitMs?: number;
  writerRetryMs?: number;
}

/**
 * What one migrate() run did. With files applied, `leaseAcquiredAt` and `committingAt` are the
 * database clock (clock_timestamp()) when the migration took the writer lease and just before its
 * COMMIT: no bot wrote after the first, so it is the point-in-time-recovery restore point.
 */
export interface MigrationReport {
  applied: string[];
  leaseAcquiredAt: string | null;
  committingAt: string | null;
}
/** The pool is application-owned; remote Discord/Lodestone work stays outside transactions. */
/** Per-session settings every pooled connection starts with; tests that set their own URL options restate them. */
export const SESSION_OPTIONS =
  "-c timezone=UTC -c statement_timeout=15000 -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3";

export class Database {
  readonly pool: pg.Pool;
  readonly orm: Orm;
  healthy = false;
  /**
   * Bound connection/query waits and normalize all database-generated instants to UTC.
   * `ca` defaults to DATABASE_CA_CERT or its private DATABASE_CA_CERT_FILE counterpart.
   * A second connection (for example check-restore against a PITR fork)
   * can supply its own provider CA, and "" forces a connection without a provider CA.
   */
  constructor(
    url: string,
    ca: string | undefined = secretSetting(process.env, "DATABASE_CA_CERT"),
  ) {
    this.pool = new pg.Pool({
      ...postgresConnection(url, ca),
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      // Client TCP keepalive lets the bot notice a database peer that vanished without FIN/RST;
      // the lifecycle's periodic lease check is the guarantee on this side.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      // Server-side keepalive (30 s idle, 3 probes 10 s apart) lets PostgreSQL end a session whose
      // client vanished after a host loss or partition, releasing its writer lease in about a
      // minute instead of after the OS default of roughly two hours.
      options: SESSION_OPTIONS,
    });
    this.orm = orm(this.pool);
    this.pool.on("error", () => {
      this.healthy = false;
    });
    this.pool.on("connect", (client) => {
      // Session advisory locks can keep a client checked out during remote I/O.
      client.on("error", () => {
        this.healthy = false;
      });
    });
  }
  /** Escape hatch for migrations, probes, catalogs, and independent test observations; use orm for application rows. */
  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(sql, values);
      this.healthy = true;
      return result.rows;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  /** Roll back the complete decision on failure, then release the checked-out client. */
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /**
   * A matching filename and checksum are required before startup accepts work. `version` is this
   * build's SCHEMA_VERSION except for check-restore --schema-version, which verifies two databases
   * still at an earlier migration of this build (a pre-migration restore rehearsal).
   */
  async schema(version: string = SCHEMA_VERSION): Promise<void> {
    // The name becomes a path under migrations/, so only a plain migration filename is accepted.
    if (!MIGRATION_FILE.test(version))
      throw new Failure("input", "A schema version is a migration filename such as 004_name.sql.");
    try {
      const rows = await this.query<{ version: string; checksum: string }>(
        "SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );
      const expected = createHash("sha256")
        .update(await Bun.file(`migrations/${version}`).text())
        .digest("hex");
      if (rows[0]?.version !== version || rows[0].checksum !== expected)
        throw new Failure(
          "schema",
          "Schema version/checksum mismatch. Use matching versioned migrations and application image.",
        );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "42P01")
        throw new Failure("schema", "Run db:migrate before starting the application.");
      throw error;
    }
  }
  /**
   * Serialize migration runners, reject edits to any previously applied migration, and apply every
   * pending file in one transaction, so a failure leaves the schema exactly as it was.
   *
   * Pending work also takes the writer lease with a transaction-scoped lock, which conflicts with
   * a bot's session lock on the same key and ends at COMMIT or ROLLBACK. A migration therefore
   * never runs while a bot writes: it waits up to `writerWaitMs` for a stopping bot, then refuses
   * and names the holder. With nothing pending the lease is never touched, so a deployment's
   * pre-deploy job succeeds while the previous bot still runs.
   */
  async migrate(directory = "migrations", options: MigrateOptions = {}): Promise<MigrationReport> {
    const waitMs = options.writerWaitMs ?? 90_000;
    const retryMs = options.writerRetryMs ?? 2_000;
    return await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(714882490)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      // Verify every applied file before changing anything, and collect the pending ones in order.
      const pending: { file: string; sql: string; checksum: string }[] = [];
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        const sql = await Bun.file(`${directory}/${file}`).text();
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [file],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum)
            throw new Error(`Modified applied migration: ${file}`);
          continue;
        }
        pending.push({ file, sql, checksum });
      }
      if (!pending.length) return { applied: [], leaseAcquiredAt: null, committingAt: null };
      const started = performance.now();
      for (;;) {
        const attempt = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
          [WRITER_LEASE_LOCK],
        );
        if (attempt.rows[0]?.locked) break;
        if (performance.now() - started >= waitMs) {
          const holder = await client.query<{ pid: number }>(WRITER_LEASE_HOLDER, [
            WRITER_LEASE_LOCK,
          ]);
          throw new Failure(
            "busy",
            `A TaruBot writer (database process ${holder.rows[0]?.pid ?? "unknown"}) holds the writer lease, so ${pending.length} pending migration(s) were not applied. Stop the bot, then migrate again.`,
          );
        }
        await Bun.sleep(retryMs);
      }
      const clock = async () =>
        (await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0]?.at ??
        null;
      const leaseAcquiredAt = await clock();
      for (const { file, sql, checksum } of pending) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [
          file,
          checksum,
        ]);
      }
      return {
        applied: pending.map(({ file }) => file),
        leaseAcquiredAt,
        committingAt: await clock(),
      };
    });
  }
  /** Drain idle/returned clients during process shutdown and one-shot tooling completion. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Record decisions in the caller's transaction so audit and state cannot diverge. */
export async function audit(
  client: Connection,
  guildId: string,
  actor: string | null,
  action: string,
  target: string | null,
  details: unknown = {},
): Promise<void> {
  await orm(client)
    .insert(schema.auditEvents)
    .values({
      guild_id: guildId,
      actor_id: actor,
      action,
      target,
      details: details === null ? sql`'null'::jsonb` : details,
    });
}

/** Preserve durable user policy while refreshing presence and resetting an obsolete join baseline. */
export async function ensureUser(
  client: Connection,
  guildId: string,
  userId: string,
  joinedAt?: Date,
): Promise<void> {
  const db = orm(client),
    user = schema.guildUsers;
  await db.insert(schema.users).values({ id: userId }).onConflictDoNothing();
  await db
    .insert(user)
    .values({
      guild_id: guildId,
      user_id: userId,
      present: joinedAt !== undefined,
      joined_at: joinedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [user.guild_id, user.user_id],
      set: {
        present: joinedAt ? true : user.present,
        nickname_baseline_set: joinedAt
          ? sql`CASE WHEN ${user.joined_at} IS DISTINCT FROM ${joinedAt.toISOString()}::timestamptz THEN false ELSE ${user.nickname_baseline_set} END`
          : user.nickname_baseline_set,
        nickname_pending: joinedAt
          ? sql`CASE WHEN ${user.joined_at} IS DISTINCT FROM ${joinedAt.toISOString()}::timestamptz THEN false ELSE ${user.nickname_pending} END`
          : user.nickname_pending,
        joined_at: joinedAt ?? user.joined_at,
      },
    });
}
