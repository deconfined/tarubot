/**
 * Real Discord.js permission resolution with controlled REST state; no gateway login or credentials.
 *
 * It models Discord's channel obfuscation (#47) as three modes, `fixture.obfuscation`:
 * - "enforced" (the default): Discord from 2026-11-16. A channel the bot can't view is left out of
 *   GET /guilds/100/channels, and the gateway (modelled by GET /guilds/100, whose `channels` fill
 *   the SDK cache as GUILD_CREATE does) holds it obfuscated: named ___hidden___, flagged
 *   CHANNEL_OBFUSCATED, with one synthetic overwrite denying @everyone View Channel, and only its
 *   id, type and parent_id real;
 * - "gateway": the Developer Portal's test toggle before the date. The gateway obfuscates, but
 *   REST still lists every channel in full;
 * - "off": Discord without obfuscation.
 * In every mode GET and PATCH /channels/{id} answer 50001 Missing Access for a channel the bot
 * can't view, and 10003 Unknown Channel for one that doesn't exist, as Discord does today.
 * Discord doesn't document the GET answer for a hidden channel from 2026-11-16, so
 * `discord.hiddenAnswer` can change it, and `discord.channelError` can fail that GET outright.
 * `discord.delivered = false` models a guild the gateway hasn't delivered yet.
 * Visibility is computed with Discord's overwrite algorithm for bot 900, plus the category rule:
 * a category is viewable when any of its channels is.
 *
 * Since 2.35.0 (#46) it also answers PUT /channels/{id}/permissions/{target}, the one write
 * /setup overrides makes: it upserts that single entry and nothing else, records the route in
 * `writes`, and answers 50001 for a channel the bot can't view. `discord.putError` fails a PUT
 * first (it may wait, for a request in flight), `discord.afterPut` runs after one lands, and
 * `discord.propagate` models Discord copying a category's new overwrites to the children that
 * were synced with it. It is on by default, as Discord documents ("Any further changes to a parent
 * category will be reflected in its synced child channels", Topics › Permissions); a test turns
 * it off to cover a write that doesn't reach them. `botAdministrator` gives bot 900 the
 * Administrator role 701 or takes it away.
 */
