/**
 * Who may see a web page (#43, ADR D2–D4, D17). The signed-in user is resolved by the resolver a
 * slash command uses (BotContext.resolveActor: gateway.actor, then Service.enrichActor), so Discord
 * and the web can't disagree: a POST in its `full` mode, exactly as a command, and a GET or a
 * sign-in in its `light` mode, whose guild and roles come from the gateway cache while the member is
 * still fetched (ActorResolution). OAuth supplies only the user ID. One predicate, admits(), drives
 * routing, navigation and the server list.
 */
import { classifyFailure } from "../domain/failures.js";
import { type Actor, type ActorResolution, authorizeRoleManager } from "../domain/policy.js";
import { Failure } from "../domain/values.js";
import type { Page } from "./page.js";

/**
 * Every flag a page may declare, any-of; definePage refuses anything else. v3 has `officer`
 * (actor.officer after enrichment: Manage Server, or the Officer role with rank access) and
 * `manager` (authorizeRoleManager passes: Manage Server and Manage Roles). 2.40.0 adds `member`
 * and `guest` (the bound Member or Guest role held now, while TaruBot holds no Administrator in
 * the server: owner decisions Q6 A and A2). 3.1.0 adds operator.
 */
export const PAGE_ACCESS = ["officer", "manager", "member", "guest"] as const;

/** A page's access flag. */
export type PageAccess = (typeof PAGE_ACCESS)[number];

/**
 * Each flag's test. `manager` reuses the application's own rule rather than restating it, so the
 * web can't drift from the commands that change officer authority. `member` and `guest` need an
 * explicit `botAdministrator === false` (A2, in code): an actor that doesn't say, because it was
 * resolved without TaruBot's own member or built without the field, admits no member or guest.
 * Neither looks at `timedOut`: a member in a time-out may still open their pages (Q6), and the
 * application refuses their saves.
 */
const FLAG: Readonly<Record<PageAccess, (actor: Actor) => boolean>> = {
  officer: (actor) => actor.officer,
  manager: (actor) => {
    try {
      authorizeRoleManager(actor);
      return true;
    } catch (error) {
      // The rule refuses with a Failure; anything else is a bug and must not read as "no".
      if (error instanceof Failure) return false;
      throw error;
    }
  },
  member: (actor) => actor.member === true && actor.botAdministrator === false,
  guest: (actor) => actor.guest === true && actor.botAdministrator === false,
};

/**
 * True when the actor holds at least one of the flags. An empty list admits no one, and so does a
 * flag this release doesn't know (definePage refuses those, but routing must fail closed anyway).
 */
export function admits(actor: Actor, access: readonly PageAccess[]): boolean {
  return access.some((flag) => Object.hasOwn(FLAG, flag) && FLAG[flag](actor));
}

/** How long a GET may reuse an actor resolved for the same user and server. */
export const ACTOR_MEMO_MS = 60_000;

/** The server list checks at most this many candidate servers (D17). */
export const SERVER_LIST_LIMIT = 25;

/** The bot's resolver (main.ts's BotContext.resolveActor), asked for the mode each use needs. */
export type ResolveActor = (
  guildId: string,
  userId: string,
  mode: ActorResolution,
) => Promise<Actor>;

/**
 * Why the web wants an actor, which decides whether the memo may answer and how fresh a
 * resolution must be (docs/MODULES.md, "Add a page", gives the cost of each):
 * - `get`: a page or / on GET. The memo answers within ACTOR_MEMO_MS; a miss resolves `light`
 *   (1 REST call: the member).
 * - `sign-in`: admission at the callback. Never the memo, so a sign-in always sees Discord as it
 *   is now; `light`, and up to SERVER_LIST_LIMIT servers, one at a time.
 * - `post`: every page POST. Never the memo to admit, and always `full` (3 REST calls), as a
 *   slash command: no write is ever admitted on cached role definitions. (The page server may
 *   refuse a POST from the memo first, through peek(), so a page someone can't use costs them
 *   nothing to hammer; that never admits anyone.)
 * A fresh answer (sign-in or post) replaces the memo, so the GETs after it see it too.
 */
export type ActorUse = "get" | "sign-in" | "post";

/** The resolution mode for each use: only a POST pays for the full one. */
const MODE: Readonly<Record<ActorUse, ActorResolution>> = {
  get: "light",
  "sign-in": "light",
  post: "full",
};

/** A server the gateway has cached. `name` is untrusted text and is always escaped. */
export interface WebGuild {
  readonly id: string;
  readonly name: string;
}

