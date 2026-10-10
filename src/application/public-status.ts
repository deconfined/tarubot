/**
 * The public status page's data (2.41.0, owner decisions of 2026-10-09): an in-memory snapshot of
 * TaruBot's status that a timer refreshes every minute, and the 90-day history behind its uptime
 * bars. /status (src/web/server.ts) only ever reads snapshot(): a visit costs no database query and
 * no Discord request, so anyone can open it without reaching either (THREAT_MODEL W1).
 *
 * The timer reads readiness from memory (ApplicationLifecycle.status(), the same booleans
 * /health/ready reports), the Lodestone's state from its client, and whether Discord changes are
 * paused from one small query. In each five-minute bucket, while this process holds the writer
 * lease, it also writes one sample (idempotent: the bucket is the key), deletes samples older than
 * 90 days (never the first one, which marks where the history starts) and recounts the history.
 * The counts stay in memory, and every snapshot works the history out from them afresh: a bucket
 * with no sample counts as down as soon as it has passed, so time TaruBot wasn't running, or
 * couldn't write a sample, shows on the page as it should, even while the database is down.
 *
 * Samples hold process-wide state and the version only: no server, member or visitor data.
 */
import { and, eq, gt, gte, lt, min, sql } from "drizzle-orm";
import { project } from "../config/project.js";
import {
  type ChangesState,
  DAY_MS,
  HISTORY_DAYS,
  type LodestoneState,
  type OverallStatus,
  overallStatus,
  SAMPLE_INTERVAL_MS,
  type SampleCount,
  type StatusComponents,
  sampleBucket,
  type UptimeHistory,
  uptimeHistory,
} from "../domain/uptime.js";
import type { Database } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import type { Reporter } from "./reporting.js";

/** How often the snapshot is refreshed; samples are written once per five-minute bucket. */
export const STATUS_REFRESH_MS = 60_000;

/** What the page shows. Replaced as a whole on every refresh, never changed in place. */
export interface StatusSnapshot {
  /** When the timer took it. */
  readonly takenAt: Date;
  /** The running release (package.json), which every page footer shows too. */
  readonly version: string;
  /** Readiness, as /health/ready reports it. */
  readonly ready: boolean;
  readonly overall: OverallStatus;
  readonly components: StatusComponents;
  /** Null until this process has written and counted its first sample. */
  readonly history: UptimeHistory | null;
}

/** One sample, as stored: its bucket, readiness, the components and the version that wrote it. */
export interface StatusSample extends StatusComponents {
  /** A bucket's start (sampleBucket). */
  readonly sampledAt: Date;
  readonly ready: boolean;
  readonly version: string;
}

/** Where samples live: PostgreSQL in production (PgStatusSamples), memory in tests. */
export interface StatusSampleStore {
  /** Insert the sample unless its bucket already has one. */
  record(sample: StatusSample): Promise<void>;
  /**
   * Delete the samples from before `before`, except the earliest of all, which marks where the
   * history starts (uptimeHistory's `first`); returns how many went.
   */
  prune(before: Date): Promise<number>;
  /** Ready samples per UTC day and version since `since`, and the earliest sample kept. */
  counts(since: Date): Promise<{ readonly first: Date | null; readonly counts: SampleCount[] }>;
}

/** The readiness fields the snapshot reads (ApplicationLifecycle.status()). */
export interface StatusReadiness {
  readonly ready: boolean;
  readonly discord: boolean;
  readonly database: boolean;
  readonly writerLease: boolean;
  readonly lodestone: { readonly cooldownSeconds: number };
}

/** Where the timer reads its state. main.ts wires the real ones; tests and the harness fake them. */
export interface StatusSources {
  /** In memory: ApplicationLifecycle.status(). */
  readonly readiness: () => StatusReadiness;
  /** In memory: whether the Lodestone's latest request went unanswered (its reachability). */
  readonly lodestoneFailing: () => boolean;
  /** Whether Discord changes are paused in any server TaruBot serves; may read the database. */
  readonly changesPaused: () => Promise<boolean>;
  readonly samples: StatusSampleStore;
}

