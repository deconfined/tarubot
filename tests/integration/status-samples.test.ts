/**
 * The public status page's samples (2.41.0, migration 013) against disposable PostgreSQL in a
 * private schema: PgStatusSamples writes one row per bucket (a second write to the same bucket
 * changes nothing), prunes by time but never the first row, which marks where the history starts,
 * and counts ready samples per UTC day and version, whatever the
 * session's time zone; PublicStatus over it writes and recounts on its ticks; and
 * changesPausedAnywhere reads only active, served servers. The same scenarios run against
 * tests/fixtures/status-samples.ts's MemoryStatusSamples, so the fake the web tests use keeps the
 * real store's rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  changesPausedAnywhere,
  PgStatusSamples,
  PublicStatus,
  type StatusSample,
  type StatusSampleStore,
} from "../../src/application/public-status.js";
import { DAY_MS } from "../../src/domain/uptime.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import { MemoryStatusSamples } from "../fixtures/status-samples.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "status_samples_it";

/** An invented sample in the bucket starting at `at`. */
const sample = (at: string, overrides: Partial<StatusSample> = {}): StatusSample => ({
  sampledAt: new Date(at),
  ready: true,
  discord: true,
  database: true,
  lodestone: "available",
  changes: "live",
  version: "2.41.0",
  ...overrides,
});

/** The scenarios every StatusSampleStore must pass. */
function scenarios(store: () => StatusSampleStore) {
  test("one sample per bucket: a second write to the bucket changes nothing", async () => {
    const samples = store();
    await samples.record(sample("2026-10-09T12:00:00Z"));
    await samples.record(sample("2026-10-09T12:00:00Z", { ready: false, version: "2.40.0" }));
    const { first, counts } = await samples.counts(new Date("2026-10-01T00:00:00Z"));
    expect(first).toEqual(new Date("2026-10-09T12:00:00Z"));
    expect(counts).toEqual([
      { day: "2026-10-09", version: "2.41.0", ready: 1, first: new Date("2026-10-09T12:00:00Z") },
    ]);
  });

  test("counts group by UTC day and version; not-ready samples count as samples, not as ready", async () => {
    const samples = store();
    for (const at of ["2026-10-08T23:55:00Z", "2026-10-09T00:00:00Z", "2026-10-09T00:05:00Z"])
      await samples.record(sample(at, { version: "2.40.0" }));
    await samples.record(sample("2026-10-09T16:50:00Z"));
    await samples.record(sample("2026-10-09T16:55:00Z", { ready: false, discord: false }));
    const { first, counts } = await samples.counts(new Date("2026-10-09T00:00:00Z"));
    expect(first).toEqual(new Date("2026-10-08T23:55:00Z"));
    expect([...counts].sort((left, right) => left.first.getTime() - right.first.getTime())).toEqual(
      [
        { day: "2026-10-09", version: "2.40.0", ready: 2, first: new Date("2026-10-09T00:00:00Z") },
        { day: "2026-10-09", version: "2.41.0", ready: 1, first: new Date("2026-10-09T16:50:00Z") },
      ],
    );
  });

  test("prune deletes only samples before the cutoff, and never the first one", async () => {
    const samples = store();
    for (const at of [
      "2026-07-10T11:50:00Z",
      "2026-07-10T11:55:00Z",
      "2026-07-10T12:00:00Z",
      "2026-10-09T12:00:00Z",
    ])
      await samples.record(sample(at));
    expect(await samples.prune(new Date("2026-07-10T12:00:00Z"))).toBe(1);
    expect(await samples.prune(new Date("2026-07-10T12:00:00Z"))).toBe(0);
    const { first, counts } = await samples.counts(new Date("2026-07-10T00:00:00Z"));
    expect(first).toEqual(new Date("2026-07-10T11:50:00Z"));
    expect(counts.find((count) => count.day === "2026-07-10")?.ready).toBe(2);
  });

  test("the first sample outlives every prune, so the history keeps its start", async () => {
    const samples = store();
    // Ran 120 days before the 2026-10-09 sample, then not again until 86 days before it.
    for (const at of ["2026-06-11T12:00:00Z", "2026-06-11T12:05:00Z", "2026-07-15T12:00:00Z"])
      await samples.record(sample(at));
    await samples.record(sample("2026-10-09T12:00:00Z"));
    // The 90-day cutoff: both June samples are older, and only the second goes.
    expect(await samples.prune(new Date("2026-07-11T12:00:00Z"))).toBe(1);
    const { first, counts } = await samples.counts(new Date("2026-07-12T00:00:00Z"));
    expect(first).toEqual(new Date("2026-06-11T12:00:00Z"));
    expect(counts.map((count) => count.day).sort()).toEqual(["2026-07-15", "2026-10-09"]);
    // A cutoff past every sample leaves the first one alone.
    expect(await samples.prune(new Date("2026-12-31T00:00:00Z"))).toBe(2);
    const left = await samples.counts(new Date(0));
    expect(left.first).toEqual(new Date("2026-06-11T12:00:00Z"));
    expect(left.counts.map((count) => count.day)).toEqual(["2026-06-11"]);
  });
}

