/**
 * The configuration reply catalog: one case per ConfigReplyKind, rendered from typed sample
 * results that reproduce the approved mockups (configuration#4, #7, #8, #9, #18, #34, #37 and
 * #41) and the reply-specs states. The builders and sample results are exported so the presenter,
 * command and component tests can vary one fact at a time and return them from service stubs.
 */
import type { GuildRecord } from "../../../src/application/records.js";
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
} from "../../../src/application/results.js";
import {
  changeReply,
  fcUnlinkReply,
  guestApplicationsReply,
  healthReply,
  officerOverrideReply,
  officerRankReply,
  officerResetReply,
  roleLayoutReply,
  setupReply,
  showReply,
  type ConfigReplyKind,
} from "../../../src/discord/presenters/configuration.js";
import { HOUSE_LIMITS } from "../../../src/discord/presenters/style.js";
import { guestApplicationsOpen } from "../../../src/domain/guest-application.js";
import { CORE_PERMISSIONS, type CorePermission } from "../../../src/domain/permissions.js";
import type { VisibilityReport } from "../../../src/domain/visibility.js";
import { GUILD_ID, NOW, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** A time as the approved cards' <t:…> values write it. */
const unix = (seconds: number): Date => new Date(seconds * 1_000);

/** The approved configuration cards' Free Company. */
export const CONFIG_FC: FcRef = {
  id: "9234567890123456789",
  name: "Example Company",
  tag: "EXMPL",
  world: "Diabolos",
};

/** The approved cards' managed roles. */
export const ROLE = {
  leader: "223456789012345604",
  officer: "223456789012345603",
  member: "223456789012345601",
  guest: "223456789012345602",
  /** A role replaced by a new binding (spec #16). */
  previous: "223456789012345699",
  /** TaruBot's own managed bot role (2.35.0's role checks). */
  bot: "223456789012345690",
} as const;

/** The approved cards' channels. */
export const CHANNEL = {
  ledger: "323456789012345601",
  notices: "323456789012345602",
  reviews: "323456789012345603",
  lobby: "323456789012345604",
  officers: "323456789012345605",
  /** Where update posts go (2.25.0); unset in the approved cards, which predate it. */
  changelog: "323456789012345606",
} as const;

/** The approved layout pass and channel-access jobs (configuration#33 and #37). */
export const LAYOUT_JOB = "0b6f3c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
export const ACCESS_JOB = "0b6f3c2e-9f8e-4d7c-8b6a-5f4e3d2c1b0a";

/** The member an officer override names (configuration#41). */
export const OVERRIDE_USER = "423456789012345678";

/**
 * A fully configured, activated guild (configuration#4 and #7): an FC, all four roles, the three
 * channels, onboarding with its lobby and officer room, the role layout on, revision 42. The
 * changelog channel (2.25.0) is unset, as it is on every server until officers choose one.
 */
export const configGuild = (overrides: Partial<GuildRecord> = {}): GuildRecord => ({
  id: GUILD_ID,
  fc_id: CONFIG_FC.id,
  member_role_id: ROLE.member,
  guest_role_id: ROLE.guest,
  officer_role_id: ROLE.officer,
  leader_role_id: ROLE.leader,
  officer_rank_name: "Officer",
  officer_rank_key: "officer",
  ledger_channel_id: CHANNEL.ledger,
  officer_notifications_channel_id: CHANNEL.notices,
  guest_application_channel_id: CHANNEL.reviews,
  guest_applications_enabled: true,
  lobby_channel_id: CHANNEL.lobby,
  officer_channel_id: CHANNEL.officers,
  access_policy_enabled: true,
  access_everyone_before: "1024",
  revision: 42n,
  active: true,
  effects_enabled: true,
  role_layout_enabled: true,
  guest_grandfather: null,
  guest_grandfathered_at: null,
  changelog_channel_id: null,
  changelog_version: null,
  ...overrides,
});

/** The linked FC's health row: read fresh at the approved time unless overridden. */
export const fcRow = (overrides: Partial<FcHealthRow> = {}): FcHealthRow => ({
  ...CONFIG_FC,
  last_successful_roster_at: unix(1_790_143_200),
  last_attempt_at: unix(1_790_143_200),
  last_error: null,
  fresh: true,
  attemptFailed: false,
  ...overrides,
});

/** Every role and channel column validate() checks. */
const RESOURCE_COLUMNS = [
  "member_role_id",
  "guest_role_id",
  "officer_role_id",
  "leader_role_id",
  "ledger_channel_id",
  "officer_notifications_channel_id",
  "guest_application_channel_id",
  "lobby_channel_id",
  "officer_channel_id",
  "changelog_channel_id",
] as const;

/**
 * TaruBot's role and channel view as validate() reports it (2.35.0, #46): a healthy one unless
 * overridden, with Administrator off, the core seven from TaruBot's own role, nothing it never
 * needs, its role above the access roles, every channel visible and no private category.
 * `onboarding` picks the mode: onboarding servers also get onboarding's permissions (all held)
 * and nothing pending for onboarding's channel pass.
 */
export const visibilityReport = (
  overrides: Partial<VisibilityReport> = {},
  onboarding = true,
): VisibilityReport => ({
  mode: onboarding ? "onboarding" : "checked",
  administrator: { held: false, roles: [], shared: [] },
  core: (Object.keys(CORE_PERMISSIONS) as CorePermission[]).map((permission) => ({
    permission,
    source: "own_role",
    roles: [],
  })),
  onboardingMissing: onboarding ? [] : null,
  neverNeeded: [],
  roleOrder: { highest: ROLE.bot, notBelow: [], throughShared: [] },
  missing: { categories: [], inside: [], channels: [], posting: [], unreadable: [] },
  masked: [],
  denied: [],
  hiddenOnPurpose: [],
  hiddenByCategory: [],
  privateCategories: [],
  onboardingPending: onboarding ? { managed: [], unmanaged: [] } : null,
  missingCount: 0,
  administratorNeeded: false,
  ...overrides,
});

/**
 * A /config show and validate report, as Service.validate builds it: every configured resource
 * available and every unset one unconfigured unless `capabilities` overrides it, the effects
 * mode derived from the guild unless given, and a healthy visibility report unless given.
 */
export function configReport(
  options: {
    readonly guild?: GuildRecord;
    readonly effectsMode?: EffectsMode;
    readonly capabilities?: Readonly<Record<string, string>>;
    readonly fc?: FcHealthRow;
    /** The changelog channel's audience, as validate() reports it in an onboarding guild. */
    readonly changelogAudience?: ChangelogAudience;
    /** TaruBot's view (2.35.0); a healthy one in the guild's mode unless given, null unreadable. */
    readonly visibility?: VisibilityReport | null;
  } = {},
): ConfigurationReport {
  const guild = options.guild ?? configGuild();
  const mode = options.effectsMode ?? (guild.effects_enabled ? "live" : "awaiting_activation");
  const capabilities: Record<string, string> = {};
  for (const column of RESOURCE_COLUMNS)
    capabilities[column] = guild[column] === null ? "unconfigured" : "available";
  return {
    configuration: guild,
    effectsGloballyEnabled: mode !== "deployment_disabled",
    effectsMode: mode,
    roleLayout: guild.role_layout_enabled
      ? "enabled"
      : "disabled (role display and order are not changed by the bot)",
    capabilities: { ...capabilities, ...options.capabilities },
    guestApplicationsOpen: guestApplicationsOpen(guild),
    fc: guild.fc_id ? [options.fc ?? fcRow()] : null,
    ...(options.changelogAudience ? { changelogAudience: options.changelogAudience } : {}),
    visibility:
      options.visibility === undefined
        ? visibilityReport({}, guild.access_policy_enabled)
        : options.visibility,
  };
}

/** A saved configure() change of `field` to `value` in a live guild, unless overridden. */
export function configChange(
  field: string,
  value: string | null,
  overrides: Partial<Extract<ConfigChange, { readonly status: "saved" }>> = {},
): Extract<ConfigChange, { readonly status: "saved" }> {
  return {
    status: "saved",
    effects: "queued",
    effectsMode: "live",
    field,
    value,
    previous: null,
    rebound: false,
    requeued: 0,
    company: null,
    guild: configGuild({ revision: 43n }),
    ...overrides,
  };
}

/**
 * A saved /config guest_applications result: [previous, value] for the switch and the review
 * channel (default: the reviews channel both times), on the configured guild after the change.
 */
export function applications(options: {
  readonly enabled: readonly [boolean, boolean];
  readonly channel?: readonly [string | null, string | null];
  readonly guild?: Partial<GuildRecord>;
  readonly effectsMode?: EffectsMode;
}): Extract<GuestApplicationsResult, { readonly status: "saved" }> {
  const [previousChannel, channel] = options.channel ?? [CHANNEL.reviews, CHANNEL.reviews];
  return {
    status: "saved",
    effects: "queued",
    effectsMode: options.effectsMode ?? "live",
    enabled: { previous: options.enabled[0], value: options.enabled[1] },
    channel: { previous: previousChannel, value: channel },
    requeued: 0,
    guild: configGuild({
      revision: 43n,
      guest_applications_enabled: options.enabled[1],
      guest_application_channel_id: channel,
      ...options.guild,
    }),
  };
}

/** The imported, not yet activated guild of configuration#6 and #9. */
const IMPORTED = configGuild({
  revision: 7n,
  leader_role_id: null,
  // 2.15.0 imports keep the legacy review channel with applications switched off.
  guest_applications_enabled: false,
  lobby_channel_id: null,
  officer_channel_id: null,
  access_policy_enabled: false,
  effects_enabled: false,
  role_layout_enabled: false,
  guest_grandfather: "pending",
});

/** The guild of the approved problems checklist (configuration#8). */
const TROUBLED = configGuild({
  guest_application_channel_id: null,
  guest_applications_enabled: false,
  lobby_channel_id: null,
  officer_channel_id: null,
  access_policy_enabled: false,
  effects_enabled: false,
  role_layout_enabled: false,
});

/** A /setup result: the approved fresh setup (configuration#37) unless overridden. */
export const setupResult = (overrides: Partial<SetupResult> = {}): SetupResult => ({
  status: "configured",
  roles: [
    { field: "member_role_id", name: "Member", id: ROLE.member, created: true },
    { field: "guest_role_id", name: "Guest", id: ROLE.guest, created: true },
    { field: "officer_role_id", name: "Officer", id: ROLE.officer, created: true },
    { field: "leader_role_id", name: "FC Leader", id: ROLE.leader, created: true },
  ],
  fcId: CONFIG_FC.id,
  company: null,
  officerRank: "Officer",
  effects: "queued",
  effectsMode: "live",
  roleLayout: "FC Leader > Officer > Member > Guest; consecutive block; display separately",
  roleLayoutEnabled: true,
  layoutJob: LAYOUT_JOB,
  lobby: { id: CHANNEL.lobby, created: true },
  officerChannel: { id: CHANNEL.officers, created: true },
  accessPolicy: "queued",
  accessJob: ACCESS_JOB,
  adopted: 0,
  officerNotifications: { id: CHANNEL.officers, defaulted: true },
  guestApplications: { id: CHANNEL.officers, defaulted: true },
  ledgerChannelId: null,
  instructions:
    "Channel enforcement is queued; inspect /sync status until secured. Configure a ledger channel if needed, then run /config validate.",
  ...overrides,
});

/** An /officer grant or revoke: the approved grant (configuration#41) unless overridden. */
export const override = (
  overrides: Partial<OfficerOverrideResult> = {},
): OfficerOverrideResult => ({
  status: "granted",
  effects: "queued",
  effectsMode: "live",
  user: OVERRIDE_USER,
  reason: "Runs FC events while the officer rank is vacant.",
  present: true,
  previous: null,
  ...overrides,
});

/** An /officer reset result: a grant removed with the rank configured, unless overridden. */
export const officerReset = (overrides: Partial<OfficerResetResult> = {}): OfficerResetResult => ({
  status: "reset",
  effects: "queued",
  effectsMode: "live",
  user: OVERRIDE_USER,
  reason: "Back to the in-game rank now the vacancy is filled.",
  present: true,
  previous: "granted",
  rankConfigured: true,
  ...overrides,
});

/** A /config officer_rank result: the rank Officer in a configured guild unless overridden. */
export const rankResult = (overrides: Partial<OfficerRankResult> = {}): OfficerRankResult => ({
  status: "saved",
  officerRank: "Officer",
  previous: null,
  mode: "rank_and_manual_overrides",
  effects: "queued",
  effectsMode: "live",
  fcLinked: true,
  officerRoleId: ROLE.officer,
  ...overrides,
});

/** A saved /config role_layout enabled:true (spec #33) unless overridden. */
export const layoutOn = (
  overrides: Partial<Extract<RoleLayoutResult, { readonly status: "saved" }>> = {},
): RoleLayoutResult => ({
  status: "saved",
  roleLayout: "enabled",
  effects: "queued",
  effectsMode: "live",
  layoutJob: LAYOUT_JOB,
  order: [ROLE.leader, ROLE.officer, ROLE.member, ROLE.guest],
  note: "FC Leader > Officer > Member > Guest will display separately in one consecutive block; see /sync status.",
  ...overrides,
});

/** A /config fc unlink result for the approved FC. */
export const unlinked = (overrides: Partial<FcUnlinkResult> = {}): FcUnlinkResult => ({
  status: "unlinked",
  effects: "queued",
  effectsMode: "live",
  company: CONFIG_FC,
  ...overrides,
});

/** The sample results, for command and component tests that stub the service. */
export const CONFIG_RESULTS = {
  healthy: configReport(),
  imported: configReport({ guild: IMPORTED }),
  troubled: configReport({
    guild: TROUBLED,
    capabilities: {
      officer_role_id:
        "Give the bot Manage Roles and place its role above the configured access role.",
      officer_notifications_channel_id:
        "Choose a text channel in this guild where the bot can view, send, embed links, and read message history.",
    },
    fc: fcRow({
      last_successful_roster_at: unix(1_790_056_800),
      last_attempt_at: unix(1_790_146_800),
      last_error: "unavailable",
      fresh: false,
      attemptFailed: true,
    }),
  }),
  partial: configReport({
    guild: configGuild({
      revision: 2n,
      member_role_id: null,
      guest_role_id: null,
      officer_role_id: null,
      leader_role_id: null,
      officer_rank_name: null,
      officer_rank_key: null,
      ledger_channel_id: null,
      officer_notifications_channel_id: null,
      guest_application_channel_id: null,
      lobby_channel_id: null,
      officer_channel_id: null,
      access_policy_enabled: false,
    }),
    fc: fcRow({ last_successful_roster_at: null, fresh: false }),
  }),
  linked: configChange("fc_id", CONFIG_FC.id, { company: CONFIG_FC }),
  alreadyLinked: { status: "unchanged", field: "fc_id", value: CONFIG_FC.id },
  memberSet: configChange("member_role_id", ROLE.member, { previous: ROLE.previous }),
  officerAdopted: configChange("officer_role_id", ROLE.officer, {
    officerHolders: {
      adopt: true,
      adopted: 3,
      sample: ["423456789012345601", "423456789012345602", "423456789012345603"],
    },
  }),
  officerNotAdopted: configChange("officer_role_id", ROLE.officer, {
    guild: configGuild({
      role_layout_enabled: false,
      access_policy_enabled: false,
      revision: 8n,
    }),
    officerHolders: { adopt: false, adopted: 0, sample: [] },
  }),
  ledgerSet: configChange("ledger_channel_id", CHANNEL.ledger, { requeued: 2 }),
  /** A first changelog channel in an onboarding guild, where onboarding shows it to members. */
  changelogSet: configChange("changelog_channel_id", CHANNEL.changelog, {
    audience: "members",
    guild: configGuild({
      revision: 43n,
      changelog_channel_id: CHANNEL.changelog,
      changelog_version: "2.25.0",
    }),
  }),
  unlinked: unlinked(),
  setup: setupResult(),
  granted: override(),
  rank: rankResult(),
  layoutOn: layoutOn(),
} as const satisfies Record<
  string,
  | ConfigurationReport
  | ConfigChange
  | FcUnlinkResult
  | SetupResult
  | OfficerOverrideResult
  | OfficerRankResult
  | RoleLayoutResult
>;

/** Shorthands for the sample results. */
const R = CONFIG_RESULTS;
/** Every case renders against the mockups' clock. */
const now = NOW;
/** /config show keeps its approved layout under its documented field exemption (C3). */
const SHOW_FIELDS = HOUSE_LIMITS.configShowFields;

/** Every configuration reply state, rendered for the audience its card is written for. */
export const CONFIG_CASES = {
  "show.configured": {
    spec: "configuration#4",
    audience: "officer",
    tone: "info",
    title: "Server configuration",
    timestamp: true,
    maxFields: SHOW_FIELDS,
    render: () => showReply(R.healthy, VIEWERS.officer, { now }),
  },
  "show.partial": {
    spec: "configuration#5",
    audience: "officer",
    tone: "info",
    title: "Server configuration",
    timestamp: true,
    maxFields: SHOW_FIELDS,
    render: () => showReply(R.partial, VIEWERS.officer, { now }),
  },
  "show.paused": {
    spec: "configuration#6",
    audience: "officer",
    tone: "pending",
    title: "Server configuration",
    timestamp: true,
    maxFields: SHOW_FIELDS,
    render: () => showReply(R.imported, VIEWERS.officer, { now }),
  },
  "validate.healthy": {
    spec: "configuration#7",
    audience: "officer",
    readOnly: true,
    tone: "success",
    title: "Configuration health · all checks passed",
    timestamp: true,
    render: () => healthReply(R.healthy, VIEWERS.officer, { now }),
  },
  "validate.problems": {
    spec: "configuration#8",
    audience: "officer",
    readOnly: true,
    tone: "error",
    title: "Configuration health · 2 problems, 2 warnings",
    timestamp: true,
    render: () => healthReply(R.troubled, VIEWERS.officer, { now }),
  },
  "validate.warnings": {
    spec: null,
    audience: "officer",
    readOnly: true,
    tone: "warning",
    title: "Configuration health · 1 warning",
    timestamp: true,
    render: () =>
      healthReply(configReport({ effectsMode: "deployment_disabled" }), VIEWERS.officer, { now }),
  },
  "validate.ready": {
    spec: "configuration#9",
    audience: "officer",
    readOnly: true,
    tone: "pending",
    title: "Configuration health · ready for activation",
    timestamp: true,
    render: () => healthReply(R.imported, VIEWERS.officer, { now }),
  },
  "fc.linked": {
    spec: "configuration#10",
    audience: "officer",
    tone: "success",
    title: "Free Company linked",
    timestamp: true,
    render: () => changeReply(R.linked, VIEWERS.officer, { now }),
  },
  "fc.unchanged": {
    spec: "configuration#11",
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Free Company already linked",
    timestamp: false,
    render: () => changeReply(R.alreadyLinked, VIEWERS.officer, { now }),
  },
  "fc.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      changeReply({ ...R.linked, effectsMode: "awaiting_activation" }, VIEWERS.officer, { now }),
  },
  "fc.unlinked": {
    spec: "configuration#14",
    audience: "officer",
    tone: "success",
    title: "Free Company unlinked",
    timestamp: true,
    render: () => fcUnlinkReply(R.unlinked, VIEWERS.officer, { fcId: CONFIG_FC.id, now }),
  },
  "fc.unlink_paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      fcUnlinkReply(unlinked({ effectsMode: "deployment_disabled" }), VIEWERS.officer, {
        fcId: CONFIG_FC.id,
        now,
      }),
  },
  "role.set": {
    spec: "configuration#16",
    audience: "officer",
    tone: "success",
    title: "Member role set",
    timestamp: true,
    render: () => changeReply(R.memberSet, VIEWERS.officer, { now }),
  },
  "role.leader": {
    spec: "configuration#19",
    audience: "manager",
    tone: "success",
    title: "FC Leader role set",
    timestamp: true,
    render: () =>
      changeReply(configChange("leader_role_id", ROLE.leader), VIEWERS.manager, { now }),
  },
  "role.leader_no_fc": {
    spec: "configuration#19",
    audience: "manager",
    tone: "warning",
    title: "FC Leader role set",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("leader_role_id", ROLE.leader, { guild: configGuild({ fc_id: null }) }),
        VIEWERS.manager,
        { now },
      ),
  },
  "role.officer_adopted": {
    spec: "configuration#17",
    audience: "manager",
    tone: "success",
    title: "Officer role set",
    timestamp: true,
    render: () => changeReply(R.officerAdopted, VIEWERS.manager, { now }),
  },
  "role.officer_not_adopted": {
    spec: "configuration#18",
    audience: "manager",
    tone: "success",
    title: "Officer role set without adopting holders",
    timestamp: true,
    render: () => changeReply(R.officerNotAdopted, VIEWERS.manager, { now }),
  },
  "role.officer_no_rank": {
    spec: "configuration#18",
    audience: "manager",
    tone: "warning",
    title: "Officer role set without adopting holders",
    timestamp: true,
    render: () =>
      changeReply(
        {
          ...R.officerNotAdopted,
          guild: configGuild({ officer_rank_name: null, officer_rank_key: null }),
        },
        VIEWERS.manager,
        { now },
      ),
  },
  "role.cleared": {
    spec: "configuration#20",
    audience: "manager",
    tone: "success",
    title: "Officer role unset",
    timestamp: true,
    render: () =>
      changeReply(
        // Onboarding refuses clears, so a cleared role belongs to a guild without it.
        configChange("officer_role_id", null, {
          previous: ROLE.officer,
          guild: configGuild({ officer_role_id: null, access_policy_enabled: false }),
        }),
        VIEWERS.manager,
        { now },
      ),
  },
  "role.unchanged": {
    spec: null,
    audience: "manager",
    noOp: true,
    tone: "info",
    title: "Officer role already set",
    timestamp: false,
    render: () =>
      changeReply(
        configChange("officer_role_id", ROLE.officer, {
          previous: ROLE.officer,
          rebound: true,
          officerHolders: { adopt: true, adopted: 0, sample: [] },
        }),
        VIEWERS.manager,
        { now },
      ),
  },
  "role.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      changeReply({ ...R.officerNotAdopted, effectsMode: "awaiting_activation" }, VIEWERS.manager, {
        now,
      }),
  },
  "channel.ledger": {
    spec: "configuration#23",
    audience: "officer",
    tone: "success",
    title: "Ledger channel set",
    timestamp: true,
    render: () => changeReply(R.ledgerSet, VIEWERS.officer, { now }),
  },
  "channel.ledger_no_fc": {
    spec: "configuration#23",
    audience: "officer",
    tone: "warning",
    title: "Ledger channel set",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("ledger_channel_id", CHANNEL.ledger, { guild: configGuild({ fc_id: null }) }),
        VIEWERS.officer,
        { now },
      ),
  },
  "channel.ledger_cleared": {
    spec: "configuration#24",
    audience: "officer",
    tone: "success",
    title: "Ledger channel unset",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("ledger_channel_id", null, { previous: CHANNEL.ledger }),
        VIEWERS.officer,
        { now },
      ),
  },
  "channel.notifications": {
    spec: "configuration#25",
    audience: "officer",
    tone: "success",
    title: "Officer notifications channel set",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("officer_notifications_channel_id", CHANNEL.notices),
        VIEWERS.officer,
        { now },
      ),
  },
  "channel.notifications_cleared": {
    spec: "configuration#26",
    audience: "officer",
    tone: "success",
    title: "Officer notifications turned off",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("officer_notifications_channel_id", null, { previous: CHANNEL.notices }),
        VIEWERS.officer,
        { now },
      ),
  },
  // /config changelog (2.25.0): where update posts go.
  "channel.changelog": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Changelog channel set",
    timestamp: true,
    render: () => changeReply(R.changelogSet, VIEWERS.officer, { now }),
  },
  "channel.changelog_hidden": {
    spec: null,
    audience: "officer",
    tone: "warning",
    title: "Changelog channel set",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("changelog_channel_id", CHANNEL.officers, {
          audience: "hidden",
          guild: configGuild({ revision: 43n, changelog_channel_id: CHANNEL.officers }),
        }),
        VIEWERS.officer,
        { now },
      ),
  },
  "channel.changelog_cleared": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Changelog posts turned off",
    timestamp: true,
    render: () =>
      changeReply(
        configChange("changelog_channel_id", null, { previous: CHANNEL.changelog }),
        VIEWERS.officer,
        { now },
      ),
  },
  // /config guest_applications (owner decision, 2026-09-24): the switch and the review channel.
  "applications.open": {
    spec: "configuration#27",
    audience: "officer",
    tone: "success",
    title: "Guest applications open",
    timestamp: true,
    render: () =>
      guestApplicationsReply(applications({ enabled: [false, true] }), VIEWERS.officer, { now }),
  },
  "applications.review_changed": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Review channel changed",
    timestamp: true,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [true, true], channel: [CHANNEL.notices, CHANNEL.reviews] }),
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.no_role": {
    spec: "configuration#27",
    audience: "officer",
    tone: "warning",
    title: "Guest applications on; Guest role still needed",
    timestamp: true,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [false, true], guild: { guest_role_id: null } }),
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.no_channel": {
    spec: null,
    audience: "officer",
    tone: "warning",
    title: "Guest applications on; review channel needed",
    timestamp: true,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [false, true], channel: [null, null] }),
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.closed": {
    spec: "configuration#28",
    audience: "officer",
    tone: "success",
    title: "Guest applications closed",
    timestamp: true,
    render: () =>
      guestApplicationsReply(applications({ enabled: [true, false] }), VIEWERS.officer, { now }),
  },
  "applications.review_set": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Review channel set",
    timestamp: true,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [false, false], channel: [null, CHANNEL.reviews] }),
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.review_unset": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Review channel unset",
    timestamp: true,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [false, false], channel: [CHANNEL.reviews, null] }),
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.unchanged": {
    spec: null,
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Guest applications already set",
    timestamp: false,
    render: () =>
      guestApplicationsReply(
        {
          status: "unchanged",
          effectsMode: "live",
          enabled: true,
          channel: CHANNEL.reviews,
          guild: configGuild(),
        },
        VIEWERS.officer,
        { now },
      ),
  },
  "applications.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      guestApplicationsReply(
        applications({ enabled: [true, false], effectsMode: "awaiting_activation" }),
        VIEWERS.officer,
        { now },
      ),
  },
  "channel.unchanged": {
    spec: null,
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Ledger channel already set",
    timestamp: false,
    render: () =>
      changeReply(
        configChange("ledger_channel_id", CHANNEL.ledger, {
          previous: CHANNEL.ledger,
          rebound: true,
        }),
        VIEWERS.officer,
        { now },
      ),
  },
  // A channel setting saved while Discord changes are paused is the #26 card like any change.
  "channel.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      changeReply({ ...R.ledgerSet, effectsMode: "awaiting_activation" }, VIEWERS.officer, { now }),
  },
  "rank.set": {
    spec: "configuration#30",
    audience: "manager",
    tone: "success",
    title: "Officer rank set",
    timestamp: true,
    render: () => officerRankReply(R.rank, VIEWERS.manager, { now }),
  },
  "rank.heads_up": {
    spec: "configuration#30",
    audience: "manager",
    tone: "warning",
    title: "Officer rank set",
    timestamp: true,
    render: () =>
      officerRankReply(rankResult({ fcLinked: false, officerRoleId: null }), VIEWERS.manager, {
        now,
      }),
  },
  "rank.cleared": {
    spec: "configuration#31",
    audience: "manager",
    tone: "success",
    title: "Officer rank unset",
    timestamp: true,
    render: () =>
      officerRankReply(
        rankResult({ officerRank: null, previous: "Officer", mode: "manual_only" }),
        VIEWERS.manager,
        { now },
      ),
  },
  "rank.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      officerRankReply(rankResult({ effectsMode: "awaiting_activation" }), VIEWERS.manager, {
        now,
      }),
  },
  // The saved rank again is a no-op (owner decision, 2026-09-24: never imply a change).
  "rank.unchanged": {
    spec: null,
    audience: "manager",
    noOp: true,
    tone: "info",
    title: "Officer rank already set",
    timestamp: false,
    render: () =>
      officerRankReply(
        rankResult({ status: "unchanged", effects: "unchanged", previous: "Officer" }),
        VIEWERS.manager,
        { now },
      ),
  },
  "layout.on": {
    spec: "configuration#33",
    audience: "manager",
    tone: "success",
    title: "Role layout turned on",
    timestamp: true,
    render: () => roleLayoutReply(R.layoutOn, VIEWERS.manager, { now }),
  },
  "layout.off": {
    spec: "configuration#34",
    audience: "manager",
    tone: "success",
    title: "Role layout turned off",
    timestamp: true,
    render: () =>
      roleLayoutReply(
        {
          status: "saved",
          roleLayout: "disabled",
          effects: "none",
          effectsMode: "live",
          layoutJob: null,
          order: [ROLE.leader, ROLE.officer, ROLE.member, ROLE.guest],
          note: "Current role display and order are left as they are; the bot will no longer change them.",
        },
        VIEWERS.manager,
        { now },
      ),
  },
  "layout.unchanged": {
    spec: "configuration#35",
    audience: "manager",
    noOp: true,
    tone: "info",
    title: "Role layout is already on",
    timestamp: false,
    render: () =>
      roleLayoutReply(
        { status: "unchanged", roleLayout: "enabled", effectsMode: "live" },
        VIEWERS.manager,
        { now },
      ),
  },
  "layout.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      roleLayoutReply(layoutOn({ effectsMode: "awaiting_activation" }), VIEWERS.manager, { now }),
  },
  "setup.created": {
    spec: "configuration#37",
    audience: "manager",
    tone: "success",
    title: "Server setup complete",
    timestamp: true,
    render: () => setupReply(R.setup, VIEWERS.manager, { now }),
  },
  "setup.reused": {
    spec: "configuration#38",
    audience: "manager",
    tone: "success",
    title: "Server setup refreshed",
    timestamp: true,
    render: () =>
      setupReply(
        setupResult({
          roles: R.setup.roles.map((role) => ({ ...role, created: false })),
          lobby: { id: CHANNEL.lobby, created: false },
          officerChannel: { id: CHANNEL.officers, created: false },
          adopted: 3,
          ledgerChannelId: CHANNEL.ledger,
          roleLayoutEnabled: false,
          layoutJob: null,
        }),
        VIEWERS.manager,
        { now },
      ),
  },
  "setup.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      setupReply(setupResult({ effectsMode: "awaiting_activation" }), VIEWERS.manager, { now }),
  },
  "officer.granted": {
    spec: "configuration#41",
    audience: "manager",
    tone: "success",
    title: "Officer access granted",
    timestamp: true,
    render: () => officerOverrideReply(R.granted, VIEWERS.manager, { now }),
  },
  "officer.revoked": {
    spec: "configuration#42",
    audience: "manager",
    tone: "success",
    title: "Officer access revoked",
    timestamp: true,
    render: () =>
      officerOverrideReply(
        override({ status: "revoked", reason: "Stepped down from the officer team." }),
        VIEWERS.manager,
        { now },
      ),
  },
  "officer.repeated": {
    spec: null,
    audience: "manager",
    tone: "success",
    title: "Officer access granted",
    timestamp: true,
    render: () => officerOverrideReply(override({ previous: "granted" }), VIEWERS.manager, { now }),
  },
  "officer.absent": {
    spec: "configuration#42",
    audience: "manager",
    tone: "success",
    title: "Officer access revoked",
    timestamp: true,
    render: () =>
      officerOverrideReply(
        override({ status: "revoked", present: false, reason: "Left the server." }),
        VIEWERS.manager,
        { now },
      ),
  },
  "officer.recorded": {
    spec: null,
    audience: "manager",
    tone: "success",
    title: "Officer access granted",
    timestamp: true,
    render: () =>
      officerOverrideReply(
        override({ effects: "recorded", effectsMode: "awaiting_activation" }),
        VIEWERS.manager,
        { now },
      ),
  },
  "officer.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      officerOverrideReply(override({ effectsMode: "deployment_disabled" }), VIEWERS.manager, {
        now,
      }),
  },
  "officer.reset": {
    spec: null,
    audience: "manager",
    tone: "success",
    title: "Officer override removed",
    timestamp: true,
    render: () => officerResetReply(officerReset(), VIEWERS.manager, { now }),
  },
  "officer.reset_unchanged": {
    spec: null,
    audience: "manager",
    noOp: true,
    tone: "info",
    title: "No officer override to remove",
    timestamp: false,
    render: () =>
      officerResetReply(
        officerReset({ status: "unchanged", effects: "unchanged", previous: null }),
        VIEWERS.manager,
        { now },
      ),
  },
  "officer.reset_paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      officerResetReply(officerReset({ effectsMode: "deployment_disabled" }), VIEWERS.manager, {
        now,
      }),
  },
} as const satisfies ReplyCatalog<ConfigReplyKind>;
