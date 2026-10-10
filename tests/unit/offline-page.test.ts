/**
 * Bundled Caddy's offline page (2.41.0, the owner's request of 2026-10-09): ops/Caddyfile answers
 * the static page in ops/offline only when the bot can't answer (Caddy's own 502, 503 or 504), as
 * a 503 that is never cached, with Retry-After and a strict CSP; serves the page's files under
 * /_offline/, a path the bot never uses; and keeps proxying everything else to the bot. The page
 * itself has no script, no inline style and no request beyond its own files, every one of which
 * exists. Caddy serves whatever the directory holds and follows symlinks, so it holds regular
 * files only, each tracked as an ordinary file, and dotfiles stay hidden all the same. The page
 * always goes out whole: the conditional and range headers are dropped before file_server.
 * docker-compose.web.yml, which every Compose manifest includes, mounts the directory read-only. tests/unit/web-parity.test.ts keeps its copied files identical to the docs site's;
 * docs-site.test.ts scans it as public content. Native Caddy validates and serves it in
 * web-server.test.ts's CADDY_FIXTURE_IMAGE test.
 */
import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { PATHS } from "../../src/web/http.js";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => Bun.file(root(path)).text();

/** The CSP both of Caddy's offline answers carry: this origin's styles, fonts and images only. */
const OFFLINE_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The text of the Caddyfile block opened by the line that starts with `opener`, braces balanced. */
function block(caddyfile: string, opener: string): string {
  const start = caddyfile.split("\n").findIndex((line) => line.trim().startsWith(opener));
  if (start < 0) throw new Error(`No block: ${opener}`);
  const lines = caddyfile.split("\n").slice(start);
  let depth = 0;
  const taken: string[] = [];
  for (const line of lines) {
    taken.push(line);
    depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
    // `{$WEB_PUBLIC_ORIGIN}` opens nothing: placeholders balance on their own line.
    if (depth <= 0 && taken.length > 1) break;
  }
  return taken.join("\n");
}

/** The directive lines of a block, comments and blank lines dropped, indentation trimmed. */
const directives = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

describe("the Caddyfile", () => {
  test("everything but /_offline/ still goes to the bot, with no access log", async () => {
    const caddyfile = await read("ops/Caddyfile");
    expect(directives(block(caddyfile, "handle {"))).toEqual([
      "handle {",
      "reverse_proxy tarubot:{$WEB_PORT:8080}",
      "}",
    ]);
    // No log directive anywhere: callback query strings carry authorization codes.
    expect(directives(caddyfile).filter((line) => /^log\b/u.test(line))).toEqual([]);
    // Nothing the bot serves lives under the offline prefix.
    for (const path of Object.values(PATHS)) expect(path.startsWith("/_offline")).toBe(false);
  });

  test("the offline page's files under /_offline/, from the mount's assets, with the CSP", async () => {
    const assets = directives(block(await read("ops/Caddyfile"), "handle_path /_offline/*"));
    expect(assets).toEqual([
      "handle_path /_offline/* {",
      "root * /srv/offline/assets",
      "header {",
      `Content-Security-Policy "${OFFLINE_CSP}"`,
      "X-Content-Type-Options nosniff",
      "X-Robots-Tag noindex",
      'Cache-Control "public, max-age=300"',
      "}",
      "file_server {",
      "hide .*",
      "}",
      "}",
    ]);
  });

  test("Caddy's own 502, 503 and 504 become the page: 503, no-store, Retry-After, a text fallback", async () => {
    const errors = directives(block(await read("ops/Caddyfile"), "handle_errors"));
    expect(errors).toEqual([
      "handle_errors 502 503 504 {",
      "root * /srv/offline",
      "header {",
      `Content-Security-Policy "${OFFLINE_CSP}"`,
      "X-Content-Type-Options nosniff",
      "X-Frame-Options DENY",
      "X-Robots-Tag noindex",
      "Referrer-Policy same-origin",
      "Cache-Control no-store",
      "Retry-After 60",
      "}",
      "@page file /index.html",
      "handle @page {",
      // Without these, file_server answers a conditional or range request with an empty or
      // partial body under the 503 (checked against the pinned image in web-server.test.ts).
      "request_header -If-Match",
      "request_header -If-None-Match",
      "request_header -If-Modified-Since",
      "request_header -If-Unmodified-Since",
      "request_header -If-Range",
      "request_header -Range",
      "rewrite * /index.html",
      "file_server {",
      "status 503",
      "hide .*",
      "}",
      "}",
      "handle {",
      'respond "TaruBot is offline right now. Try again in a few minutes." 503',
      "}",
      "}",
    ]);
  });

  test("docker-compose.web.yml mounts the page read-only, labelled like the Caddyfile", async () => {
    const compose = Bun.YAML.parse(await read("docker-compose.web.yml")) as {
      services: { caddy: { volumes: string[]; read_only: boolean; cap_drop: string[] } };
    };
    const { caddy } = compose.services;
    expect(caddy.volumes).toContain("./ops/Caddyfile:/etc/caddy/Caddyfile:ro,z");
    expect(caddy.volumes).toContain("./ops/offline:/srv/offline:ro,z");
    expect(caddy.read_only).toBe(true);
    expect(caddy.cap_drop).toEqual(["ALL"]);
    // Every manifest that runs bundled Caddy gets it through the one shared include.
    for (const manifest of [
      "docker-compose.yml",
      "docker-compose.staging.yml",
      "docker-compose.production.yml",
    ])
      expect(await read(manifest)).toContain("  - ./docker-compose.web.yml\n");
  });
});

