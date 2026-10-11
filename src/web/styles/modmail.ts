/**
 * Mod mail's pages (views/modmail.ts), phones first:
 * - the officers' inbox beside its settings card: one column up to laptops (the cases, then the
 *   card), two from 88rem, with the card in a 22rem column at the side, so the cases' table keeps
 *   room for its five columns;
 * - the filters as a row of pills that wraps, the current one marked by its border as well as its
 *   tint (aria-current carries it for assistive technology);
 * - the case tables as glass tables that stack each row into a card below 48rem, as Background
 *   work's do, with each value under its column's name;
 * - a case page: the case's card (number, topic and facts), then the thread, each message a glass
 *   card leaning to its side's edge (the viewer's side right, like a chat), state lines as small
 *   centred text between them, then the reply form and Close or Reopen; from 80rem the case's card
 *   is a sticky column beside the thread. A message keeps its line breaks (pre-wrap) and wraps any
 *   long word, so a URL or a run of characters never pushes the page sideways;
 * - a member's page: Open a case and its line on one row that wraps, then their cases. The form
 *   opens on top of the page in role-menu.ts's .overlay panel (beside its button from 40rem, a
 *   bottom sheet on a phone, centred when drawn open after a refusal), tied to its button by a
 *   static anchor pair that role-menu.ts keeps with its own, in the stylesheet's one anchor
 *   positioning block, as the CSP allows no style attribute.
 *
 * Shared vocabulary (cards, badges, notices, checklists, disclosures, tables, the form kit) lives in
 * components.ts, forms.ts, role-menu.ts and status.ts; this module only arranges it. Every surface
 * is an .orr-card, so media.ts's reduced-transparency, forced-colors and print fallbacks cover it;
 * the filter pills and the state badges, drawn with inset shadows, get forced-colors borders here.
 */
