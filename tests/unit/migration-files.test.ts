/**
 * The numbered migrations, checked without a database: every file matches MIGRATION_FILE, the
 * numbers run 001..N with no gap or repeat, and SCHEMA_VERSION names the newest file. CI's
 * integration run would notice a missing head only once PostgreSQL is up; a second 009 (two branches
 * taking the same number) or a SCHEMA_VERSION left behind fails here first. Since 2.30.0 no file
 * may control its own transaction: the automated deploy's recovery rule relies on migrate()
 * applying all pending files as one.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { MIGRATION_FILE, SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";

const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

test("migrations are numbered 001..N without gaps or repeats, and SCHEMA_VERSION is the last", async () => {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files)
    expect({ file, named: MIGRATION_FILE.test(file) }).toEqual({ file, named: true });
  // Each file's three-digit prefix is its position in runner order.
  expect(files.map((file) => file.slice(0, 3))).toEqual(
    files.map((_, index) => String(index + 1).padStart(3, "0")),
  );
  expect(files.at(-1)).toBe(SCHEMA_VERSION);
});

/**
 * The SQL left once dollar-quoted bodies ($$…$$, $tag$…$tag$) and comments are removed: what the
 * migration itself runs as statements.
 */
function statements(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/gu, "''")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/--[^\n]*/gu, "");
}

/**
 * A line-leading statement that would end or split migrate()'s single transaction. END counts only
 * as a statement of its own (`END;`, `END WORK;`), so a CASE closing on the next line reads fine
 * as long as its END isn't followed by the semicolon; BEGIN ATOMIC opens a function body.
 */
const TRANSACTION_CONTROL =
  /^\s*(?:BEGIN\b(?!\s+ATOMIC)|COMMIT\b|ROLLBACK\b|END\s*(?:WORK|TRANSACTION)?\s*;|START\s+TRANSACTION\b|SAVEPOINT\b|RELEASE\b)/imu;

test("no migration controls its own transaction", async () => {
  // migrate() applies every pending file in one transaction, which recovery from a failed
  // release relies on: a migration that failed changed nothing. A file
  // that commits, rolls back or opens a savepoint would break that. CONCURRENTLY and VACUUM
  // aren't listed: inside the transaction they fail, which is safe.
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await Bun.file(`${directory}/${file}`).text();
    expect({ file, control: TRANSACTION_CONTROL.test(statements(sql)) }).toEqual({
      file,
      control: false,
    });
  }
});

test("the transaction check catches what it must and ignores function bodies", () => {
  for (const bad of [
    "BEGIN;",
    "CREATE TABLE t (id int);\n  commit;",
    "START TRANSACTION;",
    "savepoint a;",
    "RELEASE SAVEPOINT a;",
    "ROLLBACK;",
    "END;",
  ])
    expect({ bad, caught: TRANSACTION_CONTROL.test(statements(bad)) }).toEqual({
      bad,
      caught: true,
    });
  for (const fine of [
    "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x'; END $$;",
    "DO $body$\nBEGIN\n  PERFORM 1;\nEND\n$body$;",
    "-- BEGIN is only mentioned here\nCREATE TABLE t (id int);",
    "/* COMMIT;\n */ CREATE INDEX i ON t (id);",
    "ALTER TABLE t ADD COLUMN ended_at timestamptz;",
    "UPDATE t SET n = CASE WHEN id > 0 THEN 1 ELSE 0\nEND\nWHERE n IS NULL;",
    "CREATE FUNCTION g() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT 1;\nEND",
  ])
    expect({ fine, caught: TRANSACTION_CONTROL.test(statements(fine)) }).toEqual({
      fine,
      caught: false,
    });
});
