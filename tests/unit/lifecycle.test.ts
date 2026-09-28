/**
 * Writer-lease sequencing without PostgreSQL: a fake pool client stands in for the dedicated lease
 * session, so readiness, startup refusal, log escalation, release, loss (an error event, a silent
 * session, or a missing lock found by the periodic check), a session that goes silent while waiting,
 * the shutdown deadline's exit status, shutdown's wait for drained work (2.28.0), and readiness's
 * informational channel-override counts with the scheduler's visibility check (2.35.0) run in every
 * unit pass.
 * tests/integration/lifecycle.test.ts repeats the contention and release against real advisory locks.
 */
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import {
  type ApplicationLifecycle,
  type LifecycleOptions,
  WRITER_LEASE_LOCK,
} from "../../src/application/lifecycle.js";
import { Service } from "../../src/application/service.js";
import {
  VisibilityAlerts,
  type VisibilityMonitor,
} from "../../src/application/visibility-alerts.js";
import { Failure } from "../../src/domain/values.js";
import { Database, orm } from "../../src/infrastructure/postgres/database.js";
import {
  eventually,
  type HarnessOptions,
  instance,
  LEVEL,
  type LifecycleHarness,
  lifecycleHarness,
  NO_VISIBILITY,
  observe,
  visibilityStub,
} from "../fixtures/lifecycle.js";

/** A statement as the lifecycle sends it: plain text with values, or a config with a read timeout. */
type Statement = string | { text: string; values?: unknown[]; query_timeout?: number };

/**
 * The dedicated lease session: grants the lock only once `available`, answers the periodic check
 * with `holding`, and records its statements. With `silent`, the session (waiting or held) stops
 * answering, as a half-open socket does: a statement fails only through its own read timeout, as
 * node-postgres's query_timeout makes it fail, and hangs forever without one.
 */
class FakeLeaseClient extends EventEmitter {
  available = false;
  holding = true;
  silent = false;
  readonly statements: string[] = [];
  /** The read timeout each statement carried, in order (undefined for none). */
  readonly timeouts: (number | undefined)[] = [];
  /** What release() received: undefined while checked out, false for a clean return. */
  released: unknown;
  constructor() {
    super();
    // Database's pool 'connect' hook gives every real client an error listener (it clears healthy).
    this.on("error", () => {});
  }
  async query(statement: Statement, parameters: unknown[] = []) {
    const {
      text,
      values = parameters,
      query_timeout,
    } = typeof statement === "string" ? { text: statement } : statement;
    this.statements.push(text);
    this.timeouts.push(query_timeout);
    if (this.silent)
      return new Promise<never>((_resolve, reject) => {
        if (query_timeout) setTimeout(() => reject(new Error("Query read timeout")), query_timeout);
      });
    expect(values).toEqual([WRITER_LEASE_LOCK]);
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: this.available }] };
    if (text.includes("pg_backend_pid")) return { rows: [{ held: this.holding }] };
    if (text.includes("pg_locks")) return { rows: [{ pid: 4242 }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
    throw new Error(`Unexpected lease statement: ${text}`);
  }
  release(error?: unknown) {
    this.released = error ?? false;
  }
  /** Lock attempts made so far. */
  attempts(): number {
    return this.statements.filter((text) => text.includes("pg_try_advisory_lock")).length;
  }
  /** Periodic lease checks made so far. */
  checks(): number {
    return this.statements.filter((text) => text.includes("pg_backend_pid")).length;
  }
}

/**
 * A Database whose schema check passes and whose pool hands out the one fake lease session. With
 * `hangs`, close() never resolves, as pool.end() does while a worker's client is stuck on a
 * half-open socket.
 */
function fakeDatabase(client: FakeLeaseClient, order: string[], hangs = false): Database {
  return instance(Database, {
    healthy: true,
    schema: async () => {},
    pool: { connect: async () => client },
    close: async () => {
      // pool.end() would hang on a still-checked-out lease client, so release must come first.
      order.push(client.released === undefined ? "close before release" : "close");
      if (hangs) await new Promise<void>(() => {});
    },
  });
}

