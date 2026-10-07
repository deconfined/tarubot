/**
 * An in-memory SessionStore with an injectable clock, for web unit tests that need sessions without
 * PostgreSQL. It keeps PgSessions' rules (tests/integration/web-sessions.test.ts runs the same
 * scenarios against both): SHA-256 keys only, idle and absolute expiry with the same boundaries,
 * a touch at most every SESSION_TOUCH_MS, malformed tokens refused before any lookup, and user IDs
 * checked like the external_id domain.
 */
import { idSchema } from "../../src/domain/values.js";
import {
  hashToken,
  isSessionToken,
  newSessionToken,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  type Session,
  type SessionStore,
} from "../../src/web/sessions.js";

/** A stored row: what web_sessions holds, keyed by the token's hash. */
export interface SessionRow {
  readonly tokenHash: string;
  readonly session: Session;
}

export class MemorySessions implements SessionStore {
  /** By token hash, like web_sessions' primary key. */
  private readonly byHash = new Map<string, Session>();
  /** Lookups that reached the map, so tests can prove a malformed token costs none. */
  lookups = 0;

  /** `now` is the clock every expiry decision reads, as PgSessions reads the database's. */
  constructor(private readonly now: () => number = Date.now) {}

  async create(userId: string): Promise<{ token: string; session: Session }> {
    // The external_id domain refuses anything else; so does this fake.
    if (!idSchema.safeParse(userId).success) throw new Error("Invalid session user ID");
    const token = newSessionToken();
    const at = new Date(this.now());
    const session: Session = {
      userId,
      createdAt: at,
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_MS),
    };
    this.byHash.set(hashToken(token), session);
    return { token, session };
  }

  async get(token: string): Promise<Session | null> {
    if (!isSessionToken(token)) return null;
    this.lookups++;
    const key = hashToken(token);
    const session = this.byHash.get(key);
    const now = this.now();
    if (!session || !live(session, now)) return null;
    if (now - session.lastSeenAt.getTime() < SESSION_TOUCH_MS) return session;
    const touched = { ...session, lastSeenAt: new Date(now) };
    this.byHash.set(key, touched);
    return touched;
  }

  async delete(token: string): Promise<void> {
    if (!isSessionToken(token)) return;
    this.lookups++;
    this.byHash.delete(hashToken(token));
  }

  async deleteForUser(userId: string): Promise<number> {
    let deleted = 0;
    for (const [key, session] of this.byHash)
      if (session.userId === userId) {
        this.byHash.delete(key);
        deleted++;
      }
    return deleted;
  }

  async sweep(): Promise<number> {
    const now = this.now();
    let deleted = 0;
    for (const [key, session] of this.byHash)
      if (!live(session, now)) {
        this.byHash.delete(key);
        deleted++;
      }
    return deleted;
  }

  /** Every stored row, expired ones included, as web_sessions would hold them. */
  rows(): SessionRow[] {
    return [...this.byHash].map(([tokenHash, session]) => ({ tokenHash, session }));
  }
}

/** PgSessions' LIVE condition: before the absolute expiry and seen within the idle window. */
function live(session: Session, now: number): boolean {
  return session.expiresAt.getTime() > now && session.lastSeenAt.getTime() > now - SESSION_IDLE_MS;
}
