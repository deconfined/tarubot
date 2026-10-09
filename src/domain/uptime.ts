/**
 * The public status page's rules (2.41.0, owner decisions of 2026-10-09), as pure functions: the
 * overall status from the components, the five-minute sample buckets, and the daily uptime the
 * 90-day history shows. Every day is a UTC day counted in epoch milliseconds, so daylight saving
 * time never makes a day longer or shorter than 288 samples.
 */

/** One sample every five minutes while TaruBot holds the writer lease. */
export const SAMPLE_INTERVAL_MS = 5 * 60_000;
/** A UTC day in milliseconds; UTC has no daylight saving time, so every day is this long. */
export const DAY_MS = 86_400_000;
/** The samples a whole UTC day expects. */
export const SAMPLES_PER_DAY = DAY_MS / SAMPLE_INTERVAL_MS;
/** The days the history shows, today included; samples are kept for as long (docs/PERSISTENCE.md). */
export const HISTORY_DAYS = 90;

/** The Lodestone as the page shows it. */
export const LODESTONE_STATES = ["available", "cooling_down", "unreachable"] as const;
export type LodestoneState = (typeof LODESTONE_STATES)[number];
/**
 * Discord changes: live, or paused because the deployment turned them off or a server TaruBot
 * serves awaits activation. The page never says which server, or how many.
 */
export const CHANGES_STATES = ["live", "paused"] as const;
export type ChangesState = (typeof CHANGES_STATES)[number];

/** The four components the page lists. Nothing here names or counts a server or a person. */
export interface StatusComponents {
  /** The Discord gateway is connected and ready. */
  readonly discord: boolean;
  /** The database answered the scheduler's last check. */
  readonly database: boolean;
  readonly lodestone: LodestoneState;
  readonly changes: ChangesState;
}

/** The page's headline. */
export type OverallStatus = "operational" | "degraded" | "down";

/**
 * The overall status, the rule docs/MODULES.md and the monitoring guide state:
 * - down: TaruBot isn't ready (starting, stopping, or without Discord, its database or the writer
 *   lease), so it can't do its work;
 * - degraded: ready, but the Lodestone didn't answer its latest request, so verification and
 *   roster checks wait;
 * - operational: ready, with the Lodestone answering. A Lodestone cooldown after a 429 is routine
 *   and over within minutes, so it shows on its component only.
 * Discord changes never move the headline: paused is a deliberate setting (ENABLE_EFFECTS off, the
 * default, or a server awaiting activation), not a fault, so it shows on its component only too.
 */
export function overallStatus(ready: boolean, components: StatusComponents): OverallStatus {
  if (!ready || !components.discord || !components.database) return "down";
  if (components.lodestone === "unreachable") return "degraded";
  return "operational";
}

/** The start of the five-minute bucket `at` falls in: the sample's key, so one per bucket. */
export function sampleBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS);
}

/** The UTC day of an instant, as YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of `at`'s day, in epoch milliseconds. */
const dayStart = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;

/** One group of stored samples: those of one UTC day that one version wrote. */
export interface SampleCount {
  /** YYYY-MM-DD, UTC. */
  readonly day: string;
  readonly version: string;
  /** Samples in the group that were ready. */
  readonly ready: number;
  /** The group's earliest sample, which orders a day's versions. */
  readonly first: Date;
}

/** One day of the history. */
export interface UptimeDay {
  /** YYYY-MM-DD, UTC. */
  readonly day: string;
  /** Ready samples, at most `expected`. */
  readonly ready: number;
  /**
   * Samples the day should have: every five minutes since the first sample ever (or the day's
   * start), up to the history's last bucket (or the day's end). 0 means no data: a day before
   * the first sample.
   */
  readonly expected: number;
  /** The versions that wrote samples that day, in the order they first did. */
  readonly versions: readonly string[];
}

/** The history the page shows, oldest day first. */
export interface UptimeHistory {
  /** HISTORY_DAYS days, the last of them today (the last bucket's day). */
  readonly days: readonly UptimeDay[];
  /** The history's last bucket: today's expected samples run up to and include it. */
  readonly asOf: Date;
}

