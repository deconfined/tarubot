/**
 * The web listener (#43, ADR D1, D14): a second Bun.serve in the bot process, started by main.ts
 * once the writer lease is held and Discord is ready, and stopped in the shutdown drain before the
 * gateway closes and the lease is released. It is a Hono app with the fixed routes (/, sign-in,
 * sign-out, health and assets) and the discovered pages under /g/:guild/. Web faults never stop
 * the bot: bad settings, a broken page module or a failed bind are reported and leave the web off.
 */
import type { Server, TLSOptions } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import type { Logger } from "pino";
import { databaseKey, lifecycleKey } from "../application/keys.js";
import type { BotContext } from "../bot/context.js";
import type { ServiceKey, Services } from "../bot/services.js";
import { Failure, idSchema } from "../domain/values.js";
import { AccessResolver, admits, listServers, type WebGuild } from "./access.js";
import { ASSET_CACHE_CONTROL, ASSETS } from "./assets.js";
import {
  clearCookie,
  type ErrorFrame,
  FORM_TOKEN_FIELD,
  formOnly,
  formTokenMatches,
  LOGIN_COOKIE,
  LOGIN_COOKIE_MAX_AGE,
  loginLocation,
  newRef,
  PATHS,
  page,
  problem,
  problemOf,
  type RequestContext,
  readCookie,
  redirect,
  SESSION_COOKIE,
  sameOrigin,
  securityHeaderRecord,
  SERVER_LIST_PARAM,
  securityHeaders,
  type WebEnv,
  writeCookie,
} from "./http.js";
import { BRAND, errorPage, type LayoutModel, layout, navLinks } from "./layout.js";
import {
  overBudget,
  POST_WINDOW_MS,
  RateLimiter,
  SIGN_IN_LIMIT,
  SIGN_IN_WINDOW_MS,
  stoppingRefusal,
  tooManySignIns,
} from "./limits.js";
import { DiscordSignIn } from "./oauth.js";
import type { Page, PageContext, PageServices } from "./page.js";
import { loadPages } from "./pages.js";
import { RETURN_PARAM, safeReturnPath } from "./return-path.js";
import {
  formToken,
  PgSessions,
  SESSION_ABSOLUTE_MS,
  SESSION_SWEEP_MS,
  type SessionStore,
} from "./sessions.js";
import { type WebSettings, type WebSettingsInput, webSettings } from "./settings.js";
import { renderHome, renderNoAccess, type ServerLink } from "./views/servers.js";

/** Bun's request-body cap; hono/body-limit applies the same 64 KiB inside the app. */
export const WEB_BODY_LIMIT = 65536;
/** Above the edge's two-minute upstream keepalive, so the proxy closes idle connections first. */
export const WEB_IDLE_TIMEOUT_SECONDS = 150;
/** stop() waits this long for open connections to finish, then closes them. */
export const WEB_STOP_MS = 5000;

/**
 * What the bot process hands the web: the same services, guild scope, actor resolver and reporter
 * that slash commands use, plus the gateway's cached servers. `isStopping` keeps a shutdown that
 * began while the web was starting from opening a listener the drain has already passed.
 */
export interface WebContext
  extends Pick<BotContext, "services" | "allowsGuild" | "resolveActor" | "report" | "isStopping"> {
  /** The servers the gateway has cached, with their names; D17's candidates before allowsGuild. */
  readonly guilds: () => readonly WebGuild[];
}

/** Seams for tests and the development harness; production passes none. */
export interface WebOptions {
  /** Defaults to PgSessions over the bot's Database (services' databaseKey). */
  readonly sessions?: SessionStore;
  /** Answers the OAuth token and /users/@me requests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** The harness's fake authorize page; never a setting. */
  readonly authorizeUrl?: string;
  /** Defaults to pages.ts's pagesDirectory. */
  readonly pagesDirectory?: URL;
  /** Defaults to "::", the explicit dual-stack bind; the harness selects its preview interface. */
  readonly hostname?: string;
  /** Optional listener TLS for the development harness; production passes none. */
  readonly tls?: TLSOptions;
  /** Overrides WEB_PORT; tests pass 0 for any free port. */
  readonly port?: number;
  /** Defaults to WEB_STOP_MS; tests shorten the grace period. */
  readonly stopMs?: number;
  /** Defaults to SESSION_SWEEP_MS; tests shorten the sweep period. */
  readonly sweepMs?: number;
}

