/**
 * Pure helpers for read-only Discord inspection and command-scope maintenance. They work on raw
 * REST payloads (not discord.js caches), so the production inspection and `commands.js` can run
 * over plain GET requests while the legacy bot still owns the gateway. Nothing here performs I/O.
 */
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  type ApiOverwrite,
  type ApiRole,
  ascendingRoles,
  CORE_PERMISSIONS,
  channelPermissions,
  guildPermissions,
  POSTING_PERMISSIONS,
} from "../domain/permissions.js";
import { rolePositionChanges } from "../domain/role-layout.js";
import { Failure } from "../domain/values.js";
import { MISSING_ACCESS, UNKNOWN_CHANNEL } from "./obfuscation.js";

// The permission arithmetic moved to src/domain/permissions.ts in 2.35.0 (#46), where /config
// validate, the officer alert and /setup overrides share it; the inspection tool, its fixtures and
// tests keep importing it from here.
export {
  type ApiOverwrite,
  type ApiRole,
  ascendingRoles,
  channelPermissions,
  guildPermissions,
  type PermissionOptions,
} from "../domain/permissions.js";

/** Administrator's bit, which the target report shows separately from the other grants. */
const ADMINISTRATOR = PermissionFlagsBits.Administrator;

/** The structural subset of a command option that decides its invocable paths. */
export interface CommandOption {
  type: number;
  name: string;
  options?: readonly CommandOption[] | undefined;
}

/**
 * Flatten a command into its invocable paths ("config roles member"). Subcommands (1) and
 * subcommand groups (2) nest; ordinary argument options end the path. Paths, not Discord-generated
 * IDs or omitted defaults, are what registration readback compares.
 */
export function commandPaths(name: string, options: readonly CommandOption[] = []): string[] {
  const children = options.filter((entry) => entry.type === 1 || entry.type === 2);
  return children.length
    ? children.flatMap((entry) => commandPaths(`${name} ${entry.name}`, entry.options))
    : [name];
}

/** Paths present on only one side, each sorted, for declared-versus-registered comparisons. */
export function inventoryDiff(
  expected: readonly string[],
  actual: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((path) => !have.has(path)).sort(),
    unexpected: [...have].filter((path) => !want.has(path)).sort(),
  };
}

/** ApplicationFlags.GatewayGuildMembers: the verified-app Server Members intent. */
export const GATEWAY_GUILD_MEMBERS = 1 << 14;
/** ApplicationFlags.GatewayGuildMembersLimited: the unverified-app (under 100 guilds) grant. */
export const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

/** Decode the application's Server Members intent from its public flags. */
export function memberIntent(flags: number | undefined): "enabled" | "limited" | "disabled" {
  const value = flags ?? 0;
  if (value & GATEWAY_GUILD_MEMBERS) return "enabled";
  if (value & GATEWAY_GUILD_MEMBERS_LIMITED) return "limited";
  return "disabled";
}

/**
 * A guild channel as GET /guilds/{id}/channels returns it. From 2026-11-16 that list leaves out
 * every channel the bot can't view (#47), so a channel missing from it may be hidden, not deleted.
 */
export interface ApiChannel {
  id: string;
  name?: string | undefined;
  type: number;
  permission_overwrites?: readonly ApiOverwrite[] | undefined;
}

/**
 * The core seven TaruBot keeps without Administrator (CORE_PERMISSIONS, 2.35.0). The documentation
 * site's add-to-server page lists them plus ONBOARDING_PERMISSIONS as the one recommended set, and
 * tests/unit/docs-site.test.ts checks the page against both. The inspection reports which of these
 * the bot lacks, with and without Administrator.
 */
export const requiredBotPermissions = CORE_PERMISSIONS;

/** The channel permissions DiscordGateway.validateChannel requires of a configured destination. */
export const destinationPermissions = POSTING_PERMISSIONS;

/** Names of required permissions the bits lack, in declaration order. */
export function missingPermissions(bits: bigint, required: Readonly<Record<string, bigint>>) {
  return Object.entries(required)
    .filter(([, bit]) => (bits & bit) !== bit)
    .map(([name]) => name);
}

/** Human-readable permission names for a bitfield. */
export const permissionNames = (bits: bigint): string[] => new PermissionsBitField(bits).toArray();

