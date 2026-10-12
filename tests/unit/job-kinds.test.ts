/**
 * The worker claims only the job kinds this release's dispatcher can run (src/jobs/kinds.ts), so a
 * kind missing from the list would never run, silently. Source scans pin the list to the dispatcher
 * and to every call site that queues work; an integration test (persistence.test.ts) pins the claim.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_KIND } from "../../src/discord/presenters/jobs.js";
import { JOB_KINDS } from "../../src/jobs/kinds.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8");
const known = new Set<string>(JOB_KINDS);
/** Kinds the code names with a constant instead of a literal. */
const constants: Record<string, string> = {
  ROLE_CHOICE_KIND: "roles.self",
  MODMAIL_PING_KIND: "modmail.ping",
  MODMAIL_DM_KIND: "modmail.dm",
};

test("the list has no duplicates", () => {
  expect(new Set(JOB_KINDS).size).toBe(JOB_KINDS.length);
});

test("every kind the dispatcher branches on is in the list, and every listed kind is handled", () => {
  const dispatch = source("src/jobs/dispatch.ts");
  const literals = new Set([...dispatch.matchAll(/job\.kind === "([a-z.]+)"/gu)].map((m) => m[1]));
  for (const kind of literals)
    expect({ kind, listed: known.has(kind as string) }).toEqual({ kind, listed: true });
  const named = new Set(
    [...dispatch.matchAll(/job\.kind === ([A-Z_]+)/gu)].map((m) => constants[m[1] as string]),
  );
  for (const kind of named)
    expect({ kind, listed: known.has(kind as string) }).toEqual({ kind, listed: true });
  // The modmail kinds go through modmailJob(); check the file names the kind constants.
  expect(dispatch).toContain("MODMAIL_JOB_KINDS");
  for (const kind of JOB_KINDS) {
    const handled =
      literals.has(kind) ||
      named.has(kind) ||
      Object.values(constants).includes(kind) ||
      dispatch.includes(`"${kind}"`);
    expect({ kind, handled }).toEqual({ kind, handled: true });
  }
});

test("every kind a call site queues is in the list", () => {
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(root, "src") })];
  const found = new Set<string>();
  for (const file of files) {
    const text = source(`src/${file}`);
    for (const match of text.matchAll(
      /\b(?:enqueue|scheduleJob)\(\s*[\w.]+,\s*(?:"([a-z.]+)"|([A-Z_]+))/gu,
    )) {
      const kind = match[1] ?? constants[match[2] as string];
      expect({ file, kind: match[1] ?? match[2], resolved: kind !== undefined }).toEqual({
        file,
        kind: match[1] ?? match[2],
        resolved: true,
      });
      found.add(kind as string);
    }
  }
  expect(found.size).toBeGreaterThan(5);
  for (const kind of found)
    expect({ kind, listed: known.has(kind) }).toEqual({ kind, listed: true });
});

test("every kind members see a name for is one the worker claims", () => {
  for (const kind of Object.keys(JOB_KIND))
    expect({ kind, listed: known.has(kind) }).toEqual({ kind, listed: true });
});
