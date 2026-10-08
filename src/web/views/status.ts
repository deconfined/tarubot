/**
 * Read-only background work for officers: filtered process health, a limited server-work sample
 * and actual recent refresh runs. Pure typed data in, safely escaped markup out.
 *
 * Built from the design system's dashboard parts (styles/status.ts): process health is the page's
 * one featured card, laid out like the design's bot status card; the sample counts are a row of
 * stats; work and runs are tables in their own scroll regions, like the design's log table, with
 * each row's facts and diagnostic in a native disclosure. The view has no controls: changes and
 * retries happen in Discord. The test-pinned hooks stay beside the design's classes (D12):
 * .featured, the bracketed .check tokens, the .marker badges, .metrics dd, #work-sample and
 * .diagnostic.
 */
import type { ApplicationLifecycle } from "../../application/lifecycle.js";
import type { EffectsMode, SyncRunRow, SyncStatusView } from "../../application/results.js";
import { shortId } from "../../discord/presenters/format.js";
import { jobLabel, jobMarker } from "../../discord/presenters/jobs.js";
import { CHECK, type Check, MARKER } from "../../discord/presenters/style.js";
import { RUN_LABEL, runState, runType } from "../../discord/presenters/synchronization.js";
import { html, type SafeHtml, untrusted } from "../html.js";
import { EMPTY_NAMES, mentionText, type WebNames, userName } from "../mentions.js";
import { time } from "../time.js";

/** The process booleans Status shows, with the Lodestone gate as a word. */
export interface ProcessStatus {
  readonly ready: boolean;
  readonly discord: boolean;
  readonly database: boolean;
  /** "cooling_down" while a Lodestone 429 cooldown runs, "available" otherwise. */
  readonly lodestone: "available" | "cooling_down";
}

/** The Status view model. */
export interface StatusView {
  readonly process: ProcessStatus;
  /** app.syncStatus(actor, null) for this server. */
  readonly sync: SyncStatusView;
  readonly names?: WebNames;
}

/**
 * Keep only the booleans of lifecycle.status(); everything else in it is global or diagnostic
 * (Lodestone queue depths and strikes, selector revisions, capability results, the visibility
 * monitor's counts across every server), and none of it may reach one server's officers.
 */
export function processStatus(
  status: Pick<
    ReturnType<ApplicationLifecycle["status"]>,
    "ready" | "discord" | "database" | "lodestone"
  >,
): ProcessStatus {
  return {
    ready: status.ready === true,
    discord: status.discord === true,
    database: status.database === true,
    lodestone: status.lodestone.cooldownSeconds > 0 ? "cooling_down" : "available",
  };
}

/** One health line: a health-check word (the /config validate vocabulary) and its sentence. */
interface HealthLine {
  readonly check: Check;
  readonly text: string;
}

/** Whether Discord changes run now, from this server's effects mode. */
const EFFECTS: Readonly<Record<EffectsMode, HealthLine>> = {
  live: { check: "ok", text: "Discord changes are live" },
  awaiting_activation: {
    check: "wait",
    text: "Discord changes are paused until this server is activated",
  },
  deployment_disabled: { check: "off", text: "Discord changes are off for this deployment" },
};

/** The health checklist, in the order officers read it; the first line sums up the rest. */
function healthLines(process: ProcessStatus, mode: EffectsMode): HealthLine[] {
  return [
    process.ready
      ? { check: "ok", text: "Ready" }
      : {
          check: "fail",
          text: "Not ready: TaruBot is starting, stopping or can't reach a service",
        },
    process.discord
      ? { check: "ok", text: "Connected to Discord" }
      : { check: "fail", text: "Not connected to Discord" },
    process.database
      ? { check: "ok", text: "Database reachable" }
      : { check: "fail", text: "Database unreachable" },
    process.lodestone === "available"
      ? { check: "ok", text: "Lodestone available" }
      : { check: "wait", text: "Lodestone cooling down after too many requests" },
    EFFECTS[mode],
  ];
}

/**
 * Process health, the page's one featured (holographic) card. Every line keeps its bracketed
 * token, so the words, not the colors, carry the state. The first line, readiness, is the card's
 * headline; the scale under the lines is decoration.
 */
function processHealth(process: ProcessStatus, mode: EffectsMode): SafeHtml {
  return html`<section class="orr-card orr-card--holo orr-holo-edge featured process-health" aria-labelledby="process-health">
<div class="orr-card__head"><div class="orr-card__titles"><p class="orr-label">TaruBot</p><h2 class="orr-card__title" id="process-health">Process health</h2></div></div>
<div class="orr-card__body">
<ul class="checklist process-health__checks">${healthLines(process, mode).map(
    (line, index) =>
      html`<li class="check-row${index === 0 ? " process-health__summary" : ""}"><span class="check check-${line.check}">${CHECK[line.check]}</span><span class="check-copy">${line.text}</span></li>`,
  )}</ul>
<div class="orr-scale" aria-hidden="true"></div>
</div>
</section>`;
}

