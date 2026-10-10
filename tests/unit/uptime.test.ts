/**
 * The public status page's rules (2.41.0, src/domain/uptime.ts): the overall status, the
 * five-minute buckets and the daily uptime of the 90-day history, with its edge cases: no data,
 * gaps, a partial today, a version change mid-day, capped counts and UTC days that daylight saving
 * time never stretches. Invented instants only.
 */
import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  downtimeText,
  HISTORY_DAYS,
  overallStatus,
  SAMPLE_INTERVAL_MS,
  SAMPLES_PER_DAY,
  type SampleCount,
  type StatusComponents,
  sampleBucket,
  uptimeBand,
  uptimeHistory,
  uptimePercent,
  uptimeSummary,
  utcDay,
} from "../../src/domain/uptime.js";

const LIVE: StatusComponents = {
  discord: true,
  database: true,
  lodestone: "available",
  changes: "live",
};

/** A group of samples for uptimeHistory. */
const count = (day: string, ready: number, version = "2.41.0", first = `${day}T00:00:00Z`) =>
  ({ day, version, ready, first: new Date(first) }) satisfies SampleCount;

describe("the overall status", () => {
  test("down without readiness, Discord or the database, whatever else holds", () => {
    expect(overallStatus(false, LIVE)).toBe("down");
    expect(overallStatus(true, { ...LIVE, discord: false })).toBe("down");
    expect(overallStatus(true, { ...LIVE, database: false })).toBe("down");
    expect(overallStatus(false, { ...LIVE, changes: "paused", lodestone: "unreachable" })).toBe(
      "down",
    );
  });

  test("degraded when the Lodestone is unanswered, paused changes or not", () => {
    expect(overallStatus(true, { ...LIVE, lodestone: "unreachable" })).toBe("degraded");
    expect(overallStatus(true, { ...LIVE, lodestone: "unreachable", changes: "paused" })).toBe(
      "degraded",
    );
  });

  test("operational otherwise: a routine Lodestone cooldown, and paused changes, a setting", () => {
    expect(overallStatus(true, LIVE)).toBe("operational");
    expect(overallStatus(true, { ...LIVE, lodestone: "cooling_down" })).toBe("operational");
    // ENABLE_EFFECTS off (the default) or a server awaiting activation is deliberate, not a fault:
    // it shows on its own tile only.
    expect(overallStatus(true, { ...LIVE, changes: "paused" })).toBe("operational");
    expect(overallStatus(true, { ...LIVE, lodestone: "cooling_down", changes: "paused" })).toBe(
      "operational",
    );
  });
});

describe("sample buckets", () => {
  test("round down to five minutes, so every tick inside a bucket shares its key", () => {
    expect(SAMPLES_PER_DAY).toBe(288);
    const bucket = new Date("2026-10-09T12:05:00.000Z");
    for (const at of ["12:05:00.000", "12:06:59.999", "12:09:59.999"])
      expect(sampleBucket(new Date(`2026-10-09T${at}Z`))).toEqual(bucket);
    expect(sampleBucket(new Date("2026-10-09T12:10:00.000Z")).getTime()).toBe(
      bucket.getTime() + SAMPLE_INTERVAL_MS,
    );
  });

  test("a UTC day is named from the instant, never the host's zone", () => {
    expect(utcDay(new Date("2026-10-09T23:59:59.999Z"))).toBe("2026-10-09");
    expect(utcDay(new Date("2026-10-10T00:00:00.000Z"))).toBe("2026-10-10");
  });
});

