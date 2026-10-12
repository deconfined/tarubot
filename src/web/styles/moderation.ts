/**
 * The Moderation page's own rules (views/moderation.ts), phones first and dense:
 * - one toolbar card on top: the finder (a label, its field and Find on one row that wraps) and
 *   Pause someone at the row's end;
 * - the paused people as a grid of cards, one column on phones and as many as fit from there (a
 *   card wants 22rem), each holding a chip per paused feature: the feature and its end on one line,
 *   the reason under it, and who set it with Lift on the last;
 * - the ended pauses as a grid of small entries, the same way, and the finder's result as one card
 *   whose chips fill its width;
 * - the Pause someone and Lift panels, which are role-menu.ts's .overlay panels (opened on top of
 *   the page, a sheet on a phone; Pause someone's two buttons are anchors there, so it opens
 *   beside its button on a wide screen, while Lift opens centred); only their forms' layout is
 *   here: the member and the length on one row where there is room, and the features in columns.
 *
 * A reason keeps its line breaks (pre-wrap) and wraps any long word, so a URL or a run of
 * characters never pushes the page sideways. Shared vocabulary (cards, notices, notes, empty
 * states, the form kit, buttons) lives in components.ts and forms.ts; this module only arranges it.
 * Every card is an .orr-card, so media.ts's reduced-transparency, forced-colors and print
 * fallbacks cover it; a chip and an ended entry are drawn with an inset shadow, so they get their
 * own forced-colors borders here.
 *
 * It is one of assets.ts's page stylesheets, after Mod mail's and so after role-menu.ts's, which
 * draws every .overlay and holds the anchor pairs: nothing here sets a rule for .overlay or for a
 * selector that role-menu.ts's rules would otherwise have to win over, and every class here is the
 * page's own (mod-*), so the later position changes no rule of another page.
 */
export const MODERATION_CSS = `/* Moderation */

/* The second line of the intro sits close under the lead, as the Role menu's does. */
.lead + .mod-intro {
  max-width: 80ch;
  margin-top: calc(var(--space-1) - var(--section-gap, var(--space-6)));
}

.mod-limits {
  max-width: 80ch;
}

/* The toolbar card: the finder, then the button, on one row that wraps. */
.mod-toolbar {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3) var(--space-5);
  padding: var(--card-pad);
}

.mod-finder {
  display: flex;
  flex: 1 1 24rem;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.mod-finder > .orr-field {
  flex: 1 1 16rem;
}

.mod-toolbar__tool {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-inline-start: auto;
}

/* A button that opens a panel, or the link that stands in for it, in a toolbar or a chip. */
.mod-opener,
.mod-signin {
  flex: 0 0 auto;
  min-height: 2rem;
}

@media (pointer: coarse) {
  .mod-opener,
  .mod-signin {
    min-height: 2.5rem;
  }
}

/* A section of the page: its heading, then its grid. */
.mod-section {
  display: grid;
  gap: var(--space-3);
  align-content: start;
  min-width: 0;
}

.mod-section > .section-heading {
  margin-bottom: 0;
}

/* The people and the ended entries: as many columns as fit. */
.mod-people,
.mod-dones {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mod-dones {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-2);
}

/* A person's card: the name, then their chips; the sign-in link goes at the foot when needed. */
.mod-person {
  gap: var(--space-3);
  padding: var(--card-pad);
  align-content: start;
}

.mod-person__name,
.mod-found__name {
  margin: 0;
  color: var(--text-primary);
  font: 600 1rem / 1.3 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
}

.mod-person__name a {
  color: inherit;
  text-decoration: none;
}

.mod-person__name a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.mod-person__foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mod-id {
  color: var(--text-secondary);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.mod-gone {
  color: var(--text-muted);
  font: var(--type-caption);
}

/* A chip: one paused feature. */
.mod-pauses {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mod-pause,
.mod-done {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

.mod-pause p,
.mod-done p {
  margin: 0;
}

.mod-pause__head,
.mod-done__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-3);
}

.mod-pause__feature,
.mod-done__feature {
  color: var(--text-primary);
  font: var(--type-ui);
  font-weight: var(--weight-semibold);
  overflow-wrap: anywhere;
}

.mod-until {
  color: var(--text-secondary);
  font: 500 0.75rem / 1.3 var(--font-mono);
}

.mod-pause__reason,
.mod-done__why,
.mod-done__was {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mod-pause__reason,
.mod-done__why {
  color: var(--text-secondary);
}

.mod-pause__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  min-width: 0;
  color: var(--text-muted);
  font: var(--type-caption);
}

.mod-pause__by,
.mod-pause__note {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mod-done__how {
  color: var(--text-secondary);
  font: var(--type-caption);
}

.mod-done__head a {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

/* The finder's result: one card, its chips filling its width. */
.mod-found {
  gap: var(--space-3);
  padding: var(--card-pad);
}

.mod-found__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.mod-found .mod-pauses {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
}

.mod-found__line,
.mod-found__none {
  margin: 0;
  color: var(--text-secondary);
}

.mod-found__sub {
  margin: 0;
  color: var(--text-secondary);
  font: var(--type-label);
}

/* The panels' forms: the member and the length side by side where there is room. */
.mod-form {
  gap: var(--space-3);
}

.mod-form__note {
  margin: 0;
  max-width: 70ch;
}

.mod-form__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: var(--space-3) var(--space-4);
}

.mod-form .choice-group__choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-2) var(--space-4);
}

.mod-form textarea.orr-input {
  min-height: 6rem;
}

@media (forced-colors: active) {
  .mod-pause,
  .mod-done {
    border: 1px solid CanvasText;
  }
}

@media print {
  .mod-toolbar,
  .mod-opener,
  .mod-signin {
    display: none;
  }
}
`;
