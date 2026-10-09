/**
 * The web server (#43, ADR D12, D14, E1, E10, B4): the Hono app through app.request() with fakes
 * (FakeDiscord answering the injected fetch, the in-memory session store, a recording resolver and
 * reporter, captured logs), then startWeb's real listener on loopback ports, and finally the
 * development harness driven end to end. Credential-free: invented IDs, no network beyond
 * loopback, no database.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { parseHTML } from "linkedom";
import { pino } from "pino";
import { z } from "zod";
import {
  applicationKey,
  gatewayKey,
  lifecycleKey,
  selfRolesKey,
} from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import type { SyncStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import type { ReportOptions } from "../../src/domain/failures.js";
import type { Actor, ActorResolution } from "../../src/domain/policy.js";
import {
  CHOICE_MESSAGES,
  LIMIT_MESSAGES,
  SELF_ROLE_MESSAGES,
} from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import { AccessResolver, type WebGuild } from "../../src/web/access.js";
import { ASSET_CACHE_CONTROL, ASSETS, STYLESHEET } from "../../src/web/assets.js";
import { html } from "../../src/web/html.js";
import { FORM_TOKEN_FIELD, securityHeaderRecord, type WebEnv } from "../../src/web/http.js";
import { icon } from "../../src/web/icons.js";
import {
  EXCHANGE_BUSY_SECONDS,
  EXCHANGE_LIMIT,
  ExchangeGate,
  SIGN_IN_LIMIT,
  SIGN_IN_WINDOW_MS,
  stoppingRefusal,
} from "../../src/web/limits.js";
import { DiscordSignIn } from "../../src/web/oauth.js";
import { definePage, type Page } from "../../src/web/page.js";
import { loadPages } from "../../src/web/pages.js";
import {
  createWebApp,
  startWeb,
  WEB_BODY_LIMIT,
  type WebContext,
  type WebServer,
} from "../../src/web/server.js";
import { formToken, SESSION_ABSOLUTE_MS } from "../../src/web/sessions.js";
import { type WebSettings, webSettings } from "../../src/web/settings.js";
import { notice, noticeLocation } from "../../src/web/views/forms.js";
import { type DiscordAccount, discordOAuthError, FakeDiscord } from "../fixtures/discord-oauth.js";
import { THROWN } from "../fixtures/web-pages/throws/boom.page.js";
import {
  HARNESS_APPLY_MS,
  HARNESS_GUILDS,
  HARNESS_MENU,
  type HarnessMenus,
  type HarnessPeople,
  type HarnessStates,
  harnessGateway,
  harnessOptions,
  harnessPeople,
  harnessSelfRoles,
  MENU_CATEGORY,
  MENU_REVISION,
  MENU_ROLE,
  startHarness,
} from "../fixtures/web-dev.js";
import { MemorySessions } from "../fixtures/web-sessions.js";
import { configGuild, configReport } from "../fixtures/replies/configuration.js";
import { HOSTILE_INPUT, KIT_DEFAULTS, KIT_ERRORS, kitForm } from "../fixtures/web-forms.js";

const HTTPS = "https://example.org";
const DEV = "http://localhost:8080";
/** The server everyone here signs in to. */
const GUILD = "100000000000000001";
/** Cached by the gateway, but not served by this deployment (allowsGuild refuses it). */
const UNSERVED = "100000000000000002";
/** A well-formed ID the gateway doesn't have. */
const ABSENT = "100000000000000009";
const OFFICER = "200000000000000001";
/** Holds the bound Member role: admitted to member pages (2.40.0). */
const MEMBER = "200000000000000002";
const OUTSIDER = "200000000000000003";
/** A second officer, for budgets kept per user. */
const SECOND_OFFICER = "200000000000000004";
/** Holds the bound Guest role: admitted like a member. */
const GUEST = "200000000000000005";
/** In the server with neither access role (a lobby newcomer): admitted nowhere. */
const LOBBY = "200000000000000006";
/** A member in a Discord time-out: still admitted, to view. */
const TIMED_OUT = "200000000000000007";
const CLIENT_ID = "300000000000000001";
const CLIENT_SECRET = "invented-client-secret";
/** Text that must never reach a page, a log line or stderr. */
const SECRET = "secret detail 7f3e that must never reach a page";
const REF = /Ref <code>([0-9a-f-]{36})<\/code>/u;

/** Headers that belong to one response rather than to the shared set. */
const PER_RESPONSE = new Set([
  "allow",
  "cache-control",
  "content-length",
  "content-type",
  "date",
  "location",
  "retry-after",
  "set-cookie",
]);

/** Exactly the shared set, nothing missing and nothing extra. */
function expectSecurityHeaders(response: Response, secure: boolean): void {
  const actual = Object.fromEntries(
    [...response.headers].filter(([name]) => !PER_RESPONSE.has(name)),
  );
  const expected = Object.fromEntries(
    Object.entries(securityHeaderRecord(secure)).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  expect(actual).toEqual(expected);
}

/** One recorded report call. */
interface Reported {
  readonly error: unknown;
  readonly operation: string;
  readonly options: ReportOptions | undefined;
}

/** One captured pino line. */
type LogLine = Record<string, unknown> & { level: number; msg: string };

/** A page with a form, for the POST pipeline and the 422 re-render. */
const NAME_FORM = z.object({ name: z.string().min(1).max(20) });

/** The kit page's fixed notices; the success redirect names one by its token. */
const KIT_NOTICES = { saved: "Your changes were saved." } as const;

/** The limited page's budget, small so a test can spend it. */
const LIMITED_POSTS = 3;

/** A form token's hidden input in a page, as a browser would submit it. */
const TOKEN_INPUT = new RegExp(`name="${FORM_TOKEN_FIELD}" value="([A-Za-z0-9_-]{43})"`, "gu");

/** Invented sync status for the Status page. */
const SYNC: SyncStatusView = { effectsMode: "live", runs: [], work: [] };

interface WorldOptions {
  readonly origin?: string;
  /** Replaces syncStatus, to make Status slow or throw. */
  readonly syncStatus?: () => Promise<SyncStatusView>;
  /** The Role menu's review states (the harness's), none by default. */
  readonly menuStates?: HarnessStates;
  /**
   * Serve the fixture pages only, without the discovered ones, so a test can count a member's
   * pages exactly (the / redirect).
   */
  readonly fixturesOnly?: boolean;
}

/** Everything a test needs: the app and every fake behind it. */
interface World {
  readonly app: Hono<WebEnv>;
  readonly settings: WebSettings;
  readonly discord: FakeDiscord;
  readonly sessions: MemorySessions;
  /** (guild, user) per resolver call. */
  readonly resolutions: [string, string][];
  /** The mode each resolver call asked for, in order. */
  readonly modes: ActorResolution[];
  /** Whether TaruBot holds Administrator in every server (A2); false by default. */
  readonly botAdministrator: { now: boolean };
  /**
   * While `until` is set, every request to Discord waits for it before the fake answers, so a test
   * can hold token exchanges in flight; `waiting` counts the requests held so far.
   */
  readonly discordHold: { until: Promise<void> | null; waiting: number };
  readonly reports: Reported[];
  /** Forms the form page received. */
  readonly posts: Record<string, unknown>[];
  /** Milliseconds; the memo, the session store and the POST budgets read it. */
  readonly clock: { now: number };
  readonly lifecycle: { ready: boolean };
  /** What context.isStopping() answers. */
  readonly stopping: { now: boolean };
  /** The Role menu's saved menus by server, as the harness's SelfRoles keeps them. */
  readonly menus: HarnessMenus;
  /** My roles' held roles and newest changes (2.40.0), on `clock`. */
  readonly people: HarnessPeople;
  readonly logs: () => LogLine[];
}

/**
 * The services the pages and /health/ready use, as prototype-backed fakes: the Role menu's is the
 * harness's in-memory SelfRoles over `menus`, in the review `states` given.
 */
function services(
  world: Pick<World, "lifecycle" | "menus" | "people">,
  syncStatus: () => Promise<SyncStatusView>,
  states: HarnessStates = {},
) {
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  app.syncStatus = syncStatus;
  app.validate = async () => configReport({ guild: configGuild({ id: GUILD }) });
  const lifecycle: unknown = Object.create(ApplicationLifecycle.prototype);
  if (!(lifecycle instanceof ApplicationLifecycle)) throw new Error("Invalid lifecycle fixture");
  // Only `ready` may reach the probe; the rest carries numbers a leak would show.
  lifecycle.status = () => ({
    live: true,
    ready: world.lifecycle.ready,
    database: true,
    writerLease: true,
    discord: true,
    effects: true,
    publicTestResponses: false,
    capabilities: { detail: "capability-7770" },
    lodestone: {
      parsing: 7771,
      waiting: 7772,
      cooldownSeconds: 0,
      strikes: 7773,
      selectors: {
        repository: "xivapi/lodestone-css-selectors",
        revision: "rev7774",
        source: "upstream",
        activatedAt: null,
        bundled: "rev7775",
      },
      upstream: { status: "current", checkedAt: null, components: [] },
    },
    visibility: { missing: 7776, onboardingPending: 7777, checked: 7778, checkedAt: null },
  });
  return new Services()
    .provide(applicationKey, app)
    .provide(lifecycleKey, lifecycle)
    .provide(gatewayKey, harnessGateway())
    .provide(selfRolesKey, harnessSelfRoles(states, world.menus, world.people));
}

/**
 * The bot's resolver over invented membership: officers, a member, a guest, a timed-out member,
 * a lobby newcomer and Unknown Member, with TaruBot's Administrator as `administrator` says.
 */
function resolver(
  resolutions: [string, string][],
  modes: ActorResolution[] = [],
  administrator: { now: boolean } = { now: false },
) {
  return async (guildId: string, userId: string, mode?: ActorResolution): Promise<Actor> => {
    resolutions.push([guildId, userId]);
    modes.push(mode ?? "full");
    if (userId === OUTSIDER)
      throw new Failure("forbidden", "Not a member.", 0, {
        kind: "scope",
        scope: "current_member",
      });
    return {
      guildId,
      userId,
      officer: userId === OFFICER || userId === SECOND_OFFICER,
      manageRoles: false,
      member: userId === MEMBER || userId === TIMED_OUT,
      guest: userId === GUEST,
      botAdministrator: administrator.now,
      timedOut: userId === TIMED_OUT,
    };
  };
}

/** The gateway's cached servers; names are hostile, so escaping is always exercised. */
const GUILDS: readonly WebGuild[] = [
  { id: GUILD, name: "<img src=x onerror=alert(1)> FC" },
  { id: UNSERVED, name: "Unserved FC" },
];

async function world(options: WorldOptions = {}): Promise<World> {
  const parsed = webSettings({
    WEB_PUBLIC_ORIGIN: options.origin ?? DEV,
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    DISCORD_APPLICATION_ID: CLIENT_ID,
  });
  if (parsed.status !== "on") throw new Error("Invalid test settings");
  const { settings } = parsed;
  const clock = { now: Date.parse("2026-10-04T12:00:00.000Z") };
  const lifecycle = { ready: true };
  const stopping = { now: false };
  const resolutions: [string, string][] = [];
  const modes: ActorResolution[] = [];
  const botAdministrator = { now: false };
  const discordHold: World["discordHold"] = { until: null, waiting: 0 };
  const reports: Reported[] = [];
  const posts: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const log = pino(
    { level: "debug", redact: ["token", "authorization", "password"] },
    { write: (line: string) => void lines.push(line) },
  ).child({ component: "web" });
  const formPage = definePage({
    path: "/g/:guild/form",
    title: "Form",
    access: ["officer"],
    requires: [],
    nav: "Form",
    get: ({ formToken: token }) =>
      html`<form method="post" action="/g/${GUILD}/form"><input type="hidden" name="${FORM_TOKEN_FIELD}" value="${token}"><label for="name">Name</label><input id="name" name="name"><button type="submit">Save</button></form>`,
    async post(context, form) {
      posts.push(Object.fromEntries(form));
      const parsed = NAME_FORM.safeParse(Object.fromEntries(form));
      if (!parsed.success) return { invalid: html`<p>Enter a name of at most 20 characters.</p>` };
      // A page bug returning an off-site target must still end on this origin.
      return { redirect: parsed.data.name === "away" ? "//evil.example/" : context.url.pathname };
    },
    postLimit: 120,
  });
  // The write foundation's fixture: the form kit, a success notice, both re-render
  // statuses, the pre-commit shutdown check, and a page bug's off-list status.
  const kitPage = definePage({
    path: "/g/:guild/kit",
    title: "Kit",
    access: ["officer"],
    requires: [],
    get: ({ url, formToken: token }) =>
      html`${notice(url, KIT_NOTICES)}${kitForm(url.pathname, token)}`,
    async post(context, form) {
      posts.push(Object.fromEntries(form));
      const action = context.url.pathname;
      const values = {
        ...KIT_DEFAULTS,
        name: String(form.get("name") ?? ""),
        roles: form.getAll("roles").map(String),
      };
      // An application operation's check just before commit, once shutdown has begun.
      if (form.get("op") === "commit-while-stopping") throw stoppingRefusal();
      if (form.get("op") === "teapot")
        return { invalid: html`<p>A page bug's status.</p>`, status: 418 as unknown as 409 };
      if (form.get("revision") === "stale")
        return {
          invalid: kitForm(action, context.formToken, values, [
            { id: "kit-name", message: "Another officer changed this while you were editing." },
          ]),
          status: 409,
        };
      if (values.name.length > 40)
        return { invalid: kitForm(action, context.formToken, values, KIT_ERRORS) };
      return { redirect: noticeLocation(action, "saved") };
    },
    postLimit: 120,
  });
  // A small budget to spend.
  const limitedPage = definePage({
    path: "/g/:guild/limited",
    title: "Limited",
    access: ["officer"],
    requires: [],
    get: () => html`<p>Limited</p>`,
    async post(context, form) {
      posts.push(Object.fromEntries(form));
      return { redirect: context.url.pathname };
    },
    postLimit: LIMITED_POSTS,
  });
  // A page bug: a service it never declared.
  const undeclaredPage = definePage({
    path: "/g/:guild/undeclared",
    title: "Undeclared",
    access: ["officer"],
    requires: [],
    get: ({ services }) => {
      services.get(applicationKey);
      return html`<p>Never shown</p>`;
    },
  });
  // A page members and guests may open (2.40.0), and officers too, as My roles declares; it
  // stands in for any such page, so these tests don't depend on one page's own behavior.
  const picksPage = definePage({
    path: "/g/:guild/picks",
    title: "Picks",
    access: ["member", "guest", "officer"],
    requires: [],
    nav: "Picks",
    get: ({ actor }) => html`<p>Picks for ${actor.timedOut ? "a timed-out viewer" : "you"}</p>`,
  });
  const pages = new Map<string, Page>([
    ...(options.fixturesOnly ? [] : await loadPages()),
    ...[formPage, kitPage, limitedPage, undeclaredPage, picksPage].map(
      (fixture): [string, Page] => [fixture.path, fixture],
    ),
  ]);
  const discord = new FakeDiscord(CLIENT_ID, CLIENT_SECRET);
  const sessions = new MemorySessions(() => clock.now);
  const resolve = resolver(resolutions, modes, botAdministrator);
  const menus: HarnessMenus = new Map();
  const people = harnessPeople(() => clock.now);
  const context: WebContext = {
    services: services(
      { lifecycle, menus, people },
      options.syncStatus ?? (async () => SYNC),
      options.menuStates,
    ),
    allowsGuild: (guildId) => guildId !== UNSERVED,
    isStopping: () => stopping.now,
    resolveActor: resolve,
    report: (error, operation, reportOptions) =>
      reports.push({ error, operation, options: reportOptions }),
    guilds: () => GUILDS,
  };
  const app = createWebApp({
    settings,
    context,
    pages,
    sessions,
    signIn: new DiscordSignIn({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (discordHold.until) {
            discordHold.waiting++;
            await discordHold.until;
          }
          return discord.fetch(input, init);
        },
        { preconnect: fetch.preconnect },
      ),
      // D16's gate on the test clock, with production's limits.
      gate: new ExchangeGate({ now: () => clock.now }),
    }),
    access: new AccessResolver(resolve, { now: () => clock.now }),
    log,
    now: () => clock.now,
  });
  return {
    app,
    settings,
    discord,
    sessions,
    resolutions,
    modes,
    botAdministrator,
    discordHold,
    reports,
    posts,
    clock,
    lifecycle,
    stopping,
    menus,
    people,
    logs: () => lines.map((line) => JSON.parse(line) as LogLine),
  };
}

