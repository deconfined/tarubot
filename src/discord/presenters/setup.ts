/**
 * /setup onboarding's dry run and /setup overrides (2.35.0, #46). Both subcommands are dry runs
 * unless confirm:true; `/setup onboarding confirm:true` keeps its approved receipt (setupReply in
 * configuration.ts). Pure; the clock is injected for embed timestamps.
 *
 * The overrides reply puts what the server owner must fix in Discord first, so denied channels and
 * private categories never read as an all-clear: its fields come in a pinned order (Blockers, then
 * the denied channels, the private categories, the permissions to grant before removing
 * Administrator, the write groups, the channels that stop being synced, what wasn't changed, the
 * held work a real run queued again, and next steps), each only when it has something to say. Planned or made writes are grouped by what
 * they write; the groups get the fields the others leave (at least one), and the rest merge into
 * one "Other changes" field, so a production-sized server stays within ten fields with nothing
 * cut. Lists show six mentions, then "and K more". No health tokens and no new buttons.
 */
import type {
  OverridesBlocker,
  OverridesResult,
  OverridesStop,
  OverridesWrite,
} from "../../application/overrides.js";
import type { SetupPlan } from "../../application/setup-plan.js";
import type { PermissionKey } from "../../domain/permissions.js";
import { permissionLabel } from "../../domain/permissions.js";
import type { PrivateCategory } from "../../domain/visibility.js";
import type { Viewer } from "./audience.js";
import { administratorRemoval, heldWork, hiddenByCategoryClause } from "./configuration.js";
import {
  count,
  fcName,
  list,
  mentionChannel,
  mentionRole,
  plain,
  restoreMentions,
  splitFields,
} from "./format.js";
import { reply, type FieldSpec, type Presented, type ReplySpec } from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS, type Tone } from "./style.js";

/**
 * Every setup reply kind, with whether its embed carries a timestamp: dry runs and receipts do,
 * the no-op cards (nothing to add, onboarding manages them) don't. The catalog covers each kind.
 */
const TIMESTAMP = {
  "onboarding.plan": true,
  "onboarding.plan_blocked": true,
  "overrides.plan": true,
  "overrides.plan_blocked": true,
  "overrides.plan_attention": true,
  "overrides.nothing": false,
  "overrides.nothing_attention": false,
  "overrides.onboarding": false,
  "overrides.applied": true,
  "overrides.applied_attention": true,
  "overrides.stopped": true,
} as const satisfies Record<string, boolean>;

/** A setup reply state; tests catalogue one case per kind. */
export type SetupReplyKind = keyof typeof TIMESTAMP;

/** Every setup reply kind, for catalog completeness checks. */
export const SETUP_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly SetupReplyKind[];

/** Options every setup presenter takes. */
export interface SetupReplyOptions {
  /** The current time for embed timestamps; commands omit it, tests inject the mockups' clock. */
  readonly now?: Date | undefined;
}

