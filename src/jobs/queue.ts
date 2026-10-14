/** PostgreSQL-backed work leases: deduplicate decisions and recover abandoned delivery. */
import { randomUUID } from "node:crypto";
import { DiscordAPIError } from "discord.js";
import { DISCORD_BLOCKED_CODES, WAITING_CODES } from "../domain/failures.js";
import { Failure, json } from "../domain/values.js";
import type { PoolClient } from "pg";
import { orm, type Connection, type Database } from "../infrastructure/postgres/database.js";
import {
  and,
  asc,
  type Column,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as t from "../infrastructure/postgres/schema.js";
import { JOB_KINDS } from "./kinds.js";

/** Payload version describes its schema; generation describes superseding work for the same key. */
export type Job = Pick<
  typeof t.jobs.$inferSelect,
  | "id"
  | "kind"
  | "guild_id"
  | "user_id"
  | "payload"
  | "payload_version"
  | "generation"
  | "attempts"
  | "message_id"
  // Row timestamps let log events distinguish queue latency from a wait that never clears.
  | "created_at"
  | "due_at"
> & { lease_token: string };
/** Enqueue in the decision transaction; updating active work increments its generation fence. */
export async function enqueue(
  client: Connection,
  kind: string,
  key: string,
  payload: unknown,
  guild: string | null = null,
  user: string | null = null,
  delay = 0,
): Promise<string> {
  const [row] = await orm(client)
    .insert(t.jobs)
    .values({
      kind,
      dedupe_key: key,
      payload: payload === null ? sql`'null'::jsonb` : payload,
      guild_id: guild,
      user_id: user,
      due_at: sql`now()+${delay}*interval '1 second'`,
    })
    .onConflictDoUpdate({
      target: t.jobs.dedupe_key,
      // Literal states match the existing partial unique index, including generic prepared plans.
      targetWhere: sql`${t.jobs.status} IN ('queued','running','blocked')`,
      set: {
        payload: sql`excluded.payload`,
        generation: sql`${t.jobs.generation}+1`,
        due_at: sql`least(${t.jobs.due_at},excluded.due_at)`,
        status: sql`CASE WHEN ${t.jobs.status}='blocked' THEN 'queued' ELSE ${t.jobs.status} END`,
      },
    })
    .returning({ id: t.jobs.id });
  if (!row) throw new Error("Missing queued job");
  return row.id;
}
/**
 * Queue periodic work only when no active job carries the key, leaving an existing one alone. The
 * scheduler uses this instead of enqueue(), whose conflict update pulls an active job's due_at
 * forward to the new row's: that is right when new input arrives, but for a job backing off after a
 * failure it cancelled the backoff on every 30-second scheduler tick (the 2.16 retry storm). Returns
 * the new job's ID, or undefined when an active job already covers the key.
 */
export async function scheduleJob(
  client: Connection,
  kind: string,
  key: string,
  payload: unknown,
  guild: string | null = null,
  delay = 0,
): Promise<string | undefined> {
  const [row] = await orm(client)
    .insert(t.jobs)
    .values({
      kind,
      dedupe_key: key,
      payload: payload === null ? sql`'null'::jsonb` : payload,
      guild_id: guild,
      due_at: sql`now()+${delay}*interval '1 second'`,
    })
    .onConflictDoNothing({
      target: t.jobs.dedupe_key,
      // Literal states match the existing partial unique index, as in enqueue().
      where: sql`${t.jobs.status} IN ('queued','running','blocked')`,
    })
    .returning({ id: t.jobs.id });
  return row?.id;
}
/** One active reconciliation per guild/user coalesces command changes and gateway echoes. */
export const reconcileUser = (client: Connection, guild: string, user: string): Promise<string> =>
  enqueue(client, "reconcile.user", `user:${guild}:${user}`, {}, guild, user);

/** Coalesce role appearance/order changes independently of per-user access delivery. */
export const layoutGuildRoles = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "roles.layout", `role-layout:${guild}`, {}, guild);

