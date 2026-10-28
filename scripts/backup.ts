/**
 * One encrypted backup now (2.46.0), with the bot's own settings and code, as a one-off container
 * of its image:
 *
 *   docker compose run --rm -T tarubot bun dist/scripts/backup.js
 *
 * The same backup the bot takes daily (src/application/backups.ts): the dump, the monthly copy on
 * the 1st, the settings copy and the healthchecks.io pings. It prints the stored keys and sizes,
 * and exits non-zero on failure. It doesn't take the writer lease: pg_dump reads one consistent
 * snapshot whatever a running bot writes meanwhile.
 */
import { Backups, settingsSnapshot } from "../src/application/backups.js";
import { assertToolScope, type ToolScope } from "../src/config/deployment.js";
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

if (import.meta.main) {
  backupArguments(process.argv.slice(2));
  // The database must belong to this env's deployment profile before any connection.
  assertToolScope(process.env, backupToolScope());
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
