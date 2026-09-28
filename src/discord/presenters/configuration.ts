/**
 * Configuration presenters: /config show and /config validate (and the buttons that re-run the
 * health check), every /config change, /setup, and /officer grant and revoke. Each renders a typed
 * service result for its viewer, reproducing the approved mockups (configuration#4, #7, #8, #9,
 * #18, #34, #37 and #41, with the gen.py title overrides) and the reply specs for the other states.
 * Failures are never caught here: the router's failure presenter renders them. Pure; the clock is
 * injected for embed timestamps.
 *
 * Change receipts branch on effectsMode (C5). Any change saved while Discord changes are paused
 * (roles, the FC link, the channel settings, the officer rank, the role layout, /setup, an officer
 * override) is the approved paused-save card (errors-and-style#26, owner decision O2): pending,
 * titled 'Saved, Discord changes paused', keeping the receipt's sentence and facts. Live Discord
 * work reads '… QUEUED' as the style guide says, except where an approved card words it (#37's
 * Channel access line, #41's 'Assignment queued'). A committed change with nothing left to fix is
 * success, removals included; one saved with a caveat an officer must fix (no FC, no officer rank,
 * no Guest role) is warning; repeats that change nothing are the info '= NO CHANGE' cards (C4).
 *
 * The health checklist uses the approved bracket tokens ([OK] [WARN] [FAIL] [OFF] [WAIT]), which
 * belong to health checks only. Since 2.35.0 (#46) it adds "TaruBot's role" and "Visibility",
 * judged as if Administrator were off (src/domain/visibility.ts), and /config show's health line
 * counts their rows to review. /config show keeps the approved field-per-setting layout, which
 * needs up to 15 fields since the changelog channel (2.25.0): its documented exemption from the
 * ten-field house limit (C3).
 */
import type { GuildRecord } from "../../application/records.js";
import type {
  ChangelogAudience,
  ConfigChange,
  ConfigurationReport,
  EffectsMode,
  FcHealthRow,
  FcRef,
  FcUnlinkResult,
  GuestApplicationsResult,
  OfficerOverrideResult,
  OfficerRankResult,
  OfficerResetResult,
  RoleLayoutResult,
  SetupResult,
} from "../../application/results.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../domain/guest-application.js";
import { type PermissionKey, permissionLabel } from "../../domain/permissions.js";
import type { CoreRow, VisibilityReport } from "../../domain/visibility.js";
import type { Viewer } from "./audience.js";
import { recheckButton, syncStatusButton } from "./controls.js";
import {
  code,
  count,
  fcTagText,
  fcTitleName,
  link,
  lodestone,
  mentionChannel,
  mentionRole,
  mentionUser,
  plain,
  restoreMentions,
  shortId,
  title,
  when,
} from "./format.js";
import { effectsField, pausedSave, whenApplied } from "./jobs.js";
import { reply, type FieldSpec, type Presented, type ReplySpec } from "./reply.js";
import { CHECK, DISCORD_LIMITS, HOUSE_LIMITS, marker, type Check, type Tone } from "./style.js";

/**
 * Every configuration reply kind, with whether its embed carries a timestamp: the approved card's
 * `timestamp` value, or the reply spec's for states without a drawn card (C11). Repeats that
 * change nothing and paused saves (errors-and-style#26) have none. The reply catalog must cover
 * every kind.
 */
const TIMESTAMP = {
  "show.configured": true,
  "show.partial": true,
  "show.paused": true,
  "validate.healthy": true,
  "validate.problems": true,
  "validate.warnings": true,
  "validate.ready": true,
  "fc.linked": true,
  "fc.unchanged": false,
  "fc.paused": false,
  "fc.unlinked": true,
  "fc.unlink_paused": false,
  "role.set": true,
  "role.leader": true,
  "role.leader_no_fc": true,
  "role.officer_adopted": true,
  "role.officer_not_adopted": true,
  "role.officer_no_rank": true,
  "role.cleared": true,
  "role.unchanged": false,
  "role.paused": false,
  "channel.ledger": true,
  "channel.ledger_no_fc": true,
  "channel.ledger_cleared": true,
  "channel.notifications": true,
  "channel.notifications_cleared": true,
  "channel.changelog": true,
  "channel.changelog_hidden": true,
  "channel.changelog_cleared": true,
  "channel.unchanged": false,
  "channel.paused": false,
  "applications.open": true,
  "applications.review_changed": true,
  "applications.no_role": true,
  "applications.no_channel": true,
  "applications.closed": true,
  "applications.review_set": true,
  "applications.review_unset": true,
  "applications.unchanged": false,
  "applications.paused": false,
  "rank.set": true,
  "rank.heads_up": true,
  "rank.cleared": true,
  "rank.paused": false,
  "rank.unchanged": false,
  "layout.on": true,
  "layout.off": true,
  "layout.unchanged": false,
  "layout.paused": false,
  "setup.created": true,
  "setup.reused": true,
  "setup.paused": false,
  "officer.granted": true,
  "officer.revoked": true,
  "officer.repeated": true,
  "officer.absent": true,
  "officer.recorded": true,
  "officer.paused": false,
  "officer.reset": true,
  "officer.reset_unchanged": false,
  "officer.reset_paused": false,
} as const satisfies Record<string, boolean>;

/** A configuration reply state; tests catalogue one case per kind. */
export type ConfigReplyKind = keyof typeof TIMESTAMP;

/** Every configuration reply kind, for catalog completeness checks. */
export const CONFIG_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly ConfigReplyKind[];

/** Options every configuration presenter takes. */
export interface ConfigReplyOptions {
  /** The current time for embed timestamps; commands omit it, tests inject the mockups' clock. */
  readonly now?: Date | undefined;
}