/** Channel edits coalesce independently from member enumeration and role-layout effects. */
export const secureGuildChannels = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "channels.access", `channel-access:${guild}`, {}, guild);

/**
 * At most one active (queued, running or blocked) update post per guild (2.25.0): a deploy while
 * one waits merges into it, and the job reads the release range when it runs, so one post covers
 * every release since the last. A post parked as disabled isn't merged, so paused restarts can
 * park several; resuming collapses them to one (requeueParked). The payload stays {}: the job never
 * reads it, and a merge would overwrite it anyway.
 */
export const announceChangelog = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "changelog.post", `changelog:${guild}`, {}, guild);

/** The parked job states that activation, a /config change or a restart can put back in the queue. */
export type ParkedStatus = "disabled" | "blocked";
/** The states the active_job unique index covers: at most one such row per dedupe key. */
const ACTIVE_STATES = ["queued", "running", "blocked"] as const;
/** Retry bound for the supersede/requeue pair; each retry needs yet another enqueue in the window. */
const REQUEUE_ATTEMPTS = 5;

/**
 * Whether a query failed because another row already holds its dedupe key in the active_job
 * unique index. Drizzle wraps the driver error, so its `cause` is checked as well as the error.
 */
export function activeJobConflict(error: unknown): boolean {
  const causes = [error, error instanceof Error ? error.cause : undefined];
  return causes.some(
    (cause) =>
      typeof cause === "object" &&
      cause !== null &&
      Reflect.get(cause, "code") === "23505" &&
      Reflect.get(cause, "constraint") === "active_job",
  );
}

/**
 * Return a guild's parked work to the queue, due now with a fresh attempt budget and no stored
 * diagnostic (as retry.js does), so resumed work reads `… QUEUED` rather than a retry after an
 * error. Activation, a /config change and a restart with effects on (work parked `disabled` while
 * ENABLE_EFFECTS was off) all resume work this way.
 *
 * enqueue() only coalesces into queued, running or blocked rows (the active_job index), so a key
 * enqueued again while its row sat `disabled` gets a second row, and several parked rows can
 * share one dedupe key. Requeueing them all would violate that unique index. So, per key, only
 * the newest parked row is requeued, and only when no other active row already holds the key;
 * the rest close as succeeded with {skipped: "superseded"}, because the surviving row runs the
 * same work with the newest payload. A closed row keeps its `applied` list (reconcile.user's
 * record of role changes Discord actually received), and each sync run that tracked it tracks the
 * row that now carries its key instead, so the run never reports Completed before that work runs.
 * Losers close first, since a parked `blocked` row is itself in the index. Returns the requeued
 * job IDs.
 *
 * It needs a transaction client: the pair runs inside a savepoint, so a concurrent enqueue that
 * commits an active row for the same key between the two statements (a `disabled` row sits outside
 * active_job, so nothing blocks it) is retried rather than failing the caller's transaction.
 */
