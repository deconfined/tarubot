/**
 * The role layout starts off on servers TaruBot first meets through /config or /setup onboarding
 * (CFG-07, 2.35.0). There is no migration: the column default stays on, so the application sets
 * the value at every guild insert. This pins NEW_GUILD_ROW's values and scans src/ so every
 * `.insert(t.guilds)` spreads it, except the legacy importer, which writes its own explicit
 * `role_layout_enabled: false` (with effects held until activation).
 */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { NEW_GUILD_ROW } from "../../src/application/guild-defaults.js";
import * as t from "../../src/infrastructure/postgres/schema.js";

/** A repository path, resolved relative to this test (the same helper as deployment.test.ts). */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The one insert that keeps its own values: imported servers start off and await activation. */
const IMPORTER = "src/import/importer.ts";

/** A guild insert through Drizzle, whatever the schema module's local name. */
const GUILD_INSERT = /\.insert\(\s*[\w$]+\.guilds\s*\)/gu;

/**
 * The text of the call arguments that open at `open` (the index of a "("), up to its matching ")".
 * Parentheses are counted without parsing strings; a guild insert's values hold none unbalanced.
 */
function argumentsAt(source: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  return null;
}

/**
 * Every guild insert in one source file and what is wrong with each. A mention inside a comment
 * line doesn't count. Outside the importer, the `.values({...})` that follows must spread
 * NEW_GUILD_ROW and set neither of its columns itself, so no later key can undo the default; the
 * importer must still set `role_layout_enabled: false`.
 */
function guildInserts(file: string, source: string): { sites: number; problems: string[] } {
  let sites = 0;
  const problems: string[] = [];
  for (const match of source.matchAll(GUILD_INSERT)) {
    const start = match.index ?? 0;
    const lineStart = source.lastIndexOf("\n", start) + 1;
    if (/^\s*(\/\/|\/\*|\*)/u.test(source.slice(lineStart, start))) continue;
    sites++;
    const where = `${file}:${source.slice(0, start).split("\n").length}`;
    const after = start + match[0].length;
    const values = /^\s*\.values\(/u.exec(source.slice(after));
    const text = values ? argumentsAt(source, after + values[0].length - 1) : null;
    if (text === null) problems.push(`${where} inserts a guild without .values(...)`);
    else if (file === IMPORTER) {
      if (!/\brole_layout_enabled:\s*false\b/u.test(text))
        problems.push(`${where} no longer sets role_layout_enabled: false`);
    } else if (!/\.\.\.\s*NEW_GUILD_ROW\b/u.test(text))
      problems.push(`${where} doesn't spread NEW_GUILD_ROW`);
    else if (/\b(role_layout_enabled|effects_enabled)\s*:/u.test(text))
      problems.push(`${where} overrides a NEW_GUILD_ROW column`);
  }
  return { sites, problems };
}

test("a new server starts with effects on and the role layout off", () => {
  expect(NEW_GUILD_ROW).toEqual({ effects_enabled: true, role_layout_enabled: false });
  // Both keys are real guilds columns, so the spread can't silently set nothing.
  const columns = Object.keys(getTableColumns(t.guilds));
  for (const key of Object.keys(NEW_GUILD_ROW)) expect(columns).toContain(key);
});

test("the insert scan accepts the spread and names every other shape", () => {
  const good = [
    "await db",
    "  .insert(t.guilds)",
    "  .values({ id: actor.guildId, ...NEW_GUILD_ROW })",
    "  .onConflictDoNothing();",
  ].join("\n");
  expect(guildInserts("src/application/sample.ts", good)).toEqual({ sites: 1, problems: [] });
  // Today's /config insert, before 2.35.0: it takes the column default, so the layout starts on.
  const columnDefault = "await db.insert(t.guilds).values({ id: guildId, effects_enabled: true });";
  expect(guildInserts("src/application/sample.ts", columnDefault).problems).toEqual([
    "src/application/sample.ts:1 doesn't spread NEW_GUILD_ROW",
  ]);
  const undone = "db.insert(t.guilds).values({ id, ...NEW_GUILD_ROW, role_layout_enabled: true })";
  expect(guildInserts("src/application/sample.ts", undone).problems).toEqual([
    "src/application/sample.ts:1 overrides a NEW_GUILD_ROW column",
  ]);
  expect(guildInserts("src/application/sample.ts", "store.insert(t.guilds);").problems).toEqual([
    "src/application/sample.ts:1 inserts a guild without .values(...)",
  ]);
  // A comment that names the call is no insert.
  expect(guildInserts("src/application/sample.ts", " * `.insert(t.guilds)` spreads it")).toEqual({
    sites: 0,
    problems: [],
  });
  // The importer keeps its explicit values, and must keep the layout off.
  const imported = "store.insert(t.guilds).values({ id, role_layout_enabled: false })";
  expect(guildInserts(IMPORTER, imported)).toEqual({ sites: 1, problems: [] });
  expect(
    guildInserts(IMPORTER, "store.insert(t.guilds).values({ id, effects_enabled: false })")
      .problems,
  ).toEqual([`${IMPORTER}:1 no longer sets role_layout_enabled: false`]);
});

test("every guild insert in src/ spreads NEW_GUILD_ROW, and the importer keeps the layout off", async () => {
  const found: string[] = [];
  const problems: string[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: root("src") })) {
    const file = `src/${path}`;
    const scan = guildInserts(file, await Bun.file(root(file)).text());
    if (scan.sites > 0) found.push(file);
    problems.push(...scan.problems);
  }
  // The scan must reach the known insert sites, or it would pass by finding nothing.
  expect(found).toEqual(
    expect.arrayContaining([
      "src/application/role-administration.ts",
      "src/application/service.ts",
      IMPORTER,
    ]),
  );
  expect(problems).toEqual([]);
});
