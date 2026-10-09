/**
 * The public status page's content (2.41.0, owner decisions of 2026-10-09), from the snapshot
 * PublicStatus keeps in memory (src/application/public-status.ts). Pure: typed data in, escaped
 * markup out, with the application imported as types only. Anyone may read it, so it shows only
 * process-wide state: never a server, a member or a count of either.
 *
 * Three blocks, styled by styles/public-status.ts: the overall status (the page's one holographic
 * card) beside the four components, then the history. The history is 90 daily bars drawn by CSS
 * alone, a class per band and no style attribute, under one summary sentence that gives the
 * figures: the bars are one image with a short name, each band has its own height as well as its
 * color (so the bars read without color), a legend names the bands, and a disclosure lists every
 * day below 100% in a table. Phones show the last 30 bars; the table always covers all 90 days.
 */
import type { StatusSnapshot } from "../../application/public-status.js";
import { CHECK, type Check } from "../../discord/presenters/style.js";
import {
  type ChangesState,
  downtimeText,
  HISTORY_DAYS,
  type LodestoneState,
  type OverallStatus,
  type UptimeBand,
  type UptimeDay,
  type UptimeHistory,
  type UptimeSummary,
  uptimeBand,
  uptimePercent,
  uptimeSummary,
} from "../../domain/uptime.js";
import { html, type SafeHtml } from "../html.js";
import { time } from "../time.js";

/** The page's title and its one `<h1>`. */
export const STATUS_TITLE = "Status";

/** The headline per overall status: a word, and what it means for someone using TaruBot. */
const OVERALL: Readonly<Record<OverallStatus, { readonly word: string; readonly text: string }>> = {
  operational: { word: "Operational", text: "TaruBot is working normally." },
  degraded: {
    word: "Degraded",
    text: "TaruBot is running, but some of its work is waiting.",
  },
  down: {
    word: "Down",
    text: "TaruBot can't do its work right now. It may be starting, stopping or reconnecting.",
  },
};

/** One component tile: its name, what it is for, its health-check token and a short sentence. */
interface ComponentLine {
  readonly name: string;
  readonly about: string;
  readonly check: Check;
  readonly text: string;
}

const LODESTONE: Readonly<Record<LodestoneState, Pick<ComponentLine, "check" | "text">>> = {
  available: { check: "ok", text: "Answering" },
  cooling_down: { check: "wait", text: "Cooling down after too many requests" },
  unreachable: { check: "fail", text: "No answer to the latest request" },
};

/**
 * Paused is a setting, not a fault (the deployment's ENABLE_EFFECTS, off by default, or a server
 * awaiting activation), so it reads neutrally and leaves the headline alone (overallStatus).
 */
const CHANGES: Readonly<Record<ChangesState, Pick<ComponentLine, "check" | "text">>> = {
  live: { check: "ok", text: "Live" },
  paused: { check: "wait", text: "Paused by a setting" },
};

/** The four components in reading order. */
function components(snapshot: StatusSnapshot): ComponentLine[] {
  const { discord, database, lodestone, changes } = snapshot.components;
  return [
    {
      name: "Discord connection",
      about: "How TaruBot hears commands and member changes.",
      ...(discord ? { check: "ok", text: "Connected" } : { check: "fail", text: "Not connected" }),
    },
    {
      name: "Database",
      about: "Where TaruBot keeps settings, character links and waiting work.",
      ...(database ? { check: "ok", text: "Reachable" } : { check: "fail", text: "Unreachable" }),
    },
    {
      name: "Lodestone",
      about: "Where TaruBot checks characters and the FC roster.",
      ...LODESTONE[lodestone],
    },
    {
      name: "Discord changes",
      about: "The role and nickname changes TaruBot makes in Discord.",
      ...CHANGES[changes],
    },
  ];
}

/** A `<time>` element in UTC, saying so. */
const at = (instant: Date): SafeHtml => {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
};

/** The legend's words per band, in the bars' order of severity. */
const BANDS: readonly { readonly band: UptimeBand; readonly label: string }[] = [
  { band: "full", label: "100%" },
  { band: "high", label: "99% or more" },
  { band: "mid", label: "95% or more" },
  { band: "low", label: "Below 95%" },
  { band: "none", label: "No data" },
];

/** A day's uptime in words, for a bar's tooltip and the table. */
const dayUptime = (day: UptimeDay): string => uptimePercent(day.ready, day.expected) ?? "No data";

/**
 * The span the uptime figures cover, the same in the summary and on the overall card: the last 90
 * days once every one of them has data, otherwise since the first day that has.
 */
function uptimeSpan(summary: UptimeSummary): { readonly words: string; readonly label: string } {
  return summary.daysWithData >= HISTORY_DAYS || summary.since === null
    ? { words: `over the last ${HISTORY_DAYS} days`, label: `Uptime, ${HISTORY_DAYS} days` }
    : { words: `since ${summary.since} (UTC)`, label: `Uptime since ${summary.since}` };
}

/**
 * The summary sentence: the uptime over the days with data (all 90, or since the first sample)
 * and how many of them were below 100%.
 */
function summaryText(history: UptimeHistory): string {
  const summary = uptimeSummary(history);
  const percent = uptimePercent(summary.ready, summary.expected);
  if (percent === null || summary.since === null) return "No uptime recorded yet.";
  const span = uptimeSpan(summary).words;
  const below =
    summary.daysDown === 0
      ? "Every day was at 100%."
      : `${summary.daysDown} ${summary.daysDown === 1 ? "day" : "days"} below 100%.`;
  return `Uptime ${span}: ${percent}. ${below}`;
}

