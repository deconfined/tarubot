/** TaruBot's application lifecycle is separate from module discovery and gateway wiring. */
import type { Logger } from "pino";
import type { PoolClient, QueryConfig, QueryResultRow } from "pg";
import type { Configuration } from "../config/env.js";
import { project } from "../config/project.js";
import type { DiscordGateway } from "../discord/gateway.js";
import { changelogDue } from "../domain/changelog.js";
import { Failure } from "../domain/values.js";
import type { LodestoneStatus } from "../infrastructure/lodestone/client.js";
import {
  orm,
  type Database,
  WRITER_LEASE_HOLDER,
  WRITER_LEASE_LOCK,
} from "../infrastructure/postgres/database.js";
import { and, eq, notInArray } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import {
  announceChangelog,
  enqueue,
  layoutGuildRoles,
  requeueParked,
  secureGuildChannels,
  type Queue,
} from "../jobs/queue.js";
import type { Service } from "./service.js";
import type { Synchronization } from "./synchronization.js";
import { capabilityMetrics } from "./metrics.js";
import {
  VisibilityAlerts,
  type VisibilityMonitor,
  type VisibilityStatus,
} from "./visibility-alerts.js";

/** The writer-lease key; defined beside migrate(), which also takes it, and re-exported here. */
export { WRITER_LEASE_LOCK };

/** Writer-lease timing and the lost-lease exit; production uses the defaults, tests shorten them. */
export interface LifecycleOptions {
  /** Delay between lease attempts while another writer holds the lock. */
  readonly leaseRetryMs: number;
  /** Continuous wait after which each waiting log escalates from info to warn. */
  readonly leaseWarnAfterMs: number;
  /** Interval between checks that the held lease's own session still answers and holds the lock. */
  readonly leaseCheckMs: number;
  /**
   * Client-side deadline for every statement on the lease session: each wait attempt and holder
   * probe, the periodic check and the unlock. A silently dead socket (failover, dropped NAT flow)
   * never raises an error, and the server-side statement_timeout cannot fire on a connection that
   * is gone, so only this bounds the wait.
   */
  readonly leaseQueryTimeoutMs: number;
  /**
   * Deadline for shutdown, after which the process exits anyway (with status 1 once the lease was
   * lost). A half-open socket can also hang pool.end() on a worker's checked-out client.
   */
  readonly stopDeadlineMs: number;
  /** Ends the process: after shutdown when a held lease's session was lost, or at the deadline. */
  readonly exit: (code: number) => void;
  /**
   * Periodic work after each scheduler pass while the bot holds the lease: since 2.18.0, the issue
   * reporter's trouble checks and delivery sweep. Its errors are reported, never fatal.
   */
  readonly tick: () => Promise<void>;
  /**
   * Work outside the queue that must finish before the lease is handed over, awaited beside the
   * queue's stop and within the same bound: since 2.28.0, a /suggest post still at GitHub, whose
   * audit row the next writer's limits count. Must never reject.
   */
  readonly drain: () => Promise<void>;
  /**
   * The officer alert about missing channel overrides and readiness's visibility counts (2.35.0,
   * #46), checked after each scheduler pass. Absent in production, where the constructor builds
   * VisibilityAlerts over the Service; tests supply a stand-in. Its errors are reported, never
   * fatal, and its counts never change readiness.
   */
  readonly visibility?: VisibilityMonitor;
}
const LIFECYCLE_DEFAULTS: LifecycleOptions = {
  leaseRetryMs: 5000,
  leaseWarnAfterMs: 60000,
  // A silent loss is noticed within about leaseCheckMs + leaseQueryTimeoutMs (40 s).
  leaseCheckMs: 30000,
  leaseQueryTimeoutMs: 10000,
  // Below the 30 s grace period supervisors allow between SIGTERM and SIGKILL.
  stopDeadlineMs: 27000,
  exit: (code) => process.exit(code),
  tick: async () => {},
  drain: async () => {},
};

/** Only pg_locks identifies the holder (shared with migrate()'s refusal). */
const LEASE_HOLDER = WRITER_LEASE_HOLDER;

/** The periodic lease check: does this very session (pg_backend_pid) still hold the lock? */
const LEASE_HELD = `SELECT EXISTS (SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
    AND classid = 0 AND objid = $1::bigint::oid AND objsubid = 1) AS held`;

/**
 * node-postgres honours a per-query read timeout (`query_timeout`, client.js), which its QueryConfig
 * type omits; every statement on the lease session carries one.
 */