export async function requeueParked(
  client: PoolClient,
  guilds: readonly string[],
  statuses: readonly ParkedStatus[],
): Promise<string[]> {
  if (!guilds.length || !statuses.length) return [];
  for (let attempt = 1; ; attempt++) {
    await client.query("SAVEPOINT requeue_parked");
    try {
      const ids = await supersedeAndRequeue(client, guilds, statuses);
      await client.query("RELEASE SAVEPOINT requeue_parked");
      return ids;
    } catch (error) {
      // The unique violation is raised only after the conflicting enqueue committed, so the next
      // pass sees that row as the key's holder and closes the parked row as superseded instead.
      if (attempt >= REQUEUE_ATTEMPTS || !activeJobConflict(error)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT requeue_parked");
    }
  }
}

/** One pass of requeueParked: close the losers, requeue the survivors, then move run links. */
async function supersedeAndRequeue(
  client: PoolClient,
  guilds: readonly string[],
  statuses: readonly ParkedStatus[],
): Promise<string[]> {
  const db = orm(client);
  const other = alias(t.jobs, "other");
  // The same filter on the updated row and on the aliased row it is compared with.
  const parked = (table: { readonly guild_id: Column; readonly status: Column }) =>
    and(inArray(table.guild_id, [...guilds]), inArray(table.status, [...statuses]));
  // Active states this call doesn't requeue hold their key in any guild: the index is global.
  const holding = ACTIVE_STATES.filter((state) => !(statuses as readonly string[]).includes(state));
  const superseded = await db
    .update(t.jobs)
    .set({
      status: "succeeded",
      completed_at: sql`now()`,
      lease_until: null,
      last_error: null,
      // Keep reconcile.user's append-only `applied` evidence, as queue completion does: it is the
      // only record of role changes Discord actually received
      // (site/src/content/docs/deploy/monitoring.md).
      result: sql`jsonb_build_object('skipped','superseded') || jsonb_strip_nulls(jsonb_build_object('applied',${t.jobs.result}->'applied'))`,
    })
    .where(
      and(
        parked(t.jobs),
        exists(
          db
            .select({ id: other.id })
            .from(other)
            .where(
              and(
                eq(other.dedupe_key, t.jobs.dedupe_key),
                ne(other.id, t.jobs.id),
                or(
                  holding.length ? inArray(other.status, holding) : undefined,
                  // A newer parked row for the key (ties broken by ID) survives instead.
                  and(
                    parked(other),
                    or(
                      gt(other.created_at, t.jobs.created_at),
                      and(eq(other.created_at, t.jobs.created_at), gt(other.id, t.jobs.id)),
                    ),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: t.jobs.id });
  const requeued = await db
    .update(t.jobs)
    .set({ status: "queued", due_at: sql`now()`, attempts: 0, last_error: null })
    .where(parked(t.jobs))
    .returning({ id: t.jobs.id });
  if (superseded.length) {
    // A run that tracked a superseded row now tracks the one active row carrying that key's work
    // (the requeued survivor, or the row that already held the key), as enqueue() coalescing
    // would have arranged; its link to the closed row goes, so "N of M done" stays exact. Only
    // moved links are removed: a run never loses track of work without gaining its holder.
    const ids = superseded.map((row) => row.id);
    const loser = alias(t.jobs, "loser");
    const holder = alias(t.jobs, "holder");
    const holds = and(
      eq(holder.dedupe_key, loser.dedupe_key),
      inArray(holder.status, [...ACTIVE_STATES]),
    );
    await db
      .insert(t.syncRunJobs)
      .select(
        db
          .select({ run_id: t.syncRunJobs.run_id, job_id: holder.id })
          .from(t.syncRunJobs)
          .innerJoin(loser, eq(loser.id, t.syncRunJobs.job_id))
          .innerJoin(holder, holds)
          .where(inArray(t.syncRunJobs.job_id, ids)),
      )
      .onConflictDoNothing();
    await db
      .delete(t.syncRunJobs)
      .where(
        and(
          inArray(t.syncRunJobs.job_id, ids),
          exists(
            db
              .select({ id: holder.id })
              .from(loser)
              .innerJoin(holder, holds)
              .where(eq(loser.id, t.syncRunJobs.job_id)),
          ),
        ),
      );
  }
  return requeued.map((row) => row.id);
}

/**
 * Officer Lodestone notice keys (#29), per guild and FC, so these never share a key with each
 * other, the DevBot roster line (officer:<guild>) or the per-link missing-character notices:
 * enqueue() replaces an active row's payload, which let a success overwrite a pending degraded
 * notice before #29. They live here because Synchronization and Service (the FC unlink) both use
 * them.
 */
export const degradedNoticeKey = (guild: string, fc: string): string =>
  `officer:${guild}:degraded:${fc}`;
/** The recovery line that follows a posted degraded notice (#29). */
export const recoveredNoticeKey = (guild: string, fc: string): string =>
  `officer:${guild}:recovered:${fc}`;

/**
 * Close a key's unstarted rows (queued, blocked or parked `disabled`) as succeeded with
 * {skipped: reason}, the way supersedeAndRequeue closes superseded rows: for work that became
 * pointless before it ran, such as a degraded notice once the roster recovered or the FC was
 * unlinked (#29). A running row is left to finish. If a worker claims a row concurrently, READ
 * COMMITTED re-checks it under its row lock, finds it `running`, and leaves it alone.
 */
export async function closeUnstarted(
  client: Connection,
  key: string,
  reason: string,
): Promise<void> {
  await orm(client)
    .update(t.jobs)
    .set({
      status: "succeeded",
      completed_at: sql`now()`,
      lease_until: null,
      last_error: null,
      result: { skipped: reason },
    })
    .where(
      and(eq(t.jobs.dedupe_key, key), inArray(t.jobs.status, ["queued", "blocked", "disabled"])),
    );
}

/**
 * The operator retry (retry.js): put one of a guild's blocked, failed or disabled jobs back in the
 * queue, due now with a fresh attempt budget and no stored diagnostic. Completed effects can't be
 * replayed this way. A failed or disabled row sits outside active_job, so a newer row may already
 * hold its dedupe key; requeueing it would violate that index, so the retry refuses and names the
 * newer row, which already carries the same work.
 */
export async function retryJob(client: PoolClient, guild: string, job: string): Promise<void> {
  const db = orm(client);
  const [target] = await db
    .select({ key: t.jobs.dedupe_key })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.id, job),
        eq(t.jobs.guild_id, guild),
        inArray(t.jobs.status, ["blocked", "failed", "disabled"]),
      ),
    )
    .for("update");
  if (!target) throw new Error("No retryable job with that ID belongs to this guild.");
  const [active] = await db
    .select({ id: t.jobs.id, status: t.jobs.status })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.dedupe_key, target.key),
        ne(t.jobs.id, job),
        inArray(t.jobs.status, [...ACTIVE_STATES]),
      ),
    );
  if (active)
    throw new Error(
      `A newer job for this work is already ${active.status}: ${active.id}. Retry that job if it is blocked; otherwise it runs on its own.`,
    );
  try {
    await db
      .update(t.jobs)
      // A retried row is unfinished again, so its previous failure time no longer applies.
      .set({
        status: "queued",
        attempts: 0,
        due_at: sql`now()`,
        last_error: null,
        completed_at: null,
      })
      .where(eq(t.jobs.id, job));
  } catch (error) {
    // An enqueue for the same key committed after the check above: refuse the same way.
    if (!activeJobConflict(error)) throw error;
    throw new Error(
      "A newer job for this work became active while retrying; nothing was changed. Run the retry again to see it.",
    );
  }
}