/** Everything the Hono app needs; createWebApp builds no listener, so tests use app.request(). */
export interface WebAppDependencies {
  readonly settings: WebSettings;
  readonly context: WebContext;
  readonly pages: ReadonlyMap<string, Page>;
  readonly sessions: SessionStore;
  readonly signIn: DiscordSignIn;
  readonly access: AccessResolver;
  /** Already the web's child logger (component "web"), with no redact override. */
  readonly log: Logger;
  /**
   * The POST budgets' and the sign-in limit's clock in milliseconds; defaults to performance.now.
   * Tests pass their own.
   */
  readonly now?: () => number;
}

/** A running web listener. */
export interface WebServer {
  /** The bound address; tests listen on port 0 and read the chosen port here. */
  readonly url: URL;
  /**
   * Stop accepting connections and clear the session sweep timer, wait up to WEB_STOP_MS for open
   * connections to finish, then close the rest. Closing a connection doesn't cancel its handler,
   * which may still run while the drain goes on, as an in-flight slash command does. Never
   * rejects, and stays well inside the drain's 20 s.
   */
  stop(): Promise<void>;
}

/** The session cookie lives as long as the session's absolute expiry; the server decides first. */
const SESSION_COOKIE_MAX_AGE = Math.floor(SESSION_ABSOLUTE_MS / 1000);

/** The Allow header of a fixed GET route. */
const GET_ONLY = "GET, HEAD";

/**
 * A POST whose form token isn't the session's: a form from before the latest sign-in (which
 * rotated the session, and with it the token), or one that didn't come from TaruBot's pages. Its
 * advice is to open the page again: the error page answers the POST, so reloading it would send
 * the same stale form again.
 */
const staleForm = (): Failure =>
  new Failure(
    "forbidden",
    "This form is out of date or didn't come from TaruBot's own pages, so TaruBot ignored it. Open the page again, then redo your change.",
  );

/**
 * The stale-form refusal's heading. Its message says which 403 it is, and whoever sent it may well
 * be allowed, so "Not allowed" would misname it.
 */
const STALE_FORM: ErrorFrame = { heading: "Form out of date" };

/**
 * A sign-out form whose token isn't the session's: one from a tab older than the latest sign-in.
 * It still ends nothing (a forged form must not sign anyone out), so the page says plainly that
 * this browser is still signed in, and how to sign out: the error page's own account menu carries
 * the current token. "Redo your change" would leave someone on a shared device thinking they had
 * signed out.
 */
const staleSignOut = (): Failure =>
  new Failure(
    "forbidden",
    "This sign-out form was out of date, so you're still signed in. Use Sign out in the Account menu to end this session.",
  );

/**
 * A page this signed-in person can't use here, refused on a GET: the actor resolved, but none of
 * the page's access flags holds (a member following a Status or Role menu link, or someone who
 * lost Member and Guest opening My roles). The 403's own sentence also names a forged request,
 * which a plain GET can never be, so it would only confuse. Nothing says which flag was missing.
 */
const notOpen = (): Failure =>
  new Failure("forbidden", "This page isn't open to you in this server.");

/** The stale sign-out's heading, which says the one thing that matters. */
const STILL_SIGNED_IN: ErrorFrame = { heading: "Still signed in" };

/**
 * A page's view of the services: get() for the keys it declared in `requires`, and an error for
 * any other, which the error handler answers as a 500 and reports as the page bug it
 * is. startWeb already proved every declared key is provided.
 */
function scopedServices(services: Pick<Services, "get">, declared: Page["requires"]): PageServices {
  const allowed: ReadonlySet<ServiceKey<unknown>> = new Set(declared);
  return {
    get<T>(key: ServiceKey<T>): T {
      if (!allowed.has(key)) throw new Error(`Page used an undeclared service: ${key.name}`);
      return services.get(key);
    },
  };
}

