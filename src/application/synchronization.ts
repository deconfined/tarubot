/** Acquire trustworthy shared observations, then project each guild's independent policy. */
import { z } from "zod";
import {
  accessDecisive,
  authorize,
  departure,
  desiredAccess,
  type AccessFacts,
  type Actor,
} from "../domain/policy.js";
import { effectsPaused, WAITING_CODES } from "../domain/failures.js";
import { ROLE_CHOICE_KIND, ROLE_CHOICE_RETENTION_DAYS } from "../domain/self-roles.js";
import { type Departure, statusObservation } from "../domain/status.js";
import { Failure, json, nickname, normalized } from "../domain/values.js";
import { desiredRankRole, rankAccess, rankDecisive } from "./rank-policy.js";
import { ensureUser, orm, type Connection } from "../infrastructure/postgres/database.js";
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import {
  closeUnstarted,
  degradedNoticeKey,
  enqueue,
  layoutGuildRoles,
  reconcileUser,
  recoveredNoticeKey,
  scheduleJob,
  secureGuildChannels,
  type Job,
} from "../jobs/queue.js";
import type { GuildRecord, MemberView } from "./records.js";
import type { RefreshResult } from "./results.js";
import type { Service } from "./service.js";
import { accessFacts } from "./access-facts.js";
import {
  type DepartingOwner,
  lockDepartingOwners,
  recordDepartures,
  recordStatus,
} from "./status-notices.js";

/** Bound the per-job role-delta history; a long-lived blocked job is re-run indefinitely. */
const APPLIED_HISTORY = 20;
/**
 * Officer Lodestone notices (owner decisions on #29, 2026-09-25; REQUIREMENTS.md "Approved
 * officer-notice amendments"). A degraded notice waits this long before posting, so a failure the
 * next retries fix posts nothing: a roster that changed mid-read retries only after the 60 s FC
 * cooldown, and the accepted roster then closes the notice unposted.
 */
const DEGRADED_HOLD_SECONDS = 300;
/**
 * While the FC keeps failing, each guild's officers get at most one degraded notice a day,
 * counted from when the last one finished (posted or skipped), or from when it was queued if it
 * hasn't finished.
 */
const DEGRADED_REPEAT_SECONDS = 24 * 3600;
/** Unchanged from before #29, so officers read the text they already know. */
const DEGRADED_NOTICE =
  "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status.";
/** The owner's wording (#29, second round): one line after a posted degraded notice. */
const RECOVERED_NOTICE = "Lodestone synchronization recovered: the FC roster was accepted again.";
/** One role delta sent to Discord by a reconciliation pass, even if that pass is later superseded. */
type AppliedDelta = {
  generation: number;
  at: string;
  add: string[];
  remove: string[];
  status: "applied" | "pending_or_blocked";
};
/**
 * Append a pass's delta to the job's existing `applied` list and keep the newest entries.
 * A superseded pass re-runs with the roles already present (add/remove empty), so without this
 * list the delta Discord actually received would vanish from the job's result.
 */
function appliedHistory(entry: AppliedDelta | null): SQL {
  const prior = sql`CASE WHEN jsonb_typeof(${t.jobs.result}->'applied')='array' THEN ${t.jobs.result}->'applied' ELSE '[]'::jsonb END`;
  const list = entry ? sql`(${prior} || ${json([entry])}::jsonb)` : prior;
  return sql`(SELECT coalesce(jsonb_agg(item.value ORDER BY item.position),'[]'::jsonb) FROM jsonb_array_elements(${list}) WITH ORDINALITY AS item(value,position) WHERE item.position>jsonb_array_length(${list})-${APPLIED_HISTORY})`;
}

