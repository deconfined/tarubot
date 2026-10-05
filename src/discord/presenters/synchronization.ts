/**
 * Synchronization presenters: the /refresh receipt and /sync status (a member's own view, the
 * officer server overview, one run's detail, and no matching run). They reproduce the approved
 * mockups guests#36, #43 and #44 (with the gen.py title override 'Sync status · server') and the
 * reply specs for the other states. Failures are never caught here: the router's failure presenter
 * renders them. Pure; the clock is injected for embed timestamps and start times.
 *
 * Job lines follow the approved errors-and-style#28 component: members read labels and plain
 * words, officers the raw kind, short ID, attempt and a quoted diagnostic, split across fields
 * when long (C7). Members never see job IDs or diagnostics; a run appears to them by its short ID,
 * and in full only where they must paste it (the /refresh Track progress line and Run footer).
 *
 * Tones follow the C4 table. Paused work is pending unless something is also blocked or failed.
 * The officer overview is pending while a run is in progress, a job is running, or anything is
 * queued or paused, even with a failed job (approved #44); it is warning only when the view is
 * focused on blocked or failed work, meaning such work exists and nothing is in progress (#45).
 */
import type {
  EffectsMode,
  JobView,
  RefreshResult,
  SyncRunRow,
  SyncStatusView,
} from "../../application/results.js";
import { isOfficer, type Viewer } from "./audience.js";
import { detailsButton } from "./controls.js";
import { code, count, duration, list, mentionUser, plain, shortId, when } from "./format.js";
import { effectsField, jobFields, jobLabel, jobLines, jobMarker, whenApplied } from "./jobs.js";
import { reply, type FieldSpec, type Presented, type ReplySpec } from "./reply.js";
import { HOUSE_LIMITS, marker, type Tone } from "./style.js";

/** Runs the service returns at most, and so the most a run list shows. */
const MAX_RUNS = 10;

/**
 * A run list under its heading, budgeted so the whole description stays within the house limit
 * of 1,000 characters (with '…and N more' if even ten short lines would not fit).
 */
function runList(heading: string, lines: readonly string[], lead: string | null = null): string {
  const head = lead ? `${lead}\n\n${heading}` : heading;
  return `${head}\n${list(lines, { max: MAX_RUNS, budget: HOUSE_LIMITS.description - head.length - 1 })}`;
}

/**
 * Every synchronization reply kind, with whether its embed carries a timestamp: the approved
 * card's `timestamp` value (only the officer overview, guests#44, has one), or the reply spec's
 * for states without a drawn card (C11). The reply catalog must cover every kind.
 */
const TIMESTAMP = {
  "refresh.cached": false,
  "refresh.acquisition": false,
  "refresh.officer": false,
  "refresh.forced": false,
  "refresh.paused": false,
  "status.member_empty": false,
  "status.member_done": false,
  "status.member_active": false,
  "status.member_paused": false,
  "status.member_attention": false,
  "status.officer": true,
  "status.officer_attention": true,
  "status.officer_paused": true,
  "run.detail": false,
  "run.missing": false,
} as const satisfies Record<string, boolean>;

/** A synchronization reply state; tests catalogue one case per kind. */
export type SyncReplyKind = keyof typeof TIMESTAMP;

/** Every synchronization reply kind, for catalog completeness checks. */
export const SYNC_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly SyncReplyKind[];

/** Options every synchronization presenter takes. */
export interface SyncReplyOptions {
  /** The current time for timestamps and start times; commands omit it, tests inject it. */
  readonly now?: Date | undefined;
}