import { spyOn } from "bun:test";
import {
  ChannelFlags,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  ClientUser,
  DiscordAPIError,
  InteractionType,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import { z } from "zod";
import { DiscordGuildAccess } from "../../src/discord/guild-access.js";
import { channelPermissions, guildPermissions } from "../../src/discord/inspection.js";
import { OBFUSCATED_CHANNEL_NAME } from "../../src/discord/obfuscation.js";
import type { AccessRoles } from "../../src/domain/channel-access.js";

/** Which Discord the fixture answers as; see the module comment. */
export type Obfuscation = "off" | "gateway" | "enforced";

/** Thread types, which follow their parent's visibility and never carry their own overwrites. */
const THREADS: readonly ChannelType[] = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

/** Discord's JSON error for `method route`, as @discordjs/rest throws it. */
export function discordError(code: number, status: number, method: string, route: string) {
  return new DiscordAPIError(
    { code, message: "Fixture Discord error" },
    code,
    status,
    method,
    route,
    { body: undefined, files: undefined },
  );
}

const overwrite = z.object({
  id: z.string(),
  type: z.nativeEnum(OverwriteType),
  allow: z.string(),
  deny: z.string(),
});
export interface ChannelFixture {
  id: string;
  guild_id: string;
  name: string;
  type: ChannelType;
  parent_id: string | null;
  permission_overwrites: z.infer<typeof overwrite>[];
  /** The channel's real flags; REST always sends them (0 when none), which clears a cached flag. */
  flags?: number;
}
/** Expose the protected SDK constructor only to supply a controlled logged-in identity in tests. */
class FixtureClientUser extends ClientUser {
  constructor(client: Client<true>) {
    super(client, { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true });
  }
}
/** SDK objects are built from API-shaped observations rather than duplicating permission precedence in tests. */
export function discordAccessFixture() {
  const client = new Client<true>({ intents: [] });
  client.user = new FixtureClientUser(client);
  const ready = spyOn(client, "isReady").mockReturnValue(true);
  const bindings: AccessRoles = { member: "201", guest: "202", officer: "203", leader: "204" };
  const base =
    P.ViewChannel |
    P.SendMessages |
    P.ReadMessageHistory |
    P.UseApplicationCommands |
    P.Connect |
    P.Speak |
    P.CreatePublicThreads |
    P.CreatePrivateThreads;
  const manager = P.ManageGuild | P.ManageRoles | P.ManageChannels;
  const roles = [
    { id: "100", name: "@everyone", position: 0, permissions: String(base) },
    ...Object.entries(bindings).map(([name, id], index) => ({
      id,
      name,
      position: index + 1,
      permissions: "0",
    })),
    { id: "500", name: "Unrelated", position: 5, permissions: String(P.ViewChannel) },
    {
      id: "600",
      name: "Bot",
      position: 6,
      permissions: String(base | manager | P.EmbedLinks | P.AttachFiles),
    },
    { id: "700", name: "Manager", position: 7, permissions: String(base | manager) },
    { id: "701", name: "Administrator", position: 8, permissions: String(P.Administrator) },
  ];
  const people = new Map<string, string[]>([
    ["900", ["600"]],
    ["300", []],
    ["301", ["700"]],
    ["400", []],
    ["401", ["201"]],
    ["402", ["202"]],
    ["403", ["201", "203"]],
    ["404", ["202", "204"]],
    ["405", ["500"]],
    ["406", ["701"]],
  ]);
  const channels: ChannelFixture[] = [];
  const community: { updatesChannelId: string | null } = { updatesChannelId: null };
  const writes: string[] = [];
  const reads: string[] = [];
  /** Every PUT as sent (2.35.0): its route, raw body and audit-log reason. */
  const puts: { route: string; body: unknown; reason: string | undefined }[] = [];
  // Mutable settings a test changes through the returned object (see the module comment).
  const discord: {
    obfuscation: Obfuscation;
    /**
     * How GET /channels/{id} answers for a channel the bot can't view: "missing_access" (50001,
     * Discord's answer today and the default), "unknown_channel" (10003), "obfuscated" (200 with
     * the gateway's obfuscated shape) or "full" (200 with the real channel).
     */
    hiddenAnswer: "missing_access" | "unknown_channel" | "obfuscated" | "full";
    /** Runs first for GET /channels/{id}; an error it returns is thrown (an outage, another code). */
    channelError?: ((channelId: string) => Error | undefined) | undefined;
    /**
     * False models a guild the gateway hasn't delivered: GET /guilds/100 then answers as Discord's
     * REST does, without channels or availability, so a guild first seen through it has an empty
     * channel cache and `available` false. True (the default) models GUILD_CREATE.
     */
    delivered: boolean;
    /** Runs before GET /guilds/100/channels reads the state, e.g. to delete a cached channel. */
    beforeList?: (() => void | Promise<void>) | undefined;
    /** Runs after that list is taken, e.g. to create a channel the list doesn't have. */
    afterList?: (() => void | Promise<void>) | undefined;
    /**
     * Runs first for PUT /channels/{id}/permissions/{target}; an error it returns (or resolves to)
     * is thrown and nothing is written. It gets the request's abort signal, so a test can hold a
     * PUT in flight until a drain aborts it.
     */
    putError?:
      | ((
          channelId: string,
          signal: AbortSignal | undefined,
        ) => Error | undefined | Promise<Error | undefined>)
      | undefined;
    /** Runs after a PUT has written its entry (and propagated), e.g. to change state mid-run. */
    afterPut?: ((channelId: string) => void | Promise<void>) | undefined;
    /**
     * Whether a PUT on a category also rewrites the children whose overwrites equalled the
     * category's before it (Discord's "synced" children). On by default, as Discord documents.
     */
    propagate: boolean;
  } = {
    obfuscation: "enforced",
    hiddenAnswer: "missing_access",
    delivered: true,
    propagate: true,
  };
  // Channels a slash-command option has patched in the cache: real name and flags, but still the
  // synthetic overwrite, until the gateway sends the channel again.
  const optionPatched = new Set<string>();
  let serial = 1000;
  /** Discord's permission algorithm for bot 900, with the category rule for categories. */
  const botCanView = (channel: ChannelFixture): boolean => {
    if (THREADS.includes(channel.type)) {
      const parent = channels.find((candidate) => candidate.id === channel.parent_id);
      return parent ? botCanView(parent) : false;
    }
    const held = people.get("900") ?? [];
    const base = guildPermissions(
      "100",
      roles.map((role) => ({ ...role, hoist: false, managed: false })),
      held,
    );
    const bits = channelPermissions("100", base, channel.permission_overwrites, {
      id: "900",
      roles: held,
    });
    if ((bits & P.ViewChannel) === P.ViewChannel) return true;
    return (
      channel.type === ChannelType.GuildCategory &&
      channels.some(
        (child) =>
          child.parent_id === channel.id && !THREADS.includes(child.type) && botCanView(child),
      )
    );
  };
  const hidden = (channel: ChannelFixture) => !botCanView(channel);
  /** A channel as REST returns it: in full, with its flags. */
  const rest = (channel: ChannelFixture) => ({
    ...structuredClone(channel),
    flags: channel.flags ?? 0,
  });
  /** A channel's obfuscated shape: only id, type and parent_id real, one synthetic overwrite. */
  const obfuscate = (channel: ChannelFixture) => ({
    id: channel.id,
    guild_id: channel.guild_id,
    type: channel.type,
    parent_id: channel.parent_id,
    name: OBFUSCATED_CHANNEL_NAME,
    flags: ChannelFlags.ChannelObfuscated,
    permission_overwrites: [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ],
  });
  /** A channel as the gateway sends it: obfuscated when hidden (and obfuscation is on). */
  const gateway = (channel: ChannelFixture) => {
    if (discord.obfuscation === "off" || !hidden(channel)) return rest(channel);
    const obfuscated = obfuscate(channel);
    return optionPatched.has(channel.id)
      ? { ...obfuscated, name: channel.name, flags: channel.flags ?? 0 }
      : obfuscated;
  };
  const add = (
    name: string,
    type = ChannelType.GuildText,
    permission_overwrites: ChannelFixture["permission_overwrites"] = [],
    parent_id: string | null = null,
  ): ChannelFixture => {
    const channel = {
      id: String(++serial),
      guild_id: "100",
      name,
      type,
      permission_overwrites,
      parent_id,
    };
    channels.push(channel);
    return channel;
  };
  const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
    reads.push(route);
    if (route === "/guilds/100") {
      const guild = {
        id: "100",
        name: "Access fixture",
        owner_id: "300",
        public_updates_channel_id: community.updatesChannelId,
        roles: structuredClone(roles),
      };
      if (!discord.delivered) return guild;
      // Model the available guild/channel cache normally populated by GUILD_CREATE, which
      // leaves out threads the bot can't view.
      return {
        ...guild,
        unavailable: false,
        channels: channels
          .filter((channel) => !(THREADS.includes(channel.type) && hidden(channel)))
          .map(gateway),
      };
    }
    if (route === "/guilds/100/roles") return structuredClone(roles);
    if (route === "/guilds/100/channels") {
      await discord.beforeList?.();
      const listed = channels
        .filter((channel) => discord.obfuscation !== "enforced" || !hidden(channel))
        .map(rest);
      await discord.afterList?.();
      return listed;
    }
    const person = [...people].find(([id]) => route === `/guilds/100/members/${id}`);
    if (person)
      return {
        user: {
          id: person[0],
          username: person[0],
          discriminator: "0",
          avatar: null,
          bot: person[0] === "900",
        },
        roles: person[1],
        joined_at: "2026-01-01T00:00:00Z",
        flags: 0,
      };
    const channelId = /^\/channels\/(\d+)$/u.exec(route)?.[1];
    if (channelId === undefined) throw new Error(`Unexpected fixture read ${route}`);
    const failure = discord.channelError?.(channelId);
    if (failure) throw failure;
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw discordError(10003, 404, "GET", route);
    if (!hidden(channel)) return rest(channel);
    switch (discord.hiddenAnswer) {
      case "unknown_channel":
        throw discordError(10003, 404, "GET", route);
      case "obfuscated":
        return obfuscate(channel);
      case "full":
        return rest(channel);
      case "missing_access":
        throw discordError(50001, 403, "GET", route);
    }
  });
  const patch = spyOn(client.rest, "patch").mockImplementation(async (route, options) => {
    // REST serializes SDK bitfield objects through toJSON before sending the request body.
    const body: unknown = JSON.parse(JSON.stringify(options?.body));
    writes.push(route);
    const role = roles.find((role) => route === `/guilds/100/roles/${role.id}`);
    if (role) {
      role.permissions = z.object({ permissions: z.string() }).parse(body).permissions;
      return structuredClone(role);
    }
    const channel = channels.find((channel) => route === `/channels/${channel.id}`);
    if (!channel) throw new Error(`Unexpected fixture write ${route}`);
    // Discord refuses to edit a channel the bot can't view; nothing is written.
    if (hidden(channel)) throw discordError(50001, 403, "PATCH", route);
    const change = z
      .object({
        parent_id: z.string().nullable().optional(),
        permission_overwrites: z.array(overwrite).optional(),
      })
      .parse(body);
    if (change.parent_id !== undefined) channel.parent_id = change.parent_id;
    if (change.permission_overwrites !== undefined)
      channel.permission_overwrites = change.permission_overwrites;
    return rest(channel);
  });
  const post = spyOn(client.rest, "post").mockImplementation(async (route, options) => {
    if (route !== "/guilds/100/channels") throw new Error(`Unexpected fixture creation ${route}`);
    const input = z
      .object({
        name: z.string(),
        type: z.nativeEnum(ChannelType),
        permission_overwrites: z.array(overwrite),
      })
      .parse(options?.body);
    writes.push(route);
    return rest(add(input.name, input.type, input.permission_overwrites));
  });
  /**
   * The overwrite sets as Discord compares them for "synced": same entries, any order, an
   * @everyone entry with no bits counting as none, as discord.js's GuildChannel#permissionsLocked
   * models it (Discord doesn't document that case; `propagate: false` covers a Discord that
   * wouldn't copy the write there).
   */
  const sameSet = (
    left: readonly ChannelFixture["permission_overwrites"][number][],
    right: typeof left,
  ) => {
    const real = (list: typeof left) =>
      list.filter(
        (entry) => !(entry.id === "100" && BigInt(entry.allow) === 0n && BigInt(entry.deny) === 0n),
      );
    const [a, b] = [real(left), real(right)];
    return (
      a.length === b.length &&
      a.every((entry) =>
        b.some(
          (other) =>
            other.id === entry.id &&
            other.type === entry.type &&
            BigInt(other.allow) === BigInt(entry.allow) &&
            BigInt(other.deny) === BigInt(entry.deny),
        ),
      )
    );
  };
  const put = spyOn(client.rest, "put").mockImplementation(async (route, options) => {
    const match = /^\/channels\/(\d+)\/permissions\/(\d+)$/u.exec(route);
    if (!match?.[1] || !match[2]) throw new Error(`Unexpected fixture write ${route}`);
    const [, channelId, target] = match;
    puts.push({ route, body: structuredClone(options?.body), reason: options?.reason });
    const failure = await discord.putError?.(channelId, options?.signal ?? undefined);
    if (failure) throw failure;
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw discordError(10003, 404, "PUT", route);
    // Discord refuses to edit a channel the bot can't view; nothing is written.
    if (hidden(channel)) throw discordError(50001, 403, "PUT", route);
    const body = z
      .object({ type: z.nativeEnum(OverwriteType), allow: z.string(), deny: z.string() })
      .parse(options?.body);
    writes.push(route);
    const before = structuredClone(channel.permission_overwrites);
    channel.permission_overwrites = [
      ...channel.permission_overwrites.filter((entry) => entry.id !== target),
      { id: target, type: body.type, allow: body.allow, deny: body.deny },
    ];
    if (discord.propagate && channel.type === ChannelType.GuildCategory)
      for (const child of channels)
        if (child.parent_id === channel.id && sameSet(child.permission_overwrites, before))
          child.permission_overwrites = structuredClone(channel.permission_overwrites);
    await discord.afterPut?.(channelId);
    return undefined;
  });
  let interactions = 5000;
  /**
   * A /channel-style slash command run by user 400 in `channelId`, built by the real SDK from a raw
   * payload. `appPermissions` is the bot's permission bitfield in that channel, which interaction
   * payloads carry unobfuscated. Channels in `resolved` are applied to the cache the way discord.js
   * applies a channel option's resolved data.
   */
  const slash = (
    channelId: string,
    appPermissions: bigint,
    resolved: Record<string, unknown> = {},
    name = "channel",
  ) => {
    const user = { id: "400", username: "400", discriminator: "0", avatar: null };
    const value: unknown = Reflect.construct(ChatInputCommandInteraction, [
      client,
      {
        id: String(++interactions),
        application_id: "900",
        token: "fixture-interaction-token",
        version: 1,
        type: InteractionType.ApplicationCommand,
        guild_id: "100",
        channel: { id: channelId, type: ChannelType.GuildText },
        user,
        member: { user, roles: [], joined_at: "2026-01-01T00:00:00Z", permissions: "0", flags: 0 },
        app_permissions: String(appPermissions),
        locale: "en-US",
        guild_locale: "en-US",
        entitlements: [],
        authorizing_integration_owners: {},
        attachment_size_limit: 10000000,
        data: { id: "700", name, type: 1, options: [], resolved: { channels: resolved } },
      },
    ]);
    if (!(value instanceof ChatInputCommandInteraction)) throw new Error("Invalid slash fixture");
    return value;
  };
  return {
    client,
    bindings,
    roles,
    people,
    channels,
    community,
    writes,
    reads,
    puts,
    ready,
    add,
    discord,
    hidden,
    slash,
    /**
     * Name `channelId` in a slash-command channel option, as `/setup officers:` or
     * `/config changelog channel:` would. Interactions aren't obfuscated, so the resolved channel
     * carries the real name and flags but no overwrites; the SDK patches the cached entry with it,
     * clearing CHANNEL_OBFUSCATED and keeping the synthetic overwrite. Later gateway reads keep that
     * mixed entry too. The guild must already be cached.
     */
    chooseInOption(channelId: string) {
      const channel = channels.find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Unknown fixture channel ${channelId}`);
      optionPatched.add(channelId);
      return slash(
        "1",
        P.UseApplicationCommands,
        {
          [channel.id]: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parent_id: channel.parent_id,
            flags: channel.flags ?? 0,
            permissions: "0",
          },
        },
        "setup",
      );
    },
    port: new DiscordGuildAccess(client),
    /** Give bot 900 the Administrator role 701, or take it away (2.35.0). */
    botAdministrator(on: boolean) {
      const held = (people.get("900") ?? []).filter((role) => role !== "701");
      people.set("900", on ? [...held, "701"] : held);
    },
    async close() {
      get.mockRestore();
      patch.mockRestore();
      post.mockRestore();
      put.mockRestore();
      ready.mockRestore();
      await client.destroy();
    },
  };
}
