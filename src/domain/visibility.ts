/**
 * What TaruBot can see once Administrator is off (2.35.0, #46): the pure analysis behind /config
 * validate's "TaruBot's role" and "Visibility" sections, the officer alert, the readiness count and
 * the /setup overrides planner. Everything is computed as if Administrator were off (see
 * permissions.ts): TaruBot holds it only while /setup overrides adds its own member entry to each
 * channel, and the question every caller asks is what remains once it comes off.
 *
 * Inputs are plain copies of the gateway caches (src/discord/visibility.ts) and the guild row, so
 * this module never performs I/O and never reads Discord's REST channel list, which from
 * 2026-11-16 leaves out every channel TaruBot can't view (#47).
 *
 * "As if Administrator were off" means the roles TaruBot would still hold (asIfRoles). TaruBot's
 * own bot role and @everyone lose only the Administrator bit, because an admin turns it off there.
 * Any other role granting Administrator is a shared one (an Officer role people also hold, say),
 * which an admin removes from TaruBot rather than editing, so the view drops it whole: its
 * permissions and every channel overwrite naming it. /config validate then says to remove it.
 *
 * A channel is in one of five states:
 * - visible: TaruBot sees it (and, in a posting channel, has all four posting permissions);
 * - missing: it doesn't, and nothing says that was deliberate, so /setup overrides adds TaruBot's
 *   own member entry there;
 * - masked: a configured channel TaruBot sees, whose own TaruBot entry still denies Read Message
 *   History (an earlier run masked it while no setting named it); the writer lifts only that deny;
 * - hidden_on_purpose: a channel no setting names, where TaruBot's own member entry or its bot
 *   role's entry denies View Channel. That deny wins (answer 3, 2026-09-28): left alone, reported.
 *   So does a category's: a channel with no TaruBot entry of its own inside such a category (see
 *   judge);
 * - denied: the same deliberate deny on a configured channel. It is never overwritten either, but
 *   it is a problem, not a choice: TaruBot needs that channel, so it counts as missing.
 *
 * A private category is a missing category holding a configured channel (the ledger inside a
 * category TaruBot can't see, say). @deconfined's rule (#46, comment 5869082017): it is a warning
 * the server owner fixes, by moving the configured channel out, choosing another channel for the
 * setting, or giving TaruBot View Channel on the category. Neither a View-only category (its
 * siblings would inherit no mask) nor masking the siblings one by one is acceptable as a default,
 * so the step picks nothing: it writes nothing in the category or anything inside it, and its
 * channels stay counted as missing, so Administrator stays "needed" until the owner acts.
 *
 * With onboarding on, onboarding's own channel pass writes TaruBot's entry in every channel except
 * the Community Updates channel and its category, so the analysis reports what that pass hasn't
 * reached yet (onboardingPending) instead of missing overrides, and counts nothing as missing.
 */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import {
  type ApiOverwrite,
  type ApiRole,
  ascendingRoles,
  CORE_PERMISSIONS,
  type CorePermission,
  channelPermissions,
  DENY_MASK,
  guildPermissions,
  NEVER_NEEDED_PERMISSIONS,
  type NeverNeededPermission,
  ONBOARDING_PERMISSIONS,
  type OnboardingPermission,
  POSTING_PERMISSIONS,
  type PostingPermission,
  permissionKeys,
  VOICE_DENY_MASK,
  VOICE_MASK_TYPES,
} from "./permissions.js";

/** One non-thread channel as the gateway cache holds it. */
export interface VisibilityChannel {
  readonly id: string;
  /** ChannelType; threads never appear. */
  readonly type: number;
  readonly parentId: string | null;
  /** The raw position, which orders channels within their parent. */
  readonly position: number;
  readonly overwrites: readonly ApiOverwrite[];
  /** The entry is flagged CHANNEL_OBFUSCATED (never judged by name): its overwrites are synthetic. */
  readonly obfuscated: boolean;
  /**
   * Read fresh through REST (GET /channels/{id}) and answered unobfuscated, so its overwrites are
   * real even when they look like the synthetic @everyone deny (see `unreadable`). Absent for
   * cache entries. /setup overrides sets it on the entries it re-reads while holding Administrator.
   */
  readonly fetched?: boolean;
}

/** The guild as the gateway cache holds it, for TaruBot's member. */
export interface VisibilityGuild {
  readonly guildId: string;
  readonly bot: {
    readonly id: string;
    /** TaruBot's roles, excluding @everyone. */
    readonly roles: readonly string[];
    /** The managed role tagged with TaruBot's user ID, or null. */
    readonly botRoleId: string | null;
  };
  /** Every role; @everyone has id === guildId. */
  readonly roles: readonly ApiRole[];
  /** Every non-thread channel in the gateway cache. */
  readonly channels: readonly VisibilityChannel[];
  /** Role IDs held by at least one cached member other than TaruBot (best effort). */
  readonly heldRoles: readonly string[];
  /**
   * The Community Updates channel (guild.publicUpdatesChannelId); absent or null for none.
   * Onboarding leaves it and its category alone, so the onboarding mode judges them separately.
   */
  readonly communityUpdatesId?: string | null;
}

/** The settings the analysis reads: a structural Pick of the guilds row, which GuildRecord satisfies. */
export interface VisibilityConfig {
  readonly access_policy_enabled: boolean;
  readonly ledger_channel_id: string | null;
  readonly officer_notifications_channel_id: string | null;
  readonly changelog_channel_id: string | null;
  readonly guest_application_channel_id: string | null;
  readonly guest_applications_enabled: boolean;
  readonly lobby_channel_id: string | null;
  readonly officer_channel_id: string | null;
  readonly member_role_id: string | null;
  readonly guest_role_id: string | null;
  readonly officer_role_id: string | null;
  readonly leader_role_id: string | null;
}

