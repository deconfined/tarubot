/**
 * Web pages (#43, D12, E2, E12): definePage's validation, discovery of *.page.ts modules, and the
 * rendered markup of the shell, the / page, the "no access" page, error pages and Status, with
 * invented data parsed by linkedom. The markup rules: lang="en", one <h1>, no style attribute or
 * script (the CSP allows neither), a text label on every control, hostile names escaped inside
 * dir="auto" elements, and no global process metrics or diagnostics on Status.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
  applicationKey,
  gatewayKey,
  lifecycleKey,
  selfRolesKey,
} from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import type { JobView, SyncRunRow, SyncStatusView } from "../../src/application/results.js";
import type { SelfRoleEditor } from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { ServiceKey, Services } from "../../src/bot/services.js";
import { project } from "../../src/config/project.js";
import type { Actor } from "../../src/domain/policy.js";
import {
  LIMIT_MESSAGES,
  MENU_LIMITS,
  MENU_OPERATIONS,
  type MenuOperation,
  SELF_ROLE_MESSAGES,
  type SelfRoleMenu,
} from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { PAGE_ACCESS } from "../../src/web/access.js";
import { FAVICON, STYLESHEET } from "../../src/web/assets.js";
import { html, type SafeHtml } from "../../src/web/html.js";
import { FORM_TOKEN_FIELD, problemOf } from "../../src/web/http.js";
import { errorPage, layout, navLinks, serverAvatar } from "../../src/web/layout.js";
import { definePage, PAGE_PATH, Page, type PageContext } from "../../src/web/page.js";
import { loadPages } from "../../src/web/pages.js";
import { guildNames, type WebNames } from "../../src/web/mentions.js";
import type { Session } from "../../src/web/sessions.js";
import { renderHome, renderNoAccess } from "../../src/web/views/servers.js";
import {
  noticeFor,
  type RefusedEdit,
  ROLE_MENU_NOTICES,
  renderRoleMenu,
} from "../../src/web/views/role-menu.js";
import { renderStatus } from "../../src/web/views/status.js";
import {
  HARNESS_MENU,
  type HarnessStates,
  harnessGateway,
  harnessSelfRoles,
  MENU_CATEGORY,
  MENU_ROLE,
} from "../fixtures/web-dev.js";

const GUILD = "100000000000000001";
const USER = "200000000000000002";
const REF = "00000000-0000-4000-8000-000000000000";
/** An invented form token, as the session middleware derives one. */
const TOKEN = "Zm9ybS10b2tlbi1mb3ItdGVzdHMtMDAwMDAwMDAwMDA";
const fixtures = new URL("../fixtures/web-pages/", import.meta.url);

/** Names a hostile server owner or member could choose. */
const HOSTILE: [string, string, string, string] = [
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "‮txt.exe‬ Officers",
  "Tom & Jerry's <FC>",
];

/** Render a template result to a string. */
const render = async (value: SafeHtml): Promise<string> => String(await value);

/** The accessible name a control gets from its text, aria-label or a <label for>. */
function accessibleName(document: Document, element: Element): string {
  const id = element.getAttribute("id");
  const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent : undefined;
  return (element.getAttribute("aria-label") ?? label ?? element.textContent ?? "").trim();
}

/**
 * Parse a full document and check the rules every page shares; returns the document for the
 * page-specific checks.
 */
function inspect(markup: string): Document {
  // String-level first: a parser could drop malformed markup that a browser would still run.
  expect(markup).not.toContain("style=");
  expect(markup.toLowerCase()).not.toContain("<script");
  expect(markup.toLowerCase()).not.toContain("<style");
  const { document } = parseHTML(markup);
  expect(markup.startsWith("<!doctype html>")).toBe(true);
  expect(document.documentElement.getAttribute("lang")).toBe("en");
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  expect(document.querySelectorAll("[style], script, style, iframe, object, embed")).toHaveLength(
    0,
  );
  for (const element of document.querySelectorAll("*"))
    for (const attribute of element.getAttributeNames())
      expect({ element: element.tagName, attribute }).not.toEqual({
        element: element.tagName,
        attribute: expect.stringMatching(/^on/u),
      });
  // Every control has a visible or programmatic label, and every link has text. A hidden input is
  // no control: nobody sees or reaches it (the form token, an operation name, an ID).
  for (const control of document.querySelectorAll(
    'button, input:not([type="hidden"]), select, textarea',
  ))
    expect(accessibleName(document, control)).not.toBe("");
  for (const link of document.querySelectorAll("a")) {
    expect((link.textContent ?? "").trim()).not.toBe("");
    expect(link.getAttribute("href")).not.toBe("#");
  }
  // Forms post here only (the CSP's form-action agrees), and each carries the session's form
  // token exactly once, so no POST form can be forged or forgotten.
  for (const form of document.querySelectorAll("form")) {
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toMatch(/^\/[^/\\]/u);
    const tokens = [...form.querySelectorAll(`input[name="${FORM_TOKEN_FIELD}"]`)];
    expect(tokens.map((input) => input.getAttribute("type"))).toEqual(["hidden"]);
    expect(tokens[0]?.getAttribute("value") ?? "").not.toBe("");
  }
  // The shell: viewport, the hashed assets, and the AGPL source and license links.
  expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
    "width=device-width, initial-scale=1",
  );
  expect(document.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe(
    STYLESHEET.path,
  );
  expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(FAVICON.path);
  const footer = document.querySelector("footer");
  expect(footer?.textContent).toContain(project.version);
  expect(footer?.querySelector(`a[href="${project.url}"]`)?.textContent).toBe("Source code");
  expect(
    footer?.querySelector(`a[href="${project.url}/blob/main/LICENSE"]`)?.textContent,
  ).toContain(project.license);
  return document;
}

/** Texts of every dir="auto" element: where untrusted text must land. */
const isolated = (document: Document): string[] =>
  [...document.querySelectorAll('[dir="auto"]')].map((element) => element.textContent ?? "");

describe("definePage", () => {
  const base = {
    path: "/g/:guild/status",
    title: "Status",
    access: ["officer"],
    requires: [],
    get: () => html``,
  } as const;

  test("accepts a valid page and builds its server href", () => {
    const page = definePage({
      ...base,
      nav: "Status",
      post: async () => ({ redirect: "/" }),
      postLimit: 30,
    });
    expect(page).toBeInstanceOf(Page);
    expect(page.postLimit).toBe(30);
    expect(definePage(base).postLimit).toBeUndefined();
    expect(page.href(GUILD)).toBe(`/g/${GUILD}/status`);
    expect(page.nav).toBe("Status");
    expect(page.icon).toBeUndefined();
    expect(definePage({ ...base, icon: "activity" }).icon).toBe("activity");
    expect(definePage({ ...base, path: "/g/:guild/roles/officer-ranks" }).path).toBe(
      "/g/:guild/roles/officer-ranks",
    );
  });

  test("keeps declared access in order without duplicates, and service keys as given", () => {
    expect(definePage({ ...base, access: ["manager", "officer", "manager"] }).access).toEqual([
      "manager",
      "officer",
    ]);
    const key = new ServiceKey("number", (value): value is number => typeof value === "number");
    expect(definePage({ ...base, requires: [key] }).requires).toEqual([key]);
  });

  test("refuses a path outside /g/:guild/ or with other parameters", () => {
    for (const path of [
      "/status",
      "/g/:guild",
      "/g/:guild/",
      "/g/:guild/Status",
      "/g/:guild/a_b",
      "/g/:guild/-a",
      "/g/:guild/a-",
      "/g/:guild/:other",
      "/g/:id/status",
      "/g/:guild/status/",
      "/g/:guild//status",
      "/g/:guild/status?x",
      "/x/g/:guild/status",
    ])
      expect(() => Reflect.construct(Page, [{ ...base, path }])).toThrow(
        `A page path must be /g/:guild/ followed by lowercase segments.`,
      );
  });

  test("refuses every malformed option a discovered module could export", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "/g/:guild" }, "A page path must be"],
      [{ title: "" }, "A page needs a title."],
      [{ title: "   " }, "A page needs a title."],
      [{ title: 42 }, "A page needs a title."],
      [{ access: undefined }, "A page must declare access"],
      [{ access: [] }, "A page must declare access"],
      [{ access: ["member"] }, "A page must declare access, any of: officer, manager."],
      [{ access: ["officer", "guest"] }, "A page must declare access"],
      [{ access: "officer" }, "A page must declare access"],
      [{ access: null }, "A page must declare access"],
      [{ requires: undefined }, "A page must declare the services it requires"],
      [{ requires: "application" }, "A page must declare the services it requires"],
      [{ requires: ["application"] }, "A page must declare the services it requires"],
      [{ requires: [{ name: "fake" }] }, "A page must declare the services it requires"],
      [{ requires: [null] }, "A page must declare the services it requires"],
      [{ get: undefined }, "A page needs a get handler."],
      [{ get: "<p>x</p>" }, "A page needs a get handler."],
      [{ post: "handler" }, "A page's post handler must be a function."],
      // A form page declares its budget beside its handler, and only a form page.
      [
        { post: async () => ({ redirect: "/" }) },
        "A page with a post handler must declare postLimit",
      ],
      [
        { post: async () => ({ redirect: "/" }), postLimit: 0 },
        "A page with a post handler must declare postLimit, a positive whole number of POSTs per 10 minutes.",
      ],
      [{ post: async () => ({ redirect: "/" }), postLimit: -5 }, "must declare postLimit"],
      [{ post: async () => ({ redirect: "/" }), postLimit: 1.5 }, "must declare postLimit"],
      [{ post: async () => ({ redirect: "/" }), postLimit: "120" }, "must declare postLimit"],
      [{ post: async () => ({ redirect: "/" }), postLimit: Number.NaN }, "must declare postLimit"],
      [{ postLimit: 10 }, "A page's postLimit needs a post handler."],
      [{ nav: "" }, "A page's navigation label must be text."],
      [{ nav: " " }, "A page's navigation label must be text."],
      [{ nav: 1 }, "A page's navigation label must be text."],
      [{ icon: "rocket" }, "A page's icon must name one of the icons in icons.ts."],
      [{ icon: 1 }, "A page's icon must name one of the icons in icons.ts."],
    ];
    for (const [override, message] of cases)
      expect(() => Reflect.construct(Page, [{ ...base, ...override }])).toThrow(message);
  });
});

