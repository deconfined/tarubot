/**
 * The Background work page's own rules (views/status.ts), on top of the design's card, stat, badge
 * and table in components.ts:
 * - process health, the featured card, laid out like the design's bot status card: phones list
 *   each check as a row, the token in a column; wider screens put readiness on its own line as
 *   the headline and the other checks in a grid, token over sentence, above the instrument scale;
 * - the six sample counts, a row of stat cards (two, three, then six across), on the same 16px
 *   gutter as every other card grid;
 * - the work and run tables, like the design's log table: mono times under small labels, marker
 *   badges, and each row's facts and diagnostic in a disclosure that opens on a solid panel (never
 *   glass inside the glass card). Each table keeps a minimum width and scrolls in its own region
 *   if it must, so the page itself never scrolls sideways; opening a disclosure never moves the
 *   columns;
 * - below tablet width (48rem), the same tables stack each row into a card instead, so a phone
 *   reads a job or run top to bottom rather than scrolling sideways.
 *
 * Every class here is the view's own; the shared vocabulary (status tokens, facts, checklists,
 * section headings, notes, notices, empty states, disclosures) lives in components.ts.
 */
export const STATUS_CSS = `/* Background work */

/* Process health */
.process-health__checks {
  display: grid;
}

.process-health__summary .check-copy {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

.process-health .orr-scale {
  margin-top: var(--space-5);
}

/* A page's sections: the heading (title, count and description), then content, 16px apart. */
.status-section {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

.status-section > .section-heading {
  margin-bottom: 0;
}

/* The sample counts: a stat card per marker, the badge over its count. */
.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  margin: 0;
}

.metrics > .orr-stat {
  gap: 14px;
  padding: var(--space-3);
}

.metrics .metric-none .orr-stat__value {
  color: var(--text-muted);
}

/* At a large text setting, a badge wraps inside its card rather than run out of it. */
.metrics .marker {
  white-space: normal;
}

/* The tables: the card is the scroll region, so it is a block, not the card's flex column. */
.status-section > .table-scroll {
  display: block;
}

/*
 * The narrowest a table may be before its region scrolls, so long names wrap instead of squeezing
 * every column. Unbreakable badges and times set most of the width; the column labels wrap
 * between words, so both tables fit a tablet's column. Words break only when nothing else fits
 * (body's overflow-wrap: anywhere would split "Completed" sooner than widen a column).
 */
.status-table {
  min-width: 40rem;
  overflow-wrap: break-word;
}

.status-table thead th {
  white-space: normal;
}

/* Cells keep 12px a side between columns, and the design's 16px at the table's outer edges. */
.status-table thead th,
.status-table tbody th,
.status-table td {
  padding-inline: 12px;
}

.status-table tr > :first-child {
  padding-left: 16px;
}

.status-table tr > :last-child {
  padding-right: 16px;
}

/*
 * The details column has its share of the table before any disclosure opens. An open panel adds
 * nothing to the column's width (its inline size is contained, so the table never reflows) and
 * lays out in the space the column has: its facts sit beside their labels where the column is
 * wide, and under them where it isn't.
 */
.status-table thead th:last-child {
  width: 32%;
}

.cell-title,
.cell-meta {
  display: block;
}

.cell-title {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

.cell-meta {
  margin-top: 4px;
  color: var(--text-muted);
  font: var(--type-caption);
}

.status-table .marker + .cell-meta {
  margin-top: var(--space-2);
}

/* A column's name inside a cell (views/status.ts): only a stacked card shows it, see below. */
.cell-label {
  display: none;
}

/* Short IDs and job kinds read as plain mono text in a row, not as code chips. */
.cell-meta code,
.row-details > summary code {
  padding: 0;
  background: none;
  color: inherit;
  white-space: nowrap;
}

/*
 * Each moment in a row is a small label and its time: the label over the time, like the design's
 * log times, until a wide screen has room for the labels as a column beside the times.
 */
.time-stack {
  display: grid;
  gap: var(--space-2);
}

.moment {
  display: grid;
  gap: 2px;
}

.time-stack time {
  color: var(--text-secondary);
  font: var(--type-code);
}

/* A run's aggregate outcome: its words, after a dot in the outcome's tone. */
.run-outcome {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

.run-outcome::before {
  content: "";
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--run-tone, var(--text-muted));
  box-shadow: 0 0 8px var(--run-tone, transparent);
  transform: translateY(-1px);
}

.run-outcome--queued {
  --run-tone: var(--info);
}

.run-outcome--completed {
  --run-tone: var(--success);
}

.run-outcome--blocked {
  --run-tone: var(--warning);
}

.run-outcome--paused {
  --run-tone: var(--text-muted);
}

.run-outcome--failed {
  --run-tone: var(--danger);
}

.run-progress {
  display: block;
  color: var(--text-primary);
  font: var(--type-readout);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* A row's disclosure: its summary under the badge, its body a recessed solid panel. */
.status-table .marker + .row-details,
.status-table .cell-meta + .row-details {
  margin-top: var(--space-1);
}

.row-details > summary {
  white-space: nowrap;
}

/*
 * A disclosure that opens its cell (a job's): the summary's tap height centers its label half a
 * rem under the cell's top, so it rises by that much to read on the row's first line, beside the
 * name. A run's summary follows its badge instead, and a stacked card resets this (see below).
 */
.status-table td > .row-details:first-child > summary {
  margin-top: -0.5rem;
}

.row-details__panel {
  container-type: inline-size;
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-1);
  padding: 4px 14px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-1);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  font: var(--type-caption);
}

.row-details .facts {
  grid-template-columns: 7.5rem minmax(0, 1fr);
}

/* The panel's labels are the card's mono labels, as every other label in the row. */
.row-details .facts > dt {
  font: var(--type-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
}

.row-details .facts > dt,
.row-details .facts > dd {
  padding-block: 8px;
}

.row-details .facts code {
  white-space: normal;
  overflow-wrap: anywhere;
}

/*
 * A narrow panel (the column's width, see .status-table above): each value under its label, and a
 * time may wrap before "UTC" rather than run into the panel's edge.
 */
@container (max-width: 18rem) {
  .row-details .facts {
    grid-template-columns: minmax(0, 1fr);
  }
  .row-details .facts time {
    white-space: normal;
  }
  .row-details .facts > dt {
    padding-bottom: 0;
  }
  .row-details .facts > dd {
    padding-top: 2px;
    border-top: 0;
  }
}

.row-details__panel > .note,
.row-details__panel > .diagnostic {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

/* A stored diagnostic: officer-only text, kept as written. */
.diagnostic {
  color: var(--text-primary);
  font: var(--type-code);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* From tablet width: the stats three across; process health's checks token over sentence. */
@media (min-width: 40rem) {
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .metrics > .orr-stat {
    padding: var(--space-4);
  }
  .process-health__checks {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px var(--space-4);
  }
  .process-health__checks > .check-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: var(--space-2);
    padding: 0;
    border-top: 0;
  }
  .process-health__checks .check-copy {
    color: var(--text-primary);
    font: var(--type-ui);
  }
  .process-health__checks > .process-health__summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    grid-column: 1 / -1;
    padding-bottom: 22px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .process-health__summary .check-copy {
    font: var(--type-title);
  }
}

/*
 * Wide screens: the four checks in one row, each token beside its sentence, the six counts in one
 * row, labels beside times.
 */
@media (min-width: 72rem) {
  .process-health__checks {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    row-gap: var(--space-3);
  }
  .process-health__checks > .check-row:not(.process-health__summary) {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-2);
  }
  .process-health__checks > .process-health__summary {
    padding-bottom: var(--space-3);
  }
  .process-health .orr-scale {
    margin-top: var(--space-3);
  }
  .metrics {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  .time-stack {
    grid-template-columns: max-content max-content;
    align-items: baseline;
    gap: 6px 10px;
  }
  /* The moment's label and time become cells of the stack's two columns. */
  .moment {
    display: contents;
  }
}

/*
 * The runs table from tablet width to 80rem: its five columns would squeeze the first to about
 * 100px and break "Lodestone fetch" and "Run <ID>" in two, while the times have room to spare. So
 * the details column takes only what it needs, not its share, and the cells close up to 8px a side
 * (16px still at the table's edges). From 80rem the share returns, so an open panel keeps room for
 * its facts beside their labels. A run's title and short ID are short fixed words, kept whole.
 */
@media screen and (min-width: 48rem) {
  .status-table[aria-describedby="run-sample"] th > :is(.cell-title, .cell-meta) {
    white-space: nowrap;
  }
}

@media screen and (min-width: 48rem) and (max-width: 79.99rem) {
  .status-table[aria-describedby="run-sample"] thead th:last-child {
    width: auto;
  }
  .status-table[aria-describedby="run-sample"] :is(thead th, tbody th, td) {
    padding-inline: 8px;
  }
  .status-table[aria-describedby="run-sample"] tr > :first-child {
    padding-left: 16px;
  }
  .status-table[aria-describedby="run-sample"] tr > :last-child {
    padding-right: 16px;
  }
}

/*
 * Phones and small tablets: each row is a card, stacked 16px apart like the stat cards above,
 * instead of a table row that scrolls sideways. The tables need a 40rem column: under 44rem the
 * gutters leave less than that, and up to 48rem they would fit only at their tightest, with no
 * room for a long name. The table keeps its markup, roles and caption; only the display changes,
 * and the column headers leave the screen but stay for assistive technology. The region drops
 * its glass, so each card is glass over the nebula, never glass in glass; it no longer scrolls or
 * clips (the cards' shadows reach past it), so focusing it only rings the stack.
 *
 * A card is a grid of three columns: labels, values, and the row's state.
 * - The head: the row header (the name, a job's kind, and the short ID) beside the state cell (a
 *   job's marker and attempts, or a run's aggregate outcome).
 * - The labelled lines, under a rule: a run's progress, then each moment ("Added" beside its time).
 *   Their cells subgrid the card's columns, so labels share one column and every value lines up.
 * - The last cell, under a rule, across the card: a run's acquisition, then the disclosure.
 * Nothing here keeps the table's no-wrap: with no scroll region to fall back on, a long name,
 * kind, badge, summary or time wraps inside the card instead of running off the screen. Screen
 * only, so print keeps the table.
 */
@media screen and (max-width: 47.99rem) {
  .status-section > .table-scroll {
    overflow: visible;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: none;
  }
  .status-table {
    display: block;
    min-width: 0;
  }
  .status-table > thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .status-table > tbody {
    display: grid;
    gap: var(--space-4);
  }
  .status-table > tbody > tr {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr) auto;
    gap: var(--space-2) 12px;
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
  /* Cells drop the table's padding, rules and row hover: the card draws the row. */
  .status-table tbody th,
  .status-table td,
  .status-table tr > :first-child,
  .status-table tr > :last-child,
  .status-table tbody tr:hover > * {
    min-width: 0;
    padding: 0;
    border-bottom: 0;
    background: none;
  }
  .status-table tbody th {
    grid-column: 1 / 3;
    text-align: start;
  }
  .status-table .row-state {
    grid-column: 3;
    grid-row: 1;
    text-align: end;
  }
  .status-table .row-state .marker {
    white-space: normal;
  }
  /*
   * The labelled lines. The two-column template is the fallback where subgrid is missing: each
   * cell then sizes its own label column.
   */
  .status-table td:not(.row-state, :last-child) {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-columns: subgrid;
    align-items: baseline;
  }
  .status-table td:not(.row-state, :last-child) > * {
    grid-column: 2 / -1;
  }
  .status-table td > .cell-label {
    display: block;
    grid-column: 1;
  }
  /* A subgrid's normal gap is the card's, so the times line up with the progress above them. */
  .status-table td > .time-stack {
    grid-column: 1 / -1;
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-columns: subgrid;
    column-gap: normal;
    align-items: baseline;
  }
  .status-table .moment {
    display: contents;
  }
  .status-table .moment > .orr-label {
    grid-column: 1;
  }
  .status-table .moment > time {
    grid-column: 2 / -1;
  }
  /*
   * The last cell: a run's acquisition label and badge on one line, then the disclosure; a job's
   * disclosure keeps its whole tap height under the rule.
   */
  .status-table td:last-child {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    grid-column: 1 / -1;
  }
  .status-table td:last-child > *,
  .status-table td > .row-details:first-child > summary {
    margin-top: 0;
  }
  .status-table td:last-child > .row-details {
    flex-basis: 100%;
  }
  /* A rule opens the lines and the last cell, 12px clear on both sides; lines are 8px apart. */
  .status-table .row-state + td,
  .status-table td:last-child {
    margin-top: calc(var(--space-3) - var(--space-2));
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }
  .status-table .time-stack time,
  .status-table .facts time,
  .status-table .cell-meta code,
  .status-table .run-progress,
  .status-table .row-details > summary {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

/*
 * Under 20rem of measure (the narrowest phones, or any phone at a large text setting, which
 * scales these rem breakpoints too), the state no longer fits beside the head's name: it goes
 * under it, so the name keeps the card's width.
 */
@media screen and (max-width: 19.99rem) {
  .status-table tbody th {
    grid-column: 1 / -1;
  }
  .status-table .row-state {
    grid-column: 1 / -1;
    grid-row: auto;
    text-align: start;
  }
}

@media screen and (max-width: 47.99rem) and (prefers-reduced-transparency: reduce) {
  .status-table > tbody > tr {
    background: var(--surface-1);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* Forced colors: each card gets the border media.ts gives every card, and the region none. */
@media screen and (max-width: 47.99rem) and (forced-colors: active) {
  .status-section > .table-scroll {
    border: 0;
  }
  .status-table > tbody > tr {
    border: 1px solid CanvasText;
  }
}

/*
 * Forced colors drop backgrounds and box-shadows: the outcome dot takes a system color, and the
 * details panel, whose edge is a box-shadow, gets a real border.
 */
@media (forced-colors: active) {
  .run-outcome::before {
    background: CanvasText;
  }
  .row-details__panel {
    border: 1px solid CanvasText;
  }
}

@media print {
  .status-table {
    min-width: 0;
  }
}
`;
