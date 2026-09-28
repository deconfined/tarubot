/** Guild channel provisioning and visibility writes, with fresh reads and explicit bot access. */
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import type {
  Channel,
  Client,
  Guild,
  GuildMember,
  NonThreadGuildBasedChannel,
  PermissionOverwriteManager,
  Role,
} from "discord.js";
import {
  channelAccessOverwrites,
  sameOverwrites,
  type AccessChannel,
  type AccessOverwrite,
  type AccessRoles,
  type AccessSnapshot,
  type ChannelAudience,
} from "../domain/channel-access.js";
import {
  LABELLED_PERMISSIONS,
  type PermissionKey,
  permissionLabel,
} from "../domain/permissions.js";
import { Failure, normalized } from "../domain/values.js";
import { cachedAsHidden, isObfuscated, unlistedChannel } from "./obfuscation.js";
import type {
  GuildAccessPort,
  GuildAccessSession,
  PreparedAccess,
} from "../application/records.js";
import {
  blockerOf,
  type PreparePlan,
  type RoomPlan,
  type SetupBlocker,
  type SetupPlanningPort,
} from "../application/setup-plan.js";

/** Immutable identity fences around the Gateway-updated SDK cache for one pass only. */
interface ReconciliationScope {
  guild: Guild;
  /** The channels this pass's REST list returned: the only ones TaruBot could read. */
  channelIds: ReadonlySet<string>;
  communityUpdatesId: string | null;
  /** The updates channel's parent as the gateway cache holds it (kept on obfuscated entries). */
  communityParentId: string | null;
  /** Excluded channels missing from this pass's REST list, whose real overwrites are unknown. */
  unreadable: ReadonlySet<string>;
  /** Stale cache entries Discord confirmed deleted in this pass, so later scope reads skip them. */
  deleted: ReadonlySet<string>;
}

/** What channelScope resolved for one REST read of the guild's channels. */
interface ChannelScope {
  channels: NonThreadGuildBasedChannel[];
  excluded: ReadonlySet<string>;
  communityUpdatesId: string | null;
  communityParentId: string | null;
  unreadable: ReadonlySet<string>;
  /** Cached channels the list left out that Discord confirmed deleted (see refuseHidden). */
  deleted: ReadonlySet<string>;
  preserveEveryoneView: boolean;
}

/**
 * The gateway hasn't delivered this guild, or has lost it, so its channel cache is no picture of
 * Discord: a guild first seen through REST has only what the channel list returned, which from
 * 2026-11-16 leaves out every hidden channel. Retry once the gateway is back rather than decide.
 */
function gatewayUnavailable(): Failure {
  return new Failure(
    "transient",
    "Discord scope is unavailable; retry after the gateway reconnects.",
  );
}

/**
 * The refusal for a channel onboarding should manage but TaruBot can't use. Discord hides a
 * channel TaruBot can't view (from 2026-11-16 it leaves it out of the REST list), so the same
 * refusal and fix name a hidden channel too: the pass fails closed rather than skip it.
 */
function unmanageable(id: string): Failure {
  return new Failure(
    "blocked",
    `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${id}>.`,
    0,
    { kind: "resource", resource: "channel", id, fix: "channel_permissions" },
  );
}

