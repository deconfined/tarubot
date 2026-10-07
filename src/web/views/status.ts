/**
 * Read-only background work for officers: filtered process health, a limited server-work sample
 * and actual recent refresh runs. Pure typed data in, safely escaped markup out.
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

/** The health checklist, in the order officers read it. */
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

/** A `<time>` element; the text names UTC, so no reader takes it for local time. */
const at = (instant: Date): SafeHtml => {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
};

/** Counts with thousands separators, as the Discord presenters group them. */
const grouping = new Intl.NumberFormat("en-US");
const grouped = (value: number): string => grouping.format(value);

/** Full stored diagnostics are officer-only text, resolved without exposing hidden channel names. */
function diagnostic(text: string | null, names: WebNames): SafeHtml {
  return text === null
    ? html`<p class="note">No diagnostic recorded.</p>`
    : html`<p class="diagnostic">${mentionText(text, names)}</p>`;
}

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
  return html`<tr>
<th scope="row"><code>${untrusted(shortId(run.id))}</code></th>
<td>${runType(run)}</td>
<td>${RUN_LABEL[runState(run, mode)]}</td>
<td>${grouped(run.work_completed)}/${grouped(run.work_total)} done${
    run.work_blocked > 0
      ? html` · ${grouped(run.work_blocked)} ${mode === "live" ? "blocked" : "held"}`
      : ""
  }${run.work_failed > 0 ? html` · ${grouped(run.work_failed)} failed` : ""}</td>
<td>Started ${at(run.created_at)}${
    run.completed_at === null ? "" : html`<br>Completed ${at(run.completed_at)}`
  }</td>
<td>${
    acquisition === null
      ? html`<span class="note">No acquisition job recorded.</span>`
      : html`<span class="marker marker-${acquisition.marker}">${MARKER[acquisition.marker]}</span>`
  }
<details class="job-details"><summary>Run details ${untrusted(shortId(run.id))}</summary>
<dl class="facts">
<dt>Run ID</dt><dd><code>${untrusted(run.id)}</code></dd>
<dt>Requester</dt><dd>${run.requester_id === null ? "Not recorded" : userName(run.requester_id, names)}</dd>
<dt>Stored run status</dt><dd><code>${run.status}</code></dd>
<dt>Acquisition kind</dt><dd>${run.acquisition_kind === null ? "Not recorded" : html`<code>${untrusted(run.acquisition_kind)}</code>`}</dd>
<dt>Acquisition status</dt><dd>${run.acquisition_status === null ? "Not recorded" : html`<code>${untrusted(run.acquisition_status)}</code>`}</dd>
${run.enumeration_completed_at === null ? "" : html`<dt>Enumeration finished</dt><dd>${at(run.enumeration_completed_at)}</dd>`}
</dl>
${acquisition?.dmBlocked ? html`<p class="note">The recipient's DMs are closed; the decision still stands.</p>` : ""}
${acquisition?.skipped === undefined ? "" : html`<p class="diagnostic">Skipped: ${mentionText(acquisition.skipped, names)}</p>`}
${diagnostic(run.last_error, names)}
</details></td>
</tr>`;
}

/** A sampled job, with facts only for timestamps the service actually supplies. */
function workRow(job: SyncStatusView["work"][number], names: WebNames): SafeHtml {
  const state = jobMarker(job);
  return html`<tr>
<td><span class="marker marker-${state.marker}">${MARKER[state.marker]}</span>${
    state.dmBlocked
      ? html`<p class="note">The recipient's DMs are closed; the decision still stands.</p>`
      : ""
  }</td>
<td>${untrusted(jobLabel(job.kind))}</td>
<td><code>${untrusted(job.kind)}</code></td>
<th scope="row"><code>${untrusted(shortId(job.id))}</code></th>
<td>${grouped(job.attempts)}</td>
<td>${
    state.marker === "queued" || state.marker === "waiting"
      ? html`${state.wait === "retrying" ? "Retry" : "Next"} ${at(job.due_at)}<br>`
      : ""
  }Added ${at(job.created_at)}${
    job.completed_at === null
      ? ""
      : html`<br>${state.marker === "failed" ? "Stopped" : "Completed"} ${at(job.completed_at)}`
  }</td>
