/**
 * Guest presenters: /guest status (the member's own view and the officer record view), /guest
 * grant and revoke, /guest approve and deny and the review message's buttons, /apply's closed card
 * and form receipt, the officer application autocomplete choice, and the review message and
 * decision DM the gateway renders for the guest.review and guest.dm jobs. Each renders a typed
 * service result or stored application for its viewer, reproducing the approved mockups (guests#0,
 * #7, #10, #11 and #21) exactly and the reply specs for the other states. Failures are never
 * caught here: the router's failure presenter renders them. Pure; the clock is injected for reply
 * timestamps and deadlines, and the review message and DM are stamped from the stored record.
 *
 * Members never see officer-authored grant or revocation reasons, reviewers, channel or message
 * IDs, job IDs or diagnostics. The one reason an applicant reads is their own denial reason (C6),
 * which the decision DM already sends them, capped at 300 characters like all user text.
 *
 * Change receipts branch on effectsMode (C5): a grant, revocation or decision saved while Discord
 * changes are paused is the approved paused-save card (errors-and-style#26, owner decision O2),
 * and a submitted application says when officers will see it. The officer job lines in the record
 * view show raw job kinds, as approved (errors-and-style#28); members read labels.
 */
import type { ApplicationCommandOptionChoiceData } from "discord.js";
import type { ApplicationRecord } from "../../application/records.js";
import type {
  ApplicationChoiceRow,
  ApplicationState,
  ApplicationStatusRow,
  ApplyResult,
  DecisionResult,
  EffectsMode,
  GuestActionResult,
  GuestResetResult,
  GuestStatusView,
  JobView,
} from "../../application/results.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../domain/guest-application.js";
import { isOfficer, type Viewer } from "./audience.js";
import { detailsButton, reviewButtons } from "./controls.js";
import {
  choice,
  cmd,
  code,
  cut,
  duration,
  link,
  list,
  member,
  mentionRole,
  mentionUser,
  plain,
  quote,
  shortId,
  title,
  when,
} from "./format.js";
import { jobLine, jobMarker, pausedSave, whenApplied } from "./jobs.js";
import { applicationState, grantProvenance } from "./labels.js";
import {
  post,
  reply,
  type EmbedSpec,
  type FieldSpec,
  type Presented,
  type ReplySpec,
} from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS, marker, type Tone } from "./style.js";

/**
 * Every guest reply kind, with whether its embed carries a timestamp: the approved card's
 * `timestamp` value (only the officer record view, guests#7, has one), or the reply spec's for
 * states without a drawn card (C11). The reply catalog must cover every kind.
 */
const TIMESTAMP = {
  "status.member_access": false,
  "status.revoked": false,
  "status.granted": false,
  "status.former": false,
  "status.registered": false,
  "status.waiting_roster": false,
  "status.uncertain": false,
  "status.pending": false,
  "status.denied": false,
  "status.closed": false,
  "status.none": false,
  "status.officer": true,
  "status.officer_attention": true,
  "grant.granted": false,
  "grant.restored": false,
  "grant.absent": false,
  "grant.no_role": false,
  "revoke.revoked": false,
  "action.paused": false,
  "reset.reset": false,
  "reset.unchanged": false,
  "reset.paused": false,
  "decision.approved": false,
  "decision.denied": false,
  "decision.cancelled": false,
  "decision.superseded": false,
  "decision.already": false,
  "decision.button": false,
  "decision.paused": false,
  "apply.created": false,
  "apply.replaced": false,
  "apply.existing": false,
  "apply.held": false,
} as const satisfies Record<string, boolean>;

/** A guest reply state; tests catalogue one case per kind. */
export type GuestReplyKind = keyof typeof TIMESTAMP;

/** Every guest reply kind, for catalog completeness checks. */
export const GUEST_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly GuestReplyKind[];

/** Options every guest presenter takes. */
export interface GuestReplyOptions {
  /** The current time for timestamps and deadlines; commands omit it, tests inject it. */
  readonly now?: Date | undefined;
}

