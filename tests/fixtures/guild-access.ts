/** Controlled channel effects for PostgreSQL policy/recovery scenarios; SDK permissions are tested separately. */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import type {
  GuildAccessPort,
  GuildAccessSession,
  PreparedAccess,
} from "../../src/application/records.js";
import {
  blockerOf,
  type PreparePlan,
  type SetupPlanningPort,
} from "../../src/application/setup-plan.js";
import type { Failure } from "../../src/domain/values.js";
import {
  channelAccessOverwrites,
  sameOverwrites,
  type AccessChannel,
  type AccessRoles,
  type AccessSnapshot,
  type ChannelAudience,
} from "../../src/domain/channel-access.js";

/** Mutable remote state and effect hooks model restarts, edits and partial failures without Discord credentials. */
export class FakeGuildAccess implements GuildAccessPort, SetupPlanningPort {
  readonly guilds = new Map<string, AccessSnapshot>();
  readonly writes: string[] = [];
  /** Roles the dry run's roleCandidates reads, per guild (2.35.0). */
  readonly roleLists = new Map<string, { id: string; name: string }[]>();
  /** Refusals planPrepare reports as blockers, as DiscordGuildAccess would collect them. */
  planningRefusals: Failure[] = [];
  beforeWrite: ((channel: string) => Promise<void>) | undefined;
  afterWrite: ((channel: string) => Promise<void>) | undefined;
  private next = 800000;

  async check(): Promise<void> {}
  /** The caller half of check(); every caller passes here, as in check(). */
  async checkCaller(): Promise<void> {}
  async roleCandidates(guild: string): Promise<{ id: string; name: string }[]> {
    return structuredClone(this.roleLists.get(guild) ?? []);
  }
  /**
   * The dry run's prepare(): reuse a room whose ID the snapshot holds, otherwise create one, with
   * the injected refusals as blockers. It never writes.
   */
  async planPrepare(
    guild: string,
    _roles: Partial<AccessRoles>,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparePlan> {
    const snapshot = structuredClone(this.state(guild));
    const room = (id: string | null) =>
      snapshot.channels.some((channel) => channel.id === id)
        ? { action: "reuse" as const, id }
        : { action: "create" as const, id: null };
    return {
      blockers: this.planningRefusals.map(blockerOf),
      lobby: room(lobbyId),
      officerRoom: room(officerId),
      snapshot,
    };
  }
  /** Existing rooms are reused by ID; snapshots retain the pre-enforcement state. */
  async prepare(
    guild: string,
    _actor: string,
    roles: AccessRoles,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparedAccess> {
    const snapshot = this.state(guild);
    const room = (id: string | null, name: string, audience: ChannelAudience) => {
      const existing = snapshot.channels.find((channel) => channel.id === id);
      if (existing) return { id: existing.id, created: false };
      const channel: AccessChannel = {
        id: String(++this.next),
        name,
        type: ChannelType.GuildText,
        parentId: null,
        overwrites: channelAccessOverwrites([], guild, snapshot.botId, roles, audience),
        everyoneVisible: audience === "lobby",
        memberVisible: false,
        guestVisible: false,
      };
      snapshot.channels.push(channel);
      return { id: channel.id, created: true };
    };
    const lobby = room(lobbyId, "lobby", "lobby"),
      officers = room(officerId, "officer-chat", "officers");
    return { lobby, officers, snapshot: structuredClone(snapshot) };
  }
  /** Tests may seed any non-thread channel types, including staff-only categories. */
  state(guild: string): AccessSnapshot {
    let snapshot = this.guilds.get(guild);
    if (!snapshot) {
      snapshot = {
        botId: "800",
        everyonePermissions: String(P.ViewChannel | P.SendMessages),
        excludedChannelIds: [],
        preserveEveryoneView: false,
        channels: [],
      };
      this.guilds.set(guild, snapshot);
    }
    return snapshot;
  }
  async snapshot(guild: string): Promise<AccessSnapshot> {
    return structuredClone(this.state(guild));
  }
  /** Match the application session contract while retaining the existing effect hooks. */
  async begin(guild: string, roles: AccessRoles): Promise<GuildAccessSession> {
    return {
      snapshot: await this.snapshot(guild),
      channel: (channel, audience, guard) => this.channel(guild, channel, roles, audience, guard),
      restrictEveryone: (guard) => this.restrictEveryone(guild, guard),
    };
  }
  async channel(
    guild: string,
    id: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const snapshot = this.state(guild),
      channel = snapshot.channels.find((value) => value.id === id);
    if (snapshot.excludedChannelIds.includes(id))
      throw new Error("Attempted mutation of excluded channel");
    if (!channel) throw new Error("Missing fake channel");
    const desired = channelAccessOverwrites(
      channel.overwrites,
      guild,
      snapshot.botId,
      roles,
      audience,
    );
    if (
      sameOverwrites(channel.overwrites, desired) &&
      (audience !== "lobby" || channel.parentId === null)
    )
      return false;
    await this.beforeWrite?.(id);
    await guard();
    channel.overwrites = desired;
    if (audience === "lobby") channel.parentId = null;
    this.writes.push(id);
    await this.afterWrite?.(id);
    return true;
  }
  async restrictEveryone(guild: string, guard: () => Promise<void>): Promise<boolean> {
    const snapshot = this.state(guild);
    if (snapshot.preserveEveryoneView) return false;
    if ((BigInt(snapshot.everyonePermissions) & P.ViewChannel) === 0n) return false;
    await this.beforeWrite?.("everyone");
    await guard();
    snapshot.everyonePermissions = String(BigInt(snapshot.everyonePermissions) & ~P.ViewChannel);
    this.writes.push("everyone");
    await this.afterWrite?.("everyone");
    return true;
  }
}