/** A `<time>` element; the text names UTC, so no reader takes it for local time. */
const at = (instant: Date): SafeHtml => {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
};

/**
 * One labelled moment in a row's time column, such as "Added <time>". The space keeps the label
 * and the time apart for screen readers, which read the pair as one phrase.
 */
const moment = (label: string, instant: Date): SafeHtml =>
  html`<span class="moment"><span class="orr-label">${label}</span> ${at(instant)}</span>`;

/** Counts with thousands separators, as the Discord presenters group them. */
const grouping = new Intl.NumberFormat("en-US");
const grouped = (value: number): string => grouping.format(value);

/** Full stored diagnostics are officer-only text, resolved without exposing hidden channel names. */
function diagnostic(text: string | null, names: WebNames): SafeHtml {
  return text === null
    ? html`<p class="note">No diagnostic recorded.</p>`
    : html`<p class="diagnostic">${mentionText(text, names)}</p>`;
}

/** The note a failed decision DM gets: the DM failed, the decision it carried did not. */
const DM_BLOCKED = html`<p class="note">The recipient's DMs are closed; the decision still stands.</p>`;

/**
 * A row's disclosure: its facts, any notes, then the stored diagnostic, opened in place without
 * script. The summary names the short ID, so each one is distinct for assistive technology.
 */
const rowDetails = (summary: string, id: string, body: SafeHtml): SafeHtml =>
  html`<details class="row-details"><summary>${summary} <code>${untrusted(shortId(id))}</code></summary>
<div class="row-details__panel">${body}</div>
</details>`;

/** A run's aggregate outcome is distinct from the acquisition job's outcome. */
function runRow(run: SyncRunRow, mode: EffectsMode, names: WebNames): SafeHtml {
  const acquisition =
    run.acquisition_status === null
      ? null
      : jobMarker({
          status: run.acquisition_status,
          last_error: run.last_error,
          result: run.result,
        });
  // The outcome's dot only repeats its words; the state class picks the dot's tone.
  const state = runState(run, mode);
  return html`<tr>
<th scope="row"><span class="cell-title">${runType(run)}</span><span class="cell-meta">Run <code>${untrusted(shortId(run.id))}</code></span></th>
<td><span class="run-outcome run-outcome--${state}">${RUN_LABEL[state]}</span></td>
<td><span class="run-progress">${grouped(run.work_completed)}/${grouped(run.work_total)} done</span>${
    run.work_blocked > 0
      ? html`<span class="cell-meta">${grouped(run.work_blocked)} ${mode === "live" ? "blocked" : "held"}</span>`
      : ""
  }${run.work_failed > 0 ? html`<span class="cell-meta">${grouped(run.work_failed)} failed</span>` : ""}</td>
<td><div class="time-stack">${moment("Started", run.created_at)}${
    run.completed_at === null ? "" : moment("Completed", run.completed_at)
  }</div></td>
<td>${
    acquisition === null
      ? html`<span class="cell-meta">No acquisition job recorded.</span>`
      : html`<span class="marker marker-${acquisition.marker}">${MARKER[acquisition.marker]}</span>`
  }
${rowDetails(
  "Run details",
  run.id,
  html`<dl class="facts">
<dt>Run ID</dt><dd><code>${untrusted(run.id)}</code></dd>
<dt>Requester</dt><dd>${run.requester_id === null ? "Not recorded" : userName(run.requester_id, names)}</dd>
<dt>Stored run status</dt><dd><code>${run.status}</code></dd>
<dt>Acquisition kind</dt><dd>${run.acquisition_kind === null ? "Not recorded" : html`<code>${untrusted(run.acquisition_kind)}</code>`}</dd>
<dt>Acquisition status</dt><dd>${run.acquisition_status === null ? "Not recorded" : html`<code>${untrusted(run.acquisition_status)}</code>`}</dd>
${run.enumeration_completed_at === null ? "" : html`<dt>Enumeration finished</dt><dd>${at(run.enumeration_completed_at)}</dd>`}
</dl>
${acquisition?.dmBlocked ? DM_BLOCKED : ""}
${acquisition?.skipped === undefined ? "" : html`<p class="diagnostic">Skipped: ${mentionText(acquisition.skipped, names)}</p>`}
${diagnostic(run.last_error, names)}`,
)}</td>
</tr>`;
}