describe("loadPages", () => {
  test("every shipped page declares access, services and a server path", async () => {
    const pages = await loadPages();
    expect([...pages.keys()]).toContain("/g/:guild/status");
    for (const [path, page] of pages) {
      expect(page).toBeInstanceOf(Page);
      expect(page.path).toBe(path);
      expect(PAGE_PATH.test(path)).toBe(true);
      expect(page.access.length).toBeGreaterThan(0);
      for (const flag of page.access) expect(PAGE_ACCESS).toContain(flag);
      expect(page.requires.every((key) => key instanceof ServiceKey)).toBe(true);
    }
  });

  test("discovers nested pages in file-name order and ignores helpers", async () => {
    const pages = await loadPages(new URL("valid/", fixtures));
    expect([...pages.keys()]).toEqual(["/g/:guild/alpha", "/g/:guild/zeta"]);
  });

  test("a duplicate path or a malformed export fails discovery", async () => {
    await expect(loadPages(new URL("duplicates/", fixtures))).rejects.toThrow(
      "Duplicate page path: /g/:guild/twin",
    );
    await expect(loadPages(new URL("invalid/", fixtures))).rejects.toThrow("broken.page.ts");
  });

  test("a missing directory is an empty inventory", async () => {
    expect((await loadPages(new URL("intentionally-absent/", fixtures))).size).toBe(0);
  });
});

describe("the shell and /", () => {
  test("a visitor gets a sign-in link, not a form, and no account controls", async () => {
    const document = inspect(
      await render(layout({ title: "TaruBot", signedIn: false }, renderHome({ signedIn: false }))),
    );
    expect(document.querySelector("title")?.textContent).toBe("TaruBot");
    expect(document.querySelector("h1")?.textContent).toBe("TaruBot");
    expect(document.querySelector('a[href="/login"]')?.textContent).toBe("Sign in with Discord");
    expect(document.querySelectorAll("form, button")).toHaveLength(0);
    // The design's holographic budget: the sign-in link is the one primary button, and the
    // login card the one card with the turning edge.
    expect(
      [...document.querySelectorAll(".orr-btn--primary")].map((link) => link.getAttribute("href")),
    ).toEqual(["/login"]);
    expect(document.querySelectorAll(".orr-holo-edge")).toHaveLength(1);
    // Its heading is the wordmark, so there is no bar with a second one, and no account menu.
    expect(document.querySelectorAll(".entry-bar, .account")).toHaveLength(0);
    expect(document.body.classList.contains("entry-page")).toBe(true);
  });

  test("a signed-in user gets both sign-out forms and their servers, names escaped and isolated", async () => {
    const servers = HOSTILE.map((name, index) => ({
      id: `10000000000000000${index}`,
      name,
      links: [{ href: `/g/10000000000000000${index}/status`, label: "Status", current: false }],
    }));
    const markup = await render(
      layout(
        { title: "Your servers", signedIn: true, formToken: TOKEN },
        renderHome({ signedIn: true, servers }),
      ),
    );
    const document = inspect(markup);
    expect(document.querySelector("title")?.textContent).toBe("Your servers · TaruBot");
    const forms = [...document.querySelectorAll("form")].map((form) => [
      form.getAttribute("action"),
      form.querySelector("button")?.textContent,
    ]);
    expect(forms).toEqual([
      ["/logout", "Sign out"],
      ["/logout/all", "Sign out everywhere"],
    ]);
    // Each carries the session's form token, as inspect() requires of every form.
    expect(
      [...document.querySelectorAll(`form input[name="${FORM_TOKEN_FIELD}"]`)].map((input) =>
        input.getAttribute("value"),
      ),
    ).toEqual([TOKEN, TOKEN]);
    // Hostile names are text inside dir="auto" elements, never markup.
    expect(document.querySelectorAll("main img")).toHaveLength(0);
    expect(isolated(document)).toEqual(HOSTILE);
    expect(document.querySelectorAll('.servers a[href$="/status"]')).toHaveLength(HOSTILE.length);
    // Each tile's initials: letters and digits only, decorative, outside dir="auto".
    const initials = [...document.querySelectorAll(".servers .orr-avatar")].map((avatar) => [
      avatar.getAttribute("aria-hidden"),
      avatar.textContent,
    ]);
    expect(initials).toEqual([
      ["true", "IS"],
      ["true", "S"],
      ["true", "TO"],
      ["true", "TJ"],
    ]);
    // A page link's text is its label alone; the icons beside it add none.
    expect(document.querySelector('.servers a[href$="/status"]')?.textContent).toBe("Status");
  });

  test("a signed-in user with no servers is told so, with who the pages are for", async () => {
    const document = inspect(
      await render(
        layout(
          { title: "Your servers", signedIn: true, formToken: TOKEN },
          renderHome({ signedIn: true, servers: [] }),
        ),
      ),
    );
    expect(document.querySelector("main")?.textContent).toContain(
      "You don't have access to TaruBot's pages in any server right now.",
    );
    expect(document.querySelectorAll(".servers")).toHaveLength(0);
  });

  test("a server page shows its name isolated and the navigation with the current page", async () => {
    const officer: Actor = { guildId: GUILD, userId: USER, officer: true, manageRoles: false };
    const pages = await loadPages();
    const nav = navLinks(pages.values(), officer, "/g/:guild/status");
    const name = HOSTILE[1] ?? "";
    const document = inspect(
      await render(
        layout(
          { title: "Status", signedIn: true, formToken: TOKEN, guild: { id: GUILD, name, nav } },
          html`<p>Body</p>`,
        ),
      ),
    );
    expect(isolated(document)).toEqual([name]);
    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute("href")).toBe(`/g/${GUILD}/status`);
    expect(current?.textContent).toBe("Background work");
    expect(current?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Server pages");
    // The name appears once, in the switcher back to the server list; the top bar repeats only
    // the page's title, for sight.
    expect(document.querySelector('.server-switch[href="/"] [dir="auto"]')?.textContent).toBe(name);
    expect(document.querySelector(".topbar")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".topbar")?.textContent).toBe("Workspace/Status");
    expect(document.body.classList.contains("console-page")).toBe(true);
  });

  test("server initials take letters and digits only, on a hue fixed by the server ID", async () => {
    const avatar = async (id: string, name: string) =>
      parseHTML(`<p>${await render(serverAvatar({ id, name }))}</p>`).document.querySelector(
        ".orr-avatar",
      );
    for (const [name, initials] of [
      ["Example FC", "EF"],
      ["\u202eevil\u202c FC 2", "EF"],
      ["ﾀﾙﾀﾙ «SKY»", "ﾀS"],
      ["7th Heaven", "7H"],
      ["ｗｉｌｄ west", "ＷW"],
    ] as const)
      expect((await avatar(GUILD, name))?.textContent).toBe(initials);
    // No letter or digit at all: the decorative server icon instead of empty initials.
    const symbols = await avatar(GUILD, "★ ☆ ★");
    expect(symbols?.textContent).toBe("");
    expect(symbols?.querySelector("svg.orr-icon")).not.toBeNull();
    const hue = async (id: string, name: string) =>
      [...((await avatar(id, name))?.classList ?? [])].filter((name) =>
        name.startsWith("orr-avatar--hue-"),
      );
    expect(await hue(GUILD, "Example FC")).toEqual(await hue(GUILD, "Renamed"));
    expect((await hue(GUILD, "Example FC"))[0]).toMatch(/^orr-avatar--hue-[0-7]$/u);
    const hues = new Set<string>();
    for (let index = 0; index < 64; index += 1)
      hues.add((await hue(`1000000000000000${String(index).padStart(2, "0")}`, "x"))[0] ?? "");
    expect(hues.size).toBe(8);
  });

  test("a re-rendered form's title starts with Error:, and its heading doesn't", async () => {
    const guild = { id: GUILD, name: "Example FC", nav: [] };
    const model = { title: "Role menu", signedIn: true, formToken: TOKEN, guild } as const;
    const refused = inspect(await render(layout({ ...model, error: true }, html`<p>Body</p>`)));
    expect(refused.querySelector("title")?.textContent).toBe("Error: Role menu · TaruBot");
    expect(refused.querySelector("h1")?.textContent).toBe("Role menu");
    const shown = inspect(await render(layout(model, html`<p>Body</p>`)));
    expect(shown.querySelector("title")?.textContent).toBe("Role menu · TaruBot");
  });

  test("the no-access page explains itself and sets nothing up", async () => {
    const document = inspect(
      await render(layout({ title: "No access", signedIn: false }, renderNoAccess())),
    );
    expect(document.querySelector("main")?.textContent).toContain("you aren't signed in");
    expect(document.querySelectorAll("form")).toHaveLength(0);
    expect(document.querySelector('main a[href="/"]')).not.toBeNull();
  });
});

describe("error pages", () => {
  test("show the approved message escaped, then Code and Ref", async () => {
    const details = problemOf(
      new Failure("expired", "That sign-in expired. <b>Sign in again.</b>"),
      REF,
    );
    const markup = await render(errorPage(details, TOKEN));
    const document = inspect(markup);
    expect(document.querySelector("h1")?.textContent).toBe("That didn't go through");
    expect(document.querySelector("main p")?.textContent).toBe(
      "That sign-in expired. <b>Sign in again.</b>",
    );
    expect(document.querySelector("main b")).toBeNull();
    expect(document.querySelector(".ref")?.textContent).toBe(`Code expired · Ref ${REF}`);
    expect(document.querySelectorAll("form")).toHaveLength(2);
  });

  test("never show an unexpected error's text, and name a wait in seconds", async () => {
    const secret = "connection string postgres://user:password@db";
    const markup = await render(errorPage(problemOf(new Error(secret), REF), null));
    expect(markup).not.toContain("postgres://");
    expect(inspect(markup).querySelector("h1")?.textContent).toBe("Something went wrong");
    const wait = await render(
      errorPage(problemOf(new Failure("cooldown", "Slow down.", 30), REF), null),
    );
    expect(inspect(wait).querySelector("main")?.textContent).toContain(
      "Try again in about 30 seconds.",
    );
    // A long wait (a spent POST budget) reads in minutes, rounded up.
    for (const [seconds, words] of [
      [1, "1 second"],
      [119, "119 seconds"],
      [120, "2 minutes"],
      [121, "3 minutes"],
      [600, "10 minutes"],
    ] as const) {
      const page = await render(
        errorPage(problemOf(new Failure("rate_limited", "Slow down.", seconds), REF), null),
      );
      expect(inspect(page).querySelector("main")?.textContent).toContain(
        `Try again in about ${words}.`,
      );
    }
  });

  test("every status has a heading and a sentence", async () => {
    for (const status of [400, 403, 404, 405, 409, 413, 415, 429, 500, 503, 418, 502] as const) {
      const document = inspect(
        await render(
          errorPage(
            { status, code: "input", ref: REF, message: null, retryAfter: 0, level: "info" },
            null,
          ),
        ),
      );
      expect((document.querySelector("h1")?.textContent ?? "").length).toBeGreaterThan(3);
      expect((document.querySelector("main p")?.textContent ?? "").length).toBeGreaterThan(10);
    }
  });
});

