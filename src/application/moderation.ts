/**
 * Per-person moderation (2.45.0, owner decision 3): pausing one person's use of one feature, for
 * example someone abusing /suggest, and lifting it again. A pause is deny-only and touches no
 * Discord role: it takes a held permission away from can() (policy.ts) for as long as it lasts,
 * and every enforcement site reports it as a pause (policy.ts's requireNotPaused), never as a
 * missing role. This file keeps the rules for who may set or lift one:
 *
 * - Setting and lifting need moderation.block; reading the lists needs moderation.view. A person
 *   always reads their own pauses (status), whatever they hold.
 * - Nobody pauses or lifts their own.
 * - Server managers (Manage Server and Manage Roles) can't be paused, and neither can a bot. A
 *   server manager may pause anyone else.
 * - An officer with moderation.block, who isn't a server manager, may pause only people holding
 *   no staff permission, only features that aren't manager-only (mod mail, owner decision Q6 B),
 *   and may change or lift only pauses an officer set, never a server manager's.
 * - The target is a current member, or someone TaruBot has already seen in the server (a former
 *   member): no row is made for an arbitrary user ID.
 * - A pause's reason goes to the paused person and to officers who can see pauses, and never to
 *   the audit table; the audit row names the features, the end and the batch.
 *
 * Writes are one transaction per action under a per-person advisory lock, so a change is a lift
 * plus a new pause that either both happen or neither does. They write nothing to Discord and
 * queue no job (resolving the target reads Discord first, outside the transaction). Times are the
 * database clock's, as they are when a pause is read.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { classifyFailure } from "../domain/failures.js";
import { isPauseDuration, PAUSE_DURATIONS, type PauseDuration } from "../domain/moderation.js";
import { type Actor, authorize, isStaff, requirePermission } from "../domain/policy.js";
import { isBlockable, MANAGER_ONLY_BLOCKS, type PermissionId } from "../domain/rbac.js";
import { Failure, note, stoppingRefusal } from "../domain/values.js";
import { audit, orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { ACTIVE_BLOCK } from "./blocks.js";
import type { Service } from "./service.js";

const b = t.memberBlocks;

/** When a pause ended, in SQL: its own end if it ran out, else when someone lifted it. */
const ENDED_AT = sql`CASE WHEN ${b.lifted_by} IS NULL THEN ${b.expires_at} ELSE ${b.lifted_at} END`;

/** The most recent ended pauses a list or a person's history shows. */
export const ENDED_LIMIT = 25;
/** The most active pauses the Moderation page lists. */
export const ACTIVE_LIMIT = 200;

/** One pause as a list shows it. */
export interface PauseView {
  readonly id: string;
  readonly userId: string;
  readonly permission: PermissionId;
  readonly reason: string;
  readonly createdAt: Date;
  /** When it ends, or null when it lasts until lifted. */
  readonly until: Date | null;
  /**
   * Who set it and at what level. Only for officers who can see pauses (moderation.view); never in
   * the paused person's own view (owner decision Q5 A).
   */
  readonly by?: { readonly userId: string; readonly level: "manager" | "moderator" };
  /** Set once it has ended: when, by whom (null: it ran out), and the lift reason (officers only). */
  readonly ended?: {
    readonly at: Date;
    readonly by: string | null;
    readonly reason: string | null;
  };
}

/** What `/moderate status` and a person's history show. */
export interface PauseStatus {
  readonly subject: string;
  /** The viewer is the subject: reasons shown, no issuers. */
  readonly self: boolean;
  readonly active: readonly PauseView[];
  /** The newest ended pauses (officer views only; a person's own view lists active ones). */
  readonly ended: readonly PauseView[];
}

/** What the Moderation page lists. */
export interface ModerationOverview {
  readonly active: readonly PauseView[];
  readonly ended: readonly PauseView[];
  /** More active pauses exist than the list shows. */
  readonly truncated: boolean;
}

export interface BlockResult {
  readonly target: string;
  readonly permissions: readonly PermissionId[];
  readonly duration: PauseDuration;
  /** When they end, on the database clock; null lasts until lifted. */
  readonly until: Date | null;
  /** The permissions that already had an active pause, replaced by this one. */
  readonly replaced: readonly PermissionId[];
  readonly batch: string;
}

export interface LiftResult {
  readonly target: string;
  readonly lifted: readonly PermissionId[];
  /** Asked for but not paused, so nothing changed. */
  readonly notPaused: readonly PermissionId[];
}

/** The refusal for a target the actor may not pause or whose pause they may not touch. */
const protectedTarget = (message: string): Failure =>
  new Failure("forbidden", message, 0, { kind: "scope", scope: "protected" });

