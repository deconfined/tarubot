/**
 * The Background work page's own rules (views/status.ts), on top of the design's card, stat, badge
 * and table in components.ts:
 * - process health, the featured card, laid out like the design's bot status card: phones list
 *   each check as a row, the token in a column; wider screens put readiness on its own line as
 *   the headline and the other checks in a grid, token over sentence, above the instrument scale;
 * - the six sample counts, a row of stat cards (two, three, then six across);
 * - the work and run tables, like the design's log table: mono times under small labels, marker
 *   badges, and each row's facts and diagnostic in a disclosure that opens on a solid panel (never
 *   glass inside the glass card). Each table keeps a minimum width and scrolls in its own region
 *   on a narrow screen, so the page itself never scrolls sideways.
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

/* A page's sections: heading, description, then content, 16px apart. */
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
  gap: var(--space-3);
  margin: 0;
}

.metrics > .orr-stat {
  gap: 14px;
  padding: var(--space-3);
}

.metrics .metric-none .orr-stat__value {
  color: var(--text-muted);
}

/* The tables: the card is the scroll region, so it is a block, not the card's flex column. */
.status-section > .table-scroll {
  display: block;
}

/*
 * The narrowest a table may be before its region scrolls, so long names wrap instead of squeezing
 * every column. Unbreakable badges, times and column labels set most of the width: the work table
 * fits a tablet's column, the run table a desktop's.
 */
.status-table {
  min-width: 40rem;
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

.time-stack time,
.row-details .facts time {
  color: var(--text-secondary);
  font: var(--type-code);
  white-space: nowrap;
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

.row-details[open] {
  min-width: 18rem;
  max-width: 30rem;
}

.row-details__panel {
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

.row-details .facts > dt,
.row-details .facts > dd {
  padding-block: 8px;
}

.row-details .facts code {
  white-space: normal;
  overflow-wrap: anywhere;
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
    gap: 14px;
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

/* Wide screens: the four checks in one row, the six counts in one row, labels beside times. */
@media (min-width: 72rem) {
  .process-health__checks {
    grid-template-columns: repeat(4, minmax(0, 1fr));
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