/** Build a synchronization reply of `kind`, stamping it only when its approved card does. */
function card(
  kind: SyncReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: SyncReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/** Whether Discord changes are held, until activation or for the whole deployment. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

/** en-US grouping for exact counts shown without a noun ('38/40', '1,204/1,204'). */
const grouping = new Intl.NumberFormat("en-US");
const grouped = (value: number): string => grouping.format(value);

// ---------------------------------------------------------------------------------------------
// /refresh

/**
 * /refresh. A fresh cached roster re-checks roles from it (approved guests#36); a stale or unread
 * roster is fetched from the Lodestone first, starting after its cooldown; force:true (officers
 * only) bypasses freshness. Officers also see the mode with the roster interval, the exact
 * cooldown, the last roster as a full date and the force hint. Every variant is pending, since
 * the run has only been requested, and carries the full run ID where a member must paste it: the
 * Track progress line and the 'Run <uuid>' footer, as approved. While Discord changes are paused,
 * a Role changes field says so and the description says when roles change.
 */
export function refreshReply(
  result: RefreshResult,
  viewer: Viewer,
  options: SyncReplyOptions = {},
): Presented {
  const now = options.now ?? new Date();
  const officer = isOfficer(viewer);
  const mode = result.effectsMode;
  const track: FieldSpec = { name: "Track progress", value: `/sync status run_id:${result.runId}` };
  const startsAt = new Date(now.getTime() + result.cooldownSeconds * 1_000);
  const starts: FieldSpec = {
    name: "Starts",
    value:
      result.cooldownSeconds > 0
        ? officer
          ? `${when(startsAt, "R")} (cooldown ${duration(result.cooldownSeconds)})`
          : when(startsAt, "R")
        : "Now",
    inline: true,
  };
  const lastRoster: FieldSpec = {
    name: "Last roster",
    value: result.lastSuccessfulRosterAt
      ? when(result.lastSuccessfulRosterAt, officer ? "f" : "R")
      : "Never",
    inline: true,
  };
  const interval = duration(result.intervalSeconds);
  const held = paused(mode) ? effectsField(mode, "", viewer, "Role changes") : null;
  const heldSentence = paused(mode) ? ` Role changes are applied ${whenApplied(mode)}.` : "";
  let kind: SyncReplyKind;
  let description: string;
  let fields: (FieldSpec | null)[];
  if (result.forced) {
    kind = "refresh.forced";
    description =
      "Roster freshness was bypassed. TaruBot will read the FC roster from the Lodestone, then reconcile every member.";
    fields = [starts, lastRoster, held, track];
  } else if (result.cached) {
    kind = officer ? "refresh.officer" : "refresh.cached";
    description = "The FC roster is already fresh, so TaruBot is re-checking roles from it now.";
    fields = officer
      ? [
          {
            name: "Mode",
            value: `Cached roster (fresh within ${interval}): reconcile only`,
            inline: true,
          },
          lastRoster,
          held,
          track,
        ]
      : [
          {
            name: "Roster updated",
            value: result.lastSuccessfulRosterAt
              ? when(result.lastSuccessfulRosterAt, "R")
              : "Never",
            inline: true,
          },
          held,
          track,
        ];
  } else {
    kind = officer ? "refresh.officer" : "refresh.acquisition";
    description = officer
      ? "TaruBot will read the FC roster from the Lodestone, then reconcile every member."
      : "TaruBot will read the FC roster from the Lodestone, then update roles.";
    fields = officer
      ? [
          {
            name: "Mode",
            value: result.lastSuccessfulRosterAt
              ? `Lodestone fetch (roster older than ${interval})`
              : "Lodestone fetch (no roster read yet)",
            inline: true,
          },
          starts,
          lastRoster,
          held,
          track,
        ]
      : [starts, lastRoster, held, track];
  }
  return card(
    paused(mode) ? "refresh.paused" : kind,
    {
      tone: "pending",
      title: result.forced ? "Forced refresh requested" : "Refresh requested",
      description: `${description}${heldSentence}`,
      fields,
      footer:
        officer && !result.forced
          ? [`Run ${result.runId}`, "Use force:true to bypass freshness"]
          : `Run ${result.runId}`,
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /sync status

/** Which run /sync status asked about, if any. */
export interface SyncStatusOptions extends SyncReplyOptions {
  /** The run_id option (or a Check sync status button's run); null for the overview. */
  readonly run: string | null;
}

/** Outstanding work counted by stored status; 'disabled' is shown as Paused. */
interface Tally {
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
  readonly paused: number;
  readonly failed: number;
}

/** Count outstanding work by status. */
function tally(work: readonly JobView[]): Tally {
  const of = (status: string): number => work.filter((job) => job.status === status).length;
  return {
    queued: of("queued"),
    running: of("running"),
    blocked: of("blocked"),
    paused: of("disabled"),
    failed: of("failed"),
  };
}

/**
 * A run's state. The service folds paused ('disabled') child work into 'blocked', so while
 * Discord changes are paused a blocked run is shown as paused: nothing can newly block then.
 * Shared with the web's Status page (src/web/views/status.ts).
 */
export type RunState = SyncRunRow["status"] | "paused";
export const runState = (run: SyncRunRow, mode: EffectsMode): RunState =>
  run.status === "blocked" && paused(mode) ? "paused" : run.status;

/** How each run state reads in run lists, as approved (guests#43 and #44). */
export const RUN_LABEL: Readonly<Record<RunState, string>> = {
  queued: "In progress",
  completed: "Completed",
  blocked: "Waiting on the server",
  paused: "Paused",
  failed: "Did not finish",
};

/** What started a run, from its acquisition job's kind (approved guests#44). */
export function runType(run: SyncRunRow): string {
  if (run.acquisition_kind === "roster") return "Lodestone fetch";
  if (run.acquisition_kind === "reconcile.guild") return "Cached roster";
  return "Refresh";
}

/** A member's run line: '`9d8c7b6a` · <t:…:R> · Waiting on the server: 38 of 40 done'. */
function memberRunLine(run: SyncRunRow, mode: EffectsMode): string {
  const state = runState(run, mode);
  const progress =
    state === "completed"
      ? RUN_LABEL.completed
      : `${RUN_LABEL[state]}: ${grouped(run.work_completed)} of ${grouped(run.work_total)} done`;
  return `${code(shortId(run.id))} · ${when(run.created_at, "R")} · ${progress}`;
}

/**
 * An officer's run line: '`9d8c7b6a` · <t:…:R> · Lodestone fetch · In progress · 38/40 done',
 * with blocked (held, while paused) and failed counts when there are any.
 */
function officerRunLine(run: SyncRunRow, mode: EffectsMode): string {
  const parts = [
    code(shortId(run.id)),
    when(run.created_at, "R"),
    runType(run),
    RUN_LABEL[runState(run, mode)],
    `${grouped(run.work_completed)}/${grouped(run.work_total)} done`,
    run.work_blocked > 0 && `${grouped(run.work_blocked)} ${paused(mode) ? "held" : "blocked"}`,
    run.work_failed > 0 && `${grouped(run.work_failed)} failed`,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/** A blocked or failed job (a DM the recipient's settings refused is not an officer problem). */
const troubled = (job: JobView): boolean => {
  const state = jobMarker(job);
  return state.marker === "blocked" || (state.marker === "failed" && !state.dmBlocked);
};

/**
 * A member's own sync status ('Your sync status', approved guests#43): their recent refreshes by
 * short ID with aggregate progress, and their pending work as member job lines. Nothing at all is
 * neutral; finished runs with nothing left are success; blocked or failed work is warning; queued,
 * running or paused work is pending.
 */
function memberOverview(
  view: SyncStatusView,
  viewer: Viewer,
  options: SyncStatusOptions,
): Presented {
  const mode = view.effectsMode;
  const self: Viewer = { ...viewer, audience: "member" };
  const states = view.runs.map((run) => runState(run, mode));
  const attention =
    view.work.some(troubled) || states.some((state) => state === "blocked" || state === "failed");
  const heldOnly =
    paused(mode) &&
    !attention &&
    view.work.length > 0 &&
    view.work.every((job) => job.status === "disabled") &&
    states.every((state) => state === "completed" || state === "paused");
  const active = view.work.length > 0 || states.some((state) => state !== "completed");
  const done = !active && view.runs.length > 0;
  const kind: SyncReplyKind = attention
    ? "status.member_attention"
    : heldOnly
      ? "status.member_paused"
      : active
        ? "status.member_active"
        : done
          ? "status.member_done"
          : "status.member_empty";
  const tone: Tone = attention ? "warning" : active ? "pending" : done ? "success" : "neutral";
  const lines = view.runs.map((run) => memberRunLine(run, mode));
  const description =
    !active && !done
      ? "Nothing is pending for you.\nYou haven't requested a refresh recently."
      : !view.runs.length
        ? "You haven't requested a refresh recently."
        : runList("**Your recent refreshes**", lines, done ? "Everything is up to date." : null);
  return card(
    kind,
    {
      tone,
      title: "Your sync status",
      description,
      fields: [
        view.work.length > 0 && {
          name: "Your pending work",
          value: jobLines(view.work, self, { effectsMode: mode }).join("\n"),
        },
      ],
      // Run lines show only the short label, which the run_id option rejects, so the in-progress
      // footer names where the full ID comes from instead of treating the label as input.
      footer: attention
        ? "Ask an officer if this doesn't clear."
        : !active && !done
          ? "Start one with /refresh"
          : "Details for one run: /sync status run_id: with the full ID from your /refresh reply",
    },
    options,
  );
}

/**
 * Queued and running work grouped by label for 'Next up' (approved guests#44): 'Role update ×3 ·
 * next <t:…:R>', 'Server-wide role check ×1 · running'. Largest groups first.
 */
function nextUp(work: readonly JobView[]): string[] {
  const groups = new Map<string, { total: number; running: number; next: Date | null }>();
  for (const job of work) {
    const label = jobLabel(job.kind);
    const group = groups.get(label) ?? { total: 0, running: 0, next: null };
    group.total += 1;
    if (job.status === "running") group.running += 1;
    else if (!group.next || job.due_at < group.next) group.next = job.due_at;
    groups.set(label, group);
  }
  return [...groups]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([label, group]) =>
      [
        `${label} ×${grouped(group.total)}`,
        group.running > 0 &&
          (group.running === group.total ? "running" : `${grouped(group.running)} running`),
        group.next && `next ${when(group.next, "R")}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
    );
}

/**
 * The officer server overview ('Sync status · server', approved guests#44): recent runs, the
 * outstanding-work tally (25+ when the service's cap was reached), what runs next grouped by
 * label, and what needs attention as officer job lines (failed, blocked, paused while live, then
 * queued work retrying after an error), at most ten, split across fields to fit (C7). A next step
 * appears when the view is focused on problems or only paused work remains, and, with effects
 * live, whenever work left from an earlier pause is outstanding: the /config step that re-queues it.
 */
function officerOverview(
  view: SyncStatusView,
  viewer: Viewer,
  options: SyncStatusOptions,
): Presented {
  const mode = view.effectsMode;
  const counts = tally(view.work);
  const inProgress =
    counts.running > 0 || view.runs.some((run) => runState(run, mode) === "queued");
  // A DM the recipient's settings refused is counted as failed but is no officer problem.
  const problems = view.work.filter(troubled).length;
  const focused = problems > 0 && !inProgress;
  // Only while changes are paused: live, leftover `disabled` work stays under Needs attention with
  // the /config step that re-queues it and never the "Nothing to fix" step, since no activation or
  // restart is coming to resume it.
  const heldOnly =
    paused(mode) && counts.paused > 0 && problems === 0 && counts.queued === 0 && !inProgress;
  // Shown even while other work is in progress, because nothing else will resume these rows; a
  // /config save requeues parked work (requeueParked), as the ledger officer views say.
  const leftover = mode === "live" && counts.paused > 0;
  const completed =
    view.work.length === 0 &&
    view.runs.length > 0 &&
    view.runs.every((run) => run.status === "completed");
  // Only terminal work nobody needs to fix (a DM the recipient refused) is left: info.
  const tone: Tone = focused
    ? "warning"
    : inProgress || counts.queued > 0 || counts.paused > 0 || problems > 0
      ? "pending"
      : view.work.length > 0
        ? "info"
        : completed
          ? "success"
          : "neutral";
  const byStatus = (status: string): JobView[] => view.work.filter((job) => job.status === status);
  const attention = [
    ...byStatus("failed").filter(troubled),
    ...byStatus("blocked"),
    ...(paused(mode) ? [] : byStatus("disabled")),
    ...byStatus("queued").filter((job) => job.last_error !== null),
  ];
  const upcoming = view.work.filter(
    (job) => job.status === "running" || (job.status === "queued" && job.last_error === null),
  );
  const pausedLead =
    counts.paused > 0 && paused(mode)
      ? mode === "awaiting_activation"
        ? "**Role changes are paused.** Discord changes are held until this server is activated, so role, nickname and notice work waits until then."
        : "**Role changes are paused.** Discord changes are off for this deployment, so role, nickname and notice work waits until they're turned back on."
      : null;
  const runs = view.runs.length
    ? runList(
        "**Recent runs**",
        view.runs.map((run) => officerRunLine(run, mode)),
        pausedLead,
      )
    : [pausedLead, "No refreshes were requested recently."].filter(Boolean).join("\n\n");
  const nextStep = focused
    ? "Run /config validate, fix what it reports, then /refresh."
    : heldOnly
      ? mode === "deployment_disabled"
        ? "Nothing to fix here. Held work resumes when Discord changes are turned back on."
        : "Nothing to fix. Held work resumes when the server is activated."
      : leftover
        ? "Paused work is left from an earlier pause; saving any setting with /config re-queues it."
        : null;
  const fields: (FieldSpec | null | false)[] = [
    {
      name: `Outstanding work (${view.work.length >= 25 ? "25+" : grouped(view.work.length)})`,
      value: `Queued ${grouped(counts.queued)} · Running ${grouped(counts.running)} · Blocked ${grouped(counts.blocked)} · Paused ${grouped(counts.paused)} · Failed ${grouped(counts.failed)}`,
    },
    upcoming.length > 0 && { name: "Next up", value: nextUp(upcoming).join("\n") },
    ...jobFields("Needs attention", attention, viewer),
    nextStep !== null && { name: "Next step", value: nextStep },
  ];
  return card(
    focused ? "status.officer_attention" : heldOnly ? "status.officer_paused" : "status.officer",
    {
      tone,
      title: "Sync status · server",
      description: runs,
      fields,
      footer: ["Officer view", "Up to 10 runs and 25 outstanding jobs"],
      buttons: [detailsButton({ action: "sync", run: null })],
    },
    options,
  );
}

/** Each run state's title section and tone for the run detail view. */
const RUN_DETAIL: Readonly<Record<RunState, { readonly tone: Tone; readonly title: string }>> = {
  completed: { tone: "success", title: "completed" },
  queued: { tone: "pending", title: "in progress" },
  blocked: { tone: "warning", title: "waiting on the server" },
  paused: { tone: "pending", title: "paused" },
  failed: { tone: "warning", title: "did not finish" },
};

/** The roster a run's Lodestone fetch read, from its stored result: '187 members read (4 pages)'. */
function rosterRead(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const members = "count" in result ? result.count : undefined;
  const pages = "pages" in result ? result.pages : undefined;
  if (typeof members !== "number" || typeof pages !== "number") return null;
  return `${count(members, "member")} read (${count(pages, "page")})`;
}

/**
 * One run ('Sync run · completed', guests#47): no ID in the title; the full ID is the 'Run <uuid>'
 * footer. Requested, type, roster read, member enumeration and progress are shown to everyone
 * the service lets see the run; officers also see who requested it, the acquisition job's state
 * and diagnostic, and Full details (JSON). Outstanding work isn't listed, because the service's
 * work list is not scoped to one run.
 */
function runDetail(
  run: SyncRunRow,
  view: SyncStatusView,
  viewer: Viewer,
  options: SyncStatusOptions,
): Presented {
  const officer = isOfficer(viewer);
  const mode = view.effectsMode;
  const state = runState(run, mode);
  const description = {
    completed: run.completed_at ? `Completed ${when(run.completed_at, "R")}.` : "Completed.",
    queued: "Still running. Check again in a moment.",
    blocked: officer
      ? "Waiting on the server. Run /config validate, fix what it reports, then /refresh."
      : "Waiting on the server: an officer needs to fix a permission or setting.",
    paused: `Discord changes are paused, so this run finishes ${whenApplied(mode)}.`,
    failed: officer
      ? "Some work did not finish and won't retry. Full details (JSON) has each job's diagnostic."
      : "Some work did not finish and won't retry. Ask an officer.",
  }[state];
  const roster = run.acquisition_kind === "roster" ? rosterRead(run.result) : null;
  const acquisition =
    officer && run.acquisition_status
      ? [
          `${marker(jobMarker({ status: run.acquisition_status, last_error: run.last_error, result: run.result }).marker)} ${plain(run.acquisition_kind ?? "acquisition", 40)}`,
          run.last_error && `> ${plain(run.last_error, HOUSE_LIMITS.diagnostic)}`,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      : null;
  return card(
    "run.detail",
    {
      tone: RUN_DETAIL[state].tone,
      title: `Sync run · ${RUN_DETAIL[state].title}`,
      description,
      fields: [
        {
          name: "Requested",
          value: `${when(run.created_at, "R")}${
            officer && run.requester_id ? ` by ${mentionUser(run.requester_id)}` : ""
          }`,
          inline: true,
        },
        { name: "Type", value: runType(run), inline: true },
        roster !== null && { name: "Roster", value: roster, inline: true },
        {
          name: "Members checked",
          value: run.enumeration_completed_at
            ? `Done ${when(run.enumeration_completed_at, "R")}`
            : "Not yet",
          inline: true,
        },
        {
          name: "Progress",
          value: `${grouped(run.work_completed)} of ${grouped(run.work_total)} done · ${grouped(run.work_blocked)} ${paused(mode) ? "held" : "blocked"} · ${grouped(run.work_failed)} failed`,
          inline: true,
        },
        acquisition !== null && { name: "Acquisition", value: acquisition },
      ],
      footer: `Run ${run.id}`,
      buttons: [officer && detailsButton({ action: "sync", run: run.id })],
    },
    options,
  );
}

/**
 * A run ID that matches nothing the viewer may see (guests#48). Missing runs and other members'
 * runs read the same, so a run's existence is never revealed.
 */
function noRun(viewer: Viewer, options: SyncStatusOptions): Presented {
  return card(
    "run.missing",
    {
      tone: "neutral",
      title: "No matching run",
      description: "No sync run with that ID is visible to you.",
      footer: isOfficer(viewer) ? undefined : "Members can see only runs they requested",
    },
    options,
  );
}

/**
 * /sync status and the Check sync status button. With a run, that run's detail or 'No matching
 * run'; otherwise the officer server overview for officers and the member's own view for
 * everyone else. The service has already scoped runs and work to what the viewer may see.
 */
export function syncStatusReply(
  view: SyncStatusView,
  viewer: Viewer,
  options: SyncStatusOptions,
): Presented {
  if (options.run !== null) {
    // A typed run_id may be uppercase; PostgreSQL renders UUIDs in lowercase.
    const wanted = options.run.toLowerCase();
    const run = view.runs.find((row) => row.id.toLowerCase() === wanted);
    return run ? runDetail(run, view, viewer, options) : noRun(viewer, options);
  }
  return isOfficer(viewer)
    ? officerOverview(view, viewer, options)
    : memberOverview(view, viewer, options);
}