/** Stored facts beyond the guild row (src/application/visibility-records.ts loads them). */
export interface VisibilityRecords {
  /** retired_roles.role_id for the guild. */
  readonly retiredRoles: readonly string[];
  /**
   * Distinct guest_applications.channel_id of applications still pending, or whose guest.review
   * redraw hasn't finished (it reads history there).
   */
  readonly pendingReviewChannels: readonly string[];
  /** details.hiddenOnPurpose of the newest 'setup.overrides' audit row. */
  readonly recordedHidden: readonly string[];
}

/** No stored facts. */
export const NO_RECORDS: VisibilityRecords = {
  retiredRoles: [],
  pendingReviewChannels: [],
  recordedHidden: [],
};

/** What the analysis needs to know about the server's settings. */
export interface VisibilitySettings {
  /** access_policy_enabled: onboarding writes TaruBot's channel access itself. */
  readonly onboarding: boolean;
  /**
   * Channels TaruBot posts in: ledger, officer notifications, changelog, the review channel while
   * applications are on, and every pending review channel (editReview reads there).
   */
  readonly posting: readonly string[];
  /** posting ∪ the review channel (any state) ∪ lobby ∪ officer room; never given the deny mask. */
  readonly configured: readonly string[];
  /** The set access roles. */
  readonly accessRoles: readonly string[];
  readonly retiredRoles: readonly string[];
  readonly recordedHidden: readonly string[];
}

/** Distinct non-null values, in first-seen order. */
function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

/** The settings the analysis reads, from the guild row and its stored records. */
export function visibilitySettings(
  guild: VisibilityConfig,
  records: VisibilityRecords,
): VisibilitySettings {
  const review = guild.guest_application_channel_id;
  const posting = distinct([
    guild.ledger_channel_id,
    guild.officer_notifications_channel_id,
    guild.changelog_channel_id,
    guild.guest_applications_enabled ? review : null,
    ...records.pendingReviewChannels,
  ]);
  return {
    onboarding: guild.access_policy_enabled,
    posting,
    configured: distinct([...posting, review, guild.lobby_channel_id, guild.officer_channel_id]),
    accessRoles: distinct([
      guild.member_role_id,
      guild.guest_role_id,
      guild.officer_role_id,
      guild.leader_role_id,
    ]),
    retiredRoles: distinct(records.retiredRoles),
    recordedHidden: distinct(records.recordedHidden),
  };
}

export type ChannelState = "visible" | "missing" | "masked" | "hidden_on_purpose" | "denied";

/** The bits a posting channel needs, View Channel included (84992n). */
const POSTING_BITS = Object.values(POSTING_PERMISSIONS).reduce((total, bit) => total | bit, 0n);
/** Onboarding's five, as one mask. */
const ONBOARDING_BITS = Object.values(ONBOARDING_PERMISSIONS).reduce((all, bit) => all | bit, 0n);

/**
 * Whether a cache entry's overwrites can't be trusted (src/discord/obfuscation.ts): it is flagged
 * obfuscated, or its overwrites are exactly the one synthetic @everyone View deny Discord puts on
 * an obfuscated channel. The second is the option-patched case: a slash-command channel option
 * clears the flag and restores the name, but keeps the synthetic overwrite. A real channel can
 * have that exact shape too (private, with no role or member entries); either way TaruBot can't
 * see it without Administrator, so it is missing, and only a fresh REST read (`fetched`) tells
 * the two apart. Unreadable entries are never visible, never planned, and never judged hidden on
 * purpose from their own data.
 */
export function unreadable(guild: VisibilityGuild, channel: VisibilityChannel): boolean {
  if (channel.obfuscated) return true;
  if (channel.fetched) return false;
  const [only, ...rest] = channel.overwrites;
  return (
    only !== undefined &&
    rest.length === 0 &&
    only.id === guild.guildId &&
    only.type === 0 &&
    BigInt(only.allow) === 0n &&
    BigInt(only.deny) === P.ViewChannel
  );
}

/** Whether a role's own permissions include Administrator. */
const grantsAdministrator = (role: ApiRole): boolean =>
  (BigInt(role.permissions) & P.Administrator) !== 0n;

/**
 * TaruBot's roles once Administrator is gone. Its own bot role stays (an admin turns the bit off
 * there, and guildPermissions' ignoreAdministrator drops just that bit), and so does every role
 * without Administrator; a role the list doesn't know is kept, since nothing says it grants it.
 * Every other role granting Administrator is shared: an admin removes it from TaruBot rather than
 * editing it, so it is dropped whole, with its permissions and every overwrite naming it. With no
 * known bot role, every Administrator role counts as shared: conservative, since the view then
 * never credits TaruBot with a role that may be taken away from it.
 */
export function asIfRoles(guild: VisibilityGuild): readonly string[] {
  const byId = new Map(guild.roles.map((role) => [role.id, role]));
  return guild.bot.roles.filter((id) => {
    if (id === guild.bot.botRoleId) return true;
    const role = byId.get(id);
    return role === undefined || !grantsAdministrator(role);
  });
}

/** TaruBot's guild-level permissions over asIfRoles (plus @everyone), Administrator ignored. */
export function asIfBase(guild: VisibilityGuild): bigint {
  return guildPermissions(guild.guildId, guild.roles, asIfRoles(guild), {
    ignoreAdministrator: true,
  });
}

/** The as-if view, computed once per analysis or plan. */
interface AsIf {
  /** asIfRoles(guild). */
  readonly roles: readonly string[];
  /** asIfBase(guild). */
  readonly base: bigint;
}

function asIfView(guild: VisibilityGuild): AsIf {
  const roles = asIfRoles(guild);
  return {
    roles,
    base: guildPermissions(guild.guildId, guild.roles, roles, { ignoreAdministrator: true }),
  };
}