/** A browser: a cookie jar, Fetch Metadata on its own posts, and redirects left to the test. */
class Browser {
  readonly jar = new Map<string, string>();

  constructor(private readonly world: World) {}

  /** The request header for the jar. */
  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0 && !headers.has("cookie")) headers.set("cookie", this.cookie);
    const response = await this.world.app.request(new URL(path, this.world.settings.origin).href, {
      ...init,
      headers,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/max-age=0/iu.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, init);
  }

  /**
   * The form token this browser's pages carry: derived from its session cookie as the server
   * does, or null signed out. A test that reads it from a page instead proves the two agree.
   */
  get formToken(): string | null {
    const session = this.jar.get(sessionCookie(this.world));
    return session === undefined ? null : formToken(session);
  }

  /**
   * A same-origin form post, as a browser sends it: with the form token its pages carry, unless
   * `token` says otherwise (null sends none).
   */
  post(
    path: string,
    body = "",
    headers: Record<string, string> = {},
    token: string | null = this.formToken,
  ): Promise<Response> {
    const field = token === null ? "" : `${FORM_TOKEN_FIELD}=${encodeURIComponent(token)}`;
    return this.request(path, {
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        Origin: this.world.settings.origin,
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: [body, field].filter((part) => part !== "").join("&"),
    });
  }

  /**
   * Start a sign-in through /login and the fake authorize page: the callback path and query the
   * browser would be sent to, not yet followed.
   */
  async authorize(account: DiscordAccount, to?: string): Promise<string> {
    const login = await this.get(
      to === undefined ? "/login" : `/login?to=${encodeURIComponent(to)}`,
    );
    expect(login.status).toBe(302);
    const callback = this.world.discord.authorize(
      new URL(login.headers.get("location") ?? ""),
      account,
    );
    return `${callback.pathname}${callback.search}`;
  }

  /** Sign in through /login, the fake authorize page and the callback. */
  async signIn(account: DiscordAccount, to?: string): Promise<Response> {
    return this.get(await this.authorize(account, to));
  }
}

/** A browser signed in as `userId`. */
async function signedIn(w: World, userId = OFFICER): Promise<Browser> {
  const browser = new Browser(w);
  const response = await browser.signIn({ id: userId });
  expect(response.status).toBe(303);
  return browser;
}

/** Session cookie names per origin kind. */
const sessionCookie = (w: World) => (w.settings.secure ? "__Host-tarubot" : "tarubot");
const loginCookie = (w: World) => (w.settings.secure ? "__Host-tarubot-login" : "tarubot-login");
/** Whether a response expires the sign-in handshake cookie (Max-Age=0). */
const clearsLogin = (w: World, response: Response): boolean =>
  response.headers
    .getSetCookie()
    .some((cookie) => cookie.startsWith(`${loginCookie(w)}=;`) && cookie.includes("Max-Age=0"));

describe("the header set on every answer", () => {
  for (const origin of [DEV, HTTPS])
    test(`${origin}: 200, 303, 403, 404, 405, 413, 415, 422, 500 and HEAD`, async () => {
      const failing = { now: false };
      const w = await world({
        origin,
        syncStatus: async () => {
          if (failing.now) throw new Error(SECRET);
          return SYNC;
        },
      });
      const secure = w.settings.secure;
      const visitor = new Browser(w);
      const officer = await signedIn(w);
      const status = `/g/${GUILD}/status`;
      const cases: [string, number, () => Promise<Response>][] = [
        ["home", 200, () => visitor.get("/")],
        ["page", 200, () => officer.get(status)],
        ["signed-out page", 303, () => visitor.get(status)],
        [
          "cross-site post",
          403,
          () => visitor.post("/logout", "", { "Sec-Fetch-Site": "cross-site" }),
        ],
        ["unknown path", 404, () => visitor.get("/wp-login.php")],
        ["wrong method", 405, () => visitor.request("/", { method: "PUT" })],
        ["oversized body", 413, () => visitor.post("/logout", `a=${"x".repeat(WEB_BODY_LIMIT)}`)],
        [
          "JSON post",
          415,
          () => visitor.post("/logout", "{}", { "Content-Type": "application/json" }),
        ],
        ["invalid form", 422, () => officer.post(`/g/${GUILD}/form`, "name=")],
        ["readiness", 200, () => visitor.get("/health/ready")],
        ["asset", 200, () => visitor.get(STYLESHEET.path)],
        ["HEAD", 200, () => visitor.request("/", { method: "HEAD" })],
      ];
      for (const [name, expected, send] of cases) {
        const response = await send();
        expect({ name, status: response.status }).toEqual({ name, status: expected });
        expectSecurityHeaders(response, secure);
      }
      // A thrown error: 500 with Code and Ref, and nothing of its message anywhere.
      failing.now = true;
      const stderr = spyOn(process.stderr, "write");
      const consoleError = spyOn(console, "error");
      try {
        const response = await officer.get(status);
        expect(response.status).toBe(500);
        expectSecurityHeaders(response, secure);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.text();
        expect(body).not.toContain(SECRET);
        expect(body).toContain("Code <code>unexpected</code>");
        expect(body).toMatch(REF);
        expect(stderr).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
        consoleError.mockRestore();
      }
      expect(JSON.stringify(w.logs())).not.toContain(SECRET);
    });

  test("HSTS only on https; a 405 names the allowed methods", async () => {
    const dev = await world();
    const https = await world({ origin: HTTPS });
    expect((await new Browser(dev).get("/")).headers.get("strict-transport-security")).toBeNull();
    expect((await new Browser(https).get("/")).headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    const browser = new Browser(dev);
    const allowed: [string, string, string][] = [
      ["PUT", "/", "GET, HEAD"],
      ["DELETE", `/g/${GUILD}/status`, "GET, HEAD"],
      ["PATCH", `/g/${GUILD}/form`, "GET, HEAD, POST"],
      ["GET", "/logout", "POST"],
      ["GET", "/logout/all", "POST"],
      ["PUT", "/health/ready", "GET, HEAD"],
      ["POST", "/health/ready", "GET, HEAD"],
    ];
    for (const [method, path, allow] of allowed) {
      const response =
        method === "POST" ? await browser.post(path) : await browser.request(path, { method });
      expect({
        method,
        path,
        status: response.status,
        allow: response.headers.get("allow"),
      }).toEqual({ method, path, status: 405, allow });
    }
  });
});

describe("the POST pipeline (E1)", () => {
  const form = `/g/${GUILD}/form`;

  test("same origin first (403), then the form type (415), then the session (303)", async () => {
    const w = await world();
    const visitor = new Browser(w);
    // Cross-site, the wrong type and no session: the origin check answers.
    const crossSite = await visitor.post(form, "{}", {
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    });
    expect(crossSite.status).toBe(403);
    // Same origin, the wrong type and no session: the type check answers.
    const json = await visitor.post(form, "{}", { "Content-Type": "application/json" });
    expect(json.status).toBe(415);
    // A form without a session goes to sign-in, with the page as the return path.
    const anonymous = await visitor.post(form, "name=x");
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/login?to=${encodeURIComponent(form)}`);
    expect(w.resolutions).toEqual([]);
    expect(w.posts).toEqual([]);
  });

  test("E1 refusals, readiness, assets and unknown paths never look up a session", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const before = w.sessions.lookups;
    const cases: [string, number, () => Promise<Response>][] = [
      [
        "cross-site sign-out",
        403,
        () => officer.post("/logout", "", { "Sec-Fetch-Site": "cross-site" }),
      ],
      [
        "JSON sign-out",
        415,
        () => officer.post("/logout", "{}", { "Content-Type": "application/json" }),
      ],
      [
        "cross-site sign-out everywhere",
        403,
        () => officer.post("/logout/all", "", { "Sec-Fetch-Site": "cross-site" }),
      ],
      [
        "JSON sign-out everywhere",
        415,
        () => officer.post("/logout/all", "{}", { "Content-Type": "application/json" }),
      ],
      [
        "cross-site form",
        403,
        () => officer.post(form, "name=x", { "Sec-Fetch-Site": "cross-site" }),
      ],
      ["JSON form", 415, () => officer.post(form, "{}", { "Content-Type": "application/json" })],
      ["readiness", 200, () => officer.get("/health/ready")],
      ...ASSETS.map((asset): [string, number, () => Promise<Response>] => [
        asset.path,
        200,
        () => officer.get(asset.path),
      ]),
      ["unknown path", 404, () => officer.get("/wp-login.php")],
      ["unknown path, POST", 404, () => officer.post("/wp-login.php")],
    ];
    for (const [name, expected, send] of cases)
      expect({ name, status: (await send()).status }).toEqual({ name, status: expected });
    expect(w.sessions.lookups).toBe(before);
    expect(w.posts).toEqual([]);
    // A same-origin form passes E1, and only then is the session read.
    expect((await officer.post("/logout")).status).toBe(303);
    expect(w.sessions.lookups).toBeGreaterThan(before);
  });

  test("Fetch Metadata decides when present; Origin only when it is absent", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const send = (headers: Record<string, string>) =>
      officer.request(form, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: `name=ok&${FORM_TOKEN_FIELD}=${officer.formToken}`,
      });
    const origin = w.settings.origin;
    expect((await send({ "Sec-Fetch-Site": "cross-site", Origin: origin })).status).toBe(403);
    expect((await send({ "Sec-Fetch-Site": "same-site", Origin: origin })).status).toBe(403);
    expect((await send({ "Sec-Fetch-Site": "none" })).status).toBe(403);
    expect((await send({})).status).toBe(403);
    expect((await send({ Origin: "null" })).status).toBe(403);
    expect((await send({ Origin: "http://localhost:8081" })).status).toBe(403);
    expect(w.posts).toEqual([]);
    expect((await send({ Origin: origin })).status).toBe(303);
    expect((await send({ "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
    expect(w.posts).toEqual([{ name: "ok" }, { name: "ok" }]);
  });

  test("every POST resolves the actor afresh; a GET reuses it within the memo window", async () => {
    const w = await world();
    const officer = await signedIn(w);
    // Sign-in's admission resolved fresh and memoized that answer: a GET at once reuses it.
    w.resolutions.length = 0;
    await officer.get(form);
    expect(w.resolutions).toHaveLength(0);
    w.clock.now += 61_000;
    await officer.get(form);
    await officer.get(form);
    expect(w.resolutions).toHaveLength(1);
    await officer.post(form, "name=ok");
    await officer.post(form, "name=ok");
    expect(w.resolutions).toHaveLength(3);
    // After the window a GET asks Discord again.
    w.clock.now += 61_000;
    await officer.get(form);
    expect(w.resolutions).toHaveLength(4);
  });

  test("a POST from a user without the page's flag is 403 and never reaches post()", async () => {
    const w = await world();
    // A member can't sign in (no page admits them), so the session is made directly.
    const member = new Browser(w);
    member.jar.set("tarubot", (await w.sessions.create(MEMBER)).token);
    const response = await member.post(form, "name=ok");
    expect(response.status).toBe(403);
    expect(w.posts).toEqual([]);
    // With nothing memoized, decided on a fresh resolution.
    expect(w.resolutions).toEqual([[GUILD, MEMBER]]);
  });

  test("a page someone can't use refuses their POSTs from the memo: at most one full resolution a minute", async () => {
    const w = await world();
    const roleMenu = `/g/${GUILD}/role-menu`;
    // A member signs in (My roles admits them) and posts to Role menu, which doesn't, more often
    // than its officers' budget of 120 allows: every POST is 403, none costs a Discord request
    // while sign-in's answer is memoized, and none spends the budget.
    const member = await signedIn(w, MEMBER);
    w.modes.length = 0;
    for (let attempt = 0; attempt < 125; attempt++)
      expect((await member.post(roleMenu, "op=category.create")).status).toBe(403);
    expect(w.modes).toEqual([]);
    // Once the memo's minute is over, one full resolution refreshes it, and the rest are free.
    w.clock.now += 61_000;
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await member.post(roleMenu, "op=category.create")).status).toBe(403);
    expect(w.modes).toEqual(["full"]);
    expect(w.menus.has(GUILD)).toBe(false);
    // An officer's POST, admitted by the memo's answer, still makes exactly one full resolution.
    const officer = await signedIn(w);
    w.modes.length = 0;
    expect((await officer.post(form, "name=ok")).status).toBe(303);
    expect(w.modes).toEqual(["full"]);
    // Someone not in the server (their session made directly): 404 each time, after one
    // resolution, which the memo then answers.
    const outsider = new Browser(w);
    outsider.jar.set("tarubot", (await w.sessions.create(OUTSIDER)).token);
    w.resolutions.length = 0;
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await outsider.post(form, "name=ok")).status).toBe(404);
    expect(w.resolutions).toEqual([[GUILD, OUTSIDER]]);
    expect(w.posts).toEqual([{ name: "ok" }]);
  });

  test("zod failures re-render with 422; success redirects 303, only ever on this origin", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const invalid = await officer.post(form, `name=${"x".repeat(30)}`);
    expect(invalid.status).toBe(422);
    const text = await invalid.text();
    expect(text).toContain("Enter a name of at most 20 characters.");
    expect(text).not.toContain("x".repeat(30));
    const ok = await officer.post(form, "name=ok");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(form);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const away = await officer.post(form, "name=away");
    expect(away.status).toBe(303);
    expect(away.headers.get("location")).toBe("/");
  });
});

describe("the write foundation", () => {
  const form = `/g/${GUILD}/form`;
  const kit = `/g/${GUILD}/kit`;
  const limited = `/g/${GUILD}/limited`;

  test("a POST without the session's form token is 403 before it costs anything", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const other = await signedIn(w, SECOND_OFFICER);
    w.resolutions.length = 0;
    for (const token of [null, "", "x".repeat(43), other.formToken]) {
      const response = await officer.post(form, "name=ok", {}, token);
      expect({ token, status: response.status }).toEqual({ token, status: 403 });
      const text = await response.text();
      expect(text).toContain(
        "This form is out of date or didn&#39;t come from TaruBot&#39;s own pages, so TaruBot ignored it. Open the page again, then redo your change.",
      );
      // Reloading this answer would send the same form again, so the page offers a way back to
      // the form's own page first, under a heading that doesn't call the officer not allowed.
      const { document } = parseHTML(text);
      expect(document.querySelector("h1")?.textContent).toBe("Form out of date");
      expect(
        [...document.querySelectorAll(".entry-panel__actions a")].map((link) => [
          link.getAttribute("href"),
          link.textContent,
        ]),
      ).toEqual([
        [form, "Back to Form"],
        ["/", "Go to the TaruBot start page"],
      ]);
    }
    // No Discord request and no page code ran.
    expect(w.resolutions).toEqual([]);
    expect(w.posts).toEqual([]);
    // The token the page rendered is the one that passes, and post() never sees the field.
    const page = await (await officer.get(form)).text();
    const rendered = [...page.matchAll(TOKEN_INPUT)].map((match) => match[1] ?? "");
    // The page's form and the account menu's two sign-out forms.
    const derived = officer.formToken ?? "";
    expect(rendered).toEqual([derived, derived, derived]);
    expect((await officer.post(form, "name=ok", {}, rendered[0] ?? null)).status).toBe(303);
    expect(w.posts).toEqual([{ name: "ok" }]);
  });

  test("once shutdown begins, a POST is 429 with Retry-After before the budget, the actor or post()", async () => {
    const w = await world();
    const officer = await signedIn(w);
    w.resolutions.length = 0;
    w.stopping.now = true;
    for (let attempt = 0; attempt <= LIMITED_POSTS; attempt++) {
      const response = await officer.post(limited, "x=1");
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
      // One wait, from Retry-After.
      const text = await response.text();
      expect(text).toContain("TaruBot is restarting, so nothing was saved.");
      expect(text).toContain("Try again in about 30 seconds.");
      expect(text).not.toContain("in a minute");
      expect(text).toContain(`href="${limited}">Back to Limited</a>`);
      // A restart isn't the person's doing: never "Too many requests" (UX-4).
      const { document } = parseHTML(text);
      expect(document.querySelector("h1")?.textContent).toBe("TaruBot is restarting");
      expect(document.querySelector("title")?.textContent).toStartWith("TaruBot is restarting");
    }
    expect(w.resolutions).toEqual([]);
    expect(w.posts).toEqual([]);
    // Reading still works while the drain runs.
    expect((await officer.get(limited)).status).toBe(200);
    // The refusals spent none of the budget.
    w.stopping.now = false;
    for (let attempt = 0; attempt < LIMITED_POSTS; attempt++)
      expect((await officer.post(limited, "x=1")).status).toBe(303);
  });

  test("an operation's pre-commit shutdown check answers the same 429", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const response = await officer.post(kit, "op=commit-while-stopping&name=x");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    const text = await response.text();
    expect(text).toContain("nothing was saved");
    expect(text).toContain(`href="${kit}">Back to Kit</a>`);
    const { document } = parseHTML(text);
    expect(document.querySelector("h1")?.textContent).toBe("TaruBot is restarting");
    expect(document.querySelector("title")?.textContent).toStartWith("TaruBot is restarting");
    expect(w.reports).toEqual([]);
  });

  test("the budget is per page, server and user; over it, 429 with Retry-After and no Discord request", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const second = await signedIn(w, SECOND_OFFICER);
    w.resolutions.length = 0;
    // A refused input counts like any POST: the budget bounds what a user can spend.
    for (let attempt = 0; attempt < LIMITED_POSTS; attempt++)
      expect((await officer.post(limited, "x=1")).status).toBe(303);
    const over = await officer.post(limited, "x=1");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("600");
    const refusal = await over.text();
    expect(refusal).toContain(
      "You&#39;ve sent a lot of saves in a short time, so TaruBot didn&#39;t take this one.",
    );
    expect(refusal).toContain(`href="${limited}">Back to Limited</a>`);
    // One wait, from Retry-After.
    expect(refusal).toContain("Try again in about 10 minutes.");
    expect(refusal).not.toContain("Wait a few minutes");
    // The refused POST resolved no actor and reached no page code.
    expect(w.resolutions).toHaveLength(LIMITED_POSTS);
    expect(w.posts).toHaveLength(LIMITED_POSTS);
    // Another user, and another page for the same user, have budgets of their own.
    expect((await second.post(limited, "x=1")).status).toBe(303);
    expect((await officer.post(form, "name=ok")).status).toBe(303);
    // The window counts from the first POST; the wait shrinks, then the budget is back.
    w.clock.now += 599_001;
    const last = await officer.post(limited, "x=1");
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("1");
    w.clock.now += 999;
    expect((await officer.post(limited, "x=1")).status).toBe(303);
    // Reading costs no budget.
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await officer.get(limited)).status).toBe(200);
  });

  test("a refused input re-renders at 422 with the summary, the values kept and an Error: title", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const name = `${HOSTILE_INPUT}${"x".repeat(40)}`;
    const response = await officer.post(
      kit,
      `op=category.edit&revision=7&name=${encodeURIComponent(name)}&roles=300000000000000001&roles=300000000000000003`,
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("<title>Error: Kit · TaruBot</title>");
    expect(text).toContain('<h1 class="page-header__title">Kit</h1>');
    expect(text).toContain('<div class="error-summary" role="alert" tabindex="-1" autofocus');
    expect(text).toContain('<a href="#kit-name">Enter a name of at most 40 characters.</a>');
    // What was typed comes back escaped in its field, and is never markup.
    expect(text).toContain(
      `id="kit-name" name="name" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;${"x".repeat(40)}"`,
    );
    expect(text).not.toContain("<img src=x");
    expect(text).toMatch(/value="300000000000000001" checked/u);
    expect(text).toMatch(/value="300000000000000003" checked/u);
    // The re-rendered forms carry the token again, so the corrected form can be sent.
    expect([...text.matchAll(TOKEN_INPUT)].length).toBeGreaterThanOrEqual(3);
    expect(w.posts[0]).toMatchObject({ op: "category.edit", name });
    expect(Object.keys(w.posts[0] ?? {})).not.toContain(FORM_TOKEN_FIELD);
  });

  test("a stale form re-renders at 409 with what was typed; any other page status is a 422", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const stale = await officer.post(kit, "op=category.edit&revision=stale&name=Renamed");
    expect(stale.status).toBe(409);
    const text = await stale.text();
    expect(text).toContain("<title>Error: Kit · TaruBot</title>");
    expect(text).toContain("Another officer changed this while you were editing.");
    expect(text).toContain('value="Renamed"');
    const odd = await officer.post(kit, "op=teapot");
    expect(odd.status).toBe(422);
    expect(await odd.text()).toContain("<title>Error: Kit · TaruBot</title>");
  });

  test("success is a 303 to the page with a notice, which the page shows from its own table only", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const saved = await officer.post(kit, "op=category.edit&revision=7&name=Pronouns");
    expect(saved.status).toBe(303);
    const location = saved.headers.get("location") ?? "";
    expect(location).toBe(`${kit}?notice=saved#status`);
    const shown = await (await officer.get(location)).text();
    expect(shown).toContain(
      '<p class="notice notice--success" id="status" role="status" tabindex="-1">Your changes were saved.</p>',
    );
    expect(shown).toContain("<title>Kit · TaruBot</title>");
    for (const query of ["?notice=unknown", "?notice=%3Cb%3Ehi%3C%2Fb%3E", "?notice=__proto__", ""])
      expect({
        query,
        notice: (await (await officer.get(`${kit}${query}`)).text()).includes("notice--success"),
      }).toEqual({
        query,
        notice: false,
      });
  });

  test("a page gets only the services it declared; another is a reported 500", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const response = await officer.get(`/g/${GUILD}/undeclared`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("undeclared service");
    expect(w.reports).toHaveLength(1);
    const [reported] = w.reports;
    const error = reported?.error;
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe(
      `Page used an undeclared service: ${applicationKey.name}`,
    );
    expect(reported?.options).toEqual({ scope: "web:/g/:guild/undeclared", level: "error" });
    // Declared services still resolve: Status declares the application, lifecycle and gateway.
    expect((await officer.get(`/g/${GUILD}/status`)).status).toBe(200);
  });

  test("every form page's POST route answers 405 for other methods, naming POST", async () => {
    const w = await world();
    const browser = new Browser(w);
    for (const path of [form, kit, limited]) {
      const response = await browser.request(path, { method: "PUT" });
      expect({ path, status: response.status, allow: response.headers.get("allow") }).toEqual({
        path,
        status: 405,
        allow: "GET, HEAD, POST",
      });
    }
  });
});

