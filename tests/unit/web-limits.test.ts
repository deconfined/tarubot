/**
 * The web's in-memory limits (src/web/limits.ts): fixed windows per key, pruning of
 * ended windows, Retry-After rounding, the two POST refusals as the error page shows them, and
 * (2.40.0) the sign-in limits: the per-user refusal and D16's exchange gate, with its pause after
 * Discord's 429, its global rate and its concurrency cap.
 */
import { describe, expect, test } from "bun:test";
import { Failure } from "../../src/domain/values.js";
import { problemOf } from "../../src/web/http.js";
import {
  EXCHANGE_BUSY_SECONDS,
  EXCHANGE_CONCURRENCY,
  EXCHANGE_LIMIT,
  EXCHANGE_WINDOW_MS,
  ExchangeGate,
  overBudget,
  POST_WINDOW_MS,
  RateLimiter,
  SIGN_IN_LIMIT,
  SIGN_IN_WINDOW_MS,
  STOPPING_RETRY_AFTER,
  signInsBusy,
  stoppingRefusal,
  tooManySignIns,
} from "../../src/web/limits.js";

/** A limiter over a clock the test moves. */
function limiter(limit: number, windowMs: number) {
  const clock = { now: 1_000_000 };
  return { clock, limits: new RateLimiter(limit, windowMs, () => clock.now) };
}

describe("RateLimiter", () => {
  test("allows `limit` uses per key in a window, then refuses until the window ends", () => {
    const { clock, limits } = limiter(3, 60_000);
    expect([limits.take("a"), limits.take("a"), limits.take("a")]).toEqual([0, 0, 0]);
    expect(limits.take("a")).toBe(60);
    // Another key has its own window.
    expect(limits.take("b")).toBe(0);
    clock.now += 59_999;
    expect(limits.take("a")).toBe(1);
    // The window ends exactly windowMs after the key's first use.
    clock.now += 1;
    expect(limits.take("a")).toBe(0);
    expect([limits.take("a"), limits.take("a"), limits.take("a")]).toEqual([0, 0, 60]);
  });

  test("a refused use isn't counted, so hammering doesn't push the window out", () => {
    const { clock, limits } = limiter(1, 10_000);
    expect(limits.take("a")).toBe(0);
    for (let index = 0; index < 50; index++) {
      clock.now += 100;
      expect(limits.take("a")).toBeGreaterThan(0);
    }
    clock.now = 1_000_000 + 10_000;
    expect(limits.take("a")).toBe(0);
  });

  test("Retry-After is whole seconds, rounded up and never 0", () => {
    const { clock, limits } = limiter(1, 10_000);
    limits.take("a");
    for (const [elapsed, expected] of [
      [0, 10],
      [1, 10],
      [999, 10],
      [1_000, 9],
      [1_001, 9],
      [9_000, 1],
      [9_001, 1],
      [9_999, 1],
    ] as const) {
      clock.now = 1_000_000 + elapsed;
      expect({ elapsed, wait: limits.take("a") }).toEqual({ elapsed, wait: expected });
    }
  });

  test("ended windows are dropped on the next take, so the map never grows with history", () => {
    const { clock, limits } = limiter(5, 1_000);
    for (let index = 0; index < 100; index++) limits.take(`user-${index}`);
    expect(limits.size).toBe(100);
    clock.now += 500;
    limits.take("late");
    expect(limits.size).toBe(101);
    clock.now += 500;
    // The first hundred ended; only "late" (started 500 ms ago) and the new key remain.
    limits.take("fresh");
    expect(limits.size).toBe(2);
    clock.now += 1_000;
    limits.take("late");
    expect(limits.size).toBe(1);
  });

  test("a clock that steps back never refuses a key whose window has ended", () => {
    const { clock, limits } = limiter(1, 1_000);
    limits.take("a");
    clock.now -= 5_000;
    limits.take("b");
    // "b" started earlier than "a" but sits after it, so pruning stops at the live "a" and keeps
    // the ended "b"; take() still judges "b" by its own window.
    clock.now += 5_500;
    expect(limits.take("a")).toBe(1);
    expect(limits.take("b")).toBe(0);
    expect(limits.take("b")).toBe(1);
  });

  test("refuses a limit or window that isn't a positive whole number", () => {
    for (const [limit, windowMs] of [
      [0, 1_000],
      [-1, 1_000],
      [1.5, 1_000],
      [Number.NaN, 1_000],
      [1, 0],
      [1, 0.5],
      [1, Number.POSITIVE_INFINITY],
    ] as const)
      expect(() => new RateLimiter(limit, windowMs)).toThrow();
  });
});

