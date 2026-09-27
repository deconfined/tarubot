/** Read-only restore verification: compare complete data and schema support objects exactly.
 * Catalog SQL is intentional: an independent restore check must include tables absent from ORM mappings.
 *
 *   bun dist/scripts/check-restore.js [--schema-version NNN_name.sql]
 *
 * Both databases must normally be at this build's SCHEMA_VERSION. A pre-migration rehearsal runs
 * from the currently deployed build; with a newer build, --schema-version names the earlier
 * migration both databases must still report (with this build's checksum for that file) instead.
 */
import { assertToolScope, restoreCertificate, type ToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import {
  Database,
  MIGRATION_FILE,
  SCHEMA_VERSION,
} from "../src/infrastructure/postgres/database.js";
import { Failure, json } from "../src/domain/values.js";

/** Parse the optional --schema-version; anything else is an error. */
export function restoreArguments(argv: readonly string[]): { schemaVersion: string } {
  if (!argv.length) return { schemaVersion: SCHEMA_VERSION };
  const [flag, value, ...rest] = argv;
  if (flag !== "--schema-version" || value === undefined || rest.length)
    throw new Failure("input", "Use check-restore.js [--schema-version NNN_name.sql].");
  if (!MIGRATION_FILE.test(value))
    throw new Failure("input", "--schema-version takes a migration filename such as 004_name.sql.");
  return { schemaVersion: value };
}

/**
 * The deployment guard's view of a restore check: both databases, no Discord. Exported so tests
 * check exactly what check-restore.js declares.
 */
export function restoreToolScope(): ToolScope {
  return {
    tool: "check-restore",
    guilds: [],
    discord: "none",
    databases: ["DATABASE_URL", "RESTORE_DATABASE_URL"],
  };
}

/** Catalog identifiers still need SQL quoting; unlike values, identifiers cannot be bind parameters. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Compare every table's rows, then sequences, triggers and constraints. */
async function verify(source: Database, target: Database, schemaVersion: string): Promise<void> {
  await source.schema(schemaVersion);
  await target.schema(schemaVersion);
  const catalog = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename";
  const tables = await source.query<{ tablename: string }>(catalog);
  if (json(tables) !== json(await target.query(catalog)))
    throw new Error("Restored table inventory differs.");
  for (const { tablename } of tables) {
    // Hash exact PostgreSQL text, so JSON parsing never rounds bigint values.
    const sql = `SELECT count(*)::text AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS checksum FROM public.${quote(tablename)} t`;
    const expected = await source.query<{ rows: string; checksum: string }>(sql);
    const actual = await target.query(sql);
    if (json(expected) !== json(actual)) throw new Error(`Restore mismatch: ${tablename}`);
    console.log(json({ table: tablename, rows: expected[0]?.rows, verified: true }));
  }
  for (const sql of [
    "SELECT sequencename,last_value::text,increment_by::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
    "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname,definition",
  ]) {
    if (json(await source.query(sql)) !== json(await target.query(sql))) {
      throw new Error("Restored sequence, trigger, or constraint definitions differ.");
    }
  }
  console.log(
    `Restore verified at ${schemaVersion}: every application row, sequence, trigger, and constraint matches.`,
  );
}

if (import.meta.main) {
  const { schemaVersion } = restoreArguments(process.argv.slice(2));
  if (!(await Bun.file(`migrations/${schemaVersion}`).exists()))
    throw new Error(`This build has no migrations/${schemaVersion}.`);
  // Both databases must belong to this env's deployment profile before any connection.
  assertToolScope(process.env, restoreToolScope());
  // DATABASE_URL may come from DATABASE_URL_FILE; RESTORE_DATABASE_URL has no file form.
  const original = secretSetting(process.env, "DATABASE_URL");
  const recovered = process.env.RESTORE_DATABASE_URL;
  if (!original || !recovered)
    throw new Error("DATABASE_URL and RESTORE_DATABASE_URL are required.");
  const source = new Database(original);
  // A PITR fork is a new cluster whose CA can differ from the primary's.
  const target = new Database(recovered, restoreCertificate(process.env));
  try {
    await verify(source, target, schemaVersion);
  } finally {
    await source.close();
    await target.close();
  }
}