describe("the Role menu (2.39.0)", () => {
  const path = `/g/${GUILD}/role-menu`;
  /** A form body as the page's forms send it (the browser adds the form token). */
  const body = (fields: Record<string, string | readonly string[]>): string => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(fields))
      for (const item of typeof value === "string" ? [value] : value) params.append(name, item);
    return params.toString();
  };
  /** The officer's notice redirect for `token`, shown in `category`'s card when it names one. */
  const noticed = (token: string, category?: string) =>
    category === undefined
      ? `${path}?notice=${token}#status`
      : `${path}?notice=${token}&category=${category}#status`;
  /** The saved menu the harness's SelfRoles holds for the server. */
  const saved = (w: World) => w.menus.get(GUILD);
  const categoryNamed = (w: World, name: string) =>
    saved(w)?.menu?.categories.find((category) => category.name === name);
  /** A new category's ID, as the page mints them. */
  const NEW_ID = "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const create = (overrides: Record<string, string> = {}) =>
    body({
      op: "category.create",
      revision: String(MENU_REVISION),
      id: NEW_ID,
      name: "Timezones",
      description: "Where you play from.",
      max: "1",
      ...overrides,
    });

  test("officers find it in the navigation; GET and HEAD serve it, and other methods are 405 naming POST", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const page = await officer.get(`/g/${GUILD}/status`);
    expect(await page.text()).toContain(`href="${path}"`);
    const response = await officer.get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('<h1 class="page-header__title">Role menu</h1>');
    expect(text).toContain(`href="${path}" aria-current="page"`);
    expect((await officer.request(path, { method: "HEAD" })).status).toBe(200);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const refused = await officer.request(path, { method });
      expect({ method, status: refused.status, allow: refused.headers.get("allow") }).toEqual({
        method,
        status: 405,
        allow: "GET, HEAD, POST",
      });
    }
  });

  test("every form carries op, the menu's revision and the session's form token", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const { document } = parseHTML(await (await officer.get(path)).text());
    const forms = [...document.querySelectorAll("main form")];
    expect(forms.length).toBeGreaterThan(20);
    for (const form of forms) {
      const value = (name: string) =>
        form.querySelector(`input[type="hidden"][name="${name}"]`)?.getAttribute("value");
      expect({
        action: form.getAttribute("action"),
        token: value(FORM_TOKEN_FIELD),
        revision: value("revision"),
        op: typeof value("op"),
      }).toEqual({
        action: path,
        token: officer.formToken ?? "",
        revision: String(MENU_REVISION),
        op: "string",
      });
    }
  });

  test("a member without the officer flag is 403 on GET and POST, and the menu is never read", async () => {
    const w = await world();
    const { token } = await w.sessions.create(MEMBER);
    const cookie = `tarubot=${token}`;
    expect((await w.app.request(new URL(path, DEV).href, { headers: { cookie } })).status).toBe(
      403,
    );
    const posted = await w.app.request(new URL(path, DEV).href, {
      method: "POST",
      headers: {
        cookie,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `${create()}&${FORM_TOKEN_FIELD}=${formToken(token)}`,
    });
    expect(posted.status).toBe(403);
    // Refused for access, so no way back to a page that wouldn't open, and the status's heading.
    const refusal = parseHTML(await posted.text()).document;
    expect(refusal.querySelector("h1")?.textContent).toBe("Not allowed");
    expect(refusal.querySelector(`a[href="${path}"]`)).toBeNull();
    expect(w.menus.has(GUILD)).toBe(false);
  });

  test("a create is a 303 to its notice; a double submit lands on the same 303 and writes once", async () => {
    const w = await world();
    const officer = await signedIn(w);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await officer.post(path, create());
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(noticed("created", NEW_ID));
    }
    expect(saved(w)?.revision).toBe(MENU_REVISION + 1n);
    expect(categoryNamed(w, "Timezones")).toMatchObject({ id: NEW_ID, state: "draft", max: 1 });
    const shown = await (await officer.get(noticed("created", NEW_ID))).text();
    expect(shown).toContain(
      'id="status" role="status" tabindex="-1">Category added as a draft. Add its roles, then publish it when it&#39;s ready.</p>',
    );
    // In the new category's card, ahead of its title, and only there.
    const card = parseHTML(shown).document.querySelector(`#category-${NEW_ID}`);
    expect(card?.querySelector("#status")?.nextElementSibling?.className).toBe(
      "menu-category__meta",
    );
    expect(shown.match(/id="status"/gu)).toHaveLength(1);
    expect(shown).toContain('<span dir="auto">Timezones</span>');
    // A notice the page's table doesn't hold shows nothing, and is never reflected.
    const crafted = await (await officer.get(`${path}?notice=%3Cb%3Ehi`)).text();
    expect(crafted).not.toContain("notice--success");
    expect(crafted).not.toContain("<b>hi");
    // A category the menu doesn't hold puts the notice back at the top, and is never shown.
    for (const category of ["%3Cb%3Ehi", "00000000-0000-4000-8000-000000000000"]) {
      const top = await (await officer.get(`${path}?notice=saved&category=${category}`)).text();
      const status = parseHTML(top).document.querySelector("#status");
      expect({ category, card: status?.closest(".menu-category") ?? null }).toEqual({
        category,
        card: null,
      });
      expect(status?.textContent).toBe("Category saved.");
      expect(top).not.toContain("<b>hi");
      expect(top).not.toContain("00000000-0000-4000-8000-000000000000");
    }
  });

  test("a repeated move or state change is the same 303 with no write (the equal-state rule)", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const move = body({
      op: "category.move",
      revision: String(MENU_REVISION),
      category: MENU_CATEGORY.content,
      to: "0",
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await officer.post(path, move)).headers.get("location")).toBe(
        noticed("moved", MENU_CATEGORY.content),
      );
    expect(saved(w)?.menu?.categories[0]?.id).toBe(MENU_CATEGORY.content);
    expect(saved(w)?.revision).toBe(MENU_REVISION + 1n);
    // Publishing what is already published: success, nothing written, whatever the revision.
    const publish = body({
      op: "category.setState",
      revision: "1",
      category: MENU_CATEGORY.games,
      state: "published",
    });
    expect((await officer.post(path, publish)).headers.get("location")).toBe(
      noticed("published", MENU_CATEGORY.games),
    );
    expect(saved(w)?.revision).toBe(MENU_REVISION + 1n);
  });

  test("a stale form that would change something is a 409: the menu as it is now, the typed text kept", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const second = await signedIn(w, SECOND_OFFICER);
    const rename = (category: string, name: string, revision: bigint) =>
      body({
        op: "category.edit",
        revision: String(revision),
        category,
        name,
        description: "",
        max: "any",
      });
    // Another officer renames Games first.
    expect(
      (await second.post(path, rename(MENU_CATEGORY.games, "Games we play", MENU_REVISION))).status,
    ).toBe(303);
    // This officer's form was rendered before that.
    const stale = await officer.post(
      path,
      rename(MENU_CATEGORY.pronouns, "Your <pronouns>", MENU_REVISION),
    );
    expect(stale.status).toBe(409);
    const text = await stale.text();
    expect(text).toContain("<title>Error: Role menu · TaruBot</title>");
    const { document } = parseHTML(text);
    const summary = document.querySelector(".error-summary");
    expect(summary?.querySelector("a")?.textContent).toBe(SELF_ROLE_MESSAGES.changed);
    const target = summary?.querySelector("a")?.getAttribute("href") ?? "";
    expect(target).toBe(`#category-${MENU_CATEGORY.pronouns}-name`);
    // What was typed is back in the form used, escaped, inside its open disclosure, at the
    // current revision: the officer has now seen the menu as it is.
    const input = document.querySelector(target);
    expect(input?.getAttribute("value")).toBe("Your <pronouns>");
    expect(text).not.toContain("Your <pronouns>");
    expect(input?.closest("details")?.hasAttribute("open")).toBe(true);
    expect(
      input?.closest("form")?.querySelector('input[name="revision"]')?.getAttribute("value"),
    ).toBe(String(MENU_REVISION + 1n));
    // The other officer's change shows, and nothing of this one was saved.
    expect(
      document.querySelector(`#category-${MENU_CATEGORY.games}-title > span[dir="auto"]`)
        ?.textContent,
    ).toBe("Games we play");
    expect(categoryNamed(w, "Pronouns")).toBeDefined();
    expect(saved(w)?.revision).toBe(MENU_REVISION + 1n);
  });

  test("after a 409, a resubmit keeps another officer's changes in fields this officer never touched", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const second = await signedIn(w, SECOND_OFFICER);
    const pronouns = MENU_CATEGORY.pronouns;
    /** What a rendered form sends, as a browser would; post() adds the token. */
    const fieldsOf = (form: Element | null | undefined): string => {
      const params = new URLSearchParams();
      for (const control of form?.querySelectorAll("input, select") ?? []) {
        const name = control.getAttribute("name");
        if (name === null || name === FORM_TOKEN_FIELD) continue;
        params.append(
          name,
          control.tagName === "SELECT"
            ? (control.querySelector("option[selected]")?.getAttribute("value") ?? "")
            : (control.getAttribute("value") ?? ""),
        );
      }
      return params.toString();
    };
    const formWith = (document: Document, id: string) =>
      document.querySelector(`#${id}`)?.closest("form");
    // This officer's page, rendered at the starting revision.
    const stale = parseHTML(await (await officer.get(path)).text()).document;
    // The other officer then gives Pronouns a new description and stops offering He/Him.
    expect(
      (
        await second.post(
          path,
          body({
            op: "category.edit",
            revision: String(MENU_REVISION),
            category: pronouns,
            name: "Pronouns",
            description: "Pick what fits.",
            max: "any",
          }),
        )
      ).status,
    ).toBe(303);
    const rows = [MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem, MENU_ROLE.askMe];
    const askMe = "Replaced by your profile's own pronouns field.";
    expect(
      (
        await second.post(
          path,
          body({
            op: "options.edit",
            revision: String(MENU_REVISION + 1n),
            category: pronouns,
            role: rows,
            ...Object.fromEntries(
              rows.flatMap((roleId, at) => [
                [`description:${roleId}`, roleId === MENU_ROLE.askMe ? askMe : ""],
                [`position:${roleId}`, String(at + 1)],
                [
                  `state:${roleId}`,
                  roleId === MENU_ROLE.heHim || roleId === MENU_ROLE.askMe
                    ? "removal_only"
                    : "offered",
                ],
              ]),
            ),
          }),
        )
      ).status,
    ).toBe(303);
    const pronounsNow = () => saved(w)?.menu?.categories.find((c) => c.id === pronouns);
    expect(pronounsNow()?.options[0]).toEqual({
      roleId: MENU_ROLE.heHim,
      description: "",
      removalOnly: true,
    });

    const value = (form: Element | null | undefined, name: string) =>
      form?.querySelector(`[name="${name}"]`)?.getAttribute("value");
    // This officer renames Pronouns on the stale page, first leaving the name blank: the 422 keeps
    // the stale revision and what the form first showed, so the correction still meets the lock.
    const blank = formWith(stale, `category-${pronouns}-name`);
    blank?.querySelector('input[name="name"]')?.setAttribute("value", " ");
    const invalid = await officer.post(path, fieldsOf(blank));
    expect(invalid.status).toBe(422);
    const rename = formWith(parseHTML(await invalid.text()).document, `category-${pronouns}-name`);
    expect([value(rename, "revision"), value(rename, "was:description")]).toEqual([
      String(MENU_REVISION),
      "Shown on your profile, so people know how to refer to you.",
    ]);
    // The corrected rename is a 409 showing the other officer's description, not the one the
    // stale form was filled with, under the current revision.
    rename?.querySelector('input[name="name"]')?.setAttribute("value", "Your pronouns");
    const conflict = await officer.post(path, fieldsOf(rename));
    expect(conflict.status).toBe(409);
    const shown = parseHTML(await conflict.text()).document;
    const again = formWith(shown, `category-${pronouns}-name`);
    expect([value(again, "name"), value(again, "description"), value(again, "revision")]).toEqual([
      "Your pronouns",
      "Pick what fits.",
      String(MENU_REVISION + 2n),
    ]);
    // Sending it again saves the rename and keeps the other officer's description.
    expect((await officer.post(path, fieldsOf(again))).status).toBe(303);
    expect([pronounsNow()?.name, pronounsNow()?.description]).toEqual([
      "Your pronouns",
      "Pick what fits.",
    ]);

    // The stale Edit roles form changes only She/Her's description: the 409 shows He/Him as the
    // other officer left it (Not offered), and the resubmit keeps it so.
    const edit = formWith(stale, `option-${MENU_ROLE.sheHer}-description`);
    edit
      ?.querySelector(`input[name="description:${MENU_ROLE.sheHer}"]`)
      ?.setAttribute("value", "Ask me first.");
    const optionsConflict = await officer.post(path, fieldsOf(edit));
    expect(optionsConflict.status).toBe(409);
    const optionsShown = parseHTML(await optionsConflict.text()).document;
    const optionsAgain = formWith(optionsShown, `option-${MENU_ROLE.sheHer}-description`);
    expect(
      optionsAgain
        ?.querySelector(`select[name="state:${MENU_ROLE.heHim}"] option[selected]`)
        ?.getAttribute("value"),
    ).toBe("removal_only");
    expect(value(optionsAgain, `description:${MENU_ROLE.sheHer}`)).toBe("Ask me first.");
    expect((await officer.post(path, fieldsOf(optionsAgain))).status).toBe(303);
    expect(pronounsNow()?.options.slice(0, 2)).toEqual([
      { roleId: MENU_ROLE.heHim, description: "", removalOnly: true },
      { roleId: MENU_ROLE.sheHer, description: "Ask me first.", removalOnly: false },
    ]);
  });

  test("a refused input is a 422 whose summary links each field; the form keeps its own revision", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const blank = await officer.post(path, create({ name: "   ", description: "a‮b" }));
    expect(blank.status).toBe(422);
    const { document } = parseHTML(await blank.text());
    expect(document.querySelector("title")?.textContent).toBe("Error: Role menu · TaruBot");
    expect(
      [...document.querySelectorAll(".error-summary a")].map((link) => [
        link.getAttribute("href"),
        link.textContent,
      ]),
    ).toEqual([
      ["#new-category-name", "Give the category a name."],
      ["#new-category-description", "Remove hidden formatting characters."],
    ]);
    expect(document.querySelector("#new-category-name")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("#new-category-description")?.getAttribute("value")).toBe("a‮b");
    // The refused create keeps its minted ID and the revision it was sent with.
    const form = document.querySelector("#new-category-name")?.closest("form");
    expect(form?.querySelector('input[name="id"]')?.getAttribute("value")).toBe(NEW_ID);
    expect(form?.querySelector('input[name="revision"]')?.getAttribute("value")).toBe(
      String(MENU_REVISION),
    );
    // An Edit roles row's place: refused at its own field, in the reopened form.
    const options = await officer.post(
      path,
      body({
        op: "options.edit",
        revision: String(MENU_REVISION),
        category: MENU_CATEGORY.games,
        role: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
        [`description:${MENU_ROLE.valheim}`]: "Our server.",
        [`position:${MENU_ROLE.valheim}`]: "0",
        [`state:${MENU_ROLE.valheim}`]: "offered",
        [`description:${MENU_ROLE.minecraft}`]: "",
        [`position:${MENU_ROLE.minecraft}`]: "1.5",
        [`state:${MENU_ROLE.minecraft}`]: "offered",
      }),
    );
    expect(options.status).toBe(422);
    const refused = parseHTML(await options.text()).document;
    const link = refused.querySelector(".error-summary a");
    expect(link?.getAttribute("href")).toBe(`#option-${MENU_ROLE.valheim}-position`);
    // Each row's message names its role first, in the summary and beside the field, so two rows'
    // links never read alike and a phone shows the role with the error.
    expect(
      [...refused.querySelectorAll(".error-summary a")].map((item) => [
        item.getAttribute("href"),
        item.textContent,
        item.querySelector(".mention")?.textContent,
      ]),
    ).toEqual([
      [`#option-${MENU_ROLE.valheim}-position`, `@Valheim: ${LIMIT_MESSAGES.position}`, "@Valheim"],
      [
        `#option-${MENU_ROLE.minecraft}-position`,
        `@Minecraft: ${LIMIT_MESSAGES.position}`,
        "@Minecraft",
      ],
    ]);
    expect(refused.querySelector(`#option-${MENU_ROLE.valheim}-position-error`)?.textContent).toBe(
      `Error: @Valheim: ${LIMIT_MESSAGES.position}`,
    );
    const position = refused.querySelector(`#option-${MENU_ROLE.valheim}-position`);
    expect(position?.getAttribute("value")).toBe("0");
    expect(position?.closest("details")?.hasAttribute("open")).toBe(true);
    expect(
      refused.querySelector(`#option-${MENU_ROLE.valheim}-description`)?.getAttribute("value"),
    ).toBe("Our server.");
    expect(saved(w)?.revision).toBe(MENU_REVISION);
  });

  test("any officer adds roles, with no Discord Manage Roles needed", async () => {
    const w = await world();
    // The world's officers are delegated: officer access, manageRoles false.
    const officer = await signedIn(w, SECOND_OFFICER);
    const added = await officer.post(
      path,
      body({
        op: "options.add",
        revision: String(MENU_REVISION),
        category: MENU_CATEGORY.content,
        roles: [MENU_ROLE.healer, MENU_ROLE.tank],
      }),
    );
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(noticed("added", MENU_CATEGORY.content));
    expect(categoryNamed(w, "Content")?.options.map((option) => option.roleId)).toEqual([
      MENU_ROLE.savage,
      MENU_ROLE.maps,
      MENU_ROLE.mahjong,
      MENU_ROLE.healer,
      MENU_ROLE.tank,
    ]);
  });

  test("a role the rule set refuses is a 422 naming it by its cached name", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const refused = await officer.post(
      path,
      body({
        op: "options.add",
        revision: String(MENU_REVISION),
        category: MENU_CATEGORY.games,
        roles: [MENU_ROLE.moderator],
      }),
    );
    expect(refused.status).toBe(422);
    const { document } = parseHTML(await refused.text());
    const link = document.querySelector(".error-summary a");
    expect(link?.getAttribute("href")).toBe(`#category-${MENU_CATEGORY.games}-roles`);
    expect(link?.querySelector(".mention")?.textContent).toBe("@Moderator");
    expect(link?.textContent).toContain("can't be added. It has Kick Members");
    expect(saved(w)?.revision).toBe(MENU_REVISION);
  });

  test("an add without the unreadable-channel confirmation is a 422; with it, the roles are added", async () => {
    const w = await world({ menuStates: { menuProblems: true } });
    const officer = await signedIn(w);
    const add = (extra: Record<string, string>) =>
      officer.post(
        path,
        body({
          op: "options.add",
          revision: String(MENU_REVISION),
          category: MENU_CATEGORY.games,
          roles: [MENU_ROLE.healer],
          ...extra,
        }),
      );
    const unconfirmed = await add({});
    expect(unconfirmed.status).toBe(422);
    const { document } = parseHTML(await unconfirmed.text());
    const link = document.querySelector(".error-summary a");
    expect(link?.getAttribute("href")).toBe(`#category-${MENU_CATEGORY.games}-acknowledged`);
    expect(link?.textContent).toBe(SELF_ROLE_MESSAGES.acknowledge(2));
    // The confirmation covers any permission in those channels, not only opening them, in the
    // message and in the checkbox the officer ticks.
    expect(link?.textContent).toBe(
      "Confirm you've checked that these roles don't open the 2 channels TaruBot can't see or give any permission in them.",
    );
    expect(
      document.querySelector(`#category-${MENU_CATEGORY.games}-acknowledged-error`)?.textContent,
    ).toBe(`Error: ${SELF_ROLE_MESSAGES.acknowledge(2)}`);
    expect(
      document.querySelector(`label[for="category-${MENU_CATEGORY.games}-acknowledged-1"]`)
        ?.firstChild?.textContent,
    ).toBe("I've checked that these roles don't open any of them or give any permission in them");
    // The choice is kept, so only the confirmation is missing.
    expect(
      document
        .querySelector(`#category-${MENU_CATEGORY.games}-roles input[value="${MENU_ROLE.healer}"]`)
        ?.hasAttribute("checked"),
    ).toBe(true);
    const confirmed = await add({ acknowledged: "yes" });
    expect(confirmed.headers.get("location")).toBe(noticed("added", MENU_CATEGORY.games));
  });

  test("a saved menu this build can't read refuses every edit (409); any officer may reset it", async () => {
    const w = await world({ menuStates: { menuUnreadable: true } });
    const officer = await signedIn(w, SECOND_OFFICER);
    const page = parseHTML(await (await officer.get(path)).text()).document;
    // Only Reset role menu, behind its consequence.
    expect(
      [...page.querySelectorAll('main input[name="op"]')].map((op) => op.getAttribute("value")),
    ).toEqual(["menu.reset"]);
    const refused = await officer.post(path, create());
    expect(refused.status).toBe(409);
    const text = await refused.text();
    expect(text).toContain(SELF_ROLE_MESSAGES.unreadable.replace("can't", "can&#39;t"));
    expect(saved(w)?.menu).toBeNull();
    // A delegated officer, without Discord's Manage Roles, resets it.
    const reset = await officer.post(
      path,
      body({ op: "menu.reset", revision: String(MENU_REVISION) }),
    );
    expect(reset.headers.get("location")).toBe(noticed("reset"));
    expect(saved(w)?.menu).toEqual({ v: 1, categories: [] });
    const after = await (await officer.get(noticed("reset"))).text();
    expect(after).toContain("Role menu reset. Every category was removed.");
    expect(after).toContain('<div class="empty-state">');
  });

  test("a form whose hidden fields the page never rendered is refused whole, before the menu is read", async () => {
    const w = await world();
    const officer = await signedIn(w);
    for (const fields of [
      { op: "category.rename", revision: "7" },
      { op: "menu.publishAll", revision: "07" },
      { op: "menu.publishAll", revision: "" },
      { op: "category.delete", revision: "7", category: "not-a-uuid" },
      { op: "category.move", revision: "7", category: MENU_CATEGORY.games, to: "-1" },
      { op: "category.setState", revision: "7", category: MENU_CATEGORY.games, state: "hidden" },
      { op: "category.create", revision: "7", id: "1", name: "x" },
      {
        op: "options.edit",
        revision: "7",
        category: MENU_CATEGORY.games,
        role: MENU_ROLE.valheim,
        [`state:${MENU_ROLE.valheim}`]: "gone",
      },
    ]) {
      const response = await officer.post(path, body(fields));
      expect({ fields, status: response.status }).toEqual({ fields, status: 400 });
      const text = await response.text();
      expect(text).toContain(LIMIT_MESSAGES.form);
      // Open the page again, which a link offers; reloading would send this form again.
      expect(LIMIT_MESSAGES.form).toBe(
        "This form is out of date. Open the page again, then redo your change.",
      );
      expect(text).toContain(`href="${path}">Back to Role menu</a>`);
    }
    expect(w.menus.has(GUILD)).toBe(false);
  });

  test("shutdown and the page's budget of 120 each answer 429 before the menu is touched", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const publish = body({ op: "menu.publishAll", revision: String(MENU_REVISION) });
    w.stopping.now = true;
    const stopping = await officer.post(path, publish);
    expect(stopping.status).toBe(429);
    expect(stopping.headers.get("retry-after")).toBe("30");
    expect(w.menus.has(GUILD)).toBe(false);
    w.stopping.now = false;
    // A move to where Pronouns already is: unchanged, so every POST is a 303 and writes nothing.
    const still = body({
      op: "category.move",
      revision: String(MENU_REVISION),
      category: MENU_CATEGORY.pronouns,
      to: "0",
    });
    for (let attempt = 0; attempt < 120; attempt++)
      expect((await officer.post(path, still)).status).toBe(303);
    const over = await officer.post(path, publish);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("600");
    expect(saved(w)?.revision).toBe(MENU_REVISION);
    expect(saved(w)?.menu?.categories.some((category) => category.state === "draft")).toBe(true);
  });
});

