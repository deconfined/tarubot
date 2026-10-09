/**
 * The public status page's samples in memory (2.41.0), for tests and the web harness: a
 * StatusSampleStore with PgStatusSamples' behavior (one sample per bucket, the first one kept;
 * pruning by time, never the earliest sample; counts per UTC day and version), and invented
 * histories to fill it with.
 * Everything is invented: process-wide booleans and release versions, nothing about a server.
 */
import {
  PublicStatus,
  type StatusReadiness,
  type StatusSample,
  type StatusSampleStore,
} from "../../src/application/public-status.js";
import {
  DAY_MS,
  HISTORY_DAYS,
  SAMPLE_INTERVAL_MS,
  type SampleCount,
  sampleBucket,
  utcDay,
} from "../../src/domain/uptime.js";

/** The store, keyed by bucket; calls are counted so tests can prove a visit makes none. */
export class MemoryStatusSamples implements StatusSampleStore {
  readonly samples = new Map<number, StatusSample>();
  readonly calls = { record: 0, prune: 0, counts: 0 };

  async record(sample: StatusSample): Promise<void> {
    this.calls.record++;
    const key = sample.sampledAt.getTime();
    // ON CONFLICT DO NOTHING: the bucket's first sample stays.
    if (!this.samples.has(key)) this.samples.set(key, sample);
  }

  async prune(before: Date): Promise<number> {
    this.calls.prune++;
    // The earliest sample stays, as in PgStatusSamples: it marks where the history starts.
    const earliest = Math.min(...this.samples.keys());
    let deleted = 0;
    for (const key of [...this.samples.keys()])
      if (key < before.getTime() && key > earliest) {
        this.samples.delete(key);
        deleted++;
      }
    return deleted;
  }

  async counts(since: Date): Promise<{ first: Date | null; counts: SampleCount[] }> {
    this.calls.counts++;
    const keys = [...this.samples.keys()];
    const first = keys.length === 0 ? null : new Date(Math.min(...keys));
    const groups = new Map<string, { day: string; version: string; ready: number; first: Date }>();
    for (const sample of this.samples.values()) {
      if (sample.sampledAt < since) continue;
      const day = utcDay(sample.sampledAt);
      const key = `${day} ${sample.version}`;
      const group = groups.get(key) ?? {
        day,
        version: sample.version,
        ready: 0,
        first: sample.sampledAt,
      };
      if (sample.ready) group.ready++;
      if (sample.sampledAt < group.first) group.first = sample.sampledAt;
      groups.set(key, group);
    }
    return { first, counts: [...groups.values()] };
  }
}

/**
 * --state-history's invented histories (the harness header describes each):
 * - incidents: 90 days, mostly whole, with seven bad stretches of each kind the page tells apart;
 * - new: samples only since 18:00 UTC yesterday, so 88 days show no data.
 */
export const HARNESS_HISTORIES = ["incidents", "new"] as const;
export type HarnessHistory = (typeof HARNESS_HISTORIES)[number];

/** An invented healthy sample. */
const healthy = (sampledAt: Date, version: string): StatusSample => ({
  sampledAt,
  ready: true,
  discord: true,
  database: true,
  lodestone: "available",
  changes: "live",
  version,
});

/**
 * A bad stretch in the incidents history: `day` days before today, starting `at` minutes after
 * midnight UTC and lasting `minutes`; `missing` leaves the buckets empty (TaruBot wasn't running),
 * otherwise they're written not ready (running, but without Discord).
 */
interface Stretch {
  readonly day: number;
  readonly at: number;
  readonly minutes: number;
  readonly missing: boolean;
}

/** The incidents history's bad stretches, each a kind of day the page shows differently. */
const STRETCHES: readonly Stretch[] = [
  // A long outage: about six hours not running (below 95%).
  { day: 61, at: 2 * 60, minutes: 6 * 60, missing: true },
  // A Discord outage: 45 minutes running but not ready (95% or more).
  { day: 33, at: 14 * 60 + 5, minutes: 45, missing: false },
  // A host restart: 20 minutes not running (95% or more).
  { day: 18, at: 9 * 60 + 30, minutes: 20, missing: true },
  // Two short deploys: 5 and 10 minutes (99% or more).
  { day: 12, at: 21 * 60, minutes: 5, missing: true },
  { day: 3, at: 16 * 60 + 35, minutes: 10, missing: true },
  // A reconnect of 5 minutes (99% or more), and today, 15 minutes not running.
  { day: 1, at: 7 * 60 + 15, minutes: 5, missing: false },
  { day: 0, at: 0, minutes: 15, missing: true },
];

/**
 * The version that wrote a sample in the invented history: 2.40.0 until 16:40 UTC three days ago
 * (when the second short deploy ended), 2.41.0 since, so that day lists both.
 */
function versionAt(at: number, today: number): string {
  const upgrade = today - 3 * DAY_MS + (16 * 60 + 45) * 60_000;
  return at < upgrade ? "2.40.0" : "2.41.0";
}

/**
 * Fill `store` with an invented history through `now`'s bucket, so a first tick a moment later,
 * even in the next bucket, leaves no gap. Without a history state: 90 whole days on one version.
 */
export function fillHistory(store: MemoryStatusSamples, now: Date, history?: HarnessHistory): void {
  const current = sampleBucket(now).getTime();
  const today = Math.floor(current / DAY_MS) * DAY_MS;
  const start =
    history === "new" ? today - DAY_MS + 18 * 3_600_000 : today - (HISTORY_DAYS - 1) * DAY_MS;
  const stretches = history === "incidents" ? STRETCHES : [];
  for (let at = start; at <= current; at += SAMPLE_INTERVAL_MS) {
    const stretch = stretches.find((bad) => {
      const from = today - bad.day * DAY_MS + bad.at * 60_000;
      return at >= from && at < from + bad.minutes * 60_000;
    });
    const version = history === "incidents" ? versionAt(at, today) : "2.41.0";
    if (stretch?.missing) continue;
    const sample = healthy(new Date(at), version);
    store.samples.set(at, stretch ? { ...sample, ready: false, discord: false } : sample);
  }
}

/** A PublicStatus over counting sources and a memory store, for route and view tests. */
export interface StatusFixture {
  readonly service: PublicStatus;
  readonly samples: MemoryStatusSamples;
  /** Reads of each source; a visit to /status must add none. */
  readonly reads: { readiness: number; lodestone: number; changes: number };
  /** What the sources answer; tests change them between ticks. */
  readonly state: { lodestoneFailing: boolean; changesPaused: boolean };
}

/**
 * A fixture over `readiness`, on the clock `now`, never started: tests call service.tick() to take
 * a snapshot and write the bucket's sample, exactly as the timer would.
 */
export function statusFixture(
  readiness: () => StatusReadiness,
  now: () => Date = () => new Date(),
): StatusFixture {
  const samples = new MemoryStatusSamples();
  const reads = { readiness: 0, lodestone: 0, changes: 0 };
  const state = { lodestoneFailing: false, changesPaused: false };
  const service = new PublicStatus(
    {
      readiness: () => {
        reads.readiness++;
        return readiness();
      },
      lodestoneFailing: () => {
        reads.lodestone++;
        return state.lodestoneFailing;
      },
      changesPaused: async () => {
        reads.changes++;
        return state.changesPaused;
      },
      samples,
    },
    { now },
  );
  return { service, samples, reads, state };
}