describe("Status", () => {
  const at = new Date("2026-10-04T21:37:42.000Z");

  /** A job row as syncStatus returns it. */
  const job = (overrides: Partial<JobView & { user_id: string | null }>) => ({
    id: "1a2b3c4d-0000-4000-8000-000000000001",
    kind: "reconcile.user",
    status: "queued",
    attempts: 0,
    due_at: at,
    created_at: at,
    completed_at: null,
    last_error: null,
    result: null,
    user_id: USER,
    ...overrides,
  });

  const run: SyncRunRow = {
    id: "9d8c7b6a-0000-4000-8000-000000000002",
    created_at: at,
    enumeration_completed_at: null,
    requester_id: USER,
    acquisition_kind: "roster",
    acquisition_status: "failed",
    last_error: "invalid_response: secret-run-diagnostic <@200000000000000002>",
    result: null,
    status: "failed",
    work_total: 40,
    work_completed: 38,
    work_blocked: 0,
    work_failed: 2,
    completed_at: null,
  };

  const view: SyncStatusView = {
    effectsMode: "live",
    runs: [run],
    work: [
      job({
        status: "blocked",
        last_error:
          "blocked: Missing Permissions in channel 123456789012345678 secret-job-diagnostic",
      }),
      job({
        kind: "guest.dm",
        status: "failed",
        attempts: 1,
        last_error: "dm_blocked: secret-dm-diagnostic",
      }),
      job({ kind: "roster", attempts: 2, last_error: "cooldown: Lodestone cooldown 30s" }),
      job({ kind: "<img src=x onerror=alert(1)>" }),
      job({ kind: "roles.layout", status: "running", attempts: 1 }),
      job({ kind: "officer.notify", status: "disabled" }),
    ],
  };

  /** The discovered page reads prototype-backed services without writing or fetching Discord. */
  async function statusPage(sync: SyncStatusView) {
    const app: unknown = Object.create(Service.prototype);
    if (!(app instanceof Service)) throw new Error("Invalid application fixture");
    app.syncStatus = async () => sync;
    const gateway: unknown = Object.create(DiscordGateway.prototype);
    if (!(gateway instanceof DiscordGateway)) throw new Error("Invalid gateway fixture");
    Object.defineProperty(gateway, "client", { value: { guilds: { cache: new Map() } } });
    const lifecycle: unknown = Object.create(ApplicationLifecycle.prototype);
    if (!(lifecycle instanceof ApplicationLifecycle)) throw new Error("Invalid lifecycle fixture");
    // Every global or diagnostic figure is a recognisable number, so the page can be searched.
    lifecycle.status = () => ({
      live: true,
      ready: true,
      database: true,
      writerLease: true,
      discord: false,
      effects: true,
      publicTestResponses: false,
      capabilities: { detail: "capability-7770" },
      lodestone: {
        parsing: 7771,
        waiting: 7772,
        cooldownSeconds: 30,
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
      visibility: {
        missing: 7776,
        onboardingPending: 7777,
        checked: 7778,
        checkedAt: "2026-10-04T00:00:00.000Z",
      },
    });
    const page = (await loadPages()).get("/g/:guild/status");
    if (!page) throw new Error("Status page not discovered");
    const actor: Actor = { guildId: GUILD, userId: USER, officer: true, manageRoles: false };
    const session: Session = {
      userId: USER,
      createdAt: at,
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: at,
    };
    const context: PageContext = {
      request: new Request(`https://example.org/g/${GUILD}/status`),
      url: new URL(`https://example.org/g/${GUILD}/status`),
      session,
      actor,
      guildId: GUILD,
      services: new Services()
        .provide(applicationKey, app)
        .provide(lifecycleKey, lifecycle)
        .provide(gatewayKey, gateway),
      formToken: TOKEN,
      report: () => {},
      ref: REF,
    };
    // The template result itself goes into the layout; its rendered string would be escaped.
    const body = await page.get(context);
    const main = await render(body);
    const markup = await render(
      layout(
        {
          title: page.title,
          signedIn: true,
          formToken: TOKEN,
          guild: { id: GUILD, name: "Example FC", nav: navLinks([page], actor, page.path) },
        },
        body,
      ),
    );
    return { main, markup };
  }

  /** Pure rendering also supports callers without a cached-name snapshot. */
  async function statusBody(sync: SyncStatusView, names?: WebNames) {
    const markup = await render(
      renderStatus({
        process: { ready: false, discord: true, database: false, lodestone: "available" },
        sync,
        ...(names === undefined ? {} : { names }),
      }),
    );
    return parseHTML(`<html><body>${markup}</body></html>`).document;
  }

  test("keeps health words and failure states in one featured read-only panel", async () => {
    const document = inspect((await statusPage(view)).markup);
    const health = document.querySelector(".featured");
    expect(document.querySelectorAll(".featured")).toHaveLength(1);
    expect(health?.querySelectorAll(".check")).toHaveLength(5);
    expect(health?.querySelectorAll(".check-ok")).toHaveLength(3);
    expect(health?.querySelectorAll(".check-fail")).toHaveLength(1);
    expect(health?.querySelectorAll(".check-wait")).toHaveLength(1);
    expect(health?.textContent).toContain("Discord");
    expect(health?.textContent).toContain("Database");
    expect(health?.textContent).toContain("Lodestone");
    const failed = await statusBody({ effectsMode: "live", runs: [], work: [] });
    expect(failed.querySelector(".featured")?.querySelectorAll(".check-fail")).toHaveLength(2);
    expect(document.querySelector("main")?.querySelectorAll("form, button, input")).toHaveLength(0);
  });

  test("shows actual sampled markers, raw kinds and safely disclosed diagnostics", async () => {
    const document = inspect((await statusPage(view)).markup);
    const table = document.querySelector('table[aria-describedby="work-sample"]');
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(view.work.length);
    for (const marker of ["blocked", "failed", "waiting", "queued", "running", "paused"])
      expect(table?.querySelectorAll(`.marker-${marker}`)).toHaveLength(1);
    expect(table?.textContent).toContain("reconcile.user");
    expect(table?.textContent).toContain("Role update");
    expect(table?.textContent).toContain("secret-job-diagnostic");
    expect(table?.textContent).toContain("secret-dm-diagnostic");
    expect(table?.textContent).toContain("the decision still stands");
    expect(table?.textContent).toContain("1a2b3c4d-0000-4000-8000-000000000001");
    expect(table?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelectorAll("main img")).toHaveLength(0);
    for (const details of table?.querySelectorAll("details") ?? [])
      expect((details.querySelector("summary")?.textContent ?? "").trim()).not.toBe("");
    for (const data of document.querySelectorAll("table")) {
      expect((data.querySelector("caption")?.textContent ?? "").trim()).not.toBe("");
      for (const heading of data.querySelectorAll("thead th"))
        expect(heading.getAttribute("scope")).toBe("col");
      for (const row of data.querySelectorAll("tbody tr"))
        expect(row.querySelector("th")?.getAttribute("scope")).toBe("row");
    }
  });

  test("a member's role choices show 'A member', never who; other jobs keep their user", async () => {
    const choice = {
      ...job({ kind: "roles.self", user_id: null }),
      id: "1a2b3c4d-0000-4000-8000-000000000009",
    };
    const document = await statusBody({
      effectsMode: "live",
      runs: [],
      work: [choice, job({ user_id: null }), job({})],
    });
    const users = [...document.querySelectorAll("tbody tr")].map((row) => {
      const term = [...row.querySelectorAll("dt")].find((dt) => dt.textContent === "User");
      return term?.nextElementSibling?.textContent;
    });
    expect(users).toEqual(["A member", "No user attached", USER]);
  });

  test("counts displayed work only and separates waiting from queued", async () => {
    const document = inspect((await statusPage(view)).markup);
    expect(document.querySelector("#work-sample")?.textContent).toContain("Limited sample");
    expect(document.querySelector("#work-sample")?.textContent).toContain("up to 25");
    const metrics = [...document.querySelectorAll(".metrics dd")].map((dd) =>
      Number(dd.textContent),
    );
    expect(metrics).toHaveLength(6);
    expect(metrics.reduce((sum, count) => sum + count, 0)).toBe(view.work.length);
    expect(
      document.querySelector(".metrics .marker-queued")?.closest("div")?.querySelector("dd")
        ?.textContent,
    ).toBe("1");
    expect(
      document.querySelector(".metrics .marker-waiting")?.closest("div")?.querySelector("dd")
        ?.textContent,
    ).toBe("1");
    expect(document.querySelector(".metrics .marker-done")).toBeNull();
    expect(document.querySelector('table[aria-describedby="work-sample"] .marker-done')).toBeNull();
  });

  test("renders UTC timestamps without inventing a running-job start time", async () => {
    const document = inspect((await statusPage(view)).markup);
    const times = [...document.querySelectorAll("time")];
    expect(times.length).toBeGreaterThan(0);
    for (const element of times) {
      expect(element.getAttribute("datetime")).toBe("2026-10-04T21:37:42.000Z");
      expect(element.textContent).toBe("2026-10-04 21:37 UTC");
    }
    const running = document
      .querySelector('table[aria-describedby="work-sample"] .marker-running')
      ?.closest("tr");
    expect(running?.textContent).toContain("Added");
    expect(running?.textContent).not.toContain("Started");
  });

  test("keeps process-wide figures and diagnostics out of server views", async () => {
    const { markup } = await statusPage(view);
    for (const figure of ["7770", "7771", "7772", "7773", "7774", "7775", "7776", "7777", "7778"])
      expect({ figure, shown: markup.includes(figure) }).toEqual({ figure, shown: false });
    expect(markup).not.toContain("lodestone-css-selectors");
  });

  test("resolves officer diagnostic mentions without exposing hidden names or unsafe markup", async () => {
    const hidden = "123456789012345678";
    const role = "300000000000000003";
    const names: WebNames = {
      users: new Map([[USER, HOSTILE[0]]]),
      roles: new Map([[role, HOSTILE[1]]]),
      channels: new Map([[hidden, null]]),
    };
    const document = await statusBody(
      {
        effectsMode: "live",
        runs: [],
        work: [
          job({
            last_error: `blocked: <@${USER}> <@&${role}> <#${hidden}> <t:1700000000:F> <script>unsafe()</script>`,
            result: { secret: "unrelated-payload-secret" },
          }),
        ],
      },
      names,
    );
    expect(document.querySelectorAll("script, img")).toHaveLength(0);
    expect(document.body.textContent).toContain(HOSTILE[0]);
    expect(document.body.textContent).toContain(HOSTILE[1]);
    expect(document.body.textContent).toContain("<script>unsafe()</script>");
    expect(document.body.textContent).toMatch(/channel.*TaruBot|TaruBot.*channel/iu);
    expect(document.body.textContent).not.toContain(`<#${hidden}>`);
    expect(document.body.textContent).not.toContain("unrelated-payload-secret");
    expect(isolated(document)).toContain(HOSTILE[0]);
    expect(document.querySelector(".diagnostic .mention [dir=auto]")?.textContent).toContain(
      HOSTILE[1],
    );
    expect(document.querySelector(".diagnostic time")?.getAttribute("datetime")).toBe(
      new Date(1700000000 * 1000).toISOString(),
    );
    expect(document.querySelector(".diagnostic time")?.textContent).toContain("UTC");
  });

  test("distinguishes a scheduled wait from a retry without implying either already ran", async () => {
    const document = await statusBody({
      effectsMode: "live",
      runs: [],
      work: [
        job({ last_error: "cooldown: Lodestone cooldown", attempts: 0 }),
        job({ last_error: "network: unreachable", attempts: 3 }),
      ],
    });
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll(".marker-waiting")).toHaveLength(1);
      expect(row.textContent).not.toContain("Completed");
    }
    expect(rows[0]?.textContent).toContain("Next");
    expect(rows[1]?.textContent).toContain("Retry");
  });

  test("preserves run progress and failed acquisition even when child totals say completed", async () => {
    const document = await statusBody({
      effectsMode: "live",
      runs: [{ ...run, status: "completed" }],
      work: [],
    });
    const row = document.querySelector("tbody tr");
    expect(row?.textContent).toContain("Completed");
    expect(row?.textContent).toContain("38/40 done");
    expect(row?.textContent).toContain("2 failed");
    expect(row?.querySelectorAll(".marker-failed")).toHaveLength(1);
    expect(row?.textContent).toContain("secret-run-diagnostic");
    expect(row?.textContent).toContain(run.id);
    expect(row?.textContent).toContain("invalid_response");
  });

  test("preserves paused, waiting and skipped acquisition states and DM decision semantics", async () => {
    for (const [status, last_error, result, marker] of [
      ["disabled", null, null, "paused"],
      ["queued", "cooldown: wait", null, "waiting"],
      ["succeeded", null, { skipped: "Nothing changed <@200000000000000002>" }, "skipped"],
      ["failed", "dm_blocked: refused", null, "failed"],
    ] as const) {
      const document = await statusBody({
        effectsMode: "deployment_disabled",
        runs: [
          {
            ...run,
            status: "blocked",
            acquisition_status: status,
            last_error,
            result,
            work_failed: 0,
            work_blocked: 2,
          },
        ],
        work: [],
      });
      const row = document.querySelector("tbody tr");
      expect(row?.textContent).toContain("Paused");
      expect(row?.textContent).toContain("38/40 done");
      expect(row?.textContent).toContain("2 held");
      expect(row?.querySelectorAll(`.marker-${marker}`)).toHaveLength(1);
      if (marker === "skipped") expect(row?.textContent).toContain("Nothing changed");
      if (last_error?.startsWith("dm_blocked"))
        expect(row?.textContent).toContain("the decision still stands");
    }
  });

  test("distinguishes pending activation from deployment-disabled effects", async () => {
    const waiting = inspect(
      (await statusPage({ effectsMode: "awaiting_activation", runs: [], work: [] })).markup,
    );
    expect(waiting.querySelector(".featured")?.querySelectorAll(".check-wait")).toHaveLength(2);
    const off = await statusBody({ effectsMode: "deployment_disabled", runs: [], work: [] });
    expect(off.querySelector(".featured")?.querySelectorAll(".check-off")).toHaveLength(1);
  });

  test("draws health as the featured card, counts as stats and tables in labelled regions", async () => {
    const document = inspect((await statusPage(view)).markup);
    // The one holographic card is process health, named by its heading; readiness leads.
    const health = document.querySelector(".featured");
    expect(health?.matches("section.orr-card.orr-card--holo.orr-holo-edge")).toBe(true);
    expect(document.querySelectorAll(".orr-card--holo, .orr-holo-edge")).toHaveLength(1);
    expect(health?.getAttribute("aria-labelledby")).toBe("process-health");
    expect(health?.querySelector("h2#process-health")?.textContent).toBe("Process health");
    expect(health?.querySelector("li .check-copy")?.textContent).toBe("Ready");
    // Each count is a stat: the marker badge as its dt, the count as its dd.
    const stats = [...document.querySelectorAll(".metrics > div")];
    expect(stats).toHaveLength(6);
    for (const stat of stats) {
      expect(stat.matches(".orr-stat")).toBe(true);
      expect(stat.firstElementChild?.matches("dt.orr-stat__label")).toBe(true);
      expect(stat.firstElementChild?.querySelectorAll(".marker")).toHaveLength(1);
      expect(stat.lastElementChild?.matches("dd.orr-stat__value")).toBe(true);
    }
    // A table scrolls in its own focusable region, which its caption names; the table points
    // at the sentence that describes its sample.
    const regions = [...document.querySelectorAll("main .table-scroll")];
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.getAttribute("role")).toBe("region");
      expect(region.getAttribute("tabindex")).toBe("0");
      const table = region.querySelector("table.orr-table");
      expect(region.getAttribute("aria-labelledby")).toBe(
        table?.querySelector("caption")?.getAttribute("id") ?? "",
      );
      const sample = document.getElementById(table?.getAttribute("aria-describedby") ?? "");
      expect(sample?.textContent).toContain("for this server");
      // Every row discloses its details once, named by the row's short ID.
      for (const row of table?.querySelectorAll("tbody tr") ?? []) {
        const details = row.querySelectorAll("details");
        expect(details).toHaveLength(1);
        expect(details[0]?.querySelector("summary")?.textContent).toMatch(/details [0-9a-f]{8}$/u);
      }
    }
  });

  test("an empty sample says so, says how to start work, and draws no table", async () => {
    const document = inspect(
      (await statusPage({ effectsMode: "live", runs: [], work: [] })).markup,
    );
    const main = document.querySelector("main");
    expect(main?.querySelectorAll("table, .table-scroll")).toHaveLength(0);
    // Each empty state is its statement, then the guidance, in one box.
    expect(
      [...(main?.querySelectorAll(".empty-state") ?? [])].map((box) =>
        [...box.children].map((paragraph) => [paragraph.tagName, paragraph.textContent]),
      ),
    ).toEqual([
      [
        ["P", "No outstanding work in this limited sample."],
        ["P", "Request work in Discord, then reload this page to see its progress."],
      ],
      [
        ["P", "No recent refresh runs to display."],
        ["P", "Request a refresh in Discord to start a new run."],
      ],
    ]);
    expect([...(main?.querySelectorAll(".metrics dd") ?? [])].map((dd) => dd.textContent)).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  test("every class the view renders has a rule in the stylesheet", async () => {
    // Hooks no rule needs: .featured is drawn by the card classes beside it, and the neutral
    // status tokens keep the base .check and .marker look (styles/components.ts).
    const drawnByOthers = new Set([
      "featured",
      "check-off",
      "marker-queued",
      "marker-paused",
      "marker-skipped",
    ]);
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    const runs = (["queued", "completed", "blocked", "failed"] as const).map((status) => ({
      ...run,
      status,
      work_blocked: 1,
    }));
    const views = [
      parseHTML((await statusPage(view)).main).document,
      await statusBody({
        effectsMode: "live",
        runs: [...runs, { ...run, acquisition_status: "succeeded" }],
        work: [],
      }),
      await statusBody({
        effectsMode: "deployment_disabled",
        runs: [
          { ...run, status: "blocked", acquisition_status: "disabled" },
          { ...run, acquisition_status: "succeeded", result: { skipped: "Nothing changed" } },
        ],
        work: [job({ status: "succeeded", completed_at: at })],
      }),
      await statusBody({ effectsMode: "awaiting_activation", runs: [], work: [] }),
    ];
    const classes = new Set<string>();
    for (const document of views)
      for (const element of document.querySelectorAll("[class]"))
        for (const name of element.classList) classes.add(name);
    for (const marker of ["blocked", "failed", "waiting", "queued", "running", "paused", "done"])
      expect(classes.has(`marker-${marker}`)).toBe(true);
    for (const state of ["queued", "completed", "blocked", "paused", "failed"])
      expect(classes.has(`run-outcome--${state}`)).toBe(true);
    for (const name of classes) {
      if (drawnByOthers.has(name)) continue;
      expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
        name,
        styled: true,
      });
    }
  });

  test("every table part names its role, and a stacked card's labels name their columns", async () => {
    const document = inspect((await statusPage(view)).markup);
    const tables = [...document.querySelectorAll("main table")];
    expect(tables).toHaveLength(2);
    // A phone's stacked cards change every table element's display, which some browsers take as
    // the end of the table: explicit roles keep it one, beside the pinned scopes and caption.
    for (const table of tables) {
      expect(table.getAttribute("role")).toBe("table");
      expect(table.closest('.table-scroll[role="region"][tabindex="0"]')).not.toBeNull();
      expect((table.querySelector("caption")?.textContent ?? "").trim()).not.toBe("");
      for (const group of table.querySelectorAll("thead, tbody"))
        expect(group.getAttribute("role")).toBe("rowgroup");
      for (const row of table.querySelectorAll("tr")) expect(row.getAttribute("role")).toBe("row");
      for (const heading of table.querySelectorAll("thead th"))
        expect([heading.getAttribute("role"), heading.getAttribute("scope")]).toEqual([
          "columnheader",
          "col",
        ]);
      for (const heading of table.querySelectorAll("tbody th"))
        expect([heading.getAttribute("role"), heading.getAttribute("scope")]).toEqual([
          "rowheader",
          "row",
        ]);
      for (const cell of table.querySelectorAll("td"))
        expect(cell.getAttribute("role")).toBe("cell");
      const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
      for (const row of table.querySelectorAll("tbody tr")) {
        // One cell per column: the row header, the state a card puts beside it, and the
        // disclosure, always in the last cell, closing the card.
        const cells = [...row.children];
        expect(cells).toHaveLength(headers.length);
        expect(cells[0]?.matches('th[scope="row"]')).toBe(true);
        expect(cells[1]?.matches("td.row-state")).toBe(true);
        expect(cells.at(-1)?.querySelectorAll("details")).toHaveLength(1);
        expect(row.querySelectorAll("details")).toHaveLength(1);
        // A label is its cell's own column name, out of the accessibility tree, which reads the
        // column header from the roles instead.
        for (const [index, cell] of cells.entries())
          for (const label of cell.querySelectorAll(".cell-label")) {
            expect(label.parentElement === cell).toBe(true);
            expect(label.getAttribute("aria-hidden")).toBe("true");
            expect(label.textContent).not.toBe("");
            expect(headers[index]?.startsWith(label.textContent ?? "")).toBe(true);
          }
      }
    }
    const work = [...document.querySelectorAll('table[aria-describedby="work-sample"] tbody tr')];
    const runs = [...document.querySelectorAll('table[aria-describedby="run-sample"] tbody tr')];
    expect([work.length, runs.length]).toEqual([view.work.length, view.runs.length]);
    for (const row of work) {
      expect(row.querySelectorAll(".row-state .marker")).toHaveLength(1);
      // Work labels itself: its name, marker, attempts, moments and summary each say what they are.
      expect(row.querySelectorAll(".cell-label")).toHaveLength(0);
    }
    for (const row of runs) {
      expect(row.querySelectorAll(".row-state .run-outcome")).toHaveLength(1);
      expect([...row.querySelectorAll(".cell-label")].map((label) => label.textContent)).toEqual([
        "Progress",
        "Acquisition",
      ]);
    }
    for (const moment of document.querySelectorAll("main .moment"))
      expect((moment.querySelector(".orr-label")?.textContent ?? "").trim()).not.toBe("");
  });

  test("the stylesheet stacks rows into cards only on narrow screens and keeps them a table", () => {
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    const query = "@media screen and (max-width: 47.99rem) {";
    const at = css.indexOf(query);
    expect(at).toBeGreaterThan(-1);
    const cards = css.slice(at, css.indexOf("\n}\n", at));
    const rule = (text: string, selector: string): string => {
      const start = text.indexOf(`${selector} {`);
      return start < 0 ? "" : text.slice(start, text.indexOf("}", start));
    };
    // Each row becomes a card; the column headers leave the screen but stay for assistive
    // technology (clipped, never display: none), and only there do the column labels show.
    expect(rule(cards, ".status-table > tbody > tr")).toContain("display: grid;");
    expect(rule(cards, ".status-table > thead")).toContain("clip-path: inset(50%);");
    expect(rule(cards, ".status-table > thead")).not.toContain("display: none");
    expect(rule(cards, ".status-table td > .cell-label")).toContain("display: block;");
    expect(rule(css.slice(0, at), ".cell-label")).toContain("display: none;");
    // A card stack has no sideways scroll to fall back on, and must not clip its cards' edges.
    expect(rule(cards, ".status-section > .table-scroll")).toContain("overflow: visible;");
  });

  test("display: contents never lands on a table part, in any layout", async () => {
    // display: contents drops a table part from the accessibility tree in some browsers. The
    // populated page has every row and cell shape the stacked cards target, so each selector that
    // sets it runs against real markup; one the parser can't read throws and fails the test.
    const document = inspect((await statusPage(view)).markup);
    expect(document.querySelectorAll("main table")).toHaveLength(2);
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    // A selector list splits at its top-level commas only, so :not(a, b) stays one selector.
    const selectors = (list: string): string[] => {
      const parts = [""];
      let depth = 0;
      for (const character of list) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) parts.push("");
        else parts[parts.length - 1] += character;
      }
      return parts.map((part) => part.trim());
    };
    const found = [...css.matchAll(/([^{}]+)\{[^{}]*display: contents;/gu)].flatMap((match) =>
      selectors(match[1] ?? ""),
    );
    expect(found.length).toBeGreaterThan(0);
    for (const selector of found) {
      const parts = [...document.querySelectorAll(selector)]
        .map((element) => element.tagName.toLowerCase())
        .filter((tag) => ["table", "caption", "thead", "tbody", "tr", "th", "td"].includes(tag));
      // A bare table tag at the end is caught even where the page renders no match for it.
      const bare = /\b(?:table|caption|thead|tbody|tr|th|td)$/u.test(selector);
      expect({ selector, parts, bare }).toEqual({ selector, parts: [], bare: false });
    }
  });
});

