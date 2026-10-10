/**
 * The public status page's snapshot and samples (2.41.0, src/application/public-status.ts) over
 * the in-memory store: one sample per five-minute bucket while this process is the writer,
 * pruning after 90 days (never the first sample), the history recounted after each sample and
 * worked out afresh, from memory, on every snapshot (so it keeps counting through a database
 * outage and across midnight), the components and overall status from the sources, trouble
 * reported once per streak, and nothing written once stopped. PgStatusSamples itself runs against
 * PostgreSQL in tests/integration/status-samples.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  PublicStatus,
  type StatusReadiness,
  type StatusSample,
} from "../../src/application/public-status.js";
import { project } from "../../src/config/project.js";
import type { ReportOptions } from "../../src/domain/failures.js";
import { DAY_MS, SAMPLE_INTERVAL_MS } from "../../src/domain/uptime.js";
import { MemoryStatusSamples, statusFixture } from "../fixtures/status-samples.js";

const READY: StatusReadiness = {
  ready: true,
  discord: true,
  database: true,
  writerLease: true,
  lodestone: { cooldownSeconds: 0 },
};

/** An invented healthy sample in the bucket starting at `at` (epoch milliseconds). */
const sample = (at: number, version = "2.40.0"): StatusSample => ({
  sampledAt: new Date(at),
  ready: true,
  discord: true,
  database: true,
  lodestone: "available",
  changes: "live",
  version,
});

/** Fill `store` with healthy samples in every bucket from `from` up to, not including, `until`. */
const fill = (store: MemoryStatusSamples, from: string | number, until: string | number) => {
  const end = typeof until === "string" ? Date.parse(until) : until;
  for (
    let at = typeof from === "string" ? Date.parse(from) : from;
    at < end;
    at += SAMPLE_INTERVAL_MS
  )
    store.samples.set(at, sample(at));
};

/** A clock the test moves, starting at an invented noon. */
const clock = (start = "2026-10-09T12:01:00Z") => {
  const state = { now: new Date(start) };
  return {
    state,
    now: () => state.now,
    advance: (ms: number) => {
      state.now = new Date(state.now.getTime() + ms);
    },
  };
};

