/**
 * The Discord side of /setup overrides (2.35.0, #46; src/application/overrides.ts), over raw REST
 * so every request can be aborted and the gateway cache is never mutated by a read.
 *
 * - write: one PUT /channels/{id}/permissions/{TaruBot's user ID} with `type: 1` (a member entry)
 *   and exactly the allow and deny bits planned (Resources › Channel › "Edit Channel
 *   Permissions"). It never touches another entry, never sends a channel's full overwrite list
 *   (PATCH /channels/{id}) and never uses permissionOverwrites.edit/.set/.create. Discord lets a
 *   bot allow or deny only permissions it holds itself, unless it has Manage Permissions in the
 *   channel, which is why the run needs Administrator.
 * - read: GET /channels/{id}, parsed with zod; the fresh read before each write and the
 *   read-back after it. Obfuscation (src/discord/obfuscation.ts) decides hidden and deleted.
 * - facts and snapshot come from the gateway caches (src/discord/visibility.ts). Administrator is
 *   read from role bits, never from discord.js `has()`, whose checkAdmin default answers yes.
 */
import {
  ChannelFlags,
  type Client,
  DiscordAPIError,
  PermissionFlagsBits as P,
  Routes,
} from "discord.js";
import { z } from "zod";
import type { ChannelRead, OverridesFacts, OverridesPort } from "../application/overrides.js";
import { POSTING_PERMISSIONS } from "../domain/permissions.js";
import { Failure } from "../domain/values.js";
import { asIfBase, type OverrideEntry, type VisibilityGuild } from "../domain/visibility.js";
import { cachedAsHidden, MISSING_ACCESS, UNKNOWN_CHANNEL, unlistedChannel } from "./obfuscation.js";
import { readVisibility } from "./visibility.js";

/** Discord's JSON error code for Missing Permissions. */
const MISSING_PERMISSIONS = 50013;

/** The four posting permissions as one mask. */
const POSTING = Object.values(POSTING_PERMISSIONS).reduce((all, bit) => all | bit, 0n);

/** The fields of a raw channel payload the run reads; everything else is ignored. */
const RAW_CHANNEL = z.object({
  id: z.string(),
  type: z.number(),
  guild_id: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().optional(),
  flags: z.number().optional(),
  permission_overwrites: z
    .array(
      z.object({
        id: z.string(),
        type: z.number(),
        allow: z.string(),
        deny: z.string(),
      }),
    )
    .optional(),
});

/** Whether a role's own permissions include Administrator (overwrites can't grant it). */
const administrator = (permissions: string): boolean =>
  (BigInt(permissions) & P.Administrator) !== 0n;

/** OverridesPort over a discord.js client; see the module comment. */
export class DiscordOverrides implements OverridesPort {
  constructor(private readonly client: Client) {}

  /** TaruBot's view; `fresh` fetches roles and its member first, otherwise no request is made. */
  snapshot(guild: string, fresh: boolean): Promise<VisibilityGuild | null> {
    return readVisibility(this.client, guild, fresh);
  }

  /**
   * What the run needs about TaruBot and the caller, from one view (`fresh` refetches roles and
   * TaruBot's member; the loop's re-checks read the caches). Without a view nothing is known, so
   * nothing is allowed.
   */
  async facts(guildId: string, caller: string | null, fresh: boolean): Promise<OverridesFacts> {
    const view = await readVisibility(this.client, guildId, fresh);
    if (!view) return { botAdministrator: false, callerAllowed: null, basePostingHeld: false };
    const held = new Set([guildId, ...view.bot.roles]);
    return {
      botAdministrator: view.roles.some(
        (role) => held.has(role.id) && administrator(role.permissions),
      ),
      callerAllowed: caller === null ? null : await this.callerAllowed(guildId, caller, fresh),
      // What TaruBot keeps once Administrator is off (shared Administrator roles dropped whole).
      basePostingHeld: (asIfBase(view) & POSTING) === POSTING,
    };
  }

