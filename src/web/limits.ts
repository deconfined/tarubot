/**
 * The web's in-memory limits (#43): fixed-window counters per key, the two refusals a page POST
 * can meet before it costs a Discord request (the per-page budget and a shutdown in progress), and
 * from 2.40.0 the sign-in limits: one per Discord user, and D16's gate on the token exchanges every
 * sign-in costs Discord (docs/MODULES.md's web layer). Counting in memory is exact because one
 * process serves the web (W1); a restart forgets the counts, which only ever errs toward letting a
 * request through. Keys are Discord user IDs (with the page and server for POSTs) or one global
 * key for token exchanges, never client addresses, so no address is kept here or anywhere else.
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
 * page says how long to wait, from Retry-After, so the message doesn't. Every POST counts, one that
 * changes nothing included (refunding those would let them cost a fresh actor's Discord requests
 * without bound), so it speaks of saves sent, not changes made, and fits any page's buttons.
 */
export function overBudget(retryAfter: number): Failure {
  return new Failure(
    "rate_limited",
    "You've sent a lot of saves in a short time, so TaruBot didn't take this one.",
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

/** Sign-ins one Discord user may finish per SIGN_IN_WINDOW_MS (2.40.0, owner decision Q7). */
export const SIGN_IN_LIMIT = 10;
/** The per-user sign-in limit's window. */
export const SIGN_IN_WINDOW_MS = 10 * 60_000;

/**
 * The refusal of a sign-in over the per-user limit: a 429 with Retry-After, and no session. The
 * callback counts a sign-in once Discord has said who it is and before admission, which costs a
 * Discord request per server checked, so one account can't spend the bot's REST budget by
 * signing in again and again. The error page says how long to wait.
 */
export function tooManySignIns(retryAfter: number): Failure {
  return new Failure(
    "rate_limited",
    "That's a lot of sign-ins in a short time, so TaruBot didn't sign you in.",
    retryAfter,
  );
}

/** Token exchanges that may start per EXCHANGE_WINDOW_MS, across every user (D16). */
export const EXCHANGE_LIMIT = 30;
/** The exchange rate's window: a minute. */
export const EXCHANGE_WINDOW_MS = 60_000;
/** Token exchanges that may run at once, across every user (D16). */
export const EXCHANGE_CONCURRENCY = 4;
/**
 * Retry-After for a sign-in refused while EXCHANGE_CONCURRENCY exchanges run. An exchange is two
 * Discord requests of at most ten seconds each, and usually well under one.
 */
export const EXCHANGE_BUSY_SECONDS = 5;

/**
 * The refusal of a sign-in the exchange gate holds back: a 503 with Retry-After, made before any
 * Discord request, with no session. The error page says how long to wait.
 */
export function signInsBusy(retryAfter: number): Failure {
  return new Failure(
    "unavailable",
    "Lots of people are signing in right now, so TaruBot didn't sign you in.",
    Math.max(1, retryAfter),
  );
}

/** ExchangeGate's seams; production passes none. */
export interface ExchangeGateOptions {
  /** Milliseconds clock; defaults to performance.now. */
  readonly now?: () => number;
  /** Defaults to EXCHANGE_LIMIT per EXCHANGE_WINDOW_MS. */
  readonly limit?: number;
  readonly windowMs?: number;
  /** Defaults to EXCHANGE_CONCURRENCY. */
  readonly concurrency?: number;
}

/**
 * D16's gate around the Discord requests of a sign-in (the token exchange and /users/@me), which
 * leave from the bot's own egress address. Any client can get a valid `state` from /login and then
 * cost one token request per callback, and enough 401, 403 or 429 answers bring Discord's
 * address-wide ban, which would take the bot's REST API offline too. So, before each exchange and
 * in this order, every check deciding without a Discord request (each refusal is signInsBusy, a
 * 503 with Retry-After):
 * 1. the pause: after Discord answered 429 (a Failure carrying its Retry-After, oauth.ts's triage),
 *    no exchange starts until that delay has passed, so TaruBot never hammers Discord while it is
 *    limited;
 * 2. the concurrency cap, which bounds parallel floods;
 * 3. the rate, one global key, which bounds sequential ones. Checked last, so a refusal by the
 *    pause or the cap never spends it.
 * Admission isn't under the gate: it costs a member fetch per server and is bounded by the
 * per-user sign-in limit. Nothing here knows an address.
 */
export class ExchangeGate {
  private readonly now: () => number;
  private readonly rate: RateLimiter;
  private readonly concurrency: number;
  private running = 0;
  /** The clock's value when the current pause ends; nothing is paused before the first 429. */
  private pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: ExchangeGateOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.rate = new RateLimiter(
      options.limit ?? EXCHANGE_LIMIT,
      options.windowMs ?? EXCHANGE_WINDOW_MS,
      this.now,
    );
    this.concurrency = options.concurrency ?? EXCHANGE_CONCURRENCY;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1)
      throw new Error("An exchange concurrency cap must be a positive whole number.");
  }

  /**
   * Run one exchange through the gate, or refuse it with signInsBusy before it starts. A Failure
   * with a Retry-After from the exchange, which only Discord's 429 carries, starts or extends the
   * pause; it is rethrown unchanged, so that sign-in gets Discord's own 503.
   */
  async run<T>(exchange: () => Promise<T>): Promise<T> {
    const paused = this.pausedFor();
    if (paused > 0) throw signInsBusy(paused);
    if (this.running >= this.concurrency) throw signInsBusy(EXCHANGE_BUSY_SECONDS);
    const wait = this.rate.take("exchange");
    if (wait > 0) throw signInsBusy(wait);
    this.running++;
    try {
      return await exchange();
    } catch (error) {
      if (error instanceof Failure && error.code === "unavailable" && error.retryAfter > 0)
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + error.retryAfter * 1000);
      throw error;
    } finally {
      this.running--;
    }
  }

  /** Whole seconds until the pause ends, rounded up; 0 when sign-ins aren't paused. */
  pausedFor(): number {
    const left = this.pausedUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Exchanges running now; tests read it to prove the cap and its release. */
  get inFlight(): number {
    return this.running;
  }
}
