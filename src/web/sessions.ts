/**
 * Browser sessions for the web pages (#43 W2): opaque random tokens in a cookie, kept server-side
 * in the web_sessions table (migrations/011_web_sessions.sql). A row holds only the SHA-256 of the
 * token, the Discord user ID and timestamps: no IP address, user agent or Discord token. Expiry is
 * judged on the database clock, so a restored backup or a skewed host can't revive a session past
 * its absolute expiry. Sessions are created only for admitted users (ADR D17), and sign-in deletes
 * any session the browser already presented before creating a fresh one (rotation). A user keeps
 * at most SESSIONS_PER_USER live sessions: a sign-in beyond it ends their oldest (2.40.0).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, gt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { type Database, orm } from "../infrastructure/postgres/database.js";
import { webSessions } from "../infrastructure/postgres/schema.js";

/** A session ends after seven days without a request. */
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
/** A session ends thirty days after sign-in, however active. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
/** last_seen_at is written at most this often, so page views don't each cost a write. */
export const SESSION_TOUCH_MS = 10 * 60_000;
/** How often startWeb's timer deletes expired rows. */
export const SESSION_SWEEP_MS = 3600_000;
/**
 * Live sessions one user may hold (2.40.0, owner decision Q7): every member and guest can now sign
 * in, so one account can't pile up rows by signing in again and again. A sign-in beyond it ends
 * the user's oldest live sessions (by sign-in time), silently: the newest, including the one being
 * created, are kept. Ten covers a person's phones, computers and browsers with room to spare.
 */
export const SESSIONS_PER_USER = 10;

/** One signed-in browser. The token itself is never part of it. */
export interface Session {
  readonly userId: string;
  readonly createdAt: Date;
  /** When the user signed in with Discord; v4 can require a recent sign-in for sensitive writes. */
  readonly authenticatedAt: Date;
  readonly lastSeenAt: Date;
  /** The absolute expiry (createdAt + SESSION_ABSOLUTE_MS); idle expiry follows lastSeenAt. */
  readonly expiresAt: Date;
}

/** Where sessions live: PgSessions in the bot, an in-memory fake in unit tests. */
export interface SessionStore {
  /**
   * A new random token (32 bytes, base64url) for an admitted user; only its SHA-256 is stored. The
   * user's live sessions beyond SESSIONS_PER_USER, oldest sign-in first, end in the same step;
   * the new one always stays.
   */
  create(userId: string): Promise<{ token: string; session: Session }>;
  /**
   * null when unknown, idle-expired or absolutely expired, judged on the database clock. Touches
   * last_seen_at at most every SESSION_TOUCH_MS, in one statement (UPDATE … RETURNING). A value
   * that isn't a well-formed token returns null without a query.
   */
  get(token: string): Promise<Session | null>;
  /** Sign out this browser. An unknown or malformed token is not an error. */
  delete(token: string): Promise<void>;
  /** "Sign out everywhere". Returns the number of rows deleted. */
  deleteForUser(userId: string): Promise<number>;
  /** Deletes idle- or absolutely-expired rows; returns the count. */
  sweep(): Promise<number>;
}

/** Bytes of randomness in a token: 256 bits, so tokens can't be guessed or enumerated. */
const TOKEN_BYTES = 32;
/** A well-formed token: TOKEN_BYTES as unpadded base64url, exactly 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/** A new session token: 32 random bytes as unpadded base64url. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Whether a cookie value can be a session token. Anything else is refused before hashing or any
 * query, so a junk or oversized cookie costs nothing.
 */
export function isSessionToken(value: string): boolean {
  return TOKEN.test(value);
}

/** The stored key for a token: its SHA-256 as 64 lowercase hex characters. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** HMAC message for formToken; versioned, so a later derivation can't collide with this one. */
const FORM_TOKEN_CONTEXT = "tarubot web form token v1";

/**
 * The session's form token (owner decision 2026-10-09; see docs/MODULES.md and THREAT_MODEL),
 * which every POST form carries as a hidden field and the server compares in constant time
 * (http.ts's formTokenMatches). It is an HMAC-SHA-256 keyed with the session token, so it needs no
 * storage and no new secret, and only a holder of the HttpOnly cookie can compute it: a cross-site
 * page can't read the cookie or a page, so it can't forge one. It is one-way, so a token seen in a
 * page never reveals the session token, and it differs from hashToken (a keyed MAC, not the plain
 * hash web_sessions holds), so a database reader can't derive it either. A new sign-in rotates the
 * session token and with it this one: a form left open from an earlier sign-in is refused. 43
 * characters of unpadded base64url.
 */
export function formToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update(FORM_TOKEN_CONTEXT).digest("base64url");
}