describe("server pages (D12)", () => {
  const status = `/g/${GUILD}/status`;

  /** Every discovered page's route pattern, so a new page gets the routing checks below. */
  const discovered = async (): Promise<string[]> => {
    const paths = [...(await loadPages()).keys()];
    expect(paths).toContain("/g/:guild/status");
    return paths;
  };

  test("signed out: 303 to sign-in with the return path, for any well-formed server", async () => {
    const w = await world();
    const visitor = new Browser(w);
    for (const path of await discovered())
      for (const guild of [GUILD, UNSERVED, ABSENT]) {
        const target = path.replace(":guild", guild);
        const response = await visitor.get(target);
        expect({ target, status: response.status }).toEqual({ target, status: 303 });
        expect(response.headers.get("location")).toBe(`/login?to=${encodeURIComponent(target)}`);
      }
    expect(w.resolutions).toEqual([]);
  });

  test("a malformed, absent or unserved server is 404 with no resolver call", async () => {
    const w = await world();
    const officer = await signedIn(w);
    w.resolutions.length = 0;
    for (const path of await discovered())
      for (const guild of ["abc", "0", "01", "18446744073709551616", ABSENT, UNSERVED]) {
        const target = path.replace(":guild", guild);
        expect({ target, status: (await officer.get(target)).status }).toEqual({
          target,
          status: 404,
        });
      }
    expect(w.resolutions).toEqual([]);
  });

  test("a non-member is 404 and a member without the flag 403, after one resolution", async () => {
    const w = await world();
    // Neither can sign in (no server admits them), so their sessions are made directly.
    for (const [userId, expected] of [
      [OUTSIDER, 404],
      [MEMBER, 403],
    ] as const) {
      const { token } = await w.sessions.create(userId);
      w.resolutions.length = 0;
      const response = await w.app.request(new URL(status, DEV).href, {
        headers: { cookie: `tarubot=${token}` },
      });
      expect({ userId, status: response.status }).toEqual({ userId, status: expected });
      expect(w.resolutions).toEqual([[GUILD, userId]]);
    }
  });

  test("an officer sees the page in the layout, with the server name escaped", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const response = await officer.get(status);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('<span dir="auto">&lt;img src=x onerror=alert(1)&gt; FC</span>');
    expect(text).not.toContain("<img src=x");
    expect(text).toContain(`href="${status}" aria-current="page"`);
    expect(text).toContain(`href="/g/${GUILD}/form"`);
    // HEAD answers like GET, without the body.
    const head = await officer.request(status, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("/ lists the servers where a page admits the user, linking only admitted pages", async () => {
    const w = await world();
    const officer = await signedIn(w);
    const text = await (await officer.get("/")).text();
    expect(text).toContain(`href="/g/${GUILD}/status"`);
    expect(text).not.toContain("Unserved FC");
    expect(text).toContain("Sign out everywhere");
    const visitor = await (await new Browser(w).get("/")).text();
    // The page's one primary button, a link with its decorative icon (form-action would block a
    // form's redirect to Discord).
    expect(visitor).toContain(
      `<a class="orr-btn orr-btn--primary orr-btn--lg orr-btn--block" href="/login">${String(icon("log-in"))}Sign in with Discord</a>`,
    );
    expect(visitor).not.toContain("Sign out");
  });

  test("/ reuses the actor memo for 60 seconds, like any GET", async () => {
    const w = await world();
    const officer = await signedIn(w);
    w.resolutions.length = 0;
    await officer.get("/");
    await officer.get("/");
    expect(w.resolutions).toEqual([]);
    w.clock.now += 61_000;
    await officer.get("/");
    expect(w.resolutions).toEqual([[GUILD, OFFICER]]);
  });
});

describe("sign-in", () => {
  test("sets the login cookie, then a fresh session for an admitted user, and returns", async () => {
    for (const origin of [DEV, HTTPS]) {
      const w = await world({ origin });
      const browser = new Browser(w);
      const login = await browser.get(`/login?to=${encodeURIComponent(`/g/${GUILD}/status`)}`);
      expect(login.status).toBe(302);
      expect(login.headers.get("cache-control")).toBe("no-store");
      const authorize = new URL(login.headers.get("location") ?? "");
      expect(`${authorize.origin}${authorize.pathname}`).toBe(
        "https://discord.com/oauth2/authorize",
      );
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
      expect(authorize.searchParams.get("scope")).toBe("identify");
      // Returning users skip Discord's authorization screen (#43, 2026-10-05).
      expect(authorize.searchParams.get("prompt")).toBe("none");
      const [handshake = ""] = login.headers.getSetCookie();
      expect(handshake.startsWith(`${loginCookie(w)}=`)).toBe(true);
      expect(handshake).toContain("Max-Age=600");
      expect(handshake).toContain("HttpOnly");
      expect(handshake).toContain("SameSite=Lax");
      expect(handshake).toContain("Path=/");
      expect(handshake).not.toContain("Domain");
      expect(handshake.includes("Secure")).toBe(w.settings.secure);
      const callback = w.discord.authorize(authorize, { id: OFFICER });
      const done = await browser.get(`${callback.pathname}${callback.search}`);
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe(`/g/${GUILD}/status`);
      const cookies = done.headers.getSetCookie();
      // The handshake is cleared, and the session cookie set with the absolute lifetime.
      expect(cookies.some((cookie) => cookie.startsWith(`${loginCookie(w)}=;`))).toBe(true);
      const session = cookies.find((cookie) => cookie.startsWith(`${sessionCookie(w)}=`)) ?? "";
      expect(session).toContain(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`);
      expect(session).toContain("HttpOnly");
      expect(session).toContain("SameSite=Lax");
      expect(session.includes("Secure")).toBe(w.settings.secure);
      // Only the hash is stored.
      const token = browser.jar.get(sessionCookie(w)) ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const rows = w.sessions.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session.userId).toBe(OFFICER);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect((await browser.get(`/g/${GUILD}/status`)).status).toBe(200);
      // The access token went no further than the one /users/@me call.
      expect(JSON.stringify(w.logs())).not.toContain(w.discord.issuedTokens[0] ?? "-");
    }
  });

  test("sign-in admission resolves afresh even while a GET memo is warm", async () => {
    const w = await world();
    const first = await signedIn(w);
    expect((await first.get(`/g/${GUILD}/status`)).status).toBe(200);
    w.resolutions.length = 0;
    await signedIn(w);
    expect(w.resolutions).toEqual([[GUILD, OFFICER]]);
  });

  test("a user no server admits gets no access and no session cookie", async () => {
    const w = await world();
    // From 2.40.0 a member is admitted (their own pages); a lobby newcomer holding neither access
    // role and someone not in the server are not.
    for (const userId of [LOBBY, OUTSIDER]) {
      const browser = new Browser(w);
      const response = await browser.signIn({ id: userId });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("TaruBot didn't keep a session for you");
      expect(response.headers.getSetCookie().some((c) => c.startsWith("tarubot="))).toBe(false);
      expect(browser.jar.has("tarubot")).toBe(false);
    }
    expect(w.sessions.rows()).toEqual([]);
  });

  test("a bot account is refused before admission", async () => {
    const w = await world();
    const response = await new Browser(w).signIn({ id: OFFICER, bot: true });
    expect(response.status).toBe(403);
    expect(w.resolutions).toEqual([]);
    expect(w.sessions.rows()).toEqual([]);
  });

  test("a callback without its login cookie costs Discord nothing", async () => {
    const w = await world();
    const browser = new Browser(w);
    const login = await browser.get("/login");
    const callback = w.discord.authorize(new URL(login.headers.get("location") ?? ""), {
      id: OFFICER,
    });
    browser.jar.clear();
    const response = await browser.get(`${callback.pathname}${callback.search}`);
    expect(response.status).toBe(409);
    // The handshake is single-use: a refusal clears it too.
    expect(clearsLogin(w, response)).toBe(true);
    expect(w.discord.requests).toEqual([]);
    // A cancelled sign-in too.
    const again = await browser.get("/login");
    const cancelled = w.discord.cancel(new URL(again.headers.get("location") ?? ""));
    const refused = await browser.get(`${cancelled.pathname}${cancelled.search}`);
    expect(refused.status).toBe(409);
    expect(clearsLogin(w, refused)).toBe(true);
    expect(w.discord.requests).toEqual([]);
    expect(w.sessions.rows()).toEqual([]);
  });

  test("Discord's 429 is a 503 with Retry-After and invalid_grant a friendly 409, with no session", async () => {
    const w = await world();
    const browser = new Browser(w);
    w.discord.tokenAnswer = () =>
      Response.json({ message: "rl" }, { status: 429, headers: { "retry-after": "7" } });
    const limited = await browser.signIn({ id: OFFICER });
    expect(limited.status).toBe(503);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(clearsLogin(w, limited)).toBe(true);
    expect(limited.headers.getSetCookie().some((c) => c.startsWith(`${sessionCookie(w)}=`))).toBe(
      false,
    );
    expect(w.reports.map((report) => report.options)).toEqual([
      { scope: "web:/auth/callback", level: "warn" },
    ]);
    // D16's pause: until Discord's Retry-After has passed, every sign-in is refused here, with
    // what is left of it, and Discord isn't asked again.
    const asked = w.discord.requests.length;
    w.clock.now += 3_000;
    const paused = await new Browser(w).signIn({ id: MEMBER });
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("4");
    expect(await paused.text()).toContain(
      "Lots of people are signing in right now, so TaruBot didn&#39;t sign you in.",
    );
    expect(w.discord.requests).toHaveLength(asked);
    w.clock.now += 4_000;
    w.discord.tokenAnswer = () =>
      discordOAuthError(400, "invalid_grant", 'Invalid "code" in request.');
    const expired = await browser.signIn({ id: OFFICER });
    expect(expired.status).toBe(409);
    expect(await expired.text()).toContain(
      "That sign-in code expired or was already used. Sign in again.",
    );
    expect(clearsLogin(w, expired)).toBe(true);
    expect(w.sessions.rows()).toEqual([]);
    expect(w.resolutions).toEqual([]);
  });

  test("a sign-in replaces the session the browser presented (rotation)", async () => {
    const w = await world();
    const browser = await signedIn(w);
    const first = browser.jar.get("tarubot");
    const [before] = w.sessions.rows();
    await browser.signIn({ id: OFFICER });
    const second = browser.jar.get("tarubot");
    expect(second).not.toBe(first);
    const rows = w.sessions.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(before?.tokenHash);
    // A refused sign-in in a signed-in browser ends that session too.
    await browser.signIn({ id: LOBBY });
    expect(w.sessions.rows()).toEqual([]);
    expect(browser.jar.has("tarubot")).toBe(false);
  });

  test("an unsafe return path becomes /", async () => {
    const w = await world();
    for (const to of [
      "//evil.example/",
      "/\\evil.example",
      "https://evil.example/",
      "/%2F%2Fevil",
    ]) {
      const response = await new Browser(w).signIn({ id: OFFICER }, to);
      expect({ to, location: response.headers.get("location") }).toEqual({ to, location: "/" });
    }
  });
});

describe("members and guests (2.40.0)", () => {
  const picks = `/g/${GUILD}/picks`;

  test("a member, a guest and a timed-out member sign in and open only the pages their flag opens", async () => {
    const w = await world();
    for (const userId of [MEMBER, GUEST, TIMED_OUT]) {
      const browser = await signedIn(w, userId);
      const page = await browser.get(picks);
      expect({ userId, status: page.status }).toEqual({ userId, status: 200 });
      // A time-out doesn't close the page; it is the page's (and the application's) to refuse
      // saves.
      expect(await page.text()).toContain(
        userId === TIMED_OUT ? "Picks for a timed-out viewer" : "Picks for you",
      );
      for (const officerOnly of [`/g/${GUILD}/status`, `/g/${GUILD}/form`])
        expect({ userId, officerOnly, status: (await browser.get(officerOnly)).status }).toEqual({
          userId,
          officerOnly,
          status: 403,
        });
      const post = await browser.post(`/g/${GUILD}/form`, "name=Moogle");
      expect({ userId, post: post.status }).toEqual({ userId, post: 403 });
    }
    expect(w.posts).toEqual([]);
  });

  test("a member's side navigation lists only their pages, with the members' note", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    const document = parseHTML(await (await member.get(picks)).text()).document;
    const nav = [...document.querySelectorAll(".side-nav a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(nav).toContain(picks);
    expect(nav).not.toContain(`/g/${GUILD}/status`);
    expect(nav).not.toContain(`/g/${GUILD}/form`);
    expect(document.querySelector(".side-nav__note")?.textContent).toBe(
      "Pick your roles here. Everything else is in Discord.",
    );
    const officer = await signedIn(w);
    const officerView = parseHTML(await (await officer.get(picks)).text()).document;
    expect(officerView.querySelector(".side-nav__note")?.textContent).toBe(
      "Most settings are changed in Discord; the role menu is set here.",
    );
  });

  test("while TaruBot holds Administrator, members and guests are refused and officers aren't (A2)", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    w.botAdministrator.now = true;
    // A member already signed in loses the page once the memo's minute is over.
    expect((await member.get(picks)).status).toBe(200);
    w.clock.now += 61_000;
    expect((await member.get(picks)).status).toBe(403);
    for (const userId of [MEMBER, GUEST, TIMED_OUT]) {
      const browser = new Browser(w);
      const response = await browser.signIn({ id: userId });
      expect({ userId, status: response.status }).toEqual({ userId, status: 403 });
      expect(browser.jar.has("tarubot")).toBe(false);
      // The no-access page doesn't only say Member or Guest can sign in: it says why someone with
      // one may be refused, without naming the server or the permission.
      const text = await response.text();
      expect(text).toContain(
        "While officers sort out TaruBot&#39;s permissions in a server, only officers can sign in there.",
      );
      expect(text).not.toContain("Administrator");
    }
    // Officers already run under W1's accepted risk, so A2 doesn't refuse them.
    const officer = await signedIn(w);
    expect((await officer.get(picks)).status).toBe(200);
    expect((await officer.get(`/g/${GUILD}/status`)).status).toBe(200);
  });

  test("sign-in and GETs resolve light, one member fetch; every POST resolves full", async () => {
    const w = await world();
    const officer = await signedIn(w);
    // Admission: one light resolution for the one served server.
    expect(w.modes).toEqual(["light"]);
    await officer.get(`/g/${GUILD}/status`);
    expect(w.modes).toEqual(["light"]);
    w.clock.now += 61_000;
    await officer.get(`/g/${GUILD}/status`);
    expect(w.modes).toEqual(["light", "light"]);
    expect((await officer.post(`/g/${GUILD}/form`, "name=Moogle")).status).toBe(303);
    expect(w.modes).toEqual(["light", "light", "full"]);
  });

  test("/ goes straight to someone's only page in their only server; anyone with more gets the list", async () => {
    const w = await world({ fixturesOnly: true });
    const member = new Browser(w);
    // Sign-in returns to / by default, which then lands a member on their page.
    const done = await member.signIn({ id: MEMBER });
    expect(done.headers.get("location")).toBe("/");
    const home = await member.get("/");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe(picks);
    expect(home.headers.get("cache-control")).toBe("no-store");
    // The shell's "Switch server" asks for the list itself, so it never reloads that one page.
    const page = await member.get(picks);
    const switcher = parseHTML(await page.text()).document.querySelector(".server-switch");
    expect(switcher?.getAttribute("href")).toBe("/?servers");
    const asked = await member.get("/?servers");
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain(`href="${picks}"`);
    // An officer has Form and Picks there: the list.
    const officer = await signedIn(w);
    const list = await officer.get("/");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain(`href="${picks}"`);
    expect(text).toContain(`href="/g/${GUILD}/form"`);
    // A visitor still gets the sign-in page.
    expect((await new Browser(w).get("/")).status).toBe(200);
  });
});

describe("My roles (2.40.0)", () => {
  const myRoles = `/g/${GUILD}/my-roles`;
  const pronouns = MENU_CATEGORY.pronouns;
  const games = MENU_CATEGORY.games;

  /**
   * The My roles form as a browser would send it (without the token, which Browser.post adds):
   * every hidden field, then each enabled input that is checked after ticking `tick` and unticking
   * `untick`. Ticking a radio unticks the others in its group.
   */
  function body(
    document: Document,
    change: { tick?: readonly string[]; untick?: readonly string[] } = {},
  ): string {
    const tick = new Set(change.tick ?? []);
    const untick = new Set(change.untick ?? []);
    const form = document.querySelector("form.my-roles-form");
    if (!form) throw new Error("No My roles form on the page");
    const inputs = [...form.querySelectorAll("input")];
    const radioGroups = new Set(
      inputs
        .filter((input) => input.getAttribute("type") === "radio")
        .filter((input) => tick.has(input.getAttribute("value") ?? ""))
        .map((input) => input.getAttribute("name")),
    );
    const params = new URLSearchParams();
    for (const input of inputs) {
      const name = input.getAttribute("name") ?? "";
      const value = input.getAttribute("value") ?? "";
      const type = input.getAttribute("type");
      if (name === FORM_TOKEN_FIELD) continue;
      if (type === "hidden") params.append(name, value);
      else if (!input.hasAttribute("disabled")) {
        let checked = input.hasAttribute("checked");
        if (type === "radio" && radioGroups.has(name)) checked = tick.has(value);
        else if (tick.has(value)) checked = true;
        if (untick.has(value)) checked = false;
        if (checked) params.append(name, value);
      }
    }
    return params.toString();
  }

  /** The page as `browser` sees it now. */
  const read = async (browser: Browser, path = myRoles) => {
    const response = await browser.get(path);
    expect(response.status).toBe(200);
    return parseHTML(await response.text()).document;
  };
  const banners = (document: Document) =>
    [...document.querySelectorAll("#status .notice")].map((banner) => banner.textContent);
  const ticked = (document: Document, categoryId: string) =>
    [...document.querySelectorAll(`fieldset#category-${categoryId} input[checked]`)].map((input) =>
      input.getAttribute("value"),
    );

  test("members, guests, timed-out members and officers open it; officers keep their pages", async () => {
    const w = await world();
    for (const userId of [MEMBER, GUEST, TIMED_OUT, OFFICER]) {
      const browser = await signedIn(w, userId);
      const document = await read(browser);
      expect({ userId, h1: document.querySelector("h1")?.textContent }).toEqual({
        userId,
        h1: "My roles",
      });
      const nav = [...document.querySelectorAll(".side-nav a")].map((a) => a.textContent);
      expect({ userId, mine: nav.includes("My roles") }).toEqual({ userId, mine: true });
      expect({ userId, officerPages: nav.includes("Background work") }).toEqual({
        userId,
        officerPages: userId === OFFICER,
      });
    }
    // A member once TaruBot holds Administrator (A2): refused after the memo's minute.
    const member = await signedIn(w, MEMBER);
    w.botAdministrator.now = true;
    w.clock.now += 61_000;
    expect((await member.get(myRoles)).status).toBe(403);
  });

  test("a page a member can't use says so on a GET, never that the request was forged", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    for (const path of [`/g/${GUILD}/status`, `/g/${GUILD}/role-menu`]) {
      const response = await member.get(path);
      const document = parseHTML(await response.text()).document;
      expect({
        path,
        status: response.status,
        heading: document.querySelector("h1")?.textContent,
        message: document.querySelector("main p")?.textContent,
      }).toEqual({
        path,
        status: 403,
        heading: "Not allowed",
        message: "This page isn't open to you in this server.",
      });
      expect(document.querySelector("main")?.textContent).not.toContain("come from");
    }
    // A POST refused for access keeps the status's own sentence, which covers a forged form too.
    const posted = await member.post(`/g/${GUILD}/role-menu`, "op=category.create");
    expect(posted.status).toBe(403);
    expect(parseHTML(await posted.text()).document.querySelector("main p")?.textContent).toBe(
      "You don't have access to this, or the request didn't come from TaruBot's own pages.",
    );
  });

  test("a save: 303 to the status banner, the waiting change shows, then the job's result", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    const before = await read(member);
    expect(banners(before)).toEqual([]);
    expect(ticked(before, games)).toEqual([MENU_ROLE.valheim]);
    const modes = w.modes.length;
    const saved = await member.post(
      myRoles,
      body(before, { tick: [MENU_ROLE.minecraft], untick: [MENU_ROLE.valheim] }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`${myRoles}#status`);
    // A POST resolves the actor fully, as every write does.
    expect(w.modes.slice(modes)).toEqual(["full"]);
    const waiting = await read(member);
    expect(banners(waiting)).toEqual([
      "Saved. TaruBot is updating your roles in Discord. This usually takes under a minute; reload to check.",
    ]);
    expect(ticked(waiting, games)).toEqual([MENU_ROLE.minecraft]);
    // Only the category the member changed is in the change; Pronouns is left alone.
    expect(w.people.jobs.get(`${GUILD}:${MEMBER}`)?.payload).toMatchObject({
      chosen: [MENU_ROLE.minecraft],
      offered: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
    });
    // The fake worker applies it, as the roles.self job would; the payload goes with it.
    w.clock.now += HARNESS_APPLY_MS;
    const applied = await read(member);
    expect(banners(applied)).toEqual(["Your roles were updated in Discord."]);
    expect(ticked(applied, games)).toEqual([MENU_ROLE.minecraft]);
    expect(w.people.jobs.get(`${GUILD}:${MEMBER}`)?.payload).toBeNull();
    // Ten minutes on, it's no news.
    w.clock.now += 10 * 60_000;
    expect(banners(await read(member))).toEqual([]);
  });

  test("a double submit lands on the same 303; a form sent back as shown is 'nothing to save'", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    const page = await read(member);
    const change = body(page, { untick: [MENU_ROLE.sheHer] });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await member.post(myRoles, change);
      expect({
        attempt,
        status: response.status,
        location: response.headers.get("location"),
      }).toEqual({
        attempt,
        status: 303,
        location: `${myRoles}#status`,
      });
    }
    expect(w.people.jobs.size).toBe(1);
    const unchanged = await member.post(myRoles, body(page));
    expect(unchanged.status).toBe(303);
    expect(unchanged.headers.get("location")).toBe(`${myRoles}?notice=unchanged#status`);
    // The first change still waits, so its roles aren't the member's yet: the notice says only
    // that nothing new was saved, beside the waiting change's banner.
    expect(banners(await read(member, `${myRoles}?notice=unchanged`))).toEqual([
      "Nothing new to save.",
      "Saved. TaruBot is updating your roles in Discord. This usually takes under a minute; reload to check.",
    ]);
    // Applied, the form shows the roles held, and sending it back as shown is nothing to save.
    w.clock.now += HARNESS_APPLY_MS;
    const now = await read(member);
    expect((await member.post(myRoles, body(now))).headers.get("location")).toBe(
      `${myRoles}?notice=unchanged#status`,
    );
    expect(banners(await read(member, `${myRoles}?notice=unchanged`))).toEqual([
      "Nothing to save. Those are already your roles.",
      "Your roles were updated in Discord.",
    ]);
    expect(w.people.jobs.size).toBe(1);
  });

  test("while Discord changes are paused the form is disabled, and a save is refused with 503", async () => {
    const w = await world({ menuStates: { activation: true } });
    const member = await signedIn(w, MEMBER);
    const page = await read(member);
    expect(page.querySelectorAll("main form, main button")).toHaveLength(0);
    expect(page.querySelectorAll("main fieldset input:not([disabled])")).toHaveLength(0);
    const refused = await member.post(
      myRoles,
      `shown=${pronouns}&seen%3A${pronouns}=${MENU_ROLE.sheHer}`,
    );
    expect(refused.status).toBe(503);
    const text = await refused.text();
    expect(text).toContain(CHOICE_MESSAGES.paused);
    expect(text).toContain(`href="${myRoles}"`);
    expect(w.people.jobs.size).toBe(0);
  });

  test("a member in a time-out sees the form disabled, and a save is refused with 403", async () => {
    const w = await world();
    const timedOut = await signedIn(w, TIMED_OUT);
    const page = await read(timedOut);
    expect(page.querySelectorAll("main form, main button")).toHaveLength(0);
    expect(
      [...page.querySelectorAll(".my-roles-callouts .notice")].map((note) => note.textContent),
    ).toEqual([CHOICE_MESSAGES.timedOut]);
    const refused = await timedOut.post(
      myRoles,
      `shown=${pronouns}&seen%3A${pronouns}=${MENU_ROLE.sheHer}`,
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(CHOICE_MESSAGES.timedOut);
    expect(w.people.jobs.size).toBe(0);
  });

  test("too many picked: 422 with what was picked kept; a role not on offer: 409 as it is now", async () => {
    const w = await world();
    w.menus.set(GUILD, {
      menu: {
        ...HARNESS_MENU,
        categories: HARNESS_MENU.categories.map((category) =>
          category.id === pronouns ? { ...category, max: 2 } : category,
        ),
      },
      revision: MENU_REVISION,
    });
    const member = await signedIn(w, MEMBER);
    const page = await read(member);
    const tooMany = await member.post(
      myRoles,
      body(page, { tick: [MENU_ROLE.heHim, MENU_ROLE.theyThem], untick: [MENU_ROLE.askMe] }),
    );
    expect(tooMany.status).toBe(422);
    const invalid = parseHTML(await tooMany.text()).document;
    expect(invalid.title).toBe("Error: My roles · TaruBot");
    // The summary names the category; its card says "here".
    expect([...invalid.querySelectorAll(".error-summary a")].map((a) => a.textContent)).toEqual([
      "Pronouns: pick at most 2 roles.",
    ]);
    expect(invalid.getElementById(`category-${pronouns}-error`)?.textContent).toBe(
      "Error: Pick at most 2 roles here.",
    );
    expect(ticked(invalid, pronouns)).toEqual([
      MENU_ROLE.heHim,
      MENU_ROLE.sheHer,
      MENU_ROLE.theyThem,
    ]);
    // A role the menu doesn't offer here (officers changed it, or a tampered form).
    const conflict = await member.post(
      myRoles,
      `${body(page)}&c-${pronouns}=${MENU_ROLE.moderator}`,
    );
    expect(conflict.status).toBe(409);
    const current = parseHTML(await conflict.text()).document;
    expect(current.querySelector(".error-summary a")?.textContent).toBe(CHOICE_MESSAGES.conflict);
    expect(ticked(current, pronouns)).toEqual([MENU_ROLE.sheHer, MENU_ROLE.askMe]);
    expect(w.people.jobs.size).toBe(0);
  });

  test("a form the page never made is refused whole, before anything is read", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    for (const form of [
      "shown=not-a-category",
      `shown=${pronouns}&c-${pronouns}=not-a-role`,
      `shown=${pronouns}&seen%3A${pronouns}=%3Cb%3E`,
      [...Array(11)].map((_, at) => `shown=00000000-0000-4000-8000-0000000000${10 + at}`).join("&"),
      `shown=${pronouns}&${[...Array(27)].map(() => `c-${pronouns}=${MENU_ROLE.heHim}`).join("&")}`,
    ]) {
      const response = await member.post(myRoles, form);
      expect({ form, status: response.status }).toEqual({ form, status: 400 });
      const text = await response.text();
      expect(text).toContain(LIMIT_MESSAGES.form);
      // Nothing submitted comes back.
      expect(text).not.toContain("not-a-");
      expect(text).not.toContain("&lt;b&gt;");
    }
    expect(w.people.jobs.size).toBe(0);
  });

  test("ten saves in ten minutes per person and server, then 429 with Retry-After", async () => {
    const w = await world();
    const member = await signedIn(w, MEMBER);
    const page = await read(member);
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await member.post(myRoles, body(page))).status).toBe(303);
    const over = await member.post(myRoles, body(page));
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another person's budget is their own.
    const guest = await signedIn(w, GUEST);
    expect((await guest.post(myRoles, body(await read(guest)))).status).toBe(303);
  });
});

