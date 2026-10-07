/**
 * The web's only static files (#43, ADR D11): the stylesheet and the site favicon, kept as string
 * constants so the image needs no asset directory and nothing is served from disk. Each path
 * carries a hash of its body, so a response can be cached as immutable and a new release's change
 * gets a new path.
 */
import { createHash } from "node:crypto";
import { DESIGN_TOKENS } from "./theme.js";

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
 * The exported design tokens, then the responsive console layout. Glass is reserved for the
 * sticky header/account menu; content stays solid. Status colors reinforce words with pips,
 * never low-contrast colored text. The light palette follows the device without client scripts.
 */
const CSS = `${DESIGN_TOKENS}
:root {
  color-scheme: dark light;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  scroll-padding-top: 6rem;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100dvh;
  background: var(--sl-color-bg);
  color: var(--sl-color-text);
  font: 100%/1.75 var(--font-sans);
  overflow-wrap: anywhere;
}

a {
  color: var(--sl-color-text-accent);
  text-underline-offset: 0.2em;
}

a:hover {
  color: var(--sl-color-white);
}

:focus-visible {
  outline: 2px solid var(--sl-color-accent);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  left: -100vw;
}

.skip:focus {
  left: 1rem;
  top: 1rem;
  z-index: 10;
  padding: 0.5rem 1rem;
  background: var(--sl-color-bg);
}

.masthead {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--glass);
  backdrop-filter: var(--glass-filter);
  border-bottom: 1px solid var(--glass-edge);
  box-shadow: var(--glass-shadow);
}

.masthead::after {
  content: "";
  position: absolute;
  inset: auto 0 -2px;
  height: 2px;
  background: var(--holo-foil);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  min-height: 4rem;
  padding: 0.5rem 1rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 2.75rem;
  font: 600 1.25rem/1.2 var(--font-display);
  color: var(--sl-color-white);
  text-decoration: none;
}

.brand img {
  width: 28px;
  height: 28px;
}

.server-switch {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--sl-color-white);
}

.account {
  position: relative;
  margin-left: auto;
}

.account > summary {
  padding: 0.25rem 0.75rem;
}

.account-menu {
  position: absolute;
  right: 0;
  width: 18rem;
  max-width: calc(100vw - 2rem);
  padding: 1rem;
  background: var(--glass);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  box-shadow: var(--glass-shadow);
}

.account-menu form {
  margin: 0 0 0.5rem;
}

.account-menu button {
  width: 100%;
}

button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding: 0.5rem 1rem;
  border: 1px solid var(--sl-color-accent);
  border-radius: var(--radius-mark);
  background: var(--sl-color-accent);
  color: var(--sl-color-bg);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.button:hover {
  color: var(--sl-color-bg);
}

.secondary {
  border-color: var(--sl-color-gray-3);
  background: transparent;
  color: var(--sl-color-white);
}

.workspace {
  width: 100%;
  max-width: 100rem;
  margin: 0 auto;
}

.server-nav {
  padding: 1.5rem 1rem;
  background: var(--sl-color-bg-sidebar);
}

.server-nav .server {
  color: var(--sl-color-white);
}

.server {
  margin: 0 0 0.75rem;
  font-weight: 600;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.links a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-mark);
  color: var(--sl-color-text);
  text-decoration: none;
}

.links a:hover,
.links a[aria-current="page"] {
  background: var(--sl-color-bg-inline-code);
  color: var(--sl-color-white);
}

.links a[aria-current="page"] {
  box-shadow: inset 3px 0 var(--sl-color-accent);
}

main {
  min-width: 0;
  padding: 2rem 1rem 3rem;
}

.landing {
  max-width: 48rem;
}

h1,
h2,
h3,
h4 {
  color: var(--sl-color-white);
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 1.2;
}

h1 {
  margin: 0 0 1rem;
  font-size: 35px;
}

h2 {
  margin: 2rem 0 1rem;
  font-size: 29px;
}

h3 {
  margin: 0 0 1rem;
  font-size: 24px;
}

p {
  margin: 0 0 1rem;
}

.lead {
  max-width: 65ch;
  margin-bottom: 1.5rem;
}

code,
.marker,
.check,
.readout,
.diagnostic {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

code {
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-mention);
  background: var(--sl-color-bg-inline-code);
  color: var(--sl-color-white);
}

.mention {
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-mention);
  background: var(--sl-color-accent-low);
  color: var(--sl-color-accent-high);
}

.note,
.ref,
.site-footer {
  color: var(--sl-color-gray-3);
  font-size: 0.875rem;
}

.panel {
  padding: 1.5rem;
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  background: var(--sl-color-bg-nav);
  margin: 1.5rem 0;
}

.panel h2:first-child,
.panel h3:first-child {
  margin-top: 0;
}

.featured {
  position: relative;
}

.featured::before {
  content: "";
  position: absolute;
  top: -1px;
  left: var(--radius-mark);
  right: var(--radius-mark);
  height: 2px;
  background: var(--holo-foil);
}

.dashboard-intro,
.settings-grid {
  display: grid;
  gap: 2rem;
  margin-bottom: 2rem;
}

.settings-section h3 {
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--sl-color-gray-4);
}

.facts {
  display: grid;
  grid-template-columns: minmax(6rem, 35%) minmax(0, 1fr);
  margin: 0;
  font-size: 0.875rem;
}

.facts dt,
.facts dd {
  margin: 0;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.facts dt {
  padding-right: 1rem;
  color: var(--sl-color-gray-3);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1rem;
  margin: 1rem 0;
  padding: 1rem 0;
  border-block: 1px solid var(--sl-color-gray-4);
}

.metrics dt {
  font-size: 0.75rem;
}

.metrics dd {
  margin: 0.25rem 0 0;
  color: var(--sl-color-white);
  font: 600 1.75rem/1.2 var(--font-display);
}

.table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.data-table {
  width: 100%;
  min-width: 64rem;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.875rem;
  line-height: 1.6;
}

.data-table caption {
  text-align: left;
  margin-bottom: 0.75rem;
  color: var(--sl-color-gray-3);
}

.data-table th,
.data-table td {
  padding: 0.875rem 0.75rem;
  vertical-align: top;
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.data-table thead th {
  border-bottom-color: var(--sl-color-gray-4);
  color: var(--sl-color-gray-3);
  font-weight: 500;
  white-space: nowrap;
}

.data-table tbody th {
  font-weight: 400;
  color: var(--sl-color-white);
}

.data-table td code,
.data-table th code {
  font-size: 0.75rem;
  white-space: nowrap;
  overflow-wrap: normal;
}

.data-table time {
  white-space: nowrap;
}

.servers,
.items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.servers > li {
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--sl-color-gray-4);
}

.items > li {
  padding: 0.5rem 0;
}

.marker,
.check {
  font-weight: 500;
  white-space: nowrap;
  color: var(--sl-color-white);
}

.marker::before,
.check::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 0.5rem;
  border-radius: var(--radius-pip);
  background: var(--tone-neutral);
}

.marker-done::before,
.check-ok::before {
  background: var(--tone-success);
}

.marker-queued::before,
.marker-running::before,
.marker-waiting::before,
.marker-paused::before,
.check-wait::before {
  background: var(--tone-pending);
}

.marker-blocked::before,
.check-warn::before {
  background: var(--tone-warning);
}

.marker-failed::before,
.check-fail::before {
  background: var(--tone-error);
}

summary {
  min-height: 2.75rem;
  cursor: pointer;
  color: var(--sl-color-text-accent);
}

.job-details[open] {
  min-width: 18rem;
  max-width: 30rem;
}

.diagnostic {
  white-space: pre-wrap;
  margin-top: 0.75rem;
  color: var(--sl-color-white);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin: 1rem 0;
}

.site-footer {
  max-width: 100rem;
  margin: 0 auto;
  padding: 1.5rem;
  border-top: 1px solid var(--sl-color-gray-4);
}

.site-footer p {
  margin: 0;
}

@media (min-width: 50em) {
  .bar {
    padding-inline: 1.5rem;
  }
  .console {
    display: grid;
    grid-template-columns: 14rem minmax(0, 1fr);
    min-height: calc(100dvh - 9rem);
  }
  .server-nav {
    position: sticky;
    top: 4.125rem;
    align-self: start;
    min-height: calc(100dvh - 4.125rem);
    padding-top: 2rem;
  }
  .server-nav .links {
    flex-direction: column;
  }
  .server-nav .links a {
    width: 100%;
  }
  main {
    padding: 2.5rem;
  }
  h1 {
    font-size: 42px;
  }
  .settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2.5rem 3.5rem;
  }
}

@media (min-width: 80em) {
  .dashboard-intro {
    grid-template-columns: minmax(0, 1fr) minmax(24rem, 1fr);
  }
  .dashboard-intro .panel {
    margin-top: 0;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .masthead,
  .account-menu {
    background: var(--sl-color-bg-nav);
    backdrop-filter: none;
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