/** A list of names as a sentence: "A", "A and B", "A, B and C". */
function sentence(names: readonly string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The bits text 22 can name, in the order it names them. */
const MEMBER_ENTRY_ORDER: readonly PermissionKey[] = [
  "ViewChannel",
  "ManageChannels",
  "ManageRoles",
  "Connect",
];

/** Bits as the channel's permission screen names them (Manage Roles reads Manage Permissions). */
const channelNames = (bits: bigint): string[] =>
  MEMBER_ENTRY_ORDER.filter((key) => (bits & LABELLED_PERMISSIONS[key]) !== 0n).map((key) =>
    permissionLabel(key, "channel"),
  );

/**
 * The refusal for a managed channel where TaruBot's own member entry denies what onboarding needs
 * (2.35.0, #46, text 22). /setup overrides masks channels no setting names by denying Manage
 * Permissions and Manage Channels (among others, Connect in voice and stage channels) on that
 * entry; a member entry's deny beats any role allow, so unmanageable()'s role fix can't work
 * there. With Administrator the check passes, and onboarding's first pass then lifts the mask
 * (channelAccessOverwrites), which is why turning Administrator on until that pass has run is the
 * first remedy. `needed` is what the check asked for and `denied` the lacking bits the entry
 * denies; both are named in the channel's own terms, so Manage Roles reads as Manage Permissions
 * throughout. The channel, the denied bits and where the deny sits come first, so /sync status's
 * 150-character diagnostic still carries them.
 */
function memberEntryRefusal(id: string, needed: bigint, denied: bigint): Failure {
  return new Failure(
    "blocked",
    `TaruBot's member entry in <#${id}> denies ${sentence(channelNames(denied))}; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs ${sentence(channelNames(needed))} there.`,
    0,
    { kind: "resource", resource: "channel", id, fix: "member_entry" },
  );
}

/** What onboarding needs in every channel it manages (observe's check). */
const MANAGED = P.ViewChannel | P.ManageChannels | P.ManageRoles;

/**
 * Voice and stage channels, where Discord's implicit deny applies: denying Connect there also
 * denies Manage Channels (Topics › Permissions; discord.js's `manageable` checks Connect for them),
 * so onboarding's write to one needs Connect as well.
 */
const VOICE_BASED: ReadonlySet<number> = new Set<number>([
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

/**
 * Why onboarding can't manage a listed channel, or null when it can: the member-entry refusal
 * when TaruBot's own entry denies one of the lacking bits, otherwise unmanageable(). The check
 * keeps discord.js's Administrator shortcut, as before 2.35.0: with Administrator it passes.
 *
 * In a voice or stage channel whose TaruBot member entry denies Connect (what /setup overrides'
 * mask writes there), Connect is needed too: without it Discord refuses onboarding's write with a
 * bare 50013, so the check names it instead. A Connect deny from a role or @everyone is left to
 * Discord as before 2.35.0, so no pass that worked then is refused now (docs/OPEN_ITEMS.md).
 */
function channelRefusal(channel: NonThreadGuildBasedChannel, bot: GuildMember): Failure | null {
  const permissions = channel.permissionsFor(bot);
  const own = channel.permissionOverwrites.cache.get(bot.id);
  const ownDeny = own?.type === OverwriteType.Member ? own.deny.bitfield : 0n;
  const needed =
    VOICE_BASED.has(channel.type) && (ownDeny & P.Connect) !== 0n ? MANAGED | P.Connect : MANAGED;
  if (permissions.has(needed)) return null;
  const denied = ownDeny & needed & ~permissions.bitfield;
  return denied !== 0n ? memberEntryRefusal(channel.id, needed, denied) : unmanageable(channel.id);
}

/** A room the dry run couldn't decide, behind a blocker. */
const UNKNOWN_ROOM: RoomPlan = { action: "unknown", id: null };

/**
 * The gateway cache lacks the Community Updates channel or its category, so scope is unknown.
 * Discord sends both even when TaruBot can't view them (obfuscated), so seeing them is not the fix.
 */
function communityMissing(id: string): Failure {
  return new Failure(
    "blocked",
    "Discord didn't return the Community Updates channel or its category. Check the server's Community settings, then retry.",
    0,
    { kind: "resource", resource: "channel", id },
  );
}

/**
 * Plain copies of a channel's cached overwrites. Copy them synchronously after the read they come
 * from: a gateway update applied during a later await (an obfuscated CHANNEL_UPDATE carries one
 * synthetic @everyone deny) would otherwise become the base of a plan or a write.
 */
function overwritesOf(channel: {
  readonly permissionOverwrites: PermissionOverwriteManager;
}): AccessOverwrite[] {
  return [...channel.permissionOverwrites.cache.values()].map((value) => ({
    id: value.id,
    type: value.type,
    allow: String(value.allow.bitfield),
    deny: String(value.deny.bitfield),
  }));
}

/**
 * Whether a 200 answer to GET /channels/{id} shows a channel TaruBot can view. Discord answers
 * 50001 for a hidden channel today and doesn't document its answer from 2026-11-16, so a 200 that
 * is obfuscated, or whose overwrites deny TaruBot View Channel, counts as hidden too.
 */
function viewable(fetched: Channel | null, bot: GuildMember): boolean {
  if (!fetched || !("guildId" in fetched) || fetched.isThread() || isObfuscated(fetched))
    return false;
  return fetched.permissionsFor(bot).has(P.ViewChannel);
}

/**
 * One managed channel as the onboarding snapshot records it. Member and Guest visibility are
 * judged for their roles; a role that doesn't exist yet (the dry run's roles to be created, which
 * start with no permissions and no overwrites) sees what @everyone sees.
 */
function accessChannel(
  guild: Guild,
  channel: NonThreadGuildBasedChannel,
  member: Role | undefined,
  guest: Role | undefined,
): AccessChannel {
  const everyoneVisible = channel.permissionsFor(guild.roles.everyone).has(P.ViewChannel, false);
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    overwrites: overwritesOf(channel),
    everyoneVisible,
    memberVisible: member
      ? channel.permissionsFor(member).has(P.ViewChannel, false)
      : everyoneVisible,
    guestVisible: guest ? channel.permissionsFor(guest).has(P.ViewChannel, false) : everyoneVisible,
  };
}

/** The lobby and the officer room can't be the same channel. */
function sameRooms(): Failure {
  return new Failure("input", "The lobby and officer rooms must be different channels.");
}

/**
 * How setup picks its rooms from one observed snapshot: a saved or chosen ID first, then a
 * unique recognizable name, and for the officer room the only private text channel. Ambiguity
 * requires an explicit setup option. Shared by prepare() and the dry run (planPrepare), so both
 * decide the same way; each call throws its refusal.
 */
function roomPicker(before: AccessSnapshot, guild: Guild, deleted: ReadonlySet<string>) {
  const text = before.channels.filter((channel) => channel.type === ChannelType.GuildText);
  const pick = (
    configured: string | null,
    names: readonly string[],
    candidates: readonly AccessChannel[] = text,
  ): AccessChannel | undefined => {
    if (configured) {
      if (before.excludedChannelIds.includes(configured))
        throw new Failure(
          "input",
          "The Community Updates channel and its category are reserved. Choose a different officer channel.",
          0,
          { kind: "option", option: "officers" },
        );
      const known = before.channels.find((channel) => channel.id === configured);
      if (known) {
        if (known.type !== ChannelType.GuildText)
          throw new Failure("input", "The lobby and officer rooms must be text channels.");
        return known;
      }
      // A saved room the gateway still knows but the snapshot couldn't list isn't known to be
      // gone: refuse rather than fall through to the name and private-room guesses and create
      // a second room beside it. The snapshot's hidden-channel check refuses a hidden room
      // first; this catches one that reappeared after the list. Only a room Discord confirmed
      // deleted in this pass (a stale cache entry) falls through to be recreated.
      const cached = guild.channels.cache.get(configured);
      if (cached && !cached.isThread() && !deleted.has(configured)) throw unmanageable(configured);
    }
    for (const name of names) {
      const matches = candidates.filter((channel) => normalized(channel.name) === name);
      // Guessing between same-named rooms could expose the wrong one, so the manager picks.
      if (matches.length > 1)
        throw new Failure(
          "ambiguous",
          `More than one channel is named #${name}, so TaruBot didn't guess. Pick the right one in /setup onboarding.`,
          0,
          { kind: "matches", resource: "channel", name, ids: matches.map((room) => room.id) },
        );
      if (matches[0]) return matches[0];
    }
    return undefined;
  };
  const officerNames = ["officer-chat", "officers", "officer", "staff", "staff-chat", "mod-chat"];
  return {
    lobby: (lobbyId: string | null) => pick(lobbyId, ["lobby"]),
    officers: (officerId: string | null, existingLobby: AccessChannel | undefined) => {
      let existingOfficers = pick(officerId, []);
      if (!existingOfficers) {
        const privateRooms = text.filter(
          (channel) =>
            channel.id !== existingLobby?.id &&
            !channel.everyoneVisible &&
            !channel.memberVisible &&
            !channel.guestVisible,
        );
        existingOfficers = pick(null, officerNames, privateRooms);
        if (!existingOfficers && privateRooms.length === 1) existingOfficers = privateRooms[0];
        else if (!existingOfficers && privateRooms.length > 1)
          throw new Failure(
            "ambiguous",
            "Several private channels could be the officer room. Pick one with /setup onboarding officers:.",
            0,
            {
              kind: "matches",
              resource: "channel",
              name: "officer room",
              ids: privateRooms.map((room) => room.id),
            },
          );
        existingOfficers ??= pick(null, officerNames);
      }
      return existingOfficers;
    },
  };
}

/** Without an explicit @everyone View overwrite, changing the guild default changes this area too. */
function inheritsEveryoneView(
  channel: { readonly permissionOverwrites: PermissionOverwriteManager },
  guildId: string,
): boolean {
  const everyone = channel.permissionOverwrites.cache.get(guildId);
  return !everyone || ((everyone.allow.bitfield | everyone.deny.bitfield) & P.ViewChannel) === 0n;
}

export class DiscordGuildAccess implements GuildAccessPort, SetupPlanningPort {
  constructor(private readonly client: Client) {}

  /** Removing the public default must not strand the bot or leave newcomers with management powers. */
  private async management(guildId: string): Promise<{ guild: Guild; bot: GuildMember }> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const [first] = this.managementRefusals(guild, bot);
    if (first) throw first;
    return { guild, bot };
  }

  /**
   * Every management refusal, in the order management() throws the first: TaruBot's own role
   * permissions, @everyone's management bits, and a TaruBot role granting View Channel. The dry run
   * (planPrepare) lists them all.
   */
  private managementRefusals(guild: Guild, bot: GuildMember): Failure[] {
    const refusals: Failure[] = [];
    const required = [
      P.ManageChannels,
      P.ManageRoles,
      P.ViewChannel,
      P.SendMessages,
      P.ReadMessageHistory,
      P.EmbedLinks,
      P.AttachFiles,
    ];
    if (!bot.permissions.has(required))
      refusals.push(
        new Failure(
          "blocked",
          "Give the TaruBot role Manage Channels, Manage Roles, View Channel, Send Messages, Read Message History, Embed Links and Attach Files.",
        ),
      );
    if (
      guild.roles.everyone.permissions.any(
        [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels],
        false,
      )
    )
      refusals.push(
        new Failure(
          "blocked",
          "Remove Administrator, Manage Server, Manage Roles and Manage Channels from @everyone first.",
        ),
      );
    if (
      !bot.roles.cache.some(
        (role) =>
          role.id !== guild.id && role.permissions.any([P.Administrator, P.ViewChannel], false),
      )
    )
      refusals.push(
        new Failure(
          "blocked",
          "Give the TaruBot role View Channel before onboarding hides channels from @everyone.",
        ),
      );
    return refusals;
  }

  /** Channel provisioning requires current manager authority, independently of bot-only Officer access. */
  async check(guildId: string, actor: string): Promise<void> {
    const { guild } = await this.management(guildId);
    await this.callerAllowed(guild, actor);
  }

  /**
   * The caller half of check() on its own, for the dry run (2.35.0): a refusal about the person
   * asking stays thrown, while the management checks become blockers in planPrepare.
   */
  async checkCaller(guildId: string, actor: string): Promise<void> {
    await this.callerAllowed(
      await this.client.guilds.fetch({ guild: guildId, force: true }),
      actor,
    );
  }

  /** The person setting up onboarding holds Manage Server, Manage Roles and Manage Channels. */
  private async callerAllowed(guild: Guild, actor: string): Promise<void> {
    const member = await guild.members.fetch({ user: actor, force: true });
    if (!member.permissions.has([P.ManageGuild, P.ManageRoles, P.ManageChannels]))
      throw new Failure(
        "forbidden",
        "Setting up onboarding needs Manage Server, Manage Roles and Manage Channels.",
        0,
        { kind: "scope", scope: "manage_channels" },
      );
  }

  /** Every role's ID and name, fetched fresh (the dry run's existingRoleId input). */
  async roleCandidates(guildId: string): Promise<{ id: string; name: string }[]> {
    const guild = await this.client.guilds.fetch(guildId);
    return [...(await guild.roles.fetch()).values()].map((role) => ({
      id: role.id,
      name: role.name,
    }));
  }

  /** All access bindings must remain ordinary roles below the bot, with no server-management powers. */
  private roles(
    guild: Guild,
    bot: GuildMember,
    bindings: AccessRoles,
  ): Record<keyof AccessRoles, Role> {
    const get = (id: string): Role => {
      const refused = this.roleRefusal(guild, bot, id);
      if (refused) throw refused;
      const role = guild.roles.cache.get(id);
      if (!role) throw new Error("A checked access role left the role cache");
      return role;
    };
    return {
      member: get(bindings.member),
      guest: get(bindings.guest),
      officer: get(bindings.officer),
      leader: get(bindings.leader),
    };
  }

  /**
   * Why one access role can't be used, or null: it must exist, be an ordinary role (not @everyone
   * or managed) below TaruBot's highest role, and carry no server-management permissions. One
   * approved wording for every case; the detail names the role for the Affected field.
   */
  private roleRefusal(guild: Guild, bot: GuildMember, id: string): Failure | null {
    const role = guild.roles.cache.get(id);
    if (
      !role ||
      role.id === guild.id ||
      role.managed ||
      bot.roles.highest.comparePositionTo(role) <= 0 ||
      role.permissions.any([P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels], false)
    )
      return new Failure(
        "blocked",
        "Each access role must be an ordinary role below TaruBot without management permissions. Run /setup onboarding again to repair.",
        0,
        { kind: "resource", resource: "role", id },
      );
    return null;
  }

  /**
   * Exclude configured community resources by ID, including a parent whose edits could propagate.
   *
   * From 2026-11-16 the REST list holds only channels TaruBot can view, so the Community Updates
   * channel and its category are resolved from the gateway cache, which keeps their id and
   * parent_id even when it obfuscates them. Absence from this REST list is the authority on what
   * TaruBot can read: an excluded channel it left out is unreadable, its real overwrites unknown,
   * so the pass keeps @everyone's View default (ACCESS-05's fallback) and gates each managed
   * channel through its own overwrites. Only when the cache lacks them too is scope unknown.
   *
   * All of this needs the gateway's picture of the guild, so the pass waits for it (transient)
   * before and after the list. `knownDeleted` carries this pass's confirmed deletions forward.
   * `hidden`, the dry run's list, collects every hidden channel instead of refusing the first.
   */
  private async channelScope(
    guild: Guild,
    bot: GuildMember,
    knownDeleted: ReadonlySet<string> = new Set(),
    hidden?: Failure[],
  ): Promise<ChannelScope> {
    if (!this.client.isReady() || !guild.available) throw gatewayUnavailable();
    const listed = await guild.channels.fetch();
    if (!this.client.isReady() || !guild.available) throw gatewayUnavailable();
    const channels = [...listed.values()].filter((channel) => channel !== null);
    const readable = new Set(channels.map((channel) => channel.id));
    const excluded = new Set<string>();
    const communityUpdatesId = guild.publicUpdatesChannelId ?? null;
    let communityParentId: string | null = null;
    if (communityUpdatesId) {
      const updates = guild.channels.cache.get(communityUpdatesId);
      if (!updates || updates.isThread()) throw communityMissing(communityUpdatesId);
      excluded.add(updates.id);
      communityParentId = updates.parentId;
      if (updates.parentId) {
        // Discord dispatches a category whenever it dispatches a child, so a missing one is not
        // hidden but unknown; currentScope would otherwise call every pass superseded.
        const parent = guild.channels.cache.get(updates.parentId);
        if (!parent || parent.isThread()) throw communityMissing(updates.parentId);
        excluded.add(parent.id);
      }
    }
    const unreadable = new Set([...excluded].filter((id) => !readable.has(id)));
    const preserveEveryoneView = [...excluded].some((id) => {
      const channel = listed.get(id);
      // Never read an unlisted channel's cached overwrites: an obfuscated entry's are synthetic.
      return !channel || inheritsEveryoneView(channel, guild.id);
    });
    const deleted = await this.refuseHidden(guild, bot, readable, excluded, knownDeleted, hidden);
    return {
      channels,
      excluded,
      communityUpdatesId,
      communityParentId,
      unreadable,
      deleted,
      preserveEveryoneView,
    };
  }

  /**
   * Fail closed on channels Discord hides from TaruBot (ACCESS-01/02, the owner's decision on #47).
   * From 2026-11-16 the REST list silently leaves them out, so a channel onboarding should manage
   * would drop out of the pass while it still reported "secured". Each non-thread, non-excluded
   * channel only the gateway cache knows is confirmed with GET /channels/{id}:
   * - 50001 Missing Access: hidden, so the pass refuses, naming it with the permissions fix;
   * - 200: created (or unhidden) after the list was read, so it is left for the pass its channel
   *   event queues. A 200 that is obfuscated or denies TaruBot View Channel is hidden instead;
   * - 10003 Unknown Channel: a deleted channel's stale cache entry, ignored and returned. If the
   *   gateway still holds a non-thread entry that is obfuscated, or whose cached overwrites deny
   *   TaruBot View Channel, it is hidden instead (`cachedAsHidden`): a slash-command channel
   *   option clears the flag but keeps the synthetic @everyone deny, so the flag alone would let
   *   a hidden channel drop out. A stale entry for a deleted channel TaruBot could view stays
   *   deleted. A real deletion's CHANNEL_DELETE removes the entry and queues a pass, so a
   *   refusal of a deleted hidden channel clears itself.
   * Discord answers 50001 for a hidden channel today and doesn't document the single-channel
   * answer from 2026-11-16, so the other two are checked for a hidden channel as above. Anything
   * else is rethrown for the queue to classify. A server with nothing hidden makes no extra
   * requests, and an ID in `knownDeleted` isn't asked about again. With `collect` (the dry run),
   * each hidden channel's refusal is added to it and the probe carries on.
   */
  private async refuseHidden(
    guild: Guild,
    bot: GuildMember,
    readable: ReadonlySet<string>,
    excluded: ReadonlySet<string>,
    knownDeleted: ReadonlySet<string>,
    collect?: Failure[],
  ): Promise<ReadonlySet<string>> {
    const deleted = new Set(knownDeleted);
    const unlisted = [...guild.channels.cache.values()].filter(
      (channel) =>
        !channel.isThread() &&
        !readable.has(channel.id) &&
        !excluded.has(channel.id) &&
        !deleted.has(channel.id),
    );
    for (const channel of unlisted) {
      const state = await this.client.channels.fetch(channel.id, { force: true }).then(
        (fetched) => (viewable(fetched, bot) ? ("visible" as const) : ("hidden" as const)),
        (error: unknown) => {
          const answer = unlistedChannel(error);
          if (!answer) throw error;
          if (answer !== "deleted") return answer;
          // Read the cache after the answer: a CHANNEL_DELETE applied meanwhile removed the entry.
          const cached = guild.channels.cache.get(channel.id);
          return cached && !cached.isThread() && cachedAsHidden(cached, bot) ? "hidden" : answer;
        },
      );
      if (state === "hidden") {
        if (!collect) throw unmanageable(channel.id);
        collect.push(unmanageable(channel.id));
      }
      if (state === "deleted") deleted.add(channel.id);
    }
    return deleted;
  }

  /** Retain only identities; channel objects continue receiving normal Guilds Gateway updates. */
  private retainScope(guild: Guild, scope: ChannelScope): ReconciliationScope {
    return {
      guild,
      channelIds: new Set(scope.channels.map((channel) => channel.id)),
      communityUpdatesId: scope.communityUpdatesId,
      // The same cached parent currentScope compares with, so a hidden area never looks moved.
      communityParentId: scope.communityParentId,
      unreadable: scope.unreadable,
      deleted: scope.deleted,
    };
  }

  /** Hidden community channels cannot be read individually; require a connected, coherent Gateway cache. */
  private currentScope(scope: ReconciliationScope) {
    const guild = this.client.guilds.cache.get(scope.guild.id);
    if (!this.client.isReady() || guild !== scope.guild || !guild.available)
      throw gatewayUnavailable();
    if ((guild.publicUpdatesChannelId ?? null) !== scope.communityUpdatesId)
      throw new Failure("superseded", "The community channel scope changed; retry reconciliation.");
    const excluded = new Set<string>();
    if (scope.communityUpdatesId) {
      const updates = guild.channels.cache.get(scope.communityUpdatesId);
      if (!updates || updates.isThread() || updates.parentId !== scope.communityParentId)
        throw new Failure(
          "superseded",
          "The community channel scope changed; retry reconciliation.",
        );
      excluded.add(updates.id);
      if (updates.parentId) excluded.add(updates.parentId);
    }
    // Every protected channel must still be cached before any one of them decides the default.
    const protectedChannels = [...excluded].map((id) => {
      const channel = guild.channels.cache.get(id);
      if (!channel || channel.isThread())
        throw new Failure(
          "superseded",
          "Protected channel metadata changed; retry reconciliation.",
        );
      return channel;
    });
    const preserveEveryoneView = protectedChannels.some(
      (channel) =>
        // Unreadable in this pass: its cached overwrites can't justify lowering a shared default,
        // even when an interaction option has cleared the obfuscated flag and left the synthetic
        // overwrite behind. The flag is the second signal: an area hidden since the list was read.
        scope.unreadable.has(channel.id) ||
        isObfuscated(channel) ||
        inheritsEveryoneView(channel, guild.id),
    );
    return { guild, excluded, preserveEveryoneView };
  }

  /** No catalogue request here: scope changes invalidate the pass instead of rescanning per target. */
  private managedChannel(scope: ReconciliationScope, channelId: string) {
    const current = this.currentScope(scope);
    if (current.excluded.has(channelId))
      throw new Failure(
        "blocked",
        "The Community Updates channel and its category are reserved. Choose a different officer channel.",
        0,
        { kind: "resource", resource: "channel", id: channelId },
      );
    const channel = current.guild.channels.cache.get(channelId);
    if (!scope.channelIds.has(channelId) || !channel || channel.isThread())
      throw new Failure(
        "blocked",
        "An onboarding channel was deleted or is unavailable. Run /setup onboarding to repair it.",
        0,
        { kind: "resource", resource: "channel", id: channelId },
      );
    // Hidden since this pass listed it: its cached name and overwrites are synthetic, so nothing is
    // planned or written from them. The next pass lists it afresh and refuses it if still hidden.
    if (isObfuscated(channel))
      throw new Failure(
        "superseded",
        "An onboarding channel became hidden from TaruBot; retry reconciliation.",
      );
    return channel;
  }

  /** Check capabilities only in managed channels; inaccessible community resources are outside scope. */
  async snapshot(guildId: string, bindings: AccessRoles): Promise<AccessSnapshot> {
    return (await this.begin(guildId, bindings)).snapshot;
  }

  /** Fetch the full inventory once and share it through all effects in this reconciliation. */
  async begin(guildId: string, bindings: AccessRoles): Promise<GuildAccessSession> {
    const { snapshot, retained } = await this.observe(guildId, bindings);
    return {
      snapshot,
      channel: (channel, audience, guard) =>
        this.channelWithin(retained, channel, bindings, audience, guard),
      restrictEveryone: (guard) => this.restrictEveryoneWithin(retained, guard),
    };
  }

  /** One pass's snapshot, with the scope it retains; prepare also reads the confirmed deletions. */
  private async observe(guildId: string, bindings: AccessRoles) {
    const { guild, bot } = await this.management(guildId);
    const roles = this.roles(guild, bot, bindings);
    const scope = await this.channelScope(guild, bot);
    const channels: AccessChannel[] = [];
    for (const channel of scope.channels) {
      if (scope.excluded.has(channel.id)) continue;
      const refused = channelRefusal(channel, bot);
      if (refused) throw refused;
      channels.push(accessChannel(guild, channel, roles.member, roles.guest));
    }
    const snapshot: AccessSnapshot = {
      botId: bot.id,
      everyonePermissions: String(guild.roles.everyone.permissions.bitfield),
      excludedChannelIds: [...scope.excluded].sort(),
      preserveEveryoneView: scope.preserveEveryoneView,
      channels,
    };
    return { snapshot, retained: this.retainScope(guild, scope) };
  }

  /** Prefer saved IDs, then a unique recognizable room; ambiguity requires an explicit setup option. */
  async prepare(
    guildId: string,
    actor: string,
    roles: AccessRoles,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparedAccess> {
    const { snapshot: before, retained } = await this.observe(guildId, roles);
    const guild = await this.client.guilds.fetch(guildId);
    const rooms = roomPicker(before, guild, retained.deleted);
    const existingLobby = rooms.lobby(lobbyId);
    const existingOfficers = rooms.officers(officerId, existingLobby);
    if (existingLobby && existingLobby.id === existingOfficers?.id) throw sameRooms();
    const ensure = async (
      existing: AccessChannel | undefined,
      name: string,
      audience: ChannelAudience,
    ) => {
      if (existing) return { id: existing.id, created: false };
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic:
          audience === "lobby"
            ? "Use /claim and /verify to link your character. Verified FC members receive Member; verified visitors receive Guest. Staff can help with /apply."
            : "Officer coordination and application review.",
        permissionOverwrites: channelAccessOverwrites(
          [],
          guildId,
          before.botId,
          roles,
          audience,
        ).map((overwrite) => ({
          ...overwrite,
          allow: BigInt(overwrite.allow),
          deny: BigInt(overwrite.deny),
        })),
        reason: `TaruBot onboarding setup requested by ${actor}`,
      });
      return { id: channel.id, created: true };
    };
    const lobby = await ensure(existingLobby, "lobby", "lobby");
    const officers = await ensure(existingOfficers, "officer-chat", "officers");
    // Detaching an existing lobby is deferred until its original parent/overwrites are persisted.
    const current = await this.snapshot(guildId, roles);
    const originals = new Map(before.channels.map((item) => [item.id, item]));
    return {
      lobby,
      officers,
      snapshot: {
        ...current,
        channels: current.channels.map((item) => originals.get(item.id) ?? item),
      },
    };
  }

  /**
   * The dry run's prepare() (2.35.0, #46): the same reads and decisions, with every refusal
   * collected instead of the first thrown, and nothing created. It lists each management
   * refusal, each access role in `roles` (those that already exist) that onboarding can't use,
   * each hidden or unmanageable channel, and the room choice's refusals. A scope it can't read at
   * all (the gateway lost the guild, the Community Updates channel isn't cached) leaves the rooms
   * unknown and the snapshot null.
   */
  async planPrepare(
    guildId: string,
    roles: Partial<AccessRoles>,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparePlan> {
    const refusals: Failure[] = [];
    const blockers = (): SetupBlocker[] => refusals.map(blockerOf);
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    refusals.push(...this.managementRefusals(guild, bot));
    for (const id of Object.values(roles)) {
      const refused = id ? this.roleRefusal(guild, bot, id) : null;
      if (refused) refusals.push(refused);
    }
    let scope: ChannelScope;
    try {
      scope = await this.channelScope(guild, bot, new Set(), refusals);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      refusals.push(error);
      return {
        blockers: blockers(),
        lobby: UNKNOWN_ROOM,
        officerRoom: UNKNOWN_ROOM,
        snapshot: null,
      };
    }
    const member = roles.member ? guild.roles.cache.get(roles.member) : undefined;
    const guest = roles.guest ? guild.roles.cache.get(roles.guest) : undefined;
    const channels: AccessChannel[] = [];
    for (const channel of scope.channels) {
      if (scope.excluded.has(channel.id)) continue;
      const refused = channelRefusal(channel, bot);
      if (refused) refusals.push(refused);
      channels.push(accessChannel(guild, channel, member, guest));
    }
    const snapshot: AccessSnapshot = {
      botId: bot.id,
      everyonePermissions: String(guild.roles.everyone.permissions.bitfield),
      excludedChannelIds: [...scope.excluded].sort(),
      preserveEveryoneView: scope.preserveEveryoneView,
      channels,
    };
    const rooms = roomPicker(snapshot, guild, scope.deleted);
    /** One room's decision; a refusal is collected and leaves it unknown. */
    const decide = (choose: () => AccessChannel | undefined): AccessChannel | undefined | null => {
      try {
        return choose();
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        refusals.push(error);
        return null;
      }
    };
    const lobby = decide(() => rooms.lobby(lobbyId));
    const officers = decide(() => rooms.officers(officerId, lobby ?? undefined));
    if (lobby && officers && lobby.id === officers.id) refusals.push(sameRooms());
    const plan = (room: AccessChannel | undefined | null): RoomPlan =>
      room === null
        ? UNKNOWN_ROOM
        : room
          ? { action: "reuse", id: room.id }
          : { action: "create", id: null };
    return { blockers: blockers(), lobby: plan(lobby), officerRoom: plan(officers), snapshot };
  }

  /** Standalone convenience; guild reconciliation opens one shared session instead. */
  async channel(
    guildId: string,
    channelId: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    return (await this.begin(guildId, roles)).channel(channelId, audience, guard);
  }

  /** Cached no-op detection, targeted reads before writes, and targeted readback avoid N full scans. */
  private async channelWithin(
    scope: ReconciliationScope,
    channelId: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const guildId = scope.guild.id;
    let channel = this.managedChannel(scope, channelId);
    const freshForWrite = async () => {
      await guard();
      this.managedChannel(scope, channelId);
      // Refresh just this target; Gateway events keep the protected binding/parent cache current.
      const fetched = await this.client.channels.fetch(channelId, { force: true });
      if (
        !fetched ||
        !("guildId" in fetched) ||
        fetched.guildId !== guildId ||
        fetched.isThread() ||
        !("permissionOverwrites" in fetched)
      )
        throw new Failure("superseded", "The channel scope changed before mutation.");
      // Copied before the next await, so the write is planned from what this read returned.
      const overwrites = overwritesOf(fetched);
      await guard();
      // Rechecked after the last await: listed in this pass, not excluded, and not obfuscated.
      return { channel: this.managedChannel(scope, channelId), overwrites };
    };
    const botId = this.client.user?.id;
    if (!botId) throw new Failure("blocked", "Discord bot identity is unavailable.");
    let moved = false;
    if (audience === "lobby" && channel.type === ChannelType.GuildText && channel.parentId) {
      ({ channel } = await freshForWrite());
      if (channel.type !== ChannelType.GuildText)
        throw new Failure("blocked", "The lobby must remain a guild text channel.");
      await channel.setParent(null, {
        lockPermissions: false,
        reason: "Keep the onboarding lobby outside gated categories",
      });
      moved = true;
    }
    // The no-op check reads the cache: managedChannel just confirmed it listed and not obfuscated.
    let before = overwritesOf(channel),
      desired = channelAccessOverwrites(before, guildId, botId, roles, audience);
    if (sameOverwrites(before, desired)) return moved;
    const fresh = await freshForWrite();
    channel = fresh.channel;
    before = fresh.overwrites;
    desired = channelAccessOverwrites(before, guildId, botId, roles, audience);
    if (sameOverwrites(before, desired)) return moved;
    // No await since freshForWrite's last managedChannel check, so the target is still readable.
    await channel.permissionOverwrites.set(
      desired.map((value) => ({ ...value, allow: BigInt(value.allow), deny: BigInt(value.deny) })),
      "TaruBot onboarding visibility policy",
    );
    const verified = await this.client.channels.fetch(channelId, { force: true });
    if (!verified || !("permissionOverwrites" in verified))
      throw new Failure("blocked", "Channel disappeared during access enforcement.");
    const actual = overwritesOf(verified);
    if (!sameOverwrites(actual, channelAccessOverwrites(actual, guildId, botId, roles, audience)))
      throw new Failure(
        "transient",
        "Channel permissions changed during onboarding reconciliation.",
      );
    return true;
  }

  /** Close the default only when excluded community resources have independent View overwrites. */
  async restrictEveryone(guildId: string, guard: () => Promise<void>): Promise<boolean> {
    const { guild, bot } = await this.management(guildId);
    const scope = await this.channelScope(guild, bot);
    return this.restrictEveryoneWithin(this.retainScope(guild, scope), guard);
  }

  /** A shared-default mutation gets one extra authoritative catalogue check, never one per target. */
  private async restrictEveryoneWithin(
    scope: ReconciliationScope,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const current = this.currentScope(scope);
    let everyone = current.guild.roles.everyone;
    if (current.preserveEveryoneView) return false;
    if (!everyone.permissions.has(P.ViewChannel, false)) return false;
    await guard();
    const guildId = scope.guild.id;
    const { guild, bot } = await this.management(guildId);
    // The pass's confirmed deletions aren't asked about again; anything newly hidden still is.
    const refreshed = await this.channelScope(guild, bot, scope.deleted);
    if (refreshed.preserveEveryoneView) return false;
    everyone = guild.roles.everyone;
    if (!everyone.permissions.has(P.ViewChannel, false)) return false;
    await guard();
    if (this.currentScope(scope).preserveEveryoneView) return false;
    await everyone.setPermissions(
      everyone.permissions.bitfield & ~P.ViewChannel,
      "TaruBot lobby-only newcomer visibility",
    );
    if ((await guild.roles.fetch()).get(guildId)?.permissions.has(P.ViewChannel, false))
      throw new Failure(
        "transient",
        "The @everyone visibility default changed during reconciliation.",
      );
    return true;
  }
}
