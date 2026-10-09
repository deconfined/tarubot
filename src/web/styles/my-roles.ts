/**
 * The My roles page's own rules (views/my-roles.ts), phones first: the one-sentence intro with its
 * privacy note as a small line under it, the status banners and callouts close under that, then
 * the categories as glass cards in a grid, each a fieldset whose legend is the category's heading,
 * and the Save row (forms.ts makes it stick to the bottom of a phone's screen).
 *
 * The page uses the width rather than stacking: the cards fill columns at least 19rem wide (one
 * on phones, two on tablets, three on a wide screen), and each role is a pill sized to its name,
 * so a category's roles wrap side by side instead of one full-width row each.
 *
 * Each pill is a native checkbox or radio with its label (forms.ts's .orr-check), at least 44px
 * tall for touch and 36px for a mouse from 40rem, whose whole area is the label's: the label's ::after covers
 * the pill, so a tap anywhere on it ticks the input, and the input itself stays real and visible,
 * keeping its focus outline and its forced-colors look; the pill's accent edge and glow on focus
 * only add to that outline. A ticked pill is tinted with the accent as well as ticked, so the
 * choice reads at a glance; the tint is decoration, the input's own state carries it. A role's
 * description is a small muted line inside its pill, still the input's description.
 *
 * Shared vocabulary (cards, notices, notes, badges, empty states, the form kit) lives in
 * components.ts, forms.ts and role-menu.ts; this module only arranges it. Every surface is an
 * .orr-card, so media.ts's reduced-transparency, forced-colors and print fallbacks cover it; the
 * pills' frame, an inset shadow, gets a forced-colors border here.
 */
