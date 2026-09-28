/**
 * TaruBot's permission catalog and Discord's permission arithmetic over raw payloads (2.35.0,
 * #46). Pure: no I/O and no discord.js caches, so the inspection tool, /config validate, the
 * officer alert and /setup overrides all compute from the same numbers.
 *
 * guildPermissions and channelPermissions follow Discord's "Permission Overwrites" algorithm
 * (Topics › Permissions): the base is @everyone's permissions OR every held role's; then the
 * @everyone overwrite applies (deny, then allow), then the union of the member's role overwrites
 * (every deny, then every allow), and the member's own overwrite last. Administrator short-circuits
 * all of it: a member holding it has every permission and overwrites don't apply. TaruBot holds
 * Administrator only for the /setup overrides window, so everything #46 judges ("would TaruBot
 * still see this channel once Administrator is off?") runs with `ignoreAdministrator`, which drops
 * the short-circuit and the bit itself and then runs the same steps. Never compute that answer with
 * discord.js's `has(bit)`: its checkAdmin default is true, so Administrator would answer yes.
 *
 * The catalog keys keep discord.js's PermissionFlagsBits names; tests/unit/permissions.test.ts
 * pins every total.
 */
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";

/** A guild role as GET /guilds/{id}/roles returns it (the fields inspection uses). */
export interface ApiRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  hoist: boolean;
  managed: boolean;
}

/** A channel permission overwrite: type 0 targets a role, type 1 a member. */
export interface ApiOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

/**
 * Lowest role first, in the order Discord displays. Equal raw positions (common for new roles) are
 * resolved like discord.js's RoleManager.comparePositions: the higher ID sits lower. The live
 * gateway sorts through the SDK; this is the same order for raw payloads.
 */
export function ascendingRoles<T extends { id: string; position: number }>(
  roles: readonly T[],
): T[] {
  return [...roles].sort((left, right) => {
    if (left.position !== right.position) return left.position - right.position;
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId === rightId ? 0 : leftId > rightId ? -1 : 1;
  });
}

/** `ignoreAdministrator` previews the bot with Administrator removed (the OPS-12 target). */
export interface PermissionOptions {
  ignoreAdministrator?: boolean;
}

const ADMINISTRATOR = P.Administrator;

/**
 * Guild-level permissions of a member: @everyone (the role whose ID is the guild ID) plus every
 * role the member holds. Administrator implies every permission unless it is being ignored, in
 * which case the bit itself is dropped too, so the result is what remains without it.
 */
export function guildPermissions(
  guildId: string,
  roles: readonly ApiRole[],
  memberRoles: readonly string[],
  options: PermissionOptions = {},
): bigint {
  const held = new Set([guildId, ...memberRoles]);
  let bits = roles
    .filter((role) => held.has(role.id))
    .reduce((total, role) => total | BigInt(role.permissions), 0n);
  if (options.ignoreAdministrator) bits &= ~ADMINISTRATOR;
  else if (bits & ADMINISTRATOR) return PermissionsBitField.All;
  return bits;
}

/**
 * Discord's channel overwrite algorithm for one member: start from guild permissions, apply the
 * @everyone overwrite, then the union of the member's role overwrites (denies before allows), then
 * the member's own overwrite. Administrator bypasses overwrites unless it is being ignored.
 */
export function channelPermissions(
  guildId: string,
  base: bigint,
  overwrites: readonly ApiOverwrite[],
  member: { id: string; roles: readonly string[] },
  options: PermissionOptions = {},
): bigint {
  let bits = base;
  if (options.ignoreAdministrator) bits &= ~ADMINISTRATOR;
  else if (bits & ADMINISTRATOR) return PermissionsBitField.All;
  const everyone = overwrites.find((entry) => entry.id === guildId);
  if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const roles = overwrites.filter(
    (entry) => entry.type === 0 && entry.id !== guildId && member.roles.includes(entry.id),
  );
  const roleDeny = roles.reduce((total, entry) => total | BigInt(entry.deny), 0n);
  const roleAllow = roles.reduce((total, entry) => total | BigInt(entry.allow), 0n);
  bits = (bits & ~roleDeny) | roleAllow;
  const own = overwrites.find((entry) => entry.type === 1 && entry.id === member.id);
  if (own) bits = (bits & ~BigInt(own.deny)) | BigInt(own.allow);
  return bits;
}

/**
 * The core seven: what TaruBot's own role keeps once Administrator is off. Manage Roles and Manage
 * Nicknames for access and nicknames, and the four posting permissions plus Attach Files for its
 * posts. The add-to-server page lists these plus ONBOARDING_PERMISSIONS.
 */
export const CORE_PERMISSIONS = {
  ManageRoles: P.ManageRoles,
  ManageNicknames: P.ManageNicknames,
  ViewChannel: P.ViewChannel,
  SendMessages: P.SendMessages,
  EmbedLinks: P.EmbedLinks,
  AttachFiles: P.AttachFiles,
  ReadMessageHistory: P.ReadMessageHistory,
} as const;

/**
 * What lobby onboarding adds. /config validate checks all five on onboarding servers, more than
 * the onboarding preflight (DiscordGuildAccess's management check, which asks for Manage
 * Channels and the core bits but Manage Nicknames), because onboarding's channel pass needs every
 * one: Manage Channels lets it edit overwrites at all; Discord refuses to allow or deny a
 * permission the bot doesn't hold itself, and the lobby overwrites write Use Application Commands
 * and both thread permissions; and discord.js needs Connect to manage voice channels.
 */
