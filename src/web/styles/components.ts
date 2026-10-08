/**
 * Components for the dashboard: the parts of the Orrery design system's styles/components.css a
 * view-only TaruBot uses (icon, button, badge, tag, avatar, card, stat, tabs, table, kbd), then the
 * vocabulary TaruBot's pages share on top of them: status tokens, mentions, notes and notices,
 * section headings, fact lists, checklists, disclosures and empty states.
 *
 * Left out on purpose: the form controls, switches, sliders, dialog, tooltip and toast (v3 pages
 * have no controls; disclosures are `<details>`), the icon-only button (every control has a visible
 * label), the danger button and the Discord message preview.
 *
 * Fixes to the export, each marked where it applies: link components don't inherit the link
 * hover (base.ts lowers its specificity), tabs also read aria-current, a table styles only its
 * column headers as labels and keeps row headers and captions readable, glass never nests inside
 * glass, and focus keeps base.ts's outline with the design's glow beside it.
 *
 * TaruBot's test-pinned semantic classes (.check-*, .marker-*, .mention, .featured, .ref) stay on
 * the markup next to the design's classes (D12); the status tokens below are styled through them,
 * so a view needs no mapping from a token to a badge tone.
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

.orr-icon--glow {
  filter: drop-shadow(0 0 6px currentColor);
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
  font-size: 16px;
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
  font-size: 14px;
}

.orr-btn--lg {
  min-height: var(--control-lg);
  padding: 0 var(--space-5);
  border-radius: var(--radius-lg);
  font-size: 15px;
}

.orr-btn--lg .orr-icon {
  font-size: 18px;
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
 * nested in a card, turn solid. This holds even when a view forgets the solid variant.
 */
:where(.orr-card, .orr-glass, .orr-glass-strong, .sidebar, .topbar) .orr-btn--secondary {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background: var(--surface-2);
}

/*
 * Badge: a short mono, uppercase status word. TaruBot's status tokens are badges too: a check
 * ([OK], [WARN], ...) and a job marker keep their exact text and pinned classes, which pick the
 * tone. Text always carries the meaning; the tone only reinforces it.
 */
.orr-badge,
.check,
.marker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font: 500 10.5px/1 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-default);
  font-variant-emoji: text;
}

.orr-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