/** TaruBot's permissions in one channel as if Administrator were off (Discord's algorithm). */
function channelBits(guild: VisibilityGuild, channel: VisibilityChannel, view: AsIf): bigint {
  return channelPermissions(
    guild.guildId,
    view.base,
    channel.overwrites,
    { id: guild.bot.id, roles: view.roles },
    { ignoreAdministrator: true },
  );
}

/** TaruBot's own member entry in a channel, if any. */
function ownEntry(guild: VisibilityGuild, channel: VisibilityChannel): ApiOverwrite | undefined {
  return channel.overwrites.find((entry) => entry.type === 1 && entry.id === guild.bot.id);
}

/** Whether an entry denies `bit`. */
const denies = (entry: ApiOverwrite | undefined, bit: bigint): boolean =>
  entry !== undefined && (BigInt(entry.deny) & bit) !== 0n;

/** Voice and stage channels: where a Connect deny also denies Manage Channels (implicit deny). */
const VOICE_BASED: ReadonlySet<number> = new Set<number>([
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

/**
 * Whether TaruBot's own member entry stops onboarding's channel pass writing this channel without
 * Administrator: it denies Manage Permissions or Manage Channels, or Connect in a voice or stage
 * channel. These are exactly the bits src/discord/guild-access.ts channelRefusal refuses (text 22)
 * and ONBOARDING_LIFT clears (src/domain/channel-access.ts): /setup overrides' mask puts them there
 * in channels no setting names, and only onboarding's first pass, run with Administrator, lifts
 * them. Until then such a channel is visible yet still waiting on that pass.
 */
function blocksOnboarding(guild: VisibilityGuild, channel: VisibilityChannel): boolean {
  const own = ownEntry(guild, channel);
  return (
    denies(own, P.ManageRoles | P.ManageChannels) ||
    (VOICE_BASED.has(channel.type) && denies(own, P.Connect))
  );
}

/** One channel's judgement: its state, what it needs, and TaruBot's permissions there. */
interface Judgement {
  readonly state: ChannelState;
  readonly need: bigint;
  readonly perms: bigint;
  readonly posting: boolean;
  readonly configured: boolean;
  readonly readable: boolean;
  /** Hidden on purpose only through its category's deny (see judge). */
  readonly viaCategory?: boolean;
}

/**
 * Judge one channel (the order is the spec's): a readable channel with every needed bit is visible
 * (masked when configured and TaruBot's own entry still denies Read Message History, the one mask
 * bit a configured channel needs back); otherwise a deliberate View deny on TaruBot is denied
 * (configured) or hidden on purpose; anything else is missing. Deliberate means TaruBot's own
 * member entry or its bot role's entry denies View Channel and View is indeed missing; another
 * role's deny, or @everyone's, is how private channels are made, not a choice about TaruBot. For
 * an unreadable entry only the recorded set (what an earlier /setup overrides saw in the real
 * data) can say so. A category is judged by its own overwrites: they are the template Discord
 * copies into synced and newly created children.
 *
 * A category's deny reaches only the children synced with it (Topics › Permissions, "Permission
 * Syncing"), and Discord shows TaruBot a category once it can view any channel inside ("Channel
 * Visibility"). So a readable, unconfigured channel TaruBot can't see, with no entry of its own for
 * TaruBot or its bot role, inside a category hidden from TaruBot on purpose, counts as hidden on
 * purpose too (`viaCategory`): giving it TaruBot's entry would partly undo the category's deny
 * (answer 3). So does an unreadable one the recorded set doesn't name, such as a channel created
 * in that category after the last /setup overrides run: Discord copies the category's overwrites,
 * TaruBot's deny included, into a new child. A configured channel there is judged on its own,
 * since TaruBot needs it.
 */
function judge(
  guild: VisibilityGuild,
  channel: VisibilityChannel,
  settings: VisibilitySettings,
  view: AsIf,
): Judgement {
  const posting = settings.posting.includes(channel.id);
  const configured = settings.configured.includes(channel.id);
  const need = posting ? POSTING_BITS : P.ViewChannel;
  const readable = !unreadable(guild, channel);
  const perms = channelBits(guild, channel, view);
  const own = ownEntry(guild, channel);
  const facts = { need, perms, posting, configured, readable };
  if (readable && (perms & need) === need)
    return {
      ...facts,
      state: configured && denies(own, P.ReadMessageHistory) ? "masked" : "visible",
    };
  const botRole = guild.bot.botRoleId;
  const roleEntry = botRole
    ? channel.overwrites.find((entry) => entry.type === 0 && entry.id === botRole)
    : undefined;
  const deliberate = readable
    ? (perms & P.ViewChannel) === 0n &&
      (denies(own, P.ViewChannel) || denies(roleEntry, P.ViewChannel))
    : settings.recordedHidden.includes(channel.id);
  if (deliberate) return { ...facts, state: configured ? "denied" : "hidden_on_purpose" };
  // An unreadable entry reaches here only when the recorded set doesn't name it (a channel created
  // after the last /setup overrides run), and its overwrites are synthetic, so it has no TaruBot
  // entry to look at. Its parent_id is real, though (#47), and a channel TaruBot can't view inside
  // a category hidden from it on purpose is either synced with it (so it carries the category's
  // deny) or unsynced with no entry letting TaruBot in: the readable rule's case. The one exception
  // is an unsynced child whose own entry for TaruBot or its bot role is neutral on View, which
  // Discord no longer lets TaruBot tell apart; it counts as hidden on purpose too (accepted edge).
  if (!configured && own === undefined && roleEntry === undefined) {
    // Categories don't nest, so the category's own judgement never looks further up.
    const parent = isCategory(channel)
      ? undefined
      : guild.channels.find((candidate) => candidate.id === channel.parentId);
    if (
      parent !== undefined &&
      isCategory(parent) &&
      judge(guild, parent, settings, view).state === "hidden_on_purpose"
    )
      return { ...facts, state: "hidden_on_purpose", viaCategory: true };
  }
  return { ...facts, state: "missing" };
}

/** One channel's state as if Administrator were off. */
export function channelState(
  guild: VisibilityGuild,
  channel: VisibilityChannel,
  settings: VisibilitySettings,
): ChannelState {
  return judge(guild, channel, settings, asIfView(guild)).state;
}

/** Where one of the core seven comes from, as if Administrator were off. */
export interface CoreRow {
  readonly permission: CorePermission;
  readonly source: "own_role" | "other_roles" | "everyone" | "missing";
  /** Granting roles other than TaruBot's own, highest first; guildId stands for @everyone. */
  readonly roles: readonly string[];
}

/** A missing category holding at least one configured channel (see the module comment). */
export interface PrivateCategory {
  readonly id: string;
  /** The configured channels inside it, in display order. */
  readonly configured: readonly string[];
  /**
   * The channels inside it that are missing or masked (configured ones included), in display
   * order: what /setup overrides would otherwise write there.
   */
  readonly inside: readonly string[];
}

/** What /config validate, the officer alert and readiness report about TaruBot's view. */
export interface VisibilityReport {
  readonly mode: "checked" | "onboarding";
  readonly administrator: {
    readonly held: boolean;
    /** Held roles (guildId = @everyone) whose permissions include Administrator, highest first. */
    readonly roles: readonly string[];
    /** Those that are neither TaruBot's bot role nor @everyone: dropped whole in the as-if view. */
    readonly shared: readonly string[];
  };
  /** Always 7, in CORE order. */
  readonly core: readonly CoreRow[];
  /** Onboarding's permissions TaruBot lacks; null unless onboarding is on. */
  readonly onboardingMissing: readonly OnboardingPermission[] | null;
  /**
   * Only the never-needed permissions TaruBot's roles grant, with those roles. Never @everyone:
   * every member shares its permissions, so they aren't TaruBot's to shed (and Discord's default
   * @everyone includes Mention Everyone, which would warn forever).
   */
  readonly neverNeeded: readonly {
    readonly permission: NeverNeededPermission;
    readonly roles: readonly string[];
  }[];
  /**
   * Access roles, and retired roles someone still holds, not strictly below TaruBot's highest
   * as-if role (`highest`, null for @everyone alone). `throughShared` are those of notBelow that
   * TaruBot stays above today only through a shared Administrator role, whose removal would stop
   * it managing them: they keep Administrator needed.
   */
  readonly roleOrder: {
    readonly highest: string | null;
    readonly notBelow: readonly string[];
    readonly throughShared: readonly string[];
  };
  /** Never includes a private category or anything inside one. */
  readonly missing: {
    /** Missing categories, in display order. */
    readonly categories: readonly string[];
    /** Missing channels whose parent is a missing category. */
    readonly inside: readonly string[];
    /** Other missing channels. */
    readonly channels: readonly string[];
    /** Posting channels among the three lists, with the posting permissions they lack. */
    readonly posting: readonly {
      readonly id: string;
      readonly lacks: readonly PostingPermission[];
    }[];
    /** Missing entries whose overwrites are synthetic (see `unreadable`). */
    readonly unreadable: readonly string[];
  };
  /**
   * Configured channels, outside private categories, that TaruBot sees but whose own entry denies
   * Read Message History.
   */
  readonly masked: readonly string[];
  /** Configured channels with a deliberate View deny on TaruBot (inside private categories too). */
  readonly denied: readonly string[];
  /**
   * Other channels with a deliberate View deny on TaruBot (inside private categories too), and
   * those hidden only through their category's deny (hiddenByCategory).
   */
  readonly hiddenOnPurpose: readonly string[];
  /**
   * The channels of hiddenOnPurpose with no entry of their own for TaruBot inside a category hidden
   * from it on purpose (see judge); [] in onboarding mode.
   */
  readonly hiddenByCategory: readonly string[];
  /** Private categories, left alone and reported with their fix; [] in onboarding mode. */
  readonly privateCategories: readonly PrivateCategory[];
  /**
   * Onboarding servers only (else null): channels onboarding's pass hasn't reached or is blocked
   * on (`managed`), and configured channels it never manages, the Community Updates channel's
   * (`unmanaged`), that TaruBot can't use yet.
   */
  readonly onboardingPending: {
    readonly managed: readonly string[];
    readonly unmanaged: readonly string[];
  } | null;
  /**
   * categories + inside + channels + masked + denied + Σ(1 + inside) over the private categories;
   * 0 in onboarding mode. The officer alert and readiness count this.
   */
  readonly missingCount: number;
  /** Administrator is held and something above still depends on it. */
  readonly administratorNeeded: boolean;
}

/** Channels by (position, id), IDs compared as numbers. */
function byPosition(left: VisibilityChannel, right: VisibilityChannel): number {
  if (left.position !== right.position) return left.position - right.position;
  const [a, b] = [BigInt(left.id), BigInt(right.id)];
  return a === b ? 0 : a < b ? -1 : 1;
}

const isCategory = (channel: VisibilityChannel): boolean =>
  channel.type === ChannelType.GuildCategory;

/**
 * Display order: top-level channels (and any whose category isn't cached), then each category
 * followed by its children, each group by (position, id).
 */
function displayOrder(channels: readonly VisibilityChannel[]): VisibilityChannel[] {
  const categories = channels.filter(isCategory).sort(byPosition);
  const categoryIds = new Set(categories.map((category) => category.id));
  const inCategory = (channel: VisibilityChannel) =>
    channel.parentId !== null && categoryIds.has(channel.parentId);
  const ordered = channels
    .filter((channel) => !isCategory(channel) && !inCategory(channel))
    .sort(byPosition);
  for (const category of categories)
    ordered.push(
      category,
      ...channels
        .filter((channel) => !isCategory(channel) && channel.parentId === category.id)
        .sort(byPosition),
    );
  return ordered;
}

/** `held` roles and @everyone (guildId) whose own permissions include `bit`, highest first. */
function grantingRoles(guild: VisibilityGuild, bit: bigint, held: readonly string[]): string[] {
  const set = new Set([guild.guildId, ...held]);
  return ascendingRoles(guild.roles)
    .reverse()
    .filter((role) => set.has(role.id) && (BigInt(role.permissions) & bit) === bit)
    .map((role) => role.id);
}

/**
 * Where each of the core seven comes from, from the as-if roles' permissions alone (a role with
 * Administrator but not the bit doesn't grant it once Administrator is off): TaruBot's own bot
 * role, only other roles it holds (a change to those removes it), only @everyone, or nowhere.
 */
function coreRows(guild: VisibilityGuild, view: AsIf): CoreRow[] {
  const own = guild.bot.botRoleId;
  return (Object.keys(CORE_PERMISSIONS) as CorePermission[]).map((permission) => {
    const granting = grantingRoles(guild, CORE_PERMISSIONS[permission], view.roles);
    const roles = granting.filter((id) => id !== own);
    const source: CoreRow["source"] =
      own !== null && granting.includes(own)
        ? "own_role"
        : roles.some((id) => id !== guild.guildId)
          ? "other_roles"
          : roles.includes(guild.guildId)
            ? "everyone"
            : "missing";
    return { permission, source, roles };
  });
}

/**
 * TaruBot's highest role among `roles`, and the roles it must stay above but doesn't: every access
 * role, and each retired role someone still holds (the bot removes those). Roles absent from the
 * list are ignored. Discord's role hierarchy applies with or without Administrator (Topics ›
 * Permissions, "Permission Hierarchy"), so a shared Administrator role that is TaruBot's highest
 * keeps it above roles its own role sits below.
 */
function roleOrderOver(
  guild: VisibilityGuild,
  settings: VisibilitySettings,
  roles: readonly string[],
): { highest: string | null; notBelow: string[] } {
  const ascending = ascendingRoles(guild.roles);
  const index = new Map(ascending.map((role, position) => [role.id, position]));
  const held = new Set([guild.guildId, ...roles]);
  const top = ascending.reduce<number>(
    (highest, role, position) => (held.has(role.id) ? position : highest),
    -1,
  );
  const highestRole = top >= 0 ? ascending[top] : undefined;
  const highest = highestRole && highestRole.id !== guild.guildId ? highestRole.id : null;
  const heldRetired = settings.retiredRoles.filter((role) => guild.heldRoles.includes(role));
  const notBelow = distinct([...settings.accessRoles, ...heldRetired]).filter((role) => {
    const position = index.get(role);
    return position !== undefined && position >= top;
  });
  return { highest, notBelow };
}

/**
 * The role order as if Administrator were off (over asIfRoles), plus the roles of notBelow that
 * TaruBot stays above today only through a shared Administrator role (roleOrderOver its real
 * roles): removing that role from TaruBot, as /config validate says once nothing else needs
 * Administrator, would leave it unable to manage them, so they keep Administrator needed.
 */
function roleOrder(
  guild: VisibilityGuild,
  settings: VisibilitySettings,
  view: AsIf,
): VisibilityReport["roleOrder"] {
  const asIf = roleOrderOver(guild, settings, view.roles);
  const real = roleOrderOver(guild, settings, guild.bot.roles);
  return { ...asIf, throughShared: asIf.notBelow.filter((id) => !real.notBelow.includes(id)) };
}

/**
 * The private categories: missing categories (readable or not) that a cached configured channel
 * names as its parent, whether or not that channel is synced. Checked mode only; empty with
 * onboarding on, whose own pass manages every channel.
 */
function privateSet(guild: VisibilityGuild, settings: VisibilitySettings, view: AsIf): Set<string> {
  if (settings.onboarding) return new Set();
  const holders = new Set(
    guild.channels
      .filter((channel) => settings.configured.includes(channel.id))
      .map((channel) => channel.parentId),
  );
  return new Set(
    guild.channels
      .filter(
        (channel) =>
          isCategory(channel) &&
          holders.has(channel.id) &&
          judge(guild, channel, settings, view).state === "missing",
      )
      .map((channel) => channel.id),
  );
}

/** The IDs of the private categories (see the module comment); empty in onboarding mode. */
export function privateCategoryIds(
  guild: VisibilityGuild,
  settings: VisibilitySettings,
): ReadonlySet<string> {
  return privateSet(guild, settings, asIfView(guild));
}

/**
 * The full report. With onboarding on, onboarding's own pass writes TaruBot's channel access, so
 * the report lists what it hasn't reached instead and nothing counts as missing (the officer
 * alert's approved text points at /setup overrides, which doesn't apply there).
 */
export function analyseVisibility(
  guild: VisibilityGuild,
  settings: VisibilitySettings,
): VisibilityReport {
  const view = asIfView(guild);
  // The real held set: what Administrator comes from now, and which of it is shared.
  const administratorRoles = grantingRoles(guild, P.Administrator, guild.bot.roles);
  const administrator = {
    held: administratorRoles.length > 0,
    roles: administratorRoles,
    shared: administratorRoles.filter((id) => id !== guild.bot.botRoleId && id !== guild.guildId),
  };
  const core = coreRows(guild, view);
  const onboardingMissing = settings.onboarding
    ? permissionKeys(~view.base & ONBOARDING_BITS, ONBOARDING_PERMISSIONS)
    : null;
  const neverNeeded = (Object.keys(NEVER_NEEDED_PERMISSIONS) as NeverNeededPermission[])
    .map((permission) => ({
      permission,
      roles: grantingRoles(guild, NEVER_NEEDED_PERMISSIONS[permission], view.roles).filter(
        (id) => id !== guild.guildId,
      ),
    }))
    .filter((row) => row.roles.length > 0);
  const order = roleOrder(guild, settings, view);
  // What removing Administrator would break in TaruBot's roles: a core or onboarding permission,
  // or its place above a role it manages that only a shared Administrator role gives it.
  const roleProblem =
    core.some((row) => row.source === "missing") ||
    (onboardingMissing?.length ?? 0) > 0 ||
    order.throughShared.length > 0;
  const common = { administrator, core, onboardingMissing, neverNeeded, roleOrder: order };
  const none = { categories: [], inside: [], channels: [], posting: [], unreadable: [] };

  if (settings.onboarding) {
    // Onboarding's pass (src/application/guild-access.ts) writes TaruBot's own entry, allowing
    // View, Send, History, Embed and Attach, in every channel except the Community Updates channel
    // and its category, so any other channel TaruBot can't use yet is one that pass hasn't reached
    // or is blocked on. So is one TaruBot sees whose own entry still carries /setup overrides' mask
    // (blocksOnboarding): the pass is refused there without Administrator until its first run with
    // it lifts the mask. The excluded pair matter only when a setting names them.
    const updates = guild.communityUpdatesId ?? null;
    const excluded = new Set<string>();
    if (updates !== null) {
      excluded.add(updates);
      const parent = guild.channels.find((channel) => channel.id === updates)?.parentId;
      if (parent) excluded.add(parent);
    }
    const managed: string[] = [];
    const unmanaged: string[] = [];
    for (const channel of displayOrder(guild.channels)) {
      const state = judge(guild, channel, settings, view).state;
      const reached = state === "visible" || state === "masked";
      if (excluded.has(channel.id)) {
        // Onboarding never writes these, so only a configured one TaruBot can't use counts.
        if (!reached && settings.configured.includes(channel.id)) unmanaged.push(channel.id);
        continue;
      }
      if (!reached || blocksOnboarding(guild, channel)) managed.push(channel.id);
    }
    return {
      ...common,
      mode: "onboarding",
      missing: none,
      masked: [],
      denied: [],
      hiddenOnPurpose: [],
      hiddenByCategory: [],
      privateCategories: [],
      onboardingPending: { managed, unmanaged },
      missingCount: 0,
      // Removing Administrator while the pass is still queued or blocked would leave it unable
      // to write the channels it hasn't reached.
      administratorNeeded:
        administrator.held && (roleProblem || managed.length + unmanaged.length > 0),
    };
  }

  const privateIds = privateSet(guild, settings, view);
  const privateCategories = new Map<
    string,
    { id: string; configured: string[]; inside: string[] }
  >();
  const categories: string[] = [];
  const inside: string[] = [];
  const channels: string[] = [];
  const posting: { id: string; lacks: PostingPermission[] }[] = [];
  const unreadableIds: string[] = [];
  const masked: string[] = [];
  const denied: string[] = [];
  const hiddenOnPurpose: string[] = [];
  const hiddenByCategory: string[] = [];
  // Categories come before their children in display order, so a child always sees its
  // category's verdict.
  for (const channel of displayOrder(guild.channels)) {
    if (privateIds.has(channel.id)) {
      privateCategories.set(channel.id, { id: channel.id, configured: [], inside: [] });
      continue;
    }
    const verdict = judge(guild, channel, settings, view);
    const holder = channel.parentId === null ? undefined : privateCategories.get(channel.parentId);
    if (holder) {
      // Inside a private category: reported with it, never as a missing override, except that a
      // deliberate deny is still a deliberate deny.
      if (verdict.configured) holder.configured.push(channel.id);
      if (verdict.state === "missing" || verdict.state === "masked") holder.inside.push(channel.id);
      else if (verdict.state === "denied") denied.push(channel.id);
      else if (verdict.state === "hidden_on_purpose") hiddenOnPurpose.push(channel.id);
      continue;
    }
    if (verdict.state === "masked") masked.push(channel.id);
    else if (verdict.state === "denied") denied.push(channel.id);
    else if (verdict.state === "hidden_on_purpose") {
      hiddenOnPurpose.push(channel.id);
      if (verdict.viaCategory) hiddenByCategory.push(channel.id);
    }
    if (verdict.state !== "missing") continue;
    if (isCategory(channel)) categories.push(channel.id);
    else if (channel.parentId !== null && categories.includes(channel.parentId))
      inside.push(channel.id);
    else channels.push(channel.id);
    if (verdict.posting)
      posting.push({
        id: channel.id,
        lacks: permissionKeys(~verdict.perms & POSTING_BITS, POSTING_PERMISSIONS),
      });
    if (!verdict.readable) unreadableIds.push(channel.id);
  }
  const held = [...privateCategories.values()];
  const missingCount =
    categories.length +
    inside.length +
    channels.length +
    masked.length +
    denied.length +
    held.reduce((total, entry) => total + 1 + entry.inside.length, 0);
  return {
    ...common,
    mode: "checked",
    missing: { categories, inside, channels, posting, unreadable: unreadableIds },
    masked,
    denied,
    hiddenOnPurpose,
    hiddenByCategory,
    privateCategories: held,
    onboardingPending: null,
    missingCount,
    administratorNeeded: administrator.held && (missingCount > 0 || roleProblem),
  };
}

/** A member entry's bits. */
export interface OverrideEntry {
  readonly allow: bigint;
  readonly deny: bigint;
}

/** A category's entry that its synced children copy: planned in this run, or resumed. */
export interface Inherit {
  readonly parentId: string;
  /** The category's overwrites before the write, which decide whether a child is synced. */
  readonly parentBefore: readonly ApiOverwrite[];
  readonly parentAfter: OverrideEntry;
}

/** One planned write of TaruBot's own member entry. */
export interface OverrideTarget {
  readonly channelId: string;
  readonly kind: "category" | "channel";
  readonly posting: boolean;
  /** TaruBot's member entry now. */
  readonly before: OverrideEntry | null;
  /** Exactly what the PUT sends. */
  readonly after: OverrideEntry;
  /** after.allow & ~before.allow. */
  readonly granted: bigint;
  /** Deny-mask bits newly denied. */
  readonly masked: bigint;
  /** Deny-mask bits removed (a configured channel's Read Message History). */
  readonly cleared: bigint;
  /** Copies its category's entry to stay synced. */
  readonly inherited: boolean;
  /** Was synced with its category and will not be after. */
  readonly unsyncs: boolean;
}

/**
 * Overwrites as a map from 'type:id' to 'allow:deny', bits normalised through BigInt, without an
 * @everyone entry (id `guildId`) that allows and denies nothing (see sameOverwriteSet).
 */
function overwriteKeys(overwrites: readonly ApiOverwrite[], guildId: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of overwrites) {
    const [allow, deny] = [BigInt(entry.allow), BigInt(entry.deny)];
    if (entry.id === guildId && allow === 0n && deny === 0n) continue;
    keys.set(`${entry.type}:${entry.id}`, `${allow}:${deny}`);
  }
  return keys;
}

/**
 * Whether two overwrite lists are the same set of (id, type, allow, deny) entries in any order,
 * as Discord's "synced with category" compares them. An @everyone entry with no bits counts as no
 * entry, as discord.js's GuildChannel#permissionsLocked models Discord's synced state ("Handle
 * empty overwrite"; Discord's data does hold such one-sided entries): otherwise a child the
 * Discord client shows as synced would get its own write and lose that sync. Any other entry with
 * no bits counts like any other, as it does there.
 */
export function sameOverwriteSet(
  left: readonly ApiOverwrite[],
  right: readonly ApiOverwrite[],
  guildId: string,
): boolean {
  const [a, b] = [overwriteKeys(left, guildId), overwriteKeys(right, guildId)];
  return a.size === b.size && [...a].every(([key, bits]) => b.get(key) === bits);
}

/** The entries of `channel`'s parent in the snapshot, or null without a cached parent. */
function parentOverwrites(
  guild: VisibilityGuild,
  channel: VisibilityChannel,
): readonly ApiOverwrite[] | null {
  if (channel.parentId === null) return null;
  return guild.channels.find((candidate) => candidate.id === channel.parentId)?.overwrites ?? null;
}

/** What one plan (or one recomputed target) shares: the as-if view and the private categories. */
interface PlanContext {
  readonly view: AsIf;
  readonly privateIds: ReadonlySet<string>;
}

function planContext(guild: VisibilityGuild, settings: VisibilitySettings): PlanContext {
  const view = asIfView(guild);
  return { view, privateIds: privateSet(guild, settings, view) };
}

/**
 * The write that makes one missing or masked channel visible again once Administrator is off, as
 * TaruBot's own member entry; null when there is nothing to write (visible, hidden on purpose or
 * denied; unreadable, whose real overwrites aren't known; or a private category or anything in
 * one, which the server owner fixes). Every other bit already on the entry is kept, and nobody
 * else's entry is touched.
 * - An unconfigured child synced to the category in `inherit` gets that category's exact entry,
 *   so it stays synced whether or not Discord propagates the category's write.
 * - A configured channel gets what it needs, and of the mask bits only Read Message History is
 *   lifted (it reads there); Manage Permissions, Manage Channels, Create Invite and Connect denies
 *   stay, as least privilege and perhaps the admin's own choice. It never gets the deny mask.
 * - Anything else gets View Channel plus the deny mask (answer 2): Read Message History, Manage
 *   Permissions, Manage Channels and Create Invite, plus Connect on voice, stage and categories.
 */
function targetOf(
  guild: VisibilityGuild,
  channel: VisibilityChannel,
  settings: VisibilitySettings,
  inherit: Inherit | null,
  context: PlanContext,
): OverrideTarget | null {
  const verdict = judge(guild, channel, settings, context.view);
  if (!verdict.readable || (verdict.state !== "missing" && verdict.state !== "masked")) return null;
  if (
    context.privateIds.has(channel.id) ||
    (channel.parentId !== null && context.privateIds.has(channel.parentId))
  )
    return null;
  const own = ownEntry(guild, channel);
  const before: OverrideEntry | null = own
    ? { allow: BigInt(own.allow), deny: BigInt(own.deny) }
    : null;
  const b = before ?? { allow: 0n, deny: 0n };
  const ownParent = inherit !== null && inherit.parentId === channel.parentId;
  // Synced with the category as the inherit saw it before its write, which decides inheriting,
  // or as the snapshot holds it now. The two differ only for a resumed category: a child that
  // already carries its entry E (a complete earlier run) is synced with it too, and a configured
  // one set there later loses that sync when it gets its own write, so the reply lists it.
  const matchesBefore =
    ownParent && sameOverwriteSet(channel.overwrites, inherit.parentBefore, guild.guildId);
  const current = parentOverwrites(guild, channel);
  const synced =
    matchesBefore ||
    (current !== null && sameOverwriteSet(channel.overwrites, current, guild.guildId));
  let after: OverrideEntry;
  let inherited = false;
  if (ownParent && matchesBefore && !verdict.configured) {
    after = inherit.parentAfter;
    inherited = true;
  } else {
    const granted = verdict.state === "masked" ? 0n : verdict.need & ~verdict.perms;
    if (verdict.configured)
      after = { allow: b.allow | granted, deny: b.deny & ~granted & ~P.ReadMessageHistory };
    else {
      const mask = VOICE_MASK_TYPES.has(channel.type) ? VOICE_DENY_MASK : DENY_MASK;
      after = { allow: (b.allow | granted) & ~mask, deny: (b.deny & ~granted) | mask };
    }
  }
  // A write that happens to equal the category's keeps the child synced all the same.
  const matchesParent =
    ownParent &&
    after.allow === inherit.parentAfter.allow &&
    after.deny === inherit.parentAfter.deny;
  return {
    channelId: channel.id,
    kind: isCategory(channel) ? "category" : "channel",
    posting: verdict.posting,
    before,
    after,
    granted: after.allow & ~b.allow,
    masked: after.deny & ~b.deny & VOICE_DENY_MASK,
    cleared: b.deny & ~after.deny & VOICE_DENY_MASK,
    inherited,
    unsyncs: synced && !inherited && !matchesParent,
  };
}

/** One channel's write (see targetOf); setup recomputes each target on a fresh read with it. */
export function overrideTarget(
  guild: VisibilityGuild,
  channel: VisibilityChannel,
  settings: VisibilitySettings,
  inherit: Inherit | null = null,
): OverrideTarget | null {
  return targetOf(guild, channel, settings, inherit, planContext(guild, settings));
}

/** The resume rule (see resumeInherit) over a computed as-if view. */
function resumeOf(
  guild: VisibilityGuild,
  category: VisibilityChannel,
  settings: VisibilitySettings,
  view: AsIf,
): Inherit | null {
  if (!isCategory(category) || unreadable(guild, category)) return null;
  if (judge(guild, category, settings, view).state !== "visible") return null;
  const entry = ownEntry(guild, category);
  if (!entry) return null;
  const allow = BigInt(entry.allow);
  const deny = BigInt(entry.deny);
  if ((allow & P.ViewChannel) === 0n || (deny & VOICE_DENY_MASK) !== VOICE_DENY_MASK) return null;
  return {
    parentId: category.id,
    parentBefore: category.overwrites.filter((candidate) => candidate !== entry),
    parentAfter: { allow, deny },
  };
}

/**
 * The inherit that resumes an interrupted /setup overrides run in `category`, or null. Discord
 * documents that a category's overwrite changes reach the children synced with it (Topics ›
 * Permissions, "Permission Syncing"), and the real run counts a child that already carries the
 * copy as its own write. Should a write not reach them (the test fixture's `propagate: false`), a
 * run stopped after a category's write and before its children's (a /config save, the time
 * budget, a shutdown) would otherwise unsync them on the rerun: the category is visible by then,
 * so it isn't planned, the children no longer equal it, and each would get its own entry (the text
 * mask against the category's voice mask). That is masking the siblings one by one, which
 * @deconfined rejected. So a visible, readable category carrying TaruBot's own entry E that allows
 * View Channel and denies every VOICE_DENY_MASK bit, the shape only a /setup overrides category
 * write has, lends E to each child whose overwrites equal the category's without E (so the child
 * has no TaruBot entry of its own): an unconfigured one copies E exactly and is synced again, and
 * a configured one gets its own write and is listed as unsynced. E must carry the full mask
 * because this repairs only TaruBot's own interrupted work: an entry an admin wrote (View only,
 * say) already makes the children differ from the category in Discord's own display, so no sync
 * TaruBot made is at stake, and copying it would put an entry without the mask into channels no
 * setting names (answer 2). Pure and cheap: setup's real run calls it on each fresh category read.
 */
export function resumeInherit(
  guild: VisibilityGuild,
  category: VisibilityChannel,
  settings: VisibilitySettings,
): Inherit | null {
  return resumeOf(guild, category, settings, asIfView(guild));
}

/**
 * Every write /setup overrides would make, in two passes, leaving private categories and
 * everything inside them alone: readable missing categories first, by (position, id), so a synced
 * child can copy its category's planned entry; then every other target in display order. A child
 * of a cached category this plan doesn't write gets resumeInherit's inherit, when the rule holds.
 */
export function planOverrides(
  guild: VisibilityGuild,
  settings: VisibilitySettings,
): readonly OverrideTarget[] {
  const context = planContext(guild, settings);
  const planned = new Map<string, OverrideTarget>();
  const categories: OverrideTarget[] = [];
  for (const category of guild.channels.filter(isCategory).sort(byPosition)) {
    const target = targetOf(guild, category, settings, null, context);
    if (!target) continue;
    planned.set(category.id, target);
    categories.push(target);
  }
  const resumed = new Map<string, Inherit | null>();
  const inheritFor = (channel: VisibilityChannel): Inherit | null => {
    if (channel.parentId === null) return null;
    const parent = guild.channels.find((candidate) => candidate.id === channel.parentId);
    if (!parent) return null;
    const parentTarget = planned.get(parent.id);
    if (parentTarget)
      return {
        parentId: parent.id,
        parentBefore: parent.overwrites,
        parentAfter: parentTarget.after,
      };
    if (!resumed.has(parent.id))
      resumed.set(parent.id, resumeOf(guild, parent, settings, context.view));
    return resumed.get(parent.id) ?? null;
  };
  const channels: OverrideTarget[] = [];
  for (const channel of displayOrder(guild.channels)) {
    if (isCategory(channel)) continue;
    const target = targetOf(guild, channel, settings, inheritFor(channel), context);
    if (target) channels.push(target);
  }
  return [...categories, ...channels];
}