describe("daily uptime", () => {
  const latest = new Date("2026-10-09T12:00:00Z");

  test("no samples at all: 90 days of no data, and nothing to sum", () => {
    const history = uptimeHistory([], null, latest);
    expect(history.days).toHaveLength(HISTORY_DAYS);
    expect(history.days.at(-1)?.day).toBe("2026-10-09");
    expect(history.days[0]?.day).toBe(utcDay(new Date(latest.getTime() - 89 * DAY_MS)));
    expect(history.days.every((day) => day.expected === 0 && day.ready === 0)).toBe(true);
    expect(uptimeSummary(history)).toEqual({
      ready: 0,
      expected: 0,
      daysWithData: 0,
      since: null,
      daysDown: 0,
    });
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimeBand({ ready: 0, expected: 0 })).toBe("none");
  });

  test("days before the first sample have no data; its day counts from its bucket", () => {
    // First sample yesterday at 18:02 (bucket 18:00): 72 buckets to midnight, all ready.
    const history = uptimeHistory(
      [count("2026-10-08", 72, "2.40.0", "2026-10-08T18:00:00Z"), count("2026-10-09", 145)],
      new Date("2026-10-08T18:02:00Z"),
      latest,
    );
    const [yesterday, today] = history.days.slice(-2);
    expect(history.days.slice(0, -2).every((day) => day.expected === 0)).toBe(true);
    expect(yesterday).toEqual({ day: "2026-10-08", ready: 72, expected: 72, versions: ["2.40.0"] });
    // Today runs from midnight to the 12:00 bucket, inclusive: 145 buckets.
    expect(today).toEqual({ day: "2026-10-09", ready: 145, expected: 145, versions: ["2.41.0"] });
    expect(uptimeSummary(history)).toMatchObject({ daysWithData: 2, since: "2026-10-08" });
  });

  test("a gap counts as down: missing buckets lower the day, never the expectation", () => {
    // Six hours (72 buckets) missing from a whole day.
    const history = uptimeHistory(
      [count("2026-10-07", SAMPLES_PER_DAY - 72)],
      new Date("2026-09-01T00:00:00Z"),
      latest,
    );
    const day = history.days.find((entry) => entry.day === "2026-10-07");
    expect(day).toMatchObject({ ready: 216, expected: 288 });
    expect(uptimePercent(216, 288)).toBe("75.00%");
    expect(uptimeBand({ ready: 216, expected: 288 })).toBe("low");
    expect(downtimeText(72)).toBe("6 h");
    // A day with no samples at all, after the first one, is wholly down.
    expect(history.days.find((entry) => entry.day === "2026-10-06")).toEqual({
      day: "2026-10-06",
      ready: 0,
      expected: 288,
      versions: [],
    });
  });

  test("today counts only the buckets that have passed, up to the one just written", () => {
    const early = new Date("2026-10-09T06:03:00Z");
    const history = uptimeHistory(
      [count("2026-10-09", 70)],
      new Date("2026-10-01T00:00:00Z"),
      early,
    );
    expect(history.asOf).toEqual(new Date("2026-10-09T06:00:00Z"));
    // 00:00 through 06:00 inclusive: 73 buckets, 3 of them missed.
    expect(history.days.at(-1)).toMatchObject({ ready: 70, expected: 73 });
    expect(uptimePercent(70, 73)).toBe("95.89%");
    expect(downtimeText(3)).toBe("15 min");
  });

  test("a version change mid-day: one day, both versions in the order they ran", () => {
    const history = uptimeHistory(
      [
        count("2026-10-08", 98, "2.41.0", "2026-10-08T16:45:00Z"),
        count("2026-10-08", 188, "2.40.0", "2026-10-08T00:00:00Z"),
      ],
      new Date("2026-10-01T00:00:00Z"),
      latest,
    );
    expect(history.days.find((day) => day.day === "2026-10-08")).toEqual({
      day: "2026-10-08",
      ready: 286,
      expected: 288,
      versions: ["2.40.0", "2.41.0"],
    });
    expect(uptimeBand({ ready: 286, expected: 288 })).toBe("high");
  });

  test("UTC days stay 288 buckets across daylight saving changes anywhere", () => {
    // Europe moves its clocks on 2026-03-29 and 2026-10-25, the US on 2026-03-08 and 2026-11-01.
    const end = new Date("2026-11-03T23:55:00Z");
    const history = uptimeHistory([], new Date("2026-01-01T00:00:00Z"), end);
    expect(history.days).toHaveLength(HISTORY_DAYS);
    expect(history.days.every((day) => day.expected === SAMPLES_PER_DAY)).toBe(true);
    for (const shift of ["2026-10-25", "2026-11-01"])
      expect(history.days.find((day) => day.day === shift)?.expected).toBe(288);
    const spring = uptimeHistory(
      [],
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-04-01T12:00:00Z"),
    );
    for (const shift of ["2026-03-08", "2026-03-29"])
      expect(spring.days.find((day) => day.day === shift)?.expected).toBe(288);
  });

  test("counts beyond what a day expects (a clock stepped back) are capped", () => {
    const history = uptimeHistory(
      [count("2026-10-09", 500)],
      new Date("2026-10-01T00:00:00Z"),
      latest,
    );
    expect(history.days.at(-1)).toMatchObject({ ready: 145, expected: 145 });
  });

  test("the summary sums every day with data and counts the days below 100%", () => {
    const history = uptimeHistory(
      [count("2026-10-07", 288), count("2026-10-08", 287), count("2026-10-09", 140)],
      new Date("2026-10-07T00:00:00Z"),
      latest,
    );
    expect(uptimeSummary(history)).toEqual({
      ready: 715,
      expected: 721,
      daysWithData: 3,
      since: "2026-10-07",
      daysDown: 2,
    });
  });
});

describe("bands and words", () => {
  test("one missed sample of a whole day is already below 99.9%: the bands fit 288 a day", () => {
    expect(uptimeBand({ ready: 288, expected: 288 })).toBe("full");
    expect(uptimeBand({ ready: 287, expected: 288 })).toBe("high");
    expect(uptimeBand({ ready: 286, expected: 288 })).toBe("high");
    expect(uptimeBand({ ready: 285, expected: 288 })).toBe("mid");
    expect(uptimeBand({ ready: 274, expected: 288 })).toBe("mid");
    expect(uptimeBand({ ready: 273, expected: 288 })).toBe("low");
  });

  test("percentages round down, so only nothing missed reads 100%", () => {
    expect(uptimePercent(288, 288)).toBe("100%");
    expect(uptimePercent(287, 288)).toBe("99.65%");
    expect(uptimePercent(9_999, 10_000)).toBe("99.99%");
    expect(uptimePercent(25_919, 25_920)).toBe("99.99%");
    expect(uptimePercent(0, 288)).toBe("0.00%");
    expect(uptimePercent(1, 288)).toBe("0.34%");
  });

  test("exact quotients stay exact: the float ratio would read 57/100 as 56.99%", () => {
    // (57 / 100) * 10000 is 5699.999999999999 in floating point; 57 * 10000 / 100 is 5700.
    expect(uptimePercent(57, 100)).toBe("57.00%");
    // 25 days of samples, 57% of them ready.
    expect(uptimePercent(4_104, 7_200)).toBe("57.00%");
    // More quotients the float ratio floors one hundredth low.
    expect(uptimePercent(69, 100)).toBe("69.00%");
    expect(uptimePercent(171, 300)).toBe("57.00%");
    expect(uptimePercent(43, 125)).toBe("34.40%");
  });

  test("downtime reads in minutes, then hours and minutes", () => {
    expect(downtimeText(0)).toBe("0 min");
    expect(downtimeText(1)).toBe("5 min");
    expect(downtimeText(19)).toBe("1 h 35 min");
    expect(downtimeText(288)).toBe("24 h");
  });
});
