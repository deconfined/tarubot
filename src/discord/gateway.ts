/** Discord.js adapter: current permission checks, complete observations, and scoped effects. */
import { createHash } from "node:crypto";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  GatewayIntentBits,
  GatewayRateLimitError,
  OverwriteType,
  PermissionFlagsBits,
} from "discord.js";
import type { Collection, Guild, GuildMember, Role } from "discord.js";
import { permissionKeys, permissionLabel, POSTING_PERMISSIONS } from "../domain/permissions.js";
import { Failure, normalized } from "../domain/values.js";
import type { VisibilityGuild } from "../domain/visibility.js";
import type { Actor, ActorResolution } from "../domain/policy.js";
import type {
  ApplicationRecord,
  DirectMessage,
  DiscordPort,
  MemberView,
  PostMessage,
  SelfRoleReason,
  SelfRoleWrite,
} from "../application/records.js";
import { roleLayoutPlan, rolePositionChanges, type RoleLayoutPlan } from "../domain/role-layout.js";
import { existingRoleId } from "../domain/role-selection.js";
import { NO_MANAGE_ROLES } from "../domain/self-roles.js";
import { cachedAsHidden, MISSING_ACCESS, UNKNOWN_CHANNEL } from "./obfuscation.js";
import { changelogPost } from "./presenters/changelog.js";
import { decisionDm, guestReviewPost } from "./presenters/guests.js";
import { ledgerPost } from "./presenters/ledger.js";
import { statusPost } from "./presenters/officer.js";
import type { Presented } from "./presenters/reply.js";
import { readVisibility } from "./visibility.js";

/**
 * Lowest role first. Discord can give new roles identical raw positions; the SDK comparison
 * resolves those ties by ID, matching the effective order Discord displays. Shared by the layout
 * pass, its readback and the read-only planner so all three see one order.
 */
function ascendingRoles(roles: Collection<string, Role>): Role[] {
  return [...roles.values()].sort((left, right) => left.comparePositionTo(right));
}

