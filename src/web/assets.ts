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
  gap: 0.75rem 1.5rem;
  min-height: 4.5rem;
  max-width: 100rem;
  margin: 0 auto;
  padding: 0.75rem 1.25rem;
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
  flex-direction: column;
  justify-content: center;
  gap: 0.125rem;
  min-width: 0;
  min-height: 2.75rem;
  max-width: 24rem;
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  color: var(--sl-color-white);
  line-height: 1.3;
  text-decoration: none;
}

.server-switch:hover,
.account > summary:hover {
  background: var(--sl-color-bg-inline-code);
}

.switch-name {
  overflow: hidden;
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switch-label {
  color: var(--sl-color-text);
  font-size: 0.75rem;
}

.account {
  position: relative;
  margin-left: auto;
}

.account > summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  color: var(--sl-color-white);
  font-size: 0.875rem;
  list-style: none;
}

.account > summary::-webkit-details-marker {
  display: none;
}

.account > summary::after {
  content: "";
  width: 0.375rem;
  height: 0.375rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.account[open] > summary::after {
  transform: rotate(225deg);
}

.account-menu {
  position: absolute;
  top: calc(100% + 0.625rem);
  right: 0;
  width: 17rem;
  max-width: calc(100vw - 2rem);
  padding: 0.5rem;
  background: var(--glass);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  box-shadow: var(--glass-shadow);
}

.menu-caption {
  margin: 0;
  padding: 0.5rem 0.75rem;
  color: var(--sl-color-text);
  font-size: 0.75rem;
}

.account-menu form {
  margin: 0;
}

.account-menu button {
  justify-content: flex-start;
  width: 100%;
  border: 0;
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
  font: 600 0.875rem/1.5 var(--font-sans);
  text-decoration: none;
  cursor: pointer;
}

.button:hover,
button:hover {
  background: var(--sl-color-text-accent);
  color: var(--sl-color-bg);
}

.secondary {
  border-color: var(--sl-color-gray-3);
  background: transparent;
  color: var(--sl-color-white);
}

.secondary:hover {
  background: var(--sl-color-bg-inline-code);
  color: var(--sl-color-white);
}

.workspace {
  width: 100%;
  max-width: 100rem;
  margin: 0 auto;
}

.server-nav {
  padding: 0.75rem 1rem;
  background: var(--sl-color-bg-sidebar);
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.server-nav .links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.nav-caption,
.nav-context {
  display: none;
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
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-mark);
  color: var(--sl-color-text);
  font-size: 0.875rem;
  line-height: 1.45;
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
  padding: 1.75rem 1rem 3rem;
}

.landing {
  max-width: 72rem;
  min-height: calc(100dvh - 10rem);
}

.page-heading {
  margin-bottom: 1.5rem;
}

.eyebrow {
  margin: 0 0 0.625rem;
  color: var(--sl-color-gray-3);
  font: 600 0.6875rem/1.4 var(--font-sans);
  letter-spacing: 0.12em;
  text-transform: uppercase;
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
  margin: 0;
  font-size: 35px;
}

h2 {
  margin: 2.5rem 0 1rem;
  font-size: 24px;
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
  margin-bottom: 0.75rem;
  color: var(--sl-color-white);
  font-size: 1.0625rem;
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
  margin: 0;
  padding: 1.25rem 1.5rem;
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-mark);
  background: var(--sl-color-bg-nav);
}

.panel h2,
.panel h3 {
  margin: 0;
  font-size: 24px;
}

.panel-heading {
  margin-bottom: 0.875rem;
}

.panel-heading .note {
  margin-bottom: 0.5rem;
}

.panel-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
}

.panel > .note {
  margin: 0;
  font-size: 0.75rem;
}

p.health-summary {
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
}

.health-summary strong {
  color: var(--sl-color-white);
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

.dashboard-intro {
  display: grid;
  align-items: start;
  gap: 1.5rem;
  margin-bottom: 2.5rem;
}

.intro-copy {
  min-width: 0;
}

.state-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.25rem 0;
}

.state-pill {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  min-height: 2rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mention);
  font-size: 0.75rem;
}

.state-pill .check {
  font-size: 0.6875rem;
}

.state-pill strong {
  color: var(--sl-color-white);
  font-weight: 600;
}

.notice {
  margin: 0;
  color: var(--sl-color-gray-3);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.section-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem 1.5rem;
  margin-bottom: 1rem;
}

.section-heading h2 {
  margin: 0;
}

