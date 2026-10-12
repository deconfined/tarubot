/**
 * Moderation presenters (2.45.0, owner decision 3): /moderate block and lift receipts, and the
 * status card, for the paused person's own view and for an officer who can see pauses. Each renders
 * a typed result from src/application/moderation.ts for its viewer. Failures are never caught
 * here: the router's failure presenter renders them, including the card a paused person is shown
 * when they use the feature (failure.ts, forbidden.blocked).
 *
 * What each audience may read (owner decision Q5 A): a paused person sees the feature, when the
 * pause ends and the reason, and never who set it, so the self view of a status carries no issuer
 * (the service leaves it out, and this file ignores it if a row carries one). Officers who can see
 * pauses read who set each one, at what level, and the newest ended ones with how they ended. A
 * reason is officer-written text up to 1,000 characters shown to the paused person, so every one
 * goes through plain() and is cut to the house user-text limit in a field.
 *
 * None of these cards uses the paused-effects marker (that is "Discord changes are off"), none
 * carries an embed timestamp, and a lift that found nothing to lift is the info "= NO CHANGE" card.
 * Pure.
 */
import type {
  BlockResult,
  LiftResult,
  PauseStatus,
  PauseView,
} from "../../application/moderation.js";
import { featureLabel, PAUSE_DURATIONS } from "../../domain/moderation.js";
import { PERMISSIONS, type PermissionId } from "../../domain/rbac.js";
import type { Viewer } from "./audience.js";
import { cmd, count, list, member, mentionUser, plain, when } from "./format.js";
import { type FieldSpec, type Presented, reply, type ReplySpec } from "./reply.js";
import { HOUSE_LIMITS, marker } from "./style.js";

/**
 * Every moderation reply kind, with whether its embed carries a timestamp: none do, since every
 * time the cards show is a Discord timestamp of a stored value. The reply catalog must cover every
 * kind.
 */
const TIMESTAMP = {
  "block.paused": false,
  "block.forever": false,
  "block.many": false,
  "block.replaced": false,
  "lift.lifted": false,
  "lift.many": false,
  "lift.none": false,
  "lift.held": false,
  "status.self": false,
  "status.self_clear": false,
  "status.officer": false,
  "status.officer_clear": false,
} as const satisfies Record<string, boolean>;

/** A moderation reply state; tests catalogue one case per kind. */
export type ModerationReplyKind = keyof typeof TIMESTAMP;

/** Every moderation reply kind, for catalog completeness checks. */
export const MODERATION_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly ModerationReplyKind[];

/** Build a moderation reply of `kind`, stamping it only when its card does. */
function card(kind: ModerationReplyKind, spec: Omit<ReplySpec, "timestamp">): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? new Date() : null });
}

/** The pause's end as officers and members read it: relative and absolute, or that it has none. */
const endsAt = (until: Date | null): string =>
  until ? `${when(until, "f")} (${when(until, "R")})` : PAUSE_DURATIONS.forever.label;

/** Features as a bulleted list that always fits a field. */
const featureList = (ids: readonly PermissionId[]): string =>
  list(ids.map((id) => `• ${featureLabel(id)}`));

/** The feature, or the number of features, a sentence names. */
const features = (ids: readonly PermissionId[]): string =>
  ids.length === 1 && ids[0] !== undefined
    ? `**${featureLabel(ids[0])}**`
    : count(ids.length, "feature");

// ---------------------------------------------------------------------------------------------
// /moderate block

/** A pause that was set: what the service returned, and the reason the officer wrote. */
export interface BlockReceipt extends BlockResult {
  readonly reason: string;
}

/**
 * /moderate block: the pause is saved (success, like every committed change). It names the member,
 * what they can't use and until when, says plainly that the member is shown the feature, the end
 * and this reason but never who set it, and that nothing else about them changed. A feature that
 * was already paused is listed as replaced, since the new end and reason take its place.
 */