/** Exposes a reusable Discord client plus application-owned projections of SDK state. */
export class DiscordGateway implements DiscordPort {
  // Exactly Guilds and GuildMembers. The message intents (GuildMessages, MessageContent,
  // DirectMessages) are banned permanently, and tests/unit/intents.test.ts pins the set; enable
  // privileged ones in the portal.
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [] },
    rest: { timeout: 15000, retries: 3 },
  });
  /**
   * Copy mutable SDK state into the small snapshot consumed by application policy. view() serves
   * the actor, command targets and guild-wide reads alike, so a missing join time names the
   * member it concerns (the text also reaches job diagnostics) instead of saying "your".
   */
  private view(member: GuildMember): MemberView {
    if (!member.joinedAt)
      throw new Failure(
        "incomplete",
        `Discord didn't include join details for <@${member.id}>. Try again in a moment.`,
        0,
        { kind: "discord", what: "join_context", user: member.id },
      );
    return {
      id: member.id,
      guildId: member.guild.id,
      joinedAt: member.joinedAt,
      nickname: member.nickname,
      roles: [...member.roles.cache.keys()],
      bot: member.user.bot,
      owner: member.guild.ownerId === member.id,
    };
  }
  /**
   * The current actor. `full` (the default, and every command's) refreshes the guild and its role
   * definitions so cached permissions cannot authorize a new action; `light` (web GETs and sign-in
   * admission, ActorResolution) reads them from the gateway cache, which the Guilds intent keeps
   * current, and falls back to `full` for a guild that isn't cached and available. Both force-fetch
   * the member, so a departure, a new role or a time-out is never read from a cache.
   *
   * `botAdministrator` reads TaruBot's own cached member (the GuildMembers intent keeps its roles
   * current) against the role definitions just used; a missing member counts as holding
   * Administrator, so the web's A2 gate fails closed.
   */
  async actor(guildId: string, userId: string, mode: ActorResolution = "full"): Promise<Actor> {
    const cached = mode === "light" ? this.client.guilds.cache.get(guildId) : undefined;
    let guild: Guild;
    if (cached?.available) guild = cached;
    else {
      guild = await this.client.guilds.fetch({ guild: guildId, force: true });
      await guild.roles.fetch();
    }
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member.user.bot)
      throw new Failure(
        "forbidden",
        "TaruBot commands work only inside the server, for human members.",
        0,
        { kind: "scope", scope: "human" },
      );
    const me = guild.members.me;
    return {
      guildId,
      userId,
      officer: member.permissions.has(PermissionFlagsBits.ManageGuild),
      manageRoles: member.permissions.has(PermissionFlagsBits.ManageRoles),
      serverManager: member.permissions.has(PermissionFlagsBits.ManageGuild),
      roleIds: [...member.roles.cache.keys()],
      botAdministrator: me ? me.permissions.has(PermissionFlagsBits.Administrator) : true,
      timedOut: member.isCommunicationDisabled(),
    };
  }
  /** Only explicit unknown-member/user responses mean departure; network failures propagate. */
  async member(guildId: string, userId: string): Promise<MemberView | null> {
    const guild = await this.client.guilds.fetch(guildId);
    try {
      return this.view(await guild.members.fetch({ user: userId, force: true }));
    } catch (error) {
      if (error instanceof DiscordAPIError && [10007, 10013].includes(Number(error.code)))
        return null;
      throw error;
    }
  }
  /** Require complete, count-consistent enumeration before snapshot or guild-wide reconciliation. */
  async members(guildId: string): Promise<MemberView[]> {
    const guild = await this.client.guilds.fetch(guildId);
    // Every way the full list can't be read is the member-list failure, with its approved card.
    const listFailure = (retryAfter = 0) =>
      new Failure(
        "incomplete",
        "Discord didn't return the complete member list. Try again in a minute.",
        retryAfter,
        { kind: "discord", what: "member_list" },
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = guild.memberCount;
      let members: Collection<string, GuildMember>;
      try {
        members = await guild.members.fetch({ time: 60000 });
      } catch (error) {
        // Discord allows one full member-list request per guild every 30 seconds (RATE_LIMITED),
        // and chunks can stop arriving (GuildMembersTimeout); both mean the list couldn't be
        // read. Retrying inside this loop would only be rate limited again, so stop here.
        if (error instanceof GatewayRateLimitError)
          throw listFailure(Math.ceil(error.data.retry_after));
        if (
          error instanceof DiscordjsError &&
          error.code === DiscordjsErrorCodes.GuildMembersTimeout
        )
          throw listFailure();
        throw error;
      }
      if (members.size === count && count === guild.memberCount) {
        // A member without a join time makes the whole list unusable for a guild-wide read, so
        // it is reported as the member-list failure (keeping that card's adopt_holders tip).
        if (members.some((member) => !member.joinedAt))
          throw new Failure(
            "incomplete",
            "Discord didn't include join details for every member. Try again later.",
            0,
            { kind: "discord", what: "member_list" },
          );
        return [...members.values()].map((member) => this.view(member));
      }
    }
    throw listFailure();
  }
  /**
   * Access roles must be assignable, nonadministrative, and below the applicable hierarchies.
   * Every refusal names the role in its detail, so replies and job diagnostics can point at it.
   */
  async validateRole(
    guildId: string,
    roleId: string,
    actorId?: string,
    channelAccess = false,
  ): Promise<void> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    const role = (await guild.roles.fetch()).get(roleId);
    const bot = await guild.members.fetchMe({ force: true });
    const affected = { kind: "resource", resource: "role", id: roleId } as const;
    // A configured role deleted from Discord (or one from another server) can't be fixed by
    // changing its permissions: say so, so /config validate and job diagnostics point at the cause.
    if (!role || role.guild.id !== guildId)
      throw new Failure(
        "blocked",
        "That role no longer exists in this server. Choose another with /config roles, or run /setup onboarding to recreate it.",
        0,
        affected,
      );
    if (role.id === guild.id || role.managed || bot.roles.botRole?.id === role.id)
      throw new Failure(
        "blocked",
        "Pick an ordinary role: not @everyone, not a bot or integration role, and not TaruBot's own role.",
        0,
        affected,
      );
    if (
      role.permissions.has(PermissionFlagsBits.Administrator, false) ||
      role.permissions.has(PermissionFlagsBits.ManageGuild, false) ||
      role.permissions.has(PermissionFlagsBits.ManageRoles, false)
    )
      throw new Failure(
        "blocked",
        `Access roles can't have Administrator, Manage Server or Manage Roles. Remove those from <@&${roleId}> or pick another role.`,
        0,
        affected,
      );
    if (channelAccess && role.permissions.has(PermissionFlagsBits.ManageChannels, false))
      throw new Failure(
        "blocked",
        "With onboarding on, access roles can't have Manage Channels.",
        0,
        affected,
      );
    if (
      !bot.permissions.has(PermissionFlagsBits.ManageRoles) ||
      bot.roles.highest.comparePositionTo(role) <= 0
    )
      throw new Failure(
        "blocked",
        `TaruBot can't manage <@&${roleId}>. Its own role must be above that role, and it needs Manage Roles.`,
        0,
        { ...affected, fix: "hierarchy" },
      );
    if (actorId) {
      const actor = await guild.members.fetch({ user: actorId, force: true });
      if (!actor.permissions.has(PermissionFlagsBits.ManageRoles))
        throw new Failure(
          "forbidden",
          "Choosing access roles needs Discord's Manage Roles permission.",
          0,
          { kind: "scope", scope: "manage_roles" },
        );
      if (guild.ownerId !== actorId && actor.roles.highest.comparePositionTo(role) <= 0)
        throw new Failure(
          "forbidden",
          `Your highest Discord role must be above <@&${roleId}> to select it (the server owner is exempt). Ask someone higher in the role list, or move the role lower.`,
          0,
          { kind: "scope", scope: "hierarchy" },
        );
    }
  }
  /**
   * Setup adopts a configured/exact-name role or creates a zero-permission role below the bot.
   * `hoist` is the guild's role-layout switch: created roles follow it, so with layout off Discord's
   * default (not displayed separately) is kept. Adopted existing roles are never re-hoisted here.
   */
  async ensureRole(
    guildId: string,
    name: string,
    actorId: string,
    configured: string | null,
    canonicalName: string,
    hoist: boolean,
  ): Promise<{ id: string; created: boolean }> {
    const guild = await this.client.guilds.fetch(guildId);
    const roles = await guild.roles.fetch();
    const existing = existingRoleId([...roles.values()], name, canonicalName, configured);
    let role = existing ? roles.get(existing) : undefined;
    let created = false;
    if (!role) {
      role = await guild.roles.create({
        name,
        permissions: 0n,
        hoist,
        reason: `TaruBot setup requested by ${actorId}`,
      });
      created = true;
    }
    await this.validateRole(guildId, role.id, actorId);
    // Adopt the requested prefix without replacing the existing ID, permissions, or holders.
    if (role.name !== name && normalized(role.name) === normalized(canonicalName))
      await role.setName(name, `TaruBot setup role reuse requested by ${actorId}`);
    return { id: role.id, created };
  }
  /** Keep managed role headings visible and ordered while preserving unrelated hierarchy slots. */
  async layoutRoles(
    guildId: string,
    priority: readonly string[],
    guard: () => Promise<void>,
  ): Promise<unknown> {
    if (!priority.length) return { order: [], hoisted: [], positions: [] };
    const guild = await this.client.guilds.fetch(guildId);
    for (const roleId of priority) await this.validateRole(guildId, roleId);
    let roles = await guild.roles.fetch();
    const hoisted: string[] = [];
    for (const roleId of priority) {
      const role = roles.get(roleId);
      if (!role)
        throw new Failure("blocked", "A configured role was deleted before layout.", 0, {
          kind: "resource",
          resource: "role",
          id: roleId,
        });
      if (!role.hoist) {
        await guard();
        await role.setHoist(true, "TaruBot managed-role member-list grouping");
        hoisted.push(roleId);
      }
    }
    roles = await guild.roles.fetch();
    const ascending = ascendingRoles(roles).map((role) => role.id);
    const positions = rolePositionChanges(ascending, priority);
    if (positions.length) {
      await guard();
      await guild.roles.setPositions(positions);
    }
    const verified = await guild.roles.fetch();
    const actual = ascendingRoles(verified).map((role) => role.id);
    const expected = positions.length ? positions.map((entry) => entry.role) : ascending;
    if (
      actual.join(":") !== expected.join(":") ||
      rolePositionChanges(actual, priority).length > 0 ||
      priority.some((role) => !verified.get(role)?.hoist)
    ) {
      throw new Failure(
        "transient",
        "Discord role layout changed while it was being applied; retrying current policy.",
      );
    }
    return { order: [...priority], hoisted, positions };
  }
  /**
   * Read-only counterpart of layoutRoles for the cutover preview: the same per-role checks (so a
   * blocked pass reports the same diagnostic), one role fetch and the same ordering, then the plan
   * of hoist and position writes a pass would make. It never writes, and it is deliberately not on
   * DiscordPort, so reconciliation fakes need no planner.
   */
  async planRoleLayout(guildId: string, priority: readonly string[]): Promise<RoleLayoutPlan> {
    if (!priority.length) return roleLayoutPlan([], priority);
    const guild = await this.client.guilds.fetch(guildId);
    for (const roleId of priority) await this.validateRole(guildId, roleId);
    const ascending = ascendingRoles(await guild.roles.fetch()).map((role) => ({
      id: role.id,
      name: role.name,
      hoist: role.hoist,
    }));
    return roleLayoutPlan(ascending, priority);
  }
  /**
   * Fetch the channel globally, then explicitly check guild ownership and current overwrites. A
   * deleted, non-text or other-server channel is refused as unavailable, with no permissions
   * remedy; a channel TaruBot can't use (or, 50001 Missing Access, can't even view) gets the
   * permissions refusal with its channel-permissions fix. Discord doesn't document its answer for
   * a hidden channel from 2026-11-16 (#47), so a 10003 for a text channel the gateway still holds
   * as hidden from TaruBot gets the permissions refusal too. When TaruBot's own member entry in
   * the channel denies a posting permission it lacks (the deny mask /setup overrides writes where
   * no setting named the channel, 2.35.0), it gets the member-entry refusal instead: a member
   * entry's deny beats any role allow, so the role fix can't work there.
   */
  async validateChannel(guildId: string, channelId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.roles.fetch();
    // Fetched before the channel so a 10003 can be read against the cached entry's permissions.
    const bot = await guild.members.fetchMe({ force: true });
    const affected = { kind: "resource", resource: "channel", id: channelId } as const;
    // Its wording ('View Channel') is also what ledger post states read as "missing channel
    // permissions".
    const permissionsRefusal = () =>
      new Failure(
        "blocked",
        `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${channelId}>, and it must be a text channel in this server.`,
        0,
        { ...affected, fix: "channel_permissions" },
      );
    const channel = await this.client.channels
      .fetch(channelId, { force: true })
      .catch((error: unknown) => {
        if (!(error instanceof DiscordAPIError)) throw error;
        const cached = guild.channels.cache.get(channelId);
        // 10003 Unknown Channel: normally the channel was deleted, so no permission change can fix
        // it. But a text channel the gateway still holds obfuscated, or whose cached overwrites
        // deny TaruBot View Channel (a channel option clears the flag but keeps the synthetic
        // deny), may be Discord hiding it from 2026-11-16: that is a permissions problem. A stale
        // entry TaruBot could view, or none, is a deleted channel and unavailable.
        if (Number(error.code) === UNKNOWN_CHANNEL) {
          if (cached?.type === ChannelType.GuildText && cachedAsHidden(cached, bot))
            throw permissionsRefusal();
          return null;
        }
        // 50001 Missing Access: Discord hides a channel TaruBot can't view. A text channel this
        // server still lists (the guild's channel cache holds hidden channels too) is a
        // permissions problem with a remedy; anything else, such as another server's channel, is
        // unavailable.
        if (Number(error.code) === MISSING_ACCESS) {
          if (cached?.type === ChannelType.GuildText) throw permissionsRefusal();
          return null;
        }
        throw error;
      });
    // A deleted channel, a non-text channel or one in another server can't be fixed by changing
    // permissions, so this refusal carries no permissions remedy. Its wording ('unavailable')
    // is also what ledger post states read to say "channel unavailable".
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId)
      throw new Failure(
        "blocked",
        `<#${channelId}> is unavailable: it no longer exists or isn't a text channel in this server. Choose another with /config.`,
        0,
        affected,
      );
    const permissions = channel.permissionsFor(bot);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    ) {
      // Which posting bits TaruBot lacks there that its own member entry (never its role's)
      // denies; with Administrator permissionsFor already answered everything, so it never
      // reaches here.
      const posting = Object.values(POSTING_PERMISSIONS).reduce((all, bit) => all | bit, 0n);
      const lacking = posting & ~(permissions?.bitfield ?? 0n);
      const own = channel.permissionOverwrites.cache.get(bot.id);
      const denied = own?.type === OverwriteType.Member ? own.deny.bitfield & lacking : 0n;
      if (denied !== 0n) {
        const names = permissionKeys(denied, POSTING_PERMISSIONS).map((key) =>
          permissionLabel(key, "channel"),
        );
        const labels =
          names.length <= 1
            ? names.join("")
            : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        // The channel, the denied bits and where the deny sits come first, so a stored diagnostic cut
        // at 150 characters keeps them. It keeps 'View Channel', which ledger post states read as
        // "missing channel permissions".
        throw new Failure(
          "blocked",
          `TaruBot's member entry in <#${channelId}> denies ${labels}; remove that deny (on the member, not its role). TaruBot needs View Channel, Send Messages, Embed Links and Read Message History there. Or turn Administrator on for TaruBot, set the channel in /config, and run /setup overrides confirm:true, then remove Administrator once /config validate says it is no longer needed.`,
          0,
          { ...affected, fix: "member_entry" },
        );
      }
      throw permissionsRefusal();
    }
  }
  /** REST deltas touch only requested role IDs; retry observes any partially applied transition. */
  async roles(guildId: string, userId: string, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch({ user: userId, force: true });
    await guild.roles.fetch();
    // Individual deltas preserve unrelated roles and make partial transitions retryable.
    for (const roleId of remove) {
      const role = await guild.roles.fetch(roleId);
      if (!role) continue;
      const bot = await guild.members.fetchMe();
      if (
        !bot.permissions.has(PermissionFlagsBits.ManageRoles) ||
        bot.roles.highest.comparePositionTo(role) <= 0
      )
        throw new Failure(
          "blocked",
          "A current or retired access role is above the bot's role.",
          0,
          { kind: "resource", resource: "role", id: roleId, fix: "hierarchy" },
        );
      await member.roles.remove(roleId, "TaruBot access reconciliation");
    }
    for (const roleId of add) {
      await this.validateRole(guildId, roleId);
      await member.roles.add(roleId, "TaruBot access reconciliation");
    }
  }
  /**
   * Self-service menu roles (2.40.0): one REST call per role through the member manager, so no
   * member fetch is needed and every other role is left alone; removes first, then adds. The
   * "chosen" caller (the roles.self job) checked each role against a fresh snapshot just before;
   * the "access" caller (reconciliation's removals for someone with no access role, owner decision
   * Q3 B) judged TaruBot's cached view, and only ever removes, which escalates nothing. Either way
   * there is no validateRole here (its messages name roles, and a member's choices must never
   * reach a diagnostic). A per-role refusal doesn't fail the write: 10011 Unknown Role (deleted
   * since the check) is skipped; 50013 Missing Permissions re-reads TaruBot's member (1 request),
   * and without Manage Roles the whole write waits as blocked with a role-free message (the
   * roles.self job's own check, NO_MANAGE_ROLES), otherwise the role moved above TaruBot and is
   * skipped. Only counts come back.
   */
  async selfRoles(
    guildId: string,
    userId: string,
    add: readonly string[],
    remove: readonly string[],
    reason: SelfRoleReason,
  ): Promise<SelfRoleWrite> {
    const written = { added: 0, removed: 0, skipped: 0 };
    if (!add.length && !remove.length) return written;
    const guild = await this.client.guilds.fetch(guildId);
    const why =
      reason === "chosen"
        ? "Chosen by the member on TaruBot's My roles page"
        : "TaruBot access reconciliation: no Member or Guest role, and this self-service role opens channels";
    /** One role's write: true when Discord applied it, false when it was skipped. */
    const write = async (roleId: string, adding: boolean): Promise<boolean> => {
      try {
        const options = { user: userId, role: roleId, reason: why };
        if (adding) await guild.members.addRole(options);
        else await guild.members.removeRole(options);
        return true;
      } catch (error) {
        if (!(error instanceof DiscordAPIError)) throw error;
        if (Number(error.code) === 10011) return false;
        if (Number(error.code) !== 50013) throw error;
        const bot = await guild.members.fetchMe({ force: true });
        if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
          throw new Failure("blocked", NO_MANAGE_ROLES);
        return false;
      }
    };
    for (const roleId of remove)
      if (await write(roleId, false)) written.removed++;
      else written.skipped++;
    for (const roleId of add)
      if (await write(roleId, true)) written.added++;
      else written.skipped++;
    return written;
  }
  /**
   * A member's roles from the gateway's member cache (no request), which GuildMemberUpdate keeps
   * current; null when the server or the member isn't cached.
   */
  cachedRoles(guildId: string, userId: string): readonly string[] | null {
    const member = this.client.guilds.cache.get(guildId)?.members.cache.get(userId);
    return member ? [...member.roles.cache.keys()] : null;
  }
  /** Recheck the expected nickname immediately before writing to respect intervening manual edits. */
  async nickname(
    guildId: string,
    userId: string,
    value: string | null,
    expected: string | null,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member.nickname !== expected) return false;
    if (!bot.permissions.has(PermissionFlagsBits.ManageNicknames) || !member.manageable)
      throw new Failure(
        "blocked",
        "Nickname update requires Manage Nicknames and a manageable member below the bot, excluding the guild owner.",
      );
    await member.setNickname(value, "TaruBot character nickname");
    return true;
  }
  /**
   * A presenter post's message options, mentions forced off. content is '' (which also clears a
   * pre-2.14.0 message's text on edit), with one embed and the post's buttons.
   */
  private static sendable(presented: Presented) {
    return { ...presented.options, allowedMentions: { parse: [] as [] } };
  }
  /**
   * Render a post from its data through the reply presenters, so jobs never build message text.
   * `text` is the documented plain-text exclusion (officer.notify, the DevBot smoke check): the
   * caller has escaped it, and it is cut to fit Discord's content limit.
   */
  private static render(message: PostMessage) {
    if (message.kind === "changelog") return DiscordGateway.sendable(changelogPost(message.view));
    if (message.kind === "ledger") return DiscordGateway.sendable(ledgerPost(message.view));
    if (message.kind === "review")
      return DiscordGateway.sendable(guestReviewPost(message.application));
    if (message.kind === "status") return DiscordGateway.sendable(statusPost(message.view));
    return {
      content: message.text.slice(0, 1950),
      allowedMentions: { parse: [] as [] },
      embeds: [],
      components: [],
    };
  }
  /** Use stable recent-message deduplication and explicit mention policy for outbox delivery. */
  async send(
    guildId: string,
    channelId: string,
    message: PostMessage,
    key: string,
  ): Promise<string> {
    await this.validateChannel(guildId, channelId);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText)
      throw new Failure("blocked", "Text channel unavailable.", 0, {
        kind: "resource",
        resource: "channel",
        id: channelId,
      });
    const nonce = BigInt(
      // A short decimal nonce fits Discord's limit while identifying the same durable effect.
      `0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`,
    ).toString();
    // Posts render deterministically from stored data, so a retry under this nonce is identical.
    return (await channel.send({ ...DiscordGateway.render(message), nonce, enforceNonce: true }))
      .id;
  }
  /**
   * Redraw the review message for the application's current state (the decision, disabled
   * controls), or recreate an explicitly missing one under the stable review:<id> nonce key. The
   * edit sends content '' so a pre-2.14.0 message's text is cleared in favour of the embed.
   */
  async editReview(application: ApplicationRecord): Promise<string> {
    await this.validateChannel(application.guild_id, application.channel_id);
    const channel = await this.client.channels.fetch(application.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText)
      throw new Failure("blocked", "Review channel unavailable.", 0, {
        kind: "resource",
        resource: "channel",
        id: application.channel_id,
      });
    if (application.message_id) {
      try {
        const message = await channel.messages.fetch(application.message_id);
        await message.edit(DiscordGateway.sendable(guestReviewPost(application)));
        return message.id;
      } catch (error) {
        if (!(error instanceof DiscordAPIError && Number(error.code) === 10008)) throw error;
      }
    }
    return this.send(
      application.guild_id,
      application.channel_id,
      { kind: "review", application },
      `review:${application.id}`,
    );
  }
  /**
   * TaruBot's view of the guild from the gateway caches, for /config validate, the officer alert
   * and /setup overrides (2.35.0, #46). It never lists channels over REST; see readVisibility.
   */
  visibility(guildId: string, fresh: boolean): Promise<VisibilityGuild | null> {
    return readVisibility(this.client, guildId, fresh);
  }
  /**
   * A disabled inbox is a terminal delivery result, never a rollback of the guest decision. The
   * DM names the server from the client cache (no extra request); without it the presenter says
   * 'the server where you applied'.
   */
  async dm(user: string, message: DirectMessage): Promise<void> {
    const serverName = this.client.guilds.cache.get(message.application.guild_id)?.name ?? null;
    const presented = decisionDm(message.application, {
      cooldownSeconds: message.cooldownSeconds,
      serverName,
    });
    try {
      await (await this.client.users.fetch(user)).send(DiscordGateway.sendable(presented));
    } catch (error) {
      if (error instanceof DiscordAPIError && Number(error.code) === 50007)
        throw new Failure("dm_blocked", "The recipient has disabled DMs.");
      throw error;
    }
  }
}
