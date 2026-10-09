/**
 * Web sessions (#43 W2, migration 011): PgSessions against disposable PostgreSQL in a private
 * schema, and the same scenarios against tests/fixtures/web-sessions.ts's MemorySessions, so the
 * fake the web's unit tests use keeps the real store's rules. Time passes by moving every stored
 * timestamp back in PostgreSQL (expiry is judged on the database clock) and by moving the fake's
 * injected clock forward.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import {
  hashToken,
  PgSessions,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  SESSIONS_PER_USER,
  type SessionStore,
} from "../../src/web/sessions.js";
import { MemorySessions } from "../fixtures/web-sessions.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "web_sessions_it";
const DAY = 24 * 3600_000;
/**
 * How far before a boundary a "not yet" check runs. PostgreSQL's now() keeps running between
 * statements while elapse() moves only the stored times, so this also bounds the wall time a check
 * may take; wider than any stall a test survives (bun's default per-test timeout is 5 s).
 */
const MARGIN = 10_000;
/** Invented Discord user IDs. */
const ALICE = "930000000000000001";
const BOB = "930000000000000002";

/** A store and the controls its scenarios need, the same for PostgreSQL and the fake. */
interface Harness {
  readonly store: SessionStore;
  /** Let `ms` pass for every stored session. */
  elapse(ms: number): Promise<void>;
  /** Every stored row, expired ones included, by key. */
  rows(): Promise<{ tokenHash: string; userId: string; lastSeenAt: Date }[]>;
  /** Statements (or fake lookups) that reached storage so far. */
  queries(): number;
}

/** The lastSeenAt stored for a token, read without going through the store. */
async function storedSeen(harness: Harness, token: string): Promise<Date | undefined> {
  return (await harness.rows()).find((row) => row.tokenHash === hashToken(token))?.lastSeenAt;
}