  /** The server owner, or a member holding Administrator; null when the member isn't known. */
  private async callerAllowed(
    guildId: string,
    caller: string,
    fresh: boolean,
  ): Promise<boolean | null> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
    if (guild.ownerId === caller) return true;
    const member = fresh
      ? await guild.members.fetch({ user: caller, force: true })
      : guild.members.cache.get(caller);
    if (!member) return null;
    // Role bits, as for TaruBot: the permission itself, not discord.js's admin shortcut.
    return (member.permissions.bitfield & P.Administrator) !== 0n;
  }

  /**
   * One channel read fresh. A 200 flagged obfuscated is hidden, never one only named like it; a
   * 200 whose real overwrites deny TaruBot View Channel is `ok`, since that deny is judged as
   * deliberate. 50001 is hidden, and 10003 deleted unless the gateway's entry still looks hidden
   * (cachedAsHidden). Anything else, an abort included, is thrown.
   */
  async read(guildId: string, channelId: string, signal: AbortSignal): Promise<ChannelRead> {
    let raw: unknown;
    try {
      raw = await this.client.rest.get(Routes.channel(channelId), { signal });
    } catch (error) {
      const answer = unlistedChannel(error);
      if (!answer) throw error;
      if (answer === "hidden") return { state: "hidden" };
      // Read the cache after the answer: a CHANNEL_DELETE applied meanwhile removed the entry.
      const guild = this.client.guilds.cache.get(guildId);
      const cached = guild?.channels.cache.get(channelId);
      const bot = guild?.members.me;
      return cached && !cached.isThread() && bot && cachedAsHidden(cached, bot)
        ? { state: "hidden" }
        : { state: "deleted" };
    }
    const channel = RAW_CHANNEL.parse(raw);
    // Another server's channel is none of this server's.
    if (channel.guild_id !== undefined && channel.guild_id !== guildId) return { state: "deleted" };
    // Discord says the HTTP API never obfuscates; the flag is kept as a fail-closed guard, and the
    // name never counts, because `___hidden___` is a valid name for a real channel.
    if (((channel.flags ?? 0) & ChannelFlags.ChannelObfuscated) !== 0) return { state: "hidden" };
    const cached = this.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    return {
      state: "ok",
      channel: {
        id: channel.id,
        type: channel.type,
        parentId: channel.parent_id ?? null,
        position:
          channel.position ?? (cached && !cached.isThread() ? (cached.rawPosition ?? 0) : 0),
        overwrites: (channel.permission_overwrites ?? []).map((entry) => ({
          id: entry.id,
          type: entry.type,
          allow: entry.allow,
          deny: entry.deny,
        })),
        obfuscated: false,
        fetched: true,
      },
    };
  }

  /**
   * TaruBot's own member entry, and only that. 10003 is deleted; 50001 and 50013 forbidden
   * (stops the run). A 400, or a 404 other than 10003, is Discord refusing this one channel (a
   * channel type that takes no overwrites, 50024; an invalid body, 50035), which the run records
   * and continues past. Anything else is thrown: an abort, 401, another 403, 429, 5xx and network
   * errors are about the run, not the channel.
   */
  async write(
    _guildId: string,
    channelId: string,
    entry: OverrideEntry,
    reason: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly state: "written" | "deleted" | "forbidden" }
    | { readonly state: "refused"; readonly code: number }
  > {
    const botId = this.client.user?.id;
    if (!botId) throw new Failure("blocked", "Discord bot identity is unavailable.");
    try {
      await this.client.rest.put(Routes.channelPermission(channelId, botId), {
        body: { type: 1, allow: String(entry.allow), deny: String(entry.deny) },
        reason,
        signal,
      });
      return { state: "written" };
    } catch (error) {
      if (!(error instanceof DiscordAPIError)) throw error;
      const code = Number(error.code);
      if (code === UNKNOWN_CHANNEL) return { state: "deleted" };
      if (code === MISSING_ACCESS || code === MISSING_PERMISSIONS) return { state: "forbidden" };
      if (error.status === 400 || error.status === 404) return { state: "refused", code };
      throw error;
    }
  }
}