export const ONBOARDING_PERMISSIONS = {
  ManageChannels: P.ManageChannels,
  UseApplicationCommands: P.UseApplicationCommands,
  CreatePublicThreads: P.CreatePublicThreads,
  CreatePrivateThreads: P.CreatePrivateThreads,
  Connect: P.Connect,
} as const;

/**
 * The one permission set the add-to-server page recommends: the core seven plus onboarding's five
 * (disjoint). Administrator is never part of it; it is granted only for the /setup overrides
 * window and removed once /config validate says it is no longer needed.
 */
export const RECOMMENDED_PERMISSIONS = 105_630_518_288n;

/**
 * What a posting channel (ledger, officer notifications, changelog, guest reviews) needs, View
 * Channel included: DiscordGateway.validateChannel requires all four (answer 9, 2026-09-28).
 */
export const POSTING_PERMISSIONS = {
  ViewChannel: P.ViewChannel,
  SendMessages: P.SendMessages,
  EmbedLinks: P.EmbedLinks,
  ReadMessageHistory: P.ReadMessageHistory,
} as const;

/** Permissions TaruBot never uses; /config validate warns when it holds any (answer 4). */
export const NEVER_NEEDED_PERMISSIONS = {
  ManageGuild: P.ManageGuild,
  ManageMessages: P.ManageMessages,
  MentionEveryone: P.MentionEveryone,
  KickMembers: P.KickMembers,
  BanMembers: P.BanMembers,
  ModerateMembers: P.ModerateMembers,
  ManageWebhooks: P.ManageWebhooks,
} as const;

/**
 * The deny mask /setup overrides writes on TaruBot's own member entry in channels no setting names
 * (answer 2): TaruBot only needs to be seen there (the member list), so the same entry also denies
 * reading history, managing the channel's permissions or the channel, and creating invites. It
 * never goes on a configured channel, which TaruBot reads and posts in.
 */
export const DENY_MASK =
  P.ReadMessageHistory | P.ManageRoles | P.ManageChannels | P.CreateInstantInvite;

/** The mask for voice and stage channels, and categories (their children's template): + Connect. */
export const VOICE_DENY_MASK = DENY_MASK | P.Connect;

/** Channel types that get VOICE_DENY_MASK: voice, stage, and categories. */
export const VOICE_MASK_TYPES: ReadonlySet<number> = new Set<number>([
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildCategory,
]);

export type CorePermission = keyof typeof CORE_PERMISSIONS;
export type OnboardingPermission = keyof typeof ONBOARDING_PERMISSIONS;
export type PostingPermission = keyof typeof POSTING_PERMISSIONS;
export type NeverNeededPermission = keyof typeof NEVER_NEEDED_PERMISSIONS;
/** Every permission a reply may name. */
export type PermissionKey =
  | CorePermission
  | OnboardingPermission
  | NeverNeededPermission
  | "Administrator"
  | "CreateInstantInvite";

/** Every labelled permission with its bit: the catalogs above plus Administrator and Create Invite. */
export const LABELLED_PERMISSIONS: Readonly<Record<PermissionKey, bigint>> = {
  ...CORE_PERMISSIONS,
  ...ONBOARDING_PERMISSIONS,
  ...NEVER_NEEDED_PERMISSIONS,
  Administrator: P.Administrator,
  CreateInstantInvite: P.CreateInstantInvite,
};

/**
 * Discord's names for the permissions replies mention. Singular "View Channel" matches every
 * existing TaruBot sentence (validateChannel's refusal, the add-to-server table).
 */
const LABELS: Readonly<Record<PermissionKey, string>> = {
  ManageRoles: "Manage Roles",
  ManageNicknames: "Manage Nicknames",
  ViewChannel: "View Channel",
  SendMessages: "Send Messages",
  EmbedLinks: "Embed Links",
  AttachFiles: "Attach Files",
  ReadMessageHistory: "Read Message History",
  ManageChannels: "Manage Channels",
  UseApplicationCommands: "Use Application Commands",
  CreatePublicThreads: "Create Public Threads",
  CreatePrivateThreads: "Create Private Threads",
  Connect: "Connect",
  ManageGuild: "Manage Server",
  ManageMessages: "Manage Messages",
  MentionEveryone: "Mention Everyone",
  KickMembers: "Kick Members",
  BanMembers: "Ban Members",
  ModerateMembers: "Time Out Members",
  ManageWebhooks: "Manage Webhooks",
  Administrator: "Administrator",
  CreateInstantInvite: "Create Invite",
};

/**
 * A permission's name as Discord shows it where it is set. Manage Roles is the one that changes:
 * in a channel's overwrites Discord calls the same bit Manage Permissions.
 */
export function permissionLabel(key: PermissionKey, context: "server" | "channel"): string {
  if (key === "ManageRoles" && context === "channel") return "Manage Permissions";
  return LABELS[key];
}

/** The catalog keys whose bit is set in `bits`, in catalog order. */
export function permissionKeys<K extends string>(
  bits: bigint,
  catalog: Readonly<Record<K, bigint>>,
): K[] {
  return (Object.keys(catalog) as K[]).filter((key) => (bits & catalog[key]) === catalog[key]);
}
