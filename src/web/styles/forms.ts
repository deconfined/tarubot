/**
 * Form controls for the dashboard's first writing pages (2.39.0), ported from the Orrery
 * design system's styles/components.css (field, input, select, checkbox and radio, the danger
 * button), plus the vocabulary views/forms.ts renders around them: the form's stack, the error
 * summary, choice groups, the action row, disclosures holding an editor or a confirmation, and the
 * success notice after a save. styles/media.ts carries their forced-colors and print rules.
 *
 * Fixes to the export, each marked where it applies:
 * - an input's frame is a real border, not the export's inset box-shadow, which forced colors
 *   (Windows contrast themes) drop, leaving a field with no visible edge;
 * - the export's `outline: none` on the control is gone, so base.ts's :focus-visible outline marks
 *   focus everywhere, forced colors included; the design's glow sits beside it as decoration;
 * - checkboxes and radios are the real, visible inputs, colored with accent-color, instead of a
 *   hidden input under a drawn box: the platform keeps their focus ring, their forced-colors look,
 *   their hit area and their dark rendering (color-scheme: dark), with no script;
 * - `<select>` keeps its native appearance and picker, which phones present best, so no chevron;
 * - controls use 1rem text, as phones zoom the page into any field under 16px on focus;
 * - the label is 600-weight in rem, so a large text setting scales it with the rest.
 * Not ported: the switch (an instant setting needs script; a checkbox and a submit say the same)
 * and the slider.
 */
