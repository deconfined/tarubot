/**
 * Components for the dashboard: the parts of the Orrery design system's styles/components.css that
 * TaruBot's pages render (icon, button, badge, avatar, card, stat and table), then the vocabulary
 * the pages share on top of them: status tokens, mentions, notes and notices, section headings,
 * fact lists, checklists, disclosures and empty states. A part no page renders is left out until
 * one does, so every rule here styles markup that exists.
 *
 * Left out on purpose: the form controls, switches, sliders, dialog, tooltip and toast (v3 pages
 * have no controls; disclosures are `<details>`), the icon-only button (every control has a visible
 * label), the danger button and the Discord message preview. Not yet rendered, so not ported:
 * tags, tabs, keyboard keys, the badge's own classes and dot, the interactive, solid and padding
 * card variants, the card actions, and the stat's unit and meta lines.
 *
 * Fixes to the export, each marked where it applies: link components don't inherit the link
 * hover (base.ts lowers its specificity), a table styles only its column headers as labels and
 * keeps row headers and captions readable, glass never nests inside glass, and focus keeps
 * base.ts's outline with the design's glow beside it.
 *
 * TaruBot's test-pinned semantic classes (.check-*, .marker-*, .mention, .featured, .ref) stay on
 * the markup next to the design's classes; the status tokens are styled as badges through them, so
 * a view needs no mapping from a token to a badge tone.
 */