/** Build a configuration reply of `kind`, stamping it only when its approved card does. */
function card(
  kind: ConfigReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: ConfigReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/** Whether Discord changes are held, which turns a Discord-work receipt into the paused card. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

/**
 * The approved paused-save card (errors-and-style#26) around a receipt: its sentence follows what
 * was saved, and its Saved and Discord changes fields come before the receipt's own facts.
 */
function heldCard(
  kind: ConfigReplyKind,
  mode: Exclude<EffectsMode, "live">,
  viewer: Viewer,
  saved: string,
  fields: readonly (FieldSpec | false | null | undefined)[],
  options: ConfigReplyOptions,
): Presented {
  const held = pausedSave(mode, viewer);
  return card(
    kind,
    {
      tone: held.tone,
      title: held.title,
      description: `${saved} ${held.sentence}`,
      fields: [...held.fields, ...fields],
      footer: held.footer,
    },
    options,
  );
}

/** The audit footer of a configuration change, naming the revision it produced (a bigint). */
const revisionFooter = (guild: Pick<GuildRecord, "revision">): string =>
  `Audited · configuration revision ${guild.revision}`;

/** User-written rank names and reasons in fields, capped like all user text (C10). */
const userText = (text: string): string => plain(text, HOUSE_LIMITS.userText);

/** A rank name inside a sentence, in bold, cut like a character name. */
const rankText = (rank: string): string => `**${plain(rank, HOUSE_LIMITS.characterName)}**`;

// ---------------------------------------------------------------------------------------------
// Shared vocabulary

/** The four managed roles in layout order (FC Leader > Officer > Member > Guest). */
const ROLES = [
  { column: "leader_role_id", label: "FC Leader" },
  { column: "officer_role_id", label: "Officer" },
  { column: "member_role_id", label: "Member" },
  { column: "guest_role_id", label: "Guest" },
] as const;

/** The FC's stored name for links, or its ID before the first Lodestone read filled it in. */
const rawName = (fc: Pick<FcRef, "id" | "name">): string => fc.name.trim() || `FC ${fc.id}`;

/** The FC as the checklist and receipts name it: 'Example Company «EXMPL»' (no world). */
function fcLabel(fc: Pick<FcRef, "id" | "name" | "tag">): string {
  const name = fcTitleName(fc, "text");
  const tag = fcTagText(fc.tag);
  return tag ? `${name} «${plain(tag, 20)}»` : name;
}

/** ' «EXMPL»' after a bolded FC name, or '' when the FC has no tag. */
const tagSuffix = (stored: string): string => {
  const tag = fcTagText(stored);
  return tag ? ` «${plain(tag, 20)}»` : "";
};

/**
 * The FC as a Lodestone link plus its world: '[Example Company «EXMPL»](…) · Diabolos', or with
 * ' on ' between them inside a sentence.
 */
function fcLink(fc: FcRef, joiner: " · " | " on " = " · "): string {
  const tag = fcTagText(fc.tag);
  const label = tag ? `${rawName(fc)} «${tag}»` : rawName(fc);
  const world = fc.world ? `${joiner}${plain(fc.world, HOUSE_LIMITS.characterName)}` : "";
  return `${link(label, lodestone.freeCompany(fc.id))}${world}`;
}

/**
 * The linked FC's health row. A linked FC whose row is missing (never expected: linking stores it)
 * still shows as linked by its ID, with no roster read.
 */
function linkedFc(report: ConfigurationReport): FcHealthRow | null {
  const id = report.configuration.fc_id;
  if (id === null) return null;
  return (
    report.fc?.find((row) => row.id === id) ?? {
      id,
      name: "",
      tag: "",
      world: "",
      last_successful_roster_at: null,
      last_attempt_at: null,
      last_error: null,
      fresh: false,
      attemptFailed: false,
    }
  );
}

/** What 'Discord changes' reads in /config show, and its one-word form in the description. */
const DISCORD_STATE: Readonly<
  Record<EffectsMode, { readonly field: string; readonly word: string }>
> = {
  live: { field: "Live", word: "Live" },
  awaiting_activation: { field: "Paused · pending activation", word: "Paused" },
  deployment_disabled: {
    field: "Disabled for this deployment",
    word: "Disabled for this deployment",
  },
};

/** Why Discord changes are held, as /config show's description states it. */
const PAUSED_NOTE: Readonly<Record<Exclude<EffectsMode, "live">, string>> = {
  awaiting_activation:
    "**Not activated yet.** TaruBot's role, nickname and channel changes are paused until the activation step runs.",
  deployment_disabled:
    "**Discord changes are off for this deployment.** TaruBot won't change roles, nicknames or channels until they're turned back on.",
};

/**
 * Held work a change queued again (blocked or paused jobs): '… QUEUED' while Discord changes are
 * live, otherwise when the pause ends, because the requeued jobs are held again until then.
 */
export function heldWork(requeued: number, mode: EffectsMode): FieldSpec | null {
  if (requeued <= 0) return null;
  const jobs = count(requeued, "held job");
  return {
    name: "Held work",
    value:
      mode === "live"
        ? `${marker("queued")} ${jobs} queued again`
        : `${jobs} will retry ${whenApplied(mode)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// /config validate: the health checklist

/** A checklist section: one field each, in the approved order. */
export type HealthSection =
  | "Free Company"
  | "Access roles"
  | "Channels"
  | "Onboarding"
  | "TaruBot's role"
  | "Visibility"
  | "Discord changes"
  | "Role layout"
  | "Guest grandfathering";

/** One checklist line: its bracket token, text, and whether it reports a configured resource. */
export interface HealthCheck {
  readonly section: HealthSection;
  readonly check: Check;
  readonly text: string;
  /** A role or channel check the service ran (available or failed); /config show counts these. */
  readonly resource: boolean;
}

/** Sections that sit side by side, as the approved checklists draw them. */
const INLINE_SECTIONS: ReadonlySet<HealthSection> = new Set([
  "Discord changes",
  "Role layout",
  "Guest grandfathering",
]);

/** The two sections #46 added (2.35.0), which /config show's health line counts separately. */
const VISIBILITY_SECTIONS: ReadonlySet<HealthSection> = new Set(["TaruBot's role", "Visibility"]);

/** Roster-acquisition failure codes as the failed-attempt clause names them (configuration#8). */
const ROSTER_ERROR: Readonly<Record<string, string>> = {
  unavailable: "Lodestone unavailable",
  rate_limited: "Lodestone rate limited",
  not_found: "FC not found on the Lodestone",
  incomplete: "roster read was incomplete",
  invalid_response: "unexpected Lodestone data",
  acquisition_failed: "roster read failed",
};

/**
 * The room a failed check's message gets. Messages are approved Failure text that may name the
 * resource as a mention; at this length four failing roles still fit one 1,024-character field.
 */
const CHECK_MESSAGE = 200;

/** Why a changelog channel's checklist line warns, by its audience in an onboarding guild. */
const AUDIENCE_WARNING: Readonly<Record<Exclude<ChangelogAudience, "members">, string>> = {
  hidden: "hidden from members and guests by onboarding",
  unmanaged: "not managed by onboarding, so check that members and guests can read it",
};

/** A resource check's stored state: available, unconfigured, or the check's failure message. */
function capability(report: ConfigurationReport, column: string, value: string | null): string {
  if (value === null) return "unconfigured";
  // A configured column the service did not report can't be called healthy.
  return (
    report.capabilities[column] ?? "Resource check failed; inspect bot permissions and hierarchy."
  );
}

/**
 * A configured role or channel's line: '[OK] <label> <mention>', or '[FAIL] <label> <mention>:
 * <message>' with the message's own mentions kept (the gateway names the resource in it).
 */
function resourceCheck(
  section: HealthSection,
  label: string,
  mention: string,
  state: string,
): HealthCheck {
  if (state === "available")
    return { section, check: "ok", text: `${label} ${mention}`, resource: true };
  return {
    section,
    check: "fail",
    text: `${label} ${mention}: ${restoreMentions(plain(state, CHECK_MESSAGE))}`,
    resource: true,
  };
}

/** The failed-attempt clause, only when the latest roster attempt came after the last success. */
function attemptClause(fc: FcHealthRow): string {
  const last = fc.last_successful_roster_at;
  const attempt = fc.last_attempt_at;
  if (!fc.attemptFailed || !attempt || (last && attempt <= last)) return "";
  // Stored codes are catalog codes; anything else (or a prototype key) gets the generic words.
  const stored = fc.last_error;
  const reason =
    (stored && Object.hasOwn(ROSTER_ERROR, stored) ? ROSTER_ERROR[stored] : undefined) ??
    "roster read failed";
  return `; the attempt ${when(attempt, "R")} failed (${reason})`;
}

// ---------------------------------------------------------------------------------------------
// /config validate: TaruBot's role and Visibility (2.35.0, #46)

/** One row of the two #46 sections before it is placed in a section. */
interface Row {
  readonly check: Check;
  readonly text: string;
}

/** How many mentions a row shows before 'and K more'; 0 shows only the count. */
interface MentionBudget {
  readonly roles: number;
  readonly channels: number;
}

/**
 * The mention budgets a section tries in turn until its field fits 1,024 characters: three roles
 * and six channels per row, then fewer, then counts only. A realistic server fits the first; the
 * later ones keep a pathological one (every permission from different roles, dozens of channels
 * in every list) whole rather than letting the embed builder cut it.
 */
const MENTION_BUDGETS: readonly MentionBudget[] = [
  { roles: 3, channels: 6 },
  { roles: 2, channels: 4 },
  { roles: 1, channels: 2 },
  { roles: 0, channels: 0 },
];

/** The rows of the first budget whose field fits; the last budget's otherwise. */
function fitted(build: (budget: MentionBudget) => Row[]): Row[] {
  let rows: Row[] = [];
  for (const budget of MENTION_BUDGETS) {
    rows = build(budget);
    const field = rows.map((row) => `${CHECK[row.check]} ${row.text}`).join("\n");
    if (field.length <= DISCORD_LIMITS.fieldValue) break;
  }
  return rows;
}

/**
 * At most `max` rendered items then 'and K more', joined as prose; with `max` 0 (or nothing to
 * show) only the count, in `noun`'s words.
 */
function mentions(items: readonly string[], max: number, noun: readonly [string, string]): string {
  if (max <= 0 || items.length === 0) return count(items.length, noun[0], noun[1]);
  const shown = items.slice(0, max);
  const hidden = items.length - shown.length;
  return prose(hidden > 0 ? [...shown, `${hidden} more`] : shown);
}

const ROLE_NOUN = ["role", "roles"] as const;
const CHANNEL_NOUN = ["channel", "channels"] as const;

/** Role mentions, @everyone (the guild ID) as plain text: its mention would render oddly. */
function roleMentions(roles: readonly string[], guildId: string, max: number): string {
  return mentions(
    roles.map((id) => (id === guildId ? "@everyone" : mentionRole(id))),
    max,
    ROLE_NOUN,
  );
}

/** Channel mentions within the budget. */
const channelMentions = (ids: readonly string[], max: number): string =>
  mentions(ids.map(mentionChannel), max, CHANNEL_NOUN);

/** Permission labels as prose, in the server context unless given. */
const labels = (keys: readonly PermissionKey[], context: "server" | "channel" = "server") =>
  prose(keys.map((key) => permissionLabel(key, context)));

/**
 * How to take Administrator away from TaruBot once /config validate says it is no longer needed,
 * for its 'no longer needed' row and /setup overrides' next step: turn it off where TaruBot's own
 * bot role or @everyone grants it, and remove each shared role (one people also hold) from
 * TaruBot rather than editing it, each part left out when it names no role. `roles` are the
 * Administrator roles TaruBot holds (guildId for @everyone) and `shared` those that are neither;
 * each list shows at most `maxRoles` mentions, or only its count at 0.
 */
export function administratorRemoval(
  roles: readonly string[],
  shared: readonly string[],
  guildId: string,
  maxRoles: number,
): string {
  const own = roles.filter((id) => !shared.includes(id));
  return [
    own.length > 0 && `turn it off in ${roleMentions(own, guildId, maxRoles)}`,
    shared.length > 0 && `remove ${roleMentions(shared, guildId, maxRoles)} from TaruBot`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", and ");
}

/**
 * The core seven, grouped so permissions with the same answer share a row: from TaruBot's own
 * role [OK]; only from other roles or @everyone [WARN] (a change to that role removes them);
 * missing [FAIL], or [WARN] while Administrator still covers the gap. With no mention room left,
 * every other-roles row merges into one naming the union of those roles.
 */
function coreRows(report: VisibilityReport, guildId: string, budget: MentionBudget): Row[] {
  const admin = report.administrator.held;
  const groups: { key: string; rows: CoreRow[] }[] = [];
  for (const row of report.core) {
    const borrowed = row.source === "other_roles" || row.source === "everyone";
    const key =
      borrowed && budget.roles > 0
        ? `borrowed:${row.roles.join(",")}`
        : borrowed
          ? "borrowed"
          : row.source;
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups.map(({ rows }): Row => {
    const [first] = rows;
    const names = labels(rows.map((row) => row.permission));
    const several = rows.length > 1;
    if (first?.source === "own_role") return { check: "ok", text: names };
    if (first?.source === "missing")
      return admin
        ? {
            check: "warn",
            text: `${names}: missing without Administrator; grant ${several ? "them" : "it"} before removing Administrator`,
          }
        : { check: "fail", text: `${names}: missing` };
    const roles = [...new Set(rows.flatMap((row) => row.roles))];
    return {
      check: "warn",
      text: `${names}: only from ${roleMentions(roles, guildId, budget.roles)}, so a change to ${roles.length === 1 ? "that role" : "those roles"} removes ${several ? "them" : "it"}`,
    };
  });
}

/**
 * The "TaruBot's role" section, everything as if Administrator were off: Administrator itself
 * (off; on and still needed; on and no longer needed, saying how to remove it), the core seven,
 * onboarding's permissions on onboarding servers only (a server without onboarding never sees a
 * row naming Manage Channels or the other four), the role order ([FAIL] for roles TaruBot sits
 * below, and [WARN] for those it stays above only through a shared Administrator role, which keep
 * Administrator needed), and permissions it never needs.
 */
function roleRows(report: VisibilityReport, guildId: string, budget: MentionBudget): Row[] {
  const { administrator } = report;
  const holders = roleMentions(administrator.roles, guildId, budget.roles);
  const rows: Row[] = [
    !administrator.held
      ? { check: "ok", text: "Administrator: off" }
      : report.administratorNeeded
        ? {
            check: "warn",
            text: `Administrator: on (from ${holders}); still needed until the items below are fixed`,
          }
        : {
            check: "warn",
            text: `Administrator: no longer needed; ${administratorRemoval(administrator.roles, administrator.shared, guildId, budget.roles)}`,
          },
    ...coreRows(report, guildId, budget),
  ];
  const onboarding = report.onboardingMissing;
  if (onboarding !== null)
    rows.push(
      onboarding.length === 0
        ? { check: "ok", text: "Onboarding permissions" }
        : administrator.held
          ? {
              check: "warn",
              text: `Onboarding permissions: missing ${labels(onboarding)} without Administrator; grant ${onboarding.length > 1 ? "them" : "it"} before removing Administrator`,
            }
          : { check: "fail", text: `Onboarding permissions: missing ${labels(onboarding)}` },
    );
  // Roles TaruBot sits below even with every role it holds are a failure now; those it stays above
  // only through a shared Administrator role are a warning until that role comes off.
  const { highest, notBelow, throughShared } = report.roleOrder;
  const below = notBelow.filter((id) => !throughShared.includes(id));
  if (below.length > 0)
    rows.push({
      check: "fail",
      text: `Role order: move TaruBot's highest role above ${roleMentions(below, guildId, budget.roles)}`,
    });
  if (throughShared.length > 0) {
    const shared = administrator.shared;
    const target = highest ? `move ${mentionRole(highest)} above` : "give TaruBot a role above";
    rows.push({
      check: "warn",
      text: `Role order: TaruBot is above ${roleMentions(throughShared, guildId, budget.roles)} only through ${roleMentions(shared, guildId, budget.roles)}; ${target} ${throughShared.length > 1 ? "them" : "it"} before removing ${shared.length > 1 ? "those roles" : "that role"} from TaruBot`,
    });
  }
  if (notBelow.length === 0)
    rows.push(
      highest
        ? { check: "ok", text: `Role order: ${mentionRole(highest)} is above the access roles` }
        : { check: "ok", text: "Role order: no access roles to stay above" },
    );
  const never = report.neverNeeded;
  rows.push(
    never.length > 0
      ? {
          check: "warn",
          text: `Never needed: ${labels(never.map((row) => row.permission))} (from ${roleMentions([...new Set(never.flatMap((row) => row.roles))], guildId, budget.roles)})`,
        }
      : { check: "ok", text: "No permissions it never needs" },
  );
  return rows;
}