describe("sign-in limits (2.40.0)", () => {
  /** Whether a response set a session cookie. */
  const setsSession = (w: World, response: Response): boolean =>
    response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${sessionCookie(w)}=`));

  test("ten sign-ins per user in ten minutes; the next is a 429 with Retry-After and no session", async () => {
    const w = await world();
    const first = await signedIn(w);
    for (let index = 1; index < SIGN_IN_LIMIT; index++) {
      w.clock.now += 1;
      expect((await new Browser(w).signIn({ id: OFFICER })).status).toBe(303);
    }
    const before = w.sessions.rows().length;
    w.resolutions.length = 0;
    const refused = await first.signIn({ id: OFFICER });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBe(SIGN_IN_WINDOW_MS / 1000);
    expect(await refused.text()).toContain(
      "That&#39;s a lot of sign-ins in a short time, so TaruBot didn&#39;t sign you in.",
    );
    // Counted before admission, which costs a Discord request per server: a refused sign-in
    // resolves nobody anywhere.
    expect(w.resolutions).toEqual([]);
    expect(setsSession(w, refused)).toBe(false);
    expect(clearsLogin(w, refused)).toBe(true);
    // Nothing was created or ended: the browser stays signed in as it was.
    expect(w.sessions.rows()).toHaveLength(before);
    expect((await first.get(`/g/${GUILD}/status`)).status).toBe(200);
    // Counted per Discord user: another officer still signs in.
    expect((await new Browser(w).signIn({ id: SECOND_OFFICER })).status).toBe(303);
    w.clock.now += SIGN_IN_WINDOW_MS;
    expect((await new Browser(w).signIn({ id: OFFICER })).status).toBe(303);
  });

  test("a user keeps at most ten sessions: a sign-in beyond them ends the oldest", async () => {
    const w = await world();
    const browsers: Browser[] = [];
    for (let index = 0; index < SIGN_IN_LIMIT; index++) {
      w.clock.now += 1_000;
      browsers.push(await signedIn(w));
    }
    w.clock.now += SIGN_IN_WINDOW_MS;
    const newest = await signedIn(w);
    const mine = w.sessions.rows().filter((row) => row.session.userId === OFFICER);
    expect(mine).toHaveLength(10);
    const [oldest, next] = browsers;
    expect((await oldest?.get(`/g/${GUILD}/status`))?.status).toBe(303);
    expect((await next?.get(`/g/${GUILD}/status`))?.status).toBe(200);
    expect((await newest.get(`/g/${GUILD}/status`)).status).toBe(200);
  });

  test("thirty token exchanges a minute across every user; the next is a 503 without asking Discord", async () => {
    const w = await world();
    for (const userId of [OFFICER, SECOND_OFFICER, MEMBER])
      for (let index = 0; index < EXCHANGE_LIMIT / 3; index++)
        expect((await new Browser(w).signIn({ id: userId })).status).toBe(303);
    const asked = w.discord.requests.length;
    w.clock.now += 20_000;
    const refused = await new Browser(w).signIn({ id: GUEST });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("40");
    expect(setsSession(w, refused)).toBe(false);
    expect(w.discord.requests).toHaveLength(asked);
    // A refusal before the exchange costs no admission either.
    expect(w.resolutions.filter(([, user]) => user === GUEST)).toEqual([]);
    w.clock.now += 40_000;
    expect((await new Browser(w).signIn({ id: GUEST })).status).toBe(303);
  });

  test("four token exchanges at once; a fifth is a 503 without asking Discord", async () => {
    const w = await world();
    const accounts = [OFFICER, SECOND_OFFICER, MEMBER, GUEST];
    const started = await Promise.all(
      accounts.map(async (id) => {
        const browser = new Browser(w);
        return { browser, callback: await browser.authorize({ id }) };
      }),
    );
    let release = () => {};
    w.discordHold.until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = started.map(({ browser, callback }) => browser.get(callback));
    for (let tick = 0; w.discordHold.waiting < accounts.length && tick < 500; tick++)
      await Bun.sleep(1);
    expect(w.discordHold.waiting).toBe(accounts.length);
    const refused = await new Browser(w).signIn({ id: TIMED_OUT });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe(String(EXCHANGE_BUSY_SECONDS));
    expect(w.discordHold.waiting).toBe(accounts.length);
    w.discordHold.until = null;
    release();
    expect((await Promise.all(running)).map((response) => response.status)).toEqual([
      303, 303, 303, 303,
    ]);
    // The places are free again.
    expect((await new Browser(w).signIn({ id: TIMED_OUT })).status).toBe(303);
  });
});

describe("sign-out", () => {
  test("POST /logout ends this browser's session and clears the cookie", async () => {
    const w = await world();
    const browser = await signedIn(w);
    const other = await signedIn(w);
    const response = await browser.post("/logout");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(browser.jar.has("tarubot")).toBe(false);
    expect(w.sessions.rows()).toHaveLength(1);
    expect((await other.get(`/g/${GUILD}/status`)).status).toBe(200);
  });

  test("POST /logout/all ends every session of the user, and no one else's", async () => {
    const w = await world();
    const phone = await signedIn(w);
    const laptop = await signedIn(w);
    const { token } = await w.sessions.create(MEMBER);
    const response = await phone.post("/logout/all");
    expect(response.status).toBe(303);
    expect(w.sessions.rows().map((row) => row.session.userId)).toEqual([MEMBER]);
    const stale = await laptop.get(`/g/${GUILD}/status`);
    expect(stale.status).toBe(303);
    expect(await w.sessions.get(token)).not.toBeNull();
  });

  test("a cross-site sign-out is refused and the session stays", async () => {
    const w = await world();
    const browser = await signedIn(w);
    for (const path of ["/logout", "/logout/all"]) {
      const response = await browser.post(path, "", { "Sec-Fetch-Site": "cross-site" });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
      expect(w.sessions.rows()).toHaveLength(1);
    }
  });

  test("signing out signed out is harmless", async () => {
    const w = await world();
    const response = await new Browser(w).post("/logout/all");
    expect(response.status).toBe(303);
    // Without a session there is nothing to protect: a stale form still clears the cookie.
    const stale = new Browser(w);
    stale.jar.set("tarubot", "x".repeat(43));
    const cleared = await stale.post("/logout", "", {}, formToken("y".repeat(43)));
    expect(cleared.status).toBe(303);
    expect(stale.jar.has("tarubot")).toBe(false);
  });

  test("signed in, both sign-outs need the session's form token, and a refusal ends nothing", async () => {
    const w = await world();
    const browser = await signedIn(w);
    const other = await signedIn(w);
    const page = await (await browser.get(`/g/${GUILD}/status`)).text();
    // Both forms in the account menu carry this session's token, the one the server derives.
    const tokens = [...page.matchAll(TOKEN_INPUT)].map((match) => match[1] ?? "");
    const derived = browser.formToken ?? "";
    expect(tokens).toEqual([derived, derived]);
    for (const path of ["/logout", "/logout/all"])
      for (const token of [null, "", other.formToken, `${browser.formToken}x`]) {
        const response = await browser.post(path, "", {}, token);
        expect({ path, token, status: response.status }).toEqual({ path, token, status: 403 });
        const text = await response.text();
        // Nothing ended, and the page says so: never "redo your change" (UX-2).
        expect(text).not.toContain("redo your change");
        // Sign-out has no page of its own to go back to: only the start page.
        const { document } = parseHTML(text);
        expect(document.querySelector(".entry-panel__lead")?.textContent).toBe(
          "This sign-out form was out of date, so you're still signed in. Use Sign out in the Account menu to end this session.",
        );
        expect(document.querySelector("h1")?.textContent).toBe("Still signed in");
        expect(document.querySelector("title")?.textContent).toStartWith("Still signed in");
        expect(
          [...document.querySelectorAll(".entry-panel__actions a")].map((link) =>
            link.getAttribute("href"),
          ),
        ).toEqual(["/"]);
        expect(w.sessions.rows()).toHaveLength(2);
        expect(browser.jar.has("tarubot")).toBe(true);
      }
    const out = await browser.post("/logout/all", "", {}, tokens[0] ?? null);
    expect(out.status).toBe(303);
    expect(w.sessions.rows()).toEqual([]);
  });

  test("a form from before a sign-in is refused: the new session has a new token", async () => {
    const w = await world();
    const browser = await signedIn(w);
    const before = browser.formToken;
    await browser.signIn({ id: OFFICER });
    expect(browser.formToken).not.toBe(before);
    // Sign out from a tab opened before that sign-in: refused, saying the session goes on.
    const stale = await browser.post("/logout", "", {}, before);
    expect(stale.status).toBe(403);
    const { document } = parseHTML(await stale.text());
    expect(document.querySelector("h1")?.textContent).toBe("Still signed in");
    expect(document.querySelector(".entry-panel__lead")?.textContent).toBe(
      "This sign-out form was out of date, so you're still signed in. Use Sign out in the Account menu to end this session.",
    );
    // It is: the session still opens pages, and the error page's own account menu carries the
    // current token, which signs out.
    expect((await browser.get(`/g/${GUILD}/status`)).status).toBe(200);
    expect(w.sessions.rows()).toHaveLength(1);
    expect(
      [...document.querySelectorAll(`input[name="form_token"]`)].map((input) =>
        input.getAttribute("value"),
      ),
    ).toEqual([browser.formToken, browser.formToken]);
    expect((await browser.post(`/g/${GUILD}/form`, "name=ok", {}, before)).status).toBe(403);
    expect(w.posts).toEqual([]);
    expect((await browser.post("/logout")).status).toBe(303);
  });
});

describe("errors, reports and logs", () => {
  test("a thrown error reaches the reporter with the request's ref and the route's scope", async () => {
    const failure = new Error(SECRET);
    const w = await world({
      syncStatus: async () => {
        throw failure;
      },
    });
    const officer = await signedIn(w);
    const response = await officer.get(`/g/${GUILD}/status`);
    const ref = REF.exec(await response.text())?.[1] ?? "";
    expect(ref).not.toBe("");
    expect(w.reports).toEqual([
      {
        error: failure,
        operation: ref,
        options: { scope: "web:/g/:guild/status", level: "error" },
      },
    ]);
  });

  test("an upstream failure is a 503 with Retry-After, reported at warn", async () => {
    const w = await world({
      syncStatus: async () => {
        throw new Failure("unavailable", "Discord isn't answering right now.", 30);
      },
    });
    const officer = await signedIn(w);
    const response = await officer.get(`/g/${GUILD}/status`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.text()).toContain("Discord isn&#39;t answering right now.");
    expect(w.reports.map((report) => report.options)).toEqual([
      { scope: "web:/g/:guild/status", level: "warn" },
    ]);
  });

  test("log lines carry the pattern, method, status, ms and ref only, at the right level", async () => {
    const w = await world();
    const browser = await signedIn(w);
    const token = browser.jar.get("tarubot") ?? "";
    expect(token).not.toBe("");
    await browser.get(`/g/${GUILD}/status?secret=${SECRET}`);
    await browser.get("/wp-admin/?q=1");
    await browser.request("/", { method: "DELETE" });
    await browser.post("/logout", "", { "Sec-Fetch-Site": "cross-site" });
    await browser.post("/logout");
    const lines = w.logs();
    const requests = lines.filter((line) => line.msg === "Web request");
    for (const line of requests)
      expect(Object.keys(line).sort()).toEqual(
        [
          "component",
          "hostname",
          "level",
          "method",
          "ms",
          "msg",
          "pid",
          "ref",
          "route",
          "status",
          "time",
        ].sort(),
      );
    const summary = requests.map(({ level, route, method, status }) => [
      level,
      method,
      route,
      status,
    ]);
    expect(summary).toEqual([
      [20, "GET", "/login", 302],
      [20, "GET", "/auth/callback", 303],
      [20, "GET", "/g/:guild/status", 200],
      [20, "GET", "/*", 404],
      [20, "DELETE", "/", 405],
      [30, "POST", "/logout", 403],
      [20, "POST", "/logout", 303],
    ]);
    const signIn = lines.find((line) => line.msg === "Web sign-in");
    expect(signIn).toMatchObject({ level: 30, userId: OFFICER, servers: 1 });
    expect(lines.find((line) => line.msg === "Web sign-out")).toMatchObject({
      level: 30,
      userId: OFFICER,
      everywhere: false,
      sessions: 1,
    });
    const text = JSON.stringify(lines);
    for (const leak of ["code=", "state=", "?", SECRET, token, GUILD, "127.0.0.1"])
      expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
  });
});

describe("scanner traffic", () => {
  test("a POST to an unknown or GET-only path is 404 or 405 at debug, never E1's 403", async () => {
    const w = await world();
    const scanner = new Browser(w);
    const bare: RequestInit = { method: "POST", body: "{}" };
    const crossSite: RequestInit = { ...bare, headers: { "Sec-Fetch-Site": "cross-site" } };
    const cases: [string, RequestInit, number, string | null][] = [
      ["/wp-login.php", bare, 404, null],
      ["/wp-login.php", crossSite, 404, null],
      ["/", bare, 405, "GET, HEAD"],
      ["/", crossSite, 405, "GET, HEAD"],
      [`/g/${GUILD}/status`, crossSite, 405, "GET, HEAD"],
    ];
    for (const [path, init, status, allow] of cases) {
      const response = await scanner.request(path, init);
      expect({ path, status: response.status, allow: response.headers.get("allow") }).toEqual({
        path,
        status,
        allow,
      });
    }
    // A route that serves POST still refuses a cross-site one first, worth a line at info.
    expect((await scanner.request("/logout", crossSite)).status).toBe(403);
    const requests = w.logs().filter((line) => line.msg === "Web request");
    expect(requests.map(({ level, route, status }) => [level, route, status])).toEqual([
      [20, "/*", 404],
      [20, "/*", 404],
      [20, "/", 405],
      [20, "/", 405],
      [20, "/g/:guild/status", 405],
      [30, "/logout", 403],
    ]);
  });

  test("a chunked body that fails to read is the sender's 400 on any path, never a report", async () => {
    const w = await world();
    const scanner = new Browser(w);
    // The body cap reads a chunked body itself, before routing and E1; a client that abandons it
    // makes that read fail.
    for (const path of ["/wp-login.php", "/logout"]) {
      const response = await scanner.request(path, {
        method: "POST",
        headers: { "Transfer-Encoding": "chunked" },
        body: new ReadableStream({
          pull(controller) {
            controller.error(new DOMException("The connection was closed.", "AbortError"));
          },
        }),
      });
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(await response.text()).toContain("Code <code>input</code>");
    }
    expect(w.reports).toEqual([]);
  });
});

describe("readiness and assets", () => {
  test("/health/ready answers the readiness boolean only, never cached", async () => {
    const w = await world();
    const visitor = new Browser(w);
    const ready = await visitor.get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(await ready.json()).toEqual({ ready: true });
    w.lifecycle.ready = false;
    const notReady = await visitor.get("/health/ready");
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ ready: false });
  });

  test("assets are served at their hashed paths as immutable, and nothing else is", async () => {
    const w = await world();
    const visitor = new Browser(w);
    // Text and binary alike: the stylesheet, favicon, notices and the three fonts.
    expect(new Set(ASSETS.map((asset) => asset.contentType))).toEqual(
      new Set([
        "text/css; charset=utf-8",
        "image/svg+xml",
        "text/plain; charset=utf-8",
        "font/woff2",
      ]),
    );
    for (const asset of ASSETS) {
      const response = await visitor.get(asset.path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(asset.contentType);
      expect(response.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
      // Bytes, not text: a font read as UTF-8 would lose its invalid sequences to replacement.
      const expected =
        typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : asset.body;
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    }
    for (const path of [
      "/assets/site.css",
      "/assets/../package.json",
      "/assets/",
      "/favicon.ico",
      // Only the hashed names exist: never a font or the notices by their plain names.
      "/assets/licenses.txt",
      "/assets/manrope-latin-wght-normal.woff2",
    ])
      expect({ path, status: (await visitor.get(path)).status }).toEqual({ path, status: 404 });
  });
});

/** Whether this host can bind the IPv6 loopback (CI hosts can; some containers can't). */
const ipv6Loopback = await (async () => {
  try {
    const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    try {
      return (await fetch(`http://[::1]:${probe.port}/`)).ok;
    } finally {
      await probe.stop(true);
    }
  } catch {
    return false;
  }
})();