describe("MemoryStatusSamples", () => {
  let samples = new MemoryStatusSamples();
  beforeEach(() => {
    samples = new MemoryStatusSamples();
  });
  scenarios(() => samples);
});

describe.skipIf(!url)("PgStatusSamples against PostgreSQL", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  // A session zone far from UTC: the UTC day must not follow it (the bot's own sessions use UTC).
  const confined = new URL(url);
  confined.searchParams.set(
    "options",
    `${SESSION_OPTIONS} -c search_path=${SCHEMA} -c timezone=Pacific/Kiritimati`,
  );
  const db = new Database(confined.toString());
  const store = new PgStatusSamples(db);

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
    await db.schema();
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE ${SCHEMA}.status_samples`);
    await admin.query(`TRUNCATE ${SCHEMA}.guilds CASCADE`);
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  scenarios(() => store);

  test("the table refuses keys off a five-minute boundary and unknown states", async () => {
    const refused = (statement: string) =>
      expect(admin.query(statement)).rejects.toMatchObject({ code: "23514" });
    const insert = (at: string, lodestone = "available", changes = "live", version = "2.41.0") =>
      `INSERT INTO ${SCHEMA}.status_samples VALUES ('${at}', true, true, true, '${lodestone}', '${changes}', '${version}')`;
    await refused(insert("2026-10-09T12:01:00Z"));
    await refused(insert("2026-10-09T12:00:00.5Z"));
    await refused(insert("2026-10-09T12:00:00Z", "down"));
    await refused(insert("2026-10-09T12:00:00Z", "available", "off"));
    await refused(insert("2026-10-09T12:00:00Z", "available", "live", ""));
    await refused(insert("2026-10-09T12:00:00Z", "available", "live", "2.41.0; DROP"));
    await admin.query(insert("2026-10-09T12:05:00+02:00"));
  });

  test("PublicStatus writes, prunes and recounts on its ticks", async () => {
    const state = { now: new Date("2026-10-09T12:01:00Z") };
    const daysBefore = (days: number) =>
      new Date(Date.parse("2026-10-09T12:00:00Z") - days * DAY_MS).toISOString();
    // The first sample ever, 92 days back, outlives the prune; the one 91 days back doesn't.
    await store.record(sample(daysBefore(92)));
    await store.record(sample(daysBefore(91)));
    await store.record(sample("2026-10-09T11:50:00Z", { ready: false }));
    const service = new PublicStatus(
      {
        readiness: () => ({
          ready: true,
          discord: true,
          database: true,
          writerLease: true,
          lodestone: { cooldownSeconds: 0 },
        }),
        lodestoneFailing: () => false,
        changesPaused: async () => false,
        samples: store,
      },
      { now: () => state.now },
    );
    await service.tick();
    const rows = await admin.query<{ sampled_at: Date; ready: boolean }>(
      `SELECT sampled_at, ready FROM ${SCHEMA}.status_samples ORDER BY sampled_at`,
    );
    expect(rows).toEqual([
      { sampled_at: new Date(daysBefore(92)), ready: true },
      { sampled_at: new Date("2026-10-09T11:50:00Z"), ready: false },
      { sampled_at: new Date("2026-10-09T12:00:00Z"), ready: true },
    ]);
    // Expected from the first sample ever, before the window: every day counts in full, so today
    // has 145 buckets to 12:00, of which only 12:00 was ready (11:50 wasn't, the rest are missing).
    const days = service.snapshot()?.history?.days ?? [];
    expect(days.at(-1)).toMatchObject({ day: "2026-10-09", ready: 1, expected: 145 });
    expect(days.every((day) => day.expected > 0)).toBe(true);
  });

  test("Discord changes are paused by the deployment, or by an active, served server awaiting activation", async () => {
    const all = () => true;
    expect(await changesPausedAnywhere(db, false, all)).toBe(true);
    expect(await changesPausedAnywhere(db, true, all)).toBe(false);
    await admin.query(
      `INSERT INTO ${SCHEMA}.guilds (id, active, effects_enabled) VALUES
         ('100000000000000001', true, true),
         ('100000000000000002', false, false),
         ('100000000000000003', true, false)`,
    );
    expect(await changesPausedAnywhere(db, true, all)).toBe(true);
    // A server this deployment doesn't serve (DevBot's scope) doesn't count.
    expect(await changesPausedAnywhere(db, true, (id) => id === "100000000000000001")).toBe(false);
    await admin.query(`UPDATE ${SCHEMA}.guilds SET active=false WHERE id='100000000000000003'`);
    expect(await changesPausedAnywhere(db, true, all)).toBe(false);
  });
});
