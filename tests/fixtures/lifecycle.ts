/**
 * An ApplicationLifecycle with controlled collaborators, for writer-lease and readiness tests. Only
 * the database is supplied by the test (a fake pool in unit tests, real PostgreSQL in integration
 * tests); Discord, Lodestone, scheduling and the queue are prototype-backed stand-ins that record
 * what startup asked of them. The channel-override monitor (2.35.0) is an idle stand-in unless the
 * test passes its own, so these tests never reach Discord or the database through it.
 */
import { Guild } from "discord.js";
import { pino } from "pino";
import { ApplicationLifecycle, type LifecycleOptions } from "../../src/application/lifecycle.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type {
  VisibilityMonitor,
  VisibilityStatus,
} from "../../src/application/visibility-alerts.js";
import type { Configuration } from "../../src/config/env.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import type { Database } from "../../src/infrastructure/postgres/database.js";
import { Queue } from "../../src/jobs/queue.js";

/** The application ID the stand-in gateway reports, so start() passes its identity check. */
const APPLICATION_ID = "123";

/** Build an instance of a class from its prototype plus replaced members, without its constructor. */
export function instance<T extends object>(
  type: abstract new (...args: never[]) => T,
  members: object,
): T {
  const value: unknown = Object.assign(Object.create(type.prototype), members);
  if (!(value instanceof type)) throw new Error(`Invalid ${type.name} fixture`);
  return value;
}

/** One structured pino line, as the lifecycle wrote it. */
export interface LogLine {
  level: number;
  msg: string;
  lock?: number;
  holderPid?: number;
  waitedMs?: number;
}
/** pino's numeric levels, so assertions can name them. */
export const LEVEL = { info: 30, warn: 40, error: 50 } as const;

export interface LifecycleHarness {
  lifecycle: ApplicationLifecycle;
  /** Every structured log line, in order. */
  logs: LogLine[];
  /** Exit codes requested through LifecycleOptions.exit (never the real process.exit). */
  exits: number[];
  /** Operations passed to the report callback. */
  reports: string[];
  /** How many times startup started the queue workers. */
  queueStarts: () => number;
  /** GET a health endpoint on the lifecycle's own probe server. */
  probe: (path: "/health/live" | "/health/ready") => Promise<{ status: number; body: Probe }>;
}
/** The probe fields these tests assert. */
export interface Probe {
  live: boolean;
  ready: boolean;
  database: boolean;
  writerLease: boolean;
  discord: boolean;
  visibility: VisibilityStatus;
}

/** Lifecycle options, where `visibility: "default"` asks for the lifecycle's own monitor. */
export type HarnessOptions = Partial<Omit<LifecycleOptions, "visibility">> & {
  readonly visibility?: VisibilityMonitor | "default";
};

/** A monitor's status before its first pass. */
export const NO_VISIBILITY: VisibilityStatus = {
  missing: null,
  onboardingPending: null,
  checked: null,
  checkedAt: null,
};

/**
 * A stand-in channel-override monitor: check() does nothing unless `check` is given, and status()
 * reports `status` (all nulls by default).
 */
export function visibilityStub(
  status: VisibilityStatus = NO_VISIBILITY,
  check: () => Promise<void> = async () => {},
): VisibilityMonitor {
  return { check, status: () => status };
}

/**
 * The gateway reports itself connected and correctly identified, so readiness depends only on
 * the lease and startup. Timing defaults are short; the process exit is recorded, not performed.
 * `guilds` are the guild IDs the gateway's cache reports present, which start() reconciles, and
 * `overrides` replace configuration values (effects stay off unless a test turns them on).
 * `options.visibility` replaces the idle monitor; "default" leaves the lifecycle to build its own.
 */
export function lifecycleHarness(
  db: Database,
  options: HarnessOptions = {},
  guilds: readonly string[] = [],
  overrides: Partial<Configuration> = {},
): LifecycleHarness {
  const logs: LogLine[] = [];
  const exits: number[] = [];
  const reports: string[] = [];
  let started = 0;
  const config: Configuration = {
    DATABASE_URL: "postgresql://unused/unused",
    DISCORD_TOKEN: "test-only",
    DISCORD_APPLICATION_ID: APPLICATION_ID,
    LOG_LEVEL: "info",
    ENABLE_EFFECTS: false,
    TEST_GUILD_ID: "",
    PUBLIC_TEST_RESPONSES: false,
    ROSTER_INTERVAL_SECONDS: 21600,
    VERIFICATION_SECONDS: 1800,
    GUEST_COOLDOWN_SECONDS: 86400,
    // Port 0 lets several lifecycles (and parallel test runs) listen side by side.
    HEALTH_PORT: 0,
    GITHUB_REPORTS_TOKEN: "",
    GITHUB_REPORTS_REPO: "deconfined/tarubot-reports",
    GITHUB_APP_CLIENT_ID: "",
    GITHUB_APP_PRIVATE_KEY: "",
    HEALTHCHECKS_PING_URL: "",
    ...overrides,
  };
  // A real SDK client that never logs in; only readiness and identity are replaced.
  const gateway = new DiscordGateway();
  Object.assign(gateway.client, { isReady: () => true, application: { id: APPLICATION_ID } });
  // start() reads only the cache's keys, so a prototype-backed stand-in per guild suffices (Guild's
  // constructor is private, so instance() cannot build it).
  for (const id of guilds)
    gateway.client.guilds.cache.set(
      id,
      Object.assign(Object.create(Guild.prototype) as Guild, { id }),
    );
  // The Lodestone adapter's lifecycle surface: started by the writer, stopped at shutdown.
  const app = instance(Service, {
    lodestone: {
      start: () => {},
      stop: () => {},
      status: () => ({ parsing: 0, waiting: 0, cooldownSeconds: 0, strikes: 0 }),
    },
  });
  const sync = instance(Synchronization, { schedule: async () => {} });
  const queue = instance(Queue, {
    start: () => {
      started++;
    },
    stop: async () => {},
  });
  const log = pino({ level: "info" }, { write: (line: string) => logs.push(JSON.parse(line)) });
  const { visibility = visibilityStub(), ...rest } = options;
  const lifecycle = new ApplicationLifecycle(
    config,
    db,
    gateway,
    app,
    sync,
    queue,
    log,
    (_error, operation) => reports.push(operation),
    {
      leaseRetryMs: 25,
      leaseWarnAfterMs: 60000,
      exit: (code) => exits.push(code),
      ...rest,
      ...(visibility === "default" ? {} : { visibility }),
    },
  );
  return {
    lifecycle,
    logs,
    exits,
    reports,
    queueStarts: () => started,
    probe: async (path) => {
      const response = await fetch(new URL(path, lifecycle.healthUrl));
      return { status: response.status, body: (await response.json()) as Probe };
    },
  };
}

/** Poll a condition on real timers; fails the test with the label instead of hanging. */
export async function eventually(label: string, condition: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** Track a promise's settlement without awaiting it, and keep its rejection handled. */
export function observe<T>(promise: Promise<T>): {
  settled: () => boolean;
  result: Promise<T>;
} {
  let settled = false;
  const result = promise.finally(() => {
    settled = true;
  });
  // The test awaits result later; this handler only prevents an unhandled-rejection report.
  result.catch(() => {});
  return { settled: () => settled, result };
}
