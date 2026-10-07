/**
 * Background Discord work as status replies show it: the approved job line (errors-and-style#28),
 * the effects field that reports queued or paused work in change receipts, the paused-save card
 * parts (errors-and-style#26) and the roster-evidence field. Shared by /guest status, /sync status,
 * /ledger balance and the change presenters.
 */
import type { EffectsMode, JobView, RosterEvidence } from "../../application/results.js";
import { WAITING_CODES } from "../../domain/failures.js";
import { isOfficer, type Viewer } from "./audience.js";
import { andMore, code, plain, restoreMentions, shortId, splitFields, when } from "./format.js";
import type { FieldSpec } from "./reply.js";
import { HOUSE_LIMITS, marker, type Marker } from "./style.js";

/**
 * Member-facing names for job kinds, and the completion phrase a succeeded job reads as (the only
 * state allowed completion words). Officers see the raw kind, as approved (errors-and-style#28).
 */
export const JOB_KIND: Readonly<Record<string, { readonly label: string; readonly done: string }>> =
  {
    "reconcile.user": { label: "Role update", done: "Roles and nickname updated" },
    "reconcile.guild": {
      label: "Server-wide role check",
      done: "Server-wide role check finished",
    },
    roster: { label: "FC roster check", done: "FC roster checked" },
    "roster.confirm": {
      label: "Departure confirmation",
      done: "Departure confirmation finished",
    },
    // Retired (#86): only refreshes an older version queued before an upgrade still carry this kind.
    profile: { label: "Character profile refresh", done: "Character profile refreshed" },
    "channels.access": { label: "Channel access", done: "Channel access secured" },
    "roles.layout": { label: "Role layout", done: "Role layout applied" },
    // The post after the bot starts on a newer version (2.25.0).
    "changelog.post": { label: "Update post", done: "Update posted" },
    "ledger.notify": { label: "Ledger post", done: "Ledger entry posted" },
    "guest.review": { label: "Guest review message", done: "Guest review message posted" },
    "guest.dm": { label: "Decision DM", done: "Decision DM sent" },
    "officer.notify": { label: "Officer notice", done: "Officer notice sent" },
    // The member status changes post in the officer notifications channel (2.29.0).
    "officer.status": { label: "Status notice", done: "Status notice posted" },
  };

/** A kind's member-facing label; a kind this release doesn't know falls back to its raw name. */
export const jobLabel = (kind: string): string =>
  Object.hasOwn(JOB_KIND, kind) ? (JOB_KIND[kind]?.label ?? kind) : kind;

/** The catalog code a stored last_error starts with ('code: message', or a bare code). */
export function jobCode(lastError: string | null): string | null {
  if (!lastError) return null;
  const separator = lastError.indexOf(": ");
  return separator < 0 ? lastError : lastError.slice(0, separator);
}

/** The fields of a job row that decide its marker (a JobView or a ledger delivery row). */
export interface JobStatus {
  readonly status: string;
  readonly last_error: string | null;
  readonly result?: unknown;
}

/** A job's marker, plus the qualifier its line adds. */
export interface JobState {
  readonly marker: Marker;
  /** A queued job's wait: scheduled ('next', a waiting code) or a retry after a problem. */
  readonly wait?: "next" | "retrying";
  /** A failed decision DM the recipient's settings refused; the decision still stands. */
  readonly dmBlocked?: boolean;
  /** A succeeded job that had nothing to do, with the dispatcher's reason. */
  readonly skipped?: string;
}

/** The dispatcher's skip reason from a succeeded job's result, if it skipped. */
function skipReason(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("skipped" in result)) return undefined;
  return typeof result.skipped === "string" ? result.skipped : undefined;
}

/**
 * Map a stored status and last_error code to its marker, as approved:
 * succeeded with a skip result – SKIPPED; succeeded ✓ DONE; running … IN PROGRESS; queued with no
 * error … QUEUED; queued with a waiting code (ordered, busy, cooldown, superseded, lease_lost)
 * ↻ WAITING next; queued with any other code ↻ WAITING retrying; blocked ! BLOCKED; disabled
 * ‖ PAUSED; failed with dm_blocked ✗ FAILED (the decision still stands); other failures ✗ FAILED.
 */
export function jobMarker(job: JobStatus): JobState {
  const failure = jobCode(job.last_error);
  switch (job.status) {
    case "succeeded": {
      const skipped = skipReason(job.result);
      return skipped === undefined ? { marker: "done" } : { marker: "skipped", skipped };
    }
    case "running":
      return { marker: "running" };
    case "blocked":
      return { marker: "blocked" };
    case "disabled":
      return { marker: "paused" };
    case "failed":
      return failure === "dm_blocked"
        ? { marker: "failed", dmBlocked: true }
        : { marker: "failed" };
    default:
      // 'queued' is the only other stored status (the jobs.status CHECK constraint).
      if (failure === null) return { marker: "queued" };
      return { marker: "waiting", wait: WAITING_CODES.has(failure) ? "next" : "retrying" };
  }
}

