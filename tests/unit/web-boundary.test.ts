/**
 * Source rules for the web layer (#43, E2, B3 "Stored XSS"):
 * - views (src/web/views/**) import application, infrastructure, Drizzle and src/jobs as types
 *   only, like the Discord presenters (reply-guard.test.ts): a page's get() loads through
 *   services, and the view only formats what it was given;
 * - pages (src/web/pages/**) import at runtime only the domain, application/keys.js, the web
 *   layer and zod: state is reached through the services a page declares, which
 *   server.ts scopes to its `requires`, never by importing a store, the queue or Drizzle;
 * - the unescaped bypass (`raw(`) is called only in allow-listed constant files, and only those
 *   (plus html.ts, which re-exports it) may import it, so stored text can't reach a page unescaped;
 * - Hono's template helpers are reached only through src/web/html.ts, and the Hono pieces the
 *   design avoids (JSX, static files, CORS, caching, ETags, IP rules, dotted form parsing) stay out;
 * - templates never write a style attribute, a style element or a script, which the CSP blocks;
 * - first-party source stays .ts, so the four source-scanning guards (intents, secrets, reply and
 *   guild-default rules, which glob *.ts) keep covering the web.
 */
import { expect, test } from "bun:test";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Files allowed to call the bypass: constant markup only, never a value from a request, Discord,
 * the Lodestone or the database. Empty while no page needs one; adding a file here is a reviewed
 * decision, and the file's comment must say why its markup can't come from data.
 */
const RAW_ALLOWED: ReadonlySet<string> = new Set<string>();

/** The one module that re-exports Hono's template helpers to the rest of the web. */
const HTML_MODULE = "src/web/html.ts";

/** Every first-party source file under a directory, keyed by repository-relative path. */
async function sources(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob(`${directory}/**/*.ts`).scan({ cwd: ROOT }))
    files.set(path, await Bun.file(`${ROOT}${path}`).text());
  return files;
}

/** Module specifiers of runtime imports and re-exports (`import type` and `export type` excluded). */
function runtimeSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s*"([^"]+)"/gmu),
    ...text.matchAll(/^import\s*"([^"]+)"/gmu),
    ...text.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]/gu),
    ...text.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]/gu),
  ].map((match) => match[1] ?? "");
}

/** Code without block comments and whole-line `//` comments, for checks about what code emits. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

/** Layers a view may know only as types. */
const STATEFUL = /\/application\/|\/infrastructure\/|^drizzle-orm|\/jobs\//u;

test("the import scan finds runtime and type-only imports the way the rule needs", () => {
  const sample = [
    'import type { A } from "../../application/results.js";',
    'import { b, type C } from "../../infrastructure/x.js";',
    'export { d } from "../../jobs/queue.js";',
    'export type { E } from "../../application/e.js";',
    'import "drizzle-orm";',
    'const f = await import("../../application/service.js");',
  ].join("\n");
  expect(runtimeSpecifiers(sample)).toEqual([
    "../../infrastructure/x.js",
    "../../jobs/queue.js",
    "drizzle-orm",
    "../../application/service.js",
  ]);
});

test("views import application, infrastructure, Drizzle and jobs as types only (E2)", async () => {
  const views = await sources("src/web/views");
  // The scan must reach the views, or it would pass by finding nothing.
  expect([...views.keys()].sort()).toEqual(
    expect.arrayContaining(["src/web/views/servers.ts", "src/web/views/status.ts"]),
  );
  // Status does know application types; the rule is about how it imports them.
  expect(views.get("src/web/views/status.ts")).toMatch(
    /^import type \{[^}]*\} from "\.\.\/\.\.\/application\/results\.js";/mu,
  );
  for (const [path, text] of views)
    expect({
      path,
      forbidden: runtimeSpecifiers(text).filter((from) => STATEFUL.test(from)),
    }).toEqual({ path, forbidden: [] });
});

/** Packages a page may import at runtime: zod, to validate its forms. */
const PAGE_PACKAGES: ReadonlySet<string> = new Set(["zod"]);

/**
 * Whether a page at `path` may import `from` at runtime: a module under src/domain/ or src/web/,
 * application/keys.js (the service keys a page declares), or a PAGE_PACKAGES package.
 */
function pageMayImport(path: string, from: string): boolean {
  if (!from.startsWith(".")) return PAGE_PACKAGES.has(from);
  const target = posix.normalize(posix.join(posix.dirname(path), from));
  return (
    target.startsWith("src/domain/") ||
    target.startsWith("src/web/") ||
    target === "src/application/keys.js"
  );
}

