/**
 * The Role menu page's own rules (views/role-menu.ts), phones first and dense: the intro (one
 * sentence, a small line, the address to share), the banners under it, the summary card (the
 * view's one holographic card), then the categories as compact cards, one column on phones and
 * tablets and two from 72rem, and Add a category as one row on a wide screen.
 *
 * A category's card reads in three bands: a head of one line (the name, the pick rule and how many
 * roles, then the state badges at the line's end) with the description under it; the roles as
 * mention chips that wrap or, when any role has a description, a two-column list: the names in one
 * column, each description and its "Opens:" line beside its name; and a foot with a line on what
 * the state means and what each state button does, then one toolbar. The toolbar holds every
 * action as a compact button: the editors (disclosures), the state buttons and the moves (each
 * group wrapping as one unit, never split across rows), and Delete category (a disclosure too,
 * whose panel states the consequence before its danger button). An open editor takes a row of its
 * own in place, its panel under its summary and the rest of the toolbar after it, so what is drawn
 * follows the markup's reading and focus order: a summary, its panel's controls, then the next
 * button (WCAG 1.3.2, 2.4.3).
 *
 * Forms inside a card or the Add a category card are laid out by the card's own width (container
 * queries), since a card is narrower in two columns than in one: fields go side by side where the
 * card has room, each hint and error under its control so the controls line up.
 *
 * Shared vocabulary (cards, stats, notes, notices, mentions, disclosures, empty states) lives in
 * components.ts and the form controls in forms.ts; this module only arranges them, plus the
 * design's badge, ported here because this was the first view that renders it (My roles uses it
 * too). Nothing here adds glass: every surface is an .orr-card, so media.ts's reduced-transparency,
 * forced-colors and print fallbacks already cover it. What is drawn with an inset shadow here (the
 * badge, the toolbar's summaries, an open editor's panel, a role that needs attention) gets its
 * own forced-colors border, and every control keeps base.ts's focus outline.
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

/*
 * The intro: the opening sentence, a small line on the one change TaruBot makes unasked, and My
 * roles' address to share, joined to the page header as its description (as shell.ts's
 * .page-header + .lead).
 */
.menu-intro {
  display: grid;
  gap: var(--space-1-5);
  min-width: 0;
}

.page-header + .menu-intro {
  margin-top: calc(var(--space-2) - var(--section-gap));
}

.menu-intro__note {
  max-width: 80ch;
  color: var(--text-muted);
  font: var(--type-caption);
}

/* My roles' address: a label, then the chip, which one click selects whole, ready to copy. */
.menu-share {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.menu-share > code {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: all;
}

/* The banners, or the setup callout: close under the intro, like a page's notice under its lead. */
.menu-banners {
  display: grid;
  gap: var(--space-2);
}

.menu-intro + .menu-banners,
.menu-intro + .notice {
  margin-top: calc(var(--space-3) - var(--section-gap));
}

/*
 * The summary card, compact. Phones stack the head, the counts and the foot; from 48rem the counts
 * sit beside the heading, as on Server configuration's health snapshot.
 */
.menu-summary > .orr-card__head {
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-3);
}

.menu-summary .orr-card__titles {
  gap: var(--space-1);
}

.menu-summary__title {
  font-size: 1.125rem;
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
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  font-size: 18px;
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
  gap: var(--space-3) var(--space-6);
  margin: 0;
}

.menu-summary .menu-summary__count {
  gap: var(--space-1);
}

/* A label may wrap on a phone (at 200% text "Not offered" is wider than its column). */
.menu-summary__count > .orr-stat__label {
  overflow-wrap: anywhere;
}

.menu-summary__count > .orr-stat__value {
  font-size: 1.5rem;
}

/*
 * The foot: why publishing matters, at a readable measure, then the page's one primary button at
 * the row's end.
 */