describe("startWeb", () => {
  const running: WebServer[] = [];
  afterEach(async () => {
    for (const server of running.splice(0)) await server.stop();
  });

  /** A WebContext over the fakes, with recorded reports and a hold on Status. */
  function webContext(
    reports: Reported[],
    overrides: Partial<WebContext> = {},
    syncStatus: () => Promise<SyncStatusView> = async () => SYNC,
  ): WebContext {
    return {
      services: services(
        { lifecycle: { ready: true }, menus: new Map(), people: harnessPeople() },
        syncStatus,
      ),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: resolver([]),
      report: (error, operation, options) => reports.push({ error, operation, options }),
      guilds: () => GUILDS,
      ...overrides,
    };
  }

  const config = (origin: string | undefined, port?: number) => ({
    WEB_PUBLIC_ORIGIN: origin,
    WEB_PORT: port === undefined ? undefined : String(port),
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    DISCORD_APPLICATION_ID: CLIENT_ID,
  });

  const silent = pino({ level: "silent" });

  /** A port that was free a moment ago. */
  async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = probe.port ?? 0;
    await probe.stop(true);
    return port;
  }

  /** Whether `port` can be bound on 127.0.0.1 right now (so nothing listens there). */
  function bindable(port: number): boolean {
    try {
      void Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) }).stop(true);
      return true;
    } catch {
      return false;
    }
  }

  test("an empty or unset origin returns null, silently, and nothing listens", async () => {
    for (const origin of [undefined, ""]) {
      const reports: Reported[] = [];
      const port = await freePort();
      const web = await startWeb(config(origin, port), webContext(reports), silent, {
        sessions: new MemorySessions(),
        hostname: "127.0.0.1",
      });
      expect(web).toBeNull();
      expect(reports).toEqual([]);
      expect(bindable(port)).toBe(true);
    }
  });

  test("invalid settings are reported by name, never by value, and leave the web off", async () => {
    const reports: Reported[] = [];
    const web = await startWeb(
      {
        WEB_PUBLIC_ORIGIN: "http://evil.example",
        WEB_PORT: "99999",
        DISCORD_CLIENT_SECRET: "",
        DISCORD_APPLICATION_ID: CLIENT_ID,
      },
      webContext(reports),
      silent,
      { sessions: new MemorySessions() },
    );
    expect(web).toBeNull();
    expect(reports).toHaveLength(1);
    const [{ error, operation } = { error: null, operation: "" }] = reports;
    expect(operation).toBe("web settings");
    expect(error).toBeInstanceOf(Failure);
    const message = error instanceof Failure ? error.message : "";
    expect((error as Failure).code).toBe("configuration");
    for (const name of ["WEB_PUBLIC_ORIGIN", "WEB_PORT", "DISCORD_CLIENT_SECRET"])
      expect(message).toContain(name);
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("99999");
  });

  test("a page-discovery error or a missing service is reported and leaves the web off", async () => {
    const duplicates = new URL("../fixtures/web-pages/duplicates/", import.meta.url);
    const reports: Reported[] = [];
    expect(
      await startWeb(config(DEV), webContext(reports), silent, {
        sessions: new MemorySessions(),
        pagesDirectory: duplicates,
        port: 0,
        hostname: "127.0.0.1",
      }),
    ).toBeNull();
    // Status requires the application, which this context lacks.
    expect(
      await startWeb(config(DEV), webContext(reports, { services: new Services() }), silent, {
        sessions: new MemorySessions(),
        port: 0,
        hostname: "127.0.0.1",
      }),
    ).toBeNull();
    // Without an injected store the bot's database is required too.
    expect(await startWeb(config(DEV), webContext(reports), silent, { port: 0 })).toBeNull();
    expect(reports.map((report) => report.operation)).toEqual([
      "web pages",
      "web pages",
      "web pages",
    ]);
  });

  test("an occupied port is reported and returns null; a stopping bot never binds", async () => {
    const reports: Reported[] = [];
    const occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    try {
      const web = await startWeb(config(DEV), webContext(reports), silent, {
        sessions: new MemorySessions(),
        hostname: "127.0.0.1",
        port: occupant.port ?? 0,
      });
      expect(web).toBeNull();
      expect(reports.map((report) => report.operation)).toEqual(["web listener"]);
    } finally {
      await occupant.stop(true);
    }
    const port = await freePort();
    const stopping = await startWeb(
      config(DEV),
      webContext(reports, { isStopping: () => true }),
      silent,
      { sessions: new MemorySessions(), hostname: "127.0.0.1", port },
    );
    expect(stopping).toBeNull();
    expect(bindable(port)).toBe(true);
  });

  test("stop() lets an in-flight request finish, never rejects, and closes the port", async () => {
    let release = () => {};
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = new MemorySessions();
    const { token } = await sessions.create(OFFICER);
    const web = await startWeb(
      config(DEV),
      webContext([], {}, async () => {
        entered();
        await held;
        return SYNC;
      }),
      silent,
      { sessions, hostname: "127.0.0.1", port: 0 },
    );
    if (!web) throw new Error("The web didn't start");
    const url = new URL(`/g/${GUILD}/status`, `http://127.0.0.1:${web.url.port}`);
    const request = fetch(url, { headers: { cookie: `tarubot=${token}` } });
    await inside;
    let stopped = false;
    const stop = web.stop().then(() => {
      stopped = true;
    });
    // No new connection is accepted while the held request drains.
    expect(
      await fetch(new URL("/health/ready", url)).then(
        (response) => response.status,
        () => "refused",
      ),
    ).toBe("refused");
    // The same promise however often it is called.
    expect(web.stop()).toBe(web.stop());
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    release();
    expect((await request).status).toBe(200);
    await stop;
    expect(stopped).toBe(true);
    expect(bindable(Number(web.url.port))).toBe(true);
  });

  test("stop() closes a request still running after the grace period", async () => {
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const web = await startWeb(
      config(DEV),
      webContext([], {}, () => {
        entered();
        return new Promise<SyncStatusView>(() => {});
      }),
      silent,
      { sessions: await withOfficer(), hostname: "127.0.0.1", port: 0, stopMs: 100 },
    );
    if (!web) throw new Error("The web didn't start");
    const request = fetch(new URL(`/g/${GUILD}/status`, `http://127.0.0.1:${web.url.port}`), {
      headers: { cookie: `tarubot=${officerToken}` },
    }).catch(() => null);
    // The request is inside its handler, so stop() must wait out the grace period and then close it.
    await inside;
    const started = performance.now();
    await web.stop();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(3000);
    expect((await request)?.status ?? "closed").not.toBe(200);
  });

  let officerToken = "";
  /** A session store holding one officer session (officerToken). */
  async function withOfficer(): Promise<MemorySessions> {
    const sessions = new MemorySessions();
    officerToken = (await sessions.create(OFFICER)).token;
    return sessions;
  }

  test("a non-Error throw reaches Bun's error(): a bare 500 with the header set, reported", async () => {
    const reports: Reported[] = [];
    const lines: string[] = [];
    const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
    const web = await startWeb(config(DEV), webContext(reports), log, {
      sessions: await withOfficer(),
      pagesDirectory: new URL("../fixtures/web-pages/throws/", import.meta.url),
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!web) throw new Error("The web didn't start");
    running.push(web);
    // Hono's onError never sees it (it takes Errors only); without error() Bun would print the
    // value and answer its own text page without these headers.
    const response = await fetch(new URL(`/g/${GUILD}/boom`, `http://127.0.0.1:${web.url.port}`), {
      headers: { cookie: `tarubot=${officerToken}` },
    });
    expect(response.status).toBe(500);
    expectSecurityHeaders(response, false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(reports.map(({ error, options }) => ({ error, options }))).toEqual([
      { error: THROWN, options: { scope: "web" } },
    ]);
    expect(lines.join("\n")).not.toContain(THROWN);
  });

  test("Bun's own cap answers an over-cap body, bare; a cut chunked read is never reported", async () => {
    const reports: Reported[] = [];
    const web = await startWeb(config(DEV), webContext(reports), silent, {
      sessions: new MemorySessions(),
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!web) throw new Error("The web didn't start");
    running.push(web);
    const url = new URL("/logout", `http://127.0.0.1:${web.url.port}`);
    const headers = {
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const body = new TextEncoder().encode(`a=${"x".repeat(WEB_BODY_LIMIT + 10)}`);
    // With Content-Length, Bun refuses before the app sees the request: no page, no headers.
    const sized = await fetch(url, { method: "POST", headers, body });
    expect(sized.status).toBe(413);
    expect(await sized.text()).toBe("");
    expect(sized.headers.get("content-type")).toBeNull();
    // Chunked, the app's body cap reads the stream until Bun cuts it: Bun's 413 again, and the
    // failed read is the sender's doing, never an issue report.
    let at = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) controller.close();
        else controller.enqueue(body.subarray(at, at + 8192));
        at += 8192;
      },
    });
    const cut = await fetch(url, { method: "POST", headers, body: chunked });
    expect(cut.status).toBe(413);
    await cut.text();
    expect(reports).toEqual([]);
  });

  test("a malformed Host is a bare 400 before the app, and nothing is reported", async () => {
    const reports: Reported[] = [];
    const web = await startWeb(config(DEV), webContext(reports), silent, {
      sessions: new MemorySessions(),
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!web) throw new Error("The web didn't start");
    running.push(web);
    const base = `http://127.0.0.1:${web.url.port}`;
    const status = `/g/${GUILD}/status`;
    // Bun builds request.url from Host unchecked; each of these gives a URL that URL() refuses.
    for (const [path, host] of [
      [status, "["],
      [status, "example.org:99999"],
      ["/auth/callback?code=x&state=y", "["],
    ] as const) {
      const response = await fetch(new URL(path, base), {
        headers: { Host: host },
        redirect: "manual",
      });
      expect({ path, host, status: response.status }).toEqual({ path, host, status: 400 });
      expectSecurityHeaders(response, false);
      expect(await response.text()).toBe("");
    }
    // A well-formed Host reaches the app: signed out, the page sends the visitor to sign in.
    expect((await fetch(new URL(status, base), { redirect: "manual" })).status).toBe(303);
    expect(reports).toEqual([]);
  });

  test("the sweep runs on its timer, reports its errors, and stops with the server", async () => {
    class FailingSweep extends MemorySessions {
      sweeps = 0;
      override async sweep(): Promise<number> {
        this.sweeps++;
        throw new Error("sweep failed");
      }
    }
    const reports: Reported[] = [];
    const sessions = new FailingSweep();
    const web = await startWeb(config(DEV), webContext(reports), silent, {
      sessions,
      hostname: "127.0.0.1",
      port: 0,
      sweepMs: 10,
    });
    if (!web) throw new Error("The web didn't start");
    await Bun.sleep(60);
    await web.stop();
    expect(sessions.sweeps).toBeGreaterThan(0);
    expect(new Set(reports.map((report) => report.operation))).toEqual(
      new Set(["web session sweep"]),
    );
    const after = sessions.sweeps;
    await Bun.sleep(40);
    expect(sessions.sweeps).toBe(after);
  });

  test.skipIf(!ipv6Loopback)("on '::' both [::1] and 127.0.0.1 answer", async () => {
    const web = await startWeb(config(DEV), webContext([]), silent, {
      sessions: new MemorySessions(),
      port: 0,
    });
    if (!web) throw new Error("The web didn't start");
    running.push(web);
    expect(web.url.hostname).toBe("[::]");
    for (const host of ["[::1]", "127.0.0.1"]) {
      const response = await fetch(`http://${host}:${web.url.port}/health/ready`);
      expect({ host, status: response.status }).toEqual({ host, status: 200 });
      expectSecurityHeaders(response, false);
      expect(await response.json()).toEqual({ ready: true });
    }
  });
});

