/**
 * The My roles page's own rules (views/my-roles.ts), phones first: the intro with its privacy
 * note, the status banners and callouts close under it, then one glass card per category, each a
 * fieldset whose legend is the category's heading, and the Save row (forms.ts makes it stick to
 * the bottom of a phone's screen).
 *
 * Each role is a native checkbox or radio with its label (forms.ts's .orr-check), drawn here as a
 * row at least 44px tall whose whole area is the label's: the label's ::after covers the row, so a
 * tap anywhere on it ticks the input, and the input itself stays real and visible, keeping its
 * focus ring and its forced-colors look. A ticked row is tinted with the accent as well as ticked,
 * so the choice reads at a glance; the tint is decoration, the input's own state carries it. From
 * 40rem the rows sit in columns of at least 14rem, so a wide screen doesn't stretch a short name
 * across the page.
 *
 * Shared vocabulary (cards, notices, notes, badges, empty states, the form kit) lives in
 * components.ts, forms.ts and role-menu.ts; this module only arranges it. Every surface is an
 * .orr-card, so media.ts's reduced-transparency, forced-colors and print fallbacks cover it; the
 * rows' frame, an inset shadow, gets a forced-colors border here.
 */
export const MY_ROLES_CSS = `/* My roles */

/* The opening sentence and the privacy note under it. */
.my-roles-intro {
  display: grid;
  gap: var(--space-2);
}

.my-roles-intro__privacy {
  max-width: 62ch;
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
  margin-top: calc(var(--space-4) - var(--space-8));
}

/*
 * The form: the cards, the Save hint, then the Save row. The hint is its own line above the row,
 * never in it: the row sticks to the bottom of a phone's screen, and beside the button the hint
 * grew it into a tall column with enlarged text, covering the focused input.
 */
.my-roles-form {
  gap: var(--space-5);
}

.my-roles-form__hint {
  max-width: 62ch;
}

/*
 * The categories: one card each, in the officers' order. A wide screen keeps them to a reading
 * width, with the banners above them, rather than stretching a few short names across the page.
 */
.my-categories {
  display: grid;
  gap: var(--space-5);
}

.my-categories,
.my-roles-status,
.my-roles-callouts {
  max-width: 60rem;
}

/* A category's heading, inside its legend (or on its own when it has nothing to tick). */
.my-category .choice-group__legend,
.my-category__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-bottom: var(--space-1);
}

main .my-category__title {
  font: 600 1.125rem / 1.3 var(--font-display);
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
}

/* The line under it: the rule, the description, and a note about an odd state. */
.my-category__rule,
.my-category__desc,
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
  gap: 7px;
}

/* The roles: a column on phones, columns of at least 14rem from 40rem. */
.my-category .choice-group__choices {
  gap: var(--space-2);
  margin-top: var(--space-2);
}

@media (min-width: 40rem) {
  .my-category .choice-group__choices {
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    align-items: start;
  }
}

/* One role: a row at least 44px tall, all of it the label's to tap. */
.my-category .orr-check {
  position: relative;
  min-height: 2.75rem;
  padding: 0.6875rem var(--space-3);
  border-radius: var(--radius-md);
  background: oklch(0.1 0.026 280 / 0.35);
  box-shadow: inset 0 0 0 1px var(--border-default);
  transition:
    background var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
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
  background: oklch(0.8 0.13 210 / 0.1);
  box-shadow: inset 0 0 0 1px var(--border-accent);
}

.my-category .orr-check__desc {
  overflow-wrap: anywhere;
}

/*
 * Roles held that can't change here now, beside roles that can: a line each in the group's hint,
 * so they are read with the group, framed like a row but without an input.
 */
.my-category__fixed {
  display: block;
  margin-top: var(--space-2);
  padding: 10px var(--space-3);
  border-radius: var(--radius-md);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  color: var(--text-secondary);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/*
 * A category with nothing to pick: its roles in one plain sentence, unframed, so nothing in the
 * card passes for a row to tap.
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

/* A draft, which only officers see: its badge in the drafts' violet. */
.my-category--draft .orr-badge {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

/* Forced colors drop the rows' inset frame; a border keeps each row's edge. */
@media (forced-colors: active) {
  .my-category .orr-check,
  .my-category__fixed {
    border: 1px solid CanvasText;
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