.menu-summary__foot {
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.menu-summary__foot > .note {
  flex: 1 1 16rem;
  max-width: 80ch;
}

/* A refused Publish N drafts says why on a row of its own, above the button. */
.menu-summary__foot > .form-error {
  flex-basis: 100%;
}

/*
 * Categories: one card each, in the members' order, one column until 72rem and two from there.
 * Cards in a row share its height while every editor is closed, so their toolbars line up at the
 * foot; once one opens, each card keeps its own height, so an open editor never stretches its
 * neighbour into an empty card.
 */
.menu-categories {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A card's forms follow its own width, which two columns halve (container queries below). */
.menu-category,
.menu-create {
  container-type: inline-size;
}

/*
 * The head: the name, the pick rule and how many roles, then the badges, on one line that wraps,
 * so every card's name starts at its left edge; the description goes under them. The markup puts
 * the badges first, hidden from assistive technology (the heading says the state in words), so
 * only their place on screen moves: nothing in the head takes focus.
 */
.menu-category__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5) var(--space-2);
  padding: var(--card-pad) var(--card-pad) 0;
}

/* The success notice (order 0, first), and the description, each take a line of their own. */
.menu-category__head > .notice,
.menu-category__desc {
  flex-basis: 100%;
}

.menu-category__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  order: 3;
}

.menu-category__title {
  order: 1;
  min-width: 0;
  font: 600 1.0625rem / 1.3 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
  /*
   * A link to the heading (the error summary's, the summary card's) keeps the card's top edge in
   * view too, clear of the sticky bars the shell's scroll padding already clears.
   */
  scroll-margin-top: 1.5rem;
}

/* The pick rule and the count, set apart by a small dot drawn between them (no text). */
.menu-category__facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  order: 2;
}

.menu-category__facts > * + *::before {
  content: "";
  display: inline-block;
  width: 3px;
  height: 3px;
  margin-inline-end: var(--space-2);
  border-radius: 50%;
  background: currentColor;
  vertical-align: middle;
}

.menu-category__desc {
  order: 4;
  color: var(--text-muted);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/* The roles take what height the row gives the card, so the foot stays at the card's bottom. */
.menu-category__body {
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--card-pad) var(--card-pad);
}

/*
 * The roles, as members will see them: mention chips that wrap side by side, a role with a
 * description taking at least 13rem (its description, then "Opens:", under its chip). With any
 * description, a card with room lists its roles in two columns instead (container query below):
 * the names in the first, each description and "Opens:" beside its name. A phone keeps the
 * wrapping chips, so roles without one still share a line.
 */
.menu-options {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu-option {
  display: grid;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
}

.menu-option:has(> .menu-option__desc) {
  flex: 1 1 13rem;
}

/* Without descriptions, "Opens:" follows its chip on the chip's line while it fits. */
.menu-options:not(.menu-options--described) > .menu-option {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--space-2);
}

.menu-options:not(.menu-options--described) > .menu-option > .menu-problems {
  flex-basis: 100%;
}

.menu-option__role {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  overflow-wrap: anywhere;
}

.menu-option__desc {
  color: var(--text-muted);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/*
 * "Opens:" and its channel chips, after the role's description, small and muted. A chip moves to
 * the next line whole rather than split at a hyphen ("#valheim-" / "voice"); only a name wider
 * than the line wraps inside its chip.
 */
.menu-option__opens {
  color: var(--text-muted);
  font: var(--type-caption);
}

.menu-option__opens > .mention {
  display: inline-block;
  max-width: 100%;
}

/*
 * A role with a problem takes a row of its own, tinted like a warning callout, so drift stands out
 * among the chips; the warning lines say what is wrong, across the row's full width.
 */
.menu-options > .menu-option--attention {
  flex-basis: 100%;
  grid-column: 1 / -1;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.28);
}

/* A role's problems: warning lines, the icon level with the first line. */
.menu-problems {
  display: grid;
  gap: var(--space-1);
  margin: 0;
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

/* The foot: what the state means and what each state button does, then the toolbar. */
.menu-category__foot {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--card-pad) var(--card-pad);
  border-top: 1px solid var(--border-subtle);
}

.menu-category__state {
  max-width: 80ch;
  color: var(--text-muted);
  font: var(--type-caption);
}

/*
 * The toolbar: one row that wraps. A .menu-tool wrapper only keeps the markup readable, so each
 * editor's disclosure is one of the row's items; the state buttons and the moves are each one
 * item, a group that wraps as a unit, so a pair is never split across rows (Move up ending one
 * row, Move down starting the next).
 */
.menu-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.menu-tool {
  display: contents;
}

