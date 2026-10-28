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
 *
 * Since 2.46.0 the bot applies its own pending migrations at startup, so this is the one-off tool
 * (an init container, a Compose one-shot, or a migration ahead of a start). It follows the bot's
 * pre-migration rule: with backup settings, an encrypted backup is taken under the lease before
 * the first file runs, and its failure applies nothing; without them production and staging
 * refuse, and other profiles warn. A --restore-rehearsal copy is disposable and takes none.
 */
import { Backups, settingsSnapshot } from "../src/application/backups.js";
import { migrateToolScope } from "../src/application/startup.js";
import { assertToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import { Failure } from "../src/domain/values.js";
import { Database } from "../src/infrastructure/postgres/database.js";

// Exported so tests check exactly what migrate.js declares; the bot declares the same scope.
export { migrateToolScope };

/** The only option is --restore-rehearsal; anything else is refused before any I/O. */
export function migrateArguments(argv: readonly string[]): { restoreRehearsal: boolean } {
  let restoreRehearsal = false;
  for (const argument of argv) {
    if (argument === "--restore-rehearsal" && !restoreRehearsal) restoreRehearsal = true;
    else throw new Failure("input", `Unexpected argument ${argument}.`);
  }
  return { restoreRehearsal };
}

if (import.meta.main) {
  const args = migrateArguments(process.argv.slice(2));
  // The database must belong to this env's deployment profile before any connection.
  const deployment = assertToolScope(process.env, migrateToolScope(args));
  // Resolve the direct setting or its private NAME_FILE counterpart.
  const url = secretSetting(process.env, "DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is required");
  // MIGRATE_WRITER_WAIT_SECONDS bounds the wait for a stopping bot to release the writer lease.
  const wait = Number(process.env.MIGRATE_WRITER_WAIT_SECONDS ?? 90);
  if (!Number.isInteger(wait) || wait < 0 || wait > 600)
    throw new Failure("input", "MIGRATE_WRITER_WAIT_SECONDS must be a whole number from 0 to 600.");
  const backups = args.restoreRehearsal
    ? null
    : new Backups(settingsSnapshot(process.env), (_level, fields, message) =>
        console.log(`${message} ${JSON.stringify(fields)}`),
      );
  const db = new Database(url);
  try {
    const report = await db.migrate("migrations", {
      writerWaitMs: wait * 1000,
      ...(backups && {
        beforeApply: async (pending) => {
          await backups.beforeMigration(deployment.name, pending);
        },
      }),
    });
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
