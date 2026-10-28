/**
 * One encrypted backup now (2.46.0), with the bot's own settings and code, as a one-off container
 * of its image:
 *
 *   docker compose run --rm -T tarubot bun dist/scripts/backup.js
 *
 * The same backup the bot takes daily (src/application/backups.ts): the dump, the monthly copy on
 * the 1st, the settings copy and the healthchecks.io pings. It prints the stored keys and sizes,
 * and exits non-zero on failure. It doesn't take the writer lease: pg_dump reads one consistent
 * snapshot whatever a running bot writes meanwhile. It refuses the rehearsal profile.
 */
import { Backups, settingsSnapshot } from "../src/application/backups.js";
import {
  assertToolScope,
  type Deployment,
  type Environment,
  type Launch,
  type ToolScope,
} from "../src/config/deployment.js";
import { Failure, json } from "../src/domain/values.js";

/** No options; anything else is refused before any I/O. */
export function backupArguments(argv: readonly string[]): void {
  if (argv.length) throw new Failure("input", `Unexpected argument ${argv[0]}.`);
}

/**
 * The deployment guard's view of a backup: DATABASE_URL, read only, and no Discord. Exported so
 * tests check exactly what backup.js declares.
 */
export function backupToolScope(): ToolScope {
  return { tool: "backup", guilds: [], discord: "none", databases: ["DATABASE_URL"] };
}

/**
 * backup.js's guard: the deployment guard for backupToolScope, and never the rehearsal profile. A
 * rehearsal's *_rehearsal database is disposable, and a one-off container of production's service
 * carries production's backup settings, so its backup would become the newest daily/ and env/
 * objects in production's bucket: the ones `restore.js database latest` and `settings latest`
 * choose. (Backups.beforeMigration skips the rehearsal profile for the same reason.)
 */
export function assertBackupScope(env: Environment, launch?: Launch): Deployment {
  const deployment = assertToolScope(env, backupToolScope(), launch);
  if (deployment.name === "rehearsal")
    throw new Failure(
      "configuration",
      "Refusing backup under the rehearsal profile: a rehearsal database is disposable, and its backup would become the newest object in production's bucket, the one restore.js restores as latest.",
    );
  return deployment;
}

if (import.meta.main) {
  backupArguments(process.argv.slice(2));
  // The database must belong to this env's deployment profile before any connection.
  assertBackupScope(process.env);
  const backups = new Backups(settingsSnapshot(process.env), (_level, fields, message) =>
    console.error(`${message} ${JSON.stringify(fields)}`),
  );
  if (backups.configuration.status === "off")
    throw new Failure(
      "configuration",
      "Backups aren't configured: set BACKUP_STORAGE_ENDPOINT and the other backup settings.",
    );
  console.log(json(await backups.run("one-off"), 2));
}