/** Access roles must not carry these (DiscordGateway.validateRole refuses them). */
const BLOCKING = {
  Administrator: PermissionFlagsBits.Administrator,
  ManageGuild: PermissionFlagsBits.ManageGuild,
  ManageRoles: PermissionFlagsBits.ManageRoles,
} as const;

/** A managed role to inspect: its configuration field (member, guest, ...) and ID. */
export interface ManagedRoleTarget {
  field: string;
  id: string;
}

/** What the inspection reports for one managed role. `position` is its ascending display index. */
export interface ManagedRoleEntry {
  field: string;
  id: string;
  name: string | null;
  exists: boolean;
  position: number | null;
  hoist: boolean | null;
  belowBot: boolean;
  blockingPermissions: string[];
}

/**
 * Hierarchy report for the managed roles (highest first). `belowBot` is what role assignment needs
 * (the bot's highest role above the managed role). `layout` describes the presentation a role-layout
 * pass would impose; `wouldChange` is informational only, since the production launch keeps the
 * layout switch off, and is null when a missing or duplicated role blocks the plan.
 */
export function managedRoleReport(
  guildId: string,
  roles: readonly ApiRole[],
  botRoles: readonly string[],
  managed: readonly ManagedRoleTarget[],
): {
  botHighest: { id: string; name: string; position: number } | null;
  roles: ManagedRoleEntry[];
  layout: {
    hoisted: boolean;
    consecutive: boolean;
    wouldChange: boolean | null;
    blocked: string | null;
  };
} {
  const ascending = ascendingRoles(roles);
  const index = new Map(ascending.map((role, position) => [role.id, position]));
  const held = new Set([guildId, ...botRoles]);
  const top = ascending.reduce<number>(
    (highest, role, position) => (held.has(role.id) ? position : highest),
    -1,
  );
  const highest = top >= 0 ? ascending[top] : undefined;
  const entries = managed.map(({ field, id }): ManagedRoleEntry => {
    const role = ascending.find((candidate) => candidate.id === id);
    const position = index.get(id);
    return {
      field,
      id,
      name: role?.name ?? null,
      exists: role !== undefined,
      position: position ?? null,
      hoist: role?.hoist ?? null,
      belowBot: position !== undefined && position < top,
      blockingPermissions: role
        ? Object.entries(BLOCKING)
            .filter(([, bit]) => (BigInt(role.permissions) & bit) === bit)
            .map(([name]) => name)
        : [],
    };
  });
  const present = entries.filter((entry) => entry.exists);
  const positions = present.map((entry) => entry.position ?? 0).sort((a, b) => a - b);
  const consecutive = positions.every(
    (position, offset) => offset === 0 || position === (positions[offset - 1] ?? 0) + 1,
  );
  const hoisted = present.every((entry) => entry.hoist === true);
  let wouldChange: boolean | null = null;
  let blocked: string | null = null;
  try {
    // The real layout pass plans with the same function, so a blocked plan matches its diagnostic.
    const moves = rolePositionChanges(
      ascending.map((role) => role.id),
      managed.map((entry) => entry.id),
    );
    wouldChange = moves.length > 0 || !hoisted;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    blocked = error.message;
  }
  return {
    botHighest: highest ? { id: highest.id, name: highest.name, position: top } : null,
    roles: entries,
    layout: { hoisted, consecutive, wouldChange, blocked },
  };
}

/** A configured destination channel to inspect; `imported` is false for settings not applied. */
export interface ChannelTarget {
  field: string;
  id: string;
  imported: boolean | null;
}

/**
 * What GET /channels/{id} said about a destination the guild's channel list left out:
 * - hidden_or_other_server: 50001 Missing Access. Either TaruBot can't view it in this server, or
 *   it belongs to a server TaruBot isn't in; Discord answers both the same way;
 * - deleted: 10003 Unknown Channel;
 * - other_server: TaruBot can read it, but it belongs to another server.
 */
export type UnlistedState = "hidden_or_other_server" | "deleted" | "other_server";

/**
 * Where a destination stands: `listed` in the guild's channel list (its access is computed),
 * one of the UnlistedState answers, or `unchecked` when it isn't listed and no answer is known.
 */
export type ChannelState = "listed" | UnlistedState | "unchecked";