/** Build a setup reply of `kind`, stamping it only when the kind carries a timestamp. */
function card(
  kind: SetupReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: SetupReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/** Mentions a list shows before 'and K more'. */
const MAX_MENTIONS = 6;
/** Every dry run's closing sentence (C2: read-only results say it). */
const NOTHING_CHANGED = "Nothing was changed.";

/** Items as prose: 'a', 'a and b', 'a, b and c'. */
function prose(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** At most `max` rendered items, then 'K more', as prose. */
function some(items: readonly string[], max = MAX_MENTIONS): string {
  const shown = items.slice(0, max);
  const hidden = items.length - shown.length;
  return prose(hidden > 0 ? [...shown, `${hidden} more`] : shown);
}

/** Channel mentions within the list limit. */
const channels = (ids: readonly string[], max = MAX_MENTIONS): string =>
  some(ids.map(mentionChannel), max);

/**
 * The order replies name permissions in: the posting four, then the deny mask as #46 words it
 * (Read Message History, Manage Permissions, Manage Channels, Create Invite, Connect); anything
 * else keeps the catalog's order after them.
 */
const LABEL_ORDER: readonly PermissionKey[] = [
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "ReadMessageHistory",
  "ManageRoles",
  "ManageChannels",
  "CreateInstantInvite",
  "Connect",
];
const rank = (key: PermissionKey): number => {
  const index = LABEL_ORDER.indexOf(key);
  return index < 0 ? LABEL_ORDER.length : index;
};

/** Permission labels as prose, as the channel's permission screen names them. */
const labels = (keys: readonly PermissionKey[], context: "server" | "channel" = "channel") =>
  prose(
    [...keys]
      .sort((left, right) => rank(left) - rank(right))
      .map((key) => permissionLabel(key, context)),
  );

/** A sentence's first letter in upper case. */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------------------------------------
// /setup overrides

/** The dry run's blocker lines (#46 spec §10), in the order the real run checks. */
const BLOCKER_LINES: Readonly<Record<OverridesBlocker, string>> = {
  caller: "Only someone with Administrator, or the server owner, can run `confirm:true`.",
  effects: "Discord changes are paused here, so `confirm:true` would refuse until they're on.",
  administrator:
    "TaruBot doesn't hold Administrator. Turn it on for TaruBot's role before `confirm:true`, and remove it once `/config validate` says it is no longer needed.",
  base_permissions:
    "Give TaruBot's role View Channel, Send Messages, Embed Links and Read Message History first, so it keeps them once Administrator is off.",
};

/** Why a real run stopped, and that a rerun continues. */
const STOP_LINES: Readonly<Record<OverridesStop, string>> = {
  permissions:
    "Discord refused TaruBot's change in a channel it can't see or manage, so the run stopped there.",
  changed: "A channel changed while the run was writing, so it stopped rather than guess.",
  precondition:
    "Something the run depends on changed: Administrator, TaruBot's role permissions, Discord changes, or this server's settings.",
  time: "The run reached its ten-minute limit.",
  stopping: "TaruBot was shutting down.",
};

/** The attention count N: what the server owner must fix in Discord. */
function attention(result: Exclude<OverridesResult, { status: "onboarding" }>): number {
  const refused = result.status === "applied" || result.status === "stopped" ? result.refused : [];
  return (
    result.denied.length +
    result.privateCategories.length +
    result.grantBeforeRemoving.length +
    refused.length
  );
}

/** Which kind a /setup overrides result renders as. */
export function overridesKind(result: OverridesResult): SetupReplyKind {
  if (result.status === "onboarding") return "overrides.onboarding";
  if (result.status === "stopped") return "overrides.stopped";
  const n = attention(result);
  if (result.status === "plan")
    return result.blockers.length > 0
      ? "overrides.plan_blocked"
      : n > 0
        ? "overrides.plan_attention"
        : "overrides.plan";
  if (result.status === "nothing")
    return n > 0 ? "overrides.nothing_attention" : "overrides.nothing";
  return n > 0 ? "overrides.applied_attention" : "overrides.applied";
}

/** One private category: '<#C> (holds <#L>)', naming at most two configured channels. */
const privateEntry = (category: PrivateCategory): string =>
  `${mentionChannel(category.id)} (holds ${channels(category.configured, 2)})`;

/** The writes that share a field: same kind, bits and inheritance, categories first. */
interface WriteGroup {
  readonly write: OverridesWrite;
  readonly ids: string[];
}

/** Group writes by what they write, categories first, then in order of first appearance. */
function writeGroups(writes: readonly OverridesWrite[]): WriteGroup[] {
  const groups = new Map<string, WriteGroup>();
  const ordered = [
    ...writes.filter((write) => write.kind === "category"),
    ...writes.filter((write) => write.kind !== "category"),
  ];
  for (const write of ordered) {
    const key = [write.kind, write.inherited, write.allow, write.deny, write.cleared].join("|");
    const group = groups.get(key);
    if (group) group.ids.push(write.id);
    else groups.set(key, { write, ids: [write.id] });
  }
  return [...groups.values()];
}

/** One write group's field: what it writes, whether it copies its category, and where. */
function groupField(group: WriteGroup): FieldSpec {
  const { write, ids } = group;
  const noun =
    write.kind === "category"
      ? "Categories"
      : write.inherited
        ? "Synced channels"
        : write.posting
          ? "Posting channels"
          : "Channels";
  const parts = [
    write.allow.length > 0 && `allow ${labels(write.allow)}`,
    write.deny.length > 0 && `deny ${labels(write.deny)}`,
    write.cleared.length > 0 && `lift the ${labels(write.cleared)} deny`,
  ].filter((part): part is string => Boolean(part));
  const what = parts.length > 0 ? `${sentence(parts.join("; "))}.` : "Keep TaruBot's entry.";
  return {
    name: `${noun} (${ids.length})`,
    value: [
      what,
      write.inherited && "They copy their category's entry, so they stay synced.",
      channels(ids),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  };
}

/** The write groups within `slots` fields; the rest merge into one 'Other changes' field. */
function groupFields(writes: readonly OverridesWrite[], slots: number): FieldSpec[] {
  const groups = writeGroups(writes);
  if (groups.length <= slots) return groups.map(groupField);
  const shown = groups.slice(0, Math.max(0, slots - 1));
  const rest = groups.slice(shown.length);
  const merged = rest.reduce((total, group) => total + group.ids.length, 0);
  return [
    ...shown.map(groupField),
    {
      name: "Other changes",
      value: `${count(rest.length, "more group")} of entries in ${count(merged, "channel")}: ${channels(rest.flatMap((group) => group.ids))}`,
    },
  ];
}

/** The overrides result's description: what happened, in at most two sentences. */
function overridesLead(result: OverridesResult, n: number): string {
  if (result.status === "onboarding")
    return `Onboarding manages TaruBot's channel access here, so /setup overrides has nothing to do. ${NOTHING_CHANGED}`;
  if (result.status === "nothing")
    return n > 0
      ? `TaruBot has its own entry everywhere it can add one; what's left below needs fixing in Discord. ${NOTHING_CHANGED}`
      : `TaruBot's own channel entries are already complete. ${NOTHING_CHANGED}`;
  if (result.status === "plan") {
    const w = result.writes.length;
    if (w > 0)
      return `With confirm:true, TaruBot would add its own entry in ${count(w, "channel")}, categories included, so it keeps seeing them once Administrator is off. ${NOTHING_CHANGED}`;
    // Only unreadable channels are left: without Administrator that is why; with it, a fresh read
    // still couldn't see them (as the Not changed line says).
    return result.blockers.includes("administrator")
      ? `TaruBot can't read ${count(result.unreadable.length, "channel")} until Administrator is on, so it can't plan them yet. ${NOTHING_CHANGED}`
      : `TaruBot still can't read ${count(result.unreadable.length, "channel")}, so it can't plan them yet. ${NOTHING_CHANGED}`;
  }
  const w = count(result.written.length, "channel");
  if (result.status === "stopped")
    return `TaruBot added its own entry in ${w}, then stopped with ${count(result.remaining, "channel")} still to do.`;
  return n > 0
    ? `TaruBot added its own entry in ${w}; what's listed below still needs fixing in Discord.`
    : `TaruBot added its own entry in ${w}, so it keeps seeing them once Administrator is off.`;
}

/**
 * The overrides result's 'Next steps', or undefined when it has none. A real run, and a "nothing
 * to add" answer while TaruBot still holds Administrator (the rerun that ends the window), point
 * at /config validate and at removing Administrator (answer 6).
 */
function overridesNext(result: OverridesResult, guildId: string): string | undefined {
  if (result.status === "plan")
    return "Run /setup overrides confirm:true while TaruBot holds Administrator.";
  if (result.status === "stopped")
    return [
      result.stopped ? STOP_LINES[result.stopped] : undefined,
      result.unconfirmed.length > 0 &&
        `Discord may or may not have TaruBot's entry in ${channels(result.unconfirmed)}.`,
      "Run /setup overrides confirm:true again while TaruBot holds Administrator; it continues where this run stopped.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  if (
    result.status === "applied" ||
    (result.status === "nothing" && result.administratorRoles.length > 0)
  ) {
    const removal = administratorRemoval(
      result.administratorRoles,
      result.administratorShared,
      guildId,
      3,
    );
    return [
      "1. Run /config validate.",
      removal
        ? `2. When it says Administrator is no longer needed, ${removal}.`
        : "2. Fix anything it lists.",
    ].join("\n");
  }
  return undefined;
}

/**
 * /setup overrides, dry run or real run (#46 spec §10). The kind follows the status and N, what
 * the server owner must fix in Discord (denied channels, private categories, permissions to grant
 * before removing Administrator, and on a real run the channels Discord refused): an attention
 * kind is a warning, so none of those reads as an all-clear.
 */
export function overridesReply(
  result: OverridesResult,
  viewer: Viewer,
  options: SetupReplyOptions = {},
): Presented {
  const kind = overridesKind(result);
  if (result.status === "onboarding")
    return card(
      kind,
      {
        tone: "info",
        title: "Channel overrides · onboarding manages them",
        description: overridesLead(result, 0),
      },
      options,
    );
  const n = attention(result);
  const real = result.status === "applied" || result.status === "stopped";
  const blockers = result.status === "plan" ? result.blockers : [];
  const unsyncs = (result.status === "plan" ? result.writes : real ? result.written : []).filter(
    (write) => write.unsyncs,
  );
  const unread = result.status === "plan" && result.unreadable.length > 0 ? result.unreadable : [];
  const notChanged = [
    result.hiddenOnPurpose.length > 0 &&
      `Hidden on purpose: ${channels(result.hiddenOnPurpose)}${hiddenByCategoryClause(result.hiddenByCategory.length)}`,
    unread.length > 0 &&
      (blockers.includes("administrator")
        ? `Hidden from TaruBot until Administrator is on: ${channels(unread)}`
        : `TaruBot still can't read: ${channels(unread)}`),
    real &&
      result.refused.length > 0 &&
      `Discord refused TaruBot's entry: ${channels(result.refused)}; they stay missing in /config validate`,
  ].filter((line): line is string => Boolean(line));
  const next = overridesNext(result, viewer.guildId);
  const before: (FieldSpec | false)[] = [
    blockers.length > 0 && {
      name: "Blockers",
      value: blockers.map((blocker) => BLOCKER_LINES[blocker]).join("\n"),
    },
    result.denied.length > 0 && {
      name: "Configured but denied to TaruBot",
      value: `${channels(result.denied)}; lift the deny or change the setting before removing Administrator`,
    },
    result.privateCategories.length > 0 && {
      name: "Private categories holding a configured channel",
      value: [
        some(result.privateCategories.map(privateEntry)),
        "Left alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself, then run /setup overrides again.",
      ].join("\n"),
    },
    result.grantBeforeRemoving.length > 0 && {
      name: "Grant before removing Administrator",
      value: `Give TaruBot's role ${labels(result.grantBeforeRemoving, "server")}.`,
    },
  ];
  const after: (FieldSpec | false)[] = [
    unsyncs.length > 0 && {
      name: "No longer synced with their category",
      value: `${channels(unsyncs.map((write) => write.id))}\nA setting names them, so they get their own entry instead of their category's.`,
    },
    notChanged.length > 0 && { name: "Not changed", value: notChanged.join("\n") },
    // Jobs parked on a channel TaruBot couldn't use, which a real run put back in the queue.
    (real || result.status === "nothing") &&
      (heldWork(result.requeued, result.effectsMode) ?? false),
    next !== undefined && { name: "Next steps", value: next },
  ];
  const fixed = [...before, ...after].filter(Boolean).length;
  const writes = result.status === "plan" ? result.writes : real ? result.written : [];
  const groups = groupFields(writes, Math.max(1, HOUSE_LIMITS.fields - fixed));
  const tone: Tone =
    kind === "overrides.applied"
      ? "success"
      : kind === "overrides.plan" || kind === "overrides.nothing"
        ? "info"
        : "warning";
  const title =
    kind === "overrides.plan"
      ? "Channel overrides · dry run"
      : kind === "overrides.plan_blocked"
        ? `Channel overrides · dry run · ${count(blockers.length, "blocker")}`
        : kind === "overrides.plan_attention"
          ? `Channel overrides · dry run · ${n} to fix in Discord`
          : kind === "overrides.nothing"
            ? "Channel overrides · nothing to add"
            : kind === "overrides.nothing_attention"
              ? `Channel overrides · nothing to add · ${n} to fix in Discord`
              : kind === "overrides.applied"
                ? "Channel overrides added"
                : kind === "overrides.applied_attention"
                  ? `Channel overrides added · ${n} to fix in Discord`
                  : "Channel overrides stopped";
  return card(
    kind,
    {
      tone,
      title,
      description: overridesLead(result, n),
      fields: [...before, ...groups, ...after],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /setup onboarding's dry run

/** Which kind a /setup onboarding dry run renders as. */
export const setupPlanKind = (plan: SetupPlan): SetupReplyKind =>
  plan.blockers.length > 0 ? "onboarding.plan_blocked" : "onboarding.plan";

/** Role labels in setup's order. */
const ROLE_LABELS = {
  member_role_id: "Member",
  guest_role_id: "Guest",
  officer_role_id: "Officer",
  leader_role_id: "FC Leader",
} as const;

/** One room's line: reused, created, or unknown behind a blocker. */
function roomLine(label: string, room: SetupPlan["lobby"], name: string): string {
  if (room.action === "reuse" && room.id) return `${label} ${mentionChannel(room.id)} · reuse`;
  if (room.action === "create") return `${label} · create #${name}`;
  return `${label} · unknown until the blockers are fixed`;
}

/**
 * Blocker fields: one line each, packed into as few fields as fit, at most `max`. When even that
 * isn't enough, the last field lists what it can and ends with "…and N more", so the count stays
 * exact and nothing is cut mid-line.
 */
function blockerFields(plan: SetupPlan, max: number): FieldSpec[] {
  // Blocker messages are TaruBot's own approved text, not user input, so they are bounded by the
  // field rather than the user-text limit: a member-entry refusal's remedy runs past 300 characters
  // and would otherwise be cut. Their channel and role mentions are kept, and plain() collapses
  // each to one line, so a field's lines are exactly its blockers.
  const lines = plan.blockers.map(
    (blocker) => `• ${restoreMentions(plain(blocker.message, DISCORD_LIMITS.fieldValue - 2))}`,
  );
  if (lines.length === 0 || max <= 0) return [];
  const fields = splitFields("Blockers", lines, DISCORD_LIMITS.fieldValue);
  if (fields.length <= max) return fields;
  const values = fields.slice(0, max - 1).map((field) => field.value);
  const shown = values.reduce((total, value) => total + value.split("\n").length, 0);
  const rest = lines.slice(shown);
  values.push(list(rest, { max: rest.length }));
  return values.map((value, index) => ({
    name: `Blockers (${index + 1}/${values.length})`,
    value,
  }));
}

/**
 * /setup onboarding without confirm:true: what confirm:true would create, reuse and change, and
 * every blocker, read without writing. The blockers come first; a blocked plan is a warning.
 */
export function setupPlanReply(
  plan: SetupPlan,
  _viewer: Viewer,
  options: SetupReplyOptions = {},
): Presented {
  const kind = setupPlanKind(plan);
  const roles = plan.roles.map((role) => {
    const label = ROLE_LABELS[role.field];
    const name = plain(role.name, HOUSE_LIMITS.characterName);
    if (role.action === "create") return `${label} · create ${name}`;
    const id = role.id ? ` ${mentionRole(role.id)}` : "";
    return role.action === "rename"
      ? `${label}${id} · reuse, renamed to ${name}`
      : `${label}${id} · reuse`;
  });
  const onboarding = plan.onboarding;
  // The sample names the first few; the rest are counted.
  const more = (onboarding.channels ?? 0) - onboarding.sample.length;
  const sample =
    onboarding.sample.length > 0
      ? `: ${prose([...onboarding.sample.map(mentionChannel), ...(more > 0 ? [`${more} more`] : [])])}`
      : "";
  const access =
    onboarding.channels === null
      ? "Unknown until the blockers are fixed."
      : [
          `${onboarding.alreadyOn ? "Onboarding's pass would re-check" : "Onboarding's first pass would change"} the overwrites of ${count(onboarding.channels, "channel")}${sample}.`,
          onboarding.everyoneLosesView === true &&
            "@everyone would lose View Channel, so newcomers see only the lobby until they're verified.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
  const settings = [
    `Guest applications: ${plan.guestApplications.switchesOn ? "turned on" : "stay on"}, reviews in ${plan.guestApplications.channel ? mentionChannel(plan.guestApplications.channel) : "the officer room"}`,
    `Officer notifications: ${plan.officerNotifications.channel && !plan.officerNotifications.defaulted ? mentionChannel(plan.officerNotifications.channel) : "the officer room"}`,
    plan.adopt !== null &&
      plan.adopt > 0 &&
      `Officer role holders adopted as manual grants: ${plan.adopt}`,
    `Role layout: ${plan.roleLayout ? "on" : "off (role display and order left unchanged)"}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const fixed: FieldSpec[] = [
    {
      name: "Access roles",
      value: roles.length > 0 ? roles.join("\n") : "Unknown until the blockers are fixed.",
    },
    {
      name: "Rooms",
      value: `${roomLine("Lobby", plan.lobby, "lobby")}\n${roomLine("Officer room", plan.officerRoom, "officer-chat")}`,
    },
    {
      name: "Free Company",
      value: plan.fc.company
        ? fcName(plan.fc.company)
        : plan.fc.id
          ? `FC ${plan.fc.id}`
          : "Not linked · /config fc link",
      inline: true,
    },
    {
      name: "Officer rank",
      value: plan.officerRank
        ? plain(plan.officerRank, HOUSE_LIMITS.userText)
        : "Not set · manual grants only",
      inline: true,
    },
    { name: "Settings", value: settings },
    { name: "Channel access", value: access },
    {
      name: "Next steps",
      value:
        plan.blockers.length > 0
          ? "1. Fix the blockers above.\n2. Run /setup onboarding again to check.\n3. Then run it with confirm:true."
          : "Run /setup onboarding confirm:true with the same options to make these changes.",
    },
  ];
  const blocked = plan.blockers.length > 0;
  return card(
    kind,
    {
      tone: blocked ? "warning" : "info",
      title: blocked
        ? `Server setup · dry run · ${count(plan.blockers.length, "blocker")}`
        : "Server setup · dry run",
      description: blocked
        ? `/setup onboarding confirm:true would refuse until the blockers below are fixed. ${NOTHING_CHANGED}`
        : `This is what /setup onboarding confirm:true would do. ${NOTHING_CHANGED}`,
      fields: [...blockerFields(plan, HOUSE_LIMITS.fields - fixed.length), ...fixed],
    },
    options,
  );
}