type TimedQuery = QueryConfig & { query_timeout: number };

/** Owns readiness, application scheduling, and graceful release of durable work resources. */
export class ApplicationLifecycle {
  private readonly initialized = Promise.withResolvers<void>();
  /** Resolved once shutdown begins so a lease wait wakes at once instead of after its retry delay. */
  private readonly halted = Promise.withResolvers<void>();
  private readonly health: Bun.Server<undefined>;
  private readonly options: LifecycleOptions;
  /** The channel-override monitor (options.visibility, or VisibilityAlerts by default). */
  private readonly visibility: VisibilityMonitor;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private stopPromise: Promise<void> | undefined;
  /** The writer-lease acquisition that prepare() awaits; close() lets it settle before releasing. */
  private leasing: Promise<void> | undefined;
  /** Dedicated pool client whose session holds WRITER_LEASE_LOCK for the process lifetime. */
  private lease: PoolClient | undefined;
  private leaseHeld = false;
  /** Periodic check of the held lease session; see checkWriterLease. */
  private leaseCheck: ReturnType<typeof setInterval> | undefined;
  /** The in-flight check, which release awaits so the unlock never queues behind it. */
  private leaseChecking: Promise<void> | undefined;
  /** Set once the lease session errored, went silent or lost the lock; release then destroys it. */
  private leaseBroken = false;
  /** Exit status the shutdown deadline uses; a lost or failed lease session makes it 1. */
  private exitCode = 0;
  private ready = false;
  private databaseReady = false;
  private stopping = false;
  private capabilities: unknown = { synchronization: "initializing" };

  constructor(
    private readonly config: Configuration,
    private readonly db: Database,
    private readonly gateway: DiscordGateway,
    private readonly app: Service,
    private readonly sync: Synchronization,
    private readonly queue: Queue,
    private readonly log: Logger,
    private readonly report: (error: unknown, operation: string) => void,
    options: Partial<LifecycleOptions> = {},
  ) {
    this.options = { ...LIFECYCLE_DEFAULTS, ...options };
    // Construction stores collaborators only; the first pass runs after start(), under the lease.
    this.visibility =
      this.options.visibility ??
      new VisibilityAlerts(app, (guild) => this.allowsGuild(guild), {
        log: (level, fields, message) => this.log[level](fields, message),
        report: (error, operation) => this.report(error, operation),
      });
    // Probes depend on local readiness, never on a live Lodestone acquisition.
    this.health = Bun.serve<undefined>({
      port: config.HEALTH_PORT,
      fetch: (request) => this.probe(request),
    });
  }

  /** The probe server's bound address; tests listen on port 0 and read the chosen port here. */
  get healthUrl(): URL {
    return this.health.url;
  }

  /** Shared scope gate for every installed feature's guild-specific event handling. */
  allowsGuild(guildId: string): boolean {
    return !this.config.TEST_GUILD_ID || guildId === this.config.TEST_GUILD_ID;
  }

  /** Module listeners consult this before admitting work during termination. */
  isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Check migrations, wait for the single-writer lease, then check them again. main.ts logs in only after this
   * resolves, so no gateway event, startup write or queue worker runs before the lease is held.
   */
  async prepare(): Promise<void> {
    await this.db.schema();
    this.databaseReady = true;
    this.leasing ??= this.acquireWriterLease();
    await this.leasing;
    // Check again while holding the lease. A bot that passed the first check and then waited
    // (for example an old release restarting during a migration) could otherwise take the lease
    // after the migration commits and write with old code; this refuses it, and main.ts stops,
    // which releases the lease, and exits non-zero.
    await this.db.schema();
  }