const running: LifecycleHarness[] = [];
afterEach(async () => {
  // stop() is idempotent; this frees each test's probe port even when an assertion failed.
  await Promise.all(running.splice(0).map(({ lifecycle }) => lifecycle.stop()));
});
function harness(
  client: FakeLeaseClient,
  order: string[],
  options: Partial<LifecycleOptions> = {},
) {
  const created = lifecycleHarness(fakeDatabase(client, order), options);
  running.push(created);
  return created;
}

test("readiness stays false and startup refuses until the writer lease is held", async () => {
  const client = new FakeLeaseClient();
  const order: string[] = [];
  const { lifecycle, logs, probe, queueStarts } = harness(client, order);
  const prepared = observe(lifecycle.prepare());
  await eventually("two contended attempts", () => client.attempts() >= 2);
  expect(prepared.settled()).toBe(false);

  // Liveness stays 200 so a supervisor keeps the waiting process; readiness reports the lease.
  expect(await probe("/health/live")).toMatchObject({ status: 200, body: { live: true } });
  expect(await probe("/health/ready")).toMatchObject({
    status: 503,
    body: { ready: false, database: true, writerLease: false, discord: true },
  });
  // Waiting logs stay at info before the escalation threshold and name the holder's backend.
  const waiting = logs.filter((line) => line.msg.startsWith("Waiting for the database writer"));
  expect(waiting.length).toBeGreaterThanOrEqual(2);
  for (const line of waiting)
    expect(line).toMatchObject({ level: LEVEL.info, lock: WRITER_LEASE_LOCK, holderPid: 4242 });

  // A premature ready event cannot write or start workers without the lease.
  const ready = observe(lifecycle.whenReady());
  await expect(lifecycle.start()).rejects.toMatchObject({ code: "writer_lease" });
  await expect(ready.result).rejects.toMatchObject({ code: "writer_lease" });
  expect(queueStarts()).toBe(0);

  // The holder leaves: the next attempt acquires and prepare() resolves.
  client.available = true;
  await prepared.result;
  expect(logs.at(-1)).toMatchObject({ msg: "Database writer lease acquired", level: LEVEL.info });
  expect((await probe("/health/ready")).body).toMatchObject({ writerLease: true });
  // Held on the same session: no second checkout, no release yet.
  expect(client.released).toBeUndefined();

  await lifecycle.stop();
  expect(client.statements.at(-1)).toContain("pg_advisory_unlock");
  expect(client.released).toBe(false);
  expect(order).toEqual(["close"]);
});