export function blockReply(receipt: BlockReceipt, viewer: Viewer): Presented {
  const who = mentionUser(receipt.target);
  const kind: ModerationReplyKind =
    receipt.replaced.length > 0
      ? "block.replaced"
      : receipt.permissions.length > 1
        ? "block.many"
        : receipt.until === null
          ? "block.forever"
          : "block.paused";
  const until = receipt.until ? `until ${when(receipt.until, "f")}` : "until the pause is lifted";
  return card(kind, {
    tone: "success",
    title: "Use paused",
    description: `${who} can't use ${features(receipt.permissions)} ${until}. Their Discord roles are untouched.`,
    fields: [
      { name: "Member", value: member(receipt.target, viewer, "stacked"), inline: true },
      { name: "Ends", value: endsAt(receipt.until), inline: true },
      receipt.permissions.length > 1 && {
        name: "Features",
        value: featureList(receipt.permissions),
      },
      receipt.replaced.length > 0 && {
        name: "Replaced",
        value: `These were already paused; the new end and reason take their place.\n${featureList(receipt.replaced)}`,
      },
      { name: "Reason", value: plain(receipt.reason, HOUSE_LIMITS.userText) },
      {
        name: "What they see",
        value:
          "The feature, when it ends and this reason. They are never told who paused them. What they already posted or opened stays.",
      },
      {
        name: "To lift it early",
        value: cmd("moderate lift", { member: receipt.target }),
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// /moderate lift

/** Pauses that ended: what the service returned, the reason, and what the actor couldn't lift. */
export interface LiftReceipt extends LiftResult {
  readonly reason: string;
  /**
   * Pauses a server manager set that the actor, not being one, left in place. Only "all features"
   * knows them, because it reads the person's pauses first.
   */
  readonly managerSet?: readonly PermissionId[] | undefined;
}

/**
 * /moderate lift: the pause is over (success), or nothing was paused (the info "= NO CHANGE"
 * card, which says why: nothing was paused, or only server managers can lift what is). A request
 * that lifted some and not others lists the rest; the card never claims more than was lifted.
 */
export function liftReply(receipt: LiftReceipt, viewer: Viewer): Presented {
  const who = mentionUser(receipt.target);
  const held = receipt.managerSet ?? [];
  if (receipt.lifted.length === 0) {
    const sentence =
      held.length > 0
        ? `${who}'s ${held.length === 1 ? "pause was" : "pauses were"} set by a server manager, so only a server manager can lift ${held.length === 1 ? "it" : "them"}.`
        : receipt.notPaused.length > 0
          ? `${who} has no pause on ${features(receipt.notPaused)}, so nothing changed.`
          : `${who} has nothing paused, so nothing changed.`;
    return card(held.length > 0 ? "lift.held" : "lift.none", {
      tone: "info",
      title: "Nothing to lift",
      description: `${marker("unchanged")} ${sentence}`,
      fields: [
        { name: "Member", value: member(receipt.target, viewer, "stacked"), inline: true },
        held.length > 0 && { name: "Set by a server manager", value: featureList(held) },
      ],
    });
  }
  const many = receipt.lifted.length > 1;
  return card(many ? "lift.many" : "lift.lifted", {
    tone: "success",
    title: many ? "Pauses lifted" : "Pause lifted",
    description: `${who} can use ${features(receipt.lifted)} again.`,
    fields: [
      { name: "Member", value: member(receipt.target, viewer, "stacked"), inline: true },
      many && { name: "Lifted", value: featureList(receipt.lifted) },
      receipt.notPaused.length > 0 && {
        name: "Weren't paused",
        value: featureList(receipt.notPaused),
      },
      held.length > 0 && {
        name: "Left in place",
        value: `A server manager set these, so only a server manager can lift them.\n${featureList(held)}`,
      },
      { name: "Reason", value: plain(receipt.reason, HOUSE_LIMITS.userText) },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// /moderate status

/** What an officer reads for the level a pause was set at. */
const LEVEL = { manager: "server manager", moderator: "officer" } as const;

/** How many ended pauses the card lists before "…and N more". */
const MAX_ENDED = 5;

/** The longest part of a lift reason an ended line quotes. */
const ENDED_REASON = 80;

/**
 * One active pause as a field. Everyone sees the feature, the end and the reason; only an officer
 * view names who set it. The service already leaves the issuer out of a person's own view, and
 * this does not rely on that: `issuer` is false there whatever the row carries (decision Q5 A).
 */
function pauseField(pause: PauseView, issuer: boolean): FieldSpec {
  const by = issuer ? pause.by : undefined;
  return {
    name: featureLabel(pause.permission),
    value: [
      pause.until ? `Until ${endsAt(pause.until)}` : "Until an officer lifts it",
      `Reason: ${plain(pause.reason, HOUSE_LIMITS.userText)}`,
      by &&
        `Set by ${mentionUser(by.userId)} (${LEVEL[by.level]}) on ${when(pause.createdAt, "d")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  };
}

/** One ended pause, newest first: how it ended, and the lift reason officers wrote. */
function endedLine(pause: PauseView): string {
  const ended = pause.ended;
  const how = !ended
    ? "ended"
    : ended.by
      ? `lifted by ${mentionUser(ended.by)} ${when(ended.at, "d")}`
      : `ran out ${when(ended.at, "d")}`;
  const why = ended?.reason ? ` · ${plain(ended.reason, ENDED_REASON)}` : "";
  return `**${featureLabel(pause.permission)}** · ${how}${why}`;
}

/**
 * How a paused person is told to reach the officers about `paused`, the features paused for them:
 * `modmail` when /modmail is theirs to use, `ask` otherwise. /modmail needs the Member or Guest
 * role, which holding a member-tier feature (/suggest, My roles, the ledger) implies; the baseline
 * features (/claim, /refresh, /apply, /issue) are used by lobby newcomers who hold neither, and
 * someone whose opening of cases is itself paused can't open one. So it is offered only when some
 * paused feature is member-tier and opening cases is not among them. Read from the permission
 * catalog's tiers, not a list kept here.
 */
export function reachOfficers(paused: readonly PermissionId[]): "modmail" | "ask" {
  if (paused.includes("modmail.open")) return "ask";
  return paused.some((id) => PERMISSIONS[id].tier === "member") ? "modmail" : "ask";
}

/**
 * /moderate status. A person's own view (`status.self`) lists what is paused for them in the
 * second person, with the end and the reason and never who set it, and says how to reach the
 * officers (reachOfficers): /modmail where they can use it, an officer in the server otherwise. An
 * officer's view of someone else names the member, lists each active pause with who set it and
 * when, and the newest ended ones. Read-only, so info tone.
 */
export function statusReply(status: PauseStatus, viewer: Viewer): Presented {
  const active = status.active;
  if (status.self) {
    if (active.length === 0)
      return card("status.self_clear", {
        tone: "info",
        title: "Nothing is paused for you",
        description: "None of TaruBot's features are paused for you here.",
      });
    const way = reachOfficers(active.map((pause) => pause.permission));
    return card("status.self", {
      tone: "info",
      title: "What's paused for you",
      description: [
        `Your use of ${count(active.length, "feature")} here is paused.`,
        way === "modmail"
          ? "Use **/modmail** to reach the officers."
          : "Ask an officer in the server.",
      ].join(" "),
      fields: active.map((pause) => pauseField(pause, false)),
    });
  }
  const who = member(status.subject, viewer);
  const earlier: FieldSpec[] = status.ended.length
    ? [
        {
          name: "Earlier",
          value: list(status.ended.map(endedLine), { max: MAX_ENDED }),
        },
      ]
    : [];
  if (active.length === 0)
    return card("status.officer_clear", {
      tone: "info",
      title: "Nothing is paused for this member",
      description: `${who} has no active pauses.`,
      fields: earlier,
    });
  return card("status.officer", {
    tone: "info",
    title: "Pauses for this member",
    description: `${who} has ${count(active.length, "active pause")}.`,
    fields: [...active.map((pause) => pauseField(pause, true)), ...earlier],
  });
}