/** Test seams for the memo. */
export interface AccessResolverOptions {
  /** Milliseconds clock; defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * The resolver's answer meant "not a current human member of this server": Unknown Member or
 * Unknown User from Discord (classifyFailure's `current_member` scope), or a bot account
 * (gateway.actor's `human` scope). Both are refusals, so they are forbidden-category only.
 */
function notAdmitted(error: unknown): boolean {
  const { category, detail } = classifyFailure(error);
  return (
    category === "forbidden" &&
    detail?.kind === "scope" &&
    (detail.scope === "current_member" || detail.scope === "human")
  );
}

/** The memo's key for one user in one server. */
const memoKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

/** One memoized answer, possibly still resolving, and when it stops being reusable. */
interface Memo {
  readonly actor: Promise<Actor | null>;
  readonly expiresAt: number;
}

/**
 * Live authority with a bounded memo (D3). A GET may reuse the answer for the same user and server
 * for 60 seconds (ACTOR_MEMO_MS); a fresh resolution (every POST, and sign-in admission) always
 * calls the resolver and replaces the memo. Each use asks for its own mode (ActorUse): GETs and
 * sign-ins `light`, POSTs `full`. The memo holds the resolution itself from the moment it starts,
 * so concurrent GETs for one user and server share one resolution (one bot REST call) instead of
 * each starting their own. Unknown Member or Unknown User (classifyFailure's `current_member`
 * scope) and a bot account (`human` scope) mean "not admitted": null, memoized like an actor. Any
 * other error, a Discord outage say, propagates to the error page and is not memoized. Expired
 * entries are dropped whenever the memo is consulted, so it holds only users seen within the
 * window.
 */
export class AccessResolver {
  private readonly memo = new Map<string, Memo>();
  private readonly now: () => number;

  constructor(
    private readonly resolve: ResolveActor,
    options: AccessResolverOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The actor for this user in this server, or null when they are not a current human member. */
  async actor(guildId: string, userId: string, use: ActorUse): Promise<Actor | null> {
    const started = this.now();
    this.prune(started);
    const key = memoKey(guildId, userId);
    const held = this.memo.get(key);
    if (held && use === "get") return held.actor;
    const actor = this.resolve(guildId, userId, MODE[use]).catch((error: unknown) => {
      if (!notAdmitted(error)) throw error;
      return null;
    });
    // The window runs from when the resolution started, so no answer is reused for longer than
    // ACTOR_MEMO_MS after Discord was asked, however slow the answer was.
    const entry: Memo = { actor, expiresAt: started + ACTOR_MEMO_MS };
    this.memo.set(key, entry);
    try {
      return await actor;
    } catch (error) {
      // Not memoized: the next request asks again. A newer resolution that replaced this entry
      // meanwhile (a POST's fresh one) stays.
      if (this.memo.get(key) === entry) this.memo.delete(key);
      throw error;
    }
  }

  /**
   * The answer the memo holds for this user and server, without asking Discord: an actor, null
   * ("not a current human member"), or undefined when it holds none (never resolved, expired, or
   * a resolution that failed, whose error stays actor()'s to report). A resolution still running
   * is waited for, which costs nothing more. It is only ever a reason to refuse early: whatever it
   * says, a request it doesn't refuse still resolves through actor().
   */
  async peek(guildId: string, userId: string): Promise<Actor | null | undefined> {
    this.prune(this.now());
    const held = this.memo.get(memoKey(guildId, userId));
    return held ? held.actor.catch(() => undefined) : undefined;
  }

  /** Memoized answers currently held, expired ones included until the next consultation. */
  get size(): number {
    return this.memo.size;
  }

  /** Delete expired answers; the memo is small (one entry per signed-in user and server). */
  private prune(now: number): void {
    for (const [key, entry] of this.memo) if (entry.expiresAt <= now) this.memo.delete(key);
  }
}

/** A server the user may open, with the actor that some page admits there. */
export interface ServerEntry {
  readonly guild: WebGuild;
  readonly actor: Actor;
}

/**
 * The server list (D17), for / and for admission at sign-in: of `candidates` (the gateway's cached
 * servers, already filtered by allowsGuild), the first SERVER_LIST_LIMIT are checked in order, and
 * a server is kept when the user resolves there and at least one page admits them. Resolutions run
 * one at a time, through `access` (fresh at sign-in, memoized on GET /), each a light one (one
 * member fetch), so one sign-in never bursts the bot's REST buckets. An empty result means "no
 * access": no session is created. Any error other than "not a member" propagates, so an outage
 * never reads as "no access".
 */
export async function listServers(
  candidates: readonly WebGuild[],
  userId: string,
  access: AccessResolver,
  pages: Iterable<Page>,
  use: Exclude<ActorUse, "post">,
): Promise<ServerEntry[]> {
  const all = [...pages];
  const servers: ServerEntry[] = [];
  for (const guild of candidates.slice(0, SERVER_LIST_LIMIT)) {
    // Sequential on purpose (see above); each await is one actor resolution.
    const actor = await access.actor(guild.id, userId, use);
    if (actor !== null && all.some((page) => admits(actor, page.access)))
      servers.push({ guild, actor });
  }
  return servers;
}