/** The scenarios every SessionStore must pass. */
function scenarios(harness: () => Harness) {
  test("create stores only the token's hash and starts the absolute expiry", async () => {
    const { store, rows } = harness();
    const first = await store.create(ALICE);
    const second = await store.create(ALICE);
    for (const { token } of [first, second]) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // A new token at every sign-in: the server rotates by deleting the old one and creating anew.
    expect(first.token).not.toBe(second.token);
    const { session } = first;
    expect(session.userId).toBe(ALICE);
    expect(session.authenticatedAt).toEqual(session.createdAt);
    expect(session.lastSeenAt).toEqual(session.createdAt);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(SESSION_ABSOLUTE_MS);
    expect(await store.get(first.token)).toEqual(session);
    const stored = await rows();
    expect(stored.map((row) => row.tokenHash).sort()).toEqual(
      [hashToken(first.token), hashToken(second.token)].sort(),
    );
    expect(JSON.stringify(stored)).not.toContain(first.token);
    expect(JSON.stringify(stored)).not.toContain(second.token);
  });

  test("last_seen_at is touched at most every SESSION_TOUCH_MS", async () => {
    const h = harness();
    const { token } = await h.store.create(ALICE);
    await h.elapse(SESSION_TOUCH_MS - MARGIN);
    const early = await storedSeen(h, token);
    // Not due yet: the session comes back as stored, and nothing is written.
    expect((await h.store.get(token))?.lastSeenAt).toEqual(early);
    expect(await storedSeen(h, token)).toEqual(early);
    await h.elapse(2 * MARGIN);
    const before = await storedSeen(h, token);
    const touched = await h.store.get(token);
    if (!touched || !before) throw new Error("Missing session");
    // Due: the store's clock is the new last_seen_at, returned and stored.
    const moved = touched.lastSeenAt.getTime() - before.getTime();
    expect(moved).toBeGreaterThanOrEqual(SESSION_TOUCH_MS + MARGIN);
    expect(moved).toBeLessThan(SESSION_TOUCH_MS + 60_000);
    expect(await storedSeen(h, token)).toEqual(touched.lastSeenAt);
    // Right after a touch, the next request writes nothing again.
    expect((await h.store.get(token))?.lastSeenAt).toEqual(touched.lastSeenAt);
  });

  test("seven idle days end a session; activity keeps it", async () => {
    const h = harness();
    const active = await h.store.create(ALICE);
    const idle = await h.store.create(ALICE);
    await h.elapse(SESSION_IDLE_MS - MARGIN);
    expect(await h.store.get(active.token)).not.toBeNull();
    await h.elapse(MARGIN);
    // Exactly SESSION_IDLE_MS without a request is expired, as sweep() agrees.
    expect(await h.store.get(idle.token)).toBeNull();
    expect(await h.store.get(active.token)).not.toBeNull();
  });

  test("thirty days end a session however active it is", async () => {
    const h = harness();
    const { token } = await h.store.create(ALICE);
    for (let week = 0; week < 4; week++) {
      await h.elapse(6 * DAY);
      expect(await h.store.get(token)).not.toBeNull();
    }
    await h.elapse(6 * DAY - MARGIN);
    expect(await h.store.get(token)).not.toBeNull();
    await h.elapse(MARGIN);
    expect(await h.store.get(token)).toBeNull();
  });

  test("a refused idle-expired session is not touched, so it stays expired", async () => {
    const h = harness();
    const { token } = await h.store.create(ALICE);
    await h.elapse(SESSION_IDLE_MS + 60_000);
    const seen = await storedSeen(h, token);
    expect(await h.store.get(token)).toBeNull();
    expect(await storedSeen(h, token)).toEqual(seen);
    expect(await h.store.get(token)).toBeNull();
  });

  test("delete signs out one browser; unknown tokens are not an error", async () => {
    const { store } = harness();
    const first = await store.create(ALICE);
    const second = await store.create(ALICE);
    await store.delete(first.token);
    expect(await store.get(first.token)).toBeNull();
    expect(await store.get(second.token)).not.toBeNull();
    await store.delete(first.token);
    await store.delete("A".repeat(43));
  });

  test("deleteForUser signs out every browser of one user and counts them", async () => {
    const { store } = harness();
    const alice = [await store.create(ALICE), await store.create(ALICE)];
    const bob = await store.create(BOB);
    expect(await store.deleteForUser(ALICE)).toBe(2);
    for (const { token } of alice) expect(await store.get(token)).toBeNull();
    expect(await store.get(bob.token)).not.toBeNull();
    expect(await store.deleteForUser(ALICE)).toBe(0);
  });

  test("sweep deletes idle and absolutely expired rows and keeps live ones", async () => {
    const h = harness();
    const old = await h.store.create(ALICE);
    for (let week = 0; week < 4; week++) {
      await h.elapse(6 * DAY);
      expect(await h.store.get(old.token)).not.toBeNull();
    }
    const idle = await h.store.create(BOB);
    // Day 30: `old` reaches its absolute expiry though it was seen six days ago, and `idle` has
    // gone only six days without a request, so this sweep deletes by absolute expiry alone.
    await h.elapse(6 * DAY);
    expect(await h.store.sweep()).toBe(1);
    const fresh = await h.store.create(BOB);
    // Day 31: `idle` has gone seven days without a request.
    await h.elapse(DAY);
    expect(await h.store.sweep()).toBe(1);
    expect((await h.rows()).map((row) => row.tokenHash)).toEqual([hashToken(fresh.token)]);
    expect(await h.store.get(fresh.token)).not.toBeNull();
    for (const { token } of [old, idle]) expect(await h.store.get(token)).toBeNull();
    expect(await h.store.sweep()).toBe(0);
  });

  test("a user keeps at most ten live sessions: a sign-in beyond them ends the oldest", async () => {
    const h = harness();
    expect(SESSIONS_PER_USER).toBe(10);
    const alice = [];
    for (let index = 0; index < SESSIONS_PER_USER; index++) {
      alice.push(await h.store.create(ALICE));
      // Distinct sign-in times, oldest first.
      await h.elapse(1_000);
    }
    const bob = await h.store.create(BOB);
    const newest = await h.store.create(ALICE);
    const [oldest, second] = alice;
    if (!oldest || !second) throw new Error("Missing session");
    expect(await h.store.get(oldest.token)).toBeNull();
    expect(await h.store.get(second.token)).not.toBeNull();
    expect(await h.store.get(newest.token)).not.toBeNull();
    // Another user's sessions don't count, and aren't touched.
    expect(await h.store.get(bob.token)).not.toBeNull();
    const rows = await h.rows();
    expect(rows.filter((row) => row.userId === ALICE)).toHaveLength(SESSIONS_PER_USER);
    // The next sign-in ends the next oldest, and the one just made always stays.
    const latest = await h.store.create(ALICE);
    expect(await h.store.get(second.token)).toBeNull();
    expect(await h.store.get(latest.token)).not.toBeNull();
    expect(await h.store.get(newest.token)).not.toBeNull();
  });

  test("only live sessions count toward the cap; expired ones are left to sweep", async () => {
    const h = harness();
    // The oldest sign-in, kept alive by use.
    const active = await h.store.create(ALICE);
    await h.elapse(1_000);
    // Nine newer sign-ins that are never used again.
    for (let index = 1; index < SESSIONS_PER_USER; index++) await h.store.create(ALICE);
    for (let day = 0; day < 7; day++) {
      await h.elapse(DAY);
      expect(await h.store.get(active.token)).not.toBeNull();
    }
    await h.elapse(SESSION_TOUCH_MS);
    expect(await h.store.get(active.token)).not.toBeNull();
    // Ten rows, nine of them idle-expired: a sign-in now ends nothing live. Counting every row by
    // sign-in time would have kept the nine dead ones and ended the one in use.
    const fresh = await h.store.create(ALICE);
    expect(await h.store.get(active.token)).not.toBeNull();
    expect(await h.store.get(fresh.token)).not.toBeNull();
    expect(await h.store.sweep()).toBe(SESSIONS_PER_USER - 1);
  });

  test("a malformed cookie value is refused without touching storage", async () => {
    const h = harness();
    const { token } = await h.store.create(ALICE);
    const before = h.queries();
    for (const value of [
      "",
      "x",
      `${token}=`,
      `${token}x`,
      token.slice(1),
      `${token.slice(0, 42)}+`,
      `${token.slice(0, 42)}/`,
      " ".repeat(43),
      hashToken(token),
    ]) {
      expect(await h.store.get(value)).toBeNull();
      await h.store.delete(value);
    }
    expect(h.queries()).toBe(before);
    expect(await h.store.get(token)).not.toBeNull();
  });

  test("create refuses a user ID the external_id domain would", async () => {
    const { store } = harness();
    for (const user of ["", "0", "abc", "18446744073709551616"])
      await expect(store.create(user)).rejects.toThrow();
  });
}