/**
 * Daily uptime: ready samples ÷ expected samples, per UTC day. A five-minute bucket without a
 * sample counts as down, which is what it means when TaruBot wasn't running or had no database
 * then. Expected samples start at the first sample ever (pruning always keeps it), so the days
 * before it show no data instead of a false outage, and end at `latest`'s bucket: the one the
 * caller last wrote, or the latest that has wholly passed (PublicStatus), so today counts only
 * the buckets that have passed. A day with no data has expected 0. Counts beyond what a day
 * expects (a clock that stepped back) are capped.
 */
export function uptimeHistory(
  counts: readonly SampleCount[],
  first: Date | null,
  latest: Date,
  days: number = HISTORY_DAYS,
): UptimeHistory {
  const end = sampleBucket(latest).getTime() + SAMPLE_INTERVAL_MS;
  const today = dayStart(end - SAMPLE_INTERVAL_MS);
  const start = first === null ? Number.POSITIVE_INFINITY : sampleBucket(first).getTime();
  const byDay = new Map<string, SampleCount[]>();
  for (const count of counts) byDay.set(count.day, [...(byDay.get(count.day) ?? []), count]);
  const history: UptimeDay[] = [];
  for (let index = days - 1; index >= 0; index--) {
    const from = today - index * DAY_MS;
    const day = utcDay(new Date(from));
    const counted = Math.max(from, start);
    const until = Math.min(from + DAY_MS, end);
    const expected = until > counted ? (until - counted) / SAMPLE_INTERVAL_MS : 0;
    const groups = [...(byDay.get(day) ?? [])].sort(
      (left, right) => left.first.getTime() - right.first.getTime(),
    );
    const ready = groups.reduce((sum, group) => sum + group.ready, 0);
    history.push({
      day,
      ready: Math.min(ready, expected),
      expected,
      versions: expected === 0 ? [] : [...new Set(groups.map((group) => group.version))],
    });
  }
  return { days: history, asOf: new Date(end - SAMPLE_INTERVAL_MS) };
}

/** A day's color band on the page: whole, a few minutes down, up to about an hour, more, none. */
export type UptimeBand = "full" | "high" | "mid" | "low" | "none";

/**
 * The band of a day. A day has 288 samples, so one missed sample is already 99.65%: the bands are
 * 100%, at least 99% (up to ten minutes down), at least 95% (up to 70 minutes) and below, which
 * is coarser than a status page sampling every second could use.
 */
export function uptimeBand(day: Pick<UptimeDay, "ready" | "expected">): UptimeBand {
  if (day.expected === 0) return "none";
  if (day.ready === day.expected) return "full";
  const ratio = day.ready / day.expected;
  return ratio >= 0.99 ? "high" : ratio >= 0.95 ? "mid" : "low";
}

/**
 * Uptime as text: "100%" only when nothing was missed, otherwise two decimals rounded down, so a
 * day with one missed sample in thousands never reads as 100.00%. Null when nothing was expected.
 * The hundredths of a percent are floored in integers (ready × 10,000 stays far below 2^53), not
 * from the float quotient, which lands just under the exact value for 57/100 and reads 56.99%.
 */
export function uptimePercent(ready: number, expected: number): string | null {
  if (expected === 0) return null;
  if (ready >= expected) return "100%";
  const hundredths = Math.floor((ready * 10_000) / expected);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}%`;
}

/** The history in figures, for the page's summary. */
export interface UptimeSummary {
  /** Ready and expected samples over every day with data. */
  readonly ready: number;
  readonly expected: number;
  /** Days with data, and the first of them (null when there is none). */
  readonly daysWithData: number;
  readonly since: string | null;
  /** Days with data below 100%. */
  readonly daysDown: number;
}

/** Sum the history for the summary line. */
export function uptimeSummary(history: UptimeHistory): UptimeSummary {
  const counted = history.days.filter((day) => day.expected > 0);
  return {
    ready: counted.reduce((sum, day) => sum + day.ready, 0),
    expected: counted.reduce((sum, day) => sum + day.expected, 0),
    daysWithData: counted.length,
    since: counted[0]?.day ?? null,
    daysDown: counted.filter((day) => day.ready < day.expected).length,
  };
}

/**
 * Time down in words, from missed samples: "5 min", "1 h 35 min", "24 h". Each missed sample is
 * five minutes, the resolution the history has.
 */
export function downtimeText(missed: number): string {
  const minutes = missed * (SAMPLE_INTERVAL_MS / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