test("the page import rule refuses stores, jobs and Drizzle, and allows what pages need", () => {
  const page = "src/web/pages/example.page.ts";
  for (const from of [
    "../../domain/policy.js",
    "../../application/keys.js",
    "../page.js",
    "../views/forms.js",
    "./helper.js",
    "zod",
  ])
    expect({ from, allowed: pageMayImport(page, from) }).toEqual({ from, allowed: true });
  for (const from of [
    "../../application/service.js",
    "../../application/self-roles.js",
    "../../infrastructure/postgres/database.js",
    "../../jobs/queue.js",
    "../../discord/gateway.js",
    "../../bot/services.js",
    "../../domain/../application/service.js",
    "drizzle-orm",
    "hono",
    "node:fs",
  ])
    expect({ from, allowed: pageMayImport(page, from) }).toEqual({ from, allowed: false });
});

test("pages import only the domain, application/keys.js, the web layer and zod at runtime", async () => {
  const pages = await sources("src/web/pages");
  // The scan must reach the pages, or it would pass by finding nothing.
  expect([...pages.keys()]).toEqual(
    expect.arrayContaining(["src/web/pages/configuration.page.ts", "src/web/pages/status.page.ts"]),
  );
  // Configuration does know an application type; the rule is about how it imports it.
  expect(pages.get("src/web/pages/configuration.page.ts")).toMatch(
    /^import type \{[^}]*\} from "\.\.\/\.\.\/application\/service\.js";/mu,
  );
  for (const [path, text] of pages)
    expect({
      path,
      refused: runtimeSpecifiers(text).filter((from) => !pageMayImport(path, from)),
    }).toEqual({ path, refused: [] });
});

test("raw( appears only in allow-listed constant files", async () => {
  const pattern = /\braw\s*\(/u;
  // The pattern finds direct, spaced and namespaced calls, and not lookalikes.
  for (const sample of ["raw(x)", "raw (x)", "h.raw(x)", "[raw(x), y]"])
    expect(pattern.test(sample)).toBe(true);
  for (const sample of ["c.req.raw.headers", "drawn(x)", "rawText(x)", "import { raw }"])
    expect(pattern.test(sample)).toBe(false);
  const files = await sources("src");
  expect(files.has(HTML_MODULE)).toBe(true);
  const callers = [...files].filter(([, text]) => pattern.test(text)).map(([path]) => path);
  expect(callers.filter((path) => !RAW_ALLOWED.has(path))).toEqual([]);
});

test("only html.ts and allow-listed files import the bypass, under any name", async () => {
  // Named imports of `raw` (aliased or not) and namespace imports of a module that exports it.
  const named =
    /import\s+(?!type\b)\{[^}]*\braw\b[^}]*\}\s*from\s*"(?:hono\/html|hono\/utils\/html|[^"]*\/html\.js)"/u;
  const namespace =
    /import\s+\*\s+as\s+\w+\s+from\s*"(?:hono\/html|hono\/utils\/html|[^"]*\/html\.js)"/u;
  expect(named.test('import { html, raw as r } from "./html.js"')).toBe(true);
  expect(namespace.test('import * as h from "hono/html"')).toBe(true);
  expect(named.test('import { html, untrusted } from "../html.js"')).toBe(false);
  const importers = [...(await sources("src"))]
    .filter(([, text]) => named.test(text) || namespace.test(text))
    .map(([path]) => path);
  expect(importers.filter((path) => path !== HTML_MODULE && !RAW_ALLOWED.has(path))).toEqual([]);
  expect(importers).toContain(HTML_MODULE);
});

test("Hono's template helpers are imported at runtime only by html.ts", async () => {
  for (const [path, text] of await sources("src")) {
    if (path === HTML_MODULE) continue;
    expect({
      path,
      direct: runtimeSpecifiers(text).filter((from) => /^hono\/(?:utils\/)?html$/u.test(from)),
    }).toEqual({ path, direct: [] });
  }
});

test("the web never uses the Hono pieces the design avoids", async () => {
  const avoided =
    /^hono\/(?:jsx|jsx-renderer|serve-static|bun|cors|cache|etag|ip-restriction)(?:\/|$)/u;
  for (const [path, text] of await sources("src")) {
    expect({
      path,
      avoided: runtimeSpecifiers(text).filter((from) => avoided.test(from)),
    }).toEqual({ path, avoided: [] });
    // parseBody({ dot: true }) builds nested objects from field names; forms are read flat.
    if (path.startsWith("src/web/"))
      expect({ path, dot: /\bdot\s*:\s*true\b/u.test(code(text)) }).toEqual({ path, dot: false });
  }
});

test("web templates never write a style attribute, a style element or a script", async () => {
  const files = await sources("src/web");
  expect(files.size).toBeGreaterThan(10);
  for (const [path, text] of files) {
    const emitted = code(text).toLowerCase();
    expect({
      path,
      style: emitted.includes("style="),
      element: emitted.includes("<style"),
      script: emitted.includes("<script"),
    }).toEqual({ path, style: false, element: false, script: false });
  }
});

test("first-party source is .ts only, so the source-scanning guards cover the web", async () => {
  const others: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.{tsx,jsx,js,mjs,cjs,mts,cts}").scan({
    cwd: ROOT,
  }))
    others.push(path);
  expect(others).toEqual([]);
});