/** The four posting permissions, as the channel rows name them. */
const POSTING_LABELS = "View Channel, Send Messages, Embed Links and Read Message History";

/**
 * The "Visibility" section on an onboarding server: onboarding's own channel pass gives TaruBot
 * its access, so the rows say what it hasn't reached yet (keep Administrator on while it holds, or
 * see /sync status for why the pass waits) and which configured channels it never manages (the
 * Community Updates channel's), where TaruBot needs its own access.
 */
function onboardingRows(report: VisibilityReport, budget: MentionBudget): Row[] {
  const { managed, unmanaged } = report.onboardingPending ?? { managed: [], unmanaged: [] };
  if (managed.length + unmanaged.length === 0)
    return [{ check: "ok", text: "Onboarding manages TaruBot's channel access" }];
  const held = report.administrator.held;
  const rows: Row[] = [];
  if (managed.length > 0) {
    const listed = budget.channels > 0 ? `: ${channelMentions(managed, budget.channels)}` : "";
    const lead = `Onboarding hasn't reached ${count(managed.length, "channel")} yet${listed}`;
    rows.push(
      held
        ? {
            check: "warn",
            text: `${lead}; keep Administrator on until /sync status shows its channel pass finished`,
          }
        : { check: "fail", text: `${lead}; /sync status shows why its channel pass is waiting` },
    );
  }
  if (unmanaged.length > 0) {
    const listed = channelMentions(unmanaged, budget.channels);
    rows.push(
      held
        ? {
            check: "warn",
            text: `Onboarding doesn't manage ${listed}, so TaruBot needs its own access there before Administrator comes off: give it ${POSTING_LABELS}`,
          }
        : {
            check: "fail",
            text: `Onboarding doesn't manage ${listed}, and TaruBot can't post there: give it ${POSTING_LABELS}`,
          },
    );
  }
  return rows;
}

/**
 * The "Visibility" section: onboarding's coverage (onboardingRows); every channel visible (naming
 * any hidden on purpose); or, in order, the missing overrides (categories counted with the
 * channels inside them), posting channels short of a posting permission, configured channels whose
 * own TaruBot entry denies history, configured channels denied on purpose ([FAIL] once
 * Administrator is off, since removing it then hid them), private categories (a warning the
 * server owner fixes, with the three ways), and channels hidden on purpose. The Missing and
 * Posting rows name their remedy: /setup overrides confirm:true while TaruBot holds Administrator,
 * or turning it on first.
 */
function visibilityRows(report: VisibilityReport, budget: MentionBudget): Row[] {
  if (report.mode === "onboarding") return onboardingRows(report, budget);
  const hidden = report.hiddenOnPurpose;
  // Channels hidden only through their category's deny, counted so an owner can tell them apart.
  const byCategory = hiddenByCategoryClause(report.hiddenByCategory.length);
  if (report.missingCount === 0)
    return [
      {
        check: "ok",
        text:
          hidden.length > 0
            ? `TaruBot can see every channel, except ${hidden.length} hidden on purpose${byCategory}: ${channelMentions(hidden, budget.channels)}`
            : "TaruBot can see every channel",
      },
    ];
  const rows: Row[] = [];
  const held = report.administrator.held;
  const remedy = held
    ? "; /setup overrides confirm:true adds them while TaruBot holds Administrator"
    : "; turn Administrator on for TaruBot, then run /setup overrides confirm:true";
  const { categories, inside, channels, posting, unreadable } = report.missing;
  if (categories.length + channels.length > 0) {
    const counts = [
      categories.length > 0 &&
        `${count(categories.length, "category", "categories")}${inside.length > 0 ? ` (${count(inside.length, "channel")} inside)` : ""}`,
      channels.length > 0 && count(channels.length, "channel"),
    ].filter((part): part is string => Boolean(part));
    const listed =
      budget.channels > 0
        ? `: ${channelMentions([...categories, ...channels], budget.channels)}`
        : "";
    // Entries TaruBot can't read yet: a run with Administrator reads them fresh; without it, not.
    const u = unreadable.length;
    const clause =
      u === 0
        ? ""
        : held
          ? ` (the run re-reads the ${u} TaruBot can't read yet)`
          : `; TaruBot can't read ${u} of them until then`;
    rows.push({
      check: "warn",
      text: `Missing TaruBot overrides: ${counts.join(", ")}${listed}${remedy}${clause}`,
    });
  }
  if (posting.length > 0) {
    const entries = posting.map(
      (entry) => `${mentionChannel(entry.id)} (${labels(entry.lacks, "channel")})`,
    );
    rows.push({
      check: "warn",
      text: `Posting channels without all four posting permissions: ${mentions(entries, budget.channels, CHANNEL_NOUN)}${remedy}`,
    });
  }
  if (report.masked.length > 0)
    rows.push({
      check: "warn",
      text: `Configured channels where TaruBot's own entry denies Read Message History: ${channelMentions(report.masked, budget.channels)}; /setup overrides lifts that deny while TaruBot holds Administrator`,
    });
  if (report.denied.length > 0) {
    const denied = `Configured but denied to TaruBot on purpose: ${channelMentions(report.denied, budget.channels)}; lift the deny or change the setting`;
    rows.push(
      held
        ? { check: "warn", text: `${denied} before removing Administrator` }
        : { check: "fail", text: denied },
    );
  }
  if (report.privateCategories.length > 0) {
    // Each category names at most two of the configured channels it holds (fewer on a tight
    // budget); @deconfined's rule: a warning the server owner fixes, whether or not Administrator
    // is held, since /setup overrides picks nothing for such a category.
    const shown = Math.min(2, budget.channels);
    const entries = report.privateCategories.map(
      (category) =>
        `${mentionChannel(category.id)} (holds ${mentions(category.configured.map(mentionChannel), shown, CHANNEL_NOUN)})`,
    );
    rows.push({
      check: "warn",
      text: `Private categories holding a configured channel: ${mentions(entries, budget.channels, ["category", "categories"])}; /setup overrides leaves them alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself`,
    });
  }
  if (hidden.length > 0)
    rows.push({
      check: "off",
      text: `Hidden on purpose: ${channelMentions(hidden, budget.channels)}${byCategory}`,
    });
  return rows;
}

/**
 * ' (N inside a category hidden from TaruBot)' for the channels hidden only through their
 * category's deny (VisibilityReport's hiddenByCategory), or '' for none; /setup overrides' reply
 * uses it too.
 */
export function hiddenByCategoryClause(n: number): string {
  return n > 0 ? ` (${n} inside a category hidden from TaruBot)` : "";
}

/**
 * The /config validate checklist as rows, one bracket token each (approved configuration#7–#9):
 * - Free Company: linked or not, then the roster: fresh [OK], stale or never read [WARN], with
 *   the failed-attempt clause when the latest attempt came after the last success.
 * - Access roles in layout order: [OK], [FAIL] with the check's message, [WARN] for an unset
 *   Member or Guest role, [OFF] 'not managed' for an unset Officer or FC Leader role.
 * - Channels: [OK], [FAIL], [OFF] when unset; a review channel without a Guest role is [WARN], and
 *   so is a changelog channel onboarding hides from members or doesn't manage (2.25.0).
 * - Onboarding: the lobby and officer room, or [OFF] when onboarding is off.
 * - TaruBot's role and Visibility (2.35.0, #46): see roleRows and visibilityRows. Without a
 *   readable view, the role section is left out and Visibility is one [WARN].
 * - Discord changes: [OK] Live; [WARN] when disabled for the deployment; awaiting activation is
 *   [WAIT] 'Paused until activation' (configuration#9), except beside problems, where the approved
 *   configuration#8 counts it as the warning 'Paused: this server has not been activated'.
 * - Role layout: [OK] On or [OFF] Off; Guest grandfathering: [WAIT] only while it is pending.
 * The unset-guest-channel line likewise follows each approved card's wording (#8 with problems,
 * #9 otherwise). Pure: the service already ran every check.
 */