describe("POST refusals", () => {
  test("over budget is a 429 with the wait as Retry-After, in approved wording", () => {
    expect(POST_WINDOW_MS).toBe(600_000);
    const problem = problemOf(overBudget(412), "ref");
    expect(problem).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 412 });
    // The error page names the wait from Retry-After, so the message names none of its own.
    // Saves sent, not changes made: a POST that changes nothing counts too, on any page.
    expect(problem.message).toBe(
      "You've sent a lot of saves in a short time, so TaruBot didn't take this one.",
    );
  });

  test("stopping is a 429 with Retry-After, the same failure the pre-commit check throws", () => {
    const failure = stoppingRefusal();
    expect(failure.code).toBe("stopping");
    expect(problemOf(failure, "ref")).toMatchObject({
      status: 429,
      code: "stopping",
      retryAfter: STOPPING_RETRY_AFTER,
      message: "TaruBot is restarting, so nothing was saved.",
      level: "info",
    });
  });
});

describe("sign-in limits (2.40.0)", () => {
  test("the owner's numbers: 10 sign-ins per user per 10 minutes, 30 exchanges a minute, 4 at once", () => {
    expect([SIGN_IN_LIMIT, SIGN_IN_WINDOW_MS]).toEqual([10, 600_000]);
    expect([EXCHANGE_LIMIT, EXCHANGE_WINDOW_MS, EXCHANGE_CONCURRENCY]).toEqual([30, 60_000, 4]);
  });

  test("the per-user refusal is a 429 and the gate's a 503, each with Retry-After", () => {
    expect(problemOf(tooManySignIns(120), "ref")).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfter: 120,
      message: "That's a lot of sign-ins in a short time, so TaruBot didn't sign you in.",
      level: "info",
    });
    expect(problemOf(signInsBusy(7), "ref")).toMatchObject({
      status: 503,
      code: "unavailable",
      retryAfter: 7,
      message: "Lots of people are signing in right now, so TaruBot didn't sign you in.",
    });
    // A Retry-After is never 0, which would send none.
    expect(signInsBusy(0).retryAfter).toBe(1);
  });
});

/** A deferred exchange the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** What run() threw, or "ran" with its value. */
const outcome = (run: Promise<unknown>) =>
  run.then(
    (value) => ({ ran: value }),
    (error: unknown) =>
      error instanceof Failure
        ? { code: error.code, retryAfter: error.retryAfter }
        : { error: String(error) },
  );