.section-description,
.settings-description {
  margin: 0;
  color: var(--sl-color-gray-3);
  font-size: 0.875rem;
  line-height: 1.6;
}

section + section {
  margin-top: 2.5rem;
}

.settings-grid {
  display: grid;
  gap: 1.25rem;
}

.settings-section,
.check-group {
  min-width: 0;
  margin: 0;
  padding: 1.25rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
  background: var(--sl-color-bg);
}

.settings-section h3,
.check-group h3 {
  margin: 0 0 0.375rem;
  font-size: 20px;
}

.settings-description {
  margin-bottom: 1rem;
  font-size: 0.8125rem;
}

.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-group h3 {
  margin-bottom: 1rem;
}

.check-row {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr);
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.5rem 0;
}

.check-copy {
  font-size: 0.875rem;
  line-height: 1.6;
}

.check-row.health-summary {
  margin-bottom: 0.25rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.check-row.health-summary .check-copy {
  color: var(--sl-color-white);
  font-size: 1.0625rem;
  font-weight: 600;
}

.status-intro {
  grid-template-columns: minmax(0, 1fr);
}

.status-intro .check-row.health-summary {
  padding-bottom: 0.5rem;
  border-bottom: 0;
}

.facts {
  display: grid;
  grid-template-columns: minmax(5.5rem, 36%) minmax(0, 1fr);
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.65;
}

.facts dt,
.facts dd {
  margin: 0;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.facts dt {
  padding-right: 0.75rem;
  color: var(--sl-color-gray-3);
  font-size: 0.8125rem;
}

.facts > :nth-last-child(-n + 2) {
  border-bottom: 0;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin: 1.25rem 0;
}

.metrics > div {
  min-width: 0;
  padding: 0.875rem 1rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
}

.metrics dt,
.metrics .marker {
  font-size: 0.6875rem;
}

.metrics dd {
  margin: 0.5rem 0 0;
  color: var(--sl-color-white);
  font: 600 1.75rem/1.2 var(--font-display);
}

.table-scroll {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
}

.data-table {
  width: 100%;
  min-width: 50rem;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.875rem;
  line-height: 1.55;
}

.data-table caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.data-table th,
.data-table td {
  padding: 1rem 1.25rem;
  vertical-align: top;
  border-bottom: 1px solid var(--sl-color-bg-inline-code);
}

.data-table thead th {
  background: var(--sl-color-bg-nav);
  color: var(--sl-color-gray-3);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}

.data-table tbody th {
  font-weight: 400;
  color: var(--sl-color-white);
}

.data-table code {
  padding: 0;
  background: none;
  font-size: 0.75rem;
}

.data-table tbody tr:last-child > * {
  border-bottom: 0;
}

.data-table tbody tr:hover,
.data-table tbody tr:focus-within {
  background: var(--sl-color-bg-nav);
}

.cell-title,
.cell-meta {
  display: block;
}

.cell-title {
  color: var(--sl-color-white);
  font-weight: 600;
}

.cell-meta {
  margin-top: 0.25rem;
  color: var(--sl-color-gray-3);
  font-size: 0.75rem;
}

.cell-meta code {
  color: inherit;
  white-space: nowrap;
}

.time-stack {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  color: var(--sl-color-gray-3);
  font-size: 0.75rem;
}

.data-table time {
  display: block;
  color: var(--sl-color-text);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.servers {
  display: grid;
  gap: 1.25rem;
  margin: 2rem 0 0;
  padding: 0;
  list-style: none;
}

.server-card {
  min-width: 0;
  padding: 1.5rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
}

.server-card h2 {
  margin: 0 0 0.5rem;
  font-size: 24px;
}

.workspace-links {
  flex-direction: column;
  gap: 0;
}

.workspace-links a {
  justify-content: space-between;
  min-height: 3.25rem;
  padding-inline: 0;
  border-top: 1px solid var(--sl-color-bg-inline-code);
  border-radius: 0;
  color: var(--sl-color-text-accent);
}

.workspace-links a:hover {
  color: var(--sl-color-white);
}

.welcome {
  display: grid;
  align-items: start;
  gap: 2rem;
}

.welcome-heading h1 {
  font-size: clamp(42px, 5vw, 64px);
}

.welcome-copy h2 {
  max-width: 20ch;
  margin: 0 0 1rem;
  font-size: clamp(24px, 3vw, 35px);
}

.welcome-lead {
  max-width: 45ch;
  font-size: 1.125rem;
  line-height: 1.7;
}

.welcome-features {
  margin: 2rem 0 0;
}

.welcome-features > div {
  padding: 1rem 0;
  border-top: 1px solid var(--sl-color-bg-inline-code);
}

.welcome-features dt {
  color: var(--sl-color-white);
  font-weight: 600;
}

.welcome-features dd {
  max-width: 45ch;
  margin: 0.25rem 0 0;
  color: var(--sl-color-gray-3);
  font-size: 0.875rem;
}

.entry-card {
  margin: 0;
  padding: 1.5rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
}

.entry-card h2 {
  margin: 0 0 0.75rem;
  font-size: 24px;
}

.entry-card .button {
  width: 100%;
  margin-block: 0.5rem;
}

.access-details {
  margin-top: 1.25rem;
  border-top: 1px solid var(--sl-color-bg-inline-code);
  font-size: 0.875rem;
}

.access-details > summary {
  display: list-item;
  padding-block: 0.875rem;
}

.empty-state {
  padding: 2rem;
  border: 1px solid var(--sl-color-bg-inline-code);
  border-radius: var(--radius-mark);
}

.empty-state h2 {
  margin-top: 0;
}

.empty-state > :last-child {
  margin-bottom: 0;
}


.marker,
.check {
  font-weight: 500;
  white-space: nowrap;
  color: var(--sl-color-white);
  font-variant-emoji: text;
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

.job-details > summary {
  display: list-item;
  padding-block: 0.5rem;
  font-size: 0.8125rem;
}

.data-table .job-details[open] {
  min-width: 16rem;
  max-width: 28rem;
}

.job-details .facts {
  grid-template-columns: 5.5rem minmax(0, 1fr);
  column-gap: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.8125rem;
}

.job-details code {
  white-space: normal;
  overflow-wrap: anywhere;
}

.job-details pre {
  max-width: 100%;
  margin: 0.75rem 0 0;
  white-space: pre-wrap;
}

.job-details pre code {
  display: block;
  white-space: inherit;
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
  padding: 1.25rem 1.5rem;
  border-top: 1px solid var(--sl-color-bg-inline-code);
  font-size: 0.75rem;
}

.site-footer p {
  margin: 0;
}

@media (min-width: 50em) {
  .bar {
    padding-inline: 1.5rem;
  }
  .brand {
    min-width: 12.5rem;
  }
  .console {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    min-height: calc(100dvh - 9rem);
  }
  .server-nav {
    position: sticky;
    top: 4.625rem;
    display: flex;
    flex-direction: column;
    align-self: start;
    min-height: calc(100dvh - 4.625rem);
    padding: 2rem 1rem;
    border-right: 1px solid var(--sl-color-bg-inline-code);
    border-bottom: 0;
  }
  .nav-caption {
    display: block;
    margin: 0 0 0.75rem;
    padding-inline: 0.875rem;
    color: var(--sl-color-gray-3);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .nav-context {
    display: block;
    margin-top: auto;
    padding: 2rem 0.875rem 0;
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .nav-context p {
    margin: 0 0 0.375rem;
  }
  .nav-context span {
    color: var(--sl-color-gray-3);
  }
  .server-nav .links {
    display: flex;
    flex-direction: column;
  }
  main {
    padding: 2rem 2.5rem 3.5rem;
  }
  h1 {
    font-size: 42px;
  }
  .status-intro .checklist {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem 1.25rem;
  }
  .status-intro .check-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0.5rem 0;
  }
  .status-intro .check-row.health-summary .check-copy {
    font-size: 0.875rem;
  }
  .landing main {
    padding-block: 4rem;
  }
  .settings-grid,
  .servers {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .welcome {
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    gap: 3.5rem;
  }
}

@media (min-width: 68.75em) {
  .dashboard-intro {
    grid-template-columns: minmax(0, 1fr) minmax(21rem, 0.9fr);
  }
  .dashboard-intro.status-intro {
    grid-template-columns: minmax(0, 1fr);
  }
  .status-intro .checklist {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (min-width: 87.5em) {
  .metrics {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (min-width: 95em) {
  .settings-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 49.99em) {
  /* The server selector adds a second sticky header row on phones. */
  html {
    scroll-padding-top: 9rem;
  }
  .server-switch {
    order: 3;
    width: 100%;
    max-width: none;
  }
  .server-nav .links a {
    justify-content: center;
    text-align: center;
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