export const COMPONENTS_CSS = `/* Components: from the Orrery design system's styles/components.css */

/* Icon: the class sits on the inline svg itself (icons.ts), sized by the text around it. */
.orr-icon {
  display: inline-block;
  flex-shrink: 0;
  width: 1em;
  height: 1em;
  vertical-align: -0.125em;
  stroke-width: var(--icon-stroke, 1.85);
}

/* Button: primary (holographic, one per page), secondary (glass) and ghost. */
.orr-btn {
  position: relative;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--control-md);
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius-md);
  font: var(--type-ui);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  text-decoration: none;
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    background-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out);
}

.orr-btn .orr-icon {
  font-size: 1rem;
}

.orr-btn:focus-visible {
  box-shadow: var(--glow-cyan-sm);
}

.orr-btn:active:not(:disabled) {
  transform: scale(0.975);
}

.orr-btn:disabled {
  cursor: not-allowed;
  opacity: 0.42;
  box-shadow: none;
  transform: none;
}

.orr-btn--sm {
  min-height: var(--control-sm);
  padding: 0 var(--space-3);
  gap: var(--space-1-5);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.orr-btn--sm .orr-icon {
  font-size: 0.875rem;
}

.orr-btn--lg {
  min-height: var(--control-lg);
  padding: 0 var(--space-5);
  border-radius: var(--radius-lg);
  font-size: 0.9375rem;
}

.orr-btn--lg .orr-icon {
  font-size: 1.125rem;
}

.orr-btn--block {
  width: 100%;
}

/* Dark text on the holographic fill, never white (the design's rule; white would be 1.6:1). */
.orr-btn--primary {
  color: var(--text-on-accent);
  background: var(--holo-linear);
  background-size: 200% 100%;
  animation: orr-holo-drift var(--dur-holo) linear infinite;
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.45),
    inset 0 -1px 0 oklch(0.3 0.08 280 / 0.25),
    var(--glow-holo);
}

/* The hover sheen sweeps once, behind the label; leaving resets it at once. */
.orr-btn--primary::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--holo-sheen);
  background-size: 250% 100%;
  background-position: 130% 0;
  opacity: 0;
  transition:
    opacity var(--dur-base) var(--ease-out),
    background-position 0s;
}

.orr-btn--primary:hover:not(:disabled)::after {
  opacity: 1;
  background-position: -30% 0;
  transition:
    opacity var(--dur-base) var(--ease-out),
    background-position 900ms var(--ease-out);
}

.orr-btn--primary:hover:not(:disabled),
.orr-btn--primary:focus-visible {
  color: var(--text-on-accent);
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.5),
    inset 0 -1px 0 oklch(0.3 0.08 280 / 0.25),
    var(--glow-cyan-lg);
}

.orr-btn--primary:disabled {
  animation: none;
}

.orr-btn--secondary {
  color: var(--text-primary);
  background: var(--glass-fill);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--inner-highlight);
}

.orr-btn--secondary:hover:not(:disabled),
.orr-btn--secondary:focus-visible {
  color: var(--accent-strong);
  box-shadow:
    inset 0 0 0 1px var(--border-accent),
    var(--inner-highlight),
    var(--glow-cyan-sm);
}

.orr-btn--ghost {
  color: var(--text-secondary);
  background: transparent;
}

.orr-btn--ghost:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--surface-hover);
}

/*
 * Never glass inside glass (the design's rule): a secondary button on a glass surface, and a card
 * nested in a card, turn solid by where they sit, with no variant class for a view to forget.
 */
:where(.orr-card, .sidebar, .topbar) .orr-btn--secondary {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background: var(--surface-2);
}

/*
 * Badge: a short mono, uppercase status word. TaruBot's status tokens are the design's badges: a
 * check ([OK], [WARN], ...) and a job marker keep their exact text and pinned classes, which pick
 * the tone. Text always carries the meaning; the tone only reinforces it.
 */
.check,
.marker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font: 500 0.65625rem / 1 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-default);
  font-variant-emoji: text;
}

/* Accent: work in progress and checks waiting on something. */
.check-wait,
.marker-running,
.marker-saved {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

/* Violet: work that will retry or continue later. */
.marker-waiting {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

.check-ok,
.marker-done {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.check-warn,
.marker-blocked {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

.check-fail,
.marker-failed {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.32);
}

/* Neutral is the base look: .check-off and the queued, paused, skipped and unchanged markers. */

/*
 * Avatar: initials only (the CSP admits no Discord images), a 28% squircle for a server. The hue
 * is a class, since the design's per-avatar custom properties would need style attributes;
 * layout.ts picks it from the server ID, and a frame sets the size through --size.
 */
.orr-avatar {
  --size: 40px;
  position: relative;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  font: 600 calc(var(--size) * 0.38) / 1 var(--font-sans);
  letter-spacing: 0;
  color: var(--text-primary);
  background: linear-gradient(145deg, var(--night-600), var(--violet-900));
  box-shadow: inset 0 0 0 1px oklch(1 0 0 / 0.08);
}

.orr-avatar--square {
  border-radius: 28%;
}

.orr-avatar--hue-0 {
  background: linear-gradient(145deg, oklch(0.46 0.12 210), oklch(0.27 0.08 250));
}

.orr-avatar--hue-1 {
  background: linear-gradient(145deg, oklch(0.46 0.12 250), oklch(0.27 0.08 290));
}

.orr-avatar--hue-2 {
  background: linear-gradient(145deg, oklch(0.46 0.12 290), oklch(0.27 0.08 330));
}

.orr-avatar--hue-3 {
  background: linear-gradient(145deg, oklch(0.46 0.12 330), oklch(0.27 0.08 10));
}

.orr-avatar--hue-4 {
  background: linear-gradient(145deg, oklch(0.46 0.12 20), oklch(0.27 0.08 60));
}

.orr-avatar--hue-5 {
  background: linear-gradient(145deg, oklch(0.46 0.12 70), oklch(0.27 0.08 110));
}

.orr-avatar--hue-6 {
  background: linear-gradient(145deg, oklch(0.46 0.12 150), oklch(0.27 0.08 190));
}

.orr-avatar--hue-7 {
  background: linear-gradient(145deg, oklch(0.46 0.12 180), oklch(0.27 0.08 220));
}

.orr-avatar .orr-icon {
  font-size: 0.9em;
}

/*
 * Card: glass by default, solid inside another card, holographic (with .orr-holo-edge) for the
 * page's one featured card. Its head holds an optional eyebrow (.orr-label), a title and a
 * description.
 */
.orr-card {
  --card-pad: var(--space-5);
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--radius-lg);
  background: var(--glass-fill);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--glass-edge),
    var(--shadow-1);
  transition:
    transform var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}

:where(.orr-card) .orr-card {
  background: var(--surface-1);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow:
    inset 0 0 0 1px var(--border-subtle),
    var(--inner-highlight);
}

.orr-card--holo {
  box-shadow:
    var(--glass-edge),
    var(--shadow-2),
    var(--glow-holo);
}

.orr-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--card-pad) var(--card-pad) 0;
}

.orr-card__titles {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.orr-card__title {
  font: 600 0.9375rem / 1.3 var(--font-sans);
  letter-spacing: var(--tracking-ui);
  color: var(--text-primary);
}

.orr-card__desc {
  font: var(--type-caption);
  color: var(--text-muted);
}

.orr-card__body {
  flex: 1;
  min-width: 0;
  padding: var(--card-pad);
}

.orr-card__head + .orr-card__body {
  padding-top: var(--space-4);
}

.orr-card__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--card-pad);
  border-top: 1px solid var(--border-subtle);
}

.orr-card--pad-sm {
  --card-pad: var(--space-4);
}

/* Stat: a label over a mono readout; as a dl, dt is the label and dd the value. */
.orr-stat {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.orr-stat__label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.orr-stat__label .orr-icon {
  font-size: 0.875rem;
  color: var(--text-muted);
}

.orr-stat__value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font: 400 1.875rem / 1 var(--font-mono);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/*
 * Table, in a scroll region (.table-scroll: role="region", tabindex="0" and a label) so a wide
 * table scrolls by itself on a phone instead of the page. Only column headers (thead th) are mono
 * labels; a row header (tbody th scope="row") reads as the row's title. Rows align to the top,
 * because TaruBot's cells stack several lines.
 */
.table-scroll {
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--radius-lg);
}

.orr-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font: var(--type-body);
  text-align: left;
}

.orr-table caption {
  padding: 0 16px 10px;
  caption-side: top;
  text-align: left;
  font: var(--type-caption);
  color: var(--text-muted);
}

.orr-table thead th {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  font: var(--type-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--text-muted);
}

.orr-table tbody th,
.orr-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}

.orr-table tbody th {
  font: 600 var(--text-md) / 1.45 var(--font-sans);
  color: var(--text-primary);
}

.orr-table td {
  color: var(--text-secondary);
}

.orr-table tbody tr:last-child > * {
  border-bottom: 0;
}

.orr-table tbody tr > * {
  transition: background-color var(--dur-fast) var(--ease-out);
}

.orr-table tbody tr:hover > * {
  background: var(--surface-hover);
}

/* TaruBot's shared page vocabulary */

/* The page's lede, directly under the page header; and quieter supporting text. */
.lead {
  max-width: 62ch;
  color: var(--text-secondary);
  font: var(--type-body-lg);
}

.note,
.ref {
  color: var(--text-muted);
  font: var(--type-caption);
}

/* A static callout, such as "Read-only. Update settings with /config in Discord." */
.notice {
  padding: 10px 14px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.22);
  font: var(--type-caption);
}

/* A page's notice right after its lead joins the description: 16px under it, not main's 32px. */
.lead + .notice {
  margin-top: calc(var(--space-4) - var(--space-8));
}

/* A chip that wraps onto another line gets its padding and corners on every line. */
main code {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  background: var(--surface-2);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

/*
 * A section of a page: its heading row, then content. The serif title shares its row only with a
 * short count, kept at the end like the design's "All logs"; a description sentence wraps under
 * the title, where it reads as the title's own.
 */
.section-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-1) var(--space-6);
  margin-bottom: var(--space-4);
}

.section-heading > .section-description {
  grid-column: 1 / -1;
}

.section-heading > .section-count {
  grid-row: 1;
  grid-column: 2;
}

.section-description {
  color: var(--text-muted);
  font: var(--type-caption);
}

/* A role or channel mention (mentions.ts), the design's Discord mention chip. */
.mention {
  padding: 0 4px;
  border-radius: var(--radius-xs);
  color: var(--cyan-200);
  background: oklch(0.8 0.13 210 / 0.16);
  font-weight: 500;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

/*
 * Facts: a dl of label and value rows (the design's setting rows), dt and dd as direct siblings.
 * Values may be long untrusted text, so the value column shrinks and wraps.
 */
.facts {
  display: grid;
  grid-template-columns: minmax(6.5rem, 36%) minmax(0, 1fr);
  margin: 0;
}

.facts > dt,
.facts > dd {
  margin: 0;
  padding: 10px 0;
  border-top: 1px solid var(--border-subtle);
}

.facts > dt:first-of-type,
.facts > dt:first-of-type + dd {
  border-top: 0;
}

.facts > dt {
  padding-right: var(--space-3);
  color: var(--text-muted);
  font: var(--type-caption);
}

.facts > dd {
  color: var(--text-primary);
}

/*
 * A checklist: one row per check, its status token in a fixed column so the texts line up. The
 * column fits the widest token ([WARN], [FAIL], [WAIT]) with the 1px border forced colors and
 * print give it, and no more, so a phone keeps most of the row for the sentence.
 */
.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-row {
  display: grid;
  grid-template-columns: 3.875rem minmax(0, 1fr);
  align-items: start;
  column-gap: 10px;
  padding: 10px 0;
}

.check-row + .check-row {
  border-top: 1px solid var(--border-subtle);
}

.check-row > .check {
  justify-self: start;
  margin-top: 1px;
}

.check-copy {
  color: var(--text-secondary);
}

/* A disclosure in a page: details and diagnostics open in place, without script. */
main details > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  min-height: 2.25rem;
  color: var(--text-link);
  font: var(--type-ui-sm);
  cursor: pointer;
  list-style: none;
}

main details > summary::-webkit-details-marker {
  display: none;
}

main details > summary::before {
  content: "";
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin-inline: 2px 4px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--dur-fast) var(--ease-out);
}

main details[open] > summary::before {
  transform: rotate(45deg);
}

main details > summary:hover {
  color: var(--text-link-hover);
}

/* An empty table or list: a statement, then how to start work; centered, no illustration. */
.empty-state {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: 28px var(--space-5);
  border-radius: var(--radius-lg);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  color: var(--text-muted);
  text-align: center;
}
`;