/** Attempts at or beyond this count end an ordinary retry as a failed delivery. */
const MAX_ATTEMPTS = 8;
/**
 * Waits are logged at debug, so a lock or ordering head that never clears would otherwise be
 * invisible: each wait re-queues the row one second (or its retryAfter) later forever. Once a row
 * has waited continuously for longer than this, its waits escalate to warn so the stall appears in
 * normal logs. Row age alone is no stall signal: re-queued disabled/blocked rows keep created_at.
 */
export const STALE_WAIT_MS = 10 * 60 * 1000;

/** Severity names match the pino methods used by the composition root. */
export type JobLevel = "debug" | "info" | "warn" | "error";
/** One classified failed/waiting attempt: persisted state, retry timing, and log severity. */
export type JobOutcome = {
  /** Failure code, or the Discord/transport classification for other errors. */
  code: string;
  /** Stored status, or "unchanged" when the worker lost its lease and wrote nothing. */
  status: "queued" | "blocked" | "disabled" | "succeeded" | "failed" | "unchanged";
  /**
   * Written waiting outcomes return their attempt, so contention never exhausts the retry budget.
   * A lost lease writes nothing; claim() reclaims (and counts) the expired row on its own.
   */
  waiting: boolean;
  delaySeconds: number;
  /** Stored as last_error; approved Failure messages or fixed guidance, never raw SDK errors. */
  diagnostic: string;
  category: "wait" | "lease" | "gone" | "blocked" | "disabled" | "retry" | "failed";
  /** Error class (plus Discord's numeric code) for logs; never the error's message or body. */
  source: string;
  level: JobLevel;
};

