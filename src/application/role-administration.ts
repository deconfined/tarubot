/**
 * Role provisioning and explicit officer decisions, restricted to server role managers. Since
 * 2.35.0 (#46) /setup has two subcommands, both dry runs unless confirm:true: /setup onboarding
 * (setup and planSetup) and /setup overrides (overrides, delegated to ChannelOverrides).
 */
import type { Actor } from "../domain/policy.js";
import { authorizeRoleManager } from "../domain/policy.js";
import { Failure, normalized, note } from "../domain/values.js";
import { audit, ensureUser, orm } from "../infrastructure/postgres/database.js";
import { and, eq, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import type { DiscordPort } from "./records.js";
import { enqueue, layoutGuildRoles, reconcileUser, secureGuildChannels } from "../jobs/queue.js";
import type { GuildAccess } from "./guild-access.js";
import { NEW_GUILD_ROW } from "./guild-defaults.js";
import { ChannelOverrides, type OverridesPort, type OverridesResult } from "./overrides.js";
import type { FcRef, OfficerOverrideResult, OfficerResetResult, SetupResult } from "./results.js";
import { fcLinked, type Service } from "./service.js";
import {
  addBlocker,
  blockerOf,
  collected,
  duplicateRoles,
  onboardingChanges,
  plannedAudiences,
  plannedBindings,
  roleAction,
  SAMPLE_CHANNELS,
  type SetupBlocker,
  type SetupPlan,
  type SetupRolePlan,
} from "./setup-plan.js";

/** Extra provisioning capability, separate from the reconciliation/test port. */
export interface RoleProvisioner extends DiscordPort {
  /** `hoist` is the guild's role-layout switch; a created role is displayed separately only when on. */
  ensureRole(
    guild: string,
    name: string,
    actor: string,
    configured: string | null,
    canonicalName: string,
    hoist: boolean,
  ): Promise<{ id: string; created: boolean }>;
}

/** The four access roles setup creates or reuses, in order, with their labels. */
const SETUP_ROLES = [
  ["member_role_id", "Member"],
  ["guest_role_id", "Guest"],
  ["officer_role_id", "Officer"],
  ["leader_role_id", "FC Leader"],
] as const;

/** Setup is serialized per guild; Discord resource creation precedes one configuration commit. */
export class RoleAdministration {
  /** /setup overrides' runs; absent when no port was given (tests of the other methods). */
  private readonly channelOverrides: ChannelOverrides | undefined;

  constructor(
    private readonly app: Service,
    private readonly discord: RoleProvisioner,
    private readonly access: GuildAccess,
    overrides?: OverridesPort,
  ) {
    this.channelOverrides = overrides ? new ChannelOverrides(app, overrides) : undefined;
  }

  /**
   * /setup overrides (2.35.0, #46): TaruBot's own channel entries, a dry run unless `confirm`
   * (src/application/overrides.ts).
   */
  overrides(actor: Actor, confirm: boolean): Promise<OverridesResult> {
    if (!this.channelOverrides) throw new Error("/setup overrides has no Discord port");
    return this.channelOverrides.run(actor, confirm);
  }

  /**
   * Stop a /setup overrides run in progress at shutdown and wait (about 5 s at most) for its
   * audit row. Never rejects.
   */
  async drain(): Promise<void> {
    await this.channelOverrides?.drain().catch(() => {});
  }

  /**
   * /setup onboarding's dry run (2.35.0, #46): what setup() would do with the same options, read
   * without writing (no role, channel, row, job or audit, and no lock). Every refusal setup() would
   * throw is listed as a blocker instead (src/application/setup-plan.ts), except those about the
   * person asking: the role-manager check, the caller half of the channel check, and bad option
   * values, which throw as they do in setup().
   */
  async planSetup(
    actor: Actor,
    prefix: string,
    fcId: string | null,
    officerRank: string | null,
    channels: { lobby: string | null; officers: string | null } = { lobby: null, officers: null },
  ): Promise<SetupPlan> {
    authorizeRoleManager(actor);
    prefix = prefix.trim();
    if (prefix.length > 50)
      throw new Failure("input", "The role prefix can be at most 50 characters.", 0, {
        kind: "option",
        option: "prefix",
      });
    if (officerRank !== null) officerRank = note(officerRank, "rank");
    const guildId = actor.guildId;
    const blockers: SetupBlocker[] = [];
    const [previous] = await this.app.db.orm
      .select()
      .from(t.guilds)
      .where(eq(t.guilds.id, guildId));
    if (fcId && previous?.fc_id && previous.fc_id !== fcId)
      addBlocker(blockers, blockerOf(fcLinked(previous.fc_id)));
    await this.access.discord.checkCaller(guildId, actor.userId);
    // setup() validates a kept review channel it is about to open.
    if (previous?.guest_application_channel_id && !previous.guest_applications_enabled) {
      const review = previous.guest_application_channel_id;
      await collected(blockers, () => this.discord.validateChannel(guildId, review));
    }
    const layout = previous?.role_layout_enabled ?? NEW_GUILD_ROW.role_layout_enabled;
    const targetFc = fcId ?? previous?.fc_id ?? null;
    let company: FcRef | null = null;
    if (fcId && fcId !== previous?.fc_id) {
      const read = await collected(blockers, () => this.app.lodestone.company(fcId));
      if (read) company = { id: read.id, name: read.name, tag: read.tag, world: read.world };
    } else company = await this.app.company(this.app.db.orm, targetFc);
    // The roles ensureRole would create or reuse, decided over one read-only role list.
    const candidates = await this.access.discord.roleCandidates(guildId);
    const roles: SetupRolePlan[] = [];
    for (const [field, label] of SETUP_ROLES) {
      const name = prefix ? `${prefix} ${label}` : label;
      const decided = await collected(blockers, () =>
        roleAction(candidates, name, label, previous?.[field] ?? null),
      );
      if (!decided) continue;
      roles.push({ field, name, ...decided });
      const id = decided.id;
      if (id) await collected(blockers, () => this.discord.validateRole(guildId, id, actor.userId));
    }
    const duplicate = duplicateRoles(roles);
    if (duplicate) addBlocker(blockers, blockerOf(duplicate));
    for (const selected of [channels.lobby, channels.officers])
      if (selected)
        await collected(blockers, () => this.discord.validateChannel(guildId, selected));
    // prepare() without creating anything; each refusal is its own blocker.
    const reused = (field: SetupRolePlan["field"]) =>
      roles.find((role) => role.field === field)?.id ?? undefined;
    const lobbyId = channels.lobby ?? previous?.lobby_channel_id ?? null;
    const officerId = channels.officers ?? previous?.officer_channel_id ?? null;
    const prepared = await this.access.discord.planPrepare(
      guildId,
      Object.fromEntries(
        (
          [
            ["member", reused("member_role_id")],
            ["guest", reused("guest_role_id")],
            ["officer", reused("officer_role_id")],
            ["leader", reused("leader_role_id")],
          ] as const
        ).filter((entry): entry is [(typeof entry)[0], string] => entry[1] !== undefined),
      ),
      lobbyId,
      officerId,
    );
    for (const blocker of prepared.blockers) addBlocker(blockers, blocker);
    // Onboarding's first pass: every existing managed channel whose overwrites it would change.
    let changing: readonly string[] | null = null;
    let everyoneLosesView: boolean | null = null;
    if (prepared.snapshot) {
      const audiences = plannedAudiences(
        prepared.snapshot,
        prepared.lobby.id,
        prepared.officerRoom.id,
        await this.access.policies(guildId),
        previous?.access_policy_enabled ?? false,
      );
      const changes = onboardingChanges(
        prepared.snapshot,
        plannedBindings(roles),
        audiences,
        guildId,
      );
      changing = changes.channels;
      everyoneLosesView = changes.everyoneLosesView;
    }
    // Adopting an existing staff role preserves its human holders as manual grants.
    const officerRole = roles.find((role) => role.field === "officer_role_id");
    let adopt: number | null = null;
    if (officerRole?.id && previous?.officer_role_id !== officerRole.id) {
      const holder = officerRole.id;
      const members = await collected(blockers, () => this.discord.members(guildId));
      if (members)
        adopt = members.filter((member) => !member.bot && member.roles.includes(holder)).length;
    } else if (officerRole) adopt = 0;
    const notifications = previous?.officer_notifications_channel_id ?? null;
    return {
      roles,
      lobby: prepared.lobby,
      officerRoom: prepared.officerRoom,
      onboarding: {
        alreadyOn: previous?.access_policy_enabled ?? false,
        channels: changing === null ? null : changing.length,
        sample: (changing ?? []).slice(0, SAMPLE_CHANNELS),
        everyoneLosesView,
      },
      guestApplications: {
        switchesOn: !(previous?.guest_applications_enabled ?? false),
        channel: previous?.guest_application_channel_id ?? null,
      },
      officerNotifications: {
        channel: notifications ?? prepared.officerRoom.id,
        defaulted: notifications === null,
      },
      adopt,
      fc: { id: targetFc, company },
      officerRank: officerRank ?? previous?.officer_rank_name ?? null,
      roleLayout: layout,
      blockers,
      effectsMode: this.app.effectsMode(previous ?? NEW_GUILD_ROW),
    };
  }

  /** Create/reuse four ordinary roles, optionally link an FC and select its officer rank. */
  async setup(
    actor: Actor,
    prefix: string,
    fcId: string | null,
    officerRank: string | null,
    channels: { lobby: string | null; officers: string | null } = { lobby: null, officers: null },
  ): Promise<SetupResult> {
    authorizeRoleManager(actor);
    prefix = prefix.trim();
    if (prefix.length > 50)
      throw new Failure("input", "The role prefix can be at most 50 characters.", 0, {
        kind: "option",
        option: "prefix",
      });
    if (officerRank !== null) officerRank = note(officerRank, "rank");
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`setup:${actor.guildId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked)
        throw new Failure(
          "busy",
          "Another /setup for this server is in progress. Try again in a few seconds.",
        );
      const [previous] = await this.app.db.orm
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId));
      if (fcId && previous?.fc_id && previous.fc_id !== fcId) throw fcLinked(previous.fc_id);
      await this.access.discord.check(actor.guildId, actor.userId);
      // /setup switches guest applications on. Like /config guest_applications enabled:true, it
      // first validates a kept review channel it is about to open: an import stores the legacy
      // channel unvalidated with the switch off. The revision check below catches a concurrent
      // change to it.
      if (previous?.guest_application_channel_id && !previous.guest_applications_enabled)
        await this.discord.validateChannel(actor.guildId, previous.guest_application_channel_id);
      // Setup never changes the role-layout switch. An existing guild keeps its value (an imported
      // guild stays off); a guild first created here starts with it off (NEW_GUILD_ROW, CFG-07 since
      // 2.35.0), so its created roles aren't hoisted. A concurrent /config role_layout bumps the
      // revision, so the check below turns it into a conflict.
      const layout = previous?.role_layout_enabled ?? NEW_GUILD_ROW.role_layout_enabled;
      const company =
        fcId && fcId !== previous?.fc_id ? await this.app.lodestone.company(fcId) : null;
      const specifications = [
        ["member_role_id", "Member"],
        ["guest_role_id", "Guest"],
        ["officer_role_id", "Officer"],
        ["leader_role_id", "FC Leader"],
      ] as const;
      const roles: {
        field: (typeof specifications)[number][0];
        name: string;
        id: string;
        created: boolean;
      }[] = [];
      for (const [field, label] of specifications) {
        const name = prefix ? `${prefix} ${label}` : label;
        roles.push({
          field,
          name,
          ...(await this.discord.ensureRole(
            actor.guildId,
            name,
            actor.userId,
            previous?.[field] ?? null,
            label,
            layout,
          )),
        });
      }
      if (new Set(roles.map((role) => role.id)).size !== 4)
        throw new Failure(
          "input",
          "Member, Guest, Officer and FC Leader must be four different roles.",
        );
      const [member, guest, staff, leader] = roles;
      if (!member || !guest || !staff || !leader)
        throw new Error("Incomplete setup role selection");
      for (const selected of [channels.lobby, channels.officers])
        if (selected) await this.discord.validateChannel(actor.guildId, selected);
      const prepared = await this.access.discord.prepare(
        actor.guildId,
        actor.userId,
        { member: member.id, guest: guest.id, officer: staff.id, leader: leader.id },
        channels.lobby ?? previous?.lobby_channel_id ?? null,
        channels.officers ?? previous?.officer_channel_id ?? null,
      );
      const officerRole = roles.find((role) => role.field === "officer_role_id");
      // Adopting an existing staff role is an explicit manager decision; preserve its human holders.
      const adopted =
        officerRole && !officerRole.created && previous?.officer_role_id !== officerRole.id
          ? (await this.discord.members(actor.guildId)).filter(
              (member) => !member.bot && member.roles.includes(officerRole.id),
            )
          : [];
      return await this.app.db.transaction(async (client) => {
        const db = orm(client);
        if (company) await this.app.storeCompany(client, company);
        // A server first created here starts with effects on and the role layout off (CFG-07,
        // 2.35.0): NEW_GUILD_ROW is shared with /config's inserts.
        await db
          .insert(t.guilds)
          .values({ id: actor.guildId, ...NEW_GUILD_ROW })
          .onConflictDoNothing();
        const [current] = await db
          .select()
          .from(t.guilds)
          .where(eq(t.guilds.id, actor.guildId))
          .for("update");
        if (
          !current ||
          (previous && current.revision !== previous.revision) ||
          (!previous && current.revision !== 1n)
        )
          throw new Failure(
            "conflict",
            "Server settings changed during setup, so nothing was saved. Run /setup onboarding confirm:true again; anything already created is reused.",
          );
        const targetFc = fcId ?? current.fc_id;
        for (const role of roles) {
          const old = current[role.field];
          if (old && old !== role.id)
            await db
              .insert(t.retiredRoles)
              .values({ guild_id: actor.guildId, role_id: old, revision: current.revision })
              .onConflictDoNothing();
          await db
            .delete(t.retiredRoles)
            .where(
              and(eq(t.retiredRoles.guild_id, actor.guildId), eq(t.retiredRoles.role_id, role.id)),
            );
        }
        await db
          .update(t.guilds)
          .set({
            fc_id: targetFc,
            member_role_id: member.id,
            guest_role_id: guest.id,
            officer_role_id: staff.id,
            leader_role_id: leader.id,
            officer_rank_name: officerRank ?? t.guilds.officer_rank_name,
            officer_rank_key: officerRank ? normalized(officerRank) : t.guilds.officer_rank_key,
            lobby_channel_id: prepared.lobby.id,
            officer_channel_id: prepared.officers.id,
            access_policy_enabled: true,
            access_everyone_before:
              current.access_everyone_before ?? prepared.snapshot.everyonePermissions,
            officer_notifications_channel_id:
              current.officer_notifications_channel_id ?? prepared.officers.id,
            guest_application_channel_id:
              current.guest_application_channel_id ?? prepared.officers.id,
            // /setup opens /apply (site/src/content/docs/admin/setup.md): the switch goes on
            // with the review channel.
            guest_applications_enabled: true,
            revision: sql`${t.guilds.revision}+1`,
            active: true,
          })
          .where(eq(t.guilds.id, actor.guildId));
        await this.access.remember(
          client,
          actor.guildId,
          prepared.snapshot,
          prepared.lobby.id,
          prepared.officers.id,
          previous?.access_policy_enabled ?? false,
        );
        for (const member of adopted) {
          await ensureUser(client, actor.guildId, member.id, member.joinedAt);
          await db
            .insert(t.officerOverrides)
            .values({
              guild_id: actor.guildId,
              user_id: member.id,
              state: "granted",
              actor_id: actor.userId,
              reason: "Existing Officer role adopted by setup",
            })
            .onConflictDoNothing();
          await audit(client, actor.guildId, actor.userId, "officer.adopt", member.id, {
            roleId: officerRole?.id,
          });
        }
        if (targetFc) {
          await db
            .insert(t.ledgerAccounts)
            .values({ guild_id: actor.guildId, fc_id: targetFc })
            .onConflictDoNothing();
          await enqueue(client, "roster", `roster:${targetFc}`, { fcId: targetFc });
        }
        await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
        // Presentation is opt-in per guild; with the switch off no hoist/position work is queued.
        const layoutJob = current.role_layout_enabled
          ? await layoutGuildRoles(client, actor.guildId)
          : null;
        const accessJob = await secureGuildChannels(client, actor.guildId);
        await audit(client, actor.guildId, actor.userId, "setup", actor.guildId, {
          roles,
          fcId: targetFc,
          officerRank,
          lobby: prepared.lobby,
          officers: prepared.officers,
        });
        return {
          status: "configured",
          roles,
          fcId: targetFc,
          company: await this.app.company(db, targetFc),
          officerRank: officerRank ?? current.officer_rank_name,
          effects: "queued",
          effectsMode: this.app.effectsMode(current),
          roleLayout: current.role_layout_enabled
            ? "FC Leader > Officer > Member > Guest; consecutive block; display separately"
            : "disabled: role display and order are left unchanged; enable with /config role_layout enabled:true",
          roleLayoutEnabled: current.role_layout_enabled,
          layoutJob,
          lobby: prepared.lobby,
          officerChannel: prepared.officers,
          accessPolicy: "queued",
          accessJob,
          adopted: adopted.length,
          // /setup fills these two settings with the officer room only when they were unset.
          officerNotifications: {
            id: current.officer_notifications_channel_id ?? prepared.officers.id,
            defaulted: current.officer_notifications_channel_id === null,
          },
          guestApplications: {
            id: current.guest_application_channel_id ?? prepared.officers.id,
            defaulted: current.guest_application_channel_id === null,
          },
          ledgerChannelId: current.ledger_channel_id,
          instructions:
            "Channel enforcement is queued; inspect /sync status until secured. Configure a ledger channel if needed, then run /config validate.",
        };
      });
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${actor.guildId}`])
          .catch(() => {});
      connection.release();
    }
  }

  /**
   * A durable revoke overrides rank automation until a manager explicitly grants again.
   *
   * An override may be recorded before any Officer role is bound. The production cutover (W15)
   * records the owner-approved exceptions first and only then binds the legacy role with
   * adopt_holders:false, whose repair pass would otherwise strip the role from every exception
   * until its grant arrived. Without a bound role the override confers nothing yet: officer
   * authority needs the bound role (Service.enrichActor), and reconciliation skips an unbound role.
   */
  async officer(
    actor: Actor,
    user: string,
    grant: boolean,
    reason: string,
  ): Promise<OfficerOverrideResult> {
    authorizeRoleManager(actor);
    reason = note(reason, "reason");
    const guild = await this.app.guild(actor);
    // The bound role must still be one this manager and the bot may assign.
    if (guild.officer_role_id)
      await this.discord.validateRole(
        guild.id,
        guild.officer_role_id,
        actor.userId,
        grant && guild.access_policy_enabled,
      );
    const member = await this.discord.member(guild.id, user);
    // Revoking a departed user is allowed (it applies if they rejoin); granting needs a member.
    if (member?.bot || (grant && !member))
      throw new Failure(
        "not_found",
        "That user isn't a current member of this server, or is a bot.",
        0,
        { kind: "resource", resource: "member", id: user },
      );
    return this.app.db.transaction(async (client) => {
      await ensureUser(client, guild.id, user, member?.joinedAt);
      const db = orm(client);
      const [previous] = await db
        .select({ state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(and(eq(t.officerOverrides.guild_id, guild.id), eq(t.officerOverrides.user_id, user)))
        .for("update");
      const data = { state: grant ? "granted" : "revoked", actor_id: actor.userId, reason };
      await db
        .insert(t.officerOverrides)
        .values({ guild_id: guild.id, user_id: user, ...data })
        .onConflictDoUpdate({
          target: [t.officerOverrides.guild_id, t.officerOverrides.user_id],
          set: { ...data, changed_at: sql`now()` },
        });
      await audit(
        client,
        guild.id,
        actor.userId,
        grant ? "officer.grant" : "officer.revoke",
        user,
        { reason },
      );
      await reconcileUser(client, guild.id, user);
      // "recorded": nothing to apply until /config roles officer binds a role (its pass applies it).
      return {
        status: grant ? "granted" : "revoked",
        effects: guild.officer_role_id ? "queued" : "recorded",
        effectsMode: this.app.effectsMode(guild),
        user,
        reason,
        present: member !== null,
        previous:
          previous?.state === "granted" || previous?.state === "revoked" ? previous.state : null,
      };
    });
  }
  /**
   * /officer reset (owner decision, 2026-09-24): remove the member's grant or revoke override, so
   * the in-game rank decides again ("a third option that removes any override and goes back to
   * membership/rank logic"). Like a revoke, it needs a server manager and works for someone who
   * left. With no override it changes nothing and audits nothing.
   */
  async officerReset(actor: Actor, user: string, reason: string): Promise<OfficerResetResult> {
    authorizeRoleManager(actor);
    reason = note(reason, "reason");
    const guild = await this.app.guild(actor);
    // Like grant and revoke: the bound role must still be one this manager and the bot may assign,
    // since removing a revoke can give the Officer role and removing a grant can take it away.
    // Channel access is checked as for a revoke; reconciliation revalidates any role it adds.
    if (guild.officer_role_id)
      await this.discord.validateRole(guild.id, guild.officer_role_id, actor.userId, false);
    const member = await this.discord.member(guild.id, user);
    if (member?.bot)
      throw new Failure(
        "not_found",
        "That user isn't a current member of this server, or is a bot.",
        0,
        { kind: "resource", resource: "member", id: user },
      );
    return this.app.db.transaction(async (client) => {
      await ensureUser(client, guild.id, user, member?.joinedAt);
      const db = orm(client);
      const scope = and(
        eq(t.officerOverrides.guild_id, guild.id),
        eq(t.officerOverrides.user_id, user),
      );
      const [previous] = await db
        .select({ state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(scope)
        .for("update");
      const state =
        previous?.state === "granted" || previous?.state === "revoked" ? previous.state : null;
      const common = {
        effectsMode: this.app.effectsMode(guild),
        user,
        reason,
        present: member !== null,
        previous: state,
        rankConfigured: guild.officer_rank_key !== null,
      } as const;
      if (!state) return { ...common, status: "unchanged", effects: "unchanged" };
      await db.delete(t.officerOverrides).where(scope);
      await audit(client, guild.id, actor.userId, "officer.reset", user, {
        reason,
        previous: state,
      });
      await reconcileUser(client, guild.id, user);
      return {
        ...common,
        status: "reset",
        effects: guild.officer_role_id ? "queued" : "recorded",
      };
    });
  }
}