  /**
   * Hold WRITER_LEASE_LOCK on a dedicated pool client for the process lifetime. While another
   * writer (for example an overlapping deployment) holds it, retry every leaseRetryMs; liveness
   * stays 200 and readiness stays false until this process holds it.
   */
  private async acquireWriterLease(): Promise<void> {
    const client = await this.db.pool.connect();
    this.lease = client;
    // Losing this session frees the lock for another writer; see leaseLost.
    client.on("error", this.leaseLost);
    const started = performance.now();
    const waited = () => Math.round(performance.now() - started);
    for (;;) {
      if (this.stopping) throw this.stoppedBeforeLease();
      const attempt = await this.waitStatement<{ locked: boolean }>(
        client,
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      );
      if (attempt.rows[0]?.locked) {
        this.leaseHeld = true;
        // A shutdown that began during the attempt still unlocks in close(); never report success.
        if (this.stopping) throw this.stoppedBeforeLease();
        this.log.info(
          { lock: WRITER_LEASE_LOCK, waitedMs: waited() },
          "Database writer lease acquired",
        );
        // The session is otherwise idle, so only a query shows that it is still alive.
        this.leaseCheck = setInterval(() => {
          this.leaseChecking ??= this.checkWriterLease().finally(() => {
            this.leaseChecking = undefined;
          });
        }, this.options.leaseCheckMs);
        return;
      }
      const holder = await this.waitStatement<{ pid: number }>(client, LEASE_HOLDER);
      const waitedMs = waited();
      this.log[waitedMs >= this.options.leaseWarnAfterMs ? "warn" : "info"](
        { lock: WRITER_LEASE_LOCK, holderPid: holder.rows[0]?.pid, waitedMs },
        "Waiting for the database writer lease held by another TaruBot writer; readiness stays false.",
      );
      await Promise.race([Bun.sleep(this.options.leaseRetryMs), this.halted.promise]);
    }
  }

  /** One statement on the lease session, bounded by the client-side read timeout. */
  private leaseStatement(text: string): TimedQuery {
    return { text, values: [WRITER_LEASE_LOCK], query_timeout: this.options.leaseQueryTimeoutMs };
  }

  /**
   * A wait-loop statement on the lease session, bounded like the check and the unlock: a half-open
   * socket would otherwise hang prepare() (and a SIGTERM, which lets the attempt settle first) until
   * TCP retransmission gives up, while readiness stays false and liveness keeps the process. pg's
   * query_timeout neither destroys the connection nor emits 'error', so any failure marks the
   * session broken here; release then destroys it instead of returning it to the pool. prepare()
   * rejects, main.ts stops and exits non-zero, and the supervisor restarts with a fresh session.
   */
  private async waitStatement<R extends QueryResultRow>(client: PoolClient, text: string) {
    try {
      return await client.query<R>(this.leaseStatement(text));
    } catch (error) {
      this.leaseBroken = true;
      this.exitCode = 1;
      this.log.error(
        { lock: WRITER_LEASE_LOCK },
        "The database writer lease session failed while waiting; stopping so a restart can wait again.",
      );
      throw error;
    }
  }