/** PublicStatus's seams; production passes only `report`. */
export interface PublicStatusOptions {
  /** Trouble writing or counting samples is reported at warn, once per streak. */
  readonly report?: Reporter;
  /** The clock; defaults to the system's. */
  readonly now?: () => Date;
  /** Defaults to STATUS_REFRESH_MS. */
  readonly refreshMs?: number;
}

/**
 * The Lodestone as the page names it: a cooldown after a 429 is "cooling down" (the gate holds
 * new requests); otherwise "unreachable" while its latest request went unanswered, until one is
 * answered again.
 */
function lodestoneState(readiness: StatusReadiness, failing: boolean): LodestoneState {
  if (readiness.lodestone.cooldownSeconds > 0) return "cooling_down";
  return failing ? "unreachable" : "available";
}

/** The snapshot owner. One per process; main.ts starts it once TaruBot is ready. */
export class PublicStatus {
  private readonly now: () => Date;
  private readonly refreshMs: number;
  private current: StatusSnapshot | null = null;
  /** The last count of the samples, kept in memory; null until the first one succeeds. */
  private counted: { readonly first: Date | null; readonly counts: readonly SampleCount[] } | null =
    null;
  /** The last answer about paused changes, kept while the database can't be asked. */
  private changes: ChangesState = "live";
  /** The bucket this process last wrote and counted (epoch milliseconds). */
  private sampled: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The refresh in progress; a tick while one runs joins it. */
  private running: Promise<void> | undefined;
  /** Once stop() has begun, no sample is written: a stopping process isn't the writer for long. */
  private stopped = false;
  /** Whether the last sample attempt failed, so a failure streak is reported once. */
  private failing = false;

  constructor(
    private readonly sources: StatusSources,
    private readonly options: PublicStatusOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.refreshMs = options.refreshMs ?? STATUS_REFRESH_MS;
  }

  /** The latest snapshot, or null before start(). Reads memory only. */
  snapshot(): StatusSnapshot | null {
    return this.current;
  }

  /**
   * Publish a first snapshot from memory at once, then refresh now and every refreshMs on an
   * unref'd timer. Never rejects; calling it again does nothing.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.refreshMs);
    this.timer.unref();
  }

  /** Stop the timer and wait for a refresh in progress, so nothing writes after the drain. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /**
   * One refresh; never rejects. Tests call it directly. The snapshot is published from memory
   * first, on every tick, so a slow or hung database (whose query the refresh in progress may be
   * waiting on) never freezes the page: readiness already says the database is gone. The database
   * work is single-flight: a tick while it runs joins it.
   */
  tick(): Promise<void> {
    this.publish(this.now(), this.sources.readiness());
    this.running ??= this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * The history at `now`, from the last count, with no database work. Today's expected samples run
   * to the bucket last written, or to the latest bucket that has wholly passed if that's later:
   * while samples can't be written (the database is down, say) each bucket that passes without
   * one counts as down at once, as it will for good, since a sample is only ever written for the
   * current bucket. The current bucket counts once it's written, or once it has passed.
   */
  private historyAt(now: Date): UptimeHistory | null {
    if (this.counted === null || this.sampled === null) return null;
    const passed = sampleBucket(now).getTime() - SAMPLE_INTERVAL_MS;
    const latest = new Date(Math.max(this.sampled, passed));
    return uptimeHistory(this.counted.counts, this.counted.first, latest);
  }

  /** The snapshot from what is known now, with the history worked out from the last count. */
  private publish(now: Date, readiness: StatusReadiness): StatusSnapshot {
    const components: StatusComponents = {
      discord: readiness.discord === true,
      database: readiness.database === true,
      lodestone: lodestoneState(readiness, this.sources.lodestoneFailing()),
      changes: this.changes,
    };
    const ready = readiness.ready === true;
    this.current = {
      takenAt: now,
      version: project.version,
      ready,
      overall: overallStatus(ready, components),
      components,
      history: this.historyAt(now),
    };
    return this.current;
  }

  private async refresh(): Promise<void> {
    try {
      this.changes = (await this.sources.changesPaused()) ? "paused" : "live";
    } catch {
      // The database is down or slow: keep the last answer. Its own component and readiness say
      // so, and the lifecycle's scheduler reports the outage.
    }
    const now = this.now();
    const readiness = this.sources.readiness();
    const snapshot = this.publish(now, readiness);
    const bucket = sampleBucket(now);
    if (this.stopped || !readiness.writerLease || this.sampled === bucket.getTime()) return;
    try {
      const { samples } = this.sources;
      await samples.record({
        sampledAt: bucket,
        ready: snapshot.ready,
        ...snapshot.components,
        version: snapshot.version,
      });
      await samples.prune(new Date(bucket.getTime() - HISTORY_DAYS * DAY_MS));
      // From midnight UTC on the oldest day the page shows.
      const since = Math.floor(bucket.getTime() / DAY_MS) * DAY_MS - (HISTORY_DAYS - 1) * DAY_MS;
      this.counted = await samples.counts(new Date(since));
      this.sampled = bucket.getTime();
      this.failing = false;
      this.publish(now, readiness);
    } catch (error) {
      // Retried on the next tick, inside the same bucket while it lasts; record() is idempotent.
      if (!this.failing) this.options.report?.(error, "status samples", { level: "warn" });
      this.failing = true;
    }
  }
}

/** The PostgreSQL store, through Drizzle on the bot's pool with bound values only. */
export class PgStatusSamples implements StatusSampleStore {
  constructor(private readonly db: Database) {}