/** Classify a caught job error once; waitingMs (the continuous wait streak) escalates stalls. */
export function jobOutcome(error: unknown, attempts: number, waitingMs = 0): JobOutcome {
  const discord = error instanceof DiscordAPIError ? Number(error.code) : undefined;
  const code =
    error instanceof Failure
      ? error.code
      : discord !== undefined && DISCORD_BLOCKED_CODES.has(discord)
        ? "blocked"
        : discord !== undefined && [10004, 10007, 10013].includes(discord)
          ? "gone"
          : "transient";
  // The catalog's waiting codes (ordering, locks, cooldowns, new inputs, a lost lease) are shared
  // with reply presentation, so a job line and its logged outcome agree on what is waiting.
  const waiting = WAITING_CODES.has(code);
  // Waiting for ordering/locks is not a failed delivery and must not exhaust attempts.
  const status =
    code === "lease_lost"
      ? "unchanged"
      : waiting
        ? "queued"
        : code === "blocked"
          ? "blocked"
          : code === "disabled"
            ? "disabled"
            : code === "gone"
              ? "succeeded"
              : code === "dm_blocked" || code === "invalid_job" || attempts >= MAX_ATTEMPTS
                ? "failed"
                : "queued";
  const delaySeconds =
    code === "lease_lost"
      ? 0
      : Math.max(
          error instanceof Failure ? error.retryAfter : 0,
          waiting ? 1 : Math.min(3600, 2 ** attempts + Math.random() * 5),
        );
  const diagnostic =
    // Store actionable approved messages, never raw credential-bearing SDK error objects.
    error instanceof Failure
      ? `${code}: ${error.message}`
      : code === "blocked"
        ? "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate."
        : code;
  const category =
    code === "lease_lost"
      ? "lease"
      : waiting
        ? "wait"
        : status === "succeeded"
          ? "gone"
          : status === "blocked" || status === "disabled"
            ? status
            : status === "failed"
              ? "failed"
              : "retry";
  // Expected waits stay quiet; stalls, retries and blocks warn; only terminal failures are errors.
  const level =
    category === "lease"
      ? "warn"
      : category === "wait"
        ? waitingMs > STALE_WAIT_MS
          ? "warn"
          : "debug"
        : category === "gone" || code === "dm_blocked"
          ? "info"
          : category === "failed"
            ? "error"
            : "warn";
  const source =
    error instanceof Failure
      ? "Failure"
      : discord !== undefined
        ? `DiscordAPIError[${discord}]`
        : error instanceof Error
          ? error.name
          : "unknown";
  return { code, status, waiting, delaySeconds, diagnostic, category, source, level };
}

/** Classified attempt outcomes are observed separately from worker-level infrastructure errors. */
export type QueueEvent =
  | {
      type: "job";
      job: Job;
      outcome: JobOutcome;
      /** Time spent in this attempt, from perform start to the recorded outcome. */
      durationMs: number;
      /** Queue latency: how long the row was due before this attempt started. */
      waitMs: number;
      /** Time since the row was created, spanning every retry and superseding generation. */
      ageMs: number;
    }
  | { type: "worker"; error: unknown; job?: Job };