/* Accent: work in progress and checks waiting on something. */
.orr-badge--accent,
.check-wait,
.marker-running,
.marker-saved {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

/* Violet: work that will retry or continue later. */
.orr-badge--violet,
.marker-waiting {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

.orr-badge--success,
.check-ok,
.marker-done {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.orr-badge--warning,
.check-warn,
.marker-blocked {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

.orr-badge--danger,
.check-fail,
.marker-failed {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.32);
}

/* Neutral is the base look: .check-off and the queued, paused, skipped and unchanged markers. */

.orr-badge--holo {
  color: var(--text-primary);
  background: var(--holo-fill);
  box-shadow: none;
}

.orr-badge--holo::before {
  --holo-edge-opacity: 0.9;
}

/* Tag: a role or channel chip. */
.orr-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  font: 500 12.5px/1.2 var(--font-sans);
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  transition:
    box-shadow var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.orr-tag__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--night-300);
}

.orr-tag .orr-icon {
  font-size: 13px;
  color: var(--text-muted);
}

a.orr-tag:hover {
  color: var(--text-primary);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

/*
 * Avatar: initials only (the CSP admits no Discord images), a 28% squircle for a server. The size
 * and hue are classes, since the design's per-avatar custom properties would need style
 * attributes; layout.ts picks the hue from the server ID.
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

.orr-avatar--sm {
  --size: 28px;
}

.orr-avatar--md {
  --size: 34px;
}

.orr-avatar--lg {
  --size: 52px;
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
 * page's one featured card. Its head holds an eyebrow (.orr-label), a title and a description.
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

.orr-card--solid,
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

/* A whole card that is a link: it lifts and shows its holographic edge on hover. */
a.orr-card {
  color: inherit;
  text-decoration: none;
}

.orr-card--interactive.orr-holo-edge::before {
  --holo-edge-opacity: 0;
}

.orr-card--interactive:hover,
.orr-card--interactive:focus-visible {
  transform: translateY(-2px);
  box-shadow:
    inset 0 0 0 1px transparent,
    var(--glass-edge),
    var(--shadow-2),
    var(--glow-holo);
}

.orr-card--interactive:hover.orr-holo-edge::before,
.orr-card--interactive:focus-visible.orr-holo-edge::before {
  --holo-edge-opacity: 0.9;
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
  font: 600 15px/1.3 var(--font-sans);
  letter-spacing: var(--tracking-ui);
  color: var(--text-primary);
}

.orr-card__desc {
  font: var(--type-caption);
  color: var(--text-muted);
}

.orr-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
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

.orr-card--pad-lg {
  --card-pad: var(--space-6);
}

.orr-card--pad-none > .orr-card__body {
  padding: 0;
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
  font-size: 14px;
  color: var(--text-muted);
}

.orr-stat__value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font: 400 30px/1 var(--font-mono);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.orr-stat__unit {
  font: var(--type-label);
  letter-spacing: 0.08em;
  color: var(--text-muted);
  text-transform: uppercase;
}

.orr-stat__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font: var(--type-caption);
  color: var(--text-muted);
}

/*
 * Tabs: links to sibling views, never in-place switching (no script). The current one carries
 * aria-current="page", read here as well as the design's aria-selected.
 */
.orr-tabs {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  box-shadow: inset 0 -1px 0 var(--border-subtle);
}

.orr-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: var(--type-ui);
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out);
}

.orr-tab .orr-icon {
  font-size: 16px;
}

.orr-tab:hover {
  color: var(--text-primary);
}

.orr-tab::after {
  content: "";
  position: absolute;
  right: 10px;
  bottom: 0;
  left: 10px;
  height: 2px;
  border-radius: 2px;
  background: var(--cyan-400);
  box-shadow:
    0 0 10px var(--cyan-400),
    0 0 2px var(--cyan-400);
  opacity: 0;
  transform: scaleX(0.4);
  transition:
    opacity var(--dur-base),
    transform var(--dur-slow) var(--ease-out);
}

.orr-tab[aria-current="page"],
.orr-tab[aria-selected="true"] {
  color: var(--text-primary);
}

.orr-tab[aria-current="page"]::after,
.orr-tab[aria-selected="true"]::after {
  opacity: 1;
  transform: none;
}

.orr-tab__count {
  padding: 3px 6px;
  border-radius: var(--radius-pill);
  font: 500 10.5px/1 var(--font-mono);
  background: var(--surface-2);
  color: var(--text-muted);
}

.orr-tab[aria-current="page"] .orr-tab__count,
.orr-tab[aria-selected="true"] .orr-tab__count {
  background: var(--info-bg);
  color: var(--cyan-400);
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

.orr-table .orr-table__mono {
  font: var(--type-code);
  color: var(--text-muted);
  white-space: nowrap;
}

.orr-kbd {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 5px;
  font: 500 11px/1 var(--font-mono);
  color: var(--text-muted);
  background: var(--surface-2);
  box-shadow:
    inset 0 0 0 1px var(--border-default),
    inset 0 -1px 0 var(--border-default);
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

main code {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  background: var(--surface-2);
}

/* A section of a page: its heading row (serif title, muted count or description), then content. */
.section-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2) var(--space-6);
  margin-bottom: var(--space-4);
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

/* A checklist: one row per check, its status token in a fixed column so the texts line up. */
.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-row {
  display: grid;
  grid-template-columns: 4.75rem minmax(0, 1fr);
  align-items: start;
  gap: var(--space-3);
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

/* An empty table or list: one short statement, centered, no illustration. */
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