.menu-states,
.menu-moves {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/*
 * The row's buttons and summaries, compact: 32px tall for a mouse, 40px where the pointer is a
 * finger. The forms' own buttons, in the panels, keep their size.
 */
.menu-states .orr-btn,
.menu-moves .orr-btn,
.menu-tool > details > summary {
  min-height: 2rem;
  padding: var(--space-1) 10px;
  border-radius: var(--radius-sm);
  font: var(--type-ui-sm);
  font-weight: var(--weight-semibold);
}

@media (pointer: coarse) {
  .menu-states .orr-btn,
  .menu-moves .orr-btn,
  .menu-tool > details > summary {
    min-height: 2.5rem;
  }
}

/* A state or move form in the toolbar is its one button. */
.menu-state,
.menu-move {
  display: flex;
}

/*
 * Move up and Move down only reorder the menu, so they are the row's quietest buttons, apart from
 * the state buttons that change what members see: secondary text on a hairline, with no fill.
 * Hover and focus keep the shared button's look; forced colors keep its border (media.ts).
 */
.menu-moves .orr-btn:not(:hover):not(:focus-visible) {
  color: var(--text-secondary);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

/*
 * A summary looks like the buttons beside it, with the disclosure's chevron first, set a little
 * closer than components.ts's, so a phone's first row holds the three editors.
 */
.menu-tool > details > summary {
  gap: var(--space-1-5);
  padding-inline-start: var(--space-2);
  color: var(--text-primary);
  background: var(--surface-2);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--inner-highlight);
}

.menu-tool > details > summary:hover,
.menu-tool > details > summary:focus-visible {
  color: var(--accent-strong);
  box-shadow:
    inset 0 0 0 1px var(--border-accent),
    var(--inner-highlight);
}

.menu-tool > details > summary::before {
  margin-inline: 1px 2px;
}

/* An open editor's summary stays lit, so it is plain which panel below is its own. */
.menu-tool > details[open] > summary {
  color: var(--accent-strong);
  background: oklch(0.8 0.13 210 / 0.12);
  box-shadow: inset 0 0 0 1px var(--border-accent);
}

/*
 * Delete category: the row's last item, at its end, in the danger tone; open, its summary stays at
 * the end, its consequence under it.
 */
.menu-tool--danger > details,
.menu-tool--danger > details > summary {
  margin-inline-start: auto;
}

.menu-tool--danger > details > summary,
.menu-tool--danger > details > summary:hover,
.menu-tool--danger > details > summary:focus-visible {
  color: var(--danger);
}

.menu-tool--danger > details > summary:hover,
.menu-tool--danger > details > summary:focus-visible,
.menu-tool--danger > details[open] > summary {
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.45);
}

/*
 * An open editor takes a row of its own in place, across the card: its summary, then its panel, a
 * recessed well, right under it; the toolbar's other items follow on the rows after. So nothing
 * Tab reaches after the panel's controls is drawn above them, and no button sits between a
 * summary and its panel. A form's button row inside the well reaches its edges when it sticks on
 * a phone (forms.ts reads --card-pad).
 */
.menu-tool > details[open] {
  flex: 1 0 100%;
  min-width: 0;
}