/**
 * The Hono app: security headers first, then the request reference and log line, the body limit,
 * fixed routes, page routes (the E1 checks on each POST route; a wrong method on a known path is
 * an explicit 405 with Allow), a 404 fallback and an error handler mapping Failure categories to
 * statuses (E10). Logs only the route pattern, method, status, milliseconds and ref; 5xx answers
 * go to report(error, ref, { scope: `web:${pattern}` }), whose stable scope groups repeats into
 * one issue report rather than one per request.
 */
export function createWebApp(dependencies: WebAppDependencies): Hono<WebEnv> {
  const { settings, context, pages, sessions, signIn, access, log } = dependencies;
  const now = dependencies.now ?? (() => performance.now());
  const { secure, origin } = settings;
  const app = new Hono<WebEnv>();
  /** Finished sign-ins per Discord user (2.40.0); the callback counts them before admission. */
  const signIns = new RateLimiter(SIGN_IN_LIMIT, SIGN_IN_WINDOW_MS, now);

  /**
   * The registered pattern ("/g/:guild/status"), never the path itself: paths carry server IDs and
   * queries carry the OAuth code. Every route is registered as a pattern, and the last matched one
   * is the most specific, because routes are registered after the middleware; a request no route
   * matched gets the middleware's "/*".
   */
  const pattern = (c: RequestContext): string => routePath(c, -1);

  /** D17's candidates: servers the gateway has cached that this deployment serves. */
  const candidates = (): WebGuild[] =>
    context.guilds().filter((guild) => context.allowsGuild(guild.id));

  /**
   * Render any refusal or failure through problemOf and the error page, never the error's own text
   * or response (hono/body-limit attaches a bare response without our headers). A 5xx is reported
   * at its classified level: unexpected at error (an issue report), upstream trouble at warn. Lower
   * statuses are routine refusals, which the request log records.
   */
  const fail = (error: unknown, c: RequestContext): Response | Promise<Response> => {
    const details = problemOf(error, c.get("ref") ?? newRef());
    if (details.status >= 500)
      context.report(error, details.ref, { scope: `web:${pattern(c)}`, level: details.level });
    return problem(
      c,
      details,
      errorPage(details, c.get("formToken") ?? null, c.get("errorFrame") ?? {}),
    );
  };

  /** Register the explicit 405 for a known path, after its method handlers. */
  const allow = (path: string, methods: string): void => {
    app.all(path, (c) => {
      const details = problemOf(new HTTPException(405), c.get("ref"));
      return problem(c, details, errorPage(details, c.get("formToken") ?? null), {
        Allow: methods,
      });
    });
  };

  /**
   * The signed-in session, from the session cookie, and its form token, derived from the cookie's
   * token only once the store has accepted it. Attached only to routes that use it, after the E1
   * checks, so assets and the readiness probe never query sessions.
   */
  const session: MiddlewareHandler<WebEnv> = async (c, next) => {
    const token = readCookie(c, SESSION_COOKIE, secure);
    const current = token === undefined ? null : await sessions.get(token);
    c.set("session", current);
    c.set("formToken", current && token !== undefined ? formToken(token) : null);
    await next();
  };

  // 1. The header set, first, so every answer below it carries the headers: pages, redirects,
  // assets, 404, 405 and error pages (Hono renders a thrown error at the layer that threw).
  app.use(securityHeaders(secure));
  // 2. The request reference, and one log line per request with explicit fields only: never the
  // query (the OAuth code is in it), headers, cookies, bodies or client addresses.
  app.use(async (c, next) => {
    const started = performance.now();
    c.set("ref", newRef());
    c.set("session", null);
    c.set("formToken", null);
    c.set("errorFrame", null);
    await next();
    const { status } = c.res;
    const fields = {
      route: pattern(c),
      method: c.req.method,
      status,
      ms: Math.round(performance.now() - started),
      ref: c.get("ref"),
    };
    // Scanners' 404s and 405s stay at debug, out of the capped production log; other refusals are
    // worth a line at info. A 5xx is at debug too: a fault already went through the reporter, and
    // the readiness probe's 503 isn't one.
    if (status >= 400 && status < 500 && status !== 404 && status !== 405)
      log.info(fields, "Web request");
    else log.debug(fields, "Web request");
  });
  // 3. The body cap, as Bun's own. On the listener Bun's maxRequestBodySize answers an over-cap
  // body first with its bare 413, so our 413 page shows only through app.request(). A chunked body
  // this layer reads itself, on any path and before E1, so a read that fails (an abandoned upload,
  // or Bun's cap cutting the stream) is the sender's doing: a 400, never an unexpected 500, which
  // would let anyone file issue reports with broken bodies. Only a failure before next() is a
  // read; a later layer's non-Error throw passes through to Bun's error().
  const limit = bodyLimit({ maxSize: WEB_BODY_LIMIT });
  app.use(async (c, next) => {
    let reading = true;
    try {
      return await limit(c, () => {
        reading = false;
        return next();
      });
    } catch (error) {
      if (!reading || error instanceof HTTPException) throw error;
      throw new Failure("input", "TaruBot couldn't read that request.");
    }
  });
  // E1 is mounted on each POST route below, ahead of its session: same origin, then the form type.
  // POST is the only unsafe method any route serves. Not a catch-all on POST, so a scanner's POST
  // to an unknown path or a GET-only route keeps its 404 or 405 (logged at debug), not a 403 at
  // info.

  // The stylesheet, favicon, fonts and notices, at hashed paths that never change content. A text
  // body goes out as UTF-8 and a font's bytes unchanged, each with its own Content-Type.
  for (const asset of ASSETS) {
    app.get(asset.path, (c) =>
      c.body(asset.body, 200, {
        "Content-Type": asset.contentType,
        "Cache-Control": ASSET_CACHE_CONTROL,
      }),
    );
    allow(asset.path, GET_ONLY);
  }

  // The outside check (W6): booleans only, from the same readiness the bot's probe reports.
  app.get(PATHS.ready, (c) => {
    const ready = context.services.get(lifecycleKey).status().ready === true;
    return c.json({ ready }, ready ? 200 : 503, { "Cache-Control": "no-store" });
  });
  allow(PATHS.ready, GET_ONLY);

  /**
   * A sign-in link for visitors; the servers a signed-in user may open (D17), memoized like any
   * GET. Someone with exactly one server and exactly one page there (a member or guest, whose only
   * page is My roles) goes straight to it (303), so sign-in, whose return path is / by default,
   * lands them on their page. Anyone with more gets the list, and so does anyone who asked for it
   * (SERVER_LIST, the shell's "Switch server"), so that link never reloads the page it is on.
   */
  app.get(PATHS.home, session, async (c) => {
    const current = c.get("session");
    const token = c.get("formToken");
    if (!current || token === null)
      return page(c, layout({ title: BRAND, signedIn: false }, renderHome({ signedIn: false })));
    const servers: ServerLink[] = [];
    for (const entry of await listServers(
      candidates(),
      current.userId,
      access,
      pages.values(),
      "get",
    )) {
      const links = navLinks(pages.values(), entry.actor);
      if (links.length > 0) servers.push({ id: entry.guild.id, name: entry.guild.name, links });
    }
    // Exactly one server with exactly one page: straight there. The href is the page's own path
    // in a server the gateway listed, never request text.
    const links = servers.length === 1 ? (servers[0]?.links ?? []) : [];
    const listAsked = new URL(c.req.url).searchParams.has(SERVER_LIST_PARAM);
    if (!listAsked && links.length === 1 && links[0]) return redirect(c, links[0].href);
    return page(
      c,
      layout(
        { title: "Your servers", signedIn: true, formToken: token },
        renderHome({ signedIn: true, servers }),
      ),
    );
  });
  allow(PATHS.home, GET_ONLY);

  // Sign-in starts here: the login cookie carries state, the PKCE verifier and the return path, so
  // an anonymous visitor costs no server memory. The return path is never reflected into a page.
  app.get(PATHS.login, async (c) => {
    const start = await signIn.start(safeReturnPath(c.req.query(RETURN_PARAM)));
    writeCookie(c, LOGIN_COOKIE, start.loginCookie, secure, LOGIN_COOKIE_MAX_AGE);
    c.header("Cache-Control", "no-store");
    return c.redirect(start.authorizeUrl.href, 302);
  });
  allow(PATHS.login, GET_ONLY);

  /**
   * Discord's return. finish() checks state against the login cookie before any request to
   * Discord, then exchanges the code through D16's gate (limits.ts's ExchangeGate: refused with a
   * 503 and Retry-After while Discord's 429 pause lasts, while four exchanges run, or past thirty
   * this minute). Then the per-user sign-in limit (a 429 with Retry-After, with no session and the
   * browser's session left as it was), counted before admission because admission costs a Discord
   * request per server. Then admission (D17): a session only for a user some server's page admits,
   * each server resolved afresh in the light mode.
   */
  app.get(PATHS.callback, async (c) => {
    const handshake = readCookie(c, LOGIN_COOKIE, secure);
    // The handshake is single-use: every answer clears it, a refusal or an error page included.
    clearCookie(c, LOGIN_COOKIE, secure);
    const { userId, returnPath } = await signIn.finish(new URL(c.req.url), handshake);
    // Keyed by the Discord user, never an address.
    const wait = signIns.take(userId);
    if (wait > 0) throw tooManySignIns(wait);
    const servers = await listServers(candidates(), userId, access, pages.values(), "sign-in");
    // Rotation: whatever session this browser presented ends here, admitted or not, so a sign-in
    // never continues a session that existed before it (fixation) or keeps another account's.
    const presented = readCookie(c, SESSION_COOKIE, secure);
    if (presented !== undefined) await sessions.delete(presented);
    if (servers.length === 0) {
      if (presented !== undefined) clearCookie(c, SESSION_COOKIE, secure);
      log.info({ userId, servers: 0 }, "Web sign-in");
      return page(c, layout({ title: "No access", signedIn: false }, renderNoAccess()), 403);
    }
    const { token } = await sessions.create(userId);
    writeCookie(c, SESSION_COOKIE, token, secure, SESSION_COOKIE_MAX_AGE);
    log.info({ userId, servers: servers.length }, "Web sign-in");
    return redirect(c, safeReturnPath(returnPath));
  });
  allow(PATHS.callback, GET_ONLY);

  /**
   * Sign out this browser, or every browser of the signed-in user. Both are forms, through E1, and
   * both answer 303 to / with the cookie cleared, signed in or not. Signed in, the form must carry
   * the session's form token, or nothing ends (403): a forged form can't sign anyone out. Signed
   * out there is no session to protect, so a stale form still clears the cookie.
   */
  const signOut =
    (everywhere: boolean) =>
    async (c: RequestContext): Promise<Response> => {
      const current = c.get("session");
      const expected = c.get("formToken");
      if (current && expected !== null) {
        const form = await readForm(c);
        if (!formTokenMatches(expected, form.get(FORM_TOKEN_FIELD))) {
          c.set("errorFrame", STILL_SIGNED_IN);
          throw staleSignOut();
        }
      }
      const token = readCookie(c, SESSION_COOKIE, secure);
      let ended = 0;
      if (everywhere && current) ended = await sessions.deleteForUser(current.userId);
      else if (token !== undefined) {
        await sessions.delete(token);
        ended = current ? 1 : 0;
      }
      if (current)
        log.info({ userId: current.userId, everywhere, sessions: ended }, "Web sign-out");
      clearCookie(c, SESSION_COOKIE, secure);
      return redirect(c, PATHS.home);
    };
  app.post(PATHS.logout, sameOrigin(origin), formOnly(), session, signOut(false));
  allow(PATHS.logout, "POST");
  app.post(PATHS.logoutAll, sameOrigin(origin), formOnly(), session, signOut(true));
  allow(PATHS.logoutAll, "POST");

  /**
   * A discovered page (D12). The session middleware runs first: a request carrying a session
   * cookie has already cost one session lookup, whatever its path. Then the checks run in this
   * order, and each refusal is decided before the next costs anything:
   * 1. `:guild` must be a Discord ID, else 404.
   * 2. Signed out: 303 to sign-in for any server ID, so an anonymous request can't tell which
   *    servers TaruBot serves.
   * 3. The server must be one the gateway has cached and this deployment serves, else 404, before
   *    any Discord call.
   * A POST then passes four more, none of which costs a Discord request:
   * 4. The form must carry the session's form token (403, "Form out of date"); the field is
   *    removed before post().
   * 5. Once shutdown has begun, nothing new starts (429 with Retry-After): the drain stops the web
   *    before the writer lease goes, and this keeps a write from beginning inside that window.
   * 6. An answer the actor memo already holds (AccessResolver.peek) that this page wouldn't admit
   *    refuses at once, as 8 and 9 would: 404 for not a current human member, else 403. It only
   *    ever refuses: an admitting answer, or none, goes on to the full resolution. Without it, a
   *    member could POST to a page they can't use (Role menu, say) and make TaruBot spend 3 REST
   *    calls on the per-server buckets each time, up to that page's whole budget; with it, the
   *    full resolution refreshes the memo and their next POSTs within ACTOR_MEMO_MS cost nothing.
   *    A stale refusal (someone promoted less than a minute ago) is what that page's own GET
   *    already answers inside the same window.
   * 7. The page's budget for this user in this server (429 with Retry-After), before the fresh
   *    actor, so a POST over budget costs no Discord REST call.
   * And every request:
   * 8. The actor resolves like a slash command's (memoized up to 60 s on GET and resolved light on a
   *    miss, fresh and full on POST: AccessResolver's ActorUse); not a current human member is 404,
   *    so responses never reveal membership elsewhere.
   * 9. A missing access flag is 403: on a GET with its own sentence (notOpen), on a POST with the
   *    status's own.
   * The application operations a page calls authorize the actor again, as REQUIREMENTS.md asks of
   * commands and buttons ("reauthorize the current actor"), and check for shutdown once more just
   * before they commit, throwing the domain's stoppingRefusal() (which limits.ts re-exports), so
   * the write rolls back and its form gets the same 429.
   *
   * The error page for a refused POST (steps 4, 5 and 7, and post()'s own refusals, such as a form
   * it can't use or that pre-commit 429) links back to the page, by its own href for this server:
   * reloading the answer to a POST would only send the same form again. The actor checks (6, 8 and
   * 9) refuse without the link, since the page wouldn't open for that user anyway.
   *
   * Those error pages don't carry the submitted values, so a form refused at steps 4 to 7, or by
   * the pre-commit 429, loses what was typed: an accepted, rare loss (a restart during a deploy,
   * a budget of many saves, a tab older than the latest sign-in), and each message says nothing
   * was saved. Only a page's own 409 and 422 re-render the form with its values. A stale-token
   * form must never get them back, since it may not be this user's.
   */
  const servePage = (definition: Page) => {
    const services = scopedServices(context.services, definition.requires);
    const budget =
      definition.post && definition.postLimit !== undefined
        ? new RateLimiter(definition.postLimit, POST_WINDOW_MS, now)
        : undefined;
    return async (c: RequestContext): Promise<Response> => {
      const guildId = c.req.param("guild") ?? "";
      if (!idSchema.safeParse(guildId).success) throw new HTTPException(404);
      const current = c.get("session");
      const token = c.get("formToken");
      const requested = new URL(c.req.url);
      const target = `${requested.pathname}${requested.search}`;
      if (!current || token === null) return redirect(c, loginLocation(target));
      const guild = candidates().find((candidate) => candidate.id === guildId);
      if (!guild) throw new HTTPException(404);
      const post = c.req.method === "POST" && definition.post !== undefined;
      // The page's own path in this server: from the definition and the checked ID, never the
      // request's text.
      const back: ErrorFrame = {
        back: { href: definition.href(guildId), label: definition.title },
      };
      let form: FormData | undefined;
      if (post) {
        c.set("errorFrame", back);
        form = await readForm(c);
        if (!formTokenMatches(token, form.get(FORM_TOKEN_FIELD))) {
          c.set("errorFrame", { ...STALE_FORM, ...back });
          throw staleForm();
        }
        form.delete(FORM_TOKEN_FIELD);
        if (context.isStopping()) throw stoppingRefusal();
        // Step 6: refuse from the memo alone, before the budget, so these refusals cost neither a
        // Discord request nor budget. Never admits: anything else goes on to the full resolution.
        const known = await access.peek(guildId, current.userId);
        if (known !== undefined && (known === null || !admits(known, definition.access))) {
          c.set("errorFrame", null);
          throw new HTTPException(known === null ? 404 : 403);
        }
        // Keyed by page, server and Discord user, never by address. A POST refused by the token,
        // shutdown, memo or budget check isn't counted; one refused later, by the actor check or
        // the page, is.
        const wait = budget?.take(`${definition.path} ${guildId} ${current.userId}`) ?? 0;
        if (wait > 0) throw overBudget(wait);
        c.set("errorFrame", null);
      }
      const actor = await access.actor(guildId, current.userId, post ? "post" : "get");
      // The resolver answers for this server and user; anything else is a bug, refused as absent.
      if (!actor || actor.guildId !== guildId || actor.userId !== current.userId)
        throw new HTTPException(404);
      // A GET can only be refused for access, so it says just that; a POST keeps the status's own
      // sentence, which also covers a form that didn't come from TaruBot's pages.
      if (!admits(actor, definition.access)) throw post ? new HTTPException(403) : notOpen();
      const pageContext: PageContext = {
        request: c.req.raw,
        url: new URL(target, origin),
        session: current,
        actor,
        guildId,
        services,
        formToken: token,
        report: context.report,
        ref: c.get("ref"),
      };
      const model: LayoutModel = {
        title: definition.title,
        signedIn: true,
        formToken: token,
        guild: {
          id: guildId,
          name: guild.name,
          nav: navLinks(pages.values(), actor, definition.path),
          // The side navigation's note: officers configure, members and guests pick roles.
          audience: actor.officer ? "officer" : "member",
        },
      };
      if (!form || !definition.post)
        return page(c, layout(model, await definition.get(pageContext)));
      c.set("errorFrame", back);
      const outcome = await definition.post(pageContext, form);
      // Post-redirect-get, to a same-origin path whatever the page returned.
      if ("redirect" in outcome) return redirect(c, safeReturnPath(outcome.redirect));
      // The page's form again, with what was submitted; any status but 409 (a module is untyped
      // at runtime) is the input refusal's 422. A form drawn open over the page makes the shell
      // inert too, so only that form takes focus.
      return page(
        c,
        layout({ ...model, error: true, modal: outcome.modal === true }, outcome.invalid),
        outcome.status === 409 ? 409 : 422,
      );
    };
  };
  for (const definition of pages.values()) {
    // One handler per page, so its GET and POST share one scoped view and one budget.
    const handler = servePage(definition);
    app.get(definition.path, session, handler);
    // Every form page's POST goes through E1 first, here in the one loop that registers pages.
    if (definition.post)
      app.post(definition.path, sameOrigin(origin), formOnly(), session, handler);
    allow(definition.path, definition.post ? "GET, HEAD, POST" : GET_ONLY);
  }

  app.notFound((c) => fail(new HTTPException(404), c));
  app.onError((error, c) => fail(error, c));
  return app;
}