const selfRefusal = (message: string): Failure =>
  new Failure("forbidden", message, 0, { kind: "scope", scope: "self" });

const unknownMember = (user: string): Failure =>
  new Failure("not_found", "That user isn't a current or former member of this server.", 0, {
    kind: "resource",
    resource: "member",
    id: user,
  });

/** Split a feature list into valid, unique, blockable ids; anything else is the person's mistake. */
function features(ids: readonly PermissionId[]): PermissionId[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0)
    throw new Failure("input", "Pick at least one feature.", 0, {
      kind: "option",
      option: "feature",
    });
  if (!unique.every(isBlockable))
    throw new Failure("input", "That feature can't be paused.", 0, {
      kind: "option",
      option: "feature",
    });
  return unique;
}

export class Moderation {
  constructor(
    // Private, like ModMail's: a page that declares only moderationKey reaches no other service.
    private readonly app: Service,
    /**
     * Resolves a person's access in a server as the actor would be (BotContext.resolveActor, full):
     * rejects with the usual Failure for a bot or for someone no longer in the server.
     */
    private readonly resolve: (guildId: string, userId: string) => Promise<Actor>,
    /** The lifecycle's shutdown flag: writes refuse once it is set, and roll back if set mid-write. */
    private readonly isStopping: () => boolean,
  ) {}

  /**
   * Who `target` is, to the extent a pause cares: a server manager and staff can't be paused by an
   * officer, a bot can't be paused at all, and someone who left holds nothing.
   */
  private async subject(guildId: string, target: string): Promise<Actor | null> {
    try {
      return await this.resolve(guildId, target);
    } catch (error) {
      const { category, detail } = classifyFailure(error);
      if (category === "forbidden" && detail?.kind === "scope") {
        if (detail.scope === "human") throw protectedTarget("Bots can't be paused.");
        if (detail.scope === "current_member") return null;
      }
      throw error;
    }
  }

  /** Close this person's pauses that ended on their own, so the open-pause index stays exact. */
  private async closeEnded(
    db: ReturnType<typeof orm>,
    guildId: string,
    userId: string,
  ): Promise<void> {
    await db
      .update(b)
      .set({ lifted_at: sql`now()`, lift_reason: "expired" })
      .where(
        and(
          eq(b.guild_id, guildId),
          eq(b.user_id, userId),
          sql`${b.lifted_at} IS NULL`,
          lte(b.expires_at, sql`now()`),
        ),
      );
  }