/** Destination access with and without Administrator, as the bot would use the channel. */
export interface ChannelEntry {
  field: string;
  id: string;
  name: string | null;
  /**
   * In this server's channel list. A destination that isn't may still exist (from 2026-11-16 the
   * list leaves out every channel TaruBot can't view), so `state` says what Discord answered.
   */
  exists: boolean;
  state: ChannelState;
  type: number | null;
  imported: boolean | null;
  bot: Access;
  withoutAdministrator: Access;
}

/** The destination IDs the channel list left out, which the inspection asks about one by one. */
export function unlistedTargets(
  targets: readonly ChannelTarget[],
  channels: readonly ApiChannel[],
): string[] {
  const listed = new Set(channels.map((channel) => channel.id));
  return [...new Set(targets.map((target) => target.id))].filter((id) => !listed.has(id));
}

/**
 * Classify one GET /channels/{id} answer for an unlisted destination by Discord's JSON error code
 * (not the HTTP status), or, when it succeeded, by the server the channel belongs to. A
 * successful read of a channel in this server (created after the list was read) or any other
 * answer is null, which the report shows as `unchecked`.
 */
export function unlistedState(
  answer: { ok: boolean; code?: number | undefined; guildId?: string | null | undefined },
  guildId: string,
): UnlistedState | null {
  if (answer.ok) return answer.guildId && answer.guildId !== guildId ? "other_server" : null;
  if (answer.code === MISSING_ACCESS) return "hidden_or_other_server";
  if (answer.code === UNKNOWN_CHANNEL) return "deleted";
  return null;
}

/** The channel permissions a destination depends on, as booleans. */
interface Access {
  view: boolean;
  send: boolean;
  embed: boolean;
  attach: boolean;
  history: boolean;
}

/** Summarize one channel bitfield into the access flags the report shows. */
function access(bits: bigint): Access {
  const has = (bit: bigint) => (bits & bit) === bit;
  return {
    view: has(PermissionFlagsBits.ViewChannel),
    send: has(PermissionFlagsBits.SendMessages),
    embed: has(PermissionFlagsBits.EmbedLinks),
    attach: has(PermissionFlagsBits.AttachFiles),
    history: has(PermissionFlagsBits.ReadMessageHistory),
  };
}

/**
 * The target-guild section of the production inspection: guild permissions (and what is missing
 * with Administrator removed), the managed-role hierarchy, and destination-channel access.
 */
export function targetReport(input: {
  guildId: string;
  roles: readonly ApiRole[];
  channels: readonly ApiChannel[];
  bot: { id: string; roles: readonly string[] };
  managedRoles: readonly ManagedRoleTarget[];
  channelTargets: readonly ChannelTarget[];
  /** Answers for the destinations the list left out (unlistedTargets), keyed by channel ID. */
  unlisted?: Readonly<Record<string, UnlistedState>>;
}) {
  const { guildId, roles, bot } = input;
  const withAdmin = guildPermissions(guildId, roles, bot.roles);
  const raw = guildPermissions(guildId, roles, bot.roles, { ignoreAdministrator: true });
  const hierarchy = managedRoleReport(guildId, roles, bot.roles, input.managedRoles);
  const channels = input.channelTargets.map(({ field, id, imported }): ChannelEntry => {
    const channel = input.channels.find((candidate) => candidate.id === id);
    const overwrites = channel?.permission_overwrites ?? [];
    // A destination missing from the list is `unchecked` unless Discord answered for it.
    const state: ChannelState = channel ? "listed" : (input.unlisted?.[id] ?? "unchecked");
    return {
      field,
      id,
      name: channel?.name ?? null,
      exists: state === "listed",
      state,
      type: channel?.type ?? null,
      imported,
      bot: access(channel ? channelPermissions(guildId, withAdmin, overwrites, bot) : 0n),
      withoutAdministrator: access(
        channel
          ? channelPermissions(guildId, raw, overwrites, bot, { ignoreAdministrator: true })
          : 0n,
      ),
    };
  });
  return {
    // The bot's own grants, without the Administrator expansion, so the listing stays readable.
    permissions: permissionNames(raw | (withAdmin & ADMINISTRATOR)),
    administrator: (withAdmin & ADMINISTRATOR) === ADMINISTRATOR,
    missingRequired: missingPermissions(withAdmin, requiredBotPermissions),
    withoutAdministrator: { missingRequired: missingPermissions(raw, requiredBotPermissions) },
    botHighest: hierarchy.botHighest,
    managedRoles: hierarchy.roles,
    layout: hierarchy.layout,
    channels,
  };
}