<td><details class="job-details"><summary>Job details ${untrusted(shortId(job.id))}</summary>
<dl class="facts">
<dt>Job ID</dt><dd><code>${untrusted(job.id)}</code></dd>
<dt>User</dt><dd>${job.user_id === null ? "No user attached" : userName(job.user_id, names)}</dd>
<dt>Stored status</dt><dd><code>${untrusted(job.status)}</code></dd>
</dl>
${state.skipped === undefined ? "" : html`<p class="diagnostic">Skipped: ${mentionText(state.skipped, names)}</p>`}
${diagnostic(job.last_error, names)}
</details></td>
</tr>`;
}

/** Counts are only of displayed jobs, split by the same markers the table uses. */
function sampleMetrics(work: SyncStatusView["work"]): SafeHtml {
  const counts = { blocked: 0, running: 0, queued: 0, waiting: 0, paused: 0, failed: 0 };
  for (const job of work) {
    const { marker } = jobMarker(job);
    if (marker in counts) counts[marker as keyof typeof counts] += 1;
  }
  return html`<dl class="metrics">${Object.entries(counts).map(
    ([marker, count]) =>
      html`<div><dt><span class="marker marker-${marker}">${MARKER[marker as keyof typeof counts]}</span></dt><dd>${grouped(count)}</dd></div>`,
  )}</dl>`;
}

/** The Status route stays stable; Background work is its read-only officer dashboard. */
export function renderStatus(view: StatusView): SafeHtml {
  const { runs, work, effectsMode } = view.sync;
  const names = view.names ?? EMPTY_NAMES;
  return html`<div class="dashboard-intro">
<div>
<p class="lead">Recent refresh runs, outstanding work and what needs attention on this server.</p>
<p class="note">Read-only. Times are UTC; changes and retries are managed through Discord.</p>
</div>
<section class="panel featured" aria-labelledby="process-health">
<h2 id="process-health">Process health</h2>
<ul class="items">${healthLines(view.process, effectsMode).map(
    (line) =>
      html`<li><span class="check check-${line.check}">${CHECK[line.check]}</span> ${line.text}</li>`,
  )}</ul>
</section>
</div>
<section aria-labelledby="displayed-work">
<h2 id="displayed-work">Outstanding work</h2>
<p class="note" id="work-sample">Limited sample: ${grouped(work.length)} displayed jobs, up to 25 of the latest outstanding jobs for this server. Counts below describe only this sample, not server-wide or global totals. Succeeded-job history is not included.</p>
${sampleMetrics(work)}
${
  work.length === 0
    ? html`<p>No outstanding work in this limited sample.</p>`
    : html`<div class="table-scroll" tabindex="0" role="region" aria-labelledby="work-caption"><table class="data-table" aria-describedby="work-sample">
<caption id="work-caption">Displayed outstanding jobs — limited sample</caption>
<thead><tr><th scope="col">Status</th><th scope="col">Work</th><th scope="col">Kind</th><th scope="col">Job</th><th scope="col">Attempt</th><th scope="col">When (UTC)</th><th scope="col">Details and diagnostic</th></tr></thead>
<tbody>${work.map((job) => workRow(job, names))}</tbody>
</table></div>`
}
</section>
<section aria-labelledby="recent-runs">
<h2 id="recent-runs">Recent refresh runs</h2>
<p class="note">Up to 10 recent runs. Progress counts belong to each run; acquisition status is shown separately.</p>
${
  runs.length === 0
    ? html`<p>No recent refresh runs to display.</p>`
    : html`<div class="table-scroll" tabindex="0" role="region" aria-labelledby="run-caption"><table class="data-table">
<caption id="run-caption">Recent refresh runs and acquisition outcomes</caption>
<thead><tr><th scope="col">Run</th><th scope="col">Type</th><th scope="col">Run status</th><th scope="col">Progress</th><th scope="col">When (UTC)</th><th scope="col">Acquisition and details</th></tr></thead>
<tbody>${runs.map((run) => runRow(run, effectsMode, names))}</tbody>
</table></div>`
}
</section>`;
}