describe("the offline page", () => {
  const assetsDirectory = "ops/offline/assets";
  const assets = readdirSync(root(assetsDirectory)).sort();

  test("one document by the page rules: lang, one h1, no script, inline style or handler", async () => {
    const markup = await read("ops/offline/index.html");
    expect(markup.startsWith("<!doctype html>")).toBe(true);
    expect(markup).not.toContain("style=");
    expect(markup.toLowerCase()).not.toContain("<script");
    expect(markup.toLowerCase()).not.toContain("<style");
    const { document } = parseHTML(markup);
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe("TaruBot is offline right now");
    expect(document.querySelector("title")?.textContent).toBe("TaruBot is offline");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
    for (const element of document.querySelectorAll("*"))
      for (const attribute of element.getAttributeNames())
        expect(attribute.startsWith("on")).toBe(false);
    expect(document.querySelectorAll("form, input, button, iframe, img, script")).toHaveLength(0);
    // The status page returns with TaruBot; the documentation site stays up.
    expect(document.querySelector('a[href="/status"]')).not.toBeNull();
    expect(
      document.querySelector('a[href="https://deconfined.github.io/tarubot/"]'),
    ).not.toBeNull();
  });

  test("it loads only its own files, each of which exists", async () => {
    const { document } = parseHTML(await read("ops/offline/index.html"));
    const loaded = [...document.querySelectorAll("link[href]")].map(
      (link) => link.getAttribute("href") ?? "",
    );
    const css = await read(`${assetsDirectory}/offline.css`);
    const fonts = [...css.matchAll(/url\("([^"]+)"\)/gu)].map((match) => match[1] ?? "");
    expect(css).not.toContain("@import");
    for (const path of [...loaded, ...fonts]) {
      expect({ path, offline: path.startsWith("/_offline/") }).toEqual({ path, offline: true });
      expect(assets).toContain(path.slice("/_offline/".length));
    }
    // Links leave only to the start page, the status page, GitHub and the documentation site.
    for (const link of document.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") ?? "";
      expect(
        href === "/" ||
          href === "/status" ||
          href.startsWith("/_offline/") ||
          href.startsWith("https://github.com/deconfined/tarubot") ||
          href === "https://deconfined.github.io/tarubot/",
      ).toBe(true);
    }
  });

  test("its directory holds the page's files and their licenses, nothing else", () => {
    expect(readdirSync(root("ops/offline")).sort()).toEqual(["assets", "index.html"]);
    expect(assets).toEqual([
      "favicon.svg",
      "jetbrains-mono-OFL.txt",
      "jetbrains-mono-latin-wght-normal.woff2",
      "manrope-OFL.txt",
      "manrope-latin-wght-normal.woff2",
      "offline.css",
      "sora-OFL.txt",
      "sora-latin-wght-normal.woff2",
      "third-party-licenses.txt",
      "tokens.css",
    ]);
  });

  test("only regular files and directories, none hidden: Caddy would follow a symlink anywhere", () => {
    // A link into /data/caddy, say, would publish Caddy's TLS keys under /_offline/.
    const entries: string[] = [];
    const walk = (path: string) => {
      for (const name of readdirSync(root(path))) {
        const entry = `${path}/${name}`;
        const stat = lstatSync(root(entry));
        expect({ entry, link: stat.isSymbolicLink(), hidden: name.startsWith(".") }).toEqual({
          entry,
          link: false,
          hidden: false,
        });
        expect({ entry, plain: stat.isFile() || stat.isDirectory() }).toEqual({
          entry,
          plain: true,
        });
        if (stat.isDirectory()) walk(entry);
        else entries.push(entry);
      }
    };
    walk("ops/offline");
    expect(entries).toContain("ops/offline/index.html");
    expect(entries).toHaveLength(11);
  });

  // A checkout without its history (the Docker test image) has nothing for Git to list.
  const tracked = Bun.spawnSync(["git", "ls-files", "-s", "--", "ops/offline"], {
    cwd: root("."),
    stdin: "ignore",
  });
  test.skipIf(tracked.exitCode !== 0)(
    "Git tracks each of its files as an ordinary file: mode 100644, no link, nothing executable",
    () => {
      const lines = tracked.stdout.toString().trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const [mode = "", , , path = ""] = line.split(/\s+/u);
        expect({ path, mode }).toEqual({ path, mode: "100644" });
      }
      // Until a change is staged nothing is listed; once anything is, everything on disk must be.
      if (lines.length > 0) expect(lines).toHaveLength(11);
    },
  );

  test("reduced motion stops its one animation", async () => {
    const css = await read(`${assetsDirectory}/offline.css`);
    const animated = [...css.matchAll(/^\s*\.([a-z-]+) \{[^}]*animation: (?!none)[a-z]/gmu)].map(
      (match) => match[1],
    );
    expect(animated).toEqual(["dot"]);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.dot \{\s*animation: none;/u,
    );
  });
});