describe.skipIf(!ipv6Loopback)("the development harness, end to end over loopback", () => {
  /** A cookie-jar fetch that leaves redirects to the test. */
  function client(tls?: { ca: string }) {
    const jar = new Map<string, string>();
    return async (url: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await fetch(url, {
        ...init,
        ...(tls && { tls }),
        headers,
        redirect: "manual",
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ""] = cookie.split(";");
        const [name = "", value = ""] = pair.split("=");
        if (/max-age=0/iu.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
  }

  /** From a signed-out page through the fake authorize page as `account`, to the callback. */
  async function signIn(
    browse: ReturnType<typeof client>,
    base: URL,
    account: string,
  ): Promise<Response> {
    const page = await browse(new URL(`/g/${HARNESS_GUILDS.example.id}/status`, base));
    expect(page.status).toBe(303);
    const login = await browse(new URL(page.headers.get("location") ?? "", base));
    expect(login.status).toBe(302);
    const choose = await browse(login.headers.get("location") ?? "");
    const body = await choose.text();
    const link = new RegExp(`href="(/oauth2/approve/[0-9a-f-]+/${account})"`, "u").exec(body)?.[1];
    expect(link).toBeDefined();
    const approved = await browse(new URL(link ?? "", login.headers.get("location") ?? ""));
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location") ?? "");
    expect(callback.origin).toBe(base.origin);
    return browse(callback);
  }

  test("an officer signs in, sees their server, opens Status and signs out", async () => {
    const harness = await startHarness();
    try {
      const browse = client();
      const done = await signIn(browse, harness.url, "officer");
      expect(done.status).toBe(303);
      const status = `/g/${HARNESS_GUILDS.example.id}/status`;
      expect(done.headers.get("location")).toBe(status);
      const home = await (await browse(harness.url)).text();
      expect(home).toContain("Example FC");
      // A member of Second FC, not an officer there (2.40.0): it is listed, with My roles only.
      const second = HARNESS_GUILDS.second.id;
      expect(home).toContain("Second &lt;FC&gt; &amp; Friends");
      expect(home).toContain(`href="/g/${second}/my-roles"`);
      expect(home).not.toContain(`href="/g/${second}/status"`);
      const page = await browse(new URL(status, harness.url));
      expect(page.status).toBe(200);
      // Sign-out is a form with the session's form token, read from the page like a browser.
      const token = [...(await page.text()).matchAll(TOKEN_INPUT)].map((match) => match[1]);
      expect(token).toHaveLength(2);
      const out = await browse(new URL("/logout", harness.url), {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `${FORM_TOKEN_FIELD}=${token[0]}`,
      });
      expect(out.status).toBe(303);
      expect((await browse(new URL(status, harness.url))).status).toBe(303);
    } finally {
      await harness.stop();
    }
  });

  test("the Role menu's review states: flags, problems and an unreadable menu, as the officer sees them", async () => {
    expect(harnessOptions(["--state-menu-problems", "--state-menu-unreadable"]).states).toEqual({
      menuProblems: true,
      menuUnreadable: true,
    });
    const menu = `/g/${HARNESS_GUILDS.example.id}/role-menu`;
    const read = async (states: HarnessStates) => {
      const harness = await startHarness({ states });
      try {
        const browse = client();
        expect((await signIn(browse, harness.url, "officer")).status).toBe(303);
        const page = await browse(new URL(menu, harness.url));
        expect(page.status).toBe(200);
        return parseHTML(await page.text()).document;
      } finally {
        await harness.stop();
      }
    };
    const healthy = await read({});
    expect(healthy.querySelector(".menu-summary__title")?.textContent).toBe(
      "1 draft isn't published yet.",
    );
    expect(healthy.querySelectorAll(".menu-problems, .notice--warning")).toHaveLength(0);
    const drifted = await read({ menuProblems: true });
    expect(drifted.querySelector(".menu-summary__title")?.textContent).toBe(
      "5 roles need attention.",
    );
    expect(drifted.querySelectorAll(".menu-problems")).toHaveLength(5);
    expect(drifted.querySelectorAll('fieldset[id$="-acknowledged"]').length).toBeGreaterThan(0);
    const unreadable = await read({ menuUnreadable: true });
    expect(
      [...unreadable.querySelectorAll('main input[name="op"]')].map((op) =>
        op.getAttribute("value"),
      ),
    ).toEqual(["menu.reset"]);
  });

  test("a member, a guest and a timed-out member sign in to My roles; with Administrator, only officers", async () => {
    const harness = await startHarness();
    try {
      const myRoles = (guild: string) => `/g/${guild}/my-roles`;
      const example = HARNESS_GUILDS.example.id;
      for (const account of ["member", "guest", "timedOut"] as const) {
        const browse = client();
        const done = await signIn(browse, harness.url, account);
        expect({ account, status: done.status }).toEqual({ account, status: 303 });
        // Officer pages stay closed to them.
        const status = await browse(new URL(`/g/${example}/status`, harness.url));
        expect({ account, status: status.status }).toEqual({ account, status: 403 });
        const page = await browse(new URL(myRoles(example), harness.url));
        expect({ account, myRoles: page.status }).toEqual({ account, myRoles: 200 });
        // The member has two servers, so / lists them; the others go straight to My roles.
        const home = await browse(harness.url);
        if (account === "member") {
          expect(home.status).toBe(200);
          const text = await home.text();
          for (const guild of [example, HARNESS_GUILDS.second.id])
            expect(text).toContain(`href="${myRoles(guild)}"`);
        } else {
          expect({ account, home: home.status }).toEqual({ account, home: 303 });
          expect(home.headers.get("location")).toBe(myRoles(example));
        }
      }
    } finally {
      await harness.stop();
    }
    // --state-menu-problems gives TaruBot Administrator again: A2 refuses every member and guest,
    // and the officer still signs in.
    const drifted = await startHarness({ states: { menuProblems: true } });
    try {
      for (const account of ["member", "guest", "timedOut", "officer"] as const) {
        const response = await signIn(client(), drifted.url, account);
        expect({ account, status: response.status }).toEqual({
          account,
          status: account === "officer" ? 303 : 403,
        });
      }
    } finally {
      await drifted.stop();
    }
  });

  test("a lobby newcomer, an outsider and a bot are refused; the fake serves only its redirect URI", async () => {
    const harness = await startHarness();
    try {
      for (const account of ["lobby", "outsider", "bot"] as const) {
        const response = await signIn(client(), harness.url, account);
        expect({ account, status: response.status }).toEqual({ account, status: 403 });
        expect(response.headers.getSetCookie().some((c) => c.startsWith("tarubot="))).toBe(false);
      }
      const foreign = new URL(harness.authorizeUrl);
      foreign.searchParams.set("redirect_uri", "https://evil.example/auth/callback");
      foreign.searchParams.set("state", "<script>alert(1)</script>");
      const refused = await fetch(foreign, { redirect: "manual" });
      expect(refused.status).toBe(400);
      const text = await refused.text();
      expect(text).not.toContain("evil.example");
      expect(text).not.toContain("<script>");
    } finally {
      await harness.stop();
    }
  });
  test.skipIf(!process.env.CADDY_FIXTURE_IMAGE)(
    "an accepted trailing-slash origin serves protected routes and OAuth through native Caddy",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tarubot-caddy-"));
      const project = `tarubot-caddy-${crypto.randomUUID()}`;
      const repository = fileURLToPath(new URL("../..", import.meta.url));
      const freePort = async () => {
        const probe = Bun.serve({ hostname: "::", port: 0, fetch: () => new Response(null) });
        const port = probe.port;
        await probe.stop(true);
        if (port === undefined) throw new Error("TCP probe did not expose a port");
        return port;
      };
      const publicPort = await freePort();
      let privatePort = await freePort();
      while (privatePort === publicPort) privatePort = await freePort();
      const origin = `https://localhost:${publicPort}/`;
      const harness = await startHarness({
        hostname: "::1",
        port: privatePort,
        publicOrigin: origin,
      });
      const environment = {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        WEB_PUBLIC_ORIGIN: origin,
        WEB_PORT: String(privatePort),
      };
      const compose = async (...args: string[]) => {
        const result = Bun.spawn(
          [
            "docker",
            "compose",
            "--project-name",
            project,
            "--env-file",
            "/dev/null",
            "-f",
            join(directory, "compose.yml"),
            ...args,
          ],
          { env: environment, stdout: "pipe", stderr: "pipe" },
        );
        const [code, stdout, stderr] = await Promise.all([
          result.exited,
          new Response(result.stdout).text(),
          new Response(result.stderr).text(),
        ]);
        if (code !== 0) throw new Error(stderr);
        return stdout.trim();
      };
      try {
        // Host networking reaches only the loopback fixture. No fixed host ports,
        // public ACME, bot/database credentials, or real Discord are involved.
        await writeFile(
          join(directory, "Caddyfile"),
          `{
          admin off
          auto_https disable_redirects
          skip_install_trust
          default_bind 127.0.0.1 [::1]
          servers {
            protocols h1 h2
          }
        }
        import /etc/caddy/TaruBot.Caddyfile
        `,
        );
        await writeFile(
          join(directory, "override.yml"),
          `
services:
  caddy:
    image: ${JSON.stringify(process.env.CADDY_FIXTURE_IMAGE)}
    network_mode: host
    extra_hosts: {tarubot: "::1"}
    ports: !override []
    # Native health waits for trusted TLS and the actual root response, not a delay.
    healthcheck:
      test: [CMD-SHELL, "SSL_CERT_FILE=/data/caddy/pki/authorities/local/root.crt wget -q -O /dev/null https://localhost:${publicPort}/"]
      interval: 1s
      timeout: 2s
      retries: 10
      start_period: 0s
    volumes: !override
      - ${JSON.stringify(`${repository}/ops/Caddyfile:/etc/caddy/TaruBot.Caddyfile:ro,z`)}
      - ${JSON.stringify(`${directory}/Caddyfile:/etc/caddy/Caddyfile:ro,z`)}
      - caddy_data:/data
      - caddy_config:/config
`,
        );
        await writeFile(
          join(directory, "compose.yml"),
          `
include:
  - path:
      - ${JSON.stringify(join(repository, "docker-compose.web.yml"))}
      - ${JSON.stringify(join(directory, "override.yml"))}
services:
  tarubot:
    image: ${JSON.stringify(process.env.CADDY_FIXTURE_IMAGE)}
`,
        );
        await compose(
          "up",
          "--detach",
          "--no-deps",
          "--pull",
          "never",
          "--wait",
          "--wait-timeout",
          "15",
          "caddy",
        );
        const ca = await compose(
          "exec",
          "-T",
          "caddy",
          "cat",
          "/data/caddy/pki/authorities/local/root.crt",
        );
        const browse = client({ ca });
        const done = await signIn(browse, harness.url, "officer");
        expect(done.status).toBe(303);
        expect(
          done.headers
            .getSetCookie()
            .some((cookie) => cookie.startsWith("__Host-") && /; Secure(?:;|$)/u.test(cookie)),
        ).toBe(true);
        const page = await browse(
          new URL(`/g/${HARNESS_GUILDS.example.id}/configuration`, harness.url),
        );
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Example FC");
      } finally {
        await harness.stop();
        try {
          await compose("--profile", "web", "down", "--volumes", "--remove-orphans");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
});