export function configurationChecks(report: ConfigurationReport): HealthCheck[] {
  const guild = report.configuration;
  const rows: HealthCheck[] = [];
  const add = (section: HealthSection, check: Check, text: string, resource = false): void => {
    rows.push({ section, check, text, resource });
  };

  const fc = linkedFc(report);
  if (!fc) add("Free Company", "warn", "No FC linked, so no one can receive Member");
  else {
    add("Free Company", "ok", `${fcLabel(fc)} linked`);
    const last = fc.last_successful_roster_at;
    const failed = attemptClause(fc);
    if (last && fc.fresh) add("Free Company", "ok", `Roster read ${when(last, "R")}`);
    else if (!last) add("Free Company", "warn", `No successful roster read yet${failed}`);
    else add("Free Company", "warn", `Roster is stale: last good read ${when(last, "R")}${failed}`);
  }

  for (const { column, label } of ROLES) {
    const id = guild[column];
    if (id !== null)
      rows.push(
        resourceCheck("Access roles", label, mentionRole(id), capability(report, column, id)),
      );
    else if (column === "member_role_id" || column === "guest_role_id")
      add("Access roles", "warn", `${label}: not set, so no one receives ${label} access`);
    else add("Access roles", "off", `${label}: not managed`);
  }

  const ledger = guild.ledger_channel_id;
  if (ledger !== null)
    rows.push(
      resourceCheck(
        "Channels",
        "Ledger",
        mentionChannel(ledger),
        capability(report, "ledger_channel_id", ledger),
      ),
    );
  else add("Channels", "off", "Ledger: not set, so ledger commands are unavailable");
  const notices = guild.officer_notifications_channel_id;
  if (notices !== null)
    rows.push(
      resourceCheck(
        "Channels",
        "Officer notifications",
        mentionChannel(notices),
        capability(report, "officer_notifications_channel_id", notices),
      ),
    );
  else add("Channels", "off", "Officer notifications: not set, so officer alerts are skipped");
  const changelog = guild.changelog_channel_id;
  if (changelog !== null) {
    const check = resourceCheck(
      "Channels",
      "Changelog",
      mentionChannel(changelog),
      capability(report, "changelog_channel_id", changelog),
    );
    // Where onboarding decides visibility, a usable channel members can't read (or one onboarding
    // doesn't manage) warns, as a review channel without a Guest role does. Warn only: the bot
    // never makes it visible (owner decision 4, 2026-09-25).
    const audience = report.changelogAudience;
    rows.push(
      check.check === "ok" && audience !== undefined && audience !== "members"
        ? { ...check, check: "warn", text: `${check.text}: ${AUDIENCE_WARNING[audience]}` }
        : check,
    );
  } else add("Channels", "off", "Changelog: not set, so update posts are skipped");
  const reviews = guild.guest_application_channel_id;
  // A channel is checked only while applications are on; switched off, it is just kept for later.
  const applicationsOn = guild.guest_applications_enabled;
  if (applicationsOn && reviews !== null) {
    const review = resourceCheck(
      "Channels",
      "Guest applications",
      mentionChannel(reviews),
      capability(report, "guest_application_channel_id", reviews),
    );
    // A usable review channel without a Guest role still leaves /apply closed.
    rows.push(
      review.check === "ok" && guild.guest_role_id === null
        ? {
            ...review,
            check: "warn",
            text: `${review.text}: open, but no Guest role is set, so /apply stays closed`,
          }
        : review,
    );
  }

  if (guild.access_policy_enabled)
    for (const [column, label] of [
      ["lobby_channel_id", "Lobby"],
      ["officer_channel_id", "Officer room"],
    ] as const) {
      const id = guild[column];
      if (id !== null)
        rows.push(
          resourceCheck("Onboarding", label, mentionChannel(id), capability(report, column, id)),
        );
      else add("Onboarding", "warn", `${label}: not set; run /setup onboarding again to create it`);
    }
  else add("Onboarding", "off", "Onboarding is off");

  // TaruBot's role and channel view (2.35.0, #46), before the verdict-dependent wording below so
  // their problems count toward it. No role section when TaruBot's view couldn't be read.
  const visibility = report.visibility;
  if (visibility)
    for (const row of fitted((budget) => roleRows(visibility, guild.id, budget)))
      add("TaruBot's role", row.check, row.text);
  for (const row of visibility
    ? fitted((budget) => visibilityRows(visibility, budget))
    : [
        {
          check: "warn" as const,
          text: "Couldn't read TaruBot's channel view; try again in a minute",
        },
      ])
    add("Visibility", row.check, row.text);

  // Wording that differs between the approved problem (#8) and ready (#9) checklists follows the
  // verdict. Fields group rows by section, so this line still lists last among the channels.
  const problems = rows.some((row) => row.check === "fail");
  if (!applicationsOn)
    add(
      "Channels",
      "off",
      problems && reviews === null
        ? "Guest applications: not set, so /apply is closed"
        : "Guest applications: closed, so /apply refuses",
    );
  else if (reviews === null)
    add(
      "Channels",
      "warn",
      "Guest applications: on, but no review channel is set, so /apply stays closed",
    );

  if (report.effectsMode === "deployment_disabled")
    add("Discord changes", "warn", "Disabled for this deployment");
  else if (report.effectsMode === "awaiting_activation")
    if (problems) add("Discord changes", "warn", "Paused: this server has not been activated");
    else add("Discord changes", "wait", "Paused until activation");
  else add("Discord changes", "ok", "Live");

  if (guild.role_layout_enabled) add("Role layout", "ok", "On");
  else add("Role layout", "off", "Off: display and order untouched");

  if (guild.guest_grandfather === "pending")
    add("Guest grandfathering", "wait", "Pending: runs once at activation");
  return rows;
}

/** The checklist's verdict: its counts, and which state (and so tone and title) it is in. */
interface Verdict {
  readonly kind: "validate.healthy" | "validate.problems" | "validate.warnings" | "validate.ready";
  readonly tone: Tone;
  readonly title: string;
  readonly description: string;
}

/** Tone, title and description from the checklist's token counts (approved #7, #8 and #9). */
function verdict(checks: readonly HealthCheck[], mode: EffectsMode): Verdict {
  const tally = (check: Check) => checks.filter((row) => row.check === check).length;
  const [ok, fail, warn, wait] = [tally("ok"), tally("fail"), tally("warn"), tally("wait")];
  const warnings = warn > 0 ? count(warn, "warning") : null;
  if (fail > 0)
    return {
      kind: "validate.problems",
      tone: "error",
      title: title(
        "Configuration health",
        [count(fail, "problem"), warnings].filter(Boolean).join(", "),
      ),
      description: `Fix the items marked ${CHECK.fail}, then run /config validate again. Nothing was changed.`,
    };
  if (warnings)
    return {
      kind: "validate.warnings",
      tone: "warning",
      title: title("Configuration health", warnings),
      description: `No problems found, but review the items marked ${CHECK.warn}. Nothing was changed.`,
    };
  if (wait > 0)
    return {
      kind: "validate.ready",
      tone: "pending",
      title: title("Configuration health", "ready for activation"),
      description:
        mode === "awaiting_activation"
          ? "All configured resources passed. Discord changes stay paused until activation. Nothing was changed."
          : `All configured resources passed. Items marked ${CHECK.wait} run at activation. Nothing was changed.`,
    };
  return {
    kind: "validate.healthy",
    tone: "success",
    title: title("Configuration health", "all checks passed"),
    description: `${count(ok, "check")} passed. Nothing was changed.`,
  };
}

/** One field per checklist section, in order, each line '<token> <text>'. */
function checklistFields(checks: readonly HealthCheck[]): FieldSpec[] {
  const sections: HealthSection[] = [];
  for (const row of checks) if (!sections.includes(row.section)) sections.push(row.section);
  return sections.map((section) => ({
    name: section,
    value: checks
      .filter((row) => row.section === section)
      .map((row) => `${CHECK[row.check]} ${row.text}`)
      .join("\n"),
    inline: INLINE_SECTIONS.has(section),
  }));
}

/**
 * /config validate and its Re-check, and /config show's Run health check (approved
 * configuration#7–#9, titled 'Configuration health · …'). Read-only, so every verdict says
 * "Nothing was changed." (C2). Any [FAIL] is error with the problem and warning counts; warnings
 * alone are warning; waits alone (an imported guild before activation) are pending 'ready for
 * activation'; otherwise success with the passed count. Re-check edits this view in place.
 */