/** Build a guest reply of `kind`, stamping it only when its approved card does. */
function card(
  kind: GuestReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: GuestReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/** Whether a change's Discord work is held, which turns its receipt into the paused-save card. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

/** How many grants and applications the officer record view lists before '…and N earlier'. */
const MAX_RECORD_ROWS = 5;
/** How many recent deliveries the officer record view lists (the full list is in the JSON). */
const MAX_DELIVERIES = 3;

// ---------------------------------------------------------------------------------------------
// /apply: the closed card

/** The approved hint for players, who get Guest through /claim rather than an application. */
const ALREADY_PLAY: FieldSpec = {
  name: "Already play FFXIV?",
  value: "Register your character with /claim. Registered players get Guest access automatically.",
};

/**
 * What an officer runs to open applications: the switch on, a review channel and a Guest role, all
 * required (the shared guestApplicationsOpen rule). Shown only to people who could run it.
 */
const OPEN_APPLICATIONS: FieldSpec = {
  name: "Open applications",
  value: [
    `${cmd("config guest_applications", { enabled: true, channel: "#guest-reviews" })} turns them on with a review channel.`,
    `${cmd("config roles guest", { role: "@Guest" })} sets the Guest role.`,
    "Applications open once all three are set.",
  ].join("\n"),
};

/**
 * The closed-applications card as data, so the failure presenter can add its Code · Ref footer and
 * an officer next step to the same card: info tone, the shared refusal text and the player hint.
 * It carries no timestamp, as approved.
 */
export function applicationsClosedSpec(extra: readonly FieldSpec[] = []): EmbedSpec {
  return {
    tone: "info",
    title: "Guest applications are closed",
    description: GUEST_APPLICATIONS_CLOSED,
    fields: [ALREADY_PLAY, ...extra],
  };
}

/**
 * /apply's pre-form refusal (approved guests#21). It is an expected state, not a failure, so it
 * has no footer and is never reported. `officerHint` is read from the interaction's own
 * permissions (Manage Server and Manage Roles: a server manager), because the pre-form check
 * cannot afford a network lookup; it only adds the commands that open applications, never any
 * access.
 */
export function applicationsClosedReply(options: { readonly officerHint: boolean }): Presented {
  return reply(applicationsClosedSpec(options.officerHint ? [OPEN_APPLICATIONS] : []));
}

// ---------------------------------------------------------------------------------------------
// /apply: the form receipt

/**
 * The /apply form's receipt. A new application (or one replacing an application from an earlier
 * join) is pending 'Application sent' (guests#22); a repeated submission is the info no-op
 * 'Application already sent' (#23). The answers are never echoed, not even in the public test
 * guild; only the application ID appears, in the footer. While Discord changes are paused the
 * review message is held too, so a new application is the paused-save card (O2,
 * errors-and-style#26, with that card's footer) saying when officers will see it instead of
 * promising a review now (C5).
 */
export function applicationReceivedReply(
  result: ApplyResult,
  viewer: Viewer,
  options: GuestReplyOptions = {},
): Presented {
  const footer = `Application ${result.id}`;
  const mode = result.effectsMode;
  if (result.outcome === "existing")
    return card(
      "apply.existing",
      {
        tone: "info",
        title: "Application already sent",
        description: `You already applied ${when(result.created_at, "R")}. Your original answers are kept, and officers ${
          paused(mode) ? `see them ${whenApplied(mode)}` : "will review them"
        }.`,
        footer,
      },
      options,
    );
  const replaced =
    result.outcome === "replaced"
      ? " Your earlier application from a previous join was closed."
      : "";
  if (paused(mode)) {
    // A saved application whose review message is held is a paused save (O2, errors-and-style#26):
    // the receipt keeps its own sentence, since officers seeing it is what the pause delays, and
    // takes the card's Saved and Discord changes fields and its /sync status footer, where the
    // held review job is listed as the applicant's own pending work.
    const held = pausedSave(mode, viewer);
    return card(
      "apply.held",
      {
        tone: held.tone,
        title: held.title,
        description: `Your guest application is saved. Officers see it ${whenApplied(mode)}. Submitting again keeps your original application and answers.${replaced}`,
        fields: [
          ...held.fields,
          {
            name: "What happens next",
            value:
              "Check with /guest status. You get a DM with the decision, if your DMs are open.",
          },
        ],
        footer: held.footer,
      },
      options,
    );
  }
  return card(
    result.outcome === "replaced" ? "apply.replaced" : "apply.created",
    {
      tone: "pending",
      title: "Application sent",
      description: `Your guest application is awaiting officer review. Submitting again keeps your original application and answers.${replaced}`,
      fields: [
        {
          name: "What happens next",
          value:
            "Officers review it in private. Check with /guest status. You also get a DM with the decision, if your DMs are open.",
        },
      ],
      footer,
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /guest status

/** Which record /guest status shows and whether its member option was given. */
export interface GuestStatusOptions extends GuestReplyOptions {
  /** Whose record this is. */
  readonly owner: string;
  /** The member option was given (the officer layout needs it, even for the officer's own ID). */
  readonly memberOption: boolean;
}

/**
 * What a record's access rests on, in the approved headline order: confirmed FC membership, a
 * revocation, a durable grant, former FC membership, a registered character outside the FC, a
 * registration waiting for a fresh roster, uncertain membership, then the newest application
 * (pending, denied, or otherwise closed), and finally nothing. Former membership and registration
 * give Guest only while membership is 'ineligible', exactly as reconciliation decides.
 */
type Basis =
  | "member_access"
  | "revoked"
  | "granted"
  | "former"
  | "registered"
  | "waiting_roster"
  | "uncertain"
  | "pending"
  | "denied"
  | "closed"
  | "none";

/** The headline basis of a guest record. */
function basisOf(status: GuestStatusView): Basis {
  if (status.membership === "member") return "member_access";
  if (status.revocation[0]?.revoked) return "revoked";
  if (status.grants.length) return "granted";
  if (status.formerMember[0]?.eligible && status.membership === "ineligible") return "former";
  if (status.verifiedGuestEligible) return "registered";
  if (status.registered && status.membership === "ineligible" && !status.rosterFresh)
    return "waiting_roster";
  if (status.membership === "uncertain") return "uncertain";
  const newest = status.applications[0];
  if (newest?.state === "pending") return "pending";
  if (newest?.state === "denied") return "denied";
  if (newest && newest.state !== "approved") return "closed";
  return "none";
}

/**
 * The grant a record's access began with: the earliest one. Every durable grant stands on its
 * own, so the first one is how the member qualified (approved guests#0 and #7 name it).
 */
const firstGrant = (status: GuestStatusView) => status.grants.at(-1);

/** Why each grant provenance qualifies, in the member's words (approved guests#0). */
const QUALIFY: Readonly<Record<string, string>> = {
  grandfathered: "Granted at launch: you were in the server when TaruBot took over",
  approved: "Application approved: officers approved your guest application",
  manual: "Granted by an officer",
  imported_guest: "Imported from the previous bot: your Guest access carried over",
};

/** A grant provenance as the officer headline names it (approved guests#7). */
const GRANT_BASIS: Readonly<Record<string, string>> = {
  grandfathered: "grandfathered grant",
  approved: "approved application",
  manual: "granted by an officer",
  imported_guest: "imported grant",
};

/** Look up a stored value's wording, falling back to the provenance label. */
const worded = (table: Readonly<Record<string, string>>, provenance: string): string =>
  Object.hasOwn(table, provenance)
    ? (table[provenance] ?? grantProvenance(provenance))
    : grantProvenance(provenance);

/** The time an application reached its state: its decision, or its submission while pending. */
const settledAt = (row: ApplicationStatusRow): Date => row.decided_at ?? row.created_at;

/** The newest application's outcome as the member's grant view lists it. */
function applicationOutcome(row: ApplicationStatusRow | undefined): string {
  if (!row) return "None";
  switch (row.state) {
    case "pending":
      return "Awaiting officer review";
    case "approved":
      return `Approved ${when(settledAt(row), "R")}`;
    case "denied":
      return `Not approved ${when(settledAt(row), "R")}`;
    case "cancelled":
      return `Cancelled ${when(settledAt(row), "R")}`;
    default:
      return applicationState(row.state);
  }
}

/** Why a closed (cancelled or superseded) application closed, for its applicant. */
const CLOSED_WHY: Readonly<Record<string, string>> = {
  cancelled: "Cancelled: you left or rejoined the server, or Guest access was removed.",
  superseded: "No longer needed: you qualified for access another way.",
};

/** The newest role update among the record's deliveries (they arrive newest first). */
const newestRoleUpdate = (status: GuestStatusView): JobView | undefined =>
  status.delivery.find((job) => job.kind === "reconcile.user");

/** The headline a member reads, before the Roles field adjusts its tone. */
interface Headline {
  readonly kind: GuestReplyKind;
  readonly tone: Tone;
  readonly description: string;
  readonly fields: readonly (FieldSpec | null | false | undefined)[];
  readonly footer?: string | readonly string[] | undefined;
}

/**
 * The member's own record ('Your guest access', approved guests#0), headline first. The Roles field
 * reads 'Up to date' when the newest role update succeeded, and otherwise the member job line;
 * a blocked or failed update raises the tone to warning, and a paused one to pending unless the
 * headline already warns (C4). No reason but the member's own denial reason is shown.
 */
function memberStatus(
  status: GuestStatusView,
  self: Viewer,
  options: GuestStatusOptions,
): Presented {
  const now = options.now ?? new Date();
  const mode = status.effectsMode;
  const roleJob = newestRoleUpdate(status);
  const roles: FieldSpec | null = roleJob
    ? {
        name: "Roles",
        value:
          roleJob.status === "succeeded"
            ? "Up to date"
            : jobLine(roleJob, self, { effectsMode: mode }),
        inline: true,
      }
    : null;
  const newest = status.applications[0];
  const headline = ((): Headline => {
    switch (basisOf(status)) {
      case "member_access":
        return {
          kind: "status.member_access",
          tone: "success",
          description:
            "**Member access.** A confirmed FC character gives you Member, so Guest access doesn't apply.",
          fields: [roles],
          footer: "Member access follows the FC roster.",
        };
      case "revoked":
        return {
          kind: "status.revoked",
          tone: "warning",
          description: `**Removed.** An officer removed your Guest access ${when(status.revocation[0]?.changed_at ?? now, "R")}. It stays off until an officer restores it.`,
          fields: [
            {
              name: "FC Member access",
              value: "Not affected. A confirmed FC character still gives Member.",
            },
            roles,
          ],
          footer: "Questions? Ask an officer.",
        };
      case "granted": {
        const grant = firstGrant(status);
        return {
          kind: "status.granted",
          tone: "success",
          description: "**Active.** You have Guest access in this server.",
          fields: [
            grant && {
              name: "How you qualify",
              value: `${worded(QUALIFY, grant.provenance)} (${when(grant.created_at, "D")}).`,
            },
            roles,
            { name: "Application", value: applicationOutcome(newest), inline: true },
          ],
          footer:
            "Guest access lasts until an officer removes it. A confirmed FC character gives Member instead.",
        };
      }
      case "former":
        return {
          kind: "status.former",
          tone: "success",
          description: "**Active.** You keep Guest access as a former member of the Free Company.",
          fields: [
            {
              name: "How you qualify",
              value: "Former FC member (one of your characters was confirmed in the FC before)",
            },
            roles,
          ],
          footer: "Guest access lasts until an officer removes it.",
        };
      case "registered":
        return {
          kind: "status.registered",
          tone: "success",
          description:
            "**Active.** You are a Guest because you registered a character that is not in the Free Company.",
          fields: [
            {
              name: "How you qualify",
              value: "Registered character (verified by you or assigned by an officer)",
            },
            roles,
          ],
          footer: "If one of your registered characters joins the FC, you get Member instead.",
        };
      case "waiting_roster":
        return {
          kind: "status.waiting_roster",
          tone: "pending",
          description:
            "**Waiting for a roster check.** You have a registered character. TaruBot gives you Guest or Member access once a current FC roster shows whether it's in the Free Company.",
          fields: [
            {
              name: "Next",
              value: "Roster checks run automatically. Run /refresh to ask for one now.",
            },
            roles,
          ],
        };
      case "uncertain":
        return {
          kind: "status.uncertain",
          tone: "pending",
          description:
            "**Being checked.** TaruBot is confirming whether your characters are still in the Free Company. Your access updates when the check finishes.",
          fields: [roles],
        };
      case "pending":
        return {
          kind: "status.pending",
          tone: "pending",
          description:
            "**Awaiting review.** Officers have not decided on your guest application yet.",
          fields: [
            newest && { name: "Submitted", value: when(newest.created_at, "R"), inline: true },
            {
              name: "Status",
              value: paused(mode)
                ? `Officers see it ${whenApplied(mode)}`
                : "Awaiting officer review",
              inline: true,
            },
            roles,
          ],
          footer: [
            "You get a DM when officers decide, if your DMs are open",
            newest ? `Application ${newest.id}` : "",
          ].filter(Boolean),
        };
      case "denied": {
        const decided = newest ? settledAt(newest) : now;
        const until = new Date(decided.getTime() + status.cooldownSeconds * 1_000);
        return {
          kind: "status.denied",
          tone: "warning",
          description: `**No guest access.** Your most recent application was not approved ${when(decided, "R")}.`,
          fields: [
            newest?.reason
              ? { name: "Reason", value: plain(newest.reason, HOUSE_LIMITS.userText) }
              : null,
            {
              name: "Apply again",
              value:
                until > now
                  ? `From ${when(until, "R")}, if applications are open`
                  : "Now, if applications are open",
            },
            roles,
          ],
          footer: newest ? `Application ${newest.id}` : undefined,
        };
      }
      case "closed":
        return {
          kind: "status.closed",
          tone: "neutral",
          description: `**No guest access.** Your most recent application was closed${
            newest ? ` ${when(settledAt(newest), "R")}` : ""
          }.`,
          fields: [
            newest && {
              name: "Application",
              value: Object.hasOwn(CLOSED_WHY, newest.state)
                ? (CLOSED_WHY[newest.state] ?? applicationState(newest.state))
                : applicationState(newest.state),
            },
            roles,
          ],
          footer: newest ? `Application ${newest.id}` : undefined,
        };
      default:
        return {
          kind: "status.none",
          tone: "neutral",
          description:
            "**No guest access on record.**\nRegister your character with /claim to get access automatically, or ask an officer.",
          fields: [roles],
          footer: "FC members receive Member access instead of Guest.",
        };
    }
  })();
  const state = roleJob ? jobMarker(roleJob) : null;
  let tone = headline.tone;
  if (state?.marker === "blocked" || (state?.marker === "failed" && !state.dmBlocked))
    tone = "warning";
  else if (state?.marker === "paused" && tone !== "warning") tone = "pending";
  return card(
    headline.kind,
    {
      tone,
      title: "Your guest access",
      description: headline.description,
      fields: headline.fields.filter((field): field is FieldSpec => Boolean(field)),
      footer: headline.footer,
    },
    options,
  );
}

/** The officer headline for a record's basis ('**Active:** grandfathered grant.'). */
function officerBasis(status: GuestStatusView, basis: Basis): string {
  const newest = status.applications[0];
  switch (basis) {
    case "member_access":
      return "**Member access:** confirmed FC character.";
    case "revoked":
      return `**Removed:** revoked ${when(status.revocation[0]?.changed_at ?? new Date(0), "R")}.`;
    case "granted": {
      const grant = firstGrant(status);
      return `**Active:** ${grant ? worded(GRANT_BASIS, grant.provenance) : "durable grant"}.`;
    }
    case "former":
      return "**Active:** former FC member.";
    case "registered":
      return "**Active:** registered character outside the FC.";
    case "waiting_roster":
      return "**Waiting:** registered character, roster check needed.";
    case "uncertain":
      return "**Being checked:** FC membership is uncertain.";
    case "pending":
      return "**Awaiting review:** application pending.";
    case "denied":
      return `**No access:** application denied${newest ? ` ${when(settledAt(newest), "R")}` : ""}.`;
    case "closed":
      return "**No access:** latest application closed.";
    default:
      return "**No guest access on record.**";
  }
}

/** Grants as the officer record lists them: the newest five in order, reasons quoted. */
function grantsValue(status: GuestStatusView): string {
  const shown = status.grants.slice(0, MAX_RECORD_ROWS).reverse();
  const earlier = status.grants.length - shown.length;
  const more = earlier > 0 ? `…and ${earlier} earlier` : null;
  // Budget each grant's share of the field, so every shown grant keeps a readable reason.
  const room = DISCORD_LIMITS.fieldValue - (more ? more.length + 1 : 0) - (shown.length - 1);
  const share = Math.floor(room / Math.max(1, shown.length));
  const lines = shown.map((grant) => {
    const head = `${grantProvenance(grant.provenance)} · ${when(grant.created_at, "f")}`;
    const reason = grant.reason?.trim()
      ? quote(grant.reason, Math.max(0, Math.min(HOUSE_LIMITS.userText, share - head.length - 1)))
      : "";
    return reason ? `${head}\n${reason}` : head;
  });
  return [more, ...lines].filter((line): line is string => Boolean(line)).join("\n");
}

/** A Discord message link for a posted review message, built only from decimal IDs. */
function reviewLink(row: ApplicationStatusRow): string | null {
  const decimal = /^[1-9][0-9]{0,19}$/u;
  if (
    !row.message_id ||
    ![row.guild_id, row.channel_id, row.message_id].every((id) => decimal.test(id))
  )
    return null;
  return link(
    "review message",
    `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`,
  );
}

/** One application in the officer record: short ID, state, when, who and the review message. */
function applicationLine(row: ApplicationStatusRow): string {
  const who =
    row.state === "pending"
      ? ""
      : row.reviewer_id
        ? ` by ${mentionUser(row.reviewer_id)}`
        : " automatically";
  const jump = reviewLink(row);
  return `${code(shortId(row.id))} ${applicationState(row.state)} ${when(settledAt(row), "R")}${who}${jump ? ` · ${jump}` : ""}`;
}

/** Role IDs a succeeded role update added and removed, from its stored result. */
function roleDelta(job: JobView): string {
  if (job.kind !== "reconcile.user" || job.status !== "succeeded") return "";
  const result: unknown = job.result;
  if (typeof result !== "object" || result === null) return "";
  const ids = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string" && /^[1-9][0-9]{0,19}$/u.test(id))
      : [];
  const added = "add" in result ? ids(result.add).map((id) => `+${mentionRole(id)}`) : [];
  const removed = "remove" in result ? ids(result.remove).map((id) => `−${mentionRole(id)}`) : [];
  return [...added, ...removed].join(" ");
}

/** An officer delivery line: the approved job line, with a role update's delta on its first line. */
function deliveryLine(job: JobView, viewer: Viewer): string {
  const line = jobLine(job, viewer);
  const delta = roleDelta(job);
  if (!delta) return line;
  const split = line.indexOf("\n");
  return split < 0
    ? `${line} · ${delta}`
    : `${line.slice(0, split)} · ${delta}${line.slice(split)}`;
}

/** The newest delivery of each kind: what the record's delivery health rests on. */
function newestPerKind(jobs: readonly JobView[]): JobView[] {
  const seen = new Set<string>();
  return jobs.filter((job) => !seen.has(job.kind) && Boolean(seen.add(job.kind)));
}

/** A registered character's standing, as the officer record's inline field states it. */
function registeredValue(status: GuestStatusView): string {
  if (!status.registered) return "Not eligible";
  if (status.verifiedGuestEligible) return "Eligible: registered outside the FC";
  if (status.membership === "member") return "In the FC (gives Member)";
  if (status.membership === "uncertain") return "Being checked";
  if (!status.rosterFresh) return "Waiting for a roster check";
  return "Registered, but Guest is revoked";
}

/**
 * Another member's record for an officer ('Guest access · member record', approved guests#7):
 * every basis at once, the newest five grants and applications, the latest three deliveries as
 * officer job lines, and Full details (JSON) for the rest. The tone is info; a blocked or failed
 * delivery (other than a DM the applicant's settings refused) makes it warning, and a paused one
 * pending, each with a next step.
 */
function officerStatus(
  status: GuestStatusView,
  viewer: Viewer,
  options: GuestStatusOptions,
): Presented {
  const owner = options.owner;
  const basis = basisOf(status);
  const health = newestPerKind(status.delivery).map((job) => ({ job, state: jobMarker(job) }));
  const troubled = health.filter(
    ({ state }) => state.marker === "blocked" || (state.marker === "failed" && !state.dmBlocked),
  );
  const held = troubled.length === 0 && health.some(({ state }) => state.marker === "paused");
  const tone: Tone = troubled.length ? "warning" : held ? "pending" : "info";
  const attention = troubled.length
    ? troubled.some(({ job }) => job.kind === "reconcile.user")
      ? " **Role delivery needs attention.**"
      : " **A delivery needs attention.**"
    : "";
  const revocation = status.revocation[0];
  const deliveries = status.delivery.slice(0, MAX_DELIVERIES);
  // With effects live, nothing else resumes a `disabled` row left from an earlier pause, so the
  // record never promises an activation; a /config change requeues parked work (requeueParked),
  // as the ledger officer views say.
  const nextStep = troubled.length
    ? "Run /config validate, fix the permission or role order it reports, then run /refresh."
    : held
      ? status.effectsMode === "deployment_disabled"
        ? "Discord changes are off for this deployment. Nothing to fix here."
        : status.effectsMode === "live"
          ? "Held from an earlier pause; saving any setting with `/config` re-queues it."
          : "Role changes start after activation. Nothing to fix."
      : null;
  const fields: (FieldSpec | false | null)[] = [
    {
      name: status.grants.length ? `Grants (${status.grants.length})` : "Grants",
      value: status.grants.length ? grantsValue(status) : "None",
    },
    {
      name: "Revocation",
      value: revocation?.revoked
        ? [
            `Revoked ${when(revocation.changed_at, "f")}`,
            revocation.reason?.trim() && quote(revocation.reason, HOUSE_LIMITS.userText),
          ]
            .filter(Boolean)
            .join("\n")
        : "None",
      inline: true,
    },
    {
      name: "Former FC member",
      value: status.formerMember[0]?.eligible ? "Yes" : "No",
      inline: true,
    },
    { name: "Registered character", value: registeredValue(status), inline: true },
    status.membership !== "ineligible" && {
      name: "FC membership",
      value: status.membership === "member" ? "Confirmed member (gives Member)" : "Being checked",
      inline: true,
    },
    {
      name: status.applications.length
        ? `Applications (${status.applications.length})`
        : "Applications",
      value: status.applications.length
        ? list(status.applications.map(applicationLine), {
            max: MAX_RECORD_ROWS,
            more: (hidden) => `…and ${hidden} earlier`,
          })
        : "None",
    },
    deliveries.length > 0 && {
      name: `Deliveries (latest ${deliveries.length})`,
      value: list(
        deliveries.map((job) => deliveryLine(job, viewer)),
        { max: MAX_DELIVERIES },
      ),
    },
    nextStep !== null && { name: "Next step", value: nextStep },
  ];
  return card(
    troubled.length ? "status.officer_attention" : "status.officer",
    {
      tone,
      title: "Guest access · member record",
      description: [
        `${mentionUser(owner)} · ${code(owner)}`,
        `${officerBasis(status, basis)}${attention}`,
      ],
      fields: fields.filter((field): field is FieldSpec => Boolean(field)),
      footer: ["Officer view", "Grants last until /guest revoke or /guest reset"],
      buttons: [detailsButton({ action: "guest", userId: owner })],
    },
    options,
  );
}

/**
 * /guest status. The officer record view applies only when an officer gave the member option;
 * everyone else, including an officer looking at their own record, gets the member view. The
 * service has already refused a member naming someone else ('Only your own records').
 */
export function guestStatusReply(
  status: GuestStatusView,
  viewer: Viewer,
  options: GuestStatusOptions,
): Presented {
  if (isOfficer(viewer) && options.memberOption) return officerStatus(status, viewer, options);
  // The member view uses member wording even for an officer's own record.
  return memberStatus(status, { ...viewer, audience: "member" }, options);
}

// ---------------------------------------------------------------------------------------------
// /guest grant and revoke

/** The approved revoke footer: what a revocation overrides and what it leaves alone. */
const REVOKE_FOOTER = [
  "Audited",
  "Overrides approved, manual, imported and grandfathered grants",
  "FC Member access is not affected",
] as const;

/**
 * /guest grant (approved guests#10) and /guest revoke (#11, success like every committed removal).
 * The Role update field reads 'Queued' while Discord changes are live, 'Applies when they join'
 * for someone not in the server, and says so plainly when no Guest role is set; a grant with no
 * Guest role to apply is warning with the command that fixes it. Paused effects give the approved
 * paused-save card, keeping the member and reason.
 */
export function guestActionReply(
  result: GuestActionResult,
  viewer: Viewer,
  options: GuestReplyOptions = {},
): Presented {
  const grant = result.status === "granted";
  const who = mentionUser(result.user);
  const memberField: FieldSpec = {
    name: "Member",
    value: member(result.user, viewer, "stacked"),
    inline: true,
  };
  const reasonField: FieldSpec = {
    name: "Reason",
    value: plain(result.reason, HOUSE_LIMITS.userText),
  };
  const footer: readonly string[] = grant
    ? ["Audited", `Check delivery with /guest status member:${result.user}`]
    : REVOKE_FOOTER;
  const saved = grant
    ? `${who} now has a durable Guest grant${result.restored ? ", and the earlier revocation is lifted" : ""}.`
    : `${who} loses Guest until an officer grants it again.${
        result.cancelledApplications > 0 ? " Any pending guest application was cancelled." : ""
      }`;
  if (grant && !result.guestRoleConfigured)
    return card(
      "grant.no_role",
      {
        tone: "warning",
        title: "Guest access granted",
        description: `${saved} No Guest role is set, so TaruBot can't apply it yet.`,
        fields: [
          memberField,
          { name: "Role update", value: "Not applied: no Guest role is set", inline: true },
          reasonField,
          {
            name: "Next step",
            value: `Set the Guest role with ${cmd("config roles guest", { role: "@Guest" })}. The grant applies automatically then.`,
          },
        ],
        footer,
      },
      options,
    );
  if (paused(result.effectsMode)) {
    const held = pausedSave(result.effectsMode, viewer);
    return card(
      "action.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${saved} ${held.sentence}`,
        fields: [...held.fields, memberField, reasonField],
        // The approved #26 footer: every paused-save card points to /sync status.
        footer: held.footer,
      },
      options,
    );
  }
  const roleUpdate = !result.present
    ? grant
      ? "Applies when they join"
      : "Applies if they rejoin"
    : !result.guestRoleConfigured
      ? "No Guest role is set, so there's none to remove"
      : "Queued";
  const description = grant
    ? result.present
      ? `${saved} Their roles update shortly.`
      : `${saved} It applies when they join the server.`
    : saved;
  return card(
    grant
      ? !result.present
        ? "grant.absent"
        : result.restored
          ? "grant.restored"
          : "grant.granted"
      : "revoke.revoked",
    {
      tone: "success",
      title: grant ? "Guest access granted" : "Guest access revoked",
      description,
      fields: [memberField, { name: "Role update", value: roleUpdate, inline: true }, reasonField],
      footer,
    },
    options,
  );
}

/**
 * /guest reset (owner decision, 2026-09-24): the revocation lifted and every grant ended, so FC
 * membership and registered characters decide Guest again. Success like every committed removal;
 * nothing to remove is the info '= NO CHANGE' card, and paused effects give the paused-save card.
 * The Removed field names what went, by the same provenance labels /guest status uses.
 */
export function guestResetReply(
  result: GuestResetResult,
  viewer: Viewer,
  options: GuestReplyOptions = {},
): Presented {
  const who = mentionUser(result.user);
  const memberField: FieldSpec = {
    name: "Member",
    value: member(result.user, viewer, "stacked"),
    inline: true,
  };
  const reasonField: FieldSpec = {
    name: "Reason",
    value: plain(result.reason, HOUSE_LIMITS.userText),
  };
  if (result.status === "unchanged")
    return card(
      "reset.unchanged",
      {
        tone: "info",
        title: "No Guest overrides to remove",
        description: `${marker("unchanged")} ${who} has no Guest revocation or grant, so FC membership and registered characters already decide.`,
        fields: [memberField],
      },
      options,
    );
  const removed = [
    result.revocationLifted && "Revocation lifted",
    ...result.grantsEnded.map((provenance) => `Grant ended: ${grantProvenance(provenance)}`),
  ].filter((line): line is string => Boolean(line));
  const saved = `${who}'s Guest overrides are removed. FC membership and registered characters now decide their Guest access.`;
  const removedField: FieldSpec = { name: "Removed", value: removed.join("\n") };
  if (paused(result.effectsMode)) {
    const held = pausedSave(result.effectsMode, viewer);
    return card(
      "reset.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${saved} ${held.sentence}`,
        fields: [...held.fields, memberField, removedField, reasonField],
        footer: held.footer,
      },
      options,
    );
  }
  const roleUpdate = !result.present
    ? "Applies if they rejoin"
    : result.guestRoleConfigured
      ? "Queued"
      : "No Guest role is set";
  return card(
    "reset.reset",
    {
      tone: "success",
      title: "Guest access reset",
      description: saved,
      fields: [
        memberField,
        { name: "Role update", value: roleUpdate, inline: true },
        removedField,
        reasonField,
      ],
      footer: ["Audited as guest.reset", "Ended grants stay in the history"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /guest approve and deny, and the review buttons

/** Where a decision came from: the slash command, or a review message button. */
export interface DecisionReplyOptions extends GuestReplyOptions {
  readonly via: "command" | "button";
}

/** Each decided state's title and tone; committed approvals and denials are success. */
const DECIDED: Readonly<Record<ApplicationState, { readonly tone: Tone; readonly title: string }>> =
  {
    pending: { tone: "info", title: "Already decided" },
    approved: { tone: "success", title: "Application approved" },
    denied: { tone: "success", title: "Application denied" },
    cancelled: { tone: "info", title: "Application closed · applicant left" },
    superseded: { tone: "info", title: "Application no longer needed" },
  };

/** Why a decision closed the application instead of approving or denying it. */
const CLOSED_INSTEAD: Readonly<Partial<Record<ApplicationState, string>>> = {
  cancelled:
    "The applicant left or rejoined the server after applying, so the application was cancelled instead. No access was granted and no DM was sent.",
  superseded:
    "The applicant now qualifies through an FC or registered character, so the application was closed without a guest grant.",
};

/** A stored state as the 'Already decided' sentence names it. */
const STATE_WORD: Readonly<Record<ApplicationState, string>> = {
  pending: "pending",
  approved: "approved",
  denied: "denied",
  cancelled: "cancelled",
  superseded: "closed as no longer needed",
};

/**
 * /guest approve and deny (guests#13–#17) and the review buttons (#19), one presenter for all five
 * outcomes. Approved and denied are success; a decision that cancelled the application (the
 * applicant left) or found it superseded, and a repeat on an already decided application, are
 * info. Button presses answer briefly, 'Recorded. The review message updates shortly.', since the
 * review message itself shows the outcome; nothing claims the message or DM was sent. The denial
 * reason is labelled as sent to the applicant and capped at 300 characters. Paused effects give
 * the paused-save card, which says the review message and DM wait too.
 */
export function decisionReply(
  result: DecisionResult,
  viewer: Viewer,
  options: DecisionReplyOptions,
): Presented {
  const command = options.via === "command";
  const applicant: FieldSpec = {
    name: "Applicant",
    value: member(result.userId, viewer, "stacked"),
    inline: true,
  };
  const application: FieldSpec | null = command
    ? { name: "Application", value: code(result.id) }
    : null;
  if (result.effects === "unchanged" || result.status === "pending") {
    const reviewer = result.reviewerId ? ` by ${mentionUser(result.reviewerId)}` : " automatically";
    return card(
      "decision.already",
      {
        tone: "info",
        title: "Already decided",
        description: `This application was already **${STATE_WORD[result.status]}**${
          result.decidedAt ? ` ${when(result.decidedAt, "R")}` : ""
        }${result.status === "pending" ? "" : reviewer}. Nothing was changed.`,
        fields: [applicant, application],
        footer: `See the outcome with /guest status member:${result.userId}`,
      },
      options,
    );
  }
  const denied = result.status === "denied";
  const dm = result.status === "approved" || denied;
  const reason: FieldSpec | null = denied
    ? {
        name: "Reason sent to applicant",
        value: result.reason ? plain(result.reason, HOUSE_LIMITS.userText) : "No reason given",
      }
    : null;
  const footer: string | readonly string[] = !command
    ? "Audited"
    : denied
      ? ["Audited", `The applicant may reapply after ${duration(result.cooldownSeconds)}`]
      : result.status === "approved"
        ? ["Audited", `Check delivery with /guest status member:${result.userId}`]
        : "Audited";
  if (paused(result.effectsMode)) {
    const held = pausedSave(result.effectsMode, viewer);
    const lead = CLOSED_INSTEAD[result.status] ?? `${DECIDED[result.status].title}.`;
    return card(
      "decision.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${lead} ${held.sentence} ${
          dm
            ? "The review message update and the applicant's DM wait until then too."
            : "The review message update waits until then too."
        }`,
        fields: [...held.fields, applicant, application, reason],
        // The approved #26 footer: every paused-save card points to /sync status.
        footer: held.footer,
      },
      options,
    );
  }
  const closedInstead = CLOSED_INSTEAD[result.status];
  const description = closedInstead
    ? `${closedInstead} The review message updates shortly.`
    : !command
      ? "Recorded. The review message updates shortly."
      : result.status === "approved"
        ? "The Guest role, the review message update and the applicant's DM are queued."
        : result.reason
          ? "The review message update and the applicant's DM (including your reason) are queued."
          : "The review message update and the applicant's DM are queued.";
  const kind: GuestReplyKind = closedInstead
    ? result.status === "cancelled"
      ? "decision.cancelled"
      : "decision.superseded"
    : !command
      ? "decision.button"
      : denied
        ? "decision.denied"
        : "decision.approved";
  return card(
    kind,
    {
      tone: DECIDED[result.status].tone,
      title: DECIDED[result.status].title,
      description,
      fields: [applicant, application, reason],
      footer,
    },
    options,
  );
}

/**
 * One officer autocomplete choice for /guest approve and deny: '<display name or user ID> ·
 * submitted YYYY-MM-DD · <short ID>' in plain text within 100 characters, whose value is the full
 * application UUID. The display name comes from the member cache only (no request inside
 * Discord's autocomplete window) and is cut to 60 characters on a grapheme boundary.
 */
export function applicationChoice(
  row: ApplicationChoiceRow,
  displayName: string | null | undefined,
): ApplicationCommandOptionChoiceData<string> {
  const who = cut(displayName?.trim() || row.user_id, 60);
  return choice(
    `${who} · submitted ${row.created_at.toISOString().slice(0, 10)} · ${shortId(row.id)}`,
    row.id,
  );
}

// ---------------------------------------------------------------------------------------------
// The review message and the decision DM

/**
 * Every review message and decision DM kind. Each is stamped from the stored record, never the
 * send time, so a repair or retry redraws the same message: the review message with when the
 * application was submitted, the DM with when it was decided (reply specs guests#29–#32).
 */
const POST_TIMESTAMP = {
  "review.pending": true,
  "review.legacy": true,
  "review.approved": true,
  "review.denied": true,
  "review.cancelled": true,
  "review.superseded": true,
  "dm.approved": true,
  "dm.denied": true,
} as const satisfies Record<string, boolean>;

/** A review message or decision DM state; tests catalogue one case per kind. */
export type GuestPostKind = keyof typeof POST_TIMESTAMP;

/** Every review message and DM kind, for catalog completeness checks. */
export const GUEST_POST_KINDS = Object.keys(POST_TIMESTAMP) as readonly GuestPostKind[];

/** The review message's title suffix and tone for each stored state. */
const REVIEW_STATE: Readonly<
  Record<ApplicationState, { readonly suffix: string | null; readonly tone: Tone }>
> = {
  pending: { suffix: null, tone: "pending" },
  approved: { suffix: "approved", tone: "success" },
  denied: { suffix: "denied", tone: "warning" },
  cancelled: { suffix: "cancelled", tone: "neutral" },
  superseded: { suffix: "no longer needed", tone: "info" },
};

/** A stored state's review wording; a state from a newer release shows raw, as info. */
function reviewState(state: string): { readonly suffix: string | null; readonly tone: Tone } {
  return Object.hasOwn(REVIEW_STATE, state)
    ? (REVIEW_STATE[state as ApplicationState] ?? { suffix: state, tone: "info" })
    : { suffix: state, tone: "info" };
}

/**
 * Who decided and when, in the words of reply spec guests#30. An officer's decision names them;
 * a cancellation or closure without a reviewer happened automatically, and says why. A
 * cancellation with a reviewer (a guest revocation, or a decision that found the applicant gone)
 * names the officer without guessing which.
 */
function decisionValue(application: ApplicationRecord): string {
  const at = application.decided_at ? ` ${when(application.decided_at, "R")}` : "";
  const by = application.reviewer_id ? ` by ${mentionUser(application.reviewer_id)}` : "";
  switch (application.state) {
    case "approved":
      return `Approved${by}${at}`;
    case "denied":
      return `Denied${by}${at}`;
    case "cancelled":
      return by
        ? `Cancelled${by}${at}`
        : `Cancelled automatically${at}: applicant left or rejoined`;
    case "superseded":
      return by
        ? `Closed${by}${at}: applicant already qualifies`
        : `Closed automatically${at}: applicant now qualifies through the FC or a registered character`;
    default:
      return `${applicationState(application.state)}${by}${at}`;
  }
}

/**
 * The review message in the officers' review channel (reply specs guests#29 and #30, and the
 * legacy gap): one embed that replaces the pre-2.14.0 text plus 'Applicant answers' embed.
 * 'Guest application' while pending, with when the applicant joined and Approve and Deny; once
 * decided, 'Guest application · approved' (or denied, cancelled, no longer needed) with who
 * decided, any reason, and both buttons disabled. The answers stay visible after a decision, so
 * the record stays with the review; each is escaped whole (300 characters at most, so escaping
 * keeps it within a field). A legacy application from before the form keeps 'Submitted before
 * application forms were introduced.' instead of answers. Officer-authored reasons are capped at
 * 300 characters. The mention never pings (every post sends allowedMentions {parse: []}).
 */
export function guestReviewPost(application: ApplicationRecord): Presented {
  const pending = application.state === "pending";
  const legacy = application.introduction === null || application.interest === null;
  const state = reviewState(application.state);
  const reason = application.reason?.trim();
  return post({
    tone: state.tone,
    title: title("Guest application", state.suffix),
    description: [
      `${mentionUser(application.user_id)} applied for Guest access.${
        pending ? " Officer review is required; submitting the form does not grant access." : ""
      }`,
      legacy && "Submitted before application forms were introduced.",
    ],
    fields: [
      {
        name: "Applicant",
        value: `${mentionUser(application.user_id)}\n${code(application.user_id)}`,
        inline: true,
      },
      pending && { name: "Joined server", value: when(application.joined_at, "R"), inline: true },
      { name: "Submitted", value: when(application.created_at, "R"), inline: true },
      !pending && { name: "Decision", value: decisionValue(application) },
      !pending && reason ? { name: "Reason", value: plain(reason, HOUSE_LIMITS.userText) } : null,
      application.introduction !== null && {
        name: "Introduce yourself",
        value: plain(application.introduction),
      },
      application.interest !== null && {
        name: "Why join this server?",
        value: plain(application.interest),
      },
    ],
    footer: `Application ${application.id}`,
    // Every review kind is stamped (POST_TIMESTAMP) with the submission, so redraws match.
    timestamp: application.created_at,
    buttons: reviewButtons(application.id, !pending),
  });
}

/** What the decision DM needs besides the application. */
export interface DecisionDmOptions {
  /** The reapply cooldown (GUEST_COOLDOWN_SECONDS), for when a denied applicant may apply again. */
  readonly cooldownSeconds: number;
  /** The server's name from the client cache, or null when it isn't cached. */
  readonly serverName: string | null;
}

/**
 * The DM an applicant receives once officers decide (reply specs guests#31 and #32), in words
 * for the applicant: no guild, user or application internals beyond the footer's application ID.
 * Approved is success, 'Your guest application was approved'; denied is warning, 'Your guest
 * application was not approved', with the officers' reason (the one reason an applicant reads,
 * C6, capped at 300 characters, or 'No reason was given.') and when they may apply again. The
 * server is named in bold when the client has it cached, or 'the server where you applied'. Only
 * approved and denied applications send a DM; the dispatcher refuses any other state.
 */
export function decisionDm(application: ApplicationRecord, options: DecisionDmOptions): Presented {
  const server = options.serverName?.trim()
    ? `**${plain(options.serverName, DISCORD_LIMITS.fieldName)}**`
    : "the server where you applied";
  // Both DM kinds are stamped (POST_TIMESTAMP) with the decision, so a retried DM matches.
  const decidedAt = application.decided_at ?? application.created_at;
  const footer = `Application ${application.id}`;
  if (application.state === "approved")
    return post({
      tone: "success",
      title: "Your guest application was approved",
      description: `You now have Guest access in ${server}. Your roles update shortly.`,
      footer,
      timestamp: decidedAt,
    });
  const reason = application.reason?.trim();
  const reapply = new Date(decidedAt.getTime() + options.cooldownSeconds * 1_000);
  return post({
    tone: "warning",
    title: "Your guest application was not approved",
    description: `Officers reviewed your application for ${server}.`,
    fields: [
      {
        name: "Reason",
        value: reason ? plain(reason, HOUSE_LIMITS.userText) : "No reason was given.",
      },
      {
        name: "Apply again",
        value:
          options.cooldownSeconds > 0
            ? `From ${when(reapply, "R")}, if applications are open`
            : "Any time, if applications are open",
      },
    ],
    footer,
    timestamp: decidedAt,
  });
}