/** Options for a job line: the effects mode words a paused line for members. */
export interface JobLineOptions {
  readonly effectsMode?: EffectsMode;
}

/**
 * Why a paused job waits, in member words, for the current effects mode. With effects live, a
 * `disabled` row is left over from an earlier pause that nothing resumed, so it names no
 * activation that isn't coming.
 */
const pausedReason = (mode: EffectsMode | undefined): string =>
  mode === "deployment_disabled"
    ? "Discord changes are off for this deployment"
    : mode === "live"
      ? "held from an earlier pause, so ask an officer"
      : "waiting for activation";

/** Member wording: marker, label and plain words; never IDs, attempts or diagnostics. */
function memberLine(job: JobView, state: JobState, options: JobLineOptions): string {
  const label = jobLabel(job.kind);
  const prefix = marker(state.marker);
  switch (state.marker) {
    case "done": {
      const done = Object.hasOwn(JOB_KIND, job.kind) ? JOB_KIND[job.kind]?.done : undefined;
      const at = job.completed_at ? ` ${when(job.completed_at, "R")}` : "";
      return `${prefix} ${done ?? `${label} finished`}${at}`;
    }
    case "skipped":
      return `${prefix} ${label}: nothing to do`;
    case "waiting":
      return `${prefix} ${label} (${state.wait === "next" ? "next" : "retrying"} ${when(job.due_at, "R")})`;
    case "blocked":
      return `${prefix} ${label}: an officer needs to fix permissions`;
    case "paused":
      return `${prefix} ${label}: ${pausedReason(options.effectsMode)}`;
    case "failed":
      return state.dmBlocked
        ? `${prefix} ${label}: your DMs are closed (the decision still stands)`
        : `${prefix} ${label}: stopped and won't retry, so ask an officer`;
    default:
      return `${prefix} ${label}`;
  }
}

/** A bare channel ID in an older diagnostic ('in channel 123…'), rendered as a mention. */
const CHANNEL_ID = /\bchannel ([1-9][0-9]{16,19})\b/gu;

/**
 * An officer diagnostic: the stored last_error, escaped and cut to 150 characters, with complete
 * channel, role and user mentions kept and bare channel IDs rendered as channel mentions.
 */
function diagnostic(text: string): string {
  return restoreMentions(plain(text, HOUSE_LIMITS.diagnostic)).replace(CHANNEL_ID, "channel <#$1>");
}

/**
 * Officer wording, as approved: marker, raw kind and short ID, then the facts that matter for the
 * state (attempt and next time for waits and retries, when it stopped for blocks), and the stored
 * diagnostic quoted underneath:
 * '`↻ WAITING` reconcile.user `1a2b3c4d` · attempt 3 · next <t:…:R>' / '> cooldown: …'.
 */
function officerLine(job: JobView, state: JobState): string {
  const facts: string[] = [];
  const attempt = job.attempts > 0 ? `attempt ${job.attempts}` : null;
  switch (state.marker) {
    case "done":
    case "skipped":
      if (job.completed_at) facts.push(when(job.completed_at, "R"));
      break;
    case "running":
    case "failed":
      if (attempt) facts.push(attempt);
      break;
    case "queued":
      facts.push(`next ${when(job.due_at, "R")}`);
      break;
    case "waiting":
      if (attempt) facts.push(attempt);
      facts.push(`next ${when(job.due_at, "R")}`);
      break;
    default:
      facts.push(when(job.due_at, "R"));
  }
  const head = [
    `${marker(state.marker)} ${plain(job.kind, 40)} ${code(shortId(job.id))}`,
    ...facts,
  ];
  const detail = state.skipped ?? (state.marker === "done" ? null : job.last_error);
  return detail ? `${head.join(" · ")}\n> ${diagnostic(detail)}` : head.join(" · ");
}

/** One job as a status line for this viewer (members get labels and plain words). */
export function jobLine(job: JobView, viewer: Viewer, options: JobLineOptions = {}): string {
  const state = jobMarker(job);
  return isOfficer(viewer) ? officerLine(job, state) : memberLine(job, state, options);
}

/** Up to ten job lines, plus '…and N more' for the rest. */
export function jobLines(
  jobs: readonly JobView[],
  viewer: Viewer,
  options: JobLineOptions & { readonly max?: number } = {},
): string[] {
  const max = options.max ?? HOUSE_LIMITS.jobLines;
  const lines = jobs.slice(0, max).map((job) => jobLine(job, viewer, options));
  if (jobs.length > max) lines.push(andMore(jobs.length - max));
  return lines;
}