  /**
   * Pause `target`'s use of `permissions` for `duration`, with a reason the person is shown. One
   * transaction: it replaces any pause the person already has for the same feature (history keeps
   * both), unless a server manager set that one and the actor isn't one.
   */
  async block(
    actor: Actor,
    target: string,
    permissions: readonly PermissionId[],
    duration: PauseDuration,
    reason: string,
  ): Promise<BlockResult> {
    requirePermission(actor, actor.guildId, "moderation.block");
    if (this.isStopping()) throw stoppingRefusal();
    const ids = features(permissions);
    const text = note(reason, "reason");
    if (!isPauseDuration(duration))
      throw new Failure("input", "Pick one of the listed durations.", 0, {
        kind: "option",
        option: "duration",
      });
    if (target === actor.userId) throw selfRefusal("You can't pause yourself.");
    await this.app.guild(actor);
    const level = actor.access.manager ? "manager" : "moderator";
    if (level === "moderator" && ids.some((id) => MANAGER_ONLY_BLOCKS.has(id)))
      throw protectedTarget("Only a server manager can pause mod mail.");
    const subject = await this.subject(actor.guildId, target);
    if (subject?.access.manager) throw protectedTarget("Server managers can't be paused.");
    if (level === "moderator" && subject && isStaff(subject))
      throw protectedTarget("Only a server manager can pause someone with officer permissions.");
    // A current member not yet in guild_users needs their join date for a row; read it before the
    // transaction, since Discord requests never happen inside one.
    const member = subject ? await this.app.discord.member(actor.guildId, target) : null;
    const seconds = PAUSE_DURATIONS[duration].seconds;
    const batch = randomUUID();
    return this.app.db.transaction(async (client) => {
      if (this.isStopping()) throw stoppingRefusal();
      const db = orm(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `moderation:${actor.guildId}:${target}`,
      ]);
      await this.known(db, actor.guildId, target, member?.joinedAt ?? null);
      await this.closeEnded(db, actor.guildId, target);
      const replaced: PermissionId[] = [];
      let until: Date | null = null;
      for (const id of ids) {
        const [open] = await db
          .select({ id: b.id, level: b.issuer_level })
          .from(b)
          .where(
            and(
              eq(b.guild_id, actor.guildId),
              eq(b.user_id, target),
              eq(b.permission, id),
              ACTIVE_BLOCK,
            ),
          )
          .for("update");
        if (open) {
          if (level === "moderator" && open.level === "manager")
            throw protectedTarget(
              "A server manager paused that, so only a server manager can change it.",
            );
          await db
            .update(b)
            .set({
              lifted_at: sql`now()`,
              lifted_by: actor.userId,
              lift_reason: "Replaced by a new pause",
            })
            .where(eq(b.id, open.id));
          replaced.push(id);
        }
        const [row] = await db
          .insert(b)
          .values({
            batch_id: batch,
            guild_id: actor.guildId,
            user_id: target,
            permission: id,
            reason: text,
            issuer_level: level,
            actor_id: actor.userId,
            expires_at: seconds === null ? null : sql`now()+${seconds}*interval '1 second'`,
          })
          .returning({ until: b.expires_at });
        until = row?.until ?? null;
      }
      await audit(client, actor.guildId, actor.userId, "moderation.block", target, {
        permissions: ids,
        expiresAt: until?.toISOString() ?? null,
        batch,
      });
      if (this.isStopping()) throw stoppingRefusal();
      return { target, permissions: ids, duration, until, replaced, batch };
    });
  }

  /** Make sure TaruBot has a row for `user` here: present ones are untouched, unknown ones refused. */
  private async known(
    db: ReturnType<typeof orm>,
    guildId: string,
    user: string,
    joinedAt: Date | null,
  ): Promise<void> {
    const [row] = await db
      .select({ user_id: t.guildUsers.user_id })
      .from(t.guildUsers)
      .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, user)));
    if (row) return;
    // Never a former member we have never seen, and never a made-up user ID.
    if (!joinedAt) throw unknownMember(user);
    await db.insert(t.users).values({ id: user }).onConflictDoNothing();
    await db
      .insert(t.guildUsers)
      .values({ guild_id: guildId, user_id: user, present: true, joined_at: joinedAt })
      .onConflictDoNothing();
  }

  /** End `target`'s pauses on `permissions`, with a reason kept in the history. */
  async lift(
    actor: Actor,
    target: string,
    permissions: readonly PermissionId[],
    reason: string,
  ): Promise<LiftResult> {
    requirePermission(actor, actor.guildId, "moderation.block");
    if (this.isStopping()) throw stoppingRefusal();
    const ids = features(permissions);
    const text = note(reason, "reason");
    if (target === actor.userId) throw selfRefusal("You can't lift your own pause.");
    await this.app.guild(actor);
    const level = actor.access.manager ? "manager" : "moderator";
    return this.app.db.transaction(async (client) => {
      if (this.isStopping()) throw stoppingRefusal();
      const db = orm(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `moderation:${actor.guildId}:${target}`,
      ]);
      await this.closeEnded(db, actor.guildId, target);
      const lifted: PermissionId[] = [];
      const notPaused: PermissionId[] = [];
      for (const id of ids) {
        const [open] = await db
          .select({ id: b.id, level: b.issuer_level })
          .from(b)
          .where(
            and(
              eq(b.guild_id, actor.guildId),
              eq(b.user_id, target),
              eq(b.permission, id),
              ACTIVE_BLOCK,
            ),
          )
          .for("update");
        if (!open) {
          notPaused.push(id);
          continue;
        }
        if (level === "moderator" && open.level === "manager")
          throw protectedTarget(
            "A server manager paused that, so only a server manager can lift it.",
          );
        await db
          .update(b)
          .set({ lifted_at: sql`now()`, lifted_by: actor.userId, lift_reason: text })
          .where(eq(b.id, open.id));
        lifted.push(id);
      }
      if (lifted.length > 0)
        await audit(client, actor.guildId, actor.userId, "moderation.lift", target, {
          permissions: lifted,
        });
      if (this.isStopping()) throw stoppingRefusal();
      return { target, lifted, notPaused };
    });
  }

  /** The columns a view needs; `officer` adds who set it and the lift's reason. */
  private view(
    row: {
      id: string;
      userId: string;
      permission: string;
      reason: string;
      createdAt: Date;
      until: Date | null;
      level: "manager" | "moderator";
      actorId: string;
      liftedAt: Date | null;
      liftedBy: string | null;
      liftReason: string | null;
      over: boolean;
    },
    officer: boolean,
  ): PauseView | null {
    // A pause for an id this release doesn't know (a later release's) is not shown.
    if (!isBlockable(row.permission as PermissionId)) return null;
    // A person's lift ends it when they lifted it; a pause that ran out ended at its own end, even
    // when a later write only closed it (lift_reason 'expired', no lifter) days afterwards.
    const ended =
      row.liftedBy !== null ? row.liftedAt : row.liftedAt !== null || row.over ? row.until : null;
    return {
      id: row.id,
      userId: row.userId,
      permission: row.permission as PermissionId,
      reason: row.reason,
      createdAt: row.createdAt,
      until: row.until,
      ...(officer && { by: { userId: row.actorId, level: row.level } }),
      ...(ended && {
        ended: {
          at: ended,
          by: row.liftedBy,
          reason: officer && row.liftedBy !== null ? row.liftReason : null,
        },
      }),
    };
  }

  private readonly columns = {
    id: b.id,
    userId: b.user_id,
    permission: b.permission,
    reason: b.reason,
    createdAt: b.created_at,
    until: b.expires_at,
    level: b.issuer_level,
    actorId: b.actor_id,
    liftedAt: b.lifted_at,
    liftedBy: b.lifted_by,
    liftReason: b.lift_reason,
    over: sql<boolean>`${b.expires_at} IS NOT NULL AND ${b.expires_at} <= now()`,
  };

  /**
   * A person's pauses. Their own are always readable, with the reason and the end but never who
   * set them (owner decision Q5 A); anyone else's need moderation.view and show everything.
   */
  async status(actor: Actor, subject: string): Promise<PauseStatus> {
    authorize(actor, actor.guildId);
    const self = subject === actor.userId;
    if (!self) requirePermission(actor, actor.guildId, "moderation.view");
    const db = this.app.db.orm;
    const mine = and(eq(b.guild_id, actor.guildId), eq(b.user_id, subject));
    const [active, ended] = await Promise.all([
      db.select(this.columns).from(b).where(and(mine, ACTIVE_BLOCK)).orderBy(desc(b.created_at)),
      self
        ? Promise.resolve([])
        : db
            .select(this.columns)
            .from(b)
            .where(and(mine, or(isNotNull(b.lifted_at), lte(b.expires_at, sql`now()`))))
            .orderBy(desc(ENDED_AT))
            .limit(ENDED_LIMIT),
    ]);
    const show = (row: (typeof active)[number]) => this.view(row, !self);
    return {
      subject,
      self,
      active: active.map(show).filter((view): view is PauseView => view !== null),
      ended: ended.map(show).filter((view): view is PauseView => view !== null),
    };
  }

  /** The Moderation page: every active pause in the server, and the newest ended ones. */
  async overview(actor: Actor): Promise<ModerationOverview> {
    requirePermission(actor, actor.guildId, "moderation.view");
    const db = this.app.db.orm;
    const server = eq(b.guild_id, actor.guildId);
    const [active, ended] = await Promise.all([
      db
        .select(this.columns)
        .from(b)
        .where(and(server, ACTIVE_BLOCK))
        .orderBy(desc(b.created_at))
        .limit(ACTIVE_LIMIT + 1),
      db
        .select(this.columns)
        .from(b)
        .where(and(server, or(isNotNull(b.lifted_at), lte(b.expires_at, sql`now()`))))
        .orderBy(desc(ENDED_AT))
        .limit(ENDED_LIMIT),
    ]);
    const show = (row: (typeof active)[number]) => this.view(row, true);
    return {
      active: active
        .slice(0, ACTIVE_LIMIT)
        .map(show)
        .filter((view): view is PauseView => view !== null),
      ended: ended.map(show).filter((view): view is PauseView => view !== null),
      truncated: active.length > ACTIVE_LIMIT,
    };
  }

  /**
   * Who sent suggestion `number`, for the Moderation page's finder (owner decision Q7 A: officers
   * who can see pauses may look up a suggestion's sender). Read from the audit row /suggest writes
   * after it posts, so a suggestion whose row failed to write, or one from before this TaruBot,
   * honestly isn't found. Scoped to this server.
   */
  async senderOfSuggestion(actor: Actor, number: number): Promise<string | null> {
    requirePermission(actor, actor.guildId, "moderation.view");
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const [row] = await this.app.db.orm
      .select({ sender: t.auditEvents.actor_id })
      .from(t.auditEvents)
      .where(
        and(
          eq(t.auditEvents.guild_id, actor.guildId),
          eq(t.auditEvents.action, "suggestion.posted"),
          eq(t.auditEvents.target, `#${number}`),
        ),
      )
      .orderBy(desc(t.auditEvents.id))
      .limit(1);
    return row?.sender ?? null;
  }

  /** Names for the IDs a view shows, from the gateway (cache first); empty when it can't say. */
  async names(
    guildId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || !this.app.discord.displayNames) return new Map();
    try {
      return await this.app.discord.displayNames(guildId, unique);
    } catch {
      // Names are decoration: an outage shows IDs.
      return new Map();
    }
  }
}