/**
 * The overall card: the headline word, its sentence, and the version, update time and uptime. The
 * section's name is "Right now" and the word ("Right now Operational"), so a screen reader's
 * landmark list says the state too.
 */
function overallCard(snapshot: StatusSnapshot): SafeHtml {
  const overall = OVERALL[snapshot.overall];
  const summary = snapshot.history ? uptimeSummary(snapshot.history) : null;
  const uptime = summary ? uptimePercent(summary.ready, summary.expected) : null;
  return html`<section class="orr-card orr-card--holo orr-holo-edge status-overall status-overall--${snapshot.overall}" aria-labelledby="status-now status-overall">
<p class="orr-label" id="status-now">Right now</p>
<h2 class="status-overall__word" id="status-overall"><span class="status-dot" aria-hidden="true"></span>${overall.word}</h2>
<p class="status-overall__text">${overall.text}</p>
<dl class="status-facts">
<div><dt class="orr-label">Updated</dt><dd>${at(snapshot.takenAt)}</dd></div>
<div><dt class="orr-label">Version</dt><dd>${snapshot.version}</dd></div>
${summary === null || uptime === null ? "" : html`<div><dt class="orr-label">${uptimeSpan(summary).label}</dt><dd>${uptime}</dd></div>`}
</dl>
</section>`;
}

/** The components, a tile each: name, token and sentence. The words carry the state. */
function componentGrid(snapshot: StatusSnapshot): SafeHtml {
  return html`<section class="status-components" aria-labelledby="status-components">
<h2 class="visually-hidden" id="status-components">Components</h2>
<ul class="status-components__grid">${components(snapshot).map(
    (line) =>
      html`<li class="orr-card status-component"><h3 class="status-component__name">${line.name}</h3><p class="status-component__state"><span class="check check-${line.check}">${CHECK[line.check]}</span><span class="status-component__text">${line.text}</span></p><p class="status-component__about">${line.about}</p></li>`,
  )}</ul>
</section>`;
}

/**
 * The bars' accessible name. The summary just above already gives the figures, so the name only
 * says what the image is and where the days below 100% are listed in words.
 */
const barsLabel = (below: number): string =>
  below === 0
    ? "Daily uptime bars, oldest first."
    : "Daily uptime bars, oldest first; the table below lists days under 100%.";

/** One bar: its band's class and, for a pointer, the day and its uptime. */
const bar = (day: UptimeDay): SafeHtml =>
  html`<span class="uptime-bar uptime-bar--${uptimeBand(day)}" title="${day.day}: ${dayUptime(day)}"></span>`;

/** One row of the table of days below 100%, newest first. */
const dayRow = (day: UptimeDay): SafeHtml =>
  html`<tr><th scope="row"><time datetime="${day.day}">${day.day}</time></th><td>${dayUptime(day)}</td><td>${downtimeText(day.expected - day.ready)}</td><td>${day.versions.length === 0 ? "None" : day.versions.join(", ")}</td></tr>`;

/** The history card: summary, bars, axis, legend and the table of days below 100%. */
function historyCard(history: UptimeHistory | null): SafeHtml {
  if (history === null)
    return html`<section class="orr-card uptime" aria-labelledby="uptime-heading">
<h2 class="uptime__title" id="uptime-heading">Last ${HISTORY_DAYS} days</h2>
<p class="note">The history appears once TaruBot has recorded its first check, within five minutes of starting.</p>
</section>`;
  const summary = summaryText(history);
  const below = history.days.filter((day) => day.expected > 0 && day.ready < day.expected);
  return html`<section class="orr-card uptime" aria-labelledby="uptime-heading">
<div class="uptime__head">
<h2 class="uptime__title" id="uptime-heading">Last ${HISTORY_DAYS} days</h2>
<p class="uptime__summary">${summary}</p>
</div>
<div class="uptime-bars" role="img" aria-label="${barsLabel(below.length)}">${history.days.map(bar)}</div>
<div class="uptime-axis" aria-hidden="true"><span class="uptime-axis__far">${HISTORY_DAYS} days ago</span><span class="uptime-axis__near">30 days ago</span><span>Today</span></div>
<ul class="uptime-legend">${BANDS.map(
    ({ band, label }) =>
      html`<li><span class="uptime-swatch uptime-bar--${band}" aria-hidden="true"></span>${label}</li>`,
  )}</ul>
<p class="note uptime__method">TaruBot checks itself every five minutes; a check missed while it wasn't running counts as down. Days are UTC, up to ${at(history.asOf)}.</p>
${
  below.length === 0
    ? ""
    : html`<details class="uptime-days"><summary>Days below 100% (${below.length})</summary>
<div class="table-scroll" tabindex="0" role="region" aria-labelledby="uptime-days-caption"><table class="orr-table uptime-table">
<caption id="uptime-days-caption" class="visually-hidden">Days below 100% uptime, newest first</caption>
<thead><tr><th scope="col">Day (UTC)</th><th scope="col">Uptime</th><th scope="col">Down</th><th scope="col">Versions</th></tr></thead>
<tbody>${[...below].reverse().map(dayRow)}</tbody>
</table></div>
</details>`
}
</section>`;
}

/** The /status page's main content. */
export function renderPublicStatus(snapshot: StatusSnapshot): SafeHtml {
  return html`<p class="lead">Whether TaruBot is working right now, and how it did over the last ${HISTORY_DAYS} days. All times are UTC.</p>
<div class="status-page">
${overallCard(snapshot)}
${componentGrid(snapshot)}
${historyCard(snapshot.history)}
</div>`;
}