  /**
   * Nothing else is ever sent on the lease session, so a half-open connection (a failover whose old
   * primary vanished, a dropped NAT flow) would never raise 'error' while PostgreSQL has already
   * freed the lock. Ask the session itself, with a deadline; no answer, an error or a missing lock
   * is a lost lease. Never rejects.
   */
  private async checkWriterLease(): Promise<void> {
    const client = this.lease;
    if (!client || !this.leaseHeld || this.stopping) return;
    try {
      const result = await client.query<{ held: boolean }>(this.leaseStatement(LEASE_HELD));
      if (result.rows[0]?.held !== true)
        this.leaseLost(new Error("The writer lease session no longer holds the lock."));
    } catch (error) {
      this.leaseLost(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** prepare() rejects with this so main.ts never logs in during a shutdown. */
  private stoppedBeforeLease(): Failure {
    return new Failure("stopping", "Shutdown began before the database writer lease was held.");
  }

  /**
   * A held lease's session ended (database restart, failover or a terminated backend) or stopped
   * answering the periodic check, so PostgreSQL has released, or will release, the lock and another
   * writer may take it. Stop, then exit non-zero so the supervisor restarts this process, which
   * waits for the lease again.
   */
  private readonly leaseLost = (error: Error): void => {
    // Whatever the phase, this session can no longer be trusted: release destroys it.
    this.leaseBroken = true;
    if (!this.leaseHeld || this.stopping) return;
    this.leaseHeld = false;
    // Also the shutdown deadline's status, should shutdown itself hang on the dead connection.
    this.exitCode = 1;
    this.report(error, "writer-lease");
    this.log.error(
      { lock: WRITER_LEASE_LOCK },
      "Database writer lease lost; stopping this writer.",
    );
    void this.stop()
      .catch((stopError: unknown) => this.report(stopError, "shutdown"))
      .finally(() => this.options.exit(1));
  };

  /** Unlock and return the lease client; a broken session is destroyed, which frees its locks. */
  private async releaseWriterLease(): Promise<void> {
    // An in-flight attempt settles first (halted wakes its wait), so the client is never shared.
    await this.leasing?.catch(() => undefined);
    if (this.leaseCheck) clearInterval(this.leaseCheck);
    // A running check is bounded by leaseQueryTimeoutMs and never rejects.
    await this.leaseChecking;
    const client = this.lease;
    if (!client) return;
    this.lease = undefined;
    client.off("error", this.leaseLost);
    const held = this.leaseHeld;
    this.leaseHeld = false;
    // An errored or silent session is never unlocked over or pooled again; destroying it ends the
    // backend's session, which is what frees a lock it may still hold.
    if (this.leaseBroken) {
      client.release(true);
      return;
    }
    try {
      if (held) await client.query(this.leaseStatement("SELECT pg_advisory_unlock($1::bigint)"));
      client.release();
    } catch (error) {
      client.release(error instanceof Error ? error : true);
    }
  }

  /** Main awaits the dynamically installed ready handler rather than registering its own. */
  whenReady(): Promise<void> {
    return this.initialized.promise;
  }

  /** Called once by client-ready.event: reconcile presence, then start application workers. */
  async start(): Promise<void> {
    try {
      // Defense in depth: startup writes and the queue belong to the lease holder only.
      if (!this.leaseHeld)
        throw new Failure(
          "writer_lease",
          "Startup requires the database writer lease; prepare() must complete first.",
        );
      if (this.gateway.client.application?.id !== this.config.DISCORD_APPLICATION_ID) {
        throw new Failure(
          "configuration",
          "DISCORD_APPLICATION_ID does not match the logged-in bot application.",
        );
      }
      const { resumed, announced } = await this.db.transaction(async (client) => {
        const db = orm(client);
        const present = [...this.gateway.client.guilds.cache.keys()].filter((guild) =>
          this.allowsGuild(guild),
        );
        /** Present guilds whose own effects flag is on (activated, or never imported). */
        const live: string[] = [];
        /** Guilds given an update post for the running version. */
        let announced = 0;
        await db
          .update(t.guilds)
          .set({ active: false })
          .where(
            and(
              notInArray(t.guilds.id, present),
              this.config.TEST_GUILD_ID ? eq(t.guilds.id, this.config.TEST_GUILD_ID) : undefined,
            ),
          );
        for (const guild of present) {
          const configured = await db
            .update(t.guilds)
            .set({ active: true })
            .where(eq(t.guilds.id, guild))
            .returning({
              id: t.guilds.id,
              access_policy_enabled: t.guilds.access_policy_enabled,
              role_layout_enabled: t.guilds.role_layout_enabled,
              effects_enabled: t.guilds.effects_enabled,
              changelog_channel_id: t.guilds.changelog_channel_id,
              changelog_version: t.guilds.changelog_version,
            });
          const row = configured[0];
          if (row) {
            await enqueue(client, "reconcile.guild", `guild:${guild}`, {}, guild);
            // Layout-disabled guilds (for example an imported server) get no presentation work.
            if (row.role_layout_enabled) await layoutGuildRoles(client, guild);
            if (row.access_policy_enabled) await secureGuildChannels(client, guild);
            // An update post when this version is newer than the last one the guild was told
            // about (2.25.0). Queued whatever the effects switches say: a paused guild parks it,
            // and activation or resumed effects post it at once. A restart on the same version
            // queues nothing, unless a post for it is still pending: that merges, as a retry.
            if (row.changelog_channel_id && changelogDue(row.changelog_version, project.version)) {
              await announceChangelog(client, guild);
              announced++;
            }
            if (row.effects_enabled) live.push(guild);
          }
        }
        // Work the dispatcher parked `disabled` while ENABLE_EFFECTS was off resumes once the
        // deployment runs with effects on again, as receipts promise ("once Discord changes are
        // turned back on"). An unactivated guild's parked work keeps waiting for activation, and
        // blocked work still needs its fix first (a /config change or retry.js requeues it).
        return {
          resumed: this.config.ENABLE_EFFECTS
            ? await requeueParked(client, live, ["disabled"])
            : [],
          announced,
        };
      });
      // Counts only: job payloads never reach the log.
      if (resumed.length)
        this.log.info(
          { requeued: resumed.length },
          "Requeued work held while Discord changes were off",
        );
      if (announced)
        this.log.info({ guilds: announced, version: project.version }, "Queued update posts");
      // The writer follows the selector repository's HEAD (2.21.0: in the bot, no sidecar); the
      // first check runs in the background, so readiness never waits for GitHub.
      this.app.lodestone.start();
      this.queue.start();
      this.monitor = setInterval(() => {
        void this.observe().catch((error: unknown) => this.report(error, "scheduler"));
      }, 30000);
      await this.sync.schedule();
      this.ready = true;
      this.log.info({ runtime: Bun.version }, "TaruBot ready");
      this.initialized.resolve();
    } catch (error) {
      // Propagate startup failure both to the event diagnostic and the waiting bootstrap.
      this.initialized.reject(error);
      throw error;
    }
  }

  /** Refresh cheap capability metrics separately from upstream availability. */
  private async observe(): Promise<void> {
    try {
      await this.db.query("SELECT 1");
      this.databaseReady = true;
      await this.sync.schedule();
      this.capabilities = await capabilityMetrics(this.db.orm);
      this.log.info({ metrics: this.capabilities }, "Capability status");
    } catch (error) {
      this.databaseReady = false;
      throw error;
    }
    // Reporting trouble must never make the scheduler itself look failed.
    await this.options.tick().catch((error: unknown) => this.report(error, "issue reports"));
    // The officer alert about missing channel overrides (2.35.0, #46): after the issue reporter,
    // so a failure here is reported like any other, and never fatal to the scheduler.
    await this.visibility
      .check()
      .catch((error: unknown) => this.report(error, "visibility alerts"));
  }

  /** What /health/ready reports, for issue reports' context as well as the probe. */
  status(): {
    live: boolean;
    ready: boolean;
    database: boolean;
    writerLease: boolean;
    discord: boolean;
    effects: boolean;
    publicTestResponses: boolean;
    capabilities: unknown;
    lodestone: LodestoneStatus;
    visibility: VisibilityStatus;
  } {
    const available =
      !this.stopping &&
      this.ready &&
      this.leaseHeld &&
      this.databaseReady &&
      this.db.healthy &&
      this.gateway.client.isReady();
    return {
      live: !this.stopping,
      ready: available,
      database: this.databaseReady && this.db.healthy,
      // False while another writer holds the lease; liveness is unaffected.
      writerLease: this.leaseHeld,
      discord: this.gateway.client.isReady(),
      effects: this.config.ENABLE_EFFECTS,
      publicTestResponses: Boolean(this.config.TEST_GUILD_ID) && this.config.PUBLIC_TEST_RESPONSES,
      capabilities: this.capabilities,
      // Informational (the sidecar's /health until 2.21.0): a Lodestone outage never fails readiness.
      lodestone: this.app.lodestone.status(),
      // Informational (2.35.0, #46): channels missing TaruBot's override, counted as if
      // Administrator were off, and onboarding's pending channels. Never part of `ready`.
      visibility: this.visibilityStatus(),
    };
  }

  /**
   * The monitor's last pass, or all nulls if reading it throws: a probe never fails over an
   * informational count (and isn't reported, since probes run every few seconds).
   */
  private visibilityStatus(): VisibilityStatus {
    try {
      const { missing, onboardingPending, checked, checkedAt } = this.visibility.status();
      return { missing, onboardingPending, checked, checkedAt };
    } catch {
      return { missing: null, onboardingPending: null, checked: null, checkedAt: null };
    }
  }

  /** Report application readiness without turning a Lodestone outage into a process failure. */
  private probe(request: Request): Response {
    const liveness = new URL(request.url).pathname === "/health/live";
    const status = this.status();
    return Response.json(status, { status: liveness || status.ready ? 200 : 503 });
  }

  /** Stop admission once, cancel upstream work, and leave uncompleted leases recoverable. */
  stop(): Promise<void> {
    this.stopPromise ??= this.close();
    return this.stopPromise;
  }

  /** Cleanup is shared by startup failures and process signals. */
  private async close(): Promise<void> {
    // A hung shutdown still ends: 0 for an ordinary stop, 1 once the lease was lost.
    const hardStop = setTimeout(
      () => this.options.exit(this.exitCode),
      this.options.stopDeadlineMs,
    );
    this.stopping = true;
    this.ready = false;
    // Wake a lease wait at once; prepare() then rejects and login never starts.
    this.halted.resolve();
    if (this.monitor) clearInterval(this.monitor);
    if (this.leaseCheck) clearInterval(this.leaseCheck);
    this.app.lodestone.stop();
    // Workers and any drained work (a /suggest post) finish while the gateway can still reply.
    await Promise.race([Promise.all([this.queue.stop(), this.options.drain()]), Bun.sleep(20000)]);
    await this.gateway.client.destroy();
    await this.health.stop(true);
    // Hand the lease over only once this process's workers and gateway have stopped writing.
    // pool.end() would otherwise wait on the checked-out lease client.
    await this.releaseWriterLease();
    await this.db.close();
    clearTimeout(hardStop);
  }
}
