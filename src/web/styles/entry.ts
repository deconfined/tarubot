/**
 * The entry pages (layout.ts): the sign-in, the server list, "no access" and errors, on the
 * starfield with the orbit rings, after the Orrery website kit's login and server picker. The
 * sign-in pairs the welcome copy with the login card; the server list is a grid of tiles; the
 * other pages are one centered glass card under their heading.
 */
export const ENTRY_CSS = `/* Entry pages: after the Orrery website kit */
.entry-page {
  display: flex;
  flex-direction: column;
}

/*
 * The starfield and the rings, fixed to the viewport behind the page (layout.ts's backdrop): they
 * take no space, so a phone's layout never shifts for them, and they don't scroll with the page.
 */
.orr-starfield.entry-backdrop {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.entry-backdrop > .entry-orbit {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(760px, 150vmin);
  opacity: 0.45;
  transform: translate(-50%, -50%);
}

/* The bar over every entry page but the sign-in: the wordmark home, the account menu. */
.entry-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 14px var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

/*
 * The page: one centered column, vertically centered when it is shorter than the screen. The
 * heading and lede center over it; a card or the tile grid follows.
 */
.entry {
  display: grid;
  flex: 1 0 auto;
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  justify-items: center;
  gap: var(--space-6);
  width: 100%;
  max-width: calc(1080px + 2 * var(--space-10));
  margin: 0 auto;
  padding: var(--space-10) var(--space-4) var(--space-16);
}

.entry > .page-header {
  justify-items: center;
  text-align: center;
}

.entry > .lead {
  margin-top: calc(var(--space-2) - var(--space-6));
  text-align: center;
}

/* "No access", an error, or no servers: one card of short paragraphs and a way home. */
.entry-panel {
  display: grid;
  gap: var(--space-3);
  width: min(560px, 100%);
  padding: var(--space-6);
}

.entry-panel__lead {
  color: var(--text-primary);
  font: var(--type-body-lg);
}

.entry-panel > p:not([class]) {
  color: var(--text-secondary);
}

.entry-panel__actions {
  margin-top: var(--space-2);
}

.entry-page .site-footer {
  text-align: center;
}

/*
 * The server list: a tile per server, its initials and name, then its page links. The columns
 * keep a tile's width and center as a group, so one or two servers sit under the heading.
 */
.servers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 340px));
  justify-content: center;
  gap: 14px;
  justify-self: stretch;
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.server-tile {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  padding: var(--space-5);
}

.server-tile__head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.server-tile .orr-avatar {
  --size: 52px;
}

.server-tile__titles {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.server-tile__name {
  color: var(--text-primary);
  font: 600 16px/1.3 var(--font-sans);
  letter-spacing: var(--tracking-ui);
}

.server-tile__links {
  display: grid;
  margin: 0;
  padding: 6px 0 0;
  border-top: 1px solid var(--border-subtle);
  list-style: none;
}

.server-tile__links > li + li {
  border-top: 1px solid var(--border-subtle);
}

.server-tile__link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: 2px -10px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font: var(--type-ui);
  text-decoration: none;
  transition: background-color var(--dur-fast) var(--ease-out);
}

.server-tile__link .orr-icon {
  font-size: 16px;
  color: var(--cyan-400);
}

.server-tile__label {
  flex: 1;
  min-width: 0;
}

.server-tile__link > .orr-icon:last-child {
  color: var(--text-muted);
  transition:
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.server-tile__link:hover {
  background: var(--surface-hover);
}

.server-tile__link:hover > .orr-icon:last-child {
  color: var(--text-primary);
  transform: translateX(2px);
}

/*
 * The sign-in (titled with the brand): the large wordmark heading, the welcome copy and the
 * login card. On a phone the card comes right after the heading, ahead of the copy; the copy holds
 * no control, so the keyboard order is unchanged.
 */
.entry--welcome {
  grid-template-columns: minmax(0, 36rem);
  grid-template-areas:
    "header"
    "sign-in"
    "copy";
  justify-content: center;
  justify-items: stretch;
  gap: var(--space-8);
  max-width: calc(1160px + 2 * var(--space-10));
}

.entry--welcome > .page-header {
  grid-area: header;
  justify-items: start;
  text-align: left;
}

.entry--welcome .page-header__eyebrow {
  color: var(--cyan-400);
}

.entry--welcome .page-header__title {
  font-size: clamp(56px, 13vw, 88px);
  line-height: 0.98;
  letter-spacing: -0.02em;
}

.welcome-copy {
  grid-area: copy;
  display: grid;
  gap: var(--space-5);
  min-width: 0;
  max-width: 36rem;
}

.welcome-copy__title {
  font: 400 clamp(28px, 4vw, 36px) / 1.1 var(--font-display);
}

.welcome-copy__lead {
  color: var(--text-secondary);
  font: 400 var(--text-xl) / 1.6 var(--font-sans);
}

.features {
  display: grid;
  gap: var(--space-3);
  margin: var(--space-2) 0 0;
}

.feature {
  padding: var(--space-4) 18px;
  border-radius: var(--radius-lg);
  background: var(--glass-fill);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--glass-edge);
}

.feature dt {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-primary);
  font: var(--type-subtitle);
  letter-spacing: var(--tracking-ui);
}

.feature dd {
  margin: 6px 0 0 calc(36px + var(--space-3));
  color: var(--text-muted);
}

/* A feature's icon tile: one of the places the design lets an icon glow. */
.feature__icon {
  display: inline-grid;
  flex-shrink: 0;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.25);
  font-size: 18px;
}

.feature__icon--violet {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.25);
}

.feature__icon .orr-icon {
  filter: drop-shadow(0 0 6px currentColor);
}

/* The login card: the page's one holographic card and its one primary button. */
.sign-in {
  grid-area: sign-in;
  display: grid;
  gap: var(--space-4);
  padding: var(--space-6);
}

.sign-in__title {
  font: 400 clamp(28px, 4vw, 36px) / 1.1 var(--font-display);
}

.sign-in__text {
  color: var(--text-muted);
}

.sign-in .orr-hairline {
  margin-block: var(--space-1);
}

.sign-in .disclosure {
  color: var(--text-muted);
  font: var(--type-caption);
}

.sign-in .disclosure > p {
  margin-top: var(--space-2);
}

@media (min-width: 40rem) {
  .entry-bar,
  .entry {
    padding-inline: var(--gutter);
  }
}

@media (min-width: 64rem) {
  .entry-bar {
    padding: 16px 40px;
  }
  .entry {
    padding: var(--space-16) var(--space-10) var(--space-24);
  }
  .entry--welcome {
    grid-template-columns: minmax(0, 1fr) 420px;
    grid-template-areas:
      "header sign-in"
      "copy sign-in";
    align-items: start;
    column-gap: 72px;
  }
  .entry--welcome > .sign-in {
    align-self: center;
  }
}
`;
