/**
 * The web server (#43, ADR D12, D14, E1, E10, B4): the Hono app through app.request() with fakes
 * (FakeDiscord answering the injected fetch, the in-memory session store, a recording resolver and
 * reporter, captured logs), then startWeb's real listener on loopback ports, and finally the
 * development harness driven end to end. Credential-free: invented IDs, no network beyond
 * loopback, no database.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Hono } from "hono";
import { pino } from "pino";
import { z } from "zod";
import { applicationKey, gatewayKey, lifecycleKey } from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import type { SyncStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import type { ReportOptions } from "../../src/domain/failures.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { AccessResolver, type WebGuild } from "../../src/web/access.js";
import { ASSET_CACHE_CONTROL, ASSETS, STYLESHEET } from "../../src/web/assets.js";
import { html } from "../../src/web/html.js";
import { securityHeaderRecord, type WebEnv } from "../../src/web/http.js";
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
import { SESSION_ABSOLUTE_MS } from "../../src/web/sessions.js";
import { type WebSettings, webSettings } from "../../src/web/settings.js";
import { type DiscordAccount, discordOAuthError, FakeDiscord } from "../fixtures/discord-oauth.js";
import { THROWN } from "../fixtures/web-pages/throws/boom.page.js";
import {
  HARNESS_ACCOUNTS,
  HARNESS_GUILDS,
  harnessGateway,
  startHarness,
} from "../fixtures/web-dev.js";
import { MemorySessions } from "../fixtures/web-sessions.js";
import { configGuild, configReport } from "../fixtures/replies/configuration.js";

const HTTPS = "https://example.org";
const DEV = "http://localhost:8080";
/** The server everyone here signs in to. */
const GUILD = "100000000000000001";
/** Cached by the gateway, but not served by this deployment (allowsGuild refuses it). */
const UNSERVED = "100000000000000002";
/** A well-formed ID the gateway doesn't have. */
const ABSENT = "100000000000000009";
const OFFICER = "200000000000000001";
const MEMBER = "200000000000000002";
const OUTSIDER = "200000000000000003";
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

/** Invented sync status for the Status page. */
const SYNC: SyncStatusView = { effectsMode: "live", runs: [], work: [] };

interface WorldOptions {
  readonly origin?: string;
  /** Replaces syncStatus, to make Status slow or throw. */
  readonly syncStatus?: () => Promise<SyncStatusView>;
}

/** Everything a test needs: the app and every fake behind it. */
interface World {
  readonly app: Hono<WebEnv>;
  readonly settings: WebSettings;
  readonly discord: FakeDiscord;
  readonly sessions: MemorySessions;
  /** (guild, user) per resolver call. */
  readonly resolutions: [string, string][];
  readonly reports: Reported[];
  /** Forms the form page received. */
  readonly posts: Record<string, unknown>[];
  /** Milliseconds; the memo and the session store read it. */
  readonly clock: { now: number };
  readonly lifecycle: { ready: boolean };
  readonly logs: () => LogLine[];
}

/** The services the Status page and /health/ready use, as prototype-backed fakes. */
function services(world: Pick<World, "lifecycle">, syncStatus: () => Promise<SyncStatusView>) {
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
    .provide(gatewayKey, harnessGateway());
}

/** The bot's resolver over invented membership: an officer, a member, and Unknown Member. */
function resolver(resolutions: [string, string][]) {
  return async (guildId: string, userId: string): Promise<Actor> => {
    resolutions.push([guildId, userId]);
    if (userId === OUTSIDER)
      throw new Failure("forbidden", "Not a member.", 0, {
        kind: "scope",
        scope: "current_member",
      });
    return { guildId, userId, officer: userId === OFFICER, manageRoles: false };
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
  const resolutions: [string, string][] = [];
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
    get: () =>
      html`<form method="post" action="/g/${GUILD}/form"><label for="name">Name</label><input id="name" name="name"><button type="submit">Save</button></form>`,
    async post(context, form) {
      posts.push(Object.fromEntries(form));
      const parsed = NAME_FORM.safeParse(Object.fromEntries(form));
      if (!parsed.success) return { invalid: html`<p>Enter a name of at most 20 characters.</p>` };
      // A page bug returning an off-site target must still end on this origin.
      return { redirect: parsed.data.name === "away" ? "//evil.example/" : context.url.pathname };
    },
  });
  const pages = new Map<string, Page>([...(await loadPages()), [formPage.path, formPage]]);
  const discord = new FakeDiscord(CLIENT_ID, CLIENT_SECRET);
  const sessions = new MemorySessions(() => clock.now);
  const resolve = resolver(resolutions);
  const context: WebContext = {
    services: services({ lifecycle }, options.syncStatus ?? (async () => SYNC)),
    allowsGuild: (guildId) => guildId !== UNSERVED,
    isStopping: () => false,
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
      fetch: discord.fetch,
    }),
    access: new AccessResolver(resolve, { now: () => clock.now }),
    log,
  });
  return {
    app,
    settings,
    discord,
    sessions,
    resolutions,
    reports,
    posts,
    clock,
    lifecycle,
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

  /** A same-origin form post, as a browser sends it. */
  post(path: string, body = "", headers: Record<string, string> = {}): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        Origin: this.world.settings.origin,
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
    });
  }

  /** Sign in through /login, the fake authorize page and the callback. */
  async signIn(account: DiscordAccount, to?: string): Promise<Response> {
    const login = await this.get(
      to === undefined ? "/login" : `/login?to=${encodeURIComponent(to)}`,
    );
    expect(login.status).toBe(302);
    const callback = this.world.discord.authorize(
      new URL(login.headers.get("location") ?? ""),
      account,
    );
    return this.get(`${callback.pathname}${callback.search}`);
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
        body: "name=ok",
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
    // Decided on a fresh resolution, never on a memoized answer.
    expect(w.resolutions).toEqual([[GUILD, MEMBER]]);
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
    expect(visitor).toContain('<a class="button" href="/login">Sign in with Discord</a>');
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
    for (const userId of [MEMBER, OUTSIDER]) {
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
    await browser.signIn({ id: MEMBER });
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
    for (const asset of ASSETS) {
      const response = await visitor.get(asset.path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(asset.contentType);
      expect(response.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
      expect(await response.text()).toBe(asset.body);
    }
    for (const path of ["/assets/site.css", "/assets/../package.json", "/assets/", "/favicon.ico"])
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
      services: services({ lifecycle: { ready: true } }, syncStatus),
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
  function client() {
    const jar = new Map<string, string>();
    return async (url: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await fetch(url, { ...init, headers, redirect: "manual" });
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
      // A member there, not an officer, so Second FC isn't listed.
      expect(home).not.toContain("Second");
      const page = await browse(new URL(status, harness.url));
      expect(page.status).toBe(200);
      const out = await browse(new URL("/logout", harness.url), {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      });
      expect(out.status).toBe(303);
      expect((await browse(new URL(status, harness.url))).status).toBe(303);
    } finally {
      await harness.stop();
    }
  });

  test("a member, an outsider and a bot are refused; the fake serves only its redirect URI", async () => {
    const harness = await startHarness();
    try {
      for (const account of ["member", "outsider", "bot"] as const) {
        const response = await signIn(client(), harness.url, account);
        expect({ account, status: response.status }).toEqual({ account, status: 403 });
        expect(response.headers.getSetCookie().some((c) => c.startsWith("tarubot="))).toBe(false);
      }
      expect(Object.keys(HARNESS_ACCOUNTS)).toEqual(["officer", "member", "outsider", "bot"]);
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
});
