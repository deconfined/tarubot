/**
 * One-shot schema migration; execution is serialized and checksums are verified by Database.
 *
 *   bun dist/scripts/migrate.js                        (the profile's own database)
 *   bun dist/scripts/migrate.js --restore-rehearsal    (a disposable *_restore_test copy first)
 *
 * --restore-rehearsal is the pre-migration rehearsal on a restored copy
 * (site/src/content/docs/deploy/operations.md):
 * the deployment guard then accepts DATABASE_URL only when it names a *_restore_test database.
 *
 * Pending migrations also take the database writer lease for their one transaction: the run waits
 * up to MIGRATE_WRITER_WAIT_SECONDS (default 90) for a stopping bot, then refuses while any bot
 * holds it. Stop the bot before migrating (site/src/content/docs/deploy/operations.md).
 */
import { assertToolScope, type ToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import { Failure } from "../src/domain/values.js";
import { Database } from "../src/infrastructure/postgres/database.js";

/** The only option is --restore-rehearsal; anything else is refused before any I/O. */
export function migrateArguments(argv: readonly string[]): { restoreRehearsal: boolean } {
  let restoreRehearsal = false;
  for (const argument of argv) {
    if (argument === "--restore-rehearsal" && !restoreRehearsal) restoreRehearsal = true;
    else throw new Failure("input", `Unexpected argument ${argument}.`);
  }
  return { restoreRehearsal };
}

/**
 * The deployment guard's view of a migration: DATABASE_URL only, and a *_restore_test copy only
 * with --restore-rehearsal. Exported so tests check exactly what migrate.js declares.
 */
export function migrateToolScope(args: { restoreRehearsal: boolean }): ToolScope {
  return {
    tool: "migrate",
    guilds: [],
    discord: "none",
    databases: ["DATABASE_URL"],
    restoreRehearsal: args.restoreRehearsal,
  };
}

if (import.meta.main) {
  const args = migrateArguments(process.argv.slice(2));
  // The database must belong to this env's deployment profile before any connection.
  assertToolScope(process.env, migrateToolScope(args));
  // DATABASE_URL, or the file DATABASE_URL_FILE names inside a Quadlet host's container.
  const url = secretSetting(process.env, "DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is required");
  const db = new Database(url);
  try {
    // MIGRATE_WRITER_WAIT_SECONDS bounds the wait for a stopping bot to release the writer lease.
    const wait = Number(process.env.MIGRATE_WRITER_WAIT_SECONDS ?? 90);
    if (!Number.isInteger(wait) || wait < 0 || wait > 600)
      throw new Failure(
        "input",
        "MIGRATE_WRITER_WAIT_SECONDS must be a whole number from 0 to 600.",
      );
    const report = await db.migrate("migrations", { writerWaitMs: wait * 1000 });
    // The lease time is the restore point: no bot wrote after it
    // (site/src/content/docs/deploy/operations.md).
    if (report.applied.length)
      console.log(
        `Migration writer lease acquired at ${report.leaseAcquiredAt}; applied ${report.applied.join(", ")}; committing at ${report.committingAt}.`,
      );
    await db.schema();
    console.log("Schema ready.");
  } finally {
    await db.close();
  }
}
