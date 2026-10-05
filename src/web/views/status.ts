/**
 * The Status page body (#43, ADR D9): this process's health as words, and this server's queued,
 * running, blocked, paused and failed work plus recent /refresh runs. Each job shows its marker,
 * kind label and catalog code only; stored diagnostics carry Discord mentions and wait for #43's
 * mention renderer. Never global queue metrics or visibility counts. Pure: typed data in,
 * markup out; application types are imported as types only (tests/unit/web-boundary.test.ts).
 */
import type { ApplicationLifecycle } from "../../application/lifecycle.js";
import type {
  EffectsMode,
  JobView,
  SyncRunRow,
  SyncStatusView,
} from "../../application/results.js";
import { shortId } from "../../discord/presenters/format.js";
import { jobCode, jobLabel, jobMarker } from "../../discord/presenters/jobs.js";
import { CHECK, type Check, MARKER } from "../../discord/presenters/style.js";
import { RUN_LABEL, runState, runType } from "../../discord/presenters/synchronization.js";
import { html, type SafeHtml } from "../html.js";
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

/** A catalog code from a stored last_error, never the message after it. */
const codeOf = (lastError: string | null): SafeHtml | "" => {
  const code = jobCode(lastError);
  return code === null ? "" : html` · Code <code>${code}</code>`;
};

/**
 * One run: short ID (as /sync status shows it, so the two can be matched), start time, type, state
 * and progress, in the approved run wording (guests#43 and #44); the acquisition's code, not its
 * text.
 */
function runItem(run: SyncRunRow, mode: EffectsMode): SafeHtml {
  const paused = mode !== "live";
  const state = runState(run, mode);
  const blocked =
    run.work_blocked > 0
      ? html` · ${grouped(run.work_blocked)} ${paused ? "held" : "blocked"}`
      : "";
  const failed = run.work_failed > 0 ? html` · ${grouped(run.work_failed)} failed` : "";
  return html`<li><code>${shortId(run.id)}</code> · ${at(run.created_at)} · ${runType(run)} · ${RUN_LABEL[state]} · ${grouped(run.work_completed)}/${grouped(run.work_total)} done${blocked}${failed}${codeOf(run.last_error)}</li>`;
}

/**
 * One job: its marker word, kind label and short ID, then the facts its state needs (attempts,
 * when it runs next, when it was added) and its catalog code. The stored diagnostic after the
 * code is never shown here: it can hold Discord mentions and upstream text (#43's mention
 * renderer will render it).
 */
function workItem(job: JobView): SafeHtml {
  const state = jobMarker(job);
  const attempt = job.attempts > 0 ? html` · attempt ${grouped(job.attempts)}` : "";
  let facts: SafeHtml | "";
  switch (state.marker) {
    case "queued":
      facts = html` · next ${at(job.due_at)}`;
      break;
    case "waiting":
      facts = html`${attempt} · next ${at(job.due_at)}`;
      break;
    case "running":
    case "failed":
      facts = attempt;
      break;
    default:
      facts = html` · added ${at(job.created_at)}`;
  }
  const dm = state.dmBlocked ? html` · the recipient's DMs are closed` : "";
  return html`<li><span class="marker marker-${state.marker}">${MARKER[state.marker]}</span> ${jobLabel(job.kind)} <code>${shortId(job.id)}</code>${facts}${codeOf(job.last_error)}${dm}</li>`;
}

/**
 * The Status page's main content, in the Discord presenters' vocabulary (jobLabel, jobMarker,
 * jobCode, MARKER and the run wording), as text (the house status words, never color alone).
 */
export function renderStatus(view: StatusView): SafeHtml {
  const { runs, work, effectsMode } = view.sync;
  return html`<h2>Health</h2>
<ul class="items">${healthLines(view.process, effectsMode).map(
    (line) =>
      html`<li><span class="check check-${line.check}">${CHECK[line.check]}</span> ${line.text}</li>`,
  )}</ul>
<h2>Sync runs</h2>
${
  runs.length === 0
    ? html`<p>No sync runs yet.</p>`
    : html`<ul class="items">${runs.map((run) => runItem(run, effectsMode))}</ul>`
}
<h2>Outstanding work</h2>
${
  work.length === 0
    ? html`<p>Nothing is queued, running, blocked, paused or failed.</p>`
    : html`<ul class="items">${work.map(workItem)}</ul>`
}`;
}