  async record(sample: StatusSample): Promise<void> {
    await this.db.orm
      .insert(t.statusSamples)
      .values({
        sampled_at: sample.sampledAt,
        ready: sample.ready,
        discord: sample.discord,
        database: sample.database,
        lodestone: sample.lodestone,
        changes: sample.changes,
        version: sample.version,
      })
      .onConflictDoNothing({ target: t.statusSamples.sampled_at });
  }

  async prune(before: Date): Promise<number> {
    const s = t.statusSamples;
    // One statement. The earliest row stays: without it, the history's start would move up to the
    // oldest row left, and an outage then at the window's edge would read as no data, not down.
    const result = await this.db.orm
      .delete(s)
      .where(
        and(lt(s.sampled_at, before), gt(s.sampled_at, sql`(SELECT min(sampled_at) FROM ${s})`)),
      );
    return result.rowCount ?? 0;
  }

  async counts(since: Date): Promise<{ first: Date | null; counts: SampleCount[] }> {
    const s = t.statusSamples;
    // The UTC day as text, so the session's time zone can't move a sample to another day.
    const day = sql<string>`to_char(${s.sampled_at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const [earliest] = await this.db.orm.select({ first: min(s.sampled_at) }).from(s);
    const rows = await this.db.orm
      .select({
        day,
        version: s.version,
        ready: sql<number>`(count(*) FILTER (WHERE ${s.ready}))::int`,
        first: min(s.sampled_at),
      })
      .from(s)
      .where(gte(s.sampled_at, since))
      .groupBy(day, s.version);
    return {
      first: earliest?.first ?? null,
      counts: rows.flatMap((row) =>
        row.first === null ? [] : [{ ...row, ready: Number(row.ready), first: row.first }],
      ),
    };
  }
}

/**
 * Whether Discord changes are paused in any server TaruBot serves: switched off for the whole
 * deployment (ENABLE_EFFECTS), or a configured server present now that awaits activation. One
 * small read of the guilds table; the answer is a boolean, never which servers or how many.
 */
export async function changesPausedAnywhere(
  db: Database,
  effectsEnabled: boolean,
  allowsGuild: (guildId: string) => boolean,
): Promise<boolean> {
  if (!effectsEnabled) return true;
  const paused = await db.orm
    .select({ id: t.guilds.id })
    .from(t.guilds)
    .where(and(eq(t.guilds.active, true), eq(t.guilds.effects_enabled, false)));
  return paused.some((guild) => allowsGuild(guild.id));
}