/** Non-negative elapsed milliseconds; application and database clocks both use UTC. */
const since = (instant: Date, now: number): number =>
  // Re-wrapping tolerates hand-built jobs whose timestamps arrive as ISO strings.
  Math.max(0, now - new Date(instant).getTime());

/** A small worker pool uses leases rather than keeping database transactions open during I/O. */
export class Queue {
  private stopping = false;
  private running: Promise<void>[] = [];
  /**
   * When each row's current run of consecutive waits began. In-memory is enough for the single
   * writer; after a restart a streak simply starts again from the next wait.
   */
  private readonly waitingSince = new Map<string, number>();
  /**
   * Dispatch and the clock are injected so ownership/recovery behavior can be tested independently.
   * `kinds` is what this worker may claim (the dispatcher's own, src/jobs/kinds.ts); tests that
   * queue a kind of their own widen it.
   */
  constructor(
    private readonly db: Database,
    private readonly dispatch: (job: Job, guard: () => Promise<void>) => Promise<unknown>,
    private readonly observe: (event: QueueEvent) => void,
    private readonly now: () => number = Date.now,
    private readonly kinds: readonly string[] = JOB_KINDS,
  ) {}
  /**
   * SKIP LOCKED lets workers claim distinct rows and reclaim expired leases atomically. Only kinds
   * this release knows are claimed: another release's work is left queued, not failed.
   */
  async claim(): Promise<Job | undefined> {
    const token = randomUUID();
    const db = this.db.orm;
    const candidate = db.$with("candidate").as(
      db
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .leftJoin(t.guilds, eq(t.guilds.id, t.jobs.guild_id))
        .where(
          and(
            or(
              and(eq(t.jobs.status, "queued"), lte(t.jobs.due_at, sql`now()`)),
              and(eq(t.jobs.status, "running"), lt(t.jobs.lease_until, sql`now()`)),
            ),
            or(isNull(t.jobs.guild_id), eq(t.guilds.active, true)),
            inArray(t.jobs.kind, [...this.kinds]),
          ),
        )
        .orderBy(asc(t.jobs.due_at))
        .limit(1)
        .for("update", { of: t.jobs, skipLocked: true }),
    );
    const [row] = await db
      .with(candidate)
      .update(t.jobs)
      .set({
        status: "running",
        lease_token: token,
        lease_until: sql`now()+interval '45 seconds'`,
        attempts: sql`${t.jobs.attempts}+1`,
      })
      .from(candidate)
      .where(eq(t.jobs.id, candidate.id))
      .returning();
    if (!row) return undefined;
    if (!row.lease_token) throw new Error("Claimed job has no lease token");
    return { ...row, lease_token: row.lease_token };
  }
  /** Extend ownership while work runs, then publish only through the current lease token. */
  async perform(job: Job): Promise<void> {
    const started = this.now();
    const waitMs = since(job.due_at, started);
    const guard = async (): Promise<void> => {
      // One primary-key read distinguishes lost ownership from superseding inputs for diagnostics.
      const [row] = await this.db.orm
        .select({
          lease_token: t.jobs.lease_token,
          status: t.jobs.status,
          generation: t.jobs.generation,
          live: sql<boolean>`coalesce(${t.jobs.lease_until}>now(),false)`,
        })
        .from(t.jobs)
        .where(eq(t.jobs.id, job.id));
      if (!row || row.lease_token !== job.lease_token || !row.live || row.status !== "running")
        throw new Failure(
          "lease_lost",
          "Worker lease expired or was reclaimed; another worker owns this job.",
        );
      // Reconciliation also checks generation because its desired state can change mid-flight.
      if (job.kind.startsWith("reconcile.") && row.generation !== job.generation)
        throw new Failure(
          "superseded",
          `Reconciliation inputs changed (generation ${job.generation}→${row.generation}); recomputing current desired state.`,
        );
    };
    const heartbeat = setInterval(() => {
      void this.db.orm
        .update(t.jobs)
        .set({ lease_until: sql`now()+interval '45 seconds'` })
        .where(
          and(
            eq(t.jobs.id, job.id),
            eq(t.jobs.lease_token, job.lease_token),
            gt(t.jobs.lease_until, sql`now()`),
          ),
        )
        .catch((e: unknown) => this.observe({ type: "worker", error: e, job }));
    }, 10000);
    try {
      const result = await this.dispatch(job, guard);
      await guard();
      // Carry over only the append-only `applied` evidence written by earlier superseded passes;
      // every other key comes from this attempt so stale fields such as `skipped` never survive.
      const value = json(result ?? {});
      await this.db.orm
        .update(t.jobs)
        .set({
          status: sql`CASE WHEN ${t.jobs.generation}=${job.generation} THEN 'succeeded' ELSE 'queued' END`,
          // A run requeued for newer input gets a fresh attempt budget, as requeueParked and
          // retryJob give (2.29.0): otherwise a busy guild's status post, requeued once per
          // change, would spend one attempt per run and fail on the first transient error after
          // about seven.
          attempts: sql`CASE WHEN ${t.jobs.generation}=${job.generation} THEN ${t.jobs.attempts} ELSE 0 END`,
          completed_at: sql`now()`,
          lease_until: null,
          result: sql`CASE WHEN jsonb_typeof(${value}::jsonb)='object' THEN ${value}::jsonb || jsonb_strip_nulls(jsonb_build_object('applied',${t.jobs.result}->'applied')) ELSE ${value}::jsonb END`,
          last_error: null,
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)));
      this.waitingSince.delete(job.id);
    } catch (error) {
      const now = this.now();
      const ageMs = since(job.created_at, now);
      // Escalate only when this row has kept waiting since its streak began; a first wait (for
      // example an activation-time gateway echo on an old re-queued row) stays at debug.
      const first = this.waitingSince.get(job.id) ?? started;
      const outcome = jobOutcome(error, job.attempts, now - first);
      if (outcome.category === "wait") this.waitingSince.set(job.id, first);
      else this.waitingSince.delete(job.id);
      // A worker that lost its lease no longer owns the row, even if its token still matches an
      // expired or operator-changed lease; claim() reclaims expired running rows on its own.
      if (outcome.status !== "unchanged")
        await this.db.orm
          .update(t.jobs)
          .set({
            status: outcome.status,
            due_at: sql`now()+${outcome.delaySeconds}*interval '1 second'`,
            // When the job ended (2.24.1): a terminal failure is timestamped like a success, so
            // /sync status can tell whether the same work succeeded after it. Otherwise unfinished.
            completed_at:
              outcome.status === "failed" || outcome.status === "succeeded" ? sql`now()` : null,
            lease_until: null,
            last_error: outcome.diagnostic,
            attempts: outcome.waiting ? sql`greatest(0,${t.jobs.attempts}-1)` : t.jobs.attempts,
          })
          .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)))
          .catch((e: unknown) => this.observe({ type: "worker", error: e, job }));
      // Observe after the write attempt, so the log line follows (never precedes) the stored status.
      this.observe({ type: "job", job, outcome, durationMs: now - started, waitMs, ageMs });
    } finally {
      clearInterval(heartbeat);
    }
  }
  /** Poll with bounded concurrency; a worker-level failure does not stop unrelated work. */
  start(concurrency = 3): void {
    this.running = Array.from({ length: concurrency }, async () => {
      while (!this.stopping) {
        try {
          const job = await this.claim();
          if (job) await this.perform(job);
          else await Bun.sleep(500);
        } catch (error) {
          this.observe({ type: "worker", error });
          await Bun.sleep(2000);
        }
      }
    });
  }
  /** Stop new claims and allow current jobs to finish or be abandoned by the lifecycle deadline. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.running);
  }
}