export const MY_ROLES_CSS = `/* My roles */

/*
 * The opening sentence and the privacy note under it, joined to the page header as its
 * description (as shell.ts's .page-header + .lead).
 */
.my-roles-intro {
  display: grid;
  gap: var(--space-1);
}

.page-header + .my-roles-intro {
  margin-top: calc(var(--space-2) - var(--section-gap));
}

.my-roles-intro__privacy {
  max-width: 80ch;
}

/* The status banners and the callouts: one block each, close under the intro like a page notice. */
.my-roles-status,
.my-roles-callouts {
  display: grid;
  gap: var(--space-2);
}

.my-roles-intro + .my-roles-status,
.my-roles-intro + .my-roles-callouts,
.my-roles-status + .my-roles-callouts {
  margin-top: calc(var(--space-3) - var(--section-gap));
}

/*
 * The form: the cards, the Save hint, then the Save row. On phones and tablets the hint is its own
 * line above the row, never in it: the row sticks to the bottom of the screen, and beside the
 * button the hint grew it into a tall column with enlarged text, covering the focused input.
 */
.my-roles-form {
  gap: var(--space-4);
}

.my-roles-form__hint {
  max-width: 62ch;
}

/*
 * From 64rem nothing sticks, so the Save button and its hint share one row, the button first: the
 * hint is the button's description and holds no control, so drawing it after the button moves
 * nothing in the focus order.
 */
@media (min-width: 64rem) {
  .my-roles-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: var(--space-4);
  }
  .my-roles-form > * {
    flex: 1 0 100%;
  }
  .my-roles-form > .form-actions {
    flex: 0 0 auto;
    order: 1;
  }
  .my-roles-form > .my-roles-form__hint {
    flex: 1 1 16rem;
    order: 2;
  }
}

/*
 * The categories: a card each, in the officers' order, in as many columns of at least 19rem as
 * fit (one on phones). Cards in a row share its height, so their edges line up.
 */
.my-categories {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
  gap: var(--space-4);
}

/* A category's heading and rule, in its legend (or on their own when it has nothing to tick). */
.my-category .choice-group__legend,
.my-category__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  margin-bottom: var(--space-1);
}

main .my-category__title {
  font: 600 1.0625rem / 1.3 var(--font-display);
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
}

/*
 * The rule beside the name, small, as on Role menu's cards; the lines under them: the description,
 * then a line each for a draft's note, the roles that can't change and a note about an odd state.
 */
.my-category__draft,
.my-category__note {
  display: block;
}

.my-category__rule {
  color: var(--text-accent);
  font: 500 0.6875rem / 1.6 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.my-category__desc {
  overflow-wrap: anywhere;
}

/*
 * A hint that holds only the rule for assistive technology (no description, roles kept or note)
 * shows nothing, so it takes no row, and no gap, in the group: out of the flow, still in the page.
 */
.my-category .choice-group > .orr-field__hint:not(:has(> :not(.visually-hidden))) {
  position: absolute;
}

.my-category__draft,
.my-category__note {
  margin-top: var(--space-1);
  font-weight: var(--weight-semibold);
}

.my-category__draft {
  color: var(--violet-400);
}

.my-category__note {
  color: var(--warning);
}

.my-category__plain {
  display: grid;
  gap: var(--space-1);
}

/*
 * The roles: pills that wrap side by side, each as wide as its name. Pills on one line share its
 * height, so a line mixing pills with and without a description reads as one even row; a one-line
 * pill keeps its label centred (align-content below).
 */
.my-category .choice-group__choices {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/*
 * One role: a pill all of whose area is the label's to tap, 44px tall for a thumb, and 36px where
 * a mouse picks on a wider screen.
 */
.my-category .orr-check {
  position: relative;
  grid-template-columns: auto minmax(0, auto);
  align-content: center;
  gap: var(--space-2);
  max-width: 100%;
  min-height: 2.75rem;
  padding: var(--space-1-5) var(--space-3) var(--space-1-5) 0.6875rem;
  border-radius: 1.375rem;
  background: oklch(0.1 0.026 280 / 0.35);
  box-shadow: inset 0 0 0 1px var(--border-default);
  transition:
    background var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}

@media (min-width: 40rem) and (pointer: fine) {
  .my-category .orr-check {
    min-height: 2.25rem;
    border-radius: 1.125rem;
  }
}

.my-category .orr-check__text {
  gap: 0;
}

.my-category .orr-check__label {
  overflow-wrap: anywhere;
}

.my-category .orr-check__label::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

/* The input stays above the label's cover, so a tap on the box itself lands on the box. */
.my-category .orr-check__input {
  position: relative;
  z-index: 1;
}

.my-category .orr-check:hover:not(:has(> .orr-check__input:disabled)) {
  box-shadow: inset 0 0 0 1px var(--border-control-hover);
}

.my-category .orr-check:has(> .orr-check__input:checked) {
  background: oklch(0.8 0.13 210 / 0.12);
  box-shadow: inset 0 0 0 1px var(--border-accent);
}

/* Focus: the input's own outline marks it; the pill's accent edge and glow only add to it. */
.my-category .orr-check:has(> .orr-check__input:focus-visible) {
  box-shadow:
    inset 0 0 0 1px var(--border-accent),
    var(--glow-cyan-sm);
}

.my-category .orr-check__desc {
  line-height: 1.35;
  overflow-wrap: anywhere;
}

/*
 * Roles held that can't change here now, beside roles that can: a line each in the group's hint,
 * so they are read with the group, framed like a pill but without an input.
 */
.my-category__fixed {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-1-5) var(--space-3);
  border-radius: var(--radius-md);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  color: var(--text-secondary);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/*
 * A category with nothing to pick: its roles in one plain sentence, unframed, so nothing in the
 * card passes for a pill to tap.
 */
.my-category__kept {
  display: block;
  margin-top: var(--space-1);
  overflow-wrap: anywhere;
}

/*
 * A locked form (a time-out, or role changes paused) still shows the person their own roles, so
 * only the inputs dim: the names and descriptions keep the contrast they have when enabled, the
 * names in the secondary text color as the one sign they can't be changed now. A draft, which
 * only officers preview, stays dimmed as forms.ts dims any disabled row.
 */
.my-categories--locked .my-category:not(.my-category--draft) .orr-check__input:disabled + .orr-check__text {
  opacity: 1;
}

.my-categories--locked .my-category:not(.my-category--draft) .orr-check__input:disabled + .orr-check__text > .orr-check__label {
  color: var(--text-secondary);
}

.my-categories--locked .my-category:not(.my-category--draft) .orr-check__input:disabled {
  opacity: 0.6;
}

/*
 * A badge beside a category's or a role's name moves to a line of its own when the line is full,
 * and wraps inside itself only when even that can't hold it (a large text setting on a phone),
 * rather than run out of its pill or card.
 */
.my-category .orr-badge {
  line-height: 1.2;
  white-space: normal;
}

/* A draft, which only officers see: its badge in the drafts' violet. */
.my-category--draft .orr-badge {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

/*
 * Forced colors drop the pills' inset frame and tint; a border keeps each pill's edge, and a
 * ticked pill's border takes the highlight color beside its ticked input.
 */
@media (forced-colors: active) {
  .my-category .orr-check,
  .my-category__fixed {
    border: 1px solid CanvasText;
  }
  .my-category .orr-check:has(> .orr-check__input:checked) {
    border-color: Highlight;
  }
}

/*
 * On phones the Save row sticks to the bottom of the screen (forms.ts). This form sits in the page,
 * not in a card, so the row reaches the page's own edges, its button lined up with the cards. The
 * row holds the button alone, so at any text size it stays one button tall, within the page's
 * scroll padding.
 */
@media (max-width: 63.99rem) and (min-height: 30rem) {
  .my-roles-form .form-actions {
    margin-inline: calc(-1 * var(--space-4));
    padding-inline: var(--space-4);
  }
}

@media (min-width: 40rem) and (max-width: 63.99rem) and (min-height: 30rem) {
  .my-roles-form .form-actions {
    margin-inline: calc(-1 * var(--gutter));
    padding-inline: var(--gutter);
  }
}
`;