/**
 * Job lines as fields that each fit Discord's 1,024-character value, named 'Needs attention
 * (1/2)' when they span several: ten officer lines with full diagnostics exceed one field.
 */
export function jobFields(
  name: string,
  jobs: readonly JobView[],
  viewer: Viewer,
  options: JobLineOptions & { readonly max?: number } = {},
): FieldSpec[] {
  return splitFields(name, jobLines(jobs, viewer, options));
}

/**
 * Discord work a change queued, as its receipt reports it: '… QUEUED' while effects are live,
 * '‖ PAUSED' until activation or while the deployment has effects off (never QUEUED then).
 * Officers also see why it is paused. `what` names the work ('Role update'), or '' for none.
 */
export function effectsField(
  mode: EffectsMode,
  what: string,
  viewer: Viewer,
  name = "Discord changes",
): FieldSpec {
  const subject = what ? ` ${what}` : "";
  if (mode === "live") return { name, value: `${marker("queued")}${subject}`, inline: true };
  const value =
    mode === "awaiting_activation"
      ? `${marker("paused")}${subject} until activation`
      : `${marker("paused")}${subject}${what ? ":" : ""} Discord changes are off for this deployment`;
  const why =
    mode === "awaiting_activation"
      ? "Server activation pending"
      : "Disabled globally (ENABLE_EFFECTS)";
  return { name, value: isOfficer(viewer) ? `${value}\nWhy: ${why}` : value, inline: true };
}

/**
 * When work a change queued reaches Discord, as receipt fields word it: 'shortly' while effects
 * are live, otherwise when the pause ends. It completes sentences such as 'Changes to X shortly.'
 */
export function whenApplied(mode: EffectsMode): string {
  if (mode === "live") return "shortly";
  return mode === "awaiting_activation"
    ? "once this server is activated"
    : "once Discord changes are turned back on";
}

/** The parts of the approved paused-save card that every change receipt shares. */
export interface PausedSave {
  readonly tone: "pending";
  readonly title: string;
  /** Follows the receipt's own sentence saying what was saved. */
  readonly sentence: string;
  /** 'Saved' and 'Discord changes', both inline, as approved; officers also see why. */
  readonly fields: readonly [FieldSpec, FieldSpec];
  readonly footer: string;
}

/**
 * A change saved while Discord effects are paused (approved errors-and-style#26, owner decision
 * O2): always pending tone and titled 'Saved, Discord changes paused', never a success card with a
 * PAUSED field. The receipt keeps its own facts and says what it saved first; this supplies the
 * rest. Deployment-wide pauses get their own sentence, since activation won't end them.
 */
export function pausedSave(mode: Exclude<EffectsMode, "live">, viewer: Viewer): PausedSave {
  return {
    tone: "pending",
    title: "Saved, Discord changes paused",
    sentence:
      mode === "awaiting_activation"
        ? "TaruBot won't change roles, nicknames or channels in this server until activation finishes. It will apply this change automatically then."
        : "Discord changes are off for this deployment, so TaruBot won't change roles, nicknames or channels for now. It will apply this change automatically once they're turned back on.",
    fields: [
      { name: "Saved", value: marker("saved"), inline: true },
      effectsField(mode, "", viewer),
    ],
    footer: "Check progress any time with /sync status",
  };
}

/**
 * The Member-role field for a new link (verify, assign, refresh), from the roster evidence the
 * decision rests on. Null when no FC is linked, since Member access doesn't apply. It is a field
 * on the success card, never a title: a stale roster reads '↻ WAITING for the next roster check'.
 */
export function rosterEvidence(
  evidence: RosterEvidence,
  mode: EffectsMode = "live",
): FieldSpec | null {
  if (!evidence.fcLinked) return null;
  const name = "Member role";
  if (!evidence.fresh)
    return {
      name,
      value: evidence.checkedAt
        ? `${marker("waiting")} for the next roster check (last one ${when(evidence.checkedAt, "R")})`
        : `${marker("waiting")} for the first roster check`,
      inline: true,
    };
  if (!evidence.listed)
    return {
      name,
      value: evidence.checkedAt
        ? `Doesn't apply: not in the FC roster checked ${when(evidence.checkedAt, "R")}`
        : "Doesn't apply: not in the FC roster",
      inline: true,
    };
  if (mode === "live") return { name, value: marker("queued"), inline: true };
  return {
    name,
    value:
      mode === "awaiting_activation"
        ? `${marker("paused")} until activation`
        : `${marker("paused")} Discord changes are off for this deployment`,
    inline: true,
  };
}
