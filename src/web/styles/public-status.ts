/**
 * The public status page's own rules (views/public-status.ts), an entry page on the starfield:
 * - the page's blocks widen to the entry column, dense: from 64rem the overall card and a 2×2 grid
 *   of components share a row (one third and two thirds), with the history across under them;
 *   narrower, they stack, the components two across while two tiles of 10rem fit and one above
 *   the other otherwise, so large text never splits a word or widens the page;
 * - the overall card's word and dot take its state's color (success, warning or danger); the word
 *   carries the meaning, so the color only repeats it;
 * - the history's 90 bars are a CSS grid of plain spans, one class per band and no style
 *   attribute; below 40rem only the last 30 show (the table below them still covers all 90 days),
 *   and the axis label changes with them. Each band has a height as well as a color (whole days
 *   full, then about 80%, 55% and 30%; no data an empty outline), and the legend's swatches match,
 *   so the bars read without telling colors apart: red-green color blindness, or forced colors,
 *   where the bars take the text color and no data the background with a border.
 */
export const PUBLIC_STATUS_CSS = `/* Public status */
.status-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  justify-self: stretch;
  width: 100%;
  min-width: 0;
}

/* The overall card: a label, the word with its dot, a sentence and three facts. */
.status-overall {
  --card-pad: var(--space-5);
  display: grid;
  align-content: start;
  gap: var(--space-2);
  padding: var(--card-pad);
}

.status-overall__word {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font: var(--type-h2);
  font-synthesis: none;
  letter-spacing: var(--tracking-display);
}

.status-dot {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 12px currentColor;
}

.status-overall--operational .status-overall__word {
  color: var(--success);
}

.status-overall--degraded .status-overall__word {
  color: var(--warning);
}

.status-overall--down .status-overall__word {
  color: var(--danger);
}

.status-overall__text {
  color: var(--text-secondary);
}

.status-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
  margin: var(--space-2) 0 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.status-facts > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.status-facts dd {
  margin: 0;
  color: var(--text-primary);
  font: var(--type-readout);
  font-variant-numeric: tabular-nums;
}

/*
 * The components, a tile each: two across, or one above the other where two tiles of 10rem don't
 * fit (a narrow phone, or large text). Never more than two, so the four stay a 2×2 grid.
 */
.status-components__grid {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(max(min(100%, 10rem), calc((100% - var(--space-3)) / 2)), 1fr)
  );
  gap: var(--space-3);
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.status-component {
  display: grid;
  align-content: start;
  gap: var(--space-2);
  padding: var(--space-4);
}

.status-component__name {
  color: var(--text-primary);
  font: var(--type-subtitle);
  letter-spacing: var(--tracking-ui);
}

.status-component__state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px var(--space-2);
}

.status-component__text {
  color: var(--text-secondary);
  font: var(--type-caption);
}

.status-component__about {
  margin-top: auto;
  color: var(--text-muted);
  font: var(--type-caption);
}

/*
 * The history: heading and summary on one line where they fit, then the bars. One column that may
 * shrink below its content, so the open table scrolls in its own region instead of widening the
 * card and the page.
 */
.uptime {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-5);
}

.uptime__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-4);
}

.uptime__title {
  color: var(--text-primary);
  font: var(--type-title);
}

.uptime__summary {
  color: var(--text-secondary);
  font: var(--type-ui-sm);
}

/* One row the bars stand in, bottoms aligned, so their heights compare like a chart's. */
.uptime-bars {
  display: grid;
  grid-template-columns: repeat(30, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  align-items: end;
  gap: 3px;
  height: 36px;
}

.uptime-bar {
  min-width: 0;
  height: calc(var(--band-height, 1) * 100%);
  border-radius: 2px;
  background: var(--surface-3);
}

/* Phones show the last 30 days; the first 60 bars wait for a wider screen. */
.uptime-bar:nth-child(-n + 60) {
  display: none;
}

/* A band's height, a share of the row (or of a legend swatch's 12px), then its color. */
.uptime-bar--full {
  --band-height: 1;
  background: var(--success);
}

.uptime-bar--high {
  --band-height: 0.8;
  background: color-mix(in oklch, var(--success) 45%, var(--warning));
}

.uptime-bar--mid {
  --band-height: 0.55;
  background: var(--warning);
}

.uptime-bar--low {
  --band-height: 0.3;
  background: var(--danger);
}

.uptime-bar--none {
  --band-height: 1;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.uptime-axis {
  display: flex;
  justify-content: space-between;
  color: var(--text-muted);
  font: var(--type-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
}

.uptime-axis__far {
  display: none;
}

.uptime-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin: 0;
  padding: 0;
  color: var(--text-muted);
  font: var(--type-caption);
  list-style: none;
}

/* Swatches stand on the text's baseline, each its band's share of 12px tall, like the bars. */
.uptime-legend > li {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.uptime-swatch {
  display: inline-block;
  flex-shrink: 0;
  width: 8px;
  height: calc(var(--band-height, 1) * 12px);
  border-radius: 2px;
}

.uptime__method {
  font: var(--type-caption);
}

.uptime-days {
  min-width: 0;
}

.uptime-days > .table-scroll {
  margin-top: var(--space-2);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

.uptime-table {
  min-width: 20rem;
}

/* Short figures that never wrap: a narrow phone scrolls the region rather than split "98.86%". */
.uptime-table thead th,
.uptime-table td,
.uptime-table tbody th {
  padding: 8px 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.uptime-table tr > :first-child {
  padding-left: 14px;
}

@media (min-width: 40rem) {
  .uptime-table thead th,
  .uptime-table td,
  .uptime-table tbody th {
    padding-inline: 16px;
  }
  .uptime-bars {
    grid-template-columns: repeat(90, minmax(0, 1fr));
    gap: 2px;
  }
  .uptime-bar:nth-child(-n + 60) {
    display: block;
  }
  .uptime-axis__far {
    display: inline;
  }
  .uptime-axis__near {
    display: none;
  }
}

@media (min-width: 64rem) {
  .status-page {
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: var(--space-5);
  }
  .status-page > .uptime {
    grid-column: 1 / -1;
  }
}

/*
 * Forced colors replace the bands' colors, so the heights carry them: every bar and swatch takes
 * the text color, and a day with no data the background, with a border where its inset frame was.
 */
@media (forced-colors: active) {
  .uptime-bar,
  .uptime-swatch {
    background-color: CanvasText;
  }
  .uptime-bar--none {
    background-color: Canvas;
    border: 1px solid CanvasText;
  }
}

@media print {
  .uptime-bar,
  .uptime-swatch {
    border: 1px solid #888;
  }
}
`;