/** A sampled job, with facts only for timestamps the service actually supplies. */
function workRow(job: SyncStatusView["work"][number], names: WebNames): SafeHtml {
  const state = jobMarker(job);
  return html`<tr>
<th scope="row"><span class="cell-title">${untrusted(jobLabel(job.kind))}</span><span class="cell-meta"><code>${untrusted(job.kind)}</code></span><span class="cell-meta">Job <code>${untrusted(shortId(job.id))}</code></span></th>
<td><span class="marker marker-${state.marker}">${MARKER[state.marker]}</span><span class="cell-meta">Attempts: ${grouped(job.attempts)}</span></td>
<td><div class="time-stack">${
    state.marker === "queued" || state.marker === "waiting"
      ? moment(state.wait === "retrying" ? "Retry" : "Next", job.due_at)
      : ""
  }${moment("Added", job.created_at)}${
    job.completed_at === null
      ? ""
      : moment(state.marker === "failed" ? "Stopped" : "Completed", job.completed_at)
  }</div></td>
<td>${rowDetails(
    "Job details",
    job.id,
    html`<dl class="facts">
<dt>Job ID</dt><dd><code>${untrusted(job.id)}</code></dd>
<dt>User</dt><dd>${job.user_id === null ? "No user attached" : userName(job.user_id, names)}</dd>
<dt>Stored status</dt><dd><code>${untrusted(job.status)}</code></dd>
</dl>
${state.dmBlocked ? DM_BLOCKED : ""}
${state.skipped === undefined ? "" : html`<p class="diagnostic">Skipped: ${mentionText(state.skipped, names)}</p>`}
${diagnostic(job.last_error, names)}`,
  )}</td>
</tr>`;
}

/**
 * Counts are only of displayed jobs, split by the same markers the table uses: one stat per
 * marker, each a dl group (the badge as dt, the count as dd). A zero count is drawn quieter, so
 * the markers that have work stand out; the number still says so.
 */
function sampleMetrics(work: SyncStatusView["work"]): SafeHtml {
  const counts = { blocked: 0, running: 0, queued: 0, waiting: 0, paused: 0, failed: 0 };
  for (const job of work) {
    const { marker } = jobMarker(job);
    if (marker in counts) counts[marker as keyof typeof counts] += 1;
  }
  return html`<dl class="metrics">${Object.entries(counts).map(
    ([marker, count]) =>
      html`<div class="orr-card orr-stat${count === 0 ? " metric-none" : ""}"><dt class="orr-stat__label"><span class="marker marker-${marker}">${MARKER[marker as keyof typeof counts]}</span></dt><dd class="orr-stat__value">${grouped(count)}</dd></div>`,
  )}</dl>`;
}

/**
 * A table in its own labelled scroll region, a glass card: a phone scrolls the table sideways
 * inside it rather than the page. The caption names the table for assistive technology and is
 * hidden on screen, where the section heading already names it.
 */
const dataTable = (
  name: "work" | "run",
  caption: string,
  columns: readonly string[],
  rows: readonly SafeHtml[],
): SafeHtml =>
  html`<div class="orr-card table-scroll" tabindex="0" role="region" aria-labelledby="${name}-caption"><table class="orr-table status-table" aria-describedby="${name}-sample">
<caption id="${name}-caption" class="visually-hidden">${caption}</caption>
<thead><tr>${columns.map((column) => html`<th scope="col">${column}</th>`)}</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;

/** The Status route stays stable; Background work is its read-only officer dashboard. */
export function renderStatus(view: StatusView): SafeHtml {
  const { runs, work, effectsMode } = view.sync;
  const names = view.names ?? EMPTY_NAMES;
  return html`<p class="lead">Track this server's refresh runs and outstanding work.</p>
<p class="notice">Read-only. All times are UTC. Manage changes and retries in Discord.</p>
${processHealth(view.process, effectsMode)}
<section class="status-section" aria-labelledby="displayed-work">
<div class="section-heading"><h2 id="displayed-work">Outstanding work</h2><p class="section-description">${grouped(work.length)} displayed</p></div>
<p class="section-description" id="work-sample">Limited sample: up to 25 latest outstanding jobs for this server. Counts cover displayed jobs only, not server-wide or global totals. Successful-job history is not shown.</p>
${sampleMetrics(work)}
${
  work.length === 0
    ? html`<p class="empty-state">No outstanding work in this limited sample.</p>`
    : dataTable(
        "work",
        "Displayed outstanding jobs — limited sample",
        ["Work", "Status", "When (UTC)", "Details and diagnostic"],
        work.map((job) => workRow(job, names)),
      )
}
</section>
<section class="status-section" aria-labelledby="recent-runs">
<div class="section-heading"><h2 id="recent-runs">Recent refresh runs</h2><p class="section-description">${grouped(runs.length)} displayed</p></div>
<p class="section-description" id="run-sample">Up to 10 recent runs for this server. Progress and aggregate outcome belong to the run; acquisition has its own status.</p>
${
  runs.length === 0
    ? html`<p class="empty-state">No recent refresh runs to display.</p>`
    : dataTable(
        "run",
        "Recent refresh runs and acquisition outcomes",
        ["Refresh run", "Aggregate outcome", "Progress", "When (UTC)", "Acquisition and details"],
        runs.map((run) => runRow(run, effectsMode, names)),
      )
}
</section>`;
}
