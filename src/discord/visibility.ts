/**
 * TaruBot's view of a guild as the gateway caches hold it (2.35.0, #46), copied into the plain
 * VisibilityGuild that src/domain/visibility.ts analyses.
 *
 * Channels come from the gateway cache only, never from GET /guilds/{id}/channels: from 2026-11-16
 * that list leaves out every channel TaruBot can't view (#47), which are exactly the ones this
 * reports. The gateway still dispatches them, obfuscated (src/discord/obfuscation.ts), so each
 * keeps its id, type, position and parent, and the analysis treats its overwrites as unreadable.
 * The gateway also keeps the cache current (channel, role and member updates), which is why the
 * officer alert can read it every few minutes without a request.
 *
 * Role names are copied because ApiRole carries them; they stay in memory and are never stored or
 * logged.
 */
import {
  type Client,
  DiscordAPIError,
  type Guild,
  type GuildMember,
  HTTPError,
  type NonThreadGuildBasedChannel,
  RateLimitError,
} from "discord.js";
import type { VisibilityChannel, VisibilityGuild } from "../domain/visibility.js";
import { isObfuscated } from "./obfuscation.js";

/**
 * Socket-level error codes Bun's fetch or undici raise when Discord can't be reached, on the error
 * or on its `cause`; undici's own codes all start with UND_ERR_.
 */
const SOCKET_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

/** Whether a value carries one of the socket-level codes above. */
function socketCode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" && (SOCKET_CODES.has(code) || code.startsWith("UND_ERR_"));
}

/**
 * Whether an error is Discord or the network failing, rather than a bug: a Discord answer
 * (DiscordAPIError, HTTPError, RateLimitError), an abort or timeout, a socket-level failure under
 * another class (checked on the error and one level down, on its `cause`), or the plain
 * TypeError("fetch failed") that fetch throws when it can't connect. readVisibility turns these
 * into null ("try again in a minute"); anything else, a TypeError from a discord.js change say,
 * is rethrown so it is reported rather than hidden behind that row.
 */
export function transportError(error: unknown): boolean {
  if (
    error instanceof DiscordAPIError ||
    error instanceof HTTPError ||
    error instanceof RateLimitError
  )
    return true;
  if (typeof error !== "object" || error === null) return false;
  const name: unknown = Reflect.get(error, "name");
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (socketCode(error) || socketCode(Reflect.get(error, "cause"))) return true;
  return error instanceof TypeError && error.message === "fetch failed";
}

/** One cached channel's fields, its overwrites copied as raw payload strings. */
function channelOf(channel: NonThreadGuildBasedChannel): VisibilityChannel {
  return {
    id: channel.id,
    type: channel.type,
    parentId: channel.parentId,
    // Discord always sends a position; an entry patched without one sorts first.
    position: channel.rawPosition ?? 0,
    overwrites: [...channel.permissionOverwrites.cache.values()].map((entry) => ({
      id: entry.id,
      type: entry.type,
      allow: String(entry.allow.bitfield),
      deny: String(entry.deny.bitfield),
    })),
    // The flag alone, as Discord documents: `___hidden___` is also a valid real name, and an entry
    // whose flag a channel option cleared is caught by unreadable()'s synthetic-deny rule instead.
    obfuscated: isObfuscated(channel),
  };
}

/**
 * A synchronous copy of the caches: every non-thread channel, every role (with its raw position,
 * which ascendingRoles orders as Discord does), TaruBot's roles and bot role, and the roles other
 * cached members hold (best effort: the member cache is complete only after a full member fetch).
 */
export function visibilitySnapshot(guild: Guild, bot: GuildMember): VisibilityGuild {
  const channels: VisibilityChannel[] = [];
  for (const channel of guild.channels.cache.values())
    if (!channel.isThread()) channels.push(channelOf(channel));
  const heldRoles = new Set<string>();
  for (const member of guild.members.cache.values()) {
    if (member.id === bot.id) continue;
    for (const role of member.roles.cache.keys()) if (role !== guild.id) heldRoles.add(role);
  }
  return {
    guildId: guild.id,
    bot: {
      id: bot.id,
      roles: [...bot.roles.cache.keys()].filter((role) => role !== guild.id),
      botRoleId: bot.roles.botRole?.id ?? null,
    },
    roles: [...guild.roles.cache.values()].map((role) => ({
      id: role.id,
      name: role.name,
      position: role.rawPosition,
      permissions: String(role.permissions.bitfield),
      hoist: role.hoist,
      managed: role.managed,
    })),
    channels,
    heldRoles: [...heldRoles],
    // Onboarding leaves the Community Updates channel and its category alone (#47's scope).
    communityUpdatesId: guild.publicUpdatesChannelId ?? null,
  };
}

/**
 * The guild as TaruBot sees it now, or null when the gateway can't say: the client isn't ready,
 * the guild isn't delivered or is unavailable, or TaruBot's member isn't cached. With `fresh`,
 * roles and TaruBot's member are fetched first (what /config validate and /setup overrides need,
 * since both may follow a role change), then readiness is checked again, because the gateway may
 * have dropped the guild meanwhile. A transport error from either fetch (transportError) is null
 * too; anything else propagates to the caller, which reports it. Channels are never fetched. The
 * copy is taken synchronously after the last await, so it is one consistent moment of the cache.
 */
export async function readVisibility(
  client: Client,
  guildId: string,
  fresh: boolean,
): Promise<VisibilityGuild | null> {
  const delivered = (): Guild | null => {
    if (!client.isReady()) return null;
    const guild = client.guilds.cache.get(guildId);
    return guild?.available ? guild : null;
  };
  let guild = delivered();
  if (!guild) return null;
  if (fresh) {
    try {
      await guild.roles.fetch();
      await guild.members.fetchMe({ force: true });
    } catch (error) {
      if (transportError(error)) return null;
      throw error;
    }
    guild = delivered();
    if (!guild) return null;
  }
  const bot = guild.members.cache.get(client.user?.id ?? "");
  return bot ? visibilitySnapshot(guild, bot) : null;
}