describe("Role menu (2.39.0)", () => {
  const officer: Actor = { guildId: GUILD, userId: USER, officer: true, manageRoles: false };
  const path = `/g/${GUILD}/role-menu`;
  const NEW_ID = "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const names = guildNames(harnessGateway(), GUILD);

  /** The harness's editor state for a review state, with any field replaced. */
  const editor = async (
    states: HarnessStates = {},
    overrides: Partial<SelfRoleEditor> = {},
  ): Promise<SelfRoleEditor> => ({
    ...(await harnessSelfRoles(states).editor(officer)),
    ...overrides,
  });

  /** The whole document for an editor state, as the page renders it. */
  async function rolePage(
    state: SelfRoleEditor,
    options: { refused?: RefusedEdit; url?: string; names?: WebNames } = {},
  ): Promise<Document> {
    const nav = navLinks((await loadPages()).values(), officer, "/g/:guild/role-menu");
    return inspect(
      await render(
        layout(
          {
            title: "Role menu",
            signedIn: true,
            formToken: TOKEN,
            guild: { id: GUILD, name: "Example FC", nav },
            ...(options.refused && { error: true }),
          },
          renderRoleMenu({
            editor: state,
            names: options.names ?? names,
            action: path,
            token: TOKEN,
            url: new URL(options.url ?? path, "https://example.org"),
            newCategoryId: NEW_ID,
            ...(options.refused && { refused: options.refused }),
          }),
        ),
      ),
    );
  }

  /** Text without the visually hidden suffixes: what a sighted officer reads. */
  const visibleText = (element: Element): string => {
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".visually-hidden")) hidden.remove();
    return (copy.textContent ?? "").trim();
  };

  /** The card of the category `id`. */
  const card = (document: Document, id: string) => document.querySelector(`#category-${id}`);

  test("the page module: officers only, its two services, and a budget of 120 POSTs", async () => {
    const page = (await loadPages()).get("/g/:guild/role-menu");
    expect(page?.access).toEqual(["officer"]);
    expect(page?.requires).toEqual([selfRolesKey, gatewayKey]);
    expect(page?.postLimit).toBe(120);
    expect(page?.nav).toBe("Role menu");
    expect(page?.icon).toBe("list");
    // Officers' navigation, in path order.
    expect(navLinks((await loadPages()).values(), officer).map((link) => link.label)).toEqual([
      "Server configuration",
      "Role menu",
      "Background work",
    ]);
  });

  test("each category shows what members will see: state, limit, roles, descriptions and Opens", async () => {
    const document = await rolePage(await editor());
    const cards = [...document.querySelectorAll(".menu-category")];
    expect(cards.map((item) => visibleText(item.querySelector("h3") as Element))).toEqual([
      "Pronouns",
      "Games",
      "Content",
      "Retired events",
    ]);
    // The state comes before the heading, so the heading says it too, for anyone moving by
    // heading; the badge itself is hidden from assistive technology, so reading on doesn't repeat
    // it.
    expect(cards.map((item) => item.querySelector("h3")?.textContent)).toEqual([
      "Pronouns (published)",
      "Games (published)",
      "Content (draft)",
      "Retired events (not offered)",
    ]);
    for (const item of cards)
      expect(
        item.querySelector(".menu-category__meta .orr-badge")?.getAttribute("aria-hidden"),
      ).toBe("true");
    expect(
      cards.map((item) =>
        [...(item.querySelector(".menu-category__meta")?.children ?? [])].map(
          (part) => part.textContent,
        ),
      ),
    ).toEqual([
      ["Published", "Pick any number"],
      ["Published", "Pick any number"],
      ["Draft", "Pick up to 2"],
      ["Not offered", "Pick one"],
    ]);
    const games = card(document, MENU_CATEGORY.games);
    expect(
      [...(games?.querySelectorAll(".menu-option") ?? [])].map((option) => [
        option.querySelector(".menu-option__role .mention")?.textContent,
        option.querySelector(".menu-option__desc")?.textContent,
        option.querySelector(".menu-option__opens")?.textContent,
      ]),
    ).toEqual([
      ["@Valheim", "Our dedicated server.", "Opens: #valheim, #valheim-voice"],
      ["@Minecraft", "The FC's survival world.", "Opens: #minecraft"],
    ]);
    // A role no longer offered says so; nothing has a problem in the healthy state.
    expect(
      card(document, MENU_CATEGORY.pronouns)?.querySelector(".menu-option__role .orr-badge")
        ?.textContent,
    ).toBe("Not offered");
    expect(document.querySelectorAll(".menu-problems, .notice--warning")).toHaveLength(0);
    // The one featured card, with the one primary button: Publish the draft.
    expect(document.querySelectorAll(".featured, .orr-holo-edge")).toHaveLength(1);
    expect(document.querySelector(".menu-summary__title")?.textContent).toBe(
      "1 draft isn't published yet.",
    );
    expect(
      [...document.querySelectorAll(".orr-btn--primary")].map((button) => button.textContent),
    ).toEqual(["Publish 1 draft"]);
    // What publishing does, as 2.39.0 has it: nobody picks roles yet, so not "at once" (UX-3);
    // the line describes the button, so it is heard with it (UX-8).
    const publish = document.querySelector(".orr-btn--primary");
    const publishHelp = document.getElementById(publish?.getAttribute("aria-describedby") ?? "");
    expect(publishHelp?.textContent).toBe(
      "Published categories go live for members and guests with the release that lets them pick roles. If you're replacing a reaction-role bot, keep drafts until you switch over.",
    );
    expect(document.querySelector("main")?.textContent).not.toContain("at once");
    // The readouts add up: every category is published, not offered or a draft (UX-11).
    expect(
      [...document.querySelectorAll(".menu-summary__count")].map((count) => [
        count.querySelector("dt")?.textContent,
        count.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Published", "2"],
      ["Not offered", "1"],
      ["Drafts", "1"],
      [
        "Roles",
        String(cards.reduce((n, item) => n + item.querySelectorAll(".menu-option").length, 0)),
      ],
    ]);
    // Each state button is described by its own line of help (UX-8).
    for (const button of document.querySelectorAll('.menu-state button[type="submit"]')) {
      const help = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect({
        button: button.textContent,
        help: help?.parentElement === button.parentElement,
      }).toEqual({
        button: button.textContent,
        help: true,
      });
      expect(help?.classList.contains("note")).toBe(true);
    }
    expect(
      document.querySelectorAll(".menu-state button[aria-describedby]").length,
    ).toBeGreaterThan(0);
    // Each Edit roles row's state choices say their consequence (UX-8).
    expect(
      [...(games?.querySelector('select[name^="state:"]')?.querySelectorAll("option") ?? [])].map(
        (choice) => choice.textContent,
      ),
    ).toEqual([
      "Offered",
      "Not offered: people who have it can remove it",
      "Remove from the menu: people keep it, but can't change it here",
    ]);
  });

  test("the state buttons a category offers follow its state, each with its line of help", async () => {
    const document = await rolePage(await editor());
    const states = (id: string) =>
      [...(card(document, id)?.querySelectorAll(".menu-state") ?? [])].map((form) => [
        form.querySelector('input[name="state"]')?.getAttribute("value"),
        visibleText(form.querySelector("button") as Element),
        form.querySelector(".note")?.textContent,
      ]);
    // Members and guests can't pick roles before 2.40.0, so publishing is said as what will happen.
    const publish =
      "Once members and guests can pick roles, everyone with Member or Guest can pick these.";
    const stop =
      "Nobody can add these roles. People who have them will still be able to remove them themselves.";
    const draft =
      "Only officers see a draft. People who have these roles won't be able to change them until you publish again. Nobody's roles change.";
    expect(states(MENU_CATEGORY.pronouns)).toEqual([
      ["removal_only", "Stop offering", stop],
      ["draft", "Move back to draft", draft],
    ]);
    expect(states(MENU_CATEGORY.content)).toEqual([["published", "Publish", publish]]);
    expect(states(MENU_CATEGORY.retired)).toEqual([
      ["published", "Publish", publish],
      ["draft", "Move back to draft", draft],
    ]);
    // Moves name absolute places: the first can only go down, the last only up.
    const moves = (id: string) =>
      [...(card(document, id)?.querySelectorAll(".menu-move") ?? [])].map((form) => [
        visibleText(form.querySelector("button") as Element),
        form.querySelector('input[name="to"]')?.getAttribute("value"),
      ]);
    expect(moves(MENU_CATEGORY.pronouns)).toEqual([["Move down", "1"]]);
    expect(moves(MENU_CATEGORY.games)).toEqual([
      ["Move up", "0"],
      ["Move down", "2"],
    ]);
    expect(moves(MENU_CATEGORY.retired)).toEqual([["Move up", "2"]]);
  });

  test("fieldsets have legends, every control a label, and every button visible text", async () => {
    const document = await rolePage(await editor({ menuProblems: true }));
    const fieldsets = [...document.querySelectorAll("main fieldset")];
    expect(fieldsets.length).toBeGreaterThan(10);
    for (const fieldset of fieldsets) {
      const legend = fieldset.firstElementChild;
      expect(legend?.tagName).toBe("LEGEND");
      expect(visibleText(legend as Element)).not.toBe("");
    }
    for (const control of document.querySelectorAll(
      'main input:not([type="hidden"]), main select, main textarea',
    )) {
      const id = control.getAttribute("id") ?? "";
      expect({ id, label: document.querySelectorAll(`label[for="${id}"]`).length }).toEqual({
        id,
        label: 1,
      });
    }
    for (const button of document.querySelectorAll("main button"))
      expect(visibleText(button)).not.toBe("");
    // Names and descriptions are one line each: newlines are refused, so no textarea.
    expect(document.querySelectorAll("main textarea")).toHaveLength(0);
    // Every id the page generates (per category, role and choice) is unique.
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
  });

  test("every control's accessible name is unique on the page (WCAG 2.4.6)", async () => {
    for (const states of [{}, { menuProblems: true }] satisfies HarnessStates[]) {
      const document = await rolePage(await editor(states));
      const named = [
        ...document.querySelectorAll(
          'button, input:not([type="hidden"]), select, textarea, summary',
        ),
      ].map((element) => accessibleName(document, element).replace(/\s+/gu, " "));
      const repeated = named.filter((name, at) => named.indexOf(name) !== at);
      expect({ states, repeated }).toEqual({ states, repeated: [] });
    }
  });

  test("roles that share a name in Discord still give every control a unique name", async () => {
    // Discord allows duplicate role names: two on the menu in one category (Edit roles rows), and
    // two the add lists offer, each told apart by its ID in the hidden suffix.
    const twins: WebNames = {
      ...names,
      roles: new Map([...names.roles, [MENU_ROLE.sheHer, "He/Him"], [MENU_ROLE.tank, "Healer"]]),
    };
    const document = await rolePage(await editor(), { names: twins });
    const named = [
      ...document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, summary'),
    ].map((element) => accessibleName(document, element).replace(/\s+/gu, " "));
    expect(named.filter((name, at) => named.indexOf(name) !== at)).toEqual([]);
    expect(named).toContain(`Description: He/Him (${MENU_ROLE.sheHer})`);
    expect(named).toContain(`Description: He/Him (${MENU_ROLE.heHim})`);
    // A name no other role has keeps its plain suffix.
    expect(named).toContain("Description: They/Them");
    expect(named.some((name) => name.includes(`@Healer (${MENU_ROLE.tank})`))).toBe(true);
    // What a sighted officer reads is unchanged.
    const tank = document.querySelector(
      `#category-${MENU_CATEGORY.content}-roles input[value="${MENU_ROLE.tank}"]`,
    );
    const label = document.querySelector(`label[for="${tank?.getAttribute("id")}"]`);
    expect(visibleText(label as Element)).toBe("@Healer");
  });

  test("destructive buttons sit only inside a closed disclosure that states the consequence first", async () => {
    for (const states of [{}, { menuUnreadable: true }] satisfies HarnessStates[]) {
      const document = await rolePage(await editor(states));
      const dangers = [...document.querySelectorAll(".orr-btn--danger")];
      expect(dangers.length).toBeGreaterThan(0);
      for (const button of dangers) {
        const details = button.closest("details");
        expect(details).not.toBeNull();
        expect(details?.hasAttribute("open")).toBe(false);
        const form = button.closest("form");
        expect(form?.querySelector(".note")?.textContent).toMatch(
          /[Nn]obody's roles change|keep these roles/u,
        );
      }
    }
    // Delete category, once per category.
    const document = await rolePage(await editor());
    expect(
      [...document.querySelectorAll(".orr-btn--danger")].map((button) => visibleText(button)),
    ).toEqual(Array(4).fill("Yes, delete category"));
  });

  test("Add roles lists only roles that pass, in Discord's order, and why each other role can't be added", async () => {
    const document = await rolePage(await editor());
    const content = card(document, MENU_CATEGORY.content);
    const choices = [
      ...(content?.querySelectorAll(`#category-${MENU_CATEGORY.content}-roles input`) ?? []),
    ].map((input) => input.getAttribute("value"));
    expect(choices).toEqual([MENU_ROLE.dps, MENU_ROLE.tank, MENU_ROLE.healer]);
    const refused = [...(content?.querySelectorAll(".menu-refusals > li") ?? [])].map((item) => [
      item.querySelector(".mention")?.textContent,
      item.querySelector(".note")?.textContent,
    ]);
    expect(refused).toContainEqual([
      "@Announcer",
      "It gives extra permissions in #announcements (Send Messages). A self-service role can't change channels that everyone, members or guests can already see.",
    ]);
    expect(refused).toContainEqual([
      "@Council",
      "It opens #council, which looks like an officer channel. A self-service role can't open officer channels.",
    ]);
    expect(refused).toContainEqual([
      "@Member",
      "It's TaruBot's Member role. Access roles can't be on the role menu.",
    ]);
    // An empty category opens its Add roles; the others stay closed. No confirmation is asked
    // while TaruBot can read every channel.
    expect(document.querySelectorAll('fieldset[id$="-acknowledged"]')).toHaveLength(0);
    const healthy = await rolePage(
      await editor(
        {},
        {
          menu: {
            v: 1,
            categories: [
              {
                ...(HARNESS_MENU.categories[0] as SelfRoleMenu["categories"][number]),
                options: [],
              },
            ],
          },
        },
      ),
    );
    expect(
      healthy
        .querySelector(`#category-${MENU_CATEGORY.pronouns}-roles`)
        ?.closest("details")
        ?.hasAttribute("open"),
    ).toBe(true);
  });

  test("drift since the menu was built shows on each role, in the summary, and in the banners", async () => {
    const document = await rolePage(await editor({ menuProblems: true }));
    expect(document.querySelector(".menu-summary__title")?.textContent).toBe(
      "5 roles need attention.",
    );
    // Where they are: a link per category to its focusable heading, with how many, matching each
    // card's badge and the heading's hidden words.
    const where = document.querySelector(".menu-summary__where");
    expect(where?.textContent).toBe(
      "In Pronouns (2), Games (1), Content (1) and Retired events (1).",
    );
    for (const link of where?.querySelectorAll("a") ?? []) {
      const target = document.getElementById((link.getAttribute("href") ?? "").slice(1));
      expect(target?.tagName).toBe("H3");
      expect(target?.getAttribute("tabindex")).toBe("-1");
    }
    const pronouns = card(document, MENU_CATEGORY.pronouns);
    expect(pronouns?.querySelector("h3")?.textContent).toBe(
      "Pronouns (published, 2 roles need attention)",
    );
    expect(pronouns?.querySelector(".menu-category__meta .orr-badge--warning")?.textContent).toBe(
      "2 to check",
    );
    expect(card(document, MENU_CATEGORY.games)?.querySelector("h3")?.textContent).toBe(
      "Games (published, 1 role needs attention)",
    );
    const problems = [...document.querySelectorAll(".menu-option")]
      .filter((option) => option.querySelector(".menu-problems"))
      .map((option) => [
        option.querySelector(".menu-option__role .mention, .menu-option__role code")?.textContent,
        option.querySelector(".menu-problems li")?.textContent,
      ]);
    expect(problems).toEqual([
      [
        "@She/Her",
        "It has Mention Everyone, which @everyone doesn't have in this server. A self-service role can't give server permissions.",
      ],
      [
        "@They/Them",
        "It's above @Moderator, which has Kick Members, Ban Members and Time Out Members, so people with that role couldn't kick, ban or time out anyone who picks it. Move it below @Moderator.",
      ],
      [
        "@Valheim",
        "It gives permissions @everyone doesn't have in this server: #valheim (Manage Messages). A self-service role can only carry @everyone's own permissions in a channel.",
      ],
      [
        "@Mahjong night",
        "It's at or above TaruBot's highest role, so TaruBot can't assign it. Move it below TaruBot's role.",
      ],
      ["@Halloween 2025", "This role no longer exists in this server."],
    ]);
    const banners = [...document.querySelectorAll(".menu-banners .notice")].map(
      (banner) => banner.textContent,
    );
    expect(banners).toEqual([
      "Members and guests won't be able to pick roles while TaruBot has Administrator in this server. Use /setup overrides, then remove Administrator once /config validate says it's no longer needed.",
      "TaruBot can't see 2 channels in this server, so it can't check roles there. Adding roles asks you to confirm you've checked.",
    ]);
    // Every add asks for the confirmation, as a checkbox in its own fieldset. It covers any
    // permission in those channels, not only opening them: TaruBot can't read either there.
    const confirmations = [...document.querySelectorAll('fieldset[id$="-acknowledged"]')];
    expect(confirmations).toHaveLength(4);
    for (const fieldset of confirmations) {
      expect(fieldset.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      expect(fieldset.querySelector(".orr-field__hint")?.textContent).toBe(
        "TaruBot can't see 2 channels in this server, so it can't check these roles there.",
      );
      expect(visibleText(fieldset.querySelector(".orr-check__label") as Element)).toBe(
        "I've checked that these roles don't open any of them or give any permission in them",
      );
    }
  });

  test("banners for the server's other conditions, each only when it applies", async () => {
    const banners = async (overrides: Partial<SelfRoleEditor>) =>
      [
        ...(await rolePage(await editor({}, overrides))).querySelectorAll(".menu-banners .notice"),
      ].map((banner) => banner.textContent);
    expect(await banners({})).toEqual([]);
    expect(await banners({ memberRoleId: null, guestRoleId: null })).toEqual([
      "Members and guests won't be able to pick these roles until a Member or Guest role is set with /config roles.",
    ]);
    expect(await banners({ memberRoleId: null })).toEqual([
      "Members won't be able to pick these roles until a Member role is set with /config roles.",
    ]);
    expect(await banners({ guestRoleId: null })).toEqual([]);
    expect(await banners({ onboarding: true })).toEqual([
      "TaruBot's onboarding controls channel access here, so these roles can't open channels.",
    ]);
    // A member's save is refused while changes are paused, so nothing waits for them.
    expect(await banners({ effectsMode: "awaiting_activation" })).toEqual([
      "Discord changes are paused in this server until TaruBot is activated, so members and guests won't be able to save role choices until then. You can still build the menu.",
    ]);
    expect(await banners({ effectsMode: "deployment_disabled" })).toEqual([
      "Discord changes are off for this TaruBot deployment, so members and guests won't be able to save role choices. You can still build the menu.",
    ]);
    // TaruBot's view can't be read: no verdicts, so no add form, and the page says why.
    const blind = await rolePage(await editor({}, { roles: null, administrator: null }));
    expect([...blind.querySelectorAll(".menu-banners .notice")].map((b) => b.textContent)).toEqual([
      "TaruBot can't read this server's roles right now, so it can't show which roles have a problem, or add roles. Try again in a minute.",
    ]);
    expect(blind.querySelectorAll('input[name="op"][value="options.add"]')).toHaveLength(0);
  });

  test("a saved menu this build can't read offers only Reset role menu; no setup offers no form", async () => {
    const unreadable = await rolePage(await editor({ menuUnreadable: true }));
    expect(
      [...unreadable.querySelectorAll('main input[name="op"]')].map((op) =>
        op.getAttribute("value"),
      ),
    ).toEqual(["menu.reset"]);
    expect(unreadable.querySelector("main .notice--warning")?.textContent).toContain(
      SELF_ROLE_MESSAGES.unreadable,
    );
    expect(unreadable.querySelector("main .notice--warning")?.textContent).toContain(
      "Members and guests won't see anything to pick from it.",
    );
    // Nothing there adds roles, so the hidden-channels banner doesn't mention a confirmation.
    const hidden = await rolePage(
      await editor({ menuUnreadable: true }, { unreadableChannels: 2 }),
    );
    expect([...hidden.querySelectorAll(".menu-banners .notice")].map((b) => b.textContent)).toEqual(
      ["TaruBot can't see 2 channels in this server, so it can't check roles there."],
    );
    expect(unreadable.querySelectorAll(".featured, .menu-category")).toHaveLength(0);
    const unset = await rolePage(await editor({}, { configured: false }));
    expect(unset.querySelectorAll("main form")).toHaveLength(0);
    expect(unset.querySelector("main .notice")?.textContent).toContain("Set TaruBot up first");
    // An empty menu has the empty state instead of the summary card.
    const empty = await rolePage(await editor({}, { menu: { v: 1, categories: [] } }));
    expect(empty.querySelectorAll(".featured")).toHaveLength(0);
    expect(empty.querySelector(".empty-state")?.textContent).toContain("No categories yet.");
  });

  test("hostile names and descriptions stay escaped text, isolated", async () => {
    const [img, script, rtl, amp] = HOSTILE;
    const menu: SelfRoleMenu = {
      v: 1,
      categories: [
        {
          id: MENU_CATEGORY.pronouns,
          name: img,
          description: script,
          max: null,
          state: "published",
          options: [{ roleId: MENU_ROLE.heHim, description: rtl, removalOnly: false }],
        },
      ],
    };
    const hostileNames: WebNames = { ...names, roles: new Map([[MENU_ROLE.heHim, amp]]) };
    const document = await rolePage(await editor({}, { menu }), { names: hostileNames });
    expect(document.querySelectorAll("main img, main script")).toHaveLength(0);
    for (const text of [img, script, rtl, `@${amp}`]) expect(isolated(document)).toContain(text);
    // In fields, the same text is an attribute value, never markup.
    expect(
      document.querySelector(`#category-${MENU_CATEGORY.pronouns}-name`)?.getAttribute("value"),
    ).toBe(img);
  });

  test("a refused form comes back open with its values, and every summary link resolves", async () => {
    const state = await editor();
    const refusals: RefusedEdit[] = [
      {
        form: { kind: "add", categoryId: MENU_CATEGORY.games },
        values: { roleIds: [MENU_ROLE.healer], acknowledged: false },
        revision: 7n,
        errors: [
          {
            field: "roleIds",
            message: SELF_ROLE_MESSAGES.refusedRole(MENU_ROLE.healer, {
              code: "permissions",
              message: "It has Kick Members, which @everyone doesn't have in this server.",
            }),
          },
          { field: "acknowledged", message: SELF_ROLE_MESSAGES.acknowledge(2) },
        ],
      },
      {
        form: { kind: "category", categoryId: MENU_CATEGORY.content },
        values: { name: "", description: "x", max: "99" },
        revision: 7n,
        errors: [
          { field: "name", message: "Give the category a name." },
          { field: "max", message: LIMIT_MESSAGES.max },
        ],
      },
      {
        form: { kind: "action", categoryId: MENU_CATEGORY.retired },
        values: {},
        revision: 8n,
        errors: [{ field: "form", message: SELF_ROLE_MESSAGES.changed }],
      },
      // The category the form edited is gone: the link falls back to the section.
      {
        form: { kind: "options", categoryId: "00000000-0000-4000-8000-000000000009" },
        values: {},
        revision: 8n,
        errors: [{ field: "form", message: SELF_ROLE_MESSAGES.changed }],
      },
      {
        form: { kind: "create" },
        values: { name: "x".repeat(41), description: "", max: "any", categoryId: NEW_ID },
        revision: 7n,
        errors: [{ field: "name", message: "Use at most 40 characters." }],
      },
      {
        form: { kind: "menu" },
        values: {},
        revision: 8n,
        errors: [{ field: "form", message: SELF_ROLE_MESSAGES.changed }],
      },
    ];
    /** A link moves focus to its target, so it must be a control or have tabindex="-1". */
    const focusable = (element: Element | null): boolean =>
      element !== null &&
      (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName) ||
        element.getAttribute("tabindex") === "-1");
    // The page's other fallbacks: a full menu's Add a category, a saved menu this build can't
    // read, and a server with no TaruBot configuration.
    const full = await editor(
      {},
      {
        menu: {
          v: 1,
          categories: Array.from({ length: MENU_LIMITS.categories }, (_, at) => ({
            id: `0000000${at}-0000-4000-8000-000000000000`,
            name: `Category ${at}`,
            description: "",
            max: null,
            state: "draft" as const,
            options: [],
          })),
        },
      },
    );
    const others: [SelfRoleEditor, RefusedEdit][] = [
      [
        full,
        {
          form: { kind: "create" },
          values: { name: "x", description: "", max: "any", categoryId: NEW_ID },
          revision: 7n,
          errors: [{ field: "form", message: LIMIT_MESSAGES.categories }],
        },
      ],
      [
        await editor({ menuUnreadable: true }),
        {
          form: { kind: "menu" },
          values: {},
          revision: 7n,
          errors: [{ field: "form", message: SELF_ROLE_MESSAGES.changed }],
        },
      ],
      [
        await editor({}, { configured: false }),
        {
          form: { kind: "create" },
          values: { name: "x", description: "", max: "any", categoryId: NEW_ID },
          revision: 7n,
          errors: [{ field: "name", message: LIMIT_MESSAGES.duplicateName }],
        },
      ],
    ];
    for (const [shown, refused] of [
      ...refusals.map((refused) => [state, refused] as const),
      ...others,
    ]) {
      const document = await rolePage(shown, { refused });
      expect(document.querySelector("title")?.textContent).toBe("Error: Role menu · TaruBot");
      const links = [...document.querySelectorAll(".error-summary a")];
      expect(links).toHaveLength(refused.errors.length);
      for (const link of links) {
        const target = document.getElementById((link.getAttribute("href") ?? "").slice(1));
        expect({ form: refused.form, target: target !== null, focus: focusable(target) }).toEqual({
          form: refused.form,
          target: true,
          focus: true,
        });
        // A target inside a disclosure is in an open one.
        const details = target?.closest("details");
        if (details) expect(details.hasAttribute("open")).toBe(true);
      }
    }
    // The refused role is named by its cached name in the summary and beside its field.
    const add = await rolePage(state, { refused: refusals[0] as RefusedEdit });
    const roles = add.querySelector(`#category-${MENU_CATEGORY.games}-roles`);
    expect(roles?.getAttribute("aria-describedby")).toContain(
      `category-${MENU_CATEGORY.games}-roles-error`,
    );
    expect(
      add.querySelector(`#category-${MENU_CATEGORY.games}-roles-error .mention`)?.textContent,
    ).toBe("@Healer");
    expect(add.querySelector(".error-summary a .mention")?.textContent).toBe("@Healer");
    expect(
      roles?.querySelector(`input[value="${MENU_ROLE.healer}"]`)?.hasAttribute("checked"),
    ).toBe(true);
    // The refused Edit category keeps what was typed, including the select's choice.
    const edit = await rolePage(state, { refused: refusals[1] as RefusedEdit });
    const key = `category-${MENU_CATEGORY.content}`;
    expect(edit.querySelector(`#${key}-name`)?.getAttribute("value")).toBe("");
    expect(edit.querySelector(`#${key}-description`)?.getAttribute("value")).toBe("x");
    expect(edit.querySelector(`#${key}-max option[selected]`)).toBeNull();
    // The conflict on a state change says so beside the buttons, in its category's foot, and
    // the summary links there; the message says what to do next.
    const stale = await rolePage(state, { refused: refusals[2] as RefusedEdit });
    const actions = `category-${MENU_CATEGORY.retired}-actions`;
    expect(stale.querySelector(".error-summary a")?.getAttribute("href")).toBe(`#${actions}`);
    const foot = stale.getElementById(actions);
    expect(foot?.parentElement?.className).toBe("menu-category__foot");
    expect(foot?.textContent).toBe(`Error: ${SELF_ROLE_MESSAGES.changed}`);
    expect(SELF_ROLE_MESSAGES.changed).toBe(
      "Another officer changed the role menu while you were editing, so your change wasn't saved. Check the menu as it is now, then try again if it's still needed.",
    );
    // Publish N drafts: the summary card's heading, with the message in its foot.
    const menuStale = await rolePage(state, { refused: refusals[5] as RefusedEdit });
    expect(menuStale.querySelector(".error-summary a")?.getAttribute("href")).toBe(
      "#role-menu-summary",
    );
    expect(menuStale.querySelector(".menu-summary__foot .form-error")?.textContent).toBe(
      `Error: ${SELF_ROLE_MESSAGES.changed}`,
    );
    // An empty menu has no summary card: the Categories section says it instead.
    const emptyStale = await rolePage(await editor({}, { menu: { v: 1, categories: [] } }), {
      refused: refusals[5] as RefusedEdit,
    });
    expect(emptyStale.querySelector(".error-summary a")?.getAttribute("href")).toBe(
      "#role-menu-categories",
    );
    expect(emptyStale.querySelector(".form-error + .empty-state")).not.toBeNull();
  });

  test("the summary's headline agrees with its counts, and Delete says what each state means", async () => {
    const [pronouns, games, content, retired] = HARNESS_MENU.categories as [
      SelfRoleMenu["categories"][number],
      SelfRoleMenu["categories"][number],
      SelfRoleMenu["categories"][number],
      SelfRoleMenu["categories"][number],
    ];
    const headline = async (categories: SelfRoleMenu["categories"]) =>
      (await rolePage(await editor({}, { menu: { v: 1, categories } }))).querySelector(
        ".menu-summary__title",
      )?.textContent;
    expect(await headline([pronouns, games])).toBe("Every category is published.");
    // A category no longer offered isn't published, so the headline doesn't say every one is.
    expect(await headline([pronouns, games, retired])).toBe(
      "Every category is published or no longer offered.",
    );
    expect(await headline([pronouns, content])).toBe("1 draft isn't published yet.");
    // Only a published category offers Stop offering; only officers have seen a draft.
    const document = await rolePage(await editor());
    const note = (id: string) =>
      card(document, id)?.querySelector(".orr-btn--danger")?.closest("form")?.querySelector(".note")
        ?.textContent;
    expect(note(MENU_CATEGORY.pronouns)).toBe(
      "People keep these roles in Discord, but won't be able to add or remove them themselves. To let people still remove them, choose Stop offering instead.",
    );
    expect(note(MENU_CATEGORY.content)).toBe(
      "Only officers have seen this draft. People keep these roles in Discord.",
    );
    expect(note(MENU_CATEGORY.retired)).toBe(
      "People keep these roles in Discord, but won't be able to remove them themselves any more.",
    );
  });

  test("the success notice shows the page's fixed sentences only, and every edit names one", async () => {
    const state = await editor();
    const shown = await rolePage(state, { url: `${path}?notice=added` });
    expect(shown.querySelector("#status")?.textContent).toBe("Roles added.");
    for (const query of ["?notice=unknown", "?notice=__proto__", "?notice=%3Cb%3E"]) {
      const document = await rolePage(state, { url: `${path}${query}` });
      expect({ query, notice: document.querySelector("#status") }).toEqual({ query, notice: null });
    }
    const example: Record<MenuOperation["op"], MenuOperation> = {
      "category.create": {
        op: "category.create",
        categoryId: NEW_ID,
        name: "x",
        description: "",
        max: null,
      },
      "category.edit": {
        op: "category.edit",
        categoryId: NEW_ID,
        name: "x",
        description: "",
        max: null,
      },
      "category.move": { op: "category.move", categoryId: NEW_ID, to: 0 },
      "category.setState": { op: "category.setState", categoryId: NEW_ID, state: "removal_only" },
      "category.delete": { op: "category.delete", categoryId: NEW_ID },
      "menu.publishAll": { op: "menu.publishAll" },
      "menu.reset": { op: "menu.reset" },
      "options.add": {
        op: "options.add",
        categoryId: NEW_ID,
        roleIds: [],
        unreadableAcknowledged: false,
      },
      "options.edit": { op: "options.edit", categoryId: NEW_ID, rows: [] },
    };
    for (const op of MENU_OPERATIONS)
      expect(Object.hasOwn(ROLE_MENU_NOTICES, noticeFor(example[op]))).toBe(true);
    expect(
      (["published", "removal_only", "draft"] as const).map((state) =>
        noticeFor({ op: "category.setState", categoryId: NEW_ID, state }),
      ),
    ).toEqual(["published", "stopped", "drafted"]);
  });

  test("every success notice is past tense, so a reload or Back that shows it again stays true", () => {
    // The notice rides in the URL (UX-10, accepted): each says what was done, never what is
    // happening or how the menu is now.
    for (const [token, text] of Object.entries(ROLE_MENU_NOTICES)) {
      const first = text.split(". ")[0] ?? "";
      expect({
        token,
        done: /\b(?:added|saved|moved|published|offered|deleted|reset)\b/u.test(first),
      }).toEqual({
        token,
        done: true,
      });
      expect({ token, text }).not.toMatchObject({
        text: expect.stringMatching(/\b(?:now|just|currently|being|saving|publishing)\b|…/iu),
      });
    }
  });

  test("every class the view renders has a rule in the stylesheet", async () => {
    // Hooks no rule needs: .featured is drawn by the card classes beside it, and .menu-move
    // marks a Move up or Move down form, which .form lays out.
    const drawnByOthers = new Set(["featured", "menu-move"]);
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    const state = await editor({ menuProblems: true });
    const documents = [
      await rolePage(state),
      await rolePage(await editor({ menuUnreadable: true })),
      await rolePage(state, {
        url: `${path}?notice=saved`,
        refused: {
          form: { kind: "options", categoryId: MENU_CATEGORY.games },
          values: {},
          revision: 7n,
          errors: [{ field: "rows", message: LIMIT_MESSAGES.rows }],
        },
      }),
    ];
    const classes = new Set<string>();
    for (const document of documents)
      for (const element of document.querySelectorAll("main [class]"))
        for (const name of element.classList) classes.add(name);
    for (const name of ["orr-badge", "menu-category", "option-row", "menu-problems", "form-error"])
      expect(classes.has(name)).toBe(true);
    for (const name of classes) {
      if (drawnByOthers.has(name)) continue;
      expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
        name,
        styled: true,
      });
    }
  });
});