/** The urlencoded form of a POST that passed E1; an unreadable body is the sender's mistake. */
async function readForm(c: RequestContext): Promise<FormData> {
  try {
    return await c.req.formData();
  } catch {
    throw new Failure(
      "input",
      "TaruBot couldn't read that form. Open the page again, then redo your change.",
    );
  }
}

/**
 * Start the web, or return null with no listener: when WEB_PUBLIC_ORIGIN is empty (silently), or
 * after reporting invalid settings, a page-discovery or `requires` error, or a bind failure. Never
 * rejects. When running, an hourly unref'd timer sweeps expired sessions, reporting its errors.
 */
export async function startWeb(
  config: WebSettingsInput,
  context: WebContext,
  log: Logger,
  options: WebOptions = {},
): Promise<WebServer | null> {
  try {
    const parsed = webSettings(config);
    if (parsed.status === "off") return null;
    if (parsed.status === "invalid") {
      // The problems name settings and rules, never values, so the report can't carry the secret.
      context.report(
        new Failure("configuration", `Web settings invalid: ${parsed.problems.join("; ")}`),
        "web settings",
      );
      return null;
    }
    const { settings } = parsed;
    let pages: ReadonlyMap<string, Page>;
    try {
      pages = await loadPages(options.pagesDirectory);
      // Like modules' requires at startup: a page whose services are missing keeps the web off.
      const required: ServiceKey<unknown>[] = [lifecycleKey];
      if (!options.sessions) required.push(databaseKey);
      for (const definition of pages.values()) required.push(...definition.requires);
      context.services.require(required);
    } catch (error) {
      context.report(error, "web pages");
      return null;
    }
    const webLog = log.child({ component: "web" });
    const sessions = options.sessions ?? new PgSessions(context.services.get(databaseKey));
    const app = createWebApp({
      settings,
      context,
      pages,
      sessions,
      signIn: new DiscordSignIn({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        redirectUri: settings.redirectUri,
        ...(options.fetch && { fetch: options.fetch }),
        ...(options.authorizeUrl && { authorizeUrl: options.authorizeUrl }),
      }),
      access: new AccessResolver(context.resolveActor),
      log: webLog,
    });
    // A shutdown that began during the awaits above has already run the drain without this web.
    // Nothing awaits between this check and main.ts holding the result, so none can slip past it.
    if (context.isStopping()) return null;
    /** An answer from outside the app: the header set and no text. */
    const bare = (status: number): Response =>
      new Response(null, {
        status,
        headers: { ...securityHeaderRecord(settings.secure), "Cache-Control": "no-store" },
      });
    let server: Server<undefined>;
    try {
      server = Bun.serve({
        hostname: options.hostname ?? "::",
        port: options.port ?? settings.port,
        ...(options.tls && { tls: options.tls }),
        development: false,
        maxRequestBodySize: WEB_BODY_LIMIT,
        idleTimeout: WEB_IDLE_TIMEOUT_SECONDS,
        // Bun builds request.url from the Host header unchecked: a Host such as "[" or
        // "example.org:99999" gives a URL that URL() refuses, and some others a relative one that
        // Hono misroutes. That is the client's mistake, so a bare 400 before the app, never an
        // unexpected 500 from a route that parses the URL. Only the request goes to Hono: Bun's
        // second argument would become Hono's env.
        fetch: (request) => (URL.canParse(request.url) ? app.fetch(request) : bare(400)),
        // Reached only by something Hono couldn't render (a non-Error throw). Without it Bun
        // would print the error; this answers a bare 500.
        error: (error) => {
          context.report(error, newRef(), { scope: "web" });
          return bare(500);
        },
      });
    } catch (error) {
      context.report(error, "web listener");
      return null;
    }
    const sweep = setInterval(() => {
      sessions
        .sweep()
        .then((deleted) => {
          if (deleted > 0) webLog.debug({ deleted }, "Web sessions swept");
        })
        .catch((error: unknown) => context.report(error, "web session sweep"));
    }, options.sweepMs ?? SESSION_SWEEP_MS);
    sweep.unref();
    webLog.info({ origin: settings.origin, port: server.port }, "Web server listening");
    let stopping: Promise<void> | undefined;
    return {
      url: server.url,
      stop: () => {
        stopping ??= stopServer(server, sweep, options.stopMs ?? WEB_STOP_MS);
        return stopping;
      },
    };
  } catch (error) {
    context.report(error, "web");
    return null;
  }
}

/**
 * Stop listening at once and let open connections finish (Bun's stop() resolves when the last one
 * closes); after `graceMs`, close whatever is left. That closes sockets only: a handler still
 * running is not cancelled. Never rejects.
 */
async function stopServer(
  server: Server<undefined>,
  sweep: ReturnType<typeof setInterval>,
  graceMs: number,
): Promise<void> {
  clearInterval(sweep);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceful = server.stop(false).then(
    () => true,
    () => true,
  );
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  const finished = await Promise.race([graceful, deadline]);
  clearTimeout(timer);
  if (!finished) await server.stop(true).catch(() => {});
}
