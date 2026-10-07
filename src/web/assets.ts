/**
 * The web's only static files (#43, ADR D11): the stylesheet and the site favicon, kept as string
 * constants so the image needs no asset directory and nothing is served from disk. Each path
 * carries a hash of its body, so a response can be cached as immutable and a new release's change
 * gets a new path.
 */
import { createHash } from "node:crypto";

/** One static file. */
export interface Asset {
  /** `/assets/<name>.<hash>.<ext>`; the hash is the first 12 hex digits of the body's SHA-256. */
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
}

/** Hashed paths never change content, so browsers may keep them for a year without revalidating. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Build an asset whose path is derived from its body. */
function asset(name: string, extension: string, contentType: string, body: string): Asset {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return { path: `/assets/${name}.${hash}.${extension}`, contentType, body };
}

/**
 * Phones first: system fonts, one column down to 320 px, tap targets of at least 24 px (44 px for
 * buttons and navigation), visible focus outlines, light and dark schemes with AA contrast. Templates
 * use classes only, never `style=` attributes, which the CSP blocks.
 *
 * Contrast (WCAG 2.x relative luminance), text on its background, light / dark:
 * - text #1a1b1e on #fff 17:1 / #e9ecef on #16181d 15:1; muted #495057 8.2:1 / #adb5bd 8.6:1;
 * - links and buttons #3b5bdb 5.7:1 (white on it 5.7:1) / #91a7ff 7.8:1 (#16181d on it 7.8:1);
 * - ok #1e6b30 6.6:1 / #69db7c 10:1; wait #a35200 5.6:1 / #ffc078 11:1; bad #c92a2a 5.4:1 /
 *   #ff8787 7.7:1. Markers and checks always carry their word, so color only reinforces it.
 * Change a color only with its ratio recomputed here; AA needs 4.5:1 for body text.
 */
const CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1b1e;
  --muted: #495057;
  --surface: #f1f3f5;
  --border: #ced4da;
  --accent: #3b5bdb;
  --on-accent: #ffffff;
  --ok: #1e6b30;
  --wait: #a35200;
  --bad: #c92a2a;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d;
    --fg: #e9ecef;
    --muted: #adb5bd;
    --surface: #212529;
    --border: #495057;
    --accent: #91a7ff;
    --on-accent: #16181d;
    --ok: #69db7c;
    --wait: #ffc078;
    --bad: #ff8787;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--bg);
  color: var(--fg);
  font: 100%/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  overflow-wrap: anywhere;
}

a {
  color: var(--accent);
  text-underline-offset: 0.15em;
}

:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  left: -100vw;
}

.skip:focus {
  left: 1rem;
  top: 1rem;
  z-index: 1;
  padding: 0.5rem 1rem;
  background: var(--bg);
}

.masthead,
main,
.site-footer {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding: 1rem;
}

.masthead {
  border-bottom: 1px solid var(--border);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  font-weight: 700;
  font-size: 1.25rem;
  color: var(--fg);
  text-decoration: none;
}

.account {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.account form {
  margin: 0;
}

button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding: 0.5rem 1rem;
  border: 2px solid var(--accent);
  border-radius: 0.375rem;
  background: var(--accent);
  color: var(--on-accent);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

button.secondary {
  background: transparent;
  color: var(--accent);
}

.server-nav {
  margin-top: 1rem;
}

.server {
  margin: 0 0 0.5rem;
  font-weight: 600;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.links a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  text-decoration: none;
}

.links a[aria-current="page"] {
  border: 2px solid var(--accent);
  background: var(--surface);
  font-weight: 600;
}

h1 {
  margin: 0.5rem 0 1rem;
  font-size: 1.75rem;
  line-height: 1.2;
}

h2 {
  margin: 2rem 0 0.5rem;
  font-size: 1.25rem;
  line-height: 1.3;
}

code,
.marker,
.check {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}

code {
  padding: 0.1em 0.3em;
  border-radius: 0.25rem;
  background: var(--surface);
}

.servers,
.items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.servers > li,
.items > li {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border);
}

.marker,
.check {
  font-weight: 700;
  white-space: nowrap;
}

.marker-done,
.check-ok {
  color: var(--ok);
}

.marker-queued,
.marker-running,
.marker-waiting,
.marker-paused,
.check-wait,
.check-off {
  color: var(--wait);
}

.marker-blocked,
.marker-failed,
.check-fail {
  color: var(--bad);
}

.note,
.ref,
.site-footer {
  color: var(--muted);
}

.site-footer {
  margin-top: 2rem;
  border-top: 1px solid var(--border);
  font-size: 0.875rem;
}

.site-footer a {
  color: inherit;
}

@media (min-width: 40rem) {
  h1 {
    font-size: 2rem;
  }
}
`;

/** The site's favicon (site/public/favicon.svg), byte for byte. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>TaruBot</title>
  <rect width="32" height="32" rx="7" fill="#3b5bdb"/>
  <path d="M8 9h16v4h-6v12h-4V13H8z" fill="#fff"/>
</svg>
`;

export const STYLESHEET: Asset = asset("site", "css", "text/css; charset=utf-8", CSS);
export const FAVICON: Asset = asset("favicon", "svg", "image/svg+xml", FAVICON_SVG);

/** Every asset, each served by server.ts at its own hashed path. */
export const ASSETS: readonly Asset[] = [STYLESHEET, FAVICON];
