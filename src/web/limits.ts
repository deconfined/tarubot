/**
 * The web's in-memory limits (#43): fixed-window counters per key, and the two refusals a page
 * POST can meet before it costs a Discord request, the per-page budget and a shutdown in progress
 * (docs/MODULES.md's web layer). Counting in memory is exact because one process serves the web
 * (W1); a restart forgets the counts, which only ever errs toward letting a request through. Keys
 * are Discord user IDs with the page and server (2.40.0 adds one global key, for token
 * exchanges), never client addresses, so no address is kept here or anywhere else.
 */
import { Failure } from "../domain/values.js";

/**
 * The refusal of a POST once shutdown has begun: server.ts answers it before the budget or a
 * Discord request. It lives in the domain, where the application operations that throw the same
 * failure from their pre-commit check (src/application/self-roles.ts) reach it too.
 */
export { STOPPING_RETRY_AFTER, stoppingRefusal } from "../domain/values.js";

/** The window every page's postLimit counts in. */
export const POST_WINDOW_MS = 10 * 60_000;

/**
 * The refusal of a POST over its page's budget: a 429 with Retry-After in whole seconds. The error
 * page says how long to wait, from Retry-After, so the message doesn't.
 */
export function overBudget(retryAfter: number): Failure {
  return new Failure(
    "rate_limited",
    "That's a lot of changes in a short time, so TaruBot didn't save this one.",
    retryAfter,
  );
}

/** One key's window: when it began, and how many uses it has counted. */
interface Window {
  readonly start: number;
  count: number;
}

/**
 * At most `limit` uses per key in each fixed window of `windowMs`, starting at a key's first use.
 * Every take() first drops the windows that have ended, so the map holds only keys used within
 * the last window and never grows with history. The Map keeps insertion order and a window is
 * only ever inserted at `now`, so the oldest come first and pruning stops at the first live one;
 * a clock that steps backwards can only leave an ended window for a later take() to drop.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("A rate limit must be a positive whole number.");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1)
      throw new Error("A rate limit's window must be a positive whole number of milliseconds.");
  }

  /**
   * Count one use of `key`. Returns 0 when it is allowed, or, when the key has used its limit in
   * the current window, the whole seconds until that window ends, rounded up and at least 1, for
   * Retry-After (so a client that waits exactly that long is let through). A refused use isn't
   * counted, so a client hammering the limit doesn't push its own window further out.
   */
  take(key: string): number {
    const now = this.now();
    for (const [stored, window] of this.windows) {
      if (now - window.start < this.windowMs) break;
      this.windows.delete(stored);
    }
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      // Deleted first, so the new window goes to the end and the order stays oldest-first.
      this.windows.delete(key);
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    if (window.count < this.limit) {
      window.count++;
      return 0;
    }
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  /** Keys held since the last take()'s pruning; tests read it to prove ended windows go. */
  get size(): number {
    return this.windows.size;
  }
}