export const FORMS_CSS = `/* Forms: from the Orrery design system's styles/components.css */

/* A form's fields and groups, one under another (views/forms.ts's postForm). */
.form {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

/* Field: the label, then its hint and error, then the control. */
.orr-field {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.orr-field__label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--text-secondary);
  font: 600 0.8125rem / 1.2 var(--font-sans);
}

.orr-field__hint {
  color: var(--text-muted);
  font: var(--type-caption);
}

.orr-field__hint--error {
  color: var(--danger);
  font-weight: var(--weight-semibold);
}

/*
 * Input, textarea, number and select. Fix: the frame is a real border (forced colors keep it), in
 * the opaque control tone, since it is all that shows where to type (WCAG 1.4.11: at least 3:1),
 * and focus is base.ts's outline with the design's glow beside it.
 */
.orr-input {
  width: 100%;
  min-width: 0;
  min-height: var(--control-md);
  padding: 6px var(--space-3);
  border: 1px solid var(--border-control);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: oklch(0.1 0.026 280 / 0.7);
  box-shadow: inset 0 2px 6px oklch(0 0 0 / 0.25);
  font: var(--type-ui);
  font-size: 1rem;
  font-weight: var(--weight-medium);
  transition:
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}

.orr-input:hover:not(:disabled) {
  border-color: var(--border-control-hover);
}

.orr-input:focus-visible {
  border-color: var(--border-accent);
  box-shadow:
    0 0 0 3px oklch(0.8 0.13 210 / 0.14),
    var(--glow-cyan-sm);
}

.orr-input::placeholder {
  color: var(--text-faint);
}

/*
 * A control an error summary link scrolls to keeps its label, hint and error in view above it: the
 * kit puts those between the label and the control, and the shell's scroll padding only clears the
 * sticky bar from the control itself. In rem, so it grows with the text size; most for a field
 * with a hint (and an error), and for the first field under a form's own error.
 */
.orr-field > .orr-input {
  scroll-margin-top: 3.5rem;
}

.orr-field:has(> .orr-field__hint) > .orr-input {
  scroll-margin-top: 6rem;
}

.form-error + .orr-field > .orr-input {
  scroll-margin-top: 9rem;
}

/* A field with a problem: the border carries it, and the message under the label says it. */
.orr-input[aria-invalid="true"],
.orr-input[aria-invalid="true"]:hover {
  border-color: oklch(0.74 0.15 18 / 0.75);
}

.orr-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

textarea.orr-input {
  min-height: 88px;
  padding-block: 10px;
  font-weight: var(--weight-regular);
  line-height: 1.5;
  resize: vertical;
}

/* A position or a count: a few digits, so the field stays short. */
input.orr-input[type="number"] {
  max-width: 8rem;
}

/* Browsers give a select its own line height; without block padding it matches the inputs. */
select.orr-input {
  padding-block: 0;
  cursor: pointer;
}

select.orr-input option {
  color: var(--text-primary);
  background: var(--night-850);
}

/*
 * Checkbox and radio: one row per choice, the native input then its label and description. Fix:
 * the input stays real and visible, tinted by accent-color.
 */
.orr-check {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}

.orr-check__input {
  width: 1.125rem;
  height: 1.125rem;
  margin: 0.0625rem 0 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.orr-check__text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.orr-check__label {
  color: var(--text-primary);
  font: var(--type-ui);
  cursor: pointer;
}

.orr-check__desc {
  color: var(--text-muted);
  font: var(--type-caption);
}

.orr-check__input:disabled,
.orr-check__input:disabled + .orr-check__text > .orr-check__label {
  cursor: not-allowed;
}

.orr-check__input:disabled + .orr-check__text {
  opacity: 0.45;
}

/* A group of choices: the fieldset's own frame and padding go, the legend reads as a label. */
.choice-group {
  display: grid;
  gap: 7px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.choice-group__legend {
  float: left;
  width: 100%;
  margin-bottom: 2px;
  padding: 0;
  color: var(--text-secondary);
  font: 600 0.8125rem / 1.2 var(--font-sans);
}

.choice-group__legend + * {
  clear: both;
}

.choice-group__choices {
  display: grid;
  gap: var(--space-3);
  margin-top: 3px;
}

/* Button: the danger variant, for a delete inside its confirmation (views/forms.ts). */
.orr-btn--danger {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.35);
}

.orr-btn--danger:hover:not(:disabled),
.orr-btn--danger:focus-visible {
  color: oklch(0.88 0.08 18);
  box-shadow:
    inset 0 0 0 1px oklch(0.74 0.15 18 / 0.6),
    var(--glow-danger);
}

.orr-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/*
 * The error summary at the top of a refused form: a danger-toned panel with a link to each field.
 * It takes focus on load, so base.ts's outline marks it.
 */
.error-summary {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-lg);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.45);
}

main .error-summary__title {
  color: var(--text-primary);
  font: var(--type-subtitle);
}

.error-summary__list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding-left: 1.25rem;
}

.error-summary__list a {
  color: var(--danger);
  font-weight: var(--weight-semibold);
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* A form's buttons: a row that wraps, after the fields. */
.form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

/* A disclosure's contents: an editor, or a confirmation's consequence and its button. */
.disclosure__body {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-3);
}

/* The notice after a successful save, shown once on the page the form redirected to. */
.notice--success {
  color: var(--text-primary);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

/*
 * The redirect's #status fragment scrolls on the first frame, while the page entrance still holds
 * main shrunk and lowered (effects.ts's orr-rise-in); the animation then slid the notice up under
 * the sticky bar, by more the taller the page. A page that lands on its notice skips the entrance,
 * as reduced motion does.
 */
main.orr-enter:has(#status) {
  animation: none;
}

/*
 * On phones, a form's buttons stay in reach while its fields scroll: the row sticks to the bottom
 * of the screen, solid so the fields don't show through, and clear of the home indicator. The
 * scroll padding keeps a focused field from scrolling in under the row (WCAG 2.4.11), as the
 * shell's does for its top bar. A short viewport (a phone in landscape, or 400% zoom) can't spare
 * the room, so there the row stays in its place, like the shell's bar. In a card, the row reaches
 * the card's edges, like a card's foot, rather than sitting in it as a dark inset band.
 */
@media (max-width: 63.99rem) and (min-height: 30rem) {
  html:has(.form-actions) {
    scroll-padding-bottom: calc(5rem + env(safe-area-inset-bottom));
  }
  .form-actions {
    position: sticky;
    bottom: 0;
    z-index: var(--z-sticky);
    padding-block: var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-1);
  }
  /* 1px short of each edge, so the card's own hairline edge stays whole beside the row. */
  .orr-card .form-actions {
    margin-inline: calc(1px - var(--card-pad));
    padding-inline: calc(var(--card-pad) - 1px);
  }
}
`;