describe("MemorySessions keeps PgSessions' rules", () => {
  let now = Date.parse("2026-10-04T12:00:00.000Z");
  let current: Harness;
  beforeEach(() => {
    const store = new MemorySessions(() => now);
    current = {
      store,
      elapse: async (ms) => {
        now += ms;
      },
      rows: async () =>
        store.rows().map(({ tokenHash, session }) => ({
          tokenHash,
          userId: session.userId,
          lastSeenAt: session.lastSeenAt,
        })),
      queries: () => store.lookups,
    };
  });
  scenarios(() => current);
});

describe.skipIf(!url)("PgSessions against PostgreSQL", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  const store = new PgSessions(db);
  // Every statement the store sends goes through the pool; observations use `admin` instead.
  const statements = spyOn(db.pool, "query");
  const harness: Harness = {
    store,
    // Moving every instant back is time passing for the rows, measured on the database clock.
    elapse: async (ms) => {
      await admin.query(
        `UPDATE ${SCHEMA}.web_sessions SET
           created_at = created_at - $1::double precision * interval '1 millisecond',
           authenticated_at = authenticated_at - $1::double precision * interval '1 millisecond',
           last_seen_at = last_seen_at - $1::double precision * interval '1 millisecond',
           expires_at = expires_at - $1::double precision * interval '1 millisecond'`,
        [ms],
      );
    },
    rows: () =>
      admin.query<{ tokenHash: string; userId: string; lastSeenAt: Date }>(
        `SELECT token_hash AS "tokenHash", user_id AS "userId", last_seen_at AS "lastSeenAt"
         FROM ${SCHEMA}.web_sessions ORDER BY token_hash`,
      ),
    queries: () => statements.mock.calls.length,
  };
  /** The row's transaction ID: it changes exactly when the row is written. */
  const version = async (token: string) =>
    (
      await admin.query<{ xmin: string }>(
        `SELECT xmin::text FROM ${SCHEMA}.web_sessions WHERE token_hash = $1`,
        [hashToken(token)],
      )
    )[0]?.xmin;

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
    await db.schema();
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE ${SCHEMA}.web_sessions`);
  });
  afterAll(async () => {
    statements.mockRestore();
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  scenarios(() => harness);

  test("get is one statement, and writes the row only when a touch is due", async () => {
    const { token } = await store.create(ALICE);
    const created = await version(token);
    let before = harness.queries();
    expect(await store.get(token)).not.toBeNull();
    expect(harness.queries() - before).toBe(1);
    expect(await version(token)).toBe(created);
    await harness.elapse(SESSION_TOUCH_MS);
    const due = await version(token);
    before = harness.queries();
    expect(await store.get(token)).not.toBeNull();
    expect(harness.queries() - before).toBe(1);
    const touched = await version(token);
    expect(touched).not.toBe(due);
    // Concurrent requests after a touch all see the session, and none writes again.
    const many = await Promise.all(Array.from({ length: 5 }, () => store.get(token)));
    expect(many.every((session) => session?.userId === ALICE)).toBe(true);
    expect(await version(token)).toBe(touched);
  });

  test("concurrent requests when a touch is due all succeed and touch once", async () => {
    const { token } = await store.create(ALICE);
    await harness.elapse(SESSION_TOUCH_MS);
    const due = await version(token);
    const stale = (await storedSeen(harness, token))?.getTime();
    const many = await Promise.all(Array.from({ length: 5 }, () => store.get(token)));
    expect(many.every((session) => session?.userId === ALICE)).toBe(true);
    // Each answer is the stored value or the one touch: a second touch would return its own
    // now(), a third distinct instant. The row holds that one touch.
    const touches = new Set(
      many.map((session) => session?.lastSeenAt.getTime()).filter((at) => at !== stale),
    );
    expect([...touches]).toEqual([(await storedSeen(harness, token))?.getTime()]);
    expect(await version(token)).not.toBe(due);
  });

  test("expiry ignores the process clock", async () => {
    const { token } = await store.create(ALICE);
    // A host clock far past both expiries: the database clock still says the session is fresh.
    setSystemTime(new Date(Date.now() + 40 * DAY));
    try {
      expect(await store.get(token)).not.toBeNull();
      expect(await store.sweep()).toBe(0);
    } finally {
      setSystemTime();
    }
    expect(await harness.rows()).toHaveLength(1);
  });

  test("the table holds the SHA-256 hex of the token and nothing that could replay it", async () => {
    const { token } = await store.create(ALICE);
    const [row] = await admin.query<Record<string, unknown>>(
      `SELECT * FROM ${SCHEMA}.web_sessions`,
    );
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "authenticated_at",
      "created_at",
      "expires_at",
      "last_seen_at",
      "token_hash",
      "user_id",
    ]);
    expect(row?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test("the CHECK and the domain refuse what PgSessions never writes", async () => {
    const insert = (hash: string, user = ALICE) =>
      admin.query(
        `INSERT INTO ${SCHEMA}.web_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now())`,
        [hash, user],
      );
    for (const hash of ["abc", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)])
      await expect(insert(hash)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("a".repeat(64), "not-a-user")).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(`INSERT INTO ${SCHEMA}.web_sessions (token_hash, user_id) VALUES ($1, $2)`, [
        "b".repeat(64),
        ALICE,
      ]),
    ).rejects.toMatchObject({ code: "23502" });
    await insert("c".repeat(64));
    expect(await harness.rows()).toHaveLength(1);
  });
});
