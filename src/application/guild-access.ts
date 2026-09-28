/** Durable onboarding policy and recovery snapshots; remote mutations stay outside transactions. */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import {
  accessRoles,
  channelAccessOverwrites,
  initiallyStaffOnly,
  sameOverwrites,
  type AccessSnapshot,
  type ChannelAudience,
} from "../domain/channel-access.js";
import { effectsPaused } from "../domain/failures.js";
import { Failure } from "../domain/values.js";
import { audit, orm, type Connection } from "../infrastructure/postgres/database.js";
import { and, eq } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import type { GuildAccessPort } from "./records.js";
import type { Service } from "./service.js";
import type { SetupPlanningPort } from "./setup-plan.js";

export class GuildAccess {
  constructor(
    private readonly app: Service,
    /** The channel-policy port, with the read-only methods /setup onboarding's dry run uses. */
    readonly discord: GuildAccessPort & SetupPlanningPort,
  ) {}

  /**
   * The stored staff-only decisions by channel, read without a lock: what remember() keeps for
   * channels it has seen before. /setup onboarding's dry run classifies audiences from it.
   */
  async policies(guild: string): Promise<Map<string, boolean>> {
    const rows = await this.app.db.orm
      .select({
        channel_id: t.channelAccessPolicies.channel_id,
        staff_only: t.channelAccessPolicies.staff_only,
      })
      .from(t.channelAccessPolicies)
      .where(eq(t.channelAccessPolicies.guild_id, guild));
    return new Map(rows.map((row) => [row.channel_id, row.staff_only]));
  }

  /** Capture privacy before enforcement, retaining the first observation across repeated setup. */
  async remember(
    client: Connection,
    guild: string,
    snapshot: AccessSnapshot,
    lobby: string,
    officers: string,
    alreadyEnabled: boolean,
  ): Promise<Map<string, boolean>> {
    const db = orm(client);
    const known = new Map(
      (
        await db
          .select({
            channel_id: t.channelAccessPolicies.channel_id,
            staff_only: t.channelAccessPolicies.staff_only,
          })
          .from(t.channelAccessPolicies)
          .where(eq(t.channelAccessPolicies.guild_id, guild))
      ).map((row) => [row.channel_id, row.staff_only]),
    );
    const channels = snapshot.channels
      .filter((channel) => !snapshot.excludedChannelIds.includes(channel.id))
      .sort(
        (a, b) =>
          Number(b.type === ChannelType.GuildCategory) -
          Number(a.type === ChannelType.GuildCategory),
      );
    for (const channel of channels) {
      const staff =
        channel.id === lobby
          ? false
          : channel.id === officers
            ? true
            : (known.get(channel.id) ??
              initiallyStaffOnly(
                channel,
                alreadyEnabled,
                channel.parentId ? known.get(channel.parentId) === true : false,
              ));
      await db
        .insert(t.channelAccessPolicies)
        .values({
          guild_id: guild,
          channel_id: channel.id,
          staff_only: staff,
          original_state: channel,
        })
        .onConflictDoUpdate({
          target: [t.channelAccessPolicies.guild_id, t.channelAccessPolicies.channel_id],
          set: {
            staff_only:
              channel.id === lobby || channel.id === officers
                ? staff
                : t.channelAccessPolicies.staff_only,
          },
        });
      known.set(channel.id, staff);
    }
    return known;
  }

