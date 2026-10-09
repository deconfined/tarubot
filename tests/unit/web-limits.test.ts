/**
 * The web's in-memory limits (src/web/limits.ts): fixed windows per key, pruning of
 * ended windows, Retry-After rounding, and the two POST refusals as the error page shows them.
 */
import { describe, expect, test } from "bun:test";
import { problemOf } from "../../src/web/http.js";
import {
  overBudget,
  POST_WINDOW_MS,
  RateLimiter,
  STOPPING_RETRY_AFTER,
  stoppingRefusal,
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
    expect(problem.message).toBe(
      "That's a lot of changes in a short time, so TaruBot didn't save this one.",
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
