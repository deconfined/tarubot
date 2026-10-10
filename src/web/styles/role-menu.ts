/**
 * The Role menu page's own rules (views/role-menu.ts), phones first: the summary card (the view's
 * one holographic card), the banners under the lead, one card per category with its roles, its
 * tools (disclosures holding the editors) and its state and order controls, the Edit roles rows,
 * and the badges that name a category's or role's state. Shared vocabulary (cards, stats, notes,
 * notices, mentions, disclosures, empty states) lives in components.ts and the form controls in
 * forms.ts; this module only arranges them, plus the design's badge, ported here because this is
 * the first view that renders it.
 *
 * Nothing here adds glass: every surface is an .orr-card, so media.ts's reduced-transparency,
 * forced-colors and print fallbacks already cover it. The badge, drawn with an inset shadow like
 * the status tokens, gets its own forced-colors and print border here.
 */
export const ROLE_MENU_CSS = `/* Role menu */

/*
 * Badge: the design's short mono, uppercase state word (styles/components.css's .orr-badge), for
 * a category's or a role's state. The text carries the meaning; the tone only reinforces it.
 */
.orr-badge {
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
}

.orr-badge--violet {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

.orr-badge--success {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.orr-badge--warning {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

/* A callout that needs acting on: the notice in the warning tone. */
.notice--warning {
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.28);
}

.notice--warning > .orr-icon {
  color: var(--warning);
}

/* The banners: one block of callouts, close under the lead like a page's own notice. */
.menu-banners {
  display: grid;
  gap: var(--space-2);
}

.lead + .menu-banners {
  margin-top: calc(var(--space-4) - var(--space-8));
}

/*
 * The summary card. Phones stack the head, the counts and the foot; from 48rem the counts sit
 * beside the heading, as on Server configuration's health snapshot.
 */
.menu-summary > .orr-card__head {
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-4);
}

.menu-summary__title {
  font-size: 1.25rem;
  letter-spacing: var(--tracking-title);
}

/* Where the problems are: links to the cards' headings, under the summary's title. */
.menu-summary__where {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* A tone tile behind the mark; the heading's words carry the meaning. */
.menu-summary__mark {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  font-size: 22px;
}

.menu-summary__mark--ok {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.menu-summary__mark--wait {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

.menu-summary__mark--warn {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

/* The counts: two by two on phones, so the columns line up; four across from 40rem. */
.menu-summary__counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-6);
  margin: 0;
}

.menu-summary__count > .orr-stat__label {
  white-space: nowrap;
}

/* The foot: why publishing matters, then the page's one primary button. */
.menu-summary__foot {
  justify-content: space-between;
  gap: var(--space-3) var(--space-4);
}

.menu-summary__foot > .note {
  flex: 1 1 16rem;
}

/* A refused Publish N drafts says why on a row of its own, above the button. */
.menu-summary__foot > .form-error {
  flex-basis: 100%;
}

/* Categories: one card each, in the members' order. */
.menu-categories {
  display: grid;
  gap: var(--space-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A category's state and how many someone may pick, above its name. */
.menu-category__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.menu-category__title {
  font: 600 1.125rem / 1.3 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
  /*
   * A link to the heading (the error summary's, the summary card's) keeps the state badges above
   * it in view too, clear of the sticky bars the shell's scroll padding already clears.
   */
  scroll-margin-top: 3.25rem;
}

.menu-category .orr-card__desc {
  overflow-wrap: anywhere;
}

/* The roles, as members will see them, split by hairlines. */
.menu-options {
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu-option {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) 0;
}

.menu-option:first-child {
  padding-top: 0;
}

.menu-option + .menu-option {
  border-top: 1px solid var(--border-subtle);
}

.menu-option__role {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}

.menu-option__desc {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* "Opens:" and its channel chips, with room between lines when the chips wrap. */
.menu-option__opens {
  line-height: 1.75;
}

/* A role's problems: warning lines, the icon level with the first line. */
.menu-problems {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font: var(--type-caption);
}

.menu-problems > li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.menu-problems .orr-icon {
  margin-top: 2px;
  color: var(--warning);
}

/* The editors: disclosures under the roles, one per row. */
.menu-category__tools {
  display: grid;
  margin-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

.menu-category__tools > * {
  padding-block: var(--space-1);
}

.menu-category__tools > * + * {
  border-top: 1px solid var(--border-subtle);
}

.menu-category__tools .disclosure__body {
  padding-bottom: var(--space-4);
}

/* The foot: the state buttons with their help, then the order buttons and the delete. */
.menu-category__foot {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4) var(--card-pad) var(--card-pad);
  border-top: 1px solid var(--border-subtle);
}

.menu-states {
  display: grid;
  gap: var(--space-3);
}

/* A state button and its line of help: stacked on phones, side by side from 40rem. */
.menu-state {
  gap: var(--space-2);
  justify-items: start;
}

.menu-category__end {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

/* Delete category has its own row, so its summary stays put when it opens. */
.menu-category__end > .disclosure {
  flex-basis: 100%;
}

.menu-moves {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* The Edit roles rows: each role's fields under its name, split by hairlines. */
.option-rows {
  display: grid;
  gap: var(--space-4);
}

.option-row {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.option-row + .option-row {
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

.option-row__role {
  float: left;
  width: 100%;
  padding: 0;
  overflow-wrap: anywhere;
}

.option-row__role + * {
  clear: both;
}

.option-row__fields {
  display: grid;
  gap: var(--space-3);
}

/* Add roles: the form, then why the other roles can't be added. */
.menu-add {
  display: grid;
  gap: var(--space-3);
}

.menu-refusals {
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu-refusals > li {
  display: grid;
  gap: 2px;
  padding: var(--space-2) 0;
}

.menu-refusals > li + li {
  border-top: 1px solid var(--border-subtle);
}

.menu-refusals__role {
  overflow-wrap: anywhere;
}

/* A refused form's message about the form as a whole, at its top. */
.form-error {
  margin: 0;
}

/* The unreadable menu's card: the warning, then Reset role menu behind its consequence. */
.menu-reset {
  display: grid;
  gap: var(--space-3);
}

@media (min-width: 40rem) {
  .menu-summary__counts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .menu-state {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: var(--space-4);
  }
}

@media (min-width: 48rem) {
  .menu-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .menu-summary > .orr-card__head {
    padding-bottom: var(--card-pad);
  }
  .menu-summary > .orr-card__body {
    padding: var(--card-pad) var(--card-pad) var(--card-pad) 0;
  }
  .menu-summary__counts {
    grid-template-columns: repeat(4, auto);
    gap: var(--space-8);
  }
  .menu-summary__foot {
    grid-column: 1 / -1;
  }
  /* A row's description takes the room; its place and state stay narrow. */
  .option-row__fields {
    grid-template-columns: minmax(0, 1fr) 7rem minmax(0, 15rem);
    align-items: start;
  }
}

/*
 * A category's name, description and limit stay at a readable width on wide screens. Not below
 * 64rem, where a form's sticky button row (forms.ts) spans the card and the form must too.
 */
@media (min-width: 64rem) {
  .menu-form {
    max-width: 40rem;
  }
}

@media (forced-colors: active) {
  .orr-badge {
    border: 1px solid CanvasText;
  }
}

@media print {
  .orr-badge {
    border: 1px solid #888;
  }
  /* The editors and buttons are for the screen; paper keeps the menu itself. */
  .menu-category__tools,
  .menu-category__foot,
  .menu-summary__foot {
    display: none;
  }
}
`;