  /** Current revision/effect checks fence each channel write; setup and layout share one guild lock. */
  async reconcile(guildId: string, guard: () => Promise<void>): Promise<unknown> {
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`setup:${guildId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked)
        throw new Failure("busy", "Guild setup or access reconciliation is already running.");
      const db = this.app.db.orm;
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
      if (!guild?.access_policy_enabled) return { skipped: "onboarding policy inactive" };
      if (!this.app.config.ENABLE_EFFECTS || !guild.effects_enabled)
        throw effectsPaused(this.app.config.ENABLE_EFFECTS);
      const lobby = guild.lobby_channel_id,
        officers = guild.officer_channel_id;
      if (!lobby || !officers || lobby === officers)
        throw new Failure(
          "blocked",
          "Run /setup onboarding to configure distinct lobby and officer rooms.",
        );
      const roles = accessRoles(guild);
      const currentGuard = async (): Promise<void> => {
        await guard();
        const current = await db
          .select({ id: t.guilds.id })
          .from(t.guilds)
          .where(
            and(
              eq(t.guilds.id, guildId),
              eq(t.guilds.revision, guild.revision),
              eq(t.guilds.active, true),
              eq(t.guilds.effects_enabled, true),
              eq(t.guilds.access_policy_enabled, true),
            ),
          );
        if (!current.length)
          throw new Failure(
            "superseded",
            "Guild access configuration changed during reconciliation.",
          );
      };
      await currentGuard();
      const session = await this.discord.begin(guildId, roles);
      const snapshot = session.snapshot;
      // Each refusal names the room it concerns, so a reply can point at the channel.
      const validateRooms = (value: AccessSnapshot): void => {
        const reserved = [lobby, officers].find((id) => value.excludedChannelIds.includes(id));
        if (reserved)
          throw new Failure(
            "blocked",
            "An onboarding binding now targets a reserved community channel. Run /setup onboarding with a separate officer-chat channel.",
            0,
            { kind: "resource", resource: "channel", id: reserved },
          );
        const missing = [lobby, officers].find(
          (id) =>
            !value.channels.some(
              (channel) => channel.id === id && channel.type === ChannelType.GuildText,
            ),
        );
        if (missing)
          throw new Failure(
            "blocked",
            "An onboarding room is missing. Run /setup onboarding to recreate or select it.",
            0,
            { kind: "resource", resource: "channel", id: missing },
          );
      };
      validateRooms(snapshot);
      const policies = await this.app.db.transaction(async (client) => {
        const valid = await orm(client)
          .select({ id: t.guilds.id })
          .from(t.guilds)
          .where(and(eq(t.guilds.id, guildId), eq(t.guilds.revision, guild.revision)))
          .for("share");
        if (!valid.length)
          throw new Failure(
            "superseded",
            "Access configuration changed before snapshot persistence.",
          );
        return this.remember(client, guildId, snapshot, lobby, officers, true);
      });
      const audience = (id: string): ChannelAudience =>
        id === lobby ? "lobby" : id === officers || policies.get(id) ? "officers" : "members";
      const changed = new Set<string>();
      // Establish the newcomer exception before closing the guild-level default.
      if (await session.channel(lobby, "lobby", currentGuard)) changed.add(lobby);
      const defaultChanged = await session.restrictEveryone(currentGuard);
      // Categories may propagate overwrites to synced children, so finish with the leaf channels.
      for (const channel of snapshot.channels
        .filter((channel) => !snapshot.excludedChannelIds.includes(channel.id))
        .sort(
          (a, b) =>
            Number(b.type === ChannelType.GuildCategory) -
            Number(a.type === ChannelType.GuildCategory),
        ))
        if (await session.channel(channel.id, audience(channel.id), currentGuard))
          changed.add(channel.id);
      await currentGuard();
      const verified = await this.discord.snapshot(guildId, roles);
      if (
        [...snapshot.excludedChannelIds].sort().join(":") !==
        [...verified.excludedChannelIds].sort().join(":")
      )
        throw new Failure(
          "superseded",
          "The community channel scope changed during reconciliation.",
        );
      validateRooms(verified);
      if (verified.channels.find((channel) => channel.id === lobby)?.parentId !== null)
        throw new Failure(
          "transient",
          "The lobby was moved into a gated category; retrying current policy.",
        );
      if (
        !verified.preserveEveryoneView &&
        (BigInt(verified.everyonePermissions) & P.ViewChannel) !== 0n
      )
        throw new Failure(
          "transient",
          "The default guild visibility has drifted; retrying access policy.",
        );
      const managed = verified.channels.filter(
        (channel) => !verified.excludedChannelIds.includes(channel.id),
      );
      for (const channel of managed) {
        if (
          !policies.has(channel.id) ||
          !sameOverwrites(
            channel.overwrites,
            channelAccessOverwrites(
              channel.overwrites,
              guildId,
              verified.botId,
              roles,
              audience(channel.id),
            ),
          )
        )
          throw new Failure(
            "transient",
            "Guild channels changed during access enforcement; retrying current policy.",
          );
      }
      if (changed.size || defaultChanged)
        await audit(this.app.db.pool, guildId, null, "channels.secured", guildId, {
          revision: guild.revision,
          channels: [...changed],
          defaultChanged,
          excludedChannels: verified.excludedChannelIds,
        });
      return {
        status: "secured",
        channels: managed.length,
        lobby,
        officers,
        changed: [...changed],
        defaultChanged,
        excludedChannels: verified.excludedChannelIds,
        preservedEveryoneView: verified.preserveEveryoneView,
      };
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${guildId}`])
          .catch(() => {});
      connection.release();
    }
  }
}