test("waiting escalates to warn, and a shutdown while waiting releases the session unlocked", async () => {
  const client = new FakeLeaseClient();
  const order: string[] = [];
  const { lifecycle, logs } = harness(client, order, { leaseWarnAfterMs: 60 });
  const prepared = observe(lifecycle.prepare());
  await eventually("a warn-level waiting log", () =>
    logs.some((line) => line.level === LEVEL.warn),
  );
  const waiting = logs.filter((line) => line.msg.startsWith("Waiting for the database writer"));
  // Early attempts are info; once the continuous wait passes the threshold every line is warn.
  expect(waiting[0]).toMatchObject({ level: LEVEL.info });
  const firstWarn = waiting.findIndex((line) => line.level === LEVEL.warn);
  expect(waiting.slice(firstWarn).every((line) => line.level === LEVEL.warn)).toBe(true);
  expect(waiting[firstWarn]?.waitedMs).toBeGreaterThanOrEqual(60);

  // Shutdown wakes the retry delay at once: prepare() rejects so main.ts never logs in.
  const attempts = client.attempts();
  await lifecycle.stop();
  await expect(prepared.result).rejects.toMatchObject({ code: "stopping" });
  expect(client.attempts()).toBe(attempts);
  // Never held, so nothing to unlock; the session still returns before the pool closes.
  expect(client.statements.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
  expect(client.released).toBe(false);
  expect(order).toEqual(["close"]);
});

test("a lost lease session stops the writer and exits non-zero", async () => {
  const client = new FakeLeaseClient();
  client.available = true;
  const order: string[] = [];
  const { lifecycle, exits, reports, logs } = harness(client, order);
  await lifecycle.prepare();
  // pg emits 'error' on a checked-out client whose connection ends; PostgreSQL has freed the lock.
  client.emit("error", new Error("Connection terminated unexpectedly"));
  await eventually("the lost-lease exit", () => exits.length > 0);
  expect(exits).toEqual([1]);
  expect(reports).toEqual(["writer-lease"]);
  expect(lifecycle.isStopping()).toBe(true);
  expect(logs.some((line) => line.level === LEVEL.error && line.lock === WRITER_LEASE_LOCK)).toBe(
    true,
  );
  expect(order).toEqual(["close"]);
  // The errored session is destroyed, never unlocked over or returned to the pool.
  expect(client.released).toBe(true);
  expect(client.statements.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
  // A later error on the released session is not a second loss.
  client.emit("error", new Error("late"));
  expect(exits).toEqual([1]);
});

test("the periodic check keeps a healthy lease and bounds each statement on the session", async () => {
  const client = new FakeLeaseClient();
  client.available = true;
  const order: string[] = [];
  const { lifecycle, exits, probe } = harness(client, order, {
    leaseCheckMs: 10,
    leaseQueryTimeoutMs: 1000,
  });
  await lifecycle.prepare();
  await eventually("three lease checks", () => client.checks() >= 3);
  expect(exits).toEqual([]);
  expect((await probe("/health/ready")).body).toMatchObject({ writerLease: true });
  await lifecycle.stop();
  const checks = client.checks();
  await Bun.sleep(40);
  // Checks stop with the writer; the lock attempt, every check and the unlock carried the read
  // timeout (the wait loop's holder probe is covered by the silent-while-waiting test).
  expect(client.checks()).toBe(checks);
  expect(client.statements[0]).toContain("pg_try_advisory_lock");
  expect(client.statements.at(-1)).toContain("pg_advisory_unlock");
  expect(client.timeouts).toEqual(client.statements.map(() => 1000));
  expect(client.released).toBe(false);
  expect(order).toEqual(["close"]);
});

test("a lease session that stops answering is lost within the check's deadline", async () => {
  const client = new FakeLeaseClient();
  client.available = true;
  const order: string[] = [];
  const { lifecycle, exits, reports } = harness(client, order, {
    leaseCheckMs: 10,
    leaseQueryTimeoutMs: 30,
  });
  await lifecycle.prepare();
  // A half-open socket: no 'error' event ever arrives, and no statement is answered.
  client.silent = true;
  await eventually("the lost-lease exit", () => exits.length > 0);
  expect(exits).toEqual([1]);
  expect(reports).toEqual(["writer-lease"]);
  expect(lifecycle.isStopping()).toBe(true);
  // Destroyed without an unlock that would also hang; the pool closes only afterwards.
  expect(client.released).toBe(true);
  expect(client.statements.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
  expect(order).toEqual(["close"]);
});

test("a lease session that no longer holds the lock is lost", async () => {
  const client = new FakeLeaseClient();
  client.available = true;
  const order: string[] = [];
  const { lifecycle, exits, reports, probe } = harness(client, order, {
    leaseCheckMs: 10,
    leaseQueryTimeoutMs: 1000,
  });
  await lifecycle.prepare();
  expect((await probe("/health/ready")).body).toMatchObject({ writerLease: true });
  // For example a promoted standby: advisory locks are not replicated.
  client.holding = false;
  await eventually("the lost-lease exit", () => exits.length > 0);
  expect(exits).toEqual([1]);
  expect(reports).toEqual(["writer-lease"]);
  expect(client.released).toBe(true);
  expect(order).toEqual(["close"]);
});

test("a lease session that stops answering while waiting rejects prepare() and is destroyed", async () => {
  const client = new FakeLeaseClient();
  const order: string[] = [];
  const { lifecycle, exits, logs, probe } = harness(client, order, { leaseQueryTimeoutMs: 30 });
  const prepared = observe(lifecycle.prepare());
  // Contended attempts first: each lock attempt and holder probe is answered.
  await eventually("two contended attempts", () => client.attempts() >= 2);
  // A half-open socket during the wait (for example a failover while an overlapping deploy waits):
  // no 'error' event, no answer. Without a deadline prepare() would hang for TCP's retransmission.
  client.silent = true;
  await expect(prepared.result).rejects.toThrow("Query read timeout");
  expect(logs.some((line) => line.level === LEVEL.error && line.lock === WRITER_LEASE_LOCK)).toBe(
    true,
  );
  // Every wait statement, the lock attempts and the pg_locks holder probes, carried the deadline.
  expect(client.statements.some((text) => text.includes("pg_try_advisory_lock"))).toBe(true);
  expect(
    client.statements.some((text) => text.includes("pg_locks") && !text.includes("pg_backend_pid")),
  ).toBe(true);
  expect(client.timeouts).toEqual(client.statements.map(() => 30));
  expect((await probe("/health/ready")).body).toMatchObject({ ready: false, writerLease: false });
  // main.ts stops after the rejection: the session is destroyed, never unlocked over or pooled,
  // and the process then exits non-zero by rethrowing (no lease was held, so no lost-lease exit).
  await lifecycle.stop();
  expect(client.released).toBe(true);
  expect(client.statements.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
  expect(order).toEqual(["close"]);
  expect(exits).toEqual([]);
});

test("a shutdown that hangs still exits at the deadline, with status 1 after a lost lease", async () => {
  // Not registered for afterEach: stop() never resolves here, and close() has already stopped
  // each probe server before it reaches the hanging pool.
  const lost = new FakeLeaseClient();
  lost.available = true;
  const lostOrder: string[] = [];
  const failing = lifecycleHarness(fakeDatabase(lost, lostOrder, true), {
    leaseCheckMs: 10,
    leaseQueryTimeoutMs: 30,
    stopDeadlineMs: 100,
  });
  await failing.lifecycle.prepare();
  // The silent loss this check targets also hangs pool.end() on workers' half-open clients.
  lost.silent = true;
  await eventually("the deadline exit", () => failing.exits.length > 0);
  expect(failing.exits).toEqual([1]);
  expect(failing.reports).toEqual(["writer-lease"]);
  expect(lost.released).toBe(true);
  expect(lostOrder).toEqual(["close"]);

  // An ordinary shutdown that hangs the same way keeps status 0.
  const held = new FakeLeaseClient();
  held.available = true;
  const heldOrder: string[] = [];
  const stopping = lifecycleHarness(fakeDatabase(held, heldOrder, true), { stopDeadlineMs: 100 });
  await stopping.lifecycle.prepare();
  void stopping.lifecycle.stop();
  await eventually("the deadline exit", () => stopping.exits.length > 0);
  expect(stopping.exits).toEqual([0]);
  expect(stopping.reports).toEqual([]);
  expect(held.released).toBe(false);
  expect(heldOrder).toEqual(["close"]);
});

test("shutdown waits for drained work before it releases the lease and closes the pool (2.28.0)", async () => {
  // main.ts drains /suggest here: a post still at GitHub must write its audit row while this
  // process holds the lease and the pool is open, or the next writer's limits would miss it.
  const client = new FakeLeaseClient();
  client.available = true;
  const order: string[] = [];
  const finish = Promise.withResolvers<void>();
  const { lifecycle } = harness(client, order, {
    drain: async () => {
      await finish.promise;
      order.push(client.released === undefined ? "drained while held" : "drained after release");
    },
  });
  await lifecycle.prepare();
  const stopped = observe(lifecycle.stop());
  await Bun.sleep(30);
  // Still draining: the lease is held and nothing is unlocked or closed.
  expect(stopped.settled()).toBe(false);
  expect(client.statements.some((text) => text.includes("pg_advisory_unlock"))).toBe(false);
  expect(order).toEqual([]);
  finish.resolve();
  await stopped.result;
  expect(order).toEqual(["drained while held", "close"]);
  expect(client.statements.at(-1)).toContain("pg_advisory_unlock");
  expect(client.released).toBe(false);
});

test("a writer checks the schema again once it holds the lease, and refuses a migrated database", async () => {
  // An old release that passed its first check and then waited on the lease while a migration
  // committed must not log in: the second check fails, and stop() releases the lease unlocked.
  const client = new FakeLeaseClient();
  client.available = true;
  let checks = 0;
  const database = instance(Database, {
    healthy: true,
    schema: async () => {
      checks++;
      if (checks > 1) throw new Failure("schema", "Schema version/checksum mismatch.");
    },
    pool: { connect: async () => client },
    close: async () => {},
  });
  const created = lifecycleHarness(database, {});
  running.push(created);
  await expect(created.lifecycle.prepare()).rejects.toMatchObject({ code: "schema" });
  expect(checks).toBe(2);
  expect(created.logs.some((line) => line.msg === "Database writer lease acquired")).toBe(true);
  expect(created.queueStarts()).toBe(0);
  await created.lifecycle.stop();
  expect(client.statements.at(-1)).toContain("pg_advisory_unlock");
  expect(client.released).toBe(false);
});

/**
 * A pg client for the statements start() and the scheduler pass send outside the lease session,
 * through Drizzle: every statement answers no rows, except capabilityMetrics' aggregate, which
 * answers one row of zeros. While `gate` is pending, every statement waits for it.
 */
class FakeSqlClient {
  readonly statements: string[] = [];
  gate: Promise<void> | undefined;
  async query(statement: string | { text: string }) {
    const text = typeof statement === "string" ? statement : statement.text;
    this.statements.push(text);
    await this.gate;
    return {
      rows: text.includes("oldest_roster_age_seconds") ? [[0, 0, null, 0]] : [],
      rowCount: 0,
    };
  }
}
/** The fake client as the pg type Drizzle and Database.transaction expect. */
const asClient = (client: FakeSqlClient): PoolClient => client as unknown as PoolClient;

/**
 * fakeDatabase plus what start() and the scheduler pass use: a transaction and an ORM over one
 * FakeSqlClient, and the probe query.
 */
function readyDatabase(lease: FakeLeaseClient, order: string[]): Database {
  const sql = new FakeSqlClient();
  return instance(Database, {
    healthy: true,
    schema: async () => {},
    pool: { connect: async () => lease },
    close: async () => {
      order.push(lease.released === undefined ? "close before release" : "close");
    },
    query: async () => [],
    orm: orm(asClient(sql)),
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) =>
      operation(asClient(sql)),
  });
}

/** The scheduler pass, which start() runs every 30 seconds, run once now. */
const schedulerPass = (lifecycle: ApplicationLifecycle): Promise<void> =>
  (lifecycle as unknown as { observe(): Promise<void> }).observe();

/** A lifecycle over readyDatabase, registered for afterEach's stop, with the lease free. */
function readyHarness(options: HarnessOptions) {
  const lease = new FakeLeaseClient();
  lease.available = true;
  const created = lifecycleHarness(readyDatabase(lease, []), options);
  running.push(created);
  return { ...created, lease };
}

test("/health/ready carries the visibility counts, all null before a pass (2.35.0)", async () => {
  // The default monitor, over the harness's Service: before its first pass it knows nothing.
  const defaulted = readyHarness({ visibility: "default" });
  expect((await defaulted.probe("/health/ready")).body.visibility).toEqual(NO_VISIBILITY);
  // A monitor's stored counts appear as they are, field by field.
  const counted = {
    missing: 3,
    onboardingPending: 2,
    checked: 1,
    checkedAt: "2026-09-28T12:00:00.000Z",
  };
  const reporting = readyHarness({ visibility: visibilityStub(counted) });
  expect((await reporting.probe("/health/ready")).body.visibility).toEqual(counted);
});

test("VisibilityAlerts' constructor reaches neither the database nor Discord", () => {
  // The lifecycle builds it before the lease is held and before login.
  const app = instance(Service, {});
  for (const name of ["db", "discord"])
    Object.defineProperty(app, name, {
      get: () => {
        throw new Error(`The constructor read app.${name}`);
      },
    });
  const monitor = new VisibilityAlerts(app, () => true, { log: () => {}, report: () => {} });
  expect(monitor.status()).toEqual(NO_VISIBILITY);
});

test("the visibility counts never change readiness: 503 stays 503 and 200 stays 200", async () => {
  const failing = async () => {
    throw new Error("visibility check failed");
  };
  const monitors: [string, VisibilityMonitor][] = [
    ["a failing check", visibilityStub(NO_VISIBILITY, failing)],
    [
      "a large count",
      visibilityStub({
        missing: 1_000_000,
        onboardingPending: 1_000_000,
        checked: 1,
        checkedAt: "x",
      }),
    ],
    [
      "a throwing status",
      {
        check: async () => {},
        status: () => {
          throw new Error("status failed");
        },
      },
    ],
  ];
  for (const [label, visibility] of monitors) {
    const { lifecycle, lease, probe, reports } = readyHarness({ visibility });
    lease.available = false;
    const prepared = observe(lifecycle.prepare());
    await eventually(`a contended attempt (${label})`, () => lease.attempts() >= 1);
    // Unready while another writer holds the lease, whatever the monitor says.
    const unready = await probe("/health/ready");
    expect(unready.status).toBe(503);
    expect(unready.body.ready).toBe(false);
    lease.available = true;
    await prepared.result;
    await lifecycle.start();
    await schedulerPass(lifecycle);
    // Ready, with the database still healthy, whatever the monitor did.
    const ready = await probe("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ ready: true, database: true, writerLease: true });
    if (label === "a throwing status") expect(ready.body.visibility).toEqual(NO_VISIBILITY);
    if (label === "a large count") expect(ready.body.visibility.missing).toBe(1_000_000);
    expect(reports).toEqual(label === "a failing check" ? ["visibility alerts"] : []);
    await lifecycle.stop();
  }
});

test("each scheduler pass runs the reporter's tick, then the visibility check, and reports both", async () => {
  const order: string[] = [];
  const { lifecycle, reports, probe } = readyHarness({
    tick: async () => {
      order.push("tick");
      throw new Error("tick failed");
    },
    visibility: visibilityStub(NO_VISIBILITY, async () => {
      order.push("check");
      throw new Error("check failed");
    }),
  });
  await lifecycle.prepare();
  await lifecycle.start();
  await schedulerPass(lifecycle);
  // A failing tick doesn't skip the check; each failure is reported under its own operation.
  expect(order).toEqual(["tick", "check"]);
  expect(reports).toEqual(["issue reports", "visibility alerts"]);
  // The scheduler's own database probe succeeded, so readiness still holds.
  expect((await probe("/health/ready")).body).toMatchObject({ ready: true, database: true });
});

test("an overlapping visibility check returns at once and leaves the running pass alone", async () => {
  // The guild query waits on the gate, so the first pass is still running when the second starts.
  const sql = new FakeSqlClient();
  const release = Promise.withResolvers<void>();
  sql.gate = release.promise;
  const app = instance(Service, { db: { orm: orm(asClient(sql)) } });
  const monitor = new VisibilityAlerts(app, () => true, { log: () => {}, report: () => {} });
  const first = observe(monitor.check());
  await eventually("the first pass's guild query", () => sql.statements.length === 1);
  await monitor.check();
  // The second call issued nothing and left the first pending.
  expect(sql.statements).toHaveLength(1);
  expect(first.settled()).toBe(false);
  release.resolve();
  await first.result;
  // No servers: every count is zero, and the next call runs a pass of its own.
  expect(monitor.status()).toMatchObject({ missing: 0, onboardingPending: 0, checked: 0 });
  expect(typeof monitor.status().checkedAt).toBe("string");
  await monitor.check();
  expect(sql.statements).toHaveLength(2);
});