export function healthReply(
  report: ConfigurationReport,
  _viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const checks = configurationChecks(report);
  const result = verdict(checks, report.effectsMode);
  return card(
    result.kind,
    {
      tone: result.tone,
      title: result.title,
      description: result.description,
      fields: checklistFields(checks),
      footer: ["Read-only check", `configuration revision ${report.configuration.revision}`],
      buttons: [recheckButton("Re-check")],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config show

/**
 * /config show's health line, from the same resource checks /config validate lists, plus (2.35.0)
 * how many of the TaruBot's role and Visibility rows need review. /config show has no field left
 * for them (C3), so the line carries the count and /config validate the rows.
 */
function healthLine(checks: readonly HealthCheck[]): string {
  const resources = checks.filter((row) => row.resource);
  const failed = resources.filter((row) => row.check === "fail").length;
  const review = checks.filter(
    (row) => VISIBILITY_SECTIONS.has(row.section) && (row.check === "warn" || row.check === "fail"),
  ).length;
  const suffix = review > 0 ? ` Role and visibility: ${review} to review in /config validate.` : "";
  if (resources.length === 0) return `Health: no roles or channels to check yet.${suffix}`;
  if (failed > 0) return `Health: ${count(failed, "problem")}. Run /config validate.${suffix}`;
  return `Health: all ${count(resources.length, "resource check")} passed.${suffix}`;
}

/**
 * What 'Guest applications' reads: open only when the switch is on and both the channel and the
 * Guest role are set. Switched off, it names the review channel it keeps for later.
 */
function guestApplications(guild: GuildRecord): string {
  const channel = guild.guest_application_channel_id;
  if (!guild.guest_applications_enabled)
    return channel === null ? "Off" : `Off · reviews in ${mentionChannel(channel)}`;
  if (channel === null) return "Closed · no review channel";
  if (guild.guest_role_id === null) return "Closed · no Guest role";
  return `Open · ${mentionChannel(channel)}`;
}

/** Numbered next steps for what is still unset, in the order setup needs them (spec #5). */
function nextSteps(guild: GuildRecord): string | null {
  const steps = [
    (guild.member_role_id === null || guild.guest_role_id === null) &&
      "Create or bind the access roles.",
    guild.fc_id === null && "Link the Free Company with /config fc link.",
    guild.ledger_channel_id === null && "Choose a ledger channel with /config ledger.",
  ].filter((step): step is string => Boolean(step));
  if (steps.length === 0) return null;
  return [...steps, "Run /config validate."]
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
}

/**
 * /config show (approved configuration#4; spec #5 partially configured and #6 not activated). The
 * description gives the FC, a pause note while Discord changes are held, the three switches and
 * the health line. Fields show each setting: the four roles inline in layout order (one 'Access
 * roles' field when none is set), Officer access, the four channels (one 'Channels' field when
 * none is set; the changelog channel since 2.25.0), Onboarding, Discord changes, Role layout,
 * Guest grandfathering while it applies, and Next steps when something required is unset: up to
 * 15 fields, the documented /config show exemption (C3), which leaves no room for another field.
 * Info, or pending while Discord changes are held (C4). Run health check replaces this view with
 * the checklist.
 */
export function showReply(
  report: ConfigurationReport,
  _viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const guild = report.configuration;
  const mode = report.effectsMode;
  const checks = configurationChecks(report);
  const fc = linkedFc(report);
  const onboarding = guild.access_policy_enabled;

  const fcLine = fc
    ? [
        `**${fcTitleName(fc, "text")}**`,
        tagSuffix(fc.tag),
        fc.world ? ` · ${plain(fc.world, HOUSE_LIMITS.characterName)}` : "",
      ].join("")
    : "No Free Company linked";
  const switches = [
    `Discord changes **${DISCORD_STATE[mode].word}**`,
    `Onboarding **${onboarding ? "On" : "Off"}**`,
    `Role layout **${guild.role_layout_enabled ? "On" : "Off"}**`,
  ].join(" · ");

  const company: FieldSpec = {
    name: "Free Company",
    value: fc
      ? [
          fcLink(fc),
          fc.last_successful_roster_at
            ? `Roster read ${when(fc.last_successful_roster_at, "R")}`
            : "No successful roster read yet",
          `FC ID ${fc.id}`,
        ].join("\n")
      : "Not linked. /config fc link fc_id:<ID or Lodestone URL>",
  };
  const rolesUnset = ROLES.every(({ column }) => guild[column] === null);
  const roles: FieldSpec[] = rolesUnset
    ? [
        {
          name: "Access roles",
          value:
            "Not set. Server managers can run /setup onboarding, or bind existing roles with /config roles member, guest, officer and leader.",
        },
      ]
    : ROLES.map(({ column, label }) => {
        const id = guild[column];
        return { name: `${label} role`, value: id ? mentionRole(id) : "Not set", inline: true };
      });
  const officerAccess: FieldSpec = {
    name: "Officer access",
    value:
      guild.officer_role_id === null
        ? "Server managers only. Set an Officer role with /config roles officer to delegate."
        : guild.officer_rank_name
          ? `In-game rank ${rankText(guild.officer_rank_name)} + manual grants (/officer grant)`
          : "Manual grants only (/officer grant)",
  };
  const channelsUnset =
    guild.ledger_channel_id === null &&
    guild.officer_notifications_channel_id === null &&
    guild.guest_application_channel_id === null &&
    guild.changelog_channel_id === null;
  const channels: FieldSpec[] = channelsUnset
    ? [
        {
          name: "Channels",
          value:
            "Ledger: not set\nOfficer notifications: not set\nGuest applications: closed\nChangelog: not set",
        },
      ]
    : [
        {
          name: "Ledger channel",
          value: guild.ledger_channel_id ? mentionChannel(guild.ledger_channel_id) : "Not set",
          inline: true,
        },
        {
          name: "Officer notifications",
          value: guild.officer_notifications_channel_id
            ? mentionChannel(guild.officer_notifications_channel_id)
            : "Not set",
          inline: true,
        },
        { name: "Guest applications", value: guestApplications(guild), inline: true },
        {
          name: "Changelog",
          value: guild.changelog_channel_id
            ? mentionChannel(guild.changelog_channel_id)
            : "Not set",
          inline: true,
        },
      ];
  const rooms = [
    guild.lobby_channel_id ? `lobby ${mentionChannel(guild.lobby_channel_id)}` : "lobby not set",
    guild.officer_channel_id
      ? `officer room ${mentionChannel(guild.officer_channel_id)}`
      : "officer room not set",
  ];
  const steps = nextSteps(guild);
  const grandfather = guild.guest_grandfather;

  const kind: ConfigReplyKind = paused(mode)
    ? "show.paused"
    : steps
      ? "show.partial"
      : "show.configured";
  return card(
    kind,
    {
      tone: paused(mode) ? "pending" : "info",
      title: "Server configuration",
      description: [fcLine, paused(mode) && PAUSED_NOTE[mode], switches, healthLine(checks)],
      fields: [
        company,
        ...roles,
        officerAccess,
        ...channels,
        onboarding
          ? { name: "Onboarding", value: `On · ${rooms.join(" · ")}` }
          : { name: "Onboarding", value: "Off", inline: true },
        { name: "Discord changes", value: DISCORD_STATE[mode].field, inline: true },
        {
          name: "Role layout",
          value: guild.role_layout_enabled ? "On" : "Off · display and order untouched",
          inline: true,
        },
        grandfather === "pending" && {
          name: "Guest grandfathering",
          value: "Pending · runs once at activation",
          inline: true,
        },
        grandfather === "completed" && {
          name: "Guest grandfathering",
          value: guild.guest_grandfathered_at
            ? `Completed ${when(guild.guest_grandfathered_at, "R")}`
            : "Completed",
          inline: true,
        },
        steps !== null && { name: "Next steps", value: steps },
      ],
      footer: [`Configuration revision ${guild.revision}`, "/config validate tests each resource"],
      buttons: [recheckButton("Run health check")],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config fc link and unlink

/**
 * /config fc link (spec #10, #11). A new link is success, 'Free Company linked', with the roster
 * read (which runs even while Discord changes are paused), the ledger account and the role check
 * it queued; paused, it is the paused-save card. Linking the FC that is already linked is the
 * info no-op 'Free Company already linked'.
 */
function companyLinkReply(
  result: Extract<ConfigChange, { readonly status: "saved" }>,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const id = result.value ?? result.guild.fc_id ?? "";
  const company = result.company;
  const linked = company
    ? `${fcLink(company, " on ")} is now linked to this server.`
    : `FC ${code(id)} is now linked to this server.`;
  const facts: FieldSpec[] = [
    { name: "FC ID", value: code(id), inline: true },
    { name: "Roster", value: `${marker("queued")} Lodestone read`, inline: true },
    { name: "Ledger account", value: `${marker("saved")} Ready`, inline: true },
  ];
  if (paused(result.effectsMode))
    return heldCard(
      "fc.paused",
      result.effectsMode,
      viewer,
      `${linked} Its roster is still read now.`,
      [...facts, heldWork(result.requeued, result.effectsMode)],
      options,
    );
  return card(
    "fc.linked",
    {
      tone: "success",
      title: "Free Company linked",
      description: `${linked} A roster read is queued; member access updates when it finishes.`,
      fields: [
        ...facts,
        effectsField(result.effectsMode, "Server-wide role check", viewer),
        heldWork(result.requeued, result.effectsMode),
      ],
      footer: ["Audited", "check progress with /sync status"],
    },
    options,
  );
}

/** Options for the unlink receipt: the FC ID the officer typed, which the result may not name. */
export interface UnlinkReplyOptions extends ConfigReplyOptions {
  readonly fcId: string;
}

/**
 * /config fc unlink (spec #14): success, 'Free Company unlinked', naming the FC, what the next
 * role check removes (manual grants and registered Guest stay) and that ledger commands pause;
 * paused, it is the paused-save card.
 */
export function fcUnlinkReply(
  result: FcUnlinkResult,
  viewer: Viewer,
  options: UnlinkReplyOptions,
): Presented {
  const name = result.company
    ? `**${fcTitleName(result.company, "text")}**${tagSuffix(result.company.tag)}`
    : `FC ${code(options.fcId)}`;
  const unlinked = `${name} is no longer linked. Characters, ledger history and audit records are kept.`;
  const facts: FieldSpec[] = [
    {
      name: "What changes",
      value:
        "At the next role check, TaruBot removes the Member and FC Leader roles and rank-based Officer access. Manual officer grants stay, and members with a verified character keep Guest.",
    },
    { name: "Ledger", value: "Ledger commands are unavailable until an FC is linked again." },
  ];
  if (paused(result.effectsMode))
    return heldCard("fc.unlink_paused", result.effectsMode, viewer, unlinked, facts, options);
  return card(
    "fc.unlinked",
    {
      tone: "success",
      title: "Free Company unlinked",
      description: unlinked,
      fields: [...facts, effectsField(result.effectsMode, "Server-wide role check", viewer)],
      footer: ["Audited as fc.unlink", "link again with /config fc link"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config roles and the channel settings

/** A saved configuration change (not the FC-link no-op). */
type SavedChange = Extract<ConfigChange, { readonly status: "saved" }>;

/**
 * Each role binding: its label with the article a sentence needs, what binding a role means
 * (spec #16 and #19; the Officer role has its own receipt), and the Effect a clear has (#20).
 */
const ROLE_FIELDS = {
  member_role_id: {
    label: "Member",
    article: "a",
    saved: (role: string) =>
      `${role} is now the Member role. TaruBot gives it to people whose linked character is in the linked FC and removes it from everyone else.`,
    cleared: "No one receives Member access from TaruBot until a role is set again.",
  },
  guest_role_id: {
    label: "Guest",
    article: "a",
    saved: (role: string) =>
      `${role} is now the Guest role. TaruBot gives it to approved guests, members with a verified character who aren't in the FC, and former members.`,
    cleared: "Approved guests and verified visitors get no Guest role until one is set again.",
  },
  officer_role_id: {
    label: "Officer",
    article: "an",
    saved: (role: string) => `${role} is now the bot-managed Officer role.`,
    cleared: "Delegated officer access ends: only people with Manage Server count as officers.",
  },
  leader_role_id: {
    label: "FC Leader",
    article: "an",
    saved: (role: string) =>
      `${role} now follows the Free Company leader: TaruBot gives it to the member whose linked character leads the linked FC on the Lodestone roster.`,
    cleared: "No one receives an FC Leader role.",
  },
} as const;

/** Each channel setting's name, for titles and inside sentences (its no-op receipt). */
const CHANNEL_FIELDS = {
  ledger_channel_id: { label: "Ledger channel", noun: "ledger channel" },
  officer_notifications_channel_id: {
    label: "Officer notifications channel",
    noun: "officer notifications channel",
  },
  changelog_channel_id: { label: "Changelog channel", noun: "changelog channel" },
} as const;

/**
 * The Visibility field's text for a changelog channel members may not read, by its audience in an
 * onboarding guild (2.25.0). The set receipt shows the unmanaged text (a hidden channel gets the
 * warning description instead), and the no-op card for a repeat shows either, so choosing the
 * same channel again still says what /config validate warns about.
 */
const CHANGELOG_VISIBILITY: Readonly<Record<Exclude<ChangelogAudience, "members">, string>> = {
  hidden:
    "Onboarding keeps this channel hidden from members and guests, so they won't see update posts there. Choose a channel they can read.",
  unmanaged:
    "Onboarding doesn't manage this channel (a new channel joins at the next repair pass), so make sure members and guests can read it.",
};

/**
 * A changelog change's Visibility field: present only for a channel onboarding hides or doesn't
 * manage. With onboarding off there is no audience, since server admins own the permissions.
 */
const changelogVisibility = (change: SavedChange): FieldSpec | null =>
  change.field === "changelog_channel_id" &&
  change.value !== null &&
  change.audience !== undefined &&
  change.audience !== "members"
    ? { name: "Visibility", value: CHANGELOG_VISIBILITY[change.audience] }
    : null;

/** Whether a saved field is one of the role bindings. */
const isRole = (field: string): field is keyof typeof ROLE_FIELDS =>
  Object.hasOwn(ROLE_FIELDS, field);
/** Whether a saved field is one of the channel settings. */
const isChannel = (field: string): field is keyof typeof CHANNEL_FIELDS =>
  Object.hasOwn(CHANNEL_FIELDS, field);

/**
 * The Discord work a role binding queued beyond the role check: the layout pass when the role
 * layout is on, and channel access when onboarding is on. Live only; a paused receipt's Discord
 * changes field covers them.
 */
function roleWork(change: SavedChange, viewer: Viewer): FieldSpec[] {
  const guild = change.guild;
  return [
    guild.role_layout_enabled &&
      effectsField(change.effectsMode, "Layout pass", viewer, "Role layout"),
    guild.access_policy_enabled &&
      effectsField(change.effectsMode, "Re-securing channels", viewer, "Channel access"),
  ].filter((field): field is FieldSpec => Boolean(field));
}

/** Officer access in the words of the approved cards: rank plus grants, or grants only. */
const officerAccess = (rank: string | null): string =>
  rank ? `Manual grants + in-game rank ${rankText(rank)}` : "Manual grants only";

/**
 * A repeated setting that changed nothing (C4 no-op, info): the same role or channel chosen again,
 * or a clear of something already unset. Rebinding the Officer role adopts nobody. It still
 * re-queues held work, which it reports. A repeated changelog channel onboarding hides or doesn't
 * manage keeps its Visibility field (2.25.0): the card stays info, since nothing changed.
 */
function unchangedReply(
  change: SavedChange,
  label: string,
  noun: string,
  options: ConfigReplyOptions,
): Presented {
  const role = isRole(change.field);
  const target = change.value
    ? role
      ? mentionRole(change.value)
      : mentionChannel(change.value)
    : null;
  const officer =
    change.field === "officer_role_id" && change.value ? " No holders were adopted." : "";
  return card(
    role ? "role.unchanged" : "channel.unchanged",
    {
      tone: "info",
      title: `${label} already ${change.value ? "set" : "unset"}`,
      description: target
        ? `${marker("unchanged")} ${target} was already the ${noun}.${officer}`
        : `${marker("unchanged")} No ${noun} was set.`,
      fields: [changelogVisibility(change), heldWork(change.requeued, change.effectsMode)],
      footer: revisionFooter(change.guild),
    },
    options,
  );
}

/**
 * /config roles officer (spec #17, approved #18). adopt_holders (the default) adopts the role's
 * current holders as manual grants, listing up to twenty; adopt_holders:false (the production
 * runbook) says who keeps the role, and turns warning when no officer rank is set, since then
 * only manual grants keep it.
 */
function officerRoleReply(
  change: SavedChange,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const role = mentionRole(change.value ?? "");
  const intro = ROLE_FIELDS.officer_role_id.saved(role);
  const holders = change.officerHolders;
  const rank = change.guild.officer_rank_name;
  const replaced = replacedField(change);
  const mode = change.effectsMode;
  if (holders && !holders.adopt) {
    const saved = `${intro} No manual grants were created for its current holders.`;
    const facts: (FieldSpec | null)[] = [
      {
        name: "Who keeps the role",
        value: rank
          ? `Members whose linked character holds in-game rank ${rankText(rank)}, plus anyone given /officer grant. Other holders lose the role once the roster confirms they don't hold that rank.`
          : "Only people given /officer grant, because no officer rank is set. Other holders lose the role at the next role check.",
      },
      rank
        ? { name: "Officer rank", value: userText(rank), inline: true }
        : {
            name: "Officer rank",
            value:
              "Not set. Run /config officer_rank rank:<name>, or only /officer grant confers Officer.",
          },
    ];
    if (paused(mode))
      return heldCard("role.paused", mode, viewer, saved, [...facts, replaced], options);
    return card(
      rank ? "role.officer_not_adopted" : "role.officer_no_rank",
      {
        tone: rank ? "success" : "warning",
        title: "Officer role set without adopting holders",
        description: saved,
        fields: [
          ...facts,
          effectsField(mode, "Server-wide role check", viewer),
          replaced,
          ...roleWork(change, viewer),
          heldWork(change.requeued, mode),
        ],
        footer: ["Audited", "adopt_holders:false"],
      },
      options,
    );
  }
  const adopted = holders?.adopted ?? 0;
  const sample = holders?.sample ?? [];
  const saved = `${intro} ${
    adopted > 0
      ? `${count(adopted, "current holder was", "current holders were")} adopted as manual officer grants and keep it until a server manager runs /officer revoke.`
      : "No one holds this role yet."
  }`;
  const facts: (FieldSpec | null)[] = [
    adopted > 0
      ? {
          name: "Adopted holders",
          value: `${sample.map(mentionUser).join(", ")}${
            adopted > sample.length ? ` +${adopted - sample.length} more` : ""
          }`,
        }
      : null,
    { name: "Officer access", value: officerAccess(rank), inline: true },
  ];
  if (paused(mode))
    return heldCard("role.paused", mode, viewer, saved, [...facts, replaced], options);
  return card(
    "role.officer_adopted",
    {
      tone: "success",
      title: "Officer role set",
      description: saved,
      fields: [
        ...facts,
        effectsField(mode, "Server-wide role check", viewer),
        replaced,
        ...roleWork(change, viewer),
        heldWork(change.requeued, mode),
      ],
      footer:
        adopted > 0
          ? ["Audited", "officer.adopt recorded for each holder"]
          : revisionFooter(change.guild),
    },
    options,
  );
}

/** The role a new binding retired, which TaruBot removes from its holders. */
function replacedField(change: SavedChange): FieldSpec | null {
  if (!change.previous || change.previous === change.value) return null;
  return {
    name: "Replaced",
    value: `${mentionRole(change.previous)} is retired: TaruBot removes it from its current holders.`,
  };
}

/**
 * /config roles member, guest, officer and leader (spec #16, #17, approved #18, #19 and #20).
 * Binding shows the retired role, the queued role check, the layout pass and channel access when
 * those switches are on, and held work; a leader without a linked FC turns warning. Clearing is
 * success like every committed removal, and officer and leader bindings render to the manager
 * audience that alone may make them.
 */
function roleChangeReply(
  change: SavedChange,
  field: keyof typeof ROLE_FIELDS,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const { label, article, saved: sentence, cleared } = ROLE_FIELDS[field];
  const mode = change.effectsMode;
  if (change.value === null) {
    const saved = `TaruBot no longer manages ${article} ${label} role.${
      change.previous
        ? ` ${mentionRole(change.previous)} is retired and TaruBot removes it from its current holders.`
        : ""
    }`;
    const effect: FieldSpec = { name: "Effect", value: cleared };
    if (paused(mode))
      return heldCard(
        "role.paused",
        mode,
        viewer,
        saved,
        [effect, heldWork(change.requeued, mode)],
        options,
      );
    return card(
      "role.cleared",
      {
        tone: "success",
        title: `${label} role unset`,
        description: saved,
        fields: [
          effect,
          effectsField(mode, "Role removal", viewer),
          ...roleWork(change, viewer),
          heldWork(change.requeued, mode),
        ],
        footer: revisionFooter(change.guild),
      },
      options,
    );
  }
  if (field === "officer_role_id") return officerRoleReply(change, viewer, options);
  const role = mentionRole(change.value);
  const leaderless = field === "leader_role_id" && change.guild.fc_id === null;
  const saved = sentence(role);
  const noFc: FieldSpec | null = leaderless
    ? {
        name: "Free Company",
        value: "Not linked, so no one can receive this role yet. Link one with /config fc link.",
      }
    : null;
  if (paused(mode))
    return heldCard(
      "role.paused",
      mode,
      viewer,
      saved,
      [replacedField(change), noFc, heldWork(change.requeued, mode)],
      options,
    );
  return card(
    field === "leader_role_id" ? (leaderless ? "role.leader_no_fc" : "role.leader") : "role.set",
    {
      tone: leaderless ? "warning" : "success",
      title: `${label} role set`,
      description: saved,
      fields: [
        noFc,
        replacedField(change),
        effectsField(mode, "Server-wide role check", viewer),
        ...roleWork(change, viewer),
        heldWork(change.requeued, mode),
      ],
      footer: revisionFooter(change.guild),
    },
    options,
  );
}

/**
 * /config ledger, officer_notifications and changelog (spec #23–#26; changelog since 2.25.0).
 * Warning variants: a ledger channel with no linked FC, and a changelog channel onboarding hides
 * from members and guests (owner decision 4: warn, never force it visible). A changelog channel
 * onboarding doesn't manage gets a Visibility field on the success card instead, worded for both
 * causes (a channel newer than the last repair pass, or the Community Updates channel). While
 * Discord changes are paused, every channel change is the approved paused-save card
 * (errors-and-style#26 covers any change), like the other /config receipts: it keeps the receipt's
 * own sentence and facts, and held work says when it retries. The guest review channel has its own
 * receipt, guestApplicationsReply().
 */
function channelChangeReply(
  change: SavedChange,
  field: keyof typeof CHANNEL_FIELDS,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const mode = change.effectsMode;
  const guild = change.guild;
  const held = heldWork(change.requeued, mode);
  const footer = revisionFooter(guild);
  // Live, the receipt's own card; paused, the same sentence and facts inside the #26 card, whose
  // sentence already says when the held Discord work (posts, alerts, reviews) applies.
  const done = (
    kind: ConfigReplyKind,
    spec: Omit<ReplySpec, "timestamp"> & { readonly description: string },
  ): Presented =>
    paused(mode)
      ? heldCard("channel.paused", mode, viewer, spec.description, spec.fields ?? [], options)
      : card(kind, spec, options);
  const channel = change.value ? mentionChannel(change.value) : null;
  if (field === "ledger_channel_id") {
    if (!channel)
      return done("channel.ledger_cleared", {
        tone: "success",
        title: "Ledger channel unset",
        description: "Ledger commands are unavailable until a ledger channel is set again.",
        fields: [
          {
            name: "Queued posts",
            value: "Ledger posts already queued wait, and are sent once a channel is set.",
          },
          held,
        ],
        footer,
      });
    const noFc = guild.fc_id === null;
    return done(noFc ? "channel.ledger_no_fc" : "channel.ledger", {
      tone: noFc ? "warning" : "success",
      title: "Ledger channel set",
      description: `Ledger deposits, withdrawals, adjustments and initializations will be posted in ${channel}.`,
      fields: [
        noFc && {
          name: "Free Company",
          value: "Not linked, so ledger commands stay unavailable. Link one with /config fc link.",
        },
        held,
      ],
      footer,
    });
  }
  if (field === "officer_notifications_channel_id")
    return done(
      channel ? "channel.notifications" : "channel.notifications_cleared",
      channel
        ? {
            tone: "success",
            title: "Officer notifications channel set",
            description: `Officer alerts will be posted in ${channel}.`,
            fields: [held],
            footer,
          }
        : {
            tone: "success",
            title: "Officer notifications turned off",
            description:
              "Officer alerts raised while no channel is set are skipped, not held. Set a channel again to resume them.",
            fields: [held],
            footer,
          },
    );
  if (field === "changelog_channel_id") {
    if (!channel)
      return done("channel.changelog_cleared", {
        tone: "success",
        title: "Changelog posts turned off",
        description:
          "Updates released while no channel is set aren't posted later. Set a channel again to resume posts.",
        fields: [held],
        footer,
      });
    // Two sentences, the house limit: the warning and what to do about it.
    if (change.audience === "hidden")
      return done("channel.changelog_hidden", {
        tone: "warning",
        title: "Changelog channel set",
        description: `Onboarding keeps ${channel} hidden from members and guests, so they won't see update posts there. Choose a channel they can read.`,
        fields: [held],
        footer,
      });
    // Setting a channel posts nothing now; the first post comes with the next update that has
    // something for members (owner decisions 2 and 3). A hidden channel returned above, so the
    // Visibility field here is only ever the unmanaged one.
    return done("channel.changelog", {
      tone: "success",
      title: "Changelog channel set",
      description: `From the next update on, TaruBot posts what's new for members in ${channel}. Members and guests need to be able to read this channel.`,
      fields: [changelogVisibility(change), held],
      footer,
    });
  }
  // configure() no longer saves the guest review channel; guestApplicationsReply() answers it.
  throw new Error(`No channel receipt for field ${field}.`);
}

/** Applicants' answers are posted in the review channel, so it should be staff-only. */
const PRIVATE_REVIEWS: FieldSpec = {
  name: "Keep it private",
  value:
    "Applicants' answers are visible to anyone who can read this channel. Use a staff-only channel.",
};

/**
 * /config guest_applications (owner decision, 2026-09-24): the applications switch and the review
 * channel, saved together. The card follows what changed, so it never implies a change that didn't
 * happen: switching off is 'Guest applications closed' with the exact refusal /apply now shows;
 * switching on, or setting the missing channel of a switched-on server, is 'Guest applications
 * open', or a warning naming what still keeps /apply closed (no channel, no Guest role); a new
 * channel for already-open applications is 'Review channel changed'; a channel set or unset while
 * applications stay off says so. A request matching what is saved is the info '= NO CHANGE' card.
 * Paused, a saved change is the paused-save card with the same sentence and facts.
 */
export function guestApplicationsReply(
  result: GuestApplicationsResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  if (result.status === "unchanged") {
    const where = result.channel
      ? `reviewed in ${mentionChannel(result.channel)}`
      : "with no review channel";
    return card(
      "applications.unchanged",
      {
        tone: "info",
        title: "Guest applications already set",
        description: `${marker("unchanged")} Applications are already ${result.enabled ? "on" : "off"}, ${where}.`,
        // Nothing was saved or audited, so the footer names the revision without "Audited".
        footer: `Configuration revision ${result.guild.revision}`,
      },
      options,
    );
  }
  const guild = result.guild;
  const mode = result.effectsMode;
  const held = heldWork(result.requeued, mode);
  const footer = revisionFooter(guild);
  const done = (
    kind: ConfigReplyKind,
    spec: Omit<ReplySpec, "timestamp"> & { readonly description: string },
  ): Presented =>
    paused(mode)
      ? heldCard("applications.paused", mode, viewer, spec.description, spec.fields ?? [], options)
      : card(kind, spec, options);
  const channel = result.channel.value ? mentionChannel(result.channel.value) : null;
  const channelChanged = result.channel.value !== result.channel.previous;
  const reviewField: FieldSpec | null = channelChanged
    ? { name: "Review channel", value: channel ?? "Unset", inline: true }
    : null;
  if (!result.enabled.value) {
    if (result.enabled.previous)
      return done("applications.closed", {
        tone: "success",
        title: "Guest applications closed",
        description: `/apply now refuses before the form opens: “${GUEST_APPLICATIONS_CLOSED}”`,
        fields: [
          {
            name: "Pending applications",
            value: "Applications already posted stay reviewable in their original channel.",
          },
          {
            name: "Other Guest access",
            value:
              "/guest grant still works, and people with a verified character still receive Guest.",
          },
          reviewField,
          held,
        ],
        footer,
      });
    // Off before and after: only the review channel changed.
    return channel
      ? done("applications.review_set", {
          tone: "success",
          title: "Review channel set",
          description: `Applications will be posted in ${channel} once you turn them on with /config guest_applications enabled:true.`,
          fields: [PRIVATE_REVIEWS, held],
          footer,
        })
      : done("applications.review_unset", {
          tone: "success",
          title: "Review channel unset",
          description:
            "Applications stay off, and no review channel is set. Choose one before turning them on.",
          fields: [held],
          footer,
        });
  }
  if (!channel)
    return done("applications.no_channel", {
      tone: "warning",
      title: "Guest applications on; review channel needed",
      description: "/apply stays closed until a review channel is set.",
      fields: [
        {
          name: "Next step",
          value: "Set one with /config guest_applications channel:#guest-reviews.",
        },
        reviewField,
        held,
      ],
      footer,
    });
  if (guild.guest_role_id === null)
    return done("applications.no_role", {
      tone: "warning",
      title: result.enabled.previous
        ? "Review channel set; Guest role still needed"
        : "Guest applications on; Guest role still needed",
      description: `${channel} will receive applications, but /apply stays closed until a Guest role is set.`,
      fields: [
        PRIVATE_REVIEWS,
        { name: "Next step", value: "Set the Guest role with /config roles guest role:@Guest." },
        held,
      ],
      footer,
    });
  // The Guest role can't change here, so applications were open before exactly when the switch
  // was on with a channel.
  const wasOpen = result.enabled.previous && result.channel.previous !== null;
  return done(wasOpen ? "applications.review_changed" : "applications.open", {
    tone: "success",
    title: wasOpen ? "Review channel changed" : "Guest applications open",
    description: wasOpen
      ? `New applications are posted in ${channel}. Applications already posted stay reviewable in their original channel.`
      : `/apply is open. Each application is posted in ${channel} with Approve and Deny buttons.`,
    fields: [
      PRIVATE_REVIEWS,
      { name: "Guest role", value: mentionRole(guild.guest_role_id), inline: true },
      held,
    ],
    footer,
  });
}

/**
 * Every /config change that configure() saves: fc link (and its already-linked no-op), the four
 * role bindings and the three channel settings. Repeats that change nothing are the info
 * '= NO CHANGE' card; the rest are routed by field.
 */
export function changeReply(
  result: ConfigChange,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  if (result.status === "unchanged")
    return card(
      "fc.unchanged",
      {
        tone: "info",
        title: "Free Company already linked",
        description: `${marker("unchanged")} FC ${code(result.value)} is already linked to this server.`,
      },
      options,
    );
  const field = result.field;
  if (field === "fc_id") return companyLinkReply(result, viewer, options);
  if (isRole(field)) {
    if (result.rebound) {
      const name = `${ROLE_FIELDS[field].label} role`;
      return unchangedReply(result, name, name, options);
    }
    return roleChangeReply(result, field, viewer, options);
  }
  if (isChannel(field)) {
    if (result.rebound)
      return unchangedReply(
        result,
        CHANNEL_FIELDS[field].label,
        CHANNEL_FIELDS[field].noun,
        options,
      );
    return channelChangeReply(result, field, viewer, options);
  }
  // configure() saves only allowlisted fields, so anything else is a presenter/service mismatch.
  throw new Error(`No configuration receipt for field ${field}.`);
}

// ---------------------------------------------------------------------------------------------
// /config officer_rank and role_layout

/**
 * /config officer_rank (spec #30, #31). Setting a rank is success, with a Heads-up (warning tone)
 * when no FC is linked or no Officer role is bound, since the rank can't confer anything until
 * both exist. Clearing is success: officer access comes from manual grants only. Paused, it is the
 * paused-save card.
 */
export function officerRankReply(
  result: OfficerRankResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const rank = result.officerRank;
  const mode = result.effectsMode;
  const headsUp = rank
    ? [
        !result.fcLinked && "No FC is linked, so this rank can't match anyone yet.",
        !result.officerRoleId && "No Officer role is bound; bind one with /config roles officer.",
      ].filter((line): line is string => Boolean(line))
    : [];
  // A repeat names the saved rank without claiming access it can't give yet: the same Heads-up as
  // the saved path says what is still missing (no FC linked, no Officer role bound).
  if (result.status === "unchanged")
    return card(
      "rank.unchanged",
      {
        tone: "info",
        title: rank ? "Officer rank already set" : "Officer rank already unset",
        description: rank
          ? `${marker("unchanged")} ${rankText(rank)} is already the saved officer rank.${
              headsUp.length ? "" : " Members who hold it already get bot officer access."
            }`
          : `${marker("unchanged")} No officer rank was set, so officer access already comes only from manual grants.`,
        fields: [headsUp.length ? { name: "Heads-up", value: headsUp.join("\n") } : null],
      },
      options,
    );
  const saved = rank
    ? `Members whose linked character holds the in-game rank ${rankText(rank)} get bot officer access and the Officer role, alongside manual grants. /officer revoke still overrides the rank.`
    : "Officer access now comes only from manual grants (/officer grant). People who had the Officer role only through their in-game rank lose it at the next role check.";
  const facts: (FieldSpec | null)[] = rank
    ? [
        { name: "Mode", value: "Rank + manual grants", inline: true },
        { name: "Matching", value: "Exact rank name, ignoring case and spacing", inline: true },
      ]
    : [{ name: "Mode", value: "Manual grants only", inline: true }];
  const warning: FieldSpec | null = headsUp.length
    ? { name: "Heads-up", value: headsUp.join("\n") }
    : null;
  if (paused(mode))
    return heldCard("rank.paused", mode, viewer, saved, [...facts, warning], options);
  return card(
    rank ? (warning ? "rank.heads_up" : "rank.set") : "rank.cleared",
    {
      tone: warning ? "warning" : "success",
      title: rank ? "Officer rank set" : "Officer rank unset",
      description: saved,
      fields: [...facts, effectsField(mode, "Officer role check", viewer), warning],
      footer: "Audited as config.officer_rank",
    },
    options,
  );
}

/**
 * /config role_layout (spec #33, approved #34, spec #35). Turning it on shows the order and the
 * queued layout pass by its short job ID; paused, it is the paused-save card. Turning it off
 * queues nothing and never reverts earlier changes (approved #34, in every mode). Choosing the
 * current setting is the info no-op.
 */
export function roleLayoutReply(
  result: RoleLayoutResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const on = result.roleLayout === "enabled";
  if (result.status === "unchanged")
    return card(
      "layout.unchanged",
      {
        tone: "info",
        title: `Role layout is already ${on ? "on" : "off"}`,
        description: on
          ? `${marker("unchanged")} TaruBot already keeps the managed roles displayed separately, in order.`
          : `${marker("unchanged")} TaruBot already leaves role display and order alone.`,
      },
      options,
    );
  if (!on)
    return card(
      "layout.off",
      {
        tone: "success",
        title: "Role layout turned off",
        description:
          "Current role display and order are left as they are; the bot will no longer change them.",
        fields: [{ name: "Access roles", value: "Still assigned and removed as usual" }],
        footer: "Audited as config.role_layout",
      },
      options,
    );
  const saved =
    "FC Leader > Officer > Member > Guest will be displayed separately in the member list, as one consecutive block.";
  const order: FieldSpec = {
    name: "Order",
    value: result.order.length
      ? result.order.map(mentionRole).join(" > ")
      : "No managed roles are set yet.",
  };
  if (paused(result.effectsMode))
    return heldCard("layout.paused", result.effectsMode, viewer, saved, [order], options);
  return card(
    "layout.on",
    {
      tone: "success",
      title: "Role layout turned on",
      description: saved,
      fields: [
        order,
        effectsField(
          result.effectsMode,
          result.layoutJob ? `job ${code(shortId(result.layoutJob))}` : "",
          viewer,
          "Layout pass",
        ),
      ],
      footer: ["Audited as config.role_layout", "check progress with /sync status"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /setup

/** /setup's roles in the service's order, re-sorted into layout order with their labels. */
const SETUP_ROLES = [
  { field: "leader_role_id", label: "FC Leader" },
  { field: "officer_role_id", label: "Officer" },
  { field: "member_role_id", label: "Member" },
  { field: "guest_role_id", label: "Guest" },
] as const;

/** 'created' or 'reused', as the approved card marks each resource. */
const provenance = (created: boolean): string => (created ? "created" : "reused");

/** A list in prose: 'a', 'a and b', 'a, b and c'. */
function prose(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * /setup (approved configuration#37; spec #38). 'Server setup complete' when anything was
 * created, 'Server setup refreshed' when everything was reused. Access roles in layout order with
 * created or reused (and the holders adopted onto the Officer role), the rooms, the FC and its
 * queued roster read, the officer rank, where applications and officer alerts go, the role
 * layout, channel access as approved ('[WAIT] Securing channels · job …'), and next steps (the
 * ledger step only without a ledger channel). Paused, it is the paused-save card, with the rooms
 * in one field and no Channel access line (its job is held, which the Discord changes field and
 * the first next step say) so it stays within ten. Check sync status opens /sync status in a new
 * reply.
 */
export function setupReply(
  result: SetupResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const roles = SETUP_ROLES.map(({ field, label }) => {
    const role = result.roles.find((candidate) => candidate.field === field);
    if (!role) return null;
    const adopted =
      field === "officer_role_id" && result.adopted > 0
        ? `, ${count(result.adopted, "holder")} adopted as manual grants`
        : "";
    return `${label} ${mentionRole(role.id)} · ${provenance(role.created)}${adopted}`;
  }).filter((line): line is string => line !== null);
  const createdRoles = result.roles.filter((role) => role.created).length;
  const created = [
    createdRoles > 0 && count(createdRoles, "access role"),
    result.lobby.created && "a lobby",
    result.officerChannel.created && "an officer room",
  ].filter((item): item is string => Boolean(item));
  const everything = createdRoles === result.roles.length && created.length === 3;
  const built =
    created.length === 0
      ? "Existing roles and rooms were reused; nothing was duplicated."
      : `TaruBot created ${prose(created)}${everything ? "" : ", and reused the rest"}.`;
  const mode = result.effectsMode;
  const lobby = `${mentionChannel(result.lobby.id)} · ${provenance(result.lobby.created)}`;
  const officerRoom = `${mentionChannel(result.officerChannel.id)} · ${provenance(result.officerChannel.created)}`;
  const steps = [
    // While paused the channel-access job is held, so the first step says when it runs instead of
    // asking the manager to wait for a completion that can't come until then.
    paused(mode)
      ? `Channel access is secured ${whenApplied(mode)}; until then /sync status shows it as paused.`
      : "Run /sync status until channel access shows as completed.",
    result.ledgerChannelId === null &&
      "If you use the gil ledger, set a channel with /config ledger.",
    "Run /config validate.",
  ]
    .filter((step): step is string => Boolean(step))
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const settings: FieldSpec[] = [
    {
      name: "Free Company",
      value: result.fcId
        ? `FC ${result.fcId} · roster read queued`
        : "Not linked · /config fc link",
      inline: true,
    },
    {
      name: "Officer rank",
      value: result.officerRank ? userText(result.officerRank) : "Not set · manual grants only",
      inline: true,
    },
    {
      name: "Guest applications",
      value: `Open · reviews in ${mentionChannel(result.guestApplications.id)}`,
      inline: true,
    },
    {
      name: "Officer notifications",
      value: mentionChannel(result.officerNotifications.id),
      inline: true,
    },
    {
      name: "Role layout",
      value: result.roleLayoutEnabled
        ? "On · FC Leader > Officer > Member > Guest, displayed separately"
        : "Off · role display and order are left unchanged. Enable with /config role_layout enabled:true",
    },
  ];
  const nextSteps: FieldSpec = { name: "Next steps", value: steps };
  const accessRoles: FieldSpec = { name: "Access roles", value: roles.join("\n") };
  const buttons = [syncStatusButton()];
  const footer = "Setup is safe to rerun: existing roles and rooms are reused";
  if (paused(mode)) {
    const held = pausedSave(mode, viewer);
    return card(
      "setup.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${built} ${held.sentence}`,
        fields: [
          ...held.fields,
          accessRoles,
          { name: "Rooms", value: `Lobby ${lobby}\nOfficer room ${officerRoom}` },
          ...settings,
          nextSteps,
        ],
        // The approved #26 footer; Check sync status stays as the button.
        footer: held.footer,
        buttons,
      },
      options,
    );
  }
  return card(
    created.length ? "setup.created" : "setup.reused",
    {
      tone: "success",
      title: created.length ? "Server setup complete" : "Server setup refreshed",
      description: `${built} ${
        created.length
          ? "Channel permissions are being secured in the background."
          : "Channel permissions are being re-checked in the background."
      }`,
      fields: [
        accessRoles,
        { name: "Lobby", value: lobby, inline: true },
        { name: "Officer room", value: officerRoom, inline: true },
        ...settings,
        {
          name: "Channel access",
          value: `${CHECK.wait} Securing channels · job ${shortId(result.accessJob)}`,
        },
        nextSteps,
      ],
      footer,
      buttons,
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /officer grant and revoke

/**
 * /officer grant and revoke (approved configuration#41; spec #42). Both are success. The Discord
 * role line says what is queued, 'Applies if they rejoin' for someone who left, and that nothing
 * applies until an Officer role is bound when none is. Repeating the current state says only the
 * reason was updated. Paused, a queued change is the paused-save card. The reason is the manager's
 * own text, capped at 300 characters.
 */
export function officerOverrideReply(
  result: OfficerOverrideResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const grant = result.status === "granted";
  const who = mentionUser(result.user);
  const mode = result.effectsMode;
  const recorded = result.effects === "recorded";
  const repeated = result.previous === result.status;
  const memberField: FieldSpec = { name: "Member", value: who, inline: true };
  const reasonField: FieldSpec = { name: "Reason", value: userText(result.reason) };
  const footer = `Audited as officer.${grant ? "grant" : "revoke"}`;
  const work = grant ? "Assignment" : "Removal";
  const lead = grant
    ? `${who} now has bot officer access and will receive the Officer role. This grant doesn't depend on in-game rank and lasts until a server manager runs /officer revoke or /officer reset.`
    : `${who} no longer has bot officer access, and the Officer role will be removed. This revoke also overrides the in-game rank until a server manager runs /officer grant or /officer reset.`;
  const discordRole = (value: string): FieldSpec => ({ name: "Discord role", value, inline: true });
  if (!recorded && result.present && !repeated && paused(mode))
    return heldCard("officer.paused", mode, viewer, lead, [memberField, reasonField], options);
  let kind: ConfigReplyKind;
  let description: string;
  let role: string;
  if (recorded) {
    // Officer authority needs the bound Officer role, so a recorded override confers nothing yet.
    kind = "officer.recorded";
    description = `The officer ${grant ? "grant" : "revoke"} for ${who} is recorded. No Officer role is set yet, so it takes effect once /config roles officer binds one.`;
    role = "Applies once an Officer role is set";
  } else if (!result.present) {
    kind = "officer.absent";
    description = `${who} isn't in the server now, so this applies if they rejoin. ${
      grant
        ? "This grant doesn't depend on in-game rank."
        : "This revoke also overrides the in-game rank until a server manager runs /officer grant or /officer reset."
    }`;
    role = "Applies if they rejoin";
  } else if (repeated) {
    kind = "officer.repeated";
    description = grant
      ? `${marker("unchanged")} ${who} already had bot officer access, so only the reason was updated.`
      : `${marker("unchanged")} ${who}'s officer access was already revoked, so only the reason was updated.`;
    role = paused(mode) ? `${work} applies ${whenApplied(mode)}` : `${work} queued`;
  } else {
    kind = grant ? "officer.granted" : "officer.revoked";
    description = lead;
    role = `${work} queued`;
  }
  return card(
    kind,
    {
      tone: "success",
      title: grant ? "Officer access granted" : "Officer access revoked",
      description,
      fields: [memberField, discordRole(role), reasonField],
      footer,
    },
    options,
  );
}

/**
 * /officer reset (owner decision, 2026-09-24): the grant or revoke override removed, so the
 * in-game rank decides again, or nobody without an /officer grant when no rank is set. Success;
 * nothing to remove is the info '= NO CHANGE' card. The Discord role line matches the grant and
 * revoke receipts; paused, a queued change is the paused-save card.
 */
export function officerResetReply(
  result: OfficerResetResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const who = mentionUser(result.user);
  const mode = result.effectsMode;
  const memberField: FieldSpec = { name: "Member", value: who, inline: true };
  const reasonField: FieldSpec = { name: "Reason", value: userText(result.reason) };
  // What decides now, as its own sentence: the rank, or (with none set) only /officer grant.
  const decides = result.rankConfigured
    ? "The in-game rank decides their officer access."
    : "No officer rank is set, so only /officer grant confers officer access.";
  if (result.status === "unchanged")
    return card(
      "officer.reset_unchanged",
      {
        tone: "info",
        title: "No officer override to remove",
        description: `${marker("unchanged")} ${who} has no officer grant or revoke. ${decides}`,
        fields: [memberField],
      },
      options,
    );
  const removed = result.previous === "granted" ? "officer grant" : "officer revoke";
  const lead = `${who}'s ${removed} is removed. ${decides}`;
  const recorded = result.effects === "recorded";
  if (!recorded && result.present && paused(mode))
    return heldCard(
      "officer.reset_paused",
      mode,
      viewer,
      lead,
      [memberField, reasonField],
      options,
    );
  const role = recorded
    ? "Applies once an Officer role is set"
    : !result.present
      ? "Applies if they rejoin"
      : "Update queued";
  return card(
    "officer.reset",
    {
      tone: "success",
      title: "Officer override removed",
      description: lead,
      fields: [memberField, { name: "Discord role", value: role, inline: true }, reasonField],
      footer: "Audited as officer.reset",
    },
    options,
  );
}