const s = webSessions;
/** Whole seconds for the bound `n * interval '1 second'` expressions below. */
const IDLE_SECONDS = SESSION_IDLE_MS / 1000;
const ABSOLUTE_SECONDS = SESSION_ABSOLUTE_MS / 1000;
const TOUCH_SECONDS = SESSION_TOUCH_MS / 1000;
/** A row's Session fields. */
const SESSION = {
  userId: s.user_id,
  createdAt: s.created_at,
  authenticatedAt: s.authenticated_at,
  lastSeenAt: s.last_seen_at,
  expiresAt: s.expires_at,
};

/**
 * A row still in use on the database clock: before its absolute expiry and seen within the idle
 * window. sweep() deletes exactly the complement, so a row get() refuses is always sweepable.
 */
const LIVE = and(
  gt(s.expires_at, sql`now()`),
  gt(s.last_seen_at, sql`now()-${IDLE_SECONDS}*interval '1 second'`),
);

/**
 * The PostgreSQL store, through Drizzle on the bot's pool (db.orm) with bound values only, and
 * sql`now()` for every expiry decision. The raw token is never stored, logged or reported.
 */
export class PgSessions implements SessionStore {
  constructor(private readonly db: Database) {}

  /**
   * One transaction inserts the session and ends the user's live sessions beyond
   * SESSIONS_PER_USER. A per-user advisory lock serializes a user's concurrent sign-ins, so two of
   * them can't each count nine others and leave eleven. Rows already expired are left to sweep():
   * they admit nothing, and the cap counts only sessions that still could. Ties in sign-in time are
   * broken by the stored hash, so the choice is deterministic; the new row is excluded from the
   * deletion outright, never ranked.
   */
  async create(userId: string): Promise<{ token: string; session: Session }> {
    const token = newSessionToken();
    const tokenHash = hashToken(token);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `web-sessions:${userId}`,
      ]);
      // created_at, authenticated_at and last_seen_at take their now() defaults: the same instant
      // as the expiry's now(), since now() is fixed for the transaction.
      const [session] = await db
        .insert(s)
        .values({
          token_hash: tokenHash,
          user_id: userId,
          expires_at: sql`now()+${ABSOLUTE_SECONDS}*interval '1 second'`,
        })
        .returning(SESSION);
      if (!session) throw new Error("The session insert returned no row");
      const others = and(eq(s.user_id, userId), ne(s.token_hash, tokenHash), LIVE);
      const newest = db
        .select({ token_hash: s.token_hash })
        .from(s)
        .where(others)
        .orderBy(desc(s.created_at), desc(s.token_hash))
        .limit(SESSIONS_PER_USER - 1);
      await db.delete(s).where(and(others, notInArray(s.token_hash, newest)));
      return { token, session };
    });
  }

  /**
   * One statement reads and, when due, touches the session. The `touched` CTE updates last_seen_at
   * only for a live row last seen SESSION_TOUCH_MS or more ago, so most requests write nothing.
   * LIVE in the CTE isn't redundant with the outer SELECT's: without it, an idle-expired row would
   * be refused once but touched, and the next request would revive it. The outer SELECT sees the
   * snapshot from before the CTE's update (PostgreSQL's rule for data-modifying CTEs), so it
   * decides liveness on the stored values and takes the new last_seen_at from the CTE when there
   * is one. Two concurrent touches serialize on the row lock, and the second re-checks its WHERE
   * against the first's write, so it writes nothing.
   */
  async get(token: string): Promise<Session | null> {
    if (!isSessionToken(token)) return null;
    const db = this.db.orm;
    const own = eq(s.token_hash, hashToken(token));
    const touched = db.$with("touched").as(
      db
        .update(s)
        .set({ last_seen_at: sql`now()` })
        .where(and(own, LIVE, lte(s.last_seen_at, sql`now()-${TOUCH_SECONDS}*interval '1 second'`)))
        .returning({ token_hash: s.token_hash, last_seen_at: s.last_seen_at }),
    );
    const [session] = await db
      .with(touched)
      .select({
        ...SESSION,
        lastSeenAt: sql<Date>`coalesce(${touched.last_seen_at}, ${s.last_seen_at})`.mapWith(
          s.last_seen_at,
        ),
      })
      .from(s)
      .leftJoin(touched, eq(touched.token_hash, s.token_hash))
      .where(and(own, LIVE));
    return session ?? null;
  }

  async delete(token: string): Promise<void> {
    if (!isSessionToken(token)) return;
    await this.db.orm.delete(s).where(eq(s.token_hash, hashToken(token)));
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.db.orm.delete(s).where(eq(s.user_id, userId));
    return result.rowCount ?? 0;
  }

  async sweep(): Promise<number> {
    const result = await this.db.orm
      .delete(s)
      .where(
        or(
          lte(s.expires_at, sql`now()`),
          lte(s.last_seen_at, sql`now()-${IDLE_SECONDS}*interval '1 second'`),
        ),
      );
    return result.rowCount ?? 0;
  }
}