.menu-tool > details > .disclosure__body {
  --card-pad: var(--space-3);
  margin-top: var(--space-2);
  padding: var(--card-pad);
  border-radius: var(--radius-md);
  background: oklch(0.1 0.026 280 / 0.35);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

/* The Edit roles rows: each role's fields under its name, split by hairlines. */
.option-rows {
  display: grid;
  gap: var(--space-3);
}

.option-row {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.option-row + .option-row {
  padding-top: var(--space-3);
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
  gap: var(--space-2) var(--space-3);
}

/* Add roles: the form, then why the other roles can't be added. */
.menu-add {
  display: grid;
  gap: var(--space-3);
}

/*
 * Each role to add is a row at least 32px tall (44px for a finger) whose whole area is its label's,
 * as on My roles: the label's ::after covers the row, so a click anywhere on it ticks the box, and
 * the box stays above the cover, real and visible, with its own focus outline.
 */
.menu-add .orr-check {
  position: relative;
  align-items: center;
  min-height: 2rem;
}

.menu-add .orr-check__input {
  position: relative;
  z-index: 1;
}

.menu-add .orr-check__label::after {
  content: "";
  position: absolute;
  inset: 0;
}

@media (pointer: coarse) {
  .menu-add .orr-check {
    min-height: 2.75rem;
  }
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

/*
 * Side by side in a card with room: a role's place and state share a line under its description,
 * and all three share one in a wider card (the state choices are short enough for a 13rem select);
 * Edit category and Add a category put the name and description side by side, the limit and the
 * button under them; Add roles lists its roles in columns. Each field's error, then its hint, go
 * under its control (order: the stacked field's label, hint, error, control, mirrored), so the
 * controls in a row line up whatever their hints' lengths.
 */
@container (min-width: 22rem) {
  .option-row__fields {
    grid-template-columns: 4.5rem minmax(0, 1fr);
    align-items: start;
  }
  .option-row__fields > :first-child {
    grid-column: 1 / -1;
  }
  .option-row__fields .orr-field__hint {
    order: 2;
  }
  .option-row__fields .orr-field__hint--error {
    order: 1;
  }
}

/*
 * A card with room puts its state badges at the head's end, like the kit's status badge, and lists
 * described roles in two columns: each role is a row of the list, its own columns the list's
 * (subgrid), so every name lines up in the first column (up to 45% of the card) and every
 * description and "Opens:" line in the second, beside its name; a role's warnings span both.
 * Without subgrid, a role's description and "Opens:" sit beside its own name instead.
 */
@container (min-width: 28rem) {
  .menu-category__meta {
    margin-inline-start: auto;
  }
  .menu-options--described {
    display: grid;
    grid-template-columns: fit-content(45%) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
  }
  .menu-options--described > .menu-option {
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: baseline;
    /* A subgrid's "normal" column gap is the list's. */
    gap: 2px normal;
  }
  .menu-options--described > .menu-option > .menu-option__role {
    grid-row: span 2;
    grid-column: 1;
    align-self: start;
  }
  .menu-options--described > .menu-option > :is(.menu-option__desc, .menu-option__opens) {
    grid-column: 2;
  }
  .menu-options--described > .menu-option > .menu-problems {
    grid-column: 1 / -1;
    margin-top: var(--space-1);
  }
  .menu-add .choice-group[id$="-roles"] > .choice-group__choices {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: var(--space-2) var(--space-4);
  }
}

@container (min-width: 30rem) {
  .menu-form {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
    align-items: start;
    column-gap: var(--space-3);
  }
  .menu-form > .form-error,
  .menu-form > .form-actions {
    grid-column: 1 / -1;
  }
  .menu-form .orr-field__hint {
    order: 2;
  }
  .menu-form .orr-field__hint--error {
    order: 1;
  }
}

@container (min-width: 32rem) {
  .option-row__fields {
    grid-template-columns: minmax(0, 1fr) 4.5rem minmax(0, 13rem);
  }
  .option-row__fields > :first-child {
    grid-column: auto;
  }
}

@media (min-width: 40rem) {
  .menu-summary__counts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .menu-summary__count > .orr-stat__label {
    white-space: nowrap;
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
    gap: var(--space-6);
  }
  .menu-summary__foot {
    grid-column: 1 / -1;
  }
}

/*
 * A wide form on a wide screen, where its button row no longer sticks: the name, the description,
 * the limit and the button in one row, the button level with the controls (under the labels).
 */
@media (min-width: 64rem) {
  @container (min-width: 56rem) {
    .menu-form {
      grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) minmax(0, 13rem) auto;
    }
    .menu-form > .form-actions {
      grid-column: auto;
      margin-top: calc(0.8125rem * 1.2 + 7px);
    }
  }
}

@media (min-width: 72rem) {
  .menu-categories {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .menu-categories:has(details[open]) {
    align-items: start;
  }
}

@media (forced-colors: active) {
  .orr-badge,
  .menu-options > .menu-option--attention,
  .menu-tool > details > summary,
  .menu-tool > details > .disclosure__body {
    border: 1px solid CanvasText;
  }
  .menu-tool > details[open] > summary {
    border-color: Highlight;
  }
}

@media print {
  .orr-badge,
  .menu-options > .menu-option--attention {
    border: 1px solid #888;
  }
  /* The editors and buttons are for the screen; paper keeps the menu itself. */
  .menu-category__foot,
  .menu-summary__foot {
    display: none;
  }
}
`;