describe("ExchangeGate", () => {
  /** Discord's 429 as oauth.ts's triage throws it. */
  const limited = (seconds: number) =>
    new Failure("unavailable", "Discord is limiting sign-ins right now.", seconds, {
      kind: "discord",
      what: "api",
    });

  test("caps the exchanges running at once, and frees a place when one settles", async () => {
    const clock = { now: 0 };
    const gate = new ExchangeGate({ now: () => clock.now, concurrency: 2 });
    const first = deferred<string>();
    const second = deferred<string>();
    const running = [gate.run(() => first.promise), gate.run(() => second.promise)];
    expect(gate.inFlight).toBe(2);
    let started = false;
    expect(
      await outcome(
        gate.run(async () => {
          started = true;
          return "third";
        }),
      ),
    ).toEqual({ code: "unavailable", retryAfter: EXCHANGE_BUSY_SECONDS });
    expect(started).toBe(false);
    // A failed exchange frees its place as a successful one does.
    first.reject(new Error("transport"));
    second.resolve("second");
    expect(await Promise.allSettled(running)).toMatchObject([
      { status: "rejected" },
      { status: "fulfilled", value: "second" },
    ]);
    expect(gate.inFlight).toBe(0);
    expect(await outcome(gate.run(async () => "again"))).toEqual({ ran: "again" });
  });

  test("starts at most `limit` exchanges a window, across every user, then says when", async () => {
    const clock = { now: 0 };
    const gate = new ExchangeGate({ now: () => clock.now, limit: 3, windowMs: 60_000 });
    for (let index = 0; index < 3; index++)
      expect(await outcome(gate.run(async () => index))).toEqual({ ran: index });
    clock.now += 20_000;
    expect(await outcome(gate.run(async () => "over"))).toEqual({
      code: "unavailable",
      retryAfter: 40,
    });
    clock.now += 40_000;
    expect(await outcome(gate.run(async () => "next window"))).toEqual({ ran: "next window" });
  });

  test("a refusal by the cap spends none of the rate", async () => {
    const clock = { now: 0 };
    const gate = new ExchangeGate({ now: () => clock.now, limit: 2, concurrency: 1 });
    const held = deferred<string>();
    const running = gate.run(() => held.promise);
    for (let index = 0; index < 5; index++)
      expect(await outcome(gate.run(async () => "refused"))).toMatchObject({
        code: "unavailable",
      });
    held.resolve("done");
    await running;
    expect(await outcome(gate.run(async () => "second of two"))).toEqual({ ran: "second of two" });
  });

  test("Discord's 429 pauses every exchange until its Retry-After has passed", async () => {
    const clock = { now: 0 };
    const gate = new ExchangeGate({ now: () => clock.now });
    // The 429 itself reaches its sign-in unchanged.
    expect(
      await outcome(
        gate.run(async () => {
          throw limited(30);
        }),
      ),
    ).toEqual({ code: "unavailable", retryAfter: 30 });
    expect(gate.pausedFor()).toBe(30);
    clock.now += 12_500;
    let asked = 0;
    const ask = async () => {
      asked++;
      return "signed in";
    };
    expect(await outcome(gate.run(ask))).toEqual({ code: "unavailable", retryAfter: 18 });
    expect(asked).toBe(0);
    clock.now += 17_500;
    expect(gate.pausedFor()).toBe(0);
    expect(await outcome(gate.run(ask))).toEqual({ ran: "signed in" });
    expect(asked).toBe(1);
  });

  test("a later, longer 429 extends the pause and a shorter one never shortens it", async () => {
    const clock = { now: 0 };
    const gate = new ExchangeGate({ now: () => clock.now, concurrency: 2 });
    const long = deferred<never>();
    const short = deferred<never>();
    const runs = [gate.run(() => long.promise), gate.run(() => short.promise)];
    long.reject(limited(60));
    short.reject(limited(5));
    await Promise.allSettled(runs);
    expect(gate.pausedFor()).toBe(60);
  });

  test("other failures, including Discord being unreachable, start no pause", async () => {
    const gate = new ExchangeGate({ now: () => 0 });
    for (const error of [
      new Failure("unavailable", "Discord's sign-in isn't answering right now."),
      new Failure("expired", "That sign-in code expired or was already used."),
      new Failure("rate_limited", "Not Discord's answer.", 30),
      new Error("transport"),
    ])
      await outcome(
        gate.run(async () => {
          throw error;
        }),
      );
    expect(gate.pausedFor()).toBe(0);
  });

  test("refuses a concurrency cap that isn't a positive whole number", () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN])
      expect(() => new ExchangeGate({ concurrency })).toThrow();
  });
});
