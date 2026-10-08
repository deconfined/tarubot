/**
 * The console frame around a server page (layout.ts), phones first: a sticky glass bar with the
 * wordmark, the server switcher and the account menu, the page navigation as a strip under it,
 * then the page. From 64rem the bar becomes the design's 248px glass sidebar (wordmark, switcher,
 * navigation, account menu at the bottom) beside a sticky 60px glass top bar with the page's
 * label, and the page sits in a 1180px column with 32px gutters (16px on phones).
 *
 * The design kit has no layout below desktop width and builds its shell from inline styles; these
 * classes are TaruBot's own, with the kit's values. The page header and the footer are shared
 * with the entry pages (entry.ts).
 */
export const SHELL_CSS = `/* Shell: the console frame, after the Orrery dashboard kit */

/* Keeps a focused element or an anchor target clear of the sticky bars (WCAG 2.4.11). */
html {
  scroll-padding-top: 7.5rem;
}

/*
 * The nebula wash behind the console's glass: a fixed layer rather than
 * background-attachment: fixed, which repaints on every scroll and which iOS ignores.
 */
.console-page::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background: var(--nebula-cyan), var(--nebula-violet);
  pointer-events: none;
}

.app {
  min-height: 100dvh;
}

/* The bar on phones; the sidebar from 64rem. */
.sidebar {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "wordmark switch account"
    "nav nav nav";
  align-items: center;
  column-gap: var(--space-3);
  padding: 10px var(--space-4) 0;
  background: oklch(0.12 0.03 280 / 0.72);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-bottom: 1px solid var(--border-subtle);
}

.sidebar > .wordmark {
  grid-area: wordmark;
}

.sidebar > .server-switch {
  grid-area: switch;
}

.sidebar > .side-nav {
  grid-area: nav;
}

.sidebar > .account {
  grid-area: account;
}

/* The type-only wordmark (no logo exists); the design's one serif use below 28px. */
.wordmark {
  font: 400 var(--text-2xl) / 1 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-display);
  white-space: nowrap;
  color: var(--text-primary);
  text-decoration: none;
}

/*
 * The server switcher: a link back to the server list, filled like the kit's but without its own
 * blur, since it sits on the glass bar. The name truncates; the full name is on the server list.
 */
.server-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 44px;
  padding: 6px 8px;
  border-radius: 12px;
  color: var(--text-primary);
  text-decoration: none;
  background: var(--glass-fill);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--inner-highlight);
  transition: box-shadow var(--dur-base) var(--ease-out);
}

.server-switch:hover {
  box-shadow:
    inset 0 0 0 1px var(--border-accent),
    var(--inner-highlight),
    var(--glow-cyan-sm);
}

.server-switch .orr-avatar {
  --size: 28px;
}

.server-switch__text {
  display: grid;
  flex: 1;
  gap: 4px;
  min-width: 0;
}

.server-switch__name {
  overflow: hidden;
  font: 600 var(--text-md) / 1.2 var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The name itself is the isolate (untrusted() gives it dir="auto"), so the ellipsis goes on it:
 * there it cuts the name's end in the name's own direction. On the line box around it, a name in
 * a right-to-left script would lose its start and show only a trailing Latin part. A name that
 * fits stays at the left, beside the initials, whatever its direction.
 */
.server-switch__name > [dir="auto"] {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.server-switch__hint {
  overflow: hidden;
  font: 500 var(--text-2xs) / 1.2 var(--font-mono);
  letter-spacing: 0.08em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--text-muted);
}

.server-switch > .orr-icon {
  font-size: 1rem;
  color: var(--text-muted);
}

/* The page navigation: a strip of tabs on phones, the kit's nav items in the sidebar. */
.side-nav {
  min-width: 0;
  margin-top: 6px;
}

.side-nav__caption,
.side-nav__context {
  display: none;
}

.side-nav__list {
  display: grid;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 8px;
  color: var(--text-muted);
  font: var(--type-ui);
  text-align: center;
  text-decoration: none;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.nav-item .orr-icon {
  font-size: 1rem;
}

.nav-item:hover,
.nav-item[aria-current="page"] {
  color: var(--text-primary);
}

.nav-item[aria-current="page"] {
  font-weight: 600;
}

/* Glow is for the active item only (the design's rule). */
.nav-item[aria-current="page"] .orr-icon {
  color: var(--cyan-400);
  filter: drop-shadow(0 0 6px currentColor);
}

.nav-item::after {
  content: "";
  position: absolute;
  right: 10px;
  bottom: 0;
  left: 10px;
  height: 2px;
  border-radius: 2px;
  background: var(--cyan-400);
  box-shadow: 0 0 10px var(--cyan-400);
  opacity: 0;
}

.nav-item[aria-current="page"]::after {
  opacity: 1;
}

/*
 * The account menu: a disclosure whose panel floats under its summary on phones and over it in
 * the sidebar. The panel has the strong glass's gradient over an opaque surface and no blur of its
 * own: inside the bar's glass, a nested backdrop blur only reaches the bar, so the page and the
 * sidebar's text would show through it unblurred (and the design never nests glass).
 */
.account {
  position: relative;
}

.account__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font: var(--type-ui-sm);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  list-style: none;
  box-shadow: inset 0 0 0 1px var(--border-default);
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.account__summary::-webkit-details-marker {
  display: none;
}

.account__summary:hover,
.account[open] > .account__summary {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.account__summary .orr-icon {
  font-size: 0.875rem;
  color: var(--text-muted);
  transition: transform var(--dur-fast) var(--ease-out);
}

.account[open] > .account__summary .orr-icon {
  transform: rotate(180deg);
}

.account__menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: var(--z-dropdown);
  display: grid;
  gap: 2px;
  width: 16rem;
  max-width: calc(100vw - 2 * var(--space-4));
  padding: 8px;
  border-radius: var(--radius-lg);
  background: var(--glass-fill-strong), var(--surface-1);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--glass-edge),
    var(--shadow-3);
}

.account__caption {
  padding: 6px 10px 8px;
}

.account__menu form {
  margin: 0;
}

.account__action {
  justify-content: flex-start;
}

.frame {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* The top bar (from 64rem): the page's label, repeating the h1 for sight only. */
.topbar {
  display: none;
}

.topbar__separator {
  margin: 0 10px;
  color: var(--text-faint);
}

.topbar__page {
  color: var(--text-secondary);
}

/*
 * The page: its header, then the view's sections, one column of blocks 32px apart. The column
 * track is minmax(0, 1fr), so a wide table scrolls in its own region instead of widening the page.
 */
.main {
  display: grid;
  flex: 1 0 auto;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: var(--space-8);
  width: 100%;
  max-width: calc(var(--content-max) + 2 * var(--gutter));
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-12);
}

/* The page header: an eyebrow, the serif h1; a view's opening .lead reads as its description. */
.page-header {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.page-header__title {
  color: var(--text-primary);
  font: 400 clamp(var(--display-sm), 6vw, 2.75rem) / 1.05 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-display);
}

.page-header + .lead {
  margin-top: calc(var(--space-3) - var(--space-8));
}

/* The footer: version, source and licenses (AGPL-3.0 section 13), on every page. */
.site-footer {
  width: 100%;
  max-width: calc(var(--content-max) + 2 * var(--gutter));
  margin: 0 auto;
  padding: 0 var(--space-4) var(--space-6);
  color: var(--text-muted);
  font: var(--type-caption);
}

.site-footer p {
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

.site-footer a {
  color: var(--text-secondary);
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 3px;
}

.site-footer a:hover {
  color: var(--text-primary);
  text-decoration-color: currentColor;
}

/*
 * The bar, below 64rem. The open account menu hangs under the whole bar, at the bar's edge, so it
 * never covers the navigation strip; while it is open the scroll padding grows past its panel, so
 * the panel can't hide whatever takes focus either (WCAG 2.4.11). A disclosure stays open until
 * its summary is used again, so the panel must stay clear of focus by itself.
 */
@media (max-width: 63.99rem) {
  .sidebar > .account {
    position: static;
  }
  .sidebar .account__menu {
    right: var(--space-4);
  }
}

@media (min-width: 40rem) and (max-width: 63.99rem) {
  .sidebar .account__menu {
    right: var(--gutter);
  }
}

@media (max-width: 63.99rem) and (min-height: 30rem) {
  html:has(.sidebar > .account[open]) {
    scroll-padding-top: 15.5rem;
  }
}

/*
 * A short viewport, such as a phone in landscape or 400% zoom: a sticky bar would take half the
 * screen, so it scrolls away with the page and no longer needs the scroll padding.
 */
@media (max-width: 63.99rem) and (max-height: 29.99rem) {
  .sidebar {
    position: relative;
  }
  html {
    scroll-padding-top: 0;
  }
}

/*
 * Narrow phones: the switcher keeps the server's name, moving its hint to assistive text, and on
 * the narrowest drops the decorative initials too. The navigation tabs get the smaller UI size and
 * tighter padding, and below 360px lose their icons, so each label keeps to one line; a larger
 * text setting may still wrap one, rather than spill out of its tab.
 */
@media (max-width: 23.99rem) {
  .server-switch .orr-avatar {
    display: none;
  }
}

@media (max-width: 22.49rem) {
  .nav-item .orr-icon {
    display: none;
  }
}

@media (max-width: 29.99rem) {
  .server-switch__hint {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .server-switch > .orr-icon {
    display: none;
  }
  .nav-item {
    padding-inline: 4px;
    font: var(--type-ui-sm);
  }
}

@media (min-width: 30rem) {
  .wordmark {
    font-size: 1.625rem;
  }
}

/* From tablet width, the 32px gutters. */
@media (min-width: 40rem) {
  .sidebar {
    padding-inline: var(--gutter);
  }
  .main {
    padding-inline: var(--gutter);
  }
  .site-footer {
    padding-inline: var(--gutter);
  }
}

@media (min-width: 64rem) {
  html {
    scroll-padding-top: calc(var(--topbar-h) + 1.5rem);
  }
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 18px;
    align-items: stretch;
    align-self: start;
    height: 100vh;
    height: 100dvh;
    overflow-y: auto;
    padding: 20px 14px 14px;
    background: oklch(0.105 0.027 280 / 0.78);
    border-right: 1px solid var(--border-subtle);
    border-bottom: 0;
  }
  .sidebar > .wordmark {
    padding: 0 8px;
  }
  .server-switch {
    padding: 8px;
  }
  .server-switch .orr-avatar {
    --size: 34px;
  }
  .side-nav {
    display: flex;
    flex: 1 0 auto;
    flex-direction: column;
    margin: 0;
  }
  .side-nav__caption {
    display: block;
    padding: 6px 10px 8px;
    font-size: var(--text-2xs);
  }
  .side-nav__list {
    grid-auto-flow: row;
    gap: 2px;
  }
  .nav-item {
    justify-content: flex-start;
    gap: 11px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: 9px;
    text-align: left;
  }
  .nav-item .orr-icon {
    font-size: 1.125rem;
  }
  .nav-item:hover {
    background: var(--surface-hover);
  }
  .nav-item[aria-current="page"] {
    background: var(--surface-active);
    box-shadow:
      inset 0 0 0 1px var(--border-default),
      var(--inner-highlight);
  }
  .nav-item::after {
    display: none;
  }
  .side-nav__context {
    display: grid;
    gap: var(--space-2);
    margin-top: auto;
    padding: var(--space-4) 10px 0;
    color: var(--text-muted);
    font: var(--type-caption);
  }
  /* Two notes, not one ragged paragraph: what the pages cover, then where changes happen. */
  .side-nav__context > :first-child {
    color: var(--text-secondary);
  }
  .side-nav__note {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .side-nav__note > .orr-icon {
    margin-top: 0.15em;
    color: var(--info);
  }
  .sidebar > .account {
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }
  .sidebar .account__summary {
    min-height: 40px;
    box-shadow: none;
  }
  .sidebar .account__summary .orr-icon {
    transform: rotate(180deg);
  }
  .sidebar .account[open] > .account__summary .orr-icon {
    transform: none;
  }
  .sidebar .account__menu {
    top: auto;
    right: 0;
    bottom: calc(100% + 8px);
    left: 0;
    width: auto;
  }
  /* The label starts where the page's column starts, however wide the screen (as .main). */
  .topbar {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    height: var(--topbar-h);
    padding: 0 max(var(--gutter), calc((100% - var(--content-max)) / 2));
    background: oklch(0.12 0.03 280 / 0.6);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    border-bottom: 1px solid var(--border-subtle);
  }
  .main {
    padding-top: var(--space-8);
  }
}
`;