describe("samples", () => {
  test("one per bucket while the writer: ticks inside a bucket add nothing, the next bucket adds one", async () => {
    const time = clock();
    const fixture = statusFixture(() => READY, time.now);
    await fixture.service.tick();
    await fixture.service.tick();
    time.advance(3 * 60_000);
    await fixture.service.tick();
    expect(fixture.samples.calls.record).toBe(1);
    expect([...fixture.samples.samples.keys()]).toEqual([Date.parse("2026-10-09T12:00:00Z")]);
    time.advance(SAMPLE_INTERVAL_MS);
    await fixture.service.tick();
    expect([...fixture.samples.samples.keys()]).toEqual([
      Date.parse("2026-10-09T12:00:00Z"),
      Date.parse("2026-10-09T12:05:00Z"),
    ]);
    expect(fixture.samples.samples.get(Date.parse("2026-10-09T12:00:00Z"))).toEqual({
      sampledAt: new Date("2026-10-09T12:00:00Z"),
      ready: true,
      discord: true,
      database: true,
      lodestone: "available",
      changes: "live",
      version: project.version,
    } satisfies StatusSample);
  });

  test("the store keeps a bucket's first sample (ON CONFLICT DO NOTHING)", async () => {
    const store = new MemoryStatusSamples();
    const sample: StatusSample = {
      sampledAt: new Date("2026-10-09T12:00:00Z"),
      ready: true,
      discord: true,
      database: true,
      lodestone: "available",
      changes: "live",
      version: "2.41.0",
    };
    await store.record(sample);
    await store.record({ ...sample, ready: false });
    expect([...store.samples.values()]).toEqual([sample]);
  });

  test("a process without the writer lease samples nothing but still refreshes the snapshot", async () => {
    const fixture = statusFixture(() => ({ ...READY, ready: false, writerLease: false }));
    await fixture.service.tick();
    expect(fixture.samples.calls).toEqual({ record: 0, prune: 0, counts: 0 });
    expect(fixture.service.snapshot()).toMatchObject({
      ready: false,
      overall: "down",
      history: null,
    });
  });

  test("samples older than 90 days are pruned with each new one, but the first; newer ones stay", async () => {
    const time = clock();
    const fixture = statusFixture(() => READY, time.now);
    const old = (days: number, minutes = 0) =>
      Date.parse("2026-10-09T12:00:00Z") - days * DAY_MS - minutes * 60_000;
    for (const at of [old(92), old(91), old(90, 5), old(90, -5), old(89)])
      fixture.samples.samples.set(at, sample(at));
    await fixture.service.tick();
    // The first sample ever stays: it marks where the history starts.
    expect([...fixture.samples.samples.keys()].sort()).toEqual(
      [old(92), old(90, -5), old(89), Date.parse("2026-10-09T12:00:00Z")].sort(),
    );
  });

  test("the first sample is never pruned, so an outage at the window's oldest edge reads down, not no data", async () => {
    const time = clock();
    const fixture = statusFixture(() => READY, time.now);
    const bucket = Date.parse("2026-10-09T12:00:00Z");
    // Running since 120 days ago, apart from ten days not running, from 96 to 86 days ago (noon).
    fill(fixture.samples, bucket - 120 * DAY_MS, bucket - 96 * DAY_MS);
    fill(fixture.samples, bucket - 86 * DAY_MS, bucket);
    await fixture.service.tick();
    const kept = [...fixture.samples.samples.keys()];
    expect(kept.filter((at) => at < bucket - 90 * DAY_MS)).toEqual([bucket - 120 * DAY_MS]);
    const days = fixture.service.snapshot()?.history?.days ?? [];
    // The window's three oldest days fell wholly in the outage, the fourth until noon.
    expect(days.slice(0, 4).map((day) => [day.ready, day.expected])).toEqual([
      [0, 288],
      [0, 288],
      [0, 288],
      [144, 288],
    ]);
    expect(days.every((day) => day.expected > 0)).toBe(true);
  });

  test("the history is recounted after each sample: today counts the gaps as down", async () => {
    const time = clock("2026-10-09T00:16:00Z");
    const fixture = statusFixture(() => READY, time.now);
    // Ready at midnight; 00:05 and 00:10 missed; the tick writes 00:15.
    fixture.samples.samples.set(Date.parse("2026-10-09T00:00:00Z"), {
      sampledAt: new Date("2026-10-09T00:00:00Z"),
      ready: true,
      discord: true,
      database: true,
      lodestone: "available",
      changes: "live",
      version: "2.39.0",
    });
    await fixture.service.tick();
    const history = fixture.service.snapshot()?.history;
    expect(history?.asOf).toEqual(new Date("2026-10-09T00:15:00Z"));
    expect(history?.days.at(-1)).toEqual({
      day: "2026-10-09",
      ready: 2,
      expected: 4,
      versions: ["2.39.0", project.version],
    });
    expect(history?.days.at(-2)).toMatchObject({ expected: 0 });
  });

  test("while samples can't be written, every bucket that passes counts as down at once, with no query", async () => {
    const time = clock("2026-10-09T00:01:00Z");
    const readiness = { ...READY };
    const store = new MemoryStatusSamples();
    fill(store, "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z");
    let databaseDown = false;
    const record = store.record.bind(store);
    store.record = async (value) => {
      if (databaseDown) throw new Error("connection refused");
      return record(value);
    };
    const service = new PublicStatus(
      {
        readiness: () => readiness,
        lodestoneFailing: () => false,
        changesPaused: async () => {
          if (databaseDown) throw new Error("connection refused");
          return false;
        },
        samples: store,
      },
      { now: time.now },
    );
    const today = () => service.snapshot()?.history?.days.at(-1);
    await service.tick();
    expect(today()).toEqual({
      day: "2026-10-09",
      ready: 1,
      expected: 1,
      versions: [project.version],
    });
    // The database goes away for an hour; the timer still ticks every minute.
    databaseDown = true;
    Object.assign(readiness, { ready: false, database: false });
    const counted = store.calls.counts;
    const figures: number[] = [];
    for (let minute = 1; minute <= 60; minute++) {
      time.advance(60_000);
      await service.tick();
      figures.push(today()?.expected ?? 0);
    }
    expect(store.calls.counts).toBe(counted);
    expect(service.snapshot()?.overall).toBe("down");
    // At 01:01 the buckets from 00:05 to 00:55 have passed without a sample; 01:00 is current.
    expect(today()).toEqual({
      day: "2026-10-09",
      ready: 1,
      expected: 12,
      versions: [project.version],
    });
    expect(service.snapshot()?.history?.asOf).toEqual(new Date("2026-10-09T00:55:00Z"));
    // The figure grew by one bucket every five minutes, each once it had wholly passed: 00:05's
    // at 00:10 (the ninth tick), 00:10's at 00:15.
    expect(figures.slice(7, 10)).toEqual([1, 2, 2]);
    expect(figures.slice(12, 14)).toEqual([2, 3]);
    expect(new Set(figures)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    // Back: the current bucket is written and counted, and the history picks up from the store.
    databaseDown = false;
    Object.assign(readiness, { ready: true, database: true });
    time.advance(60_000);
    await service.tick();
    expect(today()).toEqual({
      day: "2026-10-09",
      ready: 2,
      expected: 13,
      versions: [project.version],
    });
    expect(store.calls.counts).toBe(counted + 1);
  });

  test("midnight UTC: the new day starts with its first bucket, and a long stop counts as down", async () => {
    const time = clock("2026-10-08T23:56:10Z");
    const fixture = statusFixture(() => READY, time.now);
    fill(fixture.samples, "2026-10-07T00:00:00Z", "2026-10-08T23:55:00Z");
    await fixture.service.tick();
    let days = fixture.service.snapshot()?.history?.days ?? [];
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toMatchObject({ day: "2026-10-08", ready: 288, expected: 288 });
    expect(days[0]?.day).toBe("2026-07-11");
    time.state.now = new Date("2026-10-09T00:00:20Z");
    await fixture.service.tick();
    days = fixture.service.snapshot()?.history?.days ?? [];
    expect(days).toHaveLength(90);
    expect(days.slice(-3).map((day) => [day.day, day.ready, day.expected])).toEqual([
      ["2026-10-07", 288, 288],
      ["2026-10-08", 288, 288],
      ["2026-10-09", 1, 1],
    ]);
    expect(days[0]?.day).toBe("2026-07-12");
    // TaruBot stops just after midnight and starts again two days later at 03:02.
    time.state.now = new Date("2026-10-11T03:02:00Z");
    await fixture.service.tick();
    days = fixture.service.snapshot()?.history?.days ?? [];
    expect(days.slice(-3).map((day) => [day.day, day.ready, day.expected])).toEqual([
      ["2026-10-09", 1, 288],
      ["2026-10-10", 0, 288],
      ["2026-10-11", 1, 37],
    ]);
  });
});

describe("the snapshot", () => {
  test("start() publishes one at once from memory, before any query, and stop() ends the timer", async () => {
    const fixture = statusFixture(() => READY);
    expect(fixture.service.snapshot()).toBeNull();
    fixture.service.start();
    expect(fixture.service.snapshot()).toMatchObject({
      version: project.version,
      ready: true,
      overall: "operational",
    });
    await fixture.service.stop();
    const writes = fixture.samples.calls.record;
    await fixture.service.tick();
    expect(fixture.samples.calls.record).toBe(writes);
  });

  test("components follow the sources: a cooldown wins over an unanswered request", async () => {
    const readiness = { ...READY, lodestone: { cooldownSeconds: 0 } };
    const fixture = statusFixture(() => readiness);
    fixture.state.lodestoneFailing = true;
    await fixture.service.tick();
    expect(fixture.service.snapshot()).toMatchObject({
      overall: "degraded",
      components: { lodestone: "unreachable", changes: "live" },
    });
    readiness.lodestone = { cooldownSeconds: 30 };
    await fixture.service.tick();
    expect(fixture.service.snapshot()).toMatchObject({
      overall: "operational",
      components: { lodestone: "cooling_down" },
    });
    // Paused changes are a setting, not a fault: on their tile, never in the headline.
    fixture.state.changesPaused = true;
    await fixture.service.tick();
    expect(fixture.service.snapshot()).toMatchObject({
      overall: "operational",
      components: { lodestone: "cooling_down", changes: "paused" },
    });
  });

  test("a failing pause query keeps the last answer; the database component says why", async () => {
    let fail = false;
    const readiness = { ...READY };
    const service = new PublicStatus({
      readiness: () => readiness,
      lodestoneFailing: () => false,
      changesPaused: async () => {
        if (fail) throw new Error("database down");
        return true;
      },
      samples: new MemoryStatusSamples(),
    });
    await service.tick();
    fail = true;
    Object.assign(readiness, { ready: false, database: false });
    await service.tick();
    expect(service.snapshot()).toMatchObject({
      overall: "down",
      components: { database: false, changes: "paused" },
    });
  });

  test("a store failure is reported once per streak at warn, retried, and the snapshot still refreshes", async () => {
    const time = clock();
    const reports: [unknown, string, ReportOptions | undefined][] = [];
    const store = new MemoryStatusSamples();
    let broken = true;
    const record = store.record.bind(store);
    store.record = async (sample) => {
      if (broken) throw new Error("connection refused");
      return record(sample);
    };
    const service = new PublicStatus(
      {
        readiness: () => READY,
        lodestoneFailing: () => false,
        changesPaused: async () => false,
        samples: store,
      },
      {
        now: time.now,
        report: (error, operation, options) => reports.push([error, operation, options]),
      },
    );
    await service.tick();
    time.advance(60_000);
    await service.tick();
    expect(reports.map(([, operation, options]) => [operation, options])).toEqual([
      ["status samples", { level: "warn" }],
    ]);
    expect(service.snapshot()?.takenAt).toEqual(time.now());
    expect(service.snapshot()?.history).toBeNull();
    broken = false;
    time.advance(60_000);
    await service.tick();
    expect(store.samples.size).toBe(1);
    expect(service.snapshot()?.history).not.toBeNull();
    broken = true;
    time.advance(SAMPLE_INTERVAL_MS);
    await service.tick();
    expect(reports).toHaveLength(2);
  });

  test("a hung database query never freezes the snapshot: each tick publishes from memory", async () => {
    const time = clock();
    const readiness = { ...READY };
    const hung = Promise.withResolvers<boolean>();
    const service = new PublicStatus(
      {
        readiness: () => readiness,
        lodestoneFailing: () => false,
        changesPaused: () => hung.promise,
        samples: new MemoryStatusSamples(),
      },
      { now: time.now },
    );
    const first = service.tick();
    expect(service.snapshot()?.overall).toBe("operational");
    Object.assign(readiness, { ready: false, database: false });
    time.advance(60_000);
    const second = service.tick();
    expect(second).toBe(first);
    expect(service.snapshot()).toMatchObject({
      takenAt: time.now(),
      overall: "down",
      components: { database: false },
    });
    hung.reject(new Error("connection lost"));
    await first;
  });

  test("ticks while one runs join it rather than run twice", async () => {
    const fixture = statusFixture(() => READY);
    await Promise.all([fixture.service.tick(), fixture.service.tick(), fixture.service.tick()]);
    expect(fixture.reads.changes).toBe(1);
  });
});