export const MODMAIL_CSS = `/* Mod mail */

/* The privacy line: the lock, then the sentence. */
.modmail-privacy {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  max-width: 80ch;
}

.modmail-privacy > .orr-icon {
  margin-top: 0.2em;
}

/* The officers' inbox: the cases, then the settings card; two columns from 64rem. */
.modmail-inbox {
  display: grid;
  gap: var(--space-6);
}

.modmail-inbox__cases,
.modmail-inbox__side,
.modmail-mine {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  min-width: 0;
}

@media (min-width: 88rem) {
  .modmail-inbox {
    grid-template-columns: minmax(0, 1fr) 22rem;
    align-items: start;
  }
}

/* The filters: pills that wrap, each a link with a count. */
.modmail-filters ul {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A pill never shrinks or breaks inside a word: the row wraps between pills instead. */
.modmail-filters li {
  flex: 0 0 auto;
}

.modmail-filter {
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  font: var(--type-ui);
  text-decoration: none;
}

.modmail-filter:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.modmail-filter[aria-current="page"] {
  color: var(--text-primary);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.modmail-filters__count {
  font: 500 0.75rem / 1 var(--font-mono);
  color: var(--text-muted);
}

@media (min-width: 40rem) {
  .modmail-filter {
    min-height: 36px;
  }
}

/* A case's number links to it; a topic wraps rather than widen its column. */
.modmail-case-link {
  white-space: nowrap;
}

.modmail-table .orr-table {
  min-width: 36rem;
  overflow-wrap: break-word;
}

/* A topic wraps between words; its column keeps room for a few words a line. */
.modmail-topic {
  min-width: 12rem;
  overflow-wrap: break-word;
}

.modmail-unreadable {
  color: var(--text-muted);
  font-style: italic;
}

/* The state badges: the words carry the state, the tone repeats it. */
.modmail-state--officers {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

.modmail-state--member {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

/*
 * Below 48rem a case table stacks each row into a glass card, as Background work's tables do: the
 * case link and state on the first line, then each value under its column's name. The column
 * headers leave the screen but stay for assistive technology; screen only, so print keeps the
 * table.
 */
@media screen and (max-width: 47.99rem) {
  .modmail-table {
    overflow: visible;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: none;
  }
  .modmail-table .orr-table {
    display: block;
    min-width: 0;
  }
  .modmail-table .orr-table > thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .modmail-table .orr-table > tbody {
    display: grid;
    gap: var(--space-3);
  }
  .modmail-table .orr-table > tbody > tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background: var(--glass-fill);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    box-shadow:
      inset 0 0 0 1px var(--glass-border),
      var(--glass-edge),
      var(--shadow-1);
  }
  .modmail-table .orr-table tbody th,
  .modmail-table .orr-table td,
  .modmail-table .orr-table tbody tr:hover > * {
    min-width: 0;
    padding: 0;
    border-bottom: 0;
    background: none;
  }
  .modmail-table .orr-table td {
    grid-column: 1 / -1;
  }
  /* The state badge beside the case link. */
  .modmail-table .orr-table td:has(> .modmail-state) {
    grid-column: 2;
    grid-row: 1;
    text-align: end;
  }
  .modmail-table .orr-table td > .cell-label {
    display: block;
    margin-bottom: 2px;
  }
}

/* The settings card: its heading with the on/off token, the checks, then the switch. */
.modmail-settings .orr-card__body {
  display: grid;
  gap: var(--space-3);
}

.modmail-settings__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

main .modmail-settings__title {
  font: 600 1.0625rem / 1.3 var(--font-display);
  letter-spacing: var(--tracking-title);
}

.modmail-switch {
  gap: var(--space-2);
}

/* The checks, then the switch; side by side where the card spans the page (stacked layout). */
.modmail-settings__grid {
  display: grid;
  gap: var(--space-3) var(--space-6);
  align-items: start;
}

@media (min-width: 48rem) and (max-width: 87.99rem) {
  .modmail-settings__grid {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}

/* A case page: the case's card, then the thread with its forms. */
.modmail-back {
  margin: 0;
}

.modmail-case {
  display: grid;
  gap: var(--space-5);
}

.modmail-case__head .orr-card__body {
  display: grid;
  gap: var(--space-3);
}

main .modmail-case__title {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  align-items: baseline;
  font: 600 1.25rem / 1.3 var(--font-display);
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
}

.modmail-case__number {
  color: var(--text-muted);
  font: 500 0.9375rem / 1.3 var(--font-mono);
  white-space: nowrap;
}

.modmail-case__thread {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

/* The thread: messages lean to their side's edge, state lines sit centred between them. */
.modmail-thread {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.modmail-message {
  display: flex;
  min-width: 0;
}

.modmail-message__card {
  width: min(100%, 44rem);
  min-width: 0;
}

.modmail-message--own {
  justify-content: flex-end;
}

.modmail-message--own .modmail-message__card {
  box-shadow:
    inset 0 0 0 1px oklch(0.8 0.13 210 / 0.35),
    var(--glass-edge),
    var(--shadow-1);
}

.modmail-message__card {
  padding: var(--space-3) var(--space-4);
}

.modmail-message__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-3);
  margin-bottom: var(--space-2);
}

main .modmail-message__by {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  margin: 0;
  font: 600 var(--text-md) / 1.4 var(--font-sans);
  overflow-wrap: anywhere;
}

.modmail-message__time,
.modmail-line__time {
  color: var(--text-muted);
  font: var(--type-caption);
  white-space: nowrap;
}

.modmail-message__body {
  margin: 0;
  max-width: 72ch;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-primary);
}

.modmail-line {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-1) 0;
  color: var(--text-secondary);
  font: var(--type-caption);
  text-align: center;
}

/* Open a case: the button, then its line (why it's unavailable, or /modmail), wrapping as one. */
.modmail-open-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
}

.modmail-opener {
  flex: 0 0 auto;
}

.modmail-open-bar__note {
  flex: 1 1 18rem;
  min-width: 0;
  margin: 0;
}

/* The open form: the privacy sentence, then the fields. */
.modmail-open-form {
  gap: var(--space-3);
}

/* The reply form and the case's actions. */
.modmail-reply {
  gap: var(--space-3);
}

.modmail-reply .orr-input,
.modmail-open-form textarea.orr-input {
  min-height: 8rem;
}

/* The two signing choices side by side where both fit, rather than one long column. */
.modmail-reply .choice-group__choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-2) var(--space-4);
}

.modmail-case__actions {
  display: grid;
  gap: var(--space-3);
}

.modmail-state-form {
  gap: var(--space-2);
}

/* The read log: names and what happened wrap between words; the side and the time stay whole. */
.modmail-reads .orr-table td {
  overflow-wrap: break-word;
}

.modmail-reads .orr-table td:nth-child(2),
.modmail-reads .orr-table td:nth-child(4) {
  white-space: nowrap;
}

/*
 * Below 48rem each read is one block: the reader on its own line, then the side, what happened and
 * when, wrapping as they must. The column headers leave the screen but stay for assistive
 * technology, and the table keeps its explicit roles; screen only, so print keeps the table.
 */
@media screen and (max-width: 47.99rem) {
  .modmail-reads .table-scroll {
    overflow: visible;
  }
  .modmail-reads .orr-table,
  .modmail-reads .orr-table > tbody {
    display: block;
  }
  .modmail-reads .orr-table > thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .modmail-reads .orr-table tr {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .modmail-reads .orr-table td,
  .modmail-reads .orr-table tbody tr:hover > * {
    padding: 0;
    border-bottom: 0;
    background: none;
  }
  .modmail-reads .orr-table td:first-child {
    flex-basis: 100%;
    color: var(--text-primary);
    font-weight: var(--weight-semibold);
  }
}

/* From 80rem the thread is the main column and the case's card sits beside it. */
@media (min-width: 80rem) {
  .modmail-case {
    grid-template-columns: 20rem minmax(0, 1fr);
    align-items: start;
  }
  .modmail-case__head {
    position: sticky;
    top: var(--space-6);
  }
}

@media (forced-colors: active) {
  .modmail-filter {
    border: 1px solid CanvasText;
  }
  .modmail-filter[aria-current="page"] {
    border: 2px solid Highlight;
  }
}

@media print {
  .modmail-reply,
  .modmail-case__actions,
  .modmail-open-bar,
  .modmail-filters {
    display: none;
  }
  .modmail-case__head {
    position: static;
  }
}
`;