/** Evidence publication and Discord delivery have distinct transactions, timestamps, and failures. */
export class Synchronization {
  /** The application facade supplies persistence, external ports, and validated timing settings. */
  constructor(readonly app: Service) {}
  /**
   * Coalesce shared acquisition or cached reconciliation and record an inspectable request run.
   * The result says whether the cached roster was used, the roster interval behind that choice,
   * and whether Discord changes are paused.
   */
  async refresh(actor: Actor, force: boolean): Promise<RefreshResult> {
    if (force) {
      if (!actor.officer)
        throw new Failure(
          "forbidden",
          "Only officers can force a refresh. Run /refresh without force: it refreshes when the roster is due and otherwise uses recent data.",
          0,
          { kind: "scope", scope: "officer" },
        );
      authorize(actor, actor.guildId, "officer");
    }
    const guild = await this.app.guild(actor);
    if (!guild.fc_id)
      throw new Failure(
        "setup",
        "There's no FC roster to refresh until an officer links the Free Company.",
        0,
        { kind: "setup", missing: "fc" },
      );
    const [fc] = await this.app.db.orm
      .select({
        last_successful_roster_at: t.freeCompanies.last_successful_roster_at,
        last_attempt_at: t.freeCompanies.last_attempt_at,
      })
      .from(t.freeCompanies)
      .where(eq(t.freeCompanies.id, guild.fc_id));
    const fresh =
      fc?.last_successful_roster_at &&
      Date.now() - fc.last_successful_roster_at.getTime() <
        this.app.config.ROSTER_INTERVAL_SECONDS * 1000;
    const cooldown = Math.max(0, 60 - (Date.now() - (fc?.last_attempt_at?.getTime() ?? 0)) / 1000);
    return this.app.db.transaction(async (client) => {
      const job =
        force || !fresh
          ? await enqueue(
              client,
              "roster",
              `roster:${guild.fc_id}`,
              { fcId: guild.fc_id },
              null,
              null,
              cooldown,
            )
          : await enqueue(client, "reconcile.guild", `guild:${guild.id}`, {}, guild.id);
      const db = orm(client);
      const [run] = await db
        .insert(t.syncRuns)
        .values({ guild_id: guild.id, requester_id: actor.userId, job_id: job })
        .returning({ id: t.syncRuns.id });
      if (!run) throw new Error("Missing sync run");
      await db.insert(t.syncRunJobs).values({ run_id: run.id, job_id: job });
      return {
        runId: run.id,
        status: "queued",
        cached: !force && !!fresh,
        forced: force,
        cooldownSeconds: Math.ceil(cooldown),
        intervalSeconds: this.app.config.ROSTER_INTERVAL_SECONDS,
        lastSuccessfulRosterAt: fc?.last_successful_roster_at ?? null,
        effectsMode: this.app.effectsMode(guild),
      };
    });
  }
  /** Hold an FC session lock during acquisition; publish only after completeness and lease checks. */
  async roster(job: Job, guard: () => Promise<void>): Promise<unknown> {
    const { fcId } = z.object({ fcId: z.string() }).parse(job.payload);
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`fc:${fcId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("cooldown", "Refresh is already running.", 60);
      const session = orm(connection);
      const linked = await session
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)));
      if (!linked.length) return { skipped: "FC no longer linked" };
      const allowed = await session
        .update(t.freeCompanies)
        .set({ last_attempt_at: sql`now()` })
        .where(
          and(
            eq(t.freeCompanies.id, fcId),
            or(
              isNull(t.freeCompanies.last_attempt_at),
              lte(t.freeCompanies.last_attempt_at, sql`now()-interval '60 seconds'`),
            ),
          ),
        )
        .returning({ id: t.freeCompanies.id });
      if (!allowed.length) throw new Failure("cooldown", "FC refresh cooldown.", 60);
      const roster = await this.app.lodestone.roster(fcId);
      await guard();
      const result = await this.app.db.transaction(async (client) => {
        const db = orm(client);
        const lease = await db
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .where(
            and(
              eq(t.jobs.id, job.id),
              eq(t.jobs.lease_token, job.lease_token),
              gt(t.jobs.lease_until, sql`now()`),
            ),
          )
          .for("update");
        // No live lease row means another worker reclaimed (or will reclaim) this acquisition.
        if (!lease.length)
          throw new Failure(
            "lease_lost",
            "Worker lease expired or was reclaimed; another worker owns this job.",
          );
        // The outage this roster ends, read before the FC update below clears it: every failure
        // since the last accepted roster left last_error set, and the notices it queued are newer
        // than `since` (#29).
        const [previous] = await db
          .select({
            since: t.freeCompanies.last_successful_roster_at,
            error: t.freeCompanies.last_error,
          })
          .from(t.freeCompanies)
          .where(eq(t.freeCompanies.id, fcId));
        await this.app.storeCompany(client, roster.company);
        const [snapshot] = await db
          .insert(t.rosterSnapshots)
          .values({
            fc_id: fcId,
            started_at: roster.startedAt,
            observed_at: roster.observedAt,
            member_count: roster.members.length,
            evidence: {
              pages: roster.pages,
              identityRechecked: true,
              countRechecked: true,
              uniqueIds: true,
            },
          })
          .returning({ id: t.rosterSnapshots.id });
        if (!snapshot) throw new Error("Missing snapshot");
        // Officer status notices (2.29.0) record confirmed departures in this transaction, which
        // must lock the departing owners' guild_users rows before any characters row (the order
        // /unclaim, /assign and the two-404 unlink use). So every link's transition is decided
        // first, from the membership rows as they stand: nothing below writes membership before
        // the per-guild loop, so these are the transitions the loop applies. The guilds are
        // share-locked first, as before, so /config adoption, /setup and activation (which lock
        // the guild row before theirs) serialize with this on that row.
        const guilds = await db
          .select()
          .from(t.guilds)
          .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)))
          .for("share");
        const present = new Set(roster.members.map((member) => member.id));
        const plans: {
          guild: (typeof guilds)[number];
          links: {
            link: {
              id: string;
              user_id: string;
              character_id: string;
              name: string;
              world: string;
            };
            transition: ReturnType<typeof departure>;
            departed: boolean;
          }[];
        }[] = [];
        for (const guild of guilds) {
          // Every link references its character (a foreign key), whose last known name and world
          // a departure line shows.
          const links = await db
            .select({
              id: t.links.id,
              user_id: t.links.user_id,
              character_id: t.links.character_id,
              state: t.membership.state,
              first_absence_at: t.membership.first_absence_at,
              name: t.characters.name,
              world: t.characters.world,
            })
            .from(t.links)
            .innerJoin(t.characters, eq(t.characters.id, t.links.character_id))
            .leftJoin(
              t.membership,
              and(
                eq(t.membership.guild_id, t.links.guild_id),
                eq(t.membership.character_id, t.links.character_id),
                eq(t.membership.fc_id, fcId),
              ),
            )
            .where(and(eq(t.links.guild_id, guild.id), eq(t.links.active, true)));
          plans.push({
            guild,
            links: links.map((link) => {
              const transition = departure(
                link.state ?? undefined,
                present.has(link.character_id),
                link.first_absence_at,
                roster.observedAt,
              );
              // A confirmed departure (missing, then absent at least a minute later): exactly
              // the transition the DevBot roster line counts.
              const departed =
                transition.state === "absent" &&
                (link.state === "missing" || link.state === "present");
              return { link, transition, departed };
            }),
          });
        }
        // Only guilds with an officer notifications channel record departures (owner decision 5:
        // nothing is saved for later while it is unset), so only their owners are locked. The
        // channel was read under this transaction's share lock on the guild row, so it holds.
        const owners = new Map<string, DepartingOwner>();
        for (const plan of plans)
          for (const { link, departed } of plan.links)
            if (departed && plan.guild.officer_notifications_channel_id)
              owners.set(`${plan.guild.id}:${link.user_id}`, {
                guild: plan.guild.id,
                user: link.user_id,
              });
        const states = await lockDepartingOwners(client, [...owners.values()]);
        for (const member of roster.members) {
          await this.app.storeCharacter(client, member, false);
          await db.insert(t.rosterMembers).values({
            snapshot_id: snapshot.id,
            character_id: member.id,
            fc_rank_name: member.fcRankName ?? null,
            fc_rank_key: member.fcRankName ? normalized(member.fcRankName) : null,
            is_fc_leader: member.isFcLeader ?? null,
          });
        }
        let confirmation = false;
        for (const { guild, links } of plans) {
          const departures: { user: string; departure: Departure }[] = [];
          for (const { link, transition, departed } of links) {
            if (transition.state === "missing") confirmation = true;
            if (departed)
              departures.push({
                user: link.user_id,
                departure: {
                  character: link.character_id,
                  name: link.name,
                  world: link.world,
                  snapshot: snapshot.id,
                },
              });
            const observation = {
              state: transition.state,
              first_absence_at: transition.firstAbsence,
              snapshot_id: snapshot.id,
            };
            await db
              .insert(t.membership)
              .values({
                guild_id: guild.id,
                fc_id: fcId,
                character_id: link.character_id,
                ...observation,
                confirmed_snapshot_id: transition.state === "present" ? snapshot.id : null,
              })
              .onConflictDoUpdate({
                target: [t.membership.guild_id, t.membership.fc_id, t.membership.character_id],
                set: {
                  ...observation,
                  confirmed_snapshot_id:
                    transition.state === "present"
                      ? snapshot.id
                      : t.membership.confirmed_snapshot_id,
                },
              });
            if (present.has(link.character_id))
              await db
                .insert(t.membershipHistory)
                .values({
                  guild_id: guild.id,
                  user_id: link.user_id,
                  fc_id: fcId,
                  link_id: link.id,
                  snapshot_id: snapshot.id,
                  observed_at: roster.observedAt,
                })
                .onConflictDoNothing({
                  target: [t.membershipHistory.link_id, t.membershipHistory.fc_id],
                });
          }
          // Every confirmed departure of a linked character goes on its owner's row, including
          // alts whose owner keeps Member and owners no longer in the server, and queues the
          // guild's status post once (owner decision on #29: "Let #31 handle" departures). A guild
          // with no officer channel records none; the DevBot roster line below still counts them.
          await recordDepartures(
            client,
            guild.id,
            guild.officer_notifications_channel_id,
            departures,
            states,
          );
          const reconciliation = await enqueue(
            client,
            "reconcile.guild",
            `guild:${guild.id}`,
            { snapshotId: snapshot.id },
            guild.id,
          );
          await db
            .insert(t.syncRunJobs)
            .select(
              db
                .select({
                  run_id: t.syncRuns.id,
                  job_id: sql<string>`${reconciliation}::uuid`.as("job_id"),
                })
                .from(t.syncRuns)
                .where(and(eq(t.syncRuns.guild_id, guild.id), eq(t.syncRuns.job_id, job.id))),
            )
            .onConflictDoNothing();
          // Routine acceptance is a DevBot diagnostic (owner decision, #29): only the test guild
          // posts it. Production's TEST_GUILD_ID is "" (docker-compose.production.yml sets it and
          // env.ts defaults to it; deployment.ts refuses anything else for the maintenance tools),
          // which never equals a guild.
          if (guild.id === this.app.config.TEST_GUILD_ID)
            await enqueue(
              client,
              "officer.notify",
              `officer:${guild.id}`,
              {
                message: `FC roster accepted: ${roster.members.length} members; ${departures.length} confirmed character departures. Snapshot ${snapshot.id}.`,
              },
              guild.id,
              null,
              5,
            );
        }
        // Only a roster that follows a failure can end an outage officers were told about.
        if (previous?.error)
          await this.recovered(
            client,
            fcId,
            guilds.map((guild) => guild.id),
            previous.since,
          );
        await db
          .update(t.freeCompanies)
          .set({ last_successful_roster_at: roster.observedAt, last_error: null })
          .where(eq(t.freeCompanies.id, fcId));
        if (confirmation)
          await enqueue(client, "roster.confirm", `confirm:${fcId}`, { fcId }, null, null, 60);
        return { snapshotId: snapshot.id, count: roster.members.length, pages: roster.pages };
      });
      return result;
    } catch (error) {
      // Cooldowns, superseded inputs and a lost worker lease are ownership/timing changes, not
      // Lodestone degradation: the reclaiming worker owns FC state and any officer notice.
      if (
        !(error instanceof Failure && ["cooldown", "superseded", "lease_lost"].includes(error.code))
      ) {
        await this.app.db.orm
          .update(t.freeCompanies)
          .set({ last_error: error instanceof Failure ? error.code : "acquisition_failed" })
          .where(eq(t.freeCompanies.id, fcId));
        // Waits aren't degradation (2.17.0): Lodestone throttling and busy retry after the
        // cooldown without spending attempts, so a notice per wait would repeat for as long as the
        // throttling lasts. /config validate shows the FC's failed attempt once the roster is
        // stale, and /sync status lists the retrying roster job with its error. Every other
        // failure may queue a held, rate-limited degraded notice (#29).
        if (!(error instanceof Failure && WAITING_CODES.has(error.code))) await this.degraded(fcId);
      }
      throw error;
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`fc:${fcId}`])
          .catch(() => {});
      connection.release();
    }
  }
  /**
   * Queue each linked guild's degraded notice, held and rate-limited (#29). It is skipped while
   * any degraded notice for the guild and FC is pending (queued, running, blocked or parked
   * `disabled`), whatever its age. Otherwise enqueue() would merge each failure into a queued,
   * running or blocked row (bumping its generation, and flipping a blocked one back to queued),
   * and would add a second row beside a parked `disabled` one, which its active-job index doesn't
   * cover. It is also skipped while this outage's newest notice finished (or, if unfinished, was
   * queued) less than a day ago; measuring from creation alone would let a notice released after
   * a day parked be followed by a repeat minutes later. The outage began at the FC's last accepted
   * roster, and jobs rows are never deleted, so they are the notice history. Roster attempts for
   * one FC hold its advisory lock, so this check and the enqueue don't race.
   *
   * Clock assumption: the boundary, `last_successful_roster_at`, is the accepted roster's
   * `observedAt` from the acquiring process's clock, while `jobs.created_at` is the database's
   * now(). The FC lock orders them: the last outage's notices were queued before the accepted
   * attempt began fetching, and this outage's after it published and a later attempt fetched. So
   * the clocks must agree to within those seconds, which NTP keeps to milliseconds on the Docker
   * host and managed PostgreSQL. A bot clock far ahead of the database's would let this outage's
   * notices look older than the boundary and switch the daily limit off; one far behind would let
   * the last outage's notices suppress this one's first.
   */
  private async degraded(fcId: string): Promise<void> {
    await this.app.db.transaction(async (client) => {
      const db = orm(client);
      const [fc] = await db
        .select({ since: t.freeCompanies.last_successful_roster_at })
        .from(t.freeCompanies)
        .where(eq(t.freeCompanies.id, fcId));
      // Share-locked, as the roster publication does: an FC unlink waits for this transaction and
      // then closes whatever it queued, or commits first and takes the guild out of this list.
      const guilds = await db
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)))
        .for("share");
      for (const guild of guilds) {
        const key = degradedNoticeKey(guild.id, fcId);
        const [told] = await db
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .where(
            and(
              eq(t.jobs.dedupe_key, key),
              or(
                inArray(t.jobs.status, ["queued", "running", "blocked", "disabled"]),
                and(
                  fc?.since ? gt(t.jobs.created_at, fc.since) : undefined,
                  gt(
                    sql`coalesce(${t.jobs.completed_at},${t.jobs.created_at})`,
                    sql`now()-${DEGRADED_REPEAT_SECONDS}*interval '1 second'`,
                  ),
                ),
              ),
            ),
          )
          .limit(1);
        if (!told)
          await enqueue(
            client,
            "officer.notify",
            key,
            { message: DEGRADED_NOTICE },
            guild.id,
            null,
            DEGRADED_HOLD_SECONDS,
          );
      }
    });
  }
  /**
   * An accepted roster ends the outage for the FC's guilds (#29). A degraded notice still waiting
   * to post is closed unposted: posting it and then the recovery would be two lines about an
   * outage that is over. One recovery line follows only a degraded notice that was posted (or is
   * posting) during this outage, so officers who never heard an outage began aren't told it
   * ended. `active` holds the publication's share-locked active guilds; `since` is the FC's
   * previous accepted roster, where this outage began. The clock assumption in degraded()
   * applies to `since` too.
   *
   * Accepted edge case: a notice `running` now is left to finish and counted as posted. If that
   * send fails (or its worker dies), the queue retries it, and it can post after the recovery
   * line with nothing after it; the window is one send in flight during this transaction.
   */
  private async recovered(
    client: Connection,
    fcId: string,
    active: readonly string[],
    since: Date | null,
  ): Promise<void> {
    const db = orm(client);
    // Every guild still linked to the FC, including one the bot was removed from: the queue never
    // claims an inactive guild's rows, so its waiting notice would otherwise post about this ended
    // outage once the bot is added back, with no recovery line after it. One query, so a guild
    // reactivated meanwhile is still in it.
    const linked = await db
      .select({ id: t.guilds.id })
      .from(t.guilds)
      .where(eq(t.guilds.fc_id, fcId));
    for (const guild of linked)
      await closeUnstarted(client, degradedNoticeKey(guild.id, fcId), "recovered before posting");
    // Recovery lines only for active guilds: an inactive guild's would wait, like its notices, and
    // post long after this outage once the bot is added back.
    for (const guild of active) {
      // Creation, not completion, places a notice in an outage: one running at the previous
      // recovery that posted just after it belongs to that outage, and counting it here would
      // post a second recovery line for it.
      const [posted] = await db
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(
          and(
            eq(t.jobs.dedupe_key, degradedNoticeKey(guild, fcId)),
            since ? gt(t.jobs.created_at, since) : undefined,
            or(isNotNull(t.jobs.message_id), eq(t.jobs.status, "running")),
          ),
        )
        .limit(1);
      if (posted)
        await enqueue(
          client,
          "officer.notify",
          recoveredNoticeKey(guild, fcId),
          { message: RECOVERED_NOTICE },
          guild,
          null,
          5,
        );
    }
  }
  /** Evaluate links not yet observed, requesting early acquisition when fresh evidence is absent. */
  async seedFreshLink(guild: GuildRecord, user: string): Promise<void> {
    const fcId = guild.fc_id;
    if (!fcId) return;
    await this.app.db.transaction(async (client) => {
      const db = orm(client);
      const current = await db
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(
          and(
            eq(t.guilds.id, guild.id),
            eq(t.guilds.fc_id, fcId),
            eq(t.guilds.revision, guild.revision),
          ),
        )
        .for("share");
      if (!current.length)
        throw new Failure("superseded", "Configuration changed while evaluating a new link.");
      const [snapshot] = await db
        .select({ id: t.rosterSnapshots.id, observed_at: t.rosterSnapshots.observed_at })
        .from(t.rosterSnapshots)
        .where(
          and(
            eq(t.rosterSnapshots.fc_id, fcId),
            gt(
              t.rosterSnapshots.observed_at,
              sql`now()-${this.app.config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
            ),
          ),
        )
        .orderBy(desc(t.rosterSnapshots.observed_at))
        .limit(1);
      const links = await db
        .select({ id: t.links.id, character_id: t.links.character_id })
        .from(t.links)
        .leftJoin(
          t.membership,
          and(
            eq(t.membership.guild_id, t.links.guild_id),
            eq(t.membership.character_id, t.links.character_id),
            eq(t.membership.fc_id, fcId),
          ),
        )
        .where(
          and(
            eq(t.links.guild_id, guild.id),
            eq(t.links.user_id, user),
            eq(t.links.active, true),
            isNull(t.membership.character_id),
          ),
        );
      if (!snapshot) {
        if (links.length) await enqueue(client, "roster", `roster:${fcId}`, { fcId });
        return;
      }
      for (const link of links) {
        const found = await db
          .select({ character_id: t.rosterMembers.character_id })
          .from(t.rosterMembers)
          .where(
            and(
              eq(t.rosterMembers.snapshot_id, snapshot.id),
              eq(t.rosterMembers.character_id, link.character_id),
            ),
          );
        await db
          .insert(t.membership)
          .values({
            guild_id: guild.id,
            fc_id: fcId,
            character_id: link.character_id,
            state: found.length ? "present" : "absent",
            snapshot_id: snapshot.id,
            confirmed_snapshot_id: found.length ? snapshot.id : null,
          })
          .onConflictDoNothing();
        if (found.length)
          await db
            .insert(t.membershipHistory)
            .values({
              guild_id: guild.id,
              user_id: user,
              fc_id: fcId,
              link_id: link.id,
              snapshot_id: snapshot.id,
              observed_at: snapshot.observed_at,
            })
            .onConflictDoNothing();
      }
    });
  }
  /** Assemble policy facts without granting authority to manually assigned Discord roles. */
  async facts(guild: GuildRecord, member: MemberView): Promise<AccessFacts> {
    return accessFacts(
      this.app.db.orm,
      guild,
      member.id,
      this.app.config.ROSTER_INTERVAL_SECONDS,
      member.roles,
    );
  }
  /** Complete member coverage creates per-user work and associates it with requesting runs. */
  async guild(guildId: string, parentJob: string): Promise<unknown> {
    const members = await this.app.discord.members(guildId);
    await this.app.db.transaction(async (client) => {
      const db = orm(client);
      // The lock order (2.29.0; status-notices.ts has the whole rule): the guild row first, FOR
      // SHARE, then every existing member row of the guild in user order compared as plain strings,
      // then job rows. /config adoption, /setup and activation lock the guild row FOR UPDATE before
      // their member and job rows, so they now queue behind this pass (and it behind them) on the
      // guild row, instead of each holding what the other waits for. The same read gives the
      // switches that decide which guild-wide child work this run attaches: role layout only when
      // presentation is on, channel access only when onboarding is on.
      const [switches] = await db
        .select({
          access: t.guilds.access_policy_enabled,
          layout: t.guilds.role_layout_enabled,
        })
        .from(t.guilds)
        .where(eq(t.guilds.id, guildId))
        .for("share");
      // The pass locks the member rows anyway (ensureUser for present members, then the closing
      // present=false update for the rest), but in the gateway's enumeration order; taking them up
      // front in the global (guild_id, user_id) order keeps it from deadlocking with the roster's
      // departing-owner lock and the status-post freeze. FOR NO KEY UPDATE, the strength those
      // writes take, never blocks the FOR KEY SHARE of a foreign-key check (the roster's
      // membership_history inserts, for one). Rows ensureUser inserts for new members are new keys
      // nobody else holds.
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(eq(t.guildUsers.guild_id, guildId))
        .orderBy(sql`${t.guildUsers.user_id} COLLATE "C"`)
        .for("no key update");
      // Each requesting run tracks all child work, including coalesced role-layout jobs.
      const attach = async (child: string) => {
        await db
          .insert(t.syncRunJobs)
          .select(
            db
              .select({ run_id: t.syncRuns.id, job_id: sql<string>`${child}::uuid`.as("job_id") })
              .from(t.syncRuns)
              .innerJoin(t.syncRunJobs, eq(t.syncRunJobs.run_id, t.syncRuns.id))
              .where(and(eq(t.syncRuns.guild_id, guildId), eq(t.syncRunJobs.job_id, parentJob))),
          )
          .onConflictDoNothing();
      };
      if (switches?.layout) await attach(await layoutGuildRoles(client, guildId));
      if (switches?.access) await attach(await secureGuildChannels(client, guildId));
      for (const member of members) {
        if (member.bot) continue;
        await ensureUser(client, guildId, member.id, member.joinedAt);
        const child = await reconcileUser(client, guildId, member.id);
        await attach(child);
      }
      const ids = members.filter((member) => !member.bot).map((member) => member.id);
      await db
        .update(t.guildUsers)
        .set({ present: false })
        .where(and(eq(t.guildUsers.guild_id, guildId), notInArray(t.guildUsers.user_id, ids)));
      const cancelled = await db
        .update(t.guestApplications)
        .set({ state: "cancelled", decided_at: sql`now()` })
        .where(
          and(
            eq(t.guestApplications.guild_id, guildId),
            eq(t.guestApplications.state, "pending"),
            notExists(
              db
                .select({ user_id: t.guildUsers.user_id })
                .from(t.guildUsers)
                .where(
                  and(
                    eq(t.guildUsers.guild_id, t.guestApplications.guild_id),
                    eq(t.guildUsers.user_id, t.guestApplications.user_id),
                    eq(t.guildUsers.present, true),
                    eq(t.guildUsers.joined_at, t.guestApplications.joined_at),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: t.guestApplications.id, user_id: t.guestApplications.user_id });
      for (const application of cancelled)
        await enqueue(
          client,
          "guest.review",
          `review:${application.id}`,
          { applicationId: application.id },
          guildId,
          application.user_id,
        );
      await db
        .update(t.syncRuns)
        .set({ enumeration_completed_at: sql`now()`, status: "reconciling" })
        .where(
          and(
            eq(t.syncRuns.guild_id, guildId),
            exists(
              db
                .select({ run_id: t.syncRunJobs.run_id })
                .from(t.syncRunJobs)
                .where(
                  and(eq(t.syncRunJobs.run_id, t.syncRuns.id), eq(t.syncRunJobs.job_id, parentJob)),
                ),
            ),
          ),
        );
    });
    return {
      enumerationComplete: true,
      humans: members.filter((member) => !member.bot).length,
      effects: "queued",
    };
  }
  /** Serialize one user's effects; previews calculate the same desired state without mutations. */
  async user(job: Job, guard: () => Promise<void>, preview = false): Promise<unknown> {
    if (!job.guild_id || !job.user_id) throw new Failure("invalid_job", "Missing user scope.");
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`user:${job.guild_id}:${job.user_id}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("busy", "User reconciliation is already running.");
      const db = this.app.db.orm;
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, job.guild_id), eq(t.guilds.active, true)));
      if (!guild) return { skipped: "guild inactive" };
      const member = await this.app.discord.member(guild.id, job.user_id);
      if (!member || member.bot) return { skipped: "user absent or bot" };
      if (!preview) await this.seedFreshLink(guild, member.id);
      const facts = await this.facts(guild, member);
      const desired = desiredAccess(facts);
      const rank = await rankAccess(
        this.app.db,
        guild,
        member.id,
        this.app.config.ROSTER_INTERVAL_SECONDS,
      );
      const officer = desiredRankRole(
        rank.officer,
        member.roles.includes(guild.officer_role_id ?? ""),
        rank.fresh,
        rank.manualOfficer,
      );
      const leader = desiredRankRole(
        rank.leader,
        member.roles.includes(guild.leader_role_id ?? ""),
        rank.fresh,
      );
      const retired = await db
        .select({ role_id: t.retiredRoles.role_id })
        .from(t.retiredRoles)
        .where(eq(t.retiredRoles.guild_id, guild.id));
      const add: string[] = [];
      const remove = retired
        .map((row) => row.role_id)
        .filter((role) => member.roles.includes(role));
      for (const [role, wanted] of [
        [guild.member_role_id, desired.member],
        [guild.guest_role_id, desired.guest],
        [guild.officer_role_id, officer],
        [guild.leader_role_id, leader],
      ] as const) {
        if (!role) continue;
        if (wanted && !member.roles.includes(role)) add.push(role);
        if (!wanted && member.roles.includes(role)) remove.push(role);
      }
      if (preview) {
        const [preferences] = await db
          .select({ ...getTableColumns(t.guildUsers), name: t.characters.name })
          .from(t.guildUsers)
          .leftJoin(t.characters, eq(t.characters.id, t.guildUsers.primary_character_id))
          .where(and(eq(t.guildUsers.guild_id, guild.id), eq(t.guildUsers.user_id, member.id)));
        let target = member.nickname;
        // The worker never writes or restores the server owner's nickname, so a preview never
        // plans one either: the owner's desired nickname stays the current one.
        if (preferences && !member.owner) {
          const ownPending =
            preferences.nickname_pending && member.nickname === preferences.nickname_expected;
          const expected = preferences.nickname_written
            ? preferences.nickname_last
            : preferences.nickname_before;
          const independent =
            preferences.nickname_baseline_set && member.nickname !== expected && !ownPending;
          if (
            preferences.nickname_restore &&
            preferences.nickname_baseline_set &&
            (preferences.nickname_written || ownPending) &&
            !independent
          )
            target = preferences.nickname_before;
          else if (
            !preferences.nickname_restore &&
            preferences.nickname_enabled &&
            !preferences.nickname_suspended &&
            preferences.name &&
            !independent
          )
            target = nickname(preferences.name);
        }
        return {
          user: member.id,
          add,
          remove,
          desired,
          nickname: { current: member.nickname, desired: target },
        };
      }
      if (!guild.effects_enabled || !this.app.config.ENABLE_EFFECTS)
        throw effectsPaused(this.app.config.ENABLE_EFFECTS);
      await guard();
      const [current] = await db
        .select({ revision: t.guilds.revision })
        .from(t.guilds)
        .where(eq(t.guilds.id, guild.id));
      if (current?.revision !== guild.revision)
        throw new Failure("superseded", "Configuration changed.");
      let roleError: unknown;
      try {
        if (guild.access_policy_enabled)
          for (const role of add)
            await this.app.discord.validateRole(guild.id, role, undefined, true);
        await this.app.discord.roles(guild.id, member.id, add, remove);
      } catch (error) {
        roleError = error;
      }
      // Nicknames are an independent capability; a blocked role does not block them.
      let nicknameError: unknown;
      try {
        await this.nickname(guild, member, guard);
      } catch (error) {
        nicknameError = error;
      }
      const roles = { status: roleError ? "pending_or_blocked" : "applied", add, remove } as const;
      const nicknameResult = { status: nicknameError ? "pending_or_blocked" : "applied" } as const;
      // Record the delta this pass sent to Discord before any later generation fence can discard it.
      const entry =
        add.length || remove.length
          ? {
              generation: job.generation,
              at: new Date().toISOString(),
              add,
              remove,
              status: roles.status,
            }
          : null;
      await db
        .update(t.jobs)
        .set({
          result: sql`jsonb_build_object('roles',${json(roles)}::jsonb,'nickname',${json(nicknameResult)}::jsonb,'applied',${appliedHistory(entry)})`,
        })
        .where(
          and(
            eq(t.jobs.id, job.id),
            eq(t.jobs.lease_token, job.lease_token),
            gt(t.jobs.lease_until, sql`now()`),
          ),
        );
      // Officer status notices (2.29.0): record this pass's decisive values once its roles were
      // applied. Nickname errors don't matter here; a blocked role write records nothing, and the
      // pass after the fix compares against the stored state. Only values that don't depend on
      // the roles the member already holds are recorded (accessDecisive, rankDecisive).
      if (!roleError) {
        const access = accessDecisive(facts);
        await recordStatus(
          this.app,
          guild.id,
          member.id,
          member.joinedAt,
          statusObservation({
            bound: {
              member: Boolean(guild.member_role_id),
              guest: Boolean(guild.guest_role_id),
              officer: Boolean(guild.officer_role_id),
              leader: Boolean(guild.leader_role_id),
            },
            values: { member: desired.member, guest: desired.guest, officer, leader },
            decisive: {
              member: access.member,
              guest: access.guest,
              officer: rankDecisive(rank.officer, rank.fresh, rank.manualOfficer),
              leader: rankDecisive(rank.leader, rank.fresh),
            },
            facts: {
              fcLinked: Boolean(guild.fc_id),
              officerRankSet: Boolean(guild.officer_rank_key),
              grant: facts.grant,
              former: facts.former,
              guestRevoked: facts.revoked,
              manualOfficer: rank.manualOfficer,
              officerRevoked: rank.revoked,
            },
          }),
        );
      }
      if (desired.member || (desired.guest && facts.verified)) {
        const apps = await db
          .update(t.guestApplications)
          .set({ state: "superseded", decided_at: sql`now()` })
          .where(
            and(
              eq(t.guestApplications.guild_id, guild.id),
              eq(t.guestApplications.user_id, member.id),
              eq(t.guestApplications.state, "pending"),
            ),
          )
          .returning({ id: t.guestApplications.id });
        for (const app of apps)
          await enqueue(
            this.app.db.pool,
            "guest.review",
            `review:${app.id}`,
            { applicationId: app.id },
            guild.id,
            member.id,
          );
      }
      if (roleError) throw roleError;
      if (nicknameError) throw nicknameError;
      // Queue completion carries the stored `applied` history into this final result.
      return {
        user: member.id,
        add,
        remove,
        status: "applied",
        roles,
        nickname: nicknameResult,
      };
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `user:${job.guild_id}:${job.user_id}`,
          ])
          .catch(() => {});
      connection.release();
    }
  }
  /** Preserve manual edits, distinguish baseline from successful writes, and recover ambiguous delivery. */
  private async nickname(
    guild: GuildRecord,
    member: MemberView,
    guard: () => Promise<void>,
  ): Promise<void> {
    const current = await this.app.discord.member(guild.id, member.id);
    if (!current || current.bot) return;
    const db = this.app.db.orm;
    const scope = and(eq(t.guildUsers.guild_id, guild.id), eq(t.guildUsers.user_id, member.id));
    const [user] = await db.select().from(t.guildUsers).where(scope);
    if (!user) return;
    const ownPending = user.nickname_pending && current.nickname === user.nickname_expected;
    const expected = user.nickname_written ? user.nickname_last : user.nickname_before;
    const independent = user.nickname_baseline_set && current.nickname !== expected && !ownPending;
    const suspend = async () => {
      await db
        .update(t.guildUsers)
        .set({ nickname_suspended: true, nickname_enabled: false, nickname_pending: false })
        .where(scope);
    };
    // Discord lets no bot change the server owner's nickname, so the worker never writes or
    // restores it, and drops any pending restore or write, instead of blocking a job no officer
    // can fix (2.14.0 reply session: the owner's /nickname enabled:true).
    if (current.owner) {
      if (user.nickname_restore || user.nickname_pending)
        await db
          .update(t.guildUsers)
          .set({ nickname_restore: false, nickname_pending: false })
          .where(scope);
      return;
    }
    if (user.nickname_restore) {
      let restored = ownPending && current.nickname === user.nickname_before;
      let changed = independent;
      if (
        user.nickname_baseline_set &&
        (user.nickname_written || ownPending) &&
        !independent &&
        current.nickname !== user.nickname_before
      ) {
        await db
          .update(t.guildUsers)
          .set({
            nickname_pending: true,
            nickname_expected: t.guildUsers.nickname_before,
            nickname_last: current.nickname,
            nickname_written: true,
          })
          .where(scope);
        await guard();
        restored = await this.app.discord.nickname(
          guild.id,
          member.id,
          user.nickname_before,
          current.nickname,
        );
        changed = !restored;
      }
      if (changed) await suspend();
      await db
        .update(t.guildUsers)
        .set({
          nickname_restore: false,
          nickname_baseline_set: false,
          nickname_pending: false,
          nickname_written: false,
          nickname_last: restored ? t.guildUsers.nickname_before : t.guildUsers.nickname_last,
        })
        .where(scope);
      return;
    }
    if (!user.nickname_enabled || user.nickname_suspended || !user.primary_character_id) return;
    if (independent) {
      await suspend();
      return;
    }
    if (ownPending)
      await db
        .update(t.guildUsers)
        .set({ nickname_last: current.nickname, nickname_written: true, nickname_pending: false })
        .where(scope);
    const [character] = await db
      .select({ name: t.characters.name })
      .from(t.characters)
      .innerJoin(t.links, eq(t.links.character_id, t.characters.id))
      .where(
        and(
          eq(t.characters.id, user.primary_character_id),
          eq(t.links.guild_id, guild.id),
          eq(t.links.user_id, member.id),
          eq(t.links.active, true),
        ),
      );
    if (!character) return;
    const target = nickname(character.name);
    if (!user.nickname_baseline_set)
      await db
        .update(t.guildUsers)
        .set({
          nickname_before: current.nickname,
          nickname_baseline_set: true,
          nickname_written: false,
        })
        .where(scope);
    if (current.nickname !== target) {
      await db
        .update(t.guildUsers)
        .set({ nickname_pending: true, nickname_expected: target })
        .where(scope);
      await guard();
      if (!(await this.app.discord.nickname(guild.id, member.id, target, current.nickname))) {
        await suspend();
        return;
      }
      await db
        .update(t.guildUsers)
        .set({ nickname_last: target, nickname_written: true, nickname_pending: false })
        .where(scope);
    } else await db.update(t.guildUsers).set({ nickname_pending: false }).where(scope);
  }
  /**
   * Startup catch-up and jittered scheduling fetch only actively needed FC rosters. Character
   * profiles are read only to verify ownership (owner decision, #86): the roster lists each
   * member's character ID, name and world, so linked characters need no scheduled refresh.
   */
  async schedule(): Promise<void> {
    const db = this.app.db.orm;
    const companies = await db
      .select({ id: t.freeCompanies.id })
      .from(t.freeCompanies)
      .where(
        and(
          exists(
            db
              .select({ id: t.guilds.id })
              .from(t.guilds)
              .where(and(eq(t.guilds.fc_id, t.freeCompanies.id), eq(t.guilds.active, true))),
          ),
          or(
            isNull(t.freeCompanies.last_successful_roster_at),
            lt(
              t.freeCompanies.last_successful_roster_at,
              sql`now()-${this.app.config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
            ),
          ),
        ),
      );
    for (const fc of companies)
      await scheduleJob(
        this.app.db.pool,
        "roster",
        `roster:${fc.id}`,
        { fcId: fc.id },
        null,
        Math.random() * 30,
      );
    await db.delete(t.challenges).where(lt(t.challenges.expires_at, sql`now()-interval '7 days'`));
    // Finished role-choice jobs (who changed their roles and when, never which) go after 30 days
    // (owner decision Q4 A): the one kind of job history that is pruned (docs/PERSISTENCE.md). No
    // delivery attempt or sync-run link ever references one. 2.39.0 queues none, but meets them
    // after a rollback from 2.40.0, and keeps the promise then too.
    await db
      .delete(t.jobs)
      .where(
        and(
          eq(t.jobs.kind, ROLE_CHOICE_KIND),
          inArray(t.jobs.status, ["succeeded", "failed"]),
          lt(t.jobs.completed_at, sql`now()-${ROLE_CHOICE_RETENTION_DAYS}*interval '1 day'`),
        ),
      );
    await db
      .update(t.jobs)
      .set({ status: "queued", due_at: sql`now()+interval '5 minutes'`, attempts: 0 })
      .where(and(eq(t.jobs.status, "blocked"), lt(t.jobs.due_at, sql`now()-interval '5 minutes'`)));
  }
}
