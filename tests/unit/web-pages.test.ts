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
import {
  type MyRoles,
  RoleChoiceJob,
  type RoleChoiceStatus,
  type SelfRoleEditor,
  SelfRoles,
} from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { ServiceKey, Services } from "../../src/bot/services.js";
import { project } from "../../src/config/project.js";
import type { Actor } from "../../src/domain/policy.js";
import {
  CHOICE_MESSAGES,
  choiceMenu,
  LIMIT_MESSAGES,
  MENU_LIMITS,
  MENU_OPERATIONS,
  type MenuOperation,
  menuRoleIds,
  type RoleChecker,
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
  drawsEditorOpen,
  noticeFor,
  type RefusedEdit,
  ROLE_MENU_NOTICES,
  type RoleMenuView,
  renderRoleMenu,
} from "../../src/web/views/role-menu.js";
import {
  MY_ROLES_NOTICES,
  type RefusedChoice,
  renderMyRoles,
  skippedText,
  UNCHANGED_WHILE_WAITING,
} from "../../src/web/views/my-roles.js";
import { renderStatus } from "../../src/web/views/status.js";
import { renderPublicStatus, STATUS_TITLE } from "../../src/web/views/public-status.js";
import type { StatusSnapshot } from "../../src/application/public-status.js";
import {
  HISTORY_DAYS,
  type OverallStatus,
  type SampleCount,
  type StatusComponents,
  uptimeHistory,
} from "../../src/domain/uptime.js";
import {
  HARNESS_ACCOUNTS,
  HARNESS_GUILDS,
  HARNESS_MENU,
  type HarnessMenus,
  type HarnessStates,
  HELD,
  harnessGateway,
  harnessPeople,
  harnessSelfRoles,
  MENU_CATEGORY,
  MENU_REVISION,
  MENU_ROLE,
  SECOND_CATEGORY,
  SECOND_MENU,
} from "../fixtures/web-dev.js";

const GUILD = "100000000000000001";
const USER = "200000000000000002";
/** The no-access answers' exception for members and guests refused under A2. */
const NO_ACCESS_EXCEPTION =
  "While officers sort out TaruBot's permissions in a server, only officers can sign in there. If you already have the Member or Guest role, ask an officer.";
const REF = "00000000-0000-4000-8000-000000000000";
/** An invented form token, as the session middleware derives one. */
const TOKEN = Buffer.from("form-token-for-tests-00000000000").toString("base64url");
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
    // 2.40.0: members and guests (My roles declares both, and officer).
    expect(definePage({ ...base, access: ["member", "guest", "officer"] }).access).toEqual([
      "member",
      "guest",
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
      [
        { access: ["operator"] },
        "A page must declare access, any of: officer, manager, member, guest.",
      ],
      [{ access: ["officer", "operator"] }, "A page must declare access"],
      [{ access: ["Member"] }, "A page must declare access"],
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

  test("the welcome speaks to members and guests first, then officers (2.40.0)", async () => {
    const document = inspect(
      await render(layout({ title: "TaruBot", signedIn: false }, renderHome({ signedIn: false }))),
    );
    expect(document.querySelector(".welcome-copy__lead")?.textContent).toBe(
      "Pick your roles in your FC's server. Officers also get a clear view of its configuration, health and background work.",
    );
    expect([...document.querySelectorAll(".feature dt")].map((term) => term.textContent)).toEqual([
      "Pick your roles",
      "Know what's configured",
      "See what needs attention",
    ]);
    expect(document.querySelector(".disclosure summary")?.textContent).toBe("Who can sign in?");
    const answer = [...document.querySelectorAll(".disclosure p")].map((line) => line.textContent);
    expect(answer).toEqual([
      "Anyone with the server's Member or Guest role can sign in to pick their roles. Officers can also sign in to manage TaruBot.",
      "Signing in asks Discord only who you are. TaruBot checks your server access and keeps no Discord token.",
    ]);
    // The officer-era wording is gone: nothing says the pages are read-only or officers' alone.
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("read-only");
    expect(text).not.toContain("The pages are for FC officers");
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
    // Someone refused while TaruBot holds Administrator (A2) isn't told the opposite.
    expect(document.querySelector("main")?.textContent).toContain(NO_ACCESS_EXCEPTION);
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
    // the page's title, for sight. The switcher asks for the list itself, so it never lands back
    // on the only page someone has (server.ts's / redirect).
    expect(
      document.querySelector('.server-switch[href="/?servers"] [dir="auto"]')?.textContent,
    ).toBe(name);
    expect(document.querySelector(".topbar")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".topbar")?.textContent).toBe("Workspace/Status");
    expect(document.body.classList.contains("console-page")).toBe(true);
    // Officers (and a model that doesn't say) get the officers' side note.
    expect(document.querySelector(".side-nav__context")?.textContent).toBe(
      "Settings and background workMost settings are changed in Discord; the role menu is set here.",
    );
  });

  test("a member's console says where their roles are picked, not how settings are run", async () => {
    const guild = { id: GUILD, name: "Example FC", nav: [], audience: "member" } as const;
    const document = inspect(
      await render(
        layout({ title: "My roles", signedIn: true, formToken: TOKEN, guild }, html`<p>Body</p>`),
      ),
    );
    expect(document.querySelector(".side-nav__context p")?.textContent).toBe("Your roles");
    expect(document.querySelector(".side-nav__note")?.textContent).toBe(
      "Pick your roles here. Everything else is in Discord.",
    );
    const officer = inspect(
      await render(
        layout(
          {
            title: "My roles",
            signedIn: true,
            formToken: TOKEN,
            guild: { ...guild, audience: "officer" },
          },
          html`<p>Body</p>`,
        ),
      ),
    );
    expect(officer.querySelector(".side-nav__note")?.textContent).toBe(
      "Most settings are changed in Discord; the role menu is set here.",
    );
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
    const lines = [...document.querySelectorAll("main .entry-panel p")].map(
      (line) => line.textContent,
    );
    expect(lines).toContain(
      "Anyone with the server's Member or Guest role can sign in to pick their roles. Officers can also sign in to manage TaruBot. If you've just been given access, wait a minute and sign in again.",
    );
    // A Member or Guest refused while TaruBot holds Administrator (A2) reads why, in a constant
    // sentence that names no server and no permission.
    expect(lines).toContain(NO_ACCESS_EXCEPTION);
    expect(document.querySelectorAll("form")).toHaveLength(0);
    // It asks people to sign in again, so it offers that, and the start page.
    expect(
      [...document.querySelectorAll(".entry-panel__actions a")].map((link) => [
        link.getAttribute("href"),
        link.textContent,
      ]),
    ).toEqual([
      ["/login", "Sign in again"],
      ["/", "Go to the TaruBot start page"],
    ]);
  });
});

describe("the public status page (2.41.0)", () => {
  const LIVE: StatusComponents = {
    discord: true,
    database: true,
    lodestone: "available",
    changes: "live",
  };
  const latest = new Date("2026-10-09T12:00:00Z");
  /** 90 days of data: whole days, then three below 100%, one of them with two versions. */
  const counts: SampleCount[] = [
    ...Array.from({ length: HISTORY_DAYS }, (_, index) => {
      const day = new Date(latest.getTime() - (HISTORY_DAYS - 1 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return { day, version: "2.40.0", ready: 288, first: new Date(`${day}T00:00:00Z`) };
    }).filter((count) => !["2026-08-01", "2026-10-06", "2026-10-09"].includes(count.day)),
    { day: "2026-08-01", version: "2.38.0", ready: 216, first: new Date("2026-08-01T00:00:00Z") },
    { day: "2026-10-06", version: "2.40.0", ready: 200, first: new Date("2026-10-06T00:00:00Z") },
    { day: "2026-10-06", version: "2.41.0", ready: 86, first: new Date("2026-10-06T16:50:00Z") },
    { day: "2026-10-09", version: "2.41.0", ready: 142, first: new Date("2026-10-09T00:15:00Z") },
  ];
  const snapshot = (
    overall: OverallStatus,
    components: Partial<StatusComponents> = {},
    history: StatusSnapshot["history"] = uptimeHistory(counts, new Date("2026-01-01"), latest),
  ): StatusSnapshot => ({
    takenAt: new Date("2026-10-09T12:03:27Z"),
    version: "2.41.0",
    ready: overall !== "down",
    overall,
    components: { ...LIVE, ...components },
    history,
  });
  const page = async (value: StatusSnapshot) =>
    inspect(
      await render(layout({ title: STATUS_TITLE, signedIn: false }, renderPublicStatus(value))),
    );

  test("one h1, the overall word, the components, and no account, form or script", async () => {
    const document = await page(snapshot("operational"));
    expect(document.querySelector("title")?.textContent).toBe("Status · TaruBot");
    expect(document.querySelector("h1")?.textContent).toBe("Status");
    expect(document.querySelector("#status-overall")?.textContent).toBe("Operational");
    expect(document.querySelector(".status-overall__text")?.textContent).toBe(
      "TaruBot is working normally.",
    );
    expect(
      [...document.querySelectorAll(".status-component")].map((tile) => [
        tile.querySelector("h3")?.textContent,
        tile.querySelector(".check")?.textContent,
        tile.querySelector(".status-component__text")?.textContent,
      ]),
    ).toEqual([
      ["Discord connection", "[OK]", "Connected"],
      ["Database", "[OK]", "Reachable"],
      ["Lodestone", "[OK]", "Answering"],
      ["Discord changes", "[OK]", "Live"],
    ]);
    // The section's name is "Right now" and the word, so a landmark list says the state too.
    const overall = document.querySelector(".status-overall");
    expect(
      (overall?.getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toBe("Right now Operational");
    const updated = document.querySelector(".status-facts time");
    expect(updated?.getAttribute("datetime")).toBe("2026-10-09T12:03:27.000Z");
    expect(updated?.textContent).toBe("2026-10-09 12:03 UTC");
    expect(document.body.textContent).toContain("2.41.0");
    expect(document.querySelectorAll("form, button, .account, .sidebar")).toHaveLength(0);
    // Its own one holographic card, and the footer's link back to it.
    expect(document.querySelectorAll(".orr-holo-edge")).toHaveLength(1);
    expect(document.querySelector('.site-footer a[href="/status"]')?.textContent).toBe("Status");
  });

  test("degraded and down say so in words, token by token; paused changes read neutrally", async () => {
    const degraded = await page(
      snapshot("degraded", { lodestone: "unreachable", changes: "paused" }),
    );
    expect(degraded.querySelector("#status-overall")?.textContent).toBe("Degraded");
    expect(
      [...degraded.querySelectorAll(".status-component .check")].map((check) => check.textContent),
    ).toEqual(["[OK]", "[OK]", "[FAIL]", "[WAIT]"]);
    expect(degraded.body.textContent).toContain("No answer to the latest request");
    // A setting, not a fault (overallStatus leaves it out): a plain word on its own tile.
    const paused = await page(snapshot("operational", { changes: "paused" }));
    expect(paused.querySelector("#status-overall")?.textContent).toBe("Operational");
    expect(
      [...paused.querySelectorAll(".status-component")]
        .at(-1)
        ?.querySelector(".status-component__state")?.textContent,
    ).toBe("[WAIT]Paused by a setting");
    const down = await page(snapshot("down", { discord: false, lodestone: "cooling_down" }));
    expect(down.querySelector("#status-overall")?.textContent).toBe("Down");
    expect(down.body.textContent).toContain("Not connected");
    expect(down.body.textContent).toContain("Cooling down after too many requests");
  });

  test("90 bars as one labelled image, a class per band, no style attribute", async () => {
    const document = await page(snapshot("operational"));
    const image = document.querySelector(".uptime-bars");
    expect(image?.getAttribute("role")).toBe("img");
    const summary = "Uptime over the last 90 days: 99.70%. 3 days below 100%.";
    expect(document.querySelector(".uptime__summary")?.textContent).toBe(summary);
    // A short name: the summary just above already reads out the figures.
    expect(image?.getAttribute("aria-label")).toBe(
      "Daily uptime bars, oldest first; the table below lists days under 100%.",
    );
    expect(
      [...document.querySelectorAll(".status-facts > div")].map((fact) => [
        fact.querySelector("dt")?.textContent,
        fact.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Updated", "2026-10-09 12:03 UTC"],
      ["Version", "2.41.0"],
      ["Uptime, 90 days", "99.70%"],
    ]);
    const bars = [...document.querySelectorAll(".uptime-bar")];
    expect(bars).toHaveLength(HISTORY_DAYS);
    expect(new Set(bars.map((bar) => bar.getAttribute("class")))).toEqual(
      new Set([
        "uptime-bar uptime-bar--full",
        "uptime-bar uptime-bar--high",
        "uptime-bar uptime-bar--mid",
        "uptime-bar uptime-bar--low",
      ]),
    );
    expect(bars.at(-1)?.getAttribute("title")).toBe("2026-10-09: 97.93%");
    expect(bars.at(-4)?.getAttribute("title")).toBe("2026-10-06: 99.30%");
    // The legend names every band in words; the axis is decoration.
    expect(
      [...document.querySelectorAll(".uptime-legend li")].map((item) => item.textContent),
    ).toEqual(["100%", "99% or more", "95% or more", "Below 95%", "No data"]);
    expect(document.querySelector(".uptime-axis")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("a disclosure lists each day below 100%, newest first, with its versions", async () => {
    const document = await page(snapshot("operational"));
    expect(document.querySelector(".uptime-days > summary")?.textContent).toBe(
      "Days below 100% (3)",
    );
    const region = document.querySelector(".uptime-days .table-scroll");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(
      document.getElementById(region?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("Days below 100% uptime, newest first");
    expect(
      [...document.querySelectorAll(".uptime-table tbody tr")].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["2026-10-09", "97.93%", "15 min", "2.41.0"],
      ["2026-10-06", "99.30%", "10 min", "2.40.0, 2.41.0"],
      ["2026-08-01", "75.00%", "6 h", "2.38.0"],
    ]);
  });

  test("a whole history has no disclosure; a new one says since when; none says it will come", async () => {
    const whole = uptimeHistory(
      [
        {
          day: "2026-10-09",
          version: "2.41.0",
          ready: 145,
          first: new Date("2026-10-09T00:00:00Z"),
        },
      ],
      new Date("2026-10-09T00:00:00Z"),
      latest,
    );
    const fresh = await page(snapshot("operational", {}, whole));
    expect(fresh.querySelectorAll(".uptime-days")).toHaveLength(0);
    expect(fresh.querySelector(".uptime__summary")?.textContent).toBe(
      "Uptime since 2026-10-09 (UTC): 100%. Every day was at 100%.",
    );
    expect(fresh.querySelector(".uptime-bars")?.getAttribute("aria-label")).toBe(
      "Daily uptime bars, oldest first.",
    );
    // Under 90 days of data, the card names the same span as the summary, never "90 days".
    const uptime = [...fresh.querySelectorAll(".status-facts > div")].at(-1);
    expect(uptime?.querySelector("dt")?.textContent).toBe("Uptime since 2026-10-09");
    expect(uptime?.querySelector("dd")?.textContent).toBe("100%");
    expect(fresh.querySelector(".status-facts")?.textContent).not.toContain("90 days");
    expect(fresh.querySelectorAll(".uptime-bars .uptime-bar--none")).toHaveLength(HISTORY_DAYS - 1);
    const none = await page(snapshot("operational", {}, null));
    expect(none.querySelectorAll(".uptime-bar, .uptime-bars")).toHaveLength(0);
    expect(none.querySelector(".uptime .note")?.textContent).toContain("first check");
    expect(none.querySelector(".status-facts")?.textContent).not.toContain("Uptime");
  });

  test("every layout's footer and the sign-in card link the status page", async () => {
    const welcome = inspect(
      await render(layout({ title: "TaruBot", signedIn: false }, renderHome({ signedIn: false }))),
    );
    expect(welcome.querySelector('.site-footer a[href="/status"]')?.textContent).toBe("Status");
    expect(welcome.querySelector('.sign-in__status a[href="/status"]')?.textContent).toBe(
      "Check its status",
    );
    const signedIn = inspect(
      await render(
        layout(
          { title: "Your servers", signedIn: true, formToken: TOKEN },
          renderHome({ signedIn: true, servers: [] }),
        ),
      ),
    );
    expect(signedIn.querySelector('.site-footer a[href="/status"]')).not.toBeNull();
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
    const view: RoleMenuView = {
      editor: state,
      names: options.names ?? names,
      action: path,
      token: TOKEN,
      url: new URL(options.url ?? path, "https://example.org"),
      newCategoryId: NEW_ID,
      ...(options.refused && { refused: options.refused }),
    };
    // As the page module and server.ts do: a refused editor drawn open makes the shell inert.
    return inspect(
      await render(
        layout(
          {
            title: "Role menu",
            signedIn: true,
            formToken: TOKEN,
            guild: { id: GUILD, name: "Example FC", nav },
            ...(options.refused && { error: true }),
            ...(drawsEditorOpen(view) && { modal: true }),
          },
          renderRoleMenu(view),
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
    // Officers' navigation, in path order: My roles (2.40.0) is theirs too (owner decision Q6).
    expect(navLinks((await loadPages()).values(), officer).map((link) => link.label)).toEqual([
      "Server configuration",
      "My roles",
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
    // The head is one line, with the description under it. The markup keeps the hidden badges
    // first; the stylesheet draws the name, the pick rule and how many roles, then the badges at
    // the line's end, so every name starts at its card's left edge.
    expect(
      cards.map((item) =>
        [...(item.querySelector(".menu-category__head")?.children ?? [])].map(
          (part) => part.className,
        ),
      ),
    ).toEqual(
      Array(4).fill([
        "menu-category__meta",
        "menu-category__title",
        "menu-category__facts",
        "menu-category__desc",
      ]),
    );
    const parts = (item: Element, selector: string) =>
      [...(item.querySelector(selector)?.children ?? [])].map((part) => part.textContent);
    expect(
      cards.map((item) => [
        parts(item, ".menu-category__meta"),
        parts(item, ".menu-category__facts"),
      ]),
    ).toEqual([
      [["Published"], ["Pick any number", "4 roles"]],
      [["Published"], ["Pick any number", "2 roles"]],
      [["Draft"], ["Pick up to 2", "3 roles"]],
      [["Not offered"], ["Pick one", "1 role"]],
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
    // Every role reads in the same order: its chip, its description, then the channels it opens,
    // each a line of its own (side by side in two columns where the card has room).
    expect(
      [...(games?.querySelectorAll(".menu-option") ?? [])].map((option) =>
        [...option.children].map((part) => part.className),
      ),
    ).toEqual(Array(2).fill(["menu-option__role", "menu-option__desc", "menu-option__opens"]));
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
    // What publishing does, not "at once" (UX-3), and that it starts owner decision Q3 B's
    // removals; the line describes the button, so it is heard with it (UX-8).
    const publish = document.querySelector(".orr-btn--primary");
    const publishHelp = document.getElementById(publish?.getAttribute("aria-describedby") ?? "");
    expect(publishHelp?.textContent).toBe(
      "Members and guests can pick from a category on My roles as soon as it's published. From then on, TaruBot also takes its roles that open channels from anyone with none of the Member, Guest, Officer and FC Leader roles. If you're replacing a reaction-role bot, keep drafts until you switch over.",
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
    // Each state button is described by its own consequence (UX-8). The buttons submit at once,
    // so that sentence is on screen before them, in their card's state line over the toolbar, and
    // starts with the button's own label so it reads as that button's; nothing hides it.
    for (const button of document.querySelectorAll('.menu-state button[type="submit"]')) {
      const help = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect({
        button: button.textContent,
        line: help?.parentElement?.matches(".menu-category__foot > .menu-category__state"),
        card: help?.closest(".menu-category") === button.closest(".menu-category"),
        shown:
          help?.closest("[hidden], .visually-hidden") === null &&
          help?.closest("[aria-hidden]") === null,
        said: help?.textContent?.startsWith(`${visibleText(button)} `),
      }).toEqual({
        button: button.textContent,
        line: true,
        card: true,
        shown: true,
        said: true,
      });
    }
    expect(
      document.querySelectorAll(".menu-state button[aria-describedby]").length,
    ).toBeGreaterThan(0);
    // Each Edit roles row's state choices are short, so a closed select shows the whole choice at
    // any width; what they do is the note above the rows, on screen, and every state select's
    // description, so it is heard with the choice (UX-8).
    expect(
      [...(games?.querySelector('select[name^="state:"]')?.querySelectorAll("option") ?? [])].map(
        (choice) => choice.textContent,
      ),
    ).toEqual(["Offered", "Not offered", "Remove from menu"]);
    for (const select of document.querySelectorAll('.menu-category select[name^="state:"]')) {
      const help = document.getElementById(select.getAttribute("aria-describedby") ?? "");
      expect({
        id: select.id,
        note: help?.parentElement?.matches("form > p.note") === true,
        form: help?.closest("form") === select.closest("form"),
        shown: help?.closest("[hidden], .visually-hidden, [aria-hidden]") === null,
        said: help?.textContent,
      }).toEqual({
        id: select.id,
        note: true,
        form: true,
        shown: true,
        said: "Not offered means nobody can add the role, but people who have it can still remove it. Remove from menu means people keep the role in Discord, but can't change it on My roles.",
      });
    }
  });

  test("the state buttons a category offers follow its state, each described by its consequence", async () => {
    const document = await rolePage(await editor());
    const states = (id: string) =>
      [...(card(document, id)?.querySelectorAll(".menu-state") ?? [])].map((form) => [
        form.querySelector('input[name="state"]')?.getAttribute("value"),
        visibleText(form.querySelector("button") as Element),
        document.getElementById(
          form.querySelector("button")?.getAttribute("aria-describedby") ?? "",
        )?.textContent,
      ]);
    // Each state's help says what the button does for members and guests, starting with its label.
    const publish = "Publish lets members and guests pick these roles.";
    const stop = "Stop offering means people can only remove these roles.";
    const draft =
      "Move back to draft hides the category from all but officers; people keep these roles but can't change them until you publish again.";
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
    // On screen, one line over the buttons says what the card's state means, then what each of
    // its state buttons does, in the buttons' order, in place of a paragraph per button.
    const line = (id: string) =>
      card(document, id)?.querySelector(".menu-category__foot > .menu-category__state")
        ?.textContent;
    expect(line(MENU_CATEGORY.pronouns)).toBe(
      `Published: members and guests can pick these roles on My roles. ${stop} ${draft}`,
    );
    expect(line(MENU_CATEGORY.content)).toBe(`Draft: only officers see it. ${publish}`);
    expect(line(MENU_CATEGORY.retired)).toBe(
      `Not offered: people who have these roles can only remove them on My roles. ${publish} ${draft}`,
    );
  });

  test("a card's actions are one toolbar: the editors, the state buttons, the moves, then Delete category", async () => {
    const document = await rolePage(await editor());
    // What each item of a card's toolbar is, in order, as a sighted officer reads them: a button
    // that opens an editor's panel (drawn with a chevron) or one that acts at once, by its text.
    // A panel's own buttons are not the toolbar's.
    const toolbar = (id: string) =>
      [...(card(document, id)?.querySelectorAll(".menu-toolbar button") ?? [])]
        .filter((item) => item.closest(".overlay") === null)
        .map((item) => `${item.matches(".menu-opener") ? "▸ " : ""}${visibleText(item)}`);
    expect(toolbar(MENU_CATEGORY.pronouns)).toEqual([
      "▸ Edit roles",
      "▸ Add roles",
      "▸ Edit category",
      "Stop offering",
      "Move back to draft",
      "Move down",
      "▸ Delete category",
    ]);
    expect(toolbar(MENU_CATEGORY.content)).toEqual([
      "▸ Edit roles",
      "▸ Add roles",
      "▸ Edit category",
      "Publish",
      "Move up",
      "Move down",
      "▸ Delete category",
    ]);
    // Each card has exactly one toolbar, holding every form of the card: none sits apart from it.
    for (const item of document.querySelectorAll(".menu-category")) {
      expect(item.querySelectorAll(".menu-toolbar")).toHaveLength(1);
      for (const form of item.querySelectorAll("form"))
        expect(form.closest(".menu-toolbar")).not.toBeNull();
    }
    // Only Delete category is marked as the danger tool, and its panel states the consequence
    // before the button (the destructive-button test pins the rest).
    expect(
      [...document.querySelectorAll(".menu-opener--danger")].map((item) => visibleText(item)),
    ).toEqual(Array(4).fill("Delete category"));
  });

  test("every editor opens on top of the page: a modal dialog named by its title, with Close", async () => {
    for (const states of [{}, { menuProblems: true }] satisfies HarnessStates[]) {
      const document = await rolePage(await editor(states));
      // Nothing is drawn open on a GET, no backdrop covers the page, none of it is inert, and no
      // button is lit as holding a refused form.
      expect(
        document.querySelectorAll(".overlay--open, .overlay-backdrop, [inert], .menu-opener--kept"),
      ).toHaveLength(0);
      const tools = [...document.querySelectorAll(".menu-toolbar > .menu-tool")];
      expect(tools.length).toBeGreaterThan(10);
      for (const tool of tools) {
        // The button opens its own panel, which follows it in the markup: as a modal dialog by
        // its invoker command, or as a popover in a browser without invoker commands.
        const [button, panel, ...rest] = [...tool.children];
        expect(rest).toHaveLength(0);
        const id = button?.getAttribute("commandfor") ?? "";
        expect({
          tag: button?.tagName,
          type: button?.getAttribute("type"),
          command: button?.getAttribute("command"),
          popover: button?.getAttribute("popovertarget"),
          popup: button?.getAttribute("aria-haspopup"),
          panel: panel?.id,
        }).toEqual({
          tag: "BUTTON",
          type: "button",
          command: "show-modal",
          popover: id,
          popup: "dialog",
          panel: id,
        });
        expect(document.getElementById(id) === panel).toBe(true);
        // A closed dialog element that a click outside closes, its popover attribute the
        // fallback; Delete category's confirmation is an alert dialog.
        const danger = button?.matches(".menu-opener--danger") === true;
        expect({
          tag: panel?.tagName,
          open: panel?.hasAttribute("open"),
          popover: panel?.getAttribute("popover"),
          closedby: panel?.getAttribute("closedby"),
          role: panel?.getAttribute("role"),
          modal: panel?.hasAttribute("aria-modal"),
        }).toEqual({
          tag: "DIALOG",
          open: false,
          popover: "auto",
          closedby: "any",
          role: danger ? "alertdialog" : null,
          modal: false,
        });
        // Named by its title: the action the button says, then the category's name.
        const title = document.getElementById(panel?.getAttribute("aria-labelledby") ?? "");
        expect(title?.closest(".overlay")).toBe(panel ?? null);
        expect(title?.tagName).toBe("H4");
        const category = button?.closest(".menu-category")?.querySelector("h3 > span[dir]");
        expect((title?.textContent ?? "").trim()).toBe(
          `${visibleText(button as Element)}: ${category?.textContent}`,
        );
        // Never in capitals by a class (an .orr-label): Chromium names the dialog in them too.
        expect(title?.querySelector(".orr-label")).toBeNull();
        // Its head's Close closes it; Delete category's Cancel too. Each names what it closes.
        const closers = [...(panel?.querySelectorAll("[command]") ?? [])];
        expect(closers.length).toBeGreaterThan(0);
        for (const close of closers)
          expect([
            close.tagName,
            close.getAttribute("type"),
            close.getAttribute("commandfor"),
            close.getAttribute("command"),
            close.getAttribute("popovertarget"),
            close.getAttribute("popovertargetaction"),
          ]).toEqual(["BUTTON", "button", id, "close", id, "hide"]);
        expect(panel?.querySelector(".overlay__head > .overlay__close")).toBe(closers[0] ?? null);
        // Opening it moves focus to one place inside: a long editor's title (Edit roles, Edit
        // category), so a phone's keyboard doesn't cover the sheet; Add roles' first choice;
        // Cancel in a confirmation; or Close when there is nothing to fill in.
        const focused = [...(panel?.querySelectorAll("[autofocus]") ?? [])];
        expect(focused).toHaveLength(1);
        const label = visibleText(button as Element);
        const first = panel?.querySelector('.overlay__body input:not([type="hidden"])');
        const expected = ["Edit roles", "Edit category"].includes(label)
          ? title
          : danger
            ? closers[1]
            : (first ?? closers[0]);
        expect({ label, focus: focused[0] === expected }).toEqual({ label, focus: true });
        // Where focus skips the note that says what the panel is about (a confirmation, or Add
        // roles with nothing to add), that note describes the dialog.
        const note = document.getElementById(panel?.getAttribute("aria-describedby") ?? "");
        if (danger || expected === closers[0])
          expect([note?.closest(".overlay") === panel, note?.className]).toEqual([true, "note"]);
        else expect(panel?.hasAttribute("aria-describedby")).toBe(false);
      }
      // Every commandfor and popovertarget on the page names a dialog there, each opened by one
      // button.
      for (const name of ["commandfor", "popovertarget"]) {
        const targets = [...document.querySelectorAll(`[${name}]`)];
        for (const target of targets)
          expect(document.getElementById(target.getAttribute(name) ?? "")?.tagName).toBe("DIALOG");
        const opened = targets
          .filter((target) => target.matches(".menu-opener"))
          .map((target) => target.getAttribute(name));
        expect(new Set(opened).size).toBe(opened.length);
        expect(opened).toHaveLength(document.querySelectorAll("dialog").length);
      }
      // Every autofocus is inside a closed dialog, which page load skips: nothing moves focus or
      // scrolls the page when it loads.
      for (const element of document.querySelectorAll("[autofocus]"))
        expect(element.closest("dialog:not([open])")).not.toBeNull();
    }
  });

  test("every editor's panel is anchored to its own button: one pair of classes by the card's place and the editor", async () => {
    for (const states of [{}, { menuProblems: true }] satisfies HarnessStates[]) {
      const document = await rolePage(await editor(states));
      const cards = [...document.querySelectorAll(".menu-categories > .menu-category")];
      expect(cards.length).toBeGreaterThan(2);
      expect(cards.length).toBeLessThanOrEqual(MENU_LIMITS.categories);
      const names: string[] = [];
      for (const [at, card] of cards.entries()) {
        const tools = [...card.querySelectorAll(".menu-toolbar > .menu-tool")];
        expect(tools.length).toBeGreaterThan(2);
        for (const tool of tools) {
          const [button, panel] = [...tool.children];
          // The editor, as the panel's id names it after the card's (Edit roles: "edit-roles").
          const editorName = (panel?.id ?? "").slice(card.id.length + 1);
          expect(["edit-roles", "add-roles", "edit-category", "delete"]).toContain(editorName);
          const name = `c${at}-${editorName}`;
          // The button names itself an anchor, once; its panel points at that name and is placed
          // beside it. Nothing else in the tool carries an anchor class.
          expect([...(button?.classList ?? [])].filter((item) => item.includes("anchor"))).toEqual([
            `anchor-${name}`,
          ]);
          expect([...(panel?.classList ?? [])].filter((item) => item.includes("anchor"))).toEqual([
            "overlay--anchored",
            `anchored-${name}`,
          ]);
          expect(tool.querySelectorAll("[class*='anchor']")).toHaveLength(2);
          names.push(name);
        }
      }
      // Each name once on the page (anchor names are global), one per dialog, and no other element
      // names or points at an anchor.
      expect(new Set(names).size).toBe(names.length);
      expect(names).toHaveLength(document.querySelectorAll("dialog").length);
      expect(document.querySelectorAll("[class*='anchor-c']")).toHaveLength(names.length);
      expect(document.querySelectorAll("[class*='anchored-c']")).toHaveLength(names.length);
    }
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

  test("destructive buttons sit only inside a closed dialog or disclosure that states the consequence first", async () => {
    for (const states of [{}, { menuUnreadable: true }] satisfies HarnessStates[]) {
      const document = await rolePage(await editor(states));
      const dangers = [...document.querySelectorAll(".orr-btn--danger")];
      expect(dangers.length).toBeGreaterThan(0);
      for (const button of dangers) {
        // Delete category: in a card's closed alert dialog, described by the consequence, whose
        // first focus is Cancel, so Enter or Space as it opens deletes nothing. Reset role menu:
        // in a closed disclosure.
        const panel = button.closest(".overlay");
        const details = button.closest("details");
        expect([panel === null, details === null]).toEqual(
          states.menuUnreadable ? [true, false] : [false, true],
        );
        if (panel) {
          expect([panel.tagName, panel.getAttribute("role"), panel.hasAttribute("open")]).toEqual([
            "DIALOG",
            "alertdialog",
            false,
          ]);
          expect(panel.classList.contains("overlay--open")).toBe(false);
          expect(panel.querySelector("[autofocus]")?.getAttribute("command")).toBe("close");
          expect(button.hasAttribute("autofocus")).toBe(false);
          const note = button.closest("form")?.querySelector(".note");
          expect(note?.id).toBeTruthy();
          expect(panel.getAttribute("aria-describedby")).toBe(note?.id ?? "");
        }
        if (details) expect(details.hasAttribute("open")).toBe(false);
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
    // No confirmation is asked while TaruBot can read every channel.
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
    // An empty category's Add roles stays closed like every editor (a dialog can't be opened
    // from markup, and one opened on load would cover the page): the card says where to start.
    const add = healthy
      .querySelector(`#category-${MENU_CATEGORY.pronouns}-roles`)
      ?.closest(".overlay");
    expect([add?.getAttribute("popover"), add?.classList.contains("overlay--open")]).toEqual([
      "auto",
      false,
    ]);
    expect(healthy.querySelectorAll(".overlay--open")).toHaveLength(0);
    expect(
      card(healthy, MENU_CATEGORY.pronouns)?.querySelector(".menu-category__body .note")
        ?.textContent,
    ).toBe("No roles yet. Choose Add roles to list the roles people can pick from this category.");
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
        // A target inside a disclosure is in an open one, and one inside an editor's panel is in
        // the panel drawn open.
        const details = target?.closest("details");
        if (details) expect(details.hasAttribute("open")).toBe(true);
        const panel = target?.closest(".overlay");
        if (panel) expect(panel.classList.contains("overlay--open")).toBe(true);
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

  test("a refused editor comes back drawn open on top of the page, holding the focused error summary", async () => {
    const state = await editor();
    const changed = [{ field: "form", message: SELF_ROLE_MESSAGES.changed }] as const;
    // Edit roles, Add roles (with its form, and with only its note while the roles can't be read)
    // and Edit category: each comes back open, its category's other editors still closed dialogs.
    const editors: [SelfRoleEditor, RefusedEdit, string, string][] = [
      [
        state,
        {
          form: { kind: "add", categoryId: MENU_CATEGORY.games },
          values: { roleIds: [], acknowledged: false },
          revision: 7n,
          errors: [{ field: "roleIds", message: "Choose at least one role to add." }],
        },
        "add-roles",
        "Add roles: Games",
      ],
      [
        await editor({}, { roles: null }),
        {
          form: { kind: "add", categoryId: MENU_CATEGORY.games },
          values: { roleIds: [], acknowledged: false },
          revision: 7n,
          errors: [{ field: "roleIds", message: "Choose at least one role to add." }],
        },
        "add-roles",
        "Add roles: Games",
      ],
      [
        state,
        {
          form: { kind: "category", categoryId: MENU_CATEGORY.content },
          values: { name: "", description: "", max: "any" },
          revision: 7n,
          errors: [{ field: "name", message: "Give the category a name." }],
        },
        "edit-category",
        "Edit category: Content",
      ],
      [
        state,
        {
          form: { kind: "options", categoryId: MENU_CATEGORY.games },
          values: {},
          revision: 7n,
          errors: [{ field: "rows", message: LIMIT_MESSAGES.rows }],
        },
        "edit-roles",
        "Edit roles: Games",
      ],
    ];
    for (const [shown, refused, kind, name] of editors) {
      const document = await rolePage(shown, { refused });
      const categoryId = "categoryId" in refused.form ? refused.form.categoryId : "";
      const id = `category-${categoryId}-${kind}`;
      const open = [...document.querySelectorAll(".overlay--open")];
      expect(open).toHaveLength(1);
      const [panel] = open;
      // The same panel as a plain element (markup can't open a dialog): a modal dialog named by
      // its title, a heading of the page after Add a category, where it comes in the markup.
      expect({
        id: panel?.id,
        tag: panel?.tagName,
        popover: panel?.hasAttribute("popover"),
        role: panel?.getAttribute("role"),
        modal: panel?.getAttribute("aria-modal"),
      }).toEqual({ id, tag: "DIV", popover: false, role: "dialog", modal: "true" });
      const title = document.getElementById(panel?.getAttribute("aria-labelledby") ?? "");
      expect([title?.tagName, title?.textContent?.trim()]).toEqual(["H2", name]);
      // Last in main, over a backdrop of its own, out of every card. The page's own blocks under
      // it are inert, and so is the shell around them (the layout's modal flag): the skip link,
      // the navigation, the page's header and the footer. Neither Tab nor a screen reader lands
      // on anything the panel or its backdrop hides; Close is the way out.
      const main = document.querySelector("main");
      expect(main?.lastElementChild).toBe(panel ?? null);
      expect(panel?.previousElementSibling?.className).toBe("overlay-backdrop");
      expect(panel?.closest(".menu-category")).toBeNull();
      // Centred, as before anchoring: the page loads at its top, where the button may be off the
      // screen, so the panel points at no anchor, and the link standing in for its button names
      // none.
      expect([...(panel?.classList ?? [])].filter((item) => item.includes("anchor"))).toEqual([]);
      const blocks = [...(main?.children ?? [])];
      expect(blocks.slice(-2)).toEqual([
        panel?.previousElementSibling as Element,
        panel as Element,
      ]);
      // The lead, any banners, the summary card, Categories and Add a category.
      const behind = blocks.slice(1, -2);
      expect(blocks[0]?.className).toBe("page-header");
      expect(behind.length).toBeGreaterThanOrEqual(4);
      for (const block of behind) expect(block.hasAttribute("inert")).toBe(true);
      const shell = [".skip", ".sidebar", ".page-header", ".site-footer"].map((selector) =>
        document.querySelector(selector),
      );
      for (const part of shell) expect(part?.hasAttribute("inert")).toBe(true);
      expect(document.querySelectorAll("[inert]")).toHaveLength(behind.length + shell.length);
      // The page's one error summary is the first thing in the panel's body, and the only
      // autofocus that page load can reach (every other is in a closed dialog).
      const summaries = [...document.querySelectorAll(".error-summary")];
      expect(summaries).toHaveLength(1);
      expect(panel?.querySelector(".overlay__body")?.firstElementChild).toBe(summaries[0] ?? null);
      expect(
        [...document.querySelectorAll("[autofocus]")].filter((item) => !item.closest("dialog")),
      ).toEqual(summaries);
      // Each message shows once: a message about the form as a whole is the summary's, just
      // above the form, and not repeated at the form's top.
      expect(panel?.querySelectorAll(".form-error")).toHaveLength(0);
      expect(summaries[0]?.querySelectorAll("a")).toHaveLength(refused.errors.length);
      for (const link of summaries[0]?.querySelectorAll("a") ?? [])
        expect(
          document.getElementById((link.getAttribute("href") ?? "").slice(1))?.closest(".overlay"),
        ).toBe(panel ?? null);
      // Close loads the page afresh (a new GET, not a jump within this POST's page), at the card.
      expect(panel?.querySelector(".overlay__head > a.overlay__close")?.getAttribute("href")).toBe(
        `${path}?category=${categoryId}#category-${categoryId}-title`,
      );
      // In the card, a link to the open panel stands in for the editor's button; its other
      // editors stay closed dialogs, and no id is on the page twice.
      const tools = card(document, categoryId)?.querySelector(".menu-toolbar");
      expect(tools?.querySelector(`a.menu-opener[href="#${id}-title"]`)).not.toBeNull();
      expect(
        tools?.querySelector(`a.menu-opener[href="#${id}-title"]`)?.getAttribute("class"),
      ).not.toContain("anchor");
      expect(
        document.querySelectorAll(`[commandfor="${id}"], [popovertarget="${id}"]`),
      ).toHaveLength(0);
      expect(tools?.querySelectorAll("dialog").length).toBeGreaterThan(1);
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
      expect(ids.filter((item, at) => ids.indexOf(item) !== at)).toEqual([]);
    }
    // Every other refused form keeps the summary at the top, with nothing drawn open and nothing
    // inert: a card's buttons (Delete category's included), Add a category, Publish N drafts, an
    // editor whose category another officer removed, and a conflict (the next test).
    const others: RefusedEdit[] = [
      {
        form: { kind: "action", categoryId: MENU_CATEGORY.games },
        values: {},
        revision: 8n,
        errors: [...changed],
      },
      { form: { kind: "menu" }, values: {}, revision: 8n, errors: [...changed] },
      {
        form: { kind: "create" },
        values: { name: "", description: "", max: "any", categoryId: NEW_ID },
        revision: 7n,
        errors: [{ field: "name", message: "Give the category a name." }],
      },
      {
        form: { kind: "options", categoryId: "00000000-0000-4000-8000-000000000009" },
        values: {},
        revision: 8n,
        errors: [...changed],
      },
      {
        form: { kind: "options", categoryId: MENU_CATEGORY.games },
        values: {},
        revision: 8n,
        errors: [...changed],
        conflict: true,
      },
    ];
    for (const refused of others) {
      const document = await rolePage(state, { refused });
      expect(document.querySelectorAll(".overlay--open, .overlay-backdrop, [inert]")).toHaveLength(
        0,
      );
      expect(document.querySelector("main > .page-header + .error-summary")).not.toBeNull();
    }
  });

  test("a conflict isn't drawn open: the summary links to the card, whose editor keeps the changes, its button lit", async () => {
    const state = await editor();
    const changed = [{ field: "form", message: SELF_ROLE_MESSAGES.changed }] as const;
    // A 409 on each editor that can be drawn open, with what the officer changed (only that) and
    // the current revision, as the page module passes them; and how each change shows again.
    const conflicts: [RefusedEdit, string, (panel: Element | null) => unknown, unknown][] = [
      [
        {
          form: { kind: "add", categoryId: MENU_CATEGORY.games },
          values: { roleIds: [MENU_ROLE.tank], acknowledged: false },
          revision: 8n,
          errors: [...changed],
          conflict: true,
        },
        "add-roles",
        (panel) =>
          panel?.querySelector(`input[value="${MENU_ROLE.tank}"]`)?.hasAttribute("checked"),
        true,
      ],
      [
        {
          form: { kind: "category", categoryId: MENU_CATEGORY.content },
          values: { name: "Kept name" },
          revision: 8n,
          errors: [...changed],
          conflict: true,
        },
        "edit-category",
        (panel) =>
          panel?.querySelector(`#category-${MENU_CATEGORY.content}-name`)?.getAttribute("value"),
        "Kept name",
      ],
      [
        {
          form: { kind: "options", categoryId: MENU_CATEGORY.games },
          values: { rows: new Map([[MENU_ROLE.valheim, { description: "Kept description" }]]) },
          revision: 8n,
          errors: [...changed],
          conflict: true,
        },
        "edit-roles",
        (panel) =>
          panel?.querySelector(`#option-${MENU_ROLE.valheim}-description`)?.getAttribute("value"),
        "Kept description",
      ],
    ];
    for (const [refused, kind, kept, expected] of conflicts) {
      const document = await rolePage(state, { refused });
      const categoryId = "categoryId" in refused.form ? refused.form.categoryId : "";
      const id = `category-${categoryId}-${kind}`;
      // Nothing is drawn open and nothing is inert: the officer can check the menu as it is now,
      // as the message asks, rather than through a dimmed page.
      expect(document.querySelectorAll(".overlay--open, .overlay-backdrop, [inert]")).toHaveLength(
        0,
      );
      // The summary is at the top and takes focus; its one link goes to the card's heading.
      const summary = document.querySelector("main > .page-header + .error-summary");
      expect(summary?.hasAttribute("autofocus")).toBe(true);
      expect(
        [...(summary?.querySelectorAll("a") ?? [])].map((link) => [
          link.getAttribute("href"),
          link.textContent,
        ]),
      ).toEqual([[`#category-${categoryId}-title`, SELF_ROLE_MESSAGES.changed]]);
      expect(
        [...document.querySelectorAll("[autofocus]")].filter((item) => !item.closest("dialog")),
      ).toEqual([summary as Element]);
      // The editor is its card's closed dialog, holding what the officer changed at the current
      // revision, with the message at its form's top for when they open it again.
      const panel = document.getElementById(id);
      expect([
        panel?.tagName,
        panel?.hasAttribute("open"),
        panel?.closest(".menu-category")?.id,
      ]).toEqual(["DIALOG", false, `category-${categoryId}`]);
      expect(kept(panel)).toBe(expected);
      expect(panel?.querySelector('input[name="revision"]')?.getAttribute("value")).toBe("8");
      expect(panel?.querySelector("form > .form-error")?.textContent).toBe(
        `Error: ${SELF_ROLE_MESSAGES.changed}`,
      );
      // Its button stays lit, marking where the changes wait; no other button is.
      expect(
        [...document.querySelectorAll(".menu-opener--kept")].map((button) => [
          button.tagName,
          button.getAttribute("commandfor"),
        ]),
      ).toEqual([["BUTTON", id]]);
    }
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
    // Only a published category offers Stop offering; a draft may have been published before, so
    // its note says only what holds now.
    const document = await rolePage(await editor());
    const note = (id: string) =>
      card(document, id)?.querySelector(".orr-btn--danger")?.closest("form")?.querySelector(".note")
        ?.textContent;
    expect(note(MENU_CATEGORY.pronouns)).toBe(
      "People keep these roles in Discord, but won't be able to add or remove them themselves. To let people still remove them, choose Stop offering instead.",
    );
    expect(note(MENU_CATEGORY.content)).toBe(
      "Members and guests don't see a draft. People keep these roles in Discord, but won't be able to change them on My roles.",
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
      await rolePage(state, {
        refused: {
          form: { kind: "category", categoryId: MENU_CATEGORY.games },
          values: {},
          revision: 8n,
          errors: [{ field: "form", message: SELF_ROLE_MESSAGES.changed }],
          conflict: true,
        },
      }),
    ];
    const classes = new Set<string>();
    for (const document of documents)
      for (const element of document.querySelectorAll("main [class]"))
        for (const name of element.classList) classes.add(name);
    for (const name of [
      "orr-badge",
      "menu-category",
      "option-row",
      "menu-problems",
      "form-error",
      "overlay--open",
      "menu-opener--kept",
    ])
      expect({ name, rendered: classes.has(name) }).toEqual({ name, rendered: true });
    for (const name of classes) {
      if (drawnByOthers.has(name)) continue;
      expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
        name,
        styled: true,
      });
    }
  });
});

describe("My roles (2.40.0)", () => {
  const SECOND = HARNESS_GUILDS.second.id;
  const MY_ROLES = "/g/:guild/my-roles";

  /** Someone admitted to My roles here, as actor resolution makes them: a member by default. */
  const person = (userId: string, overrides: Partial<Actor> = {}, guildId = GUILD): Actor => ({
    guildId,
    userId,
    officer: false,
    manageRoles: false,
    member: true,
    guest: false,
    botAdministrator: false,
    timedOut: false,
    ...overrides,
  });
  const member = person(HARNESS_ACCOUNTS.member.id);
  const guest = person(HARNESS_ACCOUNTS.guest.id, { member: false, guest: true });
  const officer = person(HARNESS_ACCOUNTS.officer.id, { officer: true });

  /** A people store where `actor` holds exactly `held` (menu roles) in their server. */
  const holding = (actor: Actor, held: readonly string[]) => {
    const people = harnessPeople();
    people.held.set(`${actor.guildId}:${actor.userId}`, new Set(held));
    return people;
  };

  /** What SelfRoles.view gives `actor` over the harness's invented menus, with any field replaced. */
  async function viewOf(
    actor: Actor,
    options: {
      states?: HarnessStates;
      menus?: HarnessMenus;
      people?: ReturnType<typeof harnessPeople>;
      overrides?: Partial<MyRoles>;
    } = {},
  ): Promise<MyRoles> {
    const service = harnessSelfRoles(options.states ?? {}, options.menus, options.people);
    return { ...(await service.view(actor)), ...options.overrides };
  }

  /** The whole document for a My roles view, as the page renders it for `viewer`. */
  async function myRolesPage(
    roles: MyRoles,
    options: { viewer?: Actor; url?: string; refused?: RefusedChoice } = {},
  ): Promise<{ document: Document; markup: string }> {
    const viewer = options.viewer ?? member;
    const path = `/g/${roles.guildId}/my-roles`;
    const markup = await render(
      layout(
        {
          title: "My roles",
          signedIn: true,
          formToken: TOKEN,
          guild: {
            id: roles.guildId,
            name: "Example FC",
            nav: navLinks((await loadPages()).values(), viewer, MY_ROLES),
            audience: viewer.officer ? "officer" : "member",
          },
          ...(options.refused && { error: true }),
        },
        renderMyRoles({
          roles,
          officer: viewer.officer,
          action: path,
          token: TOKEN,
          url: new URL(options.url ?? path, "https://example.org"),
          ...(options.refused && { refused: options.refused }),
        }),
      ),
    );
    return { document: inspect(markup), markup };
  }

  /** Text without visually hidden parts: what a sighted person reads. */
  const visibleText = (element: Element | null): string => {
    if (!element) return "";
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".visually-hidden")) hidden.remove();
    return (copy.textContent ?? "").replace(/\s+/gu, " ").trim();
  };

  /** A category's fieldset, and what its inputs carry. */
  const group = (document: Document, categoryId: string) =>
    document.querySelector(`fieldset#category-${categoryId}`);
  const inputs = (document: Document, categoryId: string) =>
    [...(group(document, categoryId)?.querySelectorAll("input") ?? [])].map((input) => ({
      value: input.getAttribute("value"),
      type: input.getAttribute("type"),
      name: input.getAttribute("name"),
      checked: input.hasAttribute("checked"),
      disabled: input.hasAttribute("disabled"),
      label: visibleText(document.querySelector(`label[for="${input.getAttribute("id")}"]`)),
    }));
  /** The hidden fields a save sends: `shown` and each category's `seen`. */
  const hiddenValues = (document: Document, name: string) =>
    [...document.querySelectorAll(`main input[type="hidden"][name="${name}"]`)].map((input) =>
      input.getAttribute("value"),
    );
  const statusText = (document: Document) =>
    [...document.querySelectorAll("#status .notice")].map((banner) => banner.textContent);
  const callouts = (document: Document) =>
    [...document.querySelectorAll(".my-roles-callouts .notice")].map((note) => note.textContent);
  const PRIVACY =
    "Roles you choose appear on your profile in this server, where everyone can see them. TaruBot keeps no record of which roles you choose; Discord holds your roles.";
  /**
   * A rule set that refuses `roleIds` as roles above TaruBot's (so nobody can add or remove them
   * here) and passes every other role.
   */
  const refusing =
    (...roleIds: string[]): RoleChecker =>
    (roleId) => ({
      roleId,
      problems: roleIds.includes(roleId)
        ? [{ code: "above_bot", message: "It sits above TaruBot's role." }]
        : [],
      opens: [],
    });

  test("the page module: members, guests and officers, SelfRoles alone, a budget of 10 POSTs", async () => {
    const pages = await loadPages();
    const page = pages.get(MY_ROLES);
    expect(page?.access).toEqual(["member", "guest", "officer"]);
    // Every member and guest reaches this page's code, so it can reach no other service.
    expect(page?.requires).toEqual([selfRolesKey]);
    // Nor can the service it gets write to Discord: the roles.self job's write lives on
    // RoleChoiceJob, which only the job dispatcher builds.
    expect("apply" in SelfRoles.prototype).toBeFalse();
    expect(typeof RoleChoiceJob.prototype.apply).toBe("function");
    expect(page?.postLimit).toBe(10);
    expect(page?.nav).toBe("My roles");
    expect(page?.icon).toBe("user");
    expect(page?.title).toBe("My roles");
    // Members and guests see My roles alone; with Administrator (A2), nothing at all.
    for (const actor of [member, guest])
      expect(navLinks(pages.values(), actor).map((link) => link.label)).toEqual(["My roles"]);
    expect(navLinks(pages.values(), { ...member, botAdministrator: true })).toEqual([]);
    // Unknown (TaruBot's own member isn't cached) counts as holding it.
    const unknown: Actor = {
      guildId: GUILD,
      userId: member.userId,
      officer: false,
      manageRoles: false,
      member: true,
    };
    expect(navLinks(pages.values(), unknown)).toEqual([]);
  });

  test("one card per category the person may change, each a fieldset whose legend is its heading", async () => {
    const { document } = await myRolesPage(await viewOf(member));
    const groups = [...document.querySelectorAll("main fieldset.choice-group")];
    expect(groups.map((fieldset) => fieldset.querySelector("legend > h2")?.textContent)).toEqual([
      "Pronouns",
      "Games",
      "Retired events",
    ]);
    // The page's one h1, then a heading per category, so someone can move between them.
    expect([...document.querySelectorAll("main h2")].map((h2) => h2.textContent)).toEqual([
      "Pronouns",
      "Games",
      "Retired events",
    ]);
    // The legend, the rule and the description are read with the group; each in words.
    const pronouns = group(document, MENU_CATEGORY.pronouns);
    expect(pronouns?.getAttribute("aria-describedby")).toBe(
      `category-${MENU_CATEGORY.pronouns}-hint`,
    );
    expect(document.getElementById(`category-${MENU_CATEGORY.pronouns}-hint`)?.textContent).toBe(
      "Pick any number. Shown on your profile, so people know how to refer to you.",
    );
    // On screen the rule sits beside the name, on the legend's line, as a copy hidden from
    // assistive technology, so neither the group's name nor the heading's takes it; the hint keeps
    // it for them, visually hidden, so the hint's visible text starts with the description.
    const rule = pronouns?.querySelector("legend > .my-category__rule");
    expect([
      rule?.textContent,
      rule?.getAttribute("aria-hidden"),
      rule?.previousElementSibling?.tagName,
    ]).toEqual(["Pick any number", "true", "H2"]);
    expect(visibleText(document.getElementById(`category-${MENU_CATEGORY.pronouns}-hint`))).toBe(
      "Shown on your profile, so people know how to refer to you.",
    );
    const rows: [string, string, boolean][] = [
      [MENU_ROLE.heHim, "He/Him", false],
      [MENU_ROLE.sheHer, "She/Her", true],
      [MENU_ROLE.theyThem, "They/Them", false],
      // Held, no longer offered: ticked, and unticking it removes it.
      [MENU_ROLE.askMe, "Ask my pronouns No longer offered", true],
    ];
    expect(inputs(document, MENU_CATEGORY.pronouns)).toEqual(
      rows.map(([value, label, checked]) => ({
        value,
        type: "checkbox",
        name: `c-${MENU_CATEGORY.pronouns}`,
        checked,
        disabled: false,
        label,
      })),
    );
    // An option's description is tied to its input, not part of its name.
    const ask = document.querySelector(`input[value="${MENU_ROLE.askMe}"]`);
    expect(document.getElementById(ask?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Replaced by your profile's own pronouns field.",
    );
    // Every row's label covers its row (styles/my-roles.ts): a native input with its own label.
    for (const row of document.querySelectorAll(".my-category .orr-check"))
      expect(row.querySelector("input + .orr-check__text > label")).not.toBeNull();
    expect(document.querySelectorAll("main form")).toHaveLength(1);
    expect(visibleText(document.querySelector("main form button"))).toBe("Save my roles");
  });

  test("the Save hint describes the button from outside the sticky Save row", async () => {
    const { document } = await myRolesPage(await viewOf(member));
    const form = document.querySelector("main form.my-roles-form");
    const button = form?.querySelector(".form-actions > button");
    const hint = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Only the categories you change are saved.");
    // On phones the row sticks to the bottom of the screen; with enlarged text a hint inside it
    // grew it over the focused input (styles/my-roles.ts), so the hint is the form's own line,
    // just before the row, and the row holds the button alone.
    expect(hint?.parentElement?.matches("main form.my-roles-form")).toBe(true);
    expect(hint?.nextElementSibling?.classList.contains("form-actions")).toBe(true);
    expect(form?.querySelector(".form-actions")?.children).toHaveLength(1);
  });

  test("the form says what it showed: shown and seen per category, inputs named c-<id>", async () => {
    const { document } = await myRolesPage(await viewOf(member));
    expect(hiddenValues(document, "shown")).toEqual([
      MENU_CATEGORY.pronouns,
      MENU_CATEGORY.games,
      MENU_CATEGORY.retired,
    ]);
    expect(hiddenValues(document, `seen:${MENU_CATEGORY.pronouns}`)).toEqual([
      MENU_ROLE.sheHer,
      MENU_ROLE.askMe,
    ]);
    expect(hiddenValues(document, `seen:${MENU_CATEGORY.games}`)).toEqual([MENU_ROLE.valheim]);
    expect(hiddenValues(document, `seen:${MENU_CATEGORY.retired}`)).toEqual([MENU_ROLE.halloween]);
    // Every hidden field is the token, `shown` or a `seen`: nothing else rides along.
    expect(
      new Set(
        [...document.querySelectorAll('main input[type="hidden"]')].map((input) =>
          (input.getAttribute("name") ?? "").replace(/:.*$/u, ":"),
        ),
      ),
    ).toEqual(new Set([FORM_TOKEN_FIELD, "shown", "seen:"]));
  });

  test("a pick-one category: radios starting with None, preselected by what is held", async () => {
    const actor = person(HARNESS_ACCOUNTS.member.id, {}, SECOND);
    const main = SECOND_CATEGORY.mainRole;
    const values = (document: Document) =>
      inputs(document, main).map(({ value, type, checked }) => ({ value, type, checked }));
    const radio = (value: string, checked: boolean) => ({ value, type: "radio", checked });
    // Healer and Tank both held (Dyno leftovers): no radio preselected, a note, and each held row
    // says so; the form shows nothing ticked, so it sends no `seen` and counts as unchanged.
    const { document: several } = await myRolesPage(await viewOf(actor));
    expect(values(several)).toEqual([
      radio("", false),
      radio(MENU_ROLE.healer, false),
      radio(MENU_ROLE.tank, false),
      radio(MENU_ROLE.dps, false),
    ]);
    expect(inputs(several, main).map((row) => row.label)).toEqual([
      "No role from this category",
      "Healer You have this",
      "Tank You have this",
      "DPS",
    ]);
    expect(several.getElementById(`category-${main}-hint`)?.textContent).toBe(
      "Pick one. What you usually play in duties. You have 2 of these roles. Pick one to keep it and remove the others.",
    );
    expect(hiddenValues(several, "shown")).toContain(main);
    expect(hiddenValues(several, `seen:${main}`)).toEqual([]);
    // One held: that one; none held: "No role from this category", sent as "" in `seen`.
    const { document: one } = await myRolesPage(
      await viewOf(actor, { people: holding(actor, [MENU_ROLE.tank]) }),
    );
    expect(values(one).filter((row) => row.checked)).toEqual([radio(MENU_ROLE.tank, true)]);
    expect(hiddenValues(one, `seen:${main}`)).toEqual([MENU_ROLE.tank]);
    expect(one.querySelector(".my-category__note")).toBeNull();
    const { document: none } = await myRolesPage(
      await viewOf(actor, { people: holding(actor, []) }),
    );
    expect(values(none).filter((row) => row.checked)).toEqual([radio("", true)]);
    expect(hiddenValues(none, `seen:${main}`)).toEqual([""]);
  });

  test("pick-several: an 'up to N' hint, and a note when more are held than a lowered limit", async () => {
    const menus: HarnessMenus = new Map([
      [
        GUILD,
        {
          menu: {
            ...HARNESS_MENU,
            categories: HARNESS_MENU.categories.map((category) =>
              category.id === MENU_CATEGORY.pronouns ? { ...category, max: 2 } : category,
            ),
          },
          revision: MENU_REVISION,
        },
      ],
    ]);
    const people = holding(member, [MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem]);
    const { document } = await myRolesPage(await viewOf(member, { menus, people }));
    expect(document.getElementById(`category-${MENU_CATEGORY.pronouns}-hint`)?.textContent).toBe(
      "Pick up to 2. Shown on your profile, so people know how to refer to you. You have 3; the limit is now 2.",
    );
    expect(
      inputs(document, MENU_CATEGORY.pronouns)
        .filter((row) => row.checked)
        .map((row) => row.value),
    ).toEqual([MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem]);
    expect(inputs(document, MENU_CATEGORY.pronouns).every((row) => row.type === "checkbox")).toBe(
      true,
    );
  });

  test("roles no longer offered show only to the people who hold them, to remove", async () => {
    const { document: theirs } = await myRolesPage(await viewOf(member));
    const retired = group(theirs, MENU_CATEGORY.retired);
    expect(visibleText(retired?.querySelector("legend") ?? null)).toBe(
      "Retired events You can remove these No longer offered",
    );
    expect(theirs.getElementById(`category-${MENU_CATEGORY.retired}-hint`)?.textContent).toBe(
      "You can remove these. Event roles from past seasons.",
    );
    expect(inputs(theirs, MENU_CATEGORY.retired).map((row) => [row.label, row.checked])).toEqual([
      ["Halloween 2025", true],
    ]);
    // The guest holds neither Halloween 2025 nor Ask my pronouns: neither shows.
    const { document: others } = await myRolesPage(await viewOf(guest), { viewer: guest });
    expect(group(others, MENU_CATEGORY.retired)).toBeNull();
    expect(others.querySelector(`input[value="${MENU_ROLE.askMe}"]`)).toBeNull();
    expect(others.querySelector(`input[value="${MENU_ROLE.halloween}"]`)).toBeNull();
    expect(inputs(others, MENU_CATEGORY.pronouns).map((row) => row.label)).toEqual([
      "He/Him",
      "She/Her",
      "They/Them",
    ]);
  });

  test("a held role that fails a rule now can still be unticked, and says it can't be picked again", async () => {
    // --state-menu-problems, judged by the real rule set: They/Them sits above the Moderator and
    // Dyno roles (above_staff), and She/Her gained Mention @everyone (a server permission). Neither
    // stops its holders removing it, so each held one is still an input, but once unticked and
    // saved it's gone for good until officers fix it: the badge warns before that one-way change.
    const badge = "Can't be picked again right now";
    const states = { menuProblems: true };
    const { document: theirs } = await myRolesPage(await viewOf(officer, { states }), {
      viewer: officer,
    });
    expect(
      inputs(theirs, MENU_CATEGORY.pronouns).map((row) => [row.label, row.checked, row.disabled]),
    ).toEqual([
      ["He/Him", false, false],
      [`They/Them ${badge}`, true, false],
    ]);
    // The member's own view of the same rule set (in the harness TaruBot also holds Administrator
    // there, which keeps members out until it doesn't; the actor here says it doesn't).
    const { document: mine } = await myRolesPage(await viewOf(member, { states }));
    expect(inputs(mine, MENU_CATEGORY.pronouns).map((row) => [row.label, row.checked])).toEqual([
      ["He/Him", false],
      [`She/Her ${badge}`, true],
      // Not offered says so already; it never gets both.
      ["Ask my pronouns No longer offered", true],
    ]);
    // The badge is part of the input's accessible name, and never says why.
    const sheHer = mine.querySelector(`input[value="${MENU_ROLE.sheHer}"]`);
    expect(mine.querySelector(`label[for="${sheHer?.getAttribute("id")}"]`)?.textContent).toContain(
      badge,
    );
    for (const document of [theirs, mine])
      expect(document.querySelector("main")?.textContent).not.toMatch(/Moderator|Mention/u);
    // A role nobody holds that fails a rule isn't shown at all, so it never gets the badge.
    expect(mine.querySelector(`input[value="${MENU_ROLE.theyThem}"]`)).toBeNull();
    // A pick-one category's radio says the same.
    const actor = person(HARNESS_ACCOUNTS.member.id, {}, SECOND);
    const aboveStaff: RoleChecker = (roleId) => ({
      roleId,
      problems:
        roleId === MENU_ROLE.healer
          ? [{ code: "above_staff", message: "It sits above a moderation role." }]
          : [],
      opens: [],
    });
    const { document: radios } = await myRolesPage(
      await viewOf(actor, {
        overrides: {
          categories: choiceMenu(SECOND_MENU, {
            held: [MENU_ROLE.healer],
            waiting: null,
            check: aboveStaff,
            officer: false,
          }),
        },
      }),
    );
    expect(
      inputs(radios, SECOND_CATEGORY.mainRole).map((row) => [row.type, row.label, row.checked]),
    ).toEqual([
      ["radio", "No role from this category", false],
      ["radio", `Healer ${badge}`, true],
      ["radio", "Tank", false],
      ["radio", "DPS", false],
    ]);
  });

  test("roles held that can't be changed now are text, not inputs; nothing to save, no form", async () => {
    const held = HELD[GUILD]?.[member.userId] ?? [];
    const roles = await viewOf(member, {
      overrides: {
        // Every menu role moved above TaruBot: those held can't be changed, the rest don't show.
        categories: choiceMenu(HARNESS_MENU, {
          held,
          waiting: null,
          check: refusing(...menuRoleIds(HARNESS_MENU)),
          officer: false,
        }),
      },
    });
    const { document } = await myRolesPage(roles);
    expect(document.querySelectorAll("main form, main input:not([type=hidden])")).toHaveLength(0);
    expect(document.querySelectorAll('main input[type="hidden"]')).toHaveLength(0);
    expect([...document.querySelectorAll("main h2")].map((h2) => h2.textContent)).toEqual([
      "Pronouns",
      "Games",
    ]);
    // Nothing to pick: the rule says so instead of asking for a pick, and the roles kept are one
    // sentence per category, by name, in its hint under its heading. No framed line passes for a
    // row to tap.
    expect(
      [...document.querySelectorAll(".my-category .orr-field__hint")].map(
        (hint) => hint.textContent,
      ),
    ).toEqual([
      "Nothing to pick right now. Shown on your profile, so people know how to refer to you. You have @She/Her and @Ask my pronouns. They can't be changed here right now.",
      "Nothing to pick right now. Each game's role opens its channels. You have @Valheim. It can't be changed here right now.",
    ]);
    expect(document.querySelectorAll(".my-category__fixed")).toHaveLength(0);
    expect(callouts(document)).toEqual([]);
  });

  test("a pick-one category with a role held that can't be changed: alone it is text; beside another, no radio preselected", async () => {
    const actor = person(HARNESS_ACCOUNTS.member.id, {}, SECOND);
    const main = SECOND_CATEGORY.mainRole;
    // Healer moved above TaruBot; Tank and DPS can still be picked.
    const shown = async (held: string[]) =>
      (
        await myRolesPage(
          await viewOf(actor, {
            overrides: {
              categories: choiceMenu(SECOND_MENU, {
                held,
                waiting: null,
                check: refusing(MENU_ROLE.healer),
                officer: false,
              }),
            },
          }),
        )
      ).document;
    // Healer alone: Healer fills the one place, so picking Tank or DPS would be refused and "No
    // role from this category" would change nothing. No radio could do anything, so the category
    // is text, like one with only roles that can't change, and the form sends nothing for it.
    const alone = await shown([MENU_ROLE.healer]);
    expect(group(alone, main)).toBeNull();
    expect(alone.querySelectorAll(`input[name="c-${main}"]`)).toHaveLength(0);
    expect(hiddenValues(alone, "shown")).not.toContain(main);
    expect(hiddenValues(alone, `seen:${main}`)).toEqual([]);
    // The role they keep, and why there is nothing to pick, under the category's heading.
    const plain = [...alone.querySelectorAll(".my-category__plain")].find(
      (card) => card.querySelector("h2")?.textContent === "Main role",
    );
    // Said once: no "Pick one" above a card with nothing to pick, and no note repeating it.
    expect(plain?.querySelector(".orr-field__hint")?.textContent).toBe(
      "Nothing to pick right now. What you usually play in duties. You have @Healer. It can't be changed here right now.",
    );
    expect(plain?.querySelector(".my-category__note")).toBeNull();
    // With Tank as well: Tank says it is held, and the note says how to get back to one.
    const both = await shown([MENU_ROLE.healer, MENU_ROLE.tank]);
    expect(inputs(both, main).map((row) => [row.label, row.checked])).toEqual([
      ["No role from this category", false],
      ["Tank You have this", false],
      ["DPS", false],
    ]);
    expect(both.getElementById(`category-${main}-hint`)?.textContent).toBe(
      "Pick one. What you usually play in duties. You have @Healer; it can't be changed here right now. You have 2 of these roles, and one can't be changed here right now. Choose No role from this category to remove the others.",
    );
    // Pick several: a role they keep counts toward a lowered limit, as a save counts it.
    const upToTwo: SelfRoleMenu = {
      v: 1,
      categories: [
        { ...(HARNESS_MENU.categories[0] as SelfRoleMenu["categories"][number]), max: 2 },
      ],
    };
    const { document: pronouns } = await myRolesPage(
      await viewOf(member, {
        overrides: {
          categories: choiceMenu(upToTwo, {
            held: [MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem],
            waiting: null,
            check: refusing(MENU_ROLE.heHim),
            officer: false,
          }),
        },
      }),
    );
    expect(pronouns.querySelector(".my-category__note")?.textContent).toBe(
      "You have 3; the limit is now 2.",
    );
    // Pick several, with exactly as many roles that can't change as the limit, and nothing else
    // ticked: any pick would go over it, so the category is text, saying there's nothing to pick.
    const { document: full } = await myRolesPage(
      await viewOf(member, {
        overrides: {
          categories: choiceMenu(upToTwo, {
            held: [MENU_ROLE.heHim, MENU_ROLE.sheHer],
            waiting: null,
            check: refusing(MENU_ROLE.heHim, MENU_ROLE.sheHer),
            officer: false,
          }),
        },
      }),
    );
    expect(group(full, MENU_CATEGORY.pronouns)).toBeNull();
    expect(full.querySelectorAll("main form, main input")).toHaveLength(0);
    expect(full.querySelector(".my-category__plain .orr-field__hint")?.textContent).toBe(
      "Nothing to pick right now. Shown on your profile, so people know how to refer to you. You have @He/Him and @She/Her. They can't be changed here right now.",
    );
    expect(full.querySelector(".my-category__plain .my-category__note")).toBeNull();
    // A lowered limit is news even with nothing to pick, so that note stays.
    const { document: lowered } = await myRolesPage(
      await viewOf(member, {
        overrides: {
          categories: choiceMenu(upToTwo, {
            held: [MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem],
            waiting: null,
            check: refusing(MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem),
            officer: false,
          }),
        },
      }),
    );
    expect(lowered.querySelector(".my-category__plain .orr-field__hint")?.textContent).toBe(
      "Nothing to pick right now. Shown on your profile, so people know how to refer to you. You have @He/Him, @She/Her and @They/Them. They can't be changed here right now. You have 3; the limit is now 2.",
    );
  });

  test("while a change waits, its ticks show with a badge saying which way each row is waiting", async () => {
    // The waiting change asks for Minecraft instead of Valheim; the member still holds Valheim.
    for (const states of [
      { roles: "queued" },
      { roles: "queued", activation: true },
      { roles: "blocked" },
    ] as const) {
      const { document } = await myRolesPage(await viewOf(member, { states }));
      expect({
        states,
        rows: inputs(document, MENU_CATEGORY.games).map((row) => [row.label, row.checked]),
      }).toEqual({
        states,
        rows: [
          ["Valheim Waiting to remove", false],
          ["Minecraft Waiting to add", true],
        ],
      });
      // Pronouns aren't in the change: as held, no badge.
      expect(
        inputs(document, MENU_CATEGORY.pronouns).some((row) => row.label.includes("Waiting")),
      ).toBe(false);
    }
    // Nothing waiting, nothing badged.
    const { document: settled } = await myRolesPage(await viewOf(member));
    expect(settled.body.textContent).not.toContain("Waiting to");
    // A pick-one category where Healer can't change and a waiting change asks for Tank: Tank is
    // ticked, but isn't held, so it never says "You have this", and the note speaks of the change.
    const actor = person(HARNESS_ACCOUNTS.member.id, {}, SECOND);
    const main = SECOND_CATEGORY.mainRole;
    const { document } = await myRolesPage(
      await viewOf(actor, {
        overrides: {
          categories: choiceMenu(SECOND_MENU, {
            held: [MENU_ROLE.healer],
            waiting: { chosen: [MENU_ROLE.tank], offered: [MENU_ROLE.tank, MENU_ROLE.dps] },
            check: refusing(MENU_ROLE.healer),
            officer: false,
          }),
          status: {
            state: "blocked",
            skipped: 0,
            changed: false,
            recent: false,
            completedAt: null,
          },
        },
      }),
    );
    expect(inputs(document, main).map((row) => row.label)).toEqual([
      "No role from this category",
      "Tank Waiting to add",
      "DPS",
    ]);
    expect(document.getElementById(`category-${main}-hint`)?.textContent).toBe(
      "Pick one. What you usually play in duties. You have @Healer; it can't be changed here right now. With your saved change you'd have 2 of these roles, and one can't be changed here right now. Choose No role from this category to remove the others.",
    );
    // A lowered limit with a change waiting: the count is the change's, never "You have".
    const oneGame: SelfRoleMenu = {
      ...HARNESS_MENU,
      categories: HARNESS_MENU.categories.map((category) =>
        category.id === MENU_CATEGORY.games ? { ...category, max: 1 } : category,
      ),
    };
    const lowered = await myRolesPage(
      await viewOf(member, {
        menus: new Map([[GUILD, { menu: oneGame, revision: MENU_REVISION }]]),
        overrides: {
          categories: choiceMenu(oneGame, {
            held: HELD[GUILD]?.[member.userId] ?? [],
            waiting: {
              chosen: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
              offered: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
            },
            check: refusing(),
            officer: false,
          }),
        },
      }),
    );
    expect(
      lowered.document.getElementById(`category-${MENU_CATEGORY.games}-hint`)?.textContent,
    ).toContain(
      "With your saved change you'd have 2 of these roles. Pick one to keep it and remove the others.",
    );
  });

  test("published roles that all fail a rule now: nothing to pick right now, never 'officers haven't set up'", async () => {
    // Every menu role refused (TaruBot lost Manage Roles, say), and the person holds none.
    const nothing = (actor: Actor) =>
      viewOf(actor, {
        people: holding(actor, []),
        overrides: {
          categories: choiceMenu(HARNESS_MENU, {
            held: [],
            waiting: null,
            check: refusing(...menuRoleIds(HARNESS_MENU)),
            officer: false,
          }),
        },
      });
    /** The empty state's paragraphs. */
    const empty = (document: Document) =>
      [...document.querySelectorAll(".empty-state p")].map((line) => visibleText(line));
    const roles = await nothing(member);
    expect(roles.offers).toBe(true);
    const { document } = await myRolesPage(roles);
    expect(document.querySelectorAll("main .my-category, main form")).toHaveLength(0);
    expect(empty(document)).toEqual(["There are no roles to pick here right now."]);
    expect(document.body.textContent).not.toContain("haven't set up");
    // An officer is pointed at Role menu, which names each role's problem.
    const { document: theirs } = await myRolesPage(await nothing(officer), { viewer: officer });
    expect(empty(theirs)).toEqual([
      "There are no roles to pick here right now.",
      "Role menu shows which roles have a problem.",
    ]);
    // A menu that offers nothing yet: members are told officers haven't set it up; officers,
    // who would see drafts here, that nothing is published.
    const none: HarnessMenus = new Map([
      [GUILD, { menu: { v: 1, categories: [] }, revision: MENU_REVISION }],
    ]);
    const bare = await viewOf(member, { menus: none });
    expect(bare.offers).toBe(false);
    expect(empty((await myRolesPage(bare)).document)).toEqual([
      "Your officers haven't set up any roles to pick yet.",
      "Roles they offer, such as pronouns or games, will show up here.",
    ]);
    const { document: officers } = await myRolesPage(await viewOf(officer, { menus: none }), {
      viewer: officer,
    });
    expect(empty(officers)).toEqual([
      "Nothing is published yet.",
      "Add a category with roles on Role menu, then publish it.",
    ]);
  });

  test("without TaruBot's view of the roles only the reason shows: no card, and no role as a bare ID", async () => {
    const held = HELD[GUILD]?.[member.userId] ?? [];
    const { document, markup } = await myRolesPage(
      await viewOf(member, {
        overrides: {
          available: false,
          canSave: false,
          roleNames: new Map(),
          // What view() makes without TaruBot's view of the roles: nothing is changeable.
          categories: choiceMenu(HARNESS_MENU, {
            held,
            waiting: null,
            check: null,
            officer: false,
          }),
        },
      }),
    );
    expect(document.querySelectorAll("main .my-category, main form, main fieldset")).toHaveLength(
      0,
    );
    for (const roleId of held)
      expect({ roleId, shown: markup.includes(roleId) }).toEqual({ roleId, shown: false });
    expect(callouts(document)).toEqual([
      "TaruBot can't read this server's roles right now, so they can't be changed here. Try again in a minute.",
    ]);
    expect(document.querySelector(".empty-state")).toBeNull();
  });

  test("drafts show to officers only, disabled, with their roles ticked, and are never sent", async () => {
    const { document } = await myRolesPage(await viewOf(officer), { viewer: officer });
    const content = group(document, MENU_CATEGORY.content);
    expect(visibleText(content?.querySelector("legend") ?? null)).toBe(
      "Content Pick up to 2 Draft",
    );
    expect(document.getElementById(`category-${MENU_CATEGORY.content}-hint`)?.textContent).toBe(
      "Pick up to 2. What you'd like to be pinged for. Draft: only officers can see this. Publish it on Role menu.",
    );
    expect(
      inputs(document, MENU_CATEGORY.content).map(({ value, checked, disabled }) => ({
        value,
        checked,
        disabled,
      })),
    ).toEqual([
      { value: MENU_ROLE.savage, checked: true, disabled: true },
      { value: MENU_ROLE.maps, checked: false, disabled: true },
      { value: MENU_ROLE.mahjong, checked: false, disabled: true },
    ]);
    expect(hiddenValues(document, "shown")).not.toContain(MENU_CATEGORY.content);
    expect(hiddenValues(document, `seen:${MENU_CATEGORY.content}`)).toEqual([]);
    // The officer's published categories still save.
    expect(hiddenValues(document, "shown")).toEqual([MENU_CATEGORY.pronouns, MENU_CATEGORY.games]);
    // Members never see a draft.
    const { document: theirs } = await myRolesPage(await viewOf(member));
    expect(group(theirs, MENU_CATEGORY.content)).toBeNull();
    expect(theirs.querySelector(".my-category--draft")).toBeNull();
  });

  test("officers' notes link to Role menu, where they act on them; members never get the link", async () => {
    const roleMenu = `/g/${GUILD}/role-menu`;
    /** The text around each link to Role menu in the page's content (the nav isn't in main). */
    const linked = (document: Document) =>
      [...document.querySelectorAll(`main a[href="${roleMenu}"]`)].map((link) => [
        link.textContent,
        link.parentElement?.textContent,
      ]);
    // A draft's note, in its card.
    const { document: drafts } = await myRolesPage(await viewOf(officer), { viewer: officer });
    expect(linked(drafts)).toEqual([
      ["Role menu", "Draft: only officers can see this. Publish it on Role menu."],
    ]);
    // An unreadable menu's callout.
    const { document: broken } = await myRolesPage(
      await viewOf(officer, { states: { menuUnreadable: true } }),
      { viewer: officer },
    );
    expect(linked(broken)).toEqual([
      [
        "Role menu",
        "The saved role menu can't be read by this TaruBot version, so members and guests have nothing to pick. Reset it on Role menu.",
      ],
    ]);
    // Every role failing a rule now, and a menu with nothing published.
    const failing = (actor: Actor) =>
      viewOf(actor, {
        people: holding(actor, []),
        overrides: {
          categories: choiceMenu(HARNESS_MENU, {
            held: [],
            waiting: null,
            check: refusing(...menuRoleIds(HARNESS_MENU)),
            officer: false,
          }),
        },
      });
    const { document: problems } = await myRolesPage(await failing(officer), { viewer: officer });
    expect(linked(problems)).toEqual([
      ["Role menu", "Role menu shows which roles have a problem."],
    ]);
    const none: HarnessMenus = new Map([
      [GUILD, { menu: { v: 1, categories: [] }, revision: MENU_REVISION }],
    ]);
    const { document: empty } = await myRolesPage(await viewOf(officer, { menus: none }), {
      viewer: officer,
    });
    expect(linked(empty)).toEqual([
      ["Role menu", "Add a category with roles on Role menu, then publish it."],
    ]);
    // Members and guests, in the same states, see no officer note and so no link.
    for (const document of [
      (await myRolesPage(await viewOf(member))).document,
      (await myRolesPage(await viewOf(member, { states: { menuUnreadable: true } }))).document,
      (await myRolesPage(await failing(member))).document,
      (await myRolesPage(await viewOf(guest, { menus: none }), { viewer: guest })).document,
    ])
      expect(document.querySelectorAll('a[href$="/role-menu"]')).toHaveLength(0);
  });

  test("the status banner says what became of the person's newest change, by state", async () => {
    // `changed`: an applied change added or removed a role, unless a case says it changed nothing.
    const at = (
      state: RoleChoiceStatus["state"],
      skipped = 0,
      recent = true,
      completedAt: Date | null = null,
      changed = state === "applied",
    ): RoleChoiceStatus => ({ state, skipped, changed, recent, completedAt });
    // When a change ended, as the database stored it; banners show it in UTC to the minute.
    const ended = new Date("2026-10-03T14:05:30.000Z");
    const cases: [RoleChoiceStatus | null, string | null][] = [
      [null, null],
      [
        at("waiting", 0, false),
        "Saved. TaruBot is updating your roles in Discord. This usually takes under a minute; reload to check.",
      ],
      // The form is locked while paused, so the banner never asks for a save.
      [
        at("paused", 0, false),
        "Saved. Role changes are paused in this server, so yours will be applied when they resume. If that takes more than 7 days, your change is dropped and you can pick again.",
      ],
      // A save that changes nothing retries nothing, so the banner promises only the retries
      // TaruBot makes by itself.
      [
        at("blocked", 0, false),
        "Saved, but TaruBot can't change roles in this server right now. Officers can see why. TaruBot keeps trying for up to 7 days after your last saved change.",
      ],
      // A change that ended unapplied no longer shows ticked, so each says to pick again.
      [
        at("failed"),
        "TaruBot couldn't apply your last change. Check your roles below and pick again, then save. If it keeps happening, ask an officer.",
      ],
      [at("applied"), "Your roles were updated in Discord."],
      // An old success is no news: nothing is said.
      [at("applied", 0, false), null],
      // A change that dropped choices says so for as long as it is the newest. Nothing records
      // which (owner decision Q4 A), so it never says anyone can tell, or that it's "right now".
      [
        at("applied", 1, false),
        "Your roles were updated, but 1 of your choices couldn't be applied. Check your roles below, or ask an officer.",
      ],
      [
        at("applied", 3),
        "Your roles were updated, but 3 of your choices couldn't be applied. Check your roles below, or ask an officer.",
      ],
      // Applied, but every choice was skipped: nothing was updated, so it never says so.
      [
        at("applied", 2, true, null, false),
        "TaruBot couldn't apply your last change. Check your roles below and pick again, then save.",
      ],
      [
        at("expired", 0, false),
        "TaruBot couldn't apply your last change within 7 days, so it was dropped. Pick your roles again, then save.",
      ],
      // Any other skip: a restore, an older TaruBot after a rollback, nothing left to apply.
      [
        at("dropped", 0, false),
        "TaruBot couldn't apply your last change. Check your roles below and pick again, then save.",
      ],
      // Each warning that lasts as long as its row (30 days) says when the change ended, so one
      // that outlives the problem reads as history; without a stored time it says only what.
      [
        at("failed", 0, false, ended),
        "TaruBot couldn't apply your last change, and stopped trying on 2026-10-03 14:05 UTC. Check your roles below and pick again, then save. If it keeps happening, ask an officer.",
      ],
      [
        at("applied", 2, false, ended),
        "Your roles were updated on 2026-10-03 14:05 UTC, but 2 of your choices couldn't be applied. Check your roles below, or ask an officer.",
      ],
      [
        at("applied", 1, false, ended, false),
        "TaruBot couldn't apply your last change on 2026-10-03 14:05 UTC. Check your roles below and pick again, then save.",
      ],
      [
        at("expired", 0, false, ended),
        "TaruBot couldn't apply your last change within 7 days, so it was dropped on 2026-10-03 14:05 UTC. Pick your roles again, then save.",
      ],
      [
        at("dropped", 0, false, ended),
        "TaruBot couldn't apply your last change, and dropped it on 2026-10-03 14:05 UTC. Check your roles below and pick again, then save.",
      ],
      // News needs no date: it shows only within 10 minutes.
      [at("applied", 0, true, ended), "Your roles were updated in Discord."],
    ];
    for (const [status, text] of cases) {
      const { document } = await myRolesPage(await viewOf(member, { overrides: { status } }));
      expect({ status, banners: statusText(document) }).toEqual({
        status,
        banners: text === null ? [] : [text],
      });
      if (text !== null) {
        // The fragment a save's redirect names, polite, and able to take that focus.
        const region = document.getElementById("status");
        expect(region?.getAttribute("role")).toBe("status");
        expect(region?.getAttribute("tabindex")).toBe("-1");
      }
      // A date is a <time> element with the exact instant.
      const dated = [...document.querySelectorAll("#status time")].map((element) =>
        element.getAttribute("datetime"),
      );
      expect({ status, dated }).toEqual({
        status,
        dated: text?.includes(" UTC") ? [ended.toISOString()] : [],
      });
    }
    expect(String(skippedText(2))).toContain("2 of your choices couldn't be applied");
    for (const count of [1, 2, 30])
      expect(String(skippedText(count, ended))).not.toMatch(/Officers can see|right now/u);
  });

  test("the 'unchanged' notice shows from its fixed table only, never the token", async () => {
    const page = async (query: string) =>
      (await myRolesPage(await viewOf(member), { url: `/g/${GUILD}/my-roles${query}` })).document;
    expect(statusText(await page("?notice=unchanged"))).toEqual([MY_ROLES_NOTICES.unchanged]);
    expect(MY_ROLES_NOTICES.unchanged).toBe("Nothing to save. Those are already your roles.");
    for (const query of ["?notice=saved", "?notice=%3Cb%3Ex", "?notice=toString", "?other=1"]) {
      const document = await page(query);
      expect({ query, banners: statusText(document) }).toEqual({ query, banners: [] });
      expect(document.getElementById("status")).toBeNull();
    }
    // While a change waits, the form shows it ticked, so sending it back changes nothing; but
    // those roles aren't the person's yet, so it never says "Those are already your roles".
    for (const state of ["waiting", "paused", "blocked"] as const) {
      const { document } = await myRolesPage(
        await viewOf(member, {
          overrides: {
            status: { state, skipped: 0, changed: false, recent: false, completedAt: null },
          },
        }),
        { url: `/g/${GUILD}/my-roles?notice=unchanged` },
      );
      const banners = statusText(document);
      expect({ state, first: banners[0], count: banners.length }).toEqual({
        state,
        first: UNCHANGED_WHILE_WAITING,
        count: 2,
      });
      expect(banners.join(" ")).not.toContain("Those are already your roles");
    }
    expect(UNCHANGED_WHILE_WAITING).toBe("Nothing new to save.");
    // Once the change has ended, the form shows the roles held again, and the sentence is true.
    const { document: ended } = await myRolesPage(
      await viewOf(member, {
        overrides: {
          status: { state: "failed", skipped: 0, changed: false, recent: true, completedAt: null },
        },
      }),
      { url: `/g/${GUILD}/my-roles?notice=unchanged` },
    );
    expect(statusText(ended)[0]).toBe(MY_ROLES_NOTICES.unchanged);
  });

  test("a time-out, paused changes or no setup lock the page with a reason; the privacy note stays", async () => {
    const locked = async (actor: Actor, overrides: Partial<MyRoles>, viewer = actor) => {
      const { document } = await myRolesPage(await viewOf(actor, { overrides }), { viewer });
      // Inputs show, disabled; there is no form and no Save button to send.
      expect(document.querySelectorAll("main form, main button")).toHaveLength(0);
      for (const input of document.querySelectorAll("main fieldset input"))
        expect(input.hasAttribute("disabled")).toBe(true);
      expect(document.querySelector(".my-roles-intro__privacy")?.textContent).toBe(PRIVACY);
      return callouts(document);
    };
    const timedOut = person(HARNESS_ACCOUNTS.timedOut.id, { timedOut: true });
    expect(await locked(timedOut, {})).toEqual([CHOICE_MESSAGES.timedOut]);
    // A locked form is still the person's view of their own roles: its cards carry the modifier
    // that keeps the rows readable (styles/my-roles.ts), which a form that can save never has.
    const { document: theirs } = await myRolesPage(await viewOf(timedOut), { viewer: timedOut });
    expect(
      theirs.querySelector(".my-categories")?.classList.contains("my-categories--locked"),
    ).toBe(true);
    const { document: open } = await myRolesPage(await viewOf(member));
    expect(open.querySelector(".my-categories--locked")).toBeNull();
    const paused =
      "Role changes are paused in this server right now. You can see your roles here, but changes can't be saved until they resume.";
    for (const effectsMode of ["awaiting_activation", "deployment_disabled"] as const)
      expect(await locked(member, { effectsMode, canSave: false })).toEqual([paused]);
    // A change parked by the pause already says so in its banner, so the callout isn't repeated;
    // a short line still says why there is no Save button.
    expect(
      await locked(member, {
        effectsMode: "awaiting_activation",
        canSave: false,
        status: { state: "paused", skipped: 0, changed: false, recent: false, completedAt: null },
      }),
    ).toEqual(["You can't change your roles here until role changes resume."]);
    // No setup: only officers get in, and there is nothing to pick.
    expect(
      await locked(
        officer,
        { configured: false, categories: [], canSave: false, administrator: null },
        officer,
      ),
    ).toEqual(["TaruBot isn't set up in this server yet, so there are no roles to pick here."]);
  });

  test("officers see the Administrator banner (A2) and an unreadable menu's note; members never do", async () => {
    const administrator =
      "Members and guests can't open this page while TaruBot has Administrator in this server. Use /setup overrides, then remove Administrator once /config validate says it's no longer needed.";
    const { document } = await myRolesPage(
      await viewOf(officer, { states: { menuProblems: true } }),
      { viewer: officer },
    );
    expect(callouts(document)).toEqual([administrator]);
    const unreadable = await viewOf(officer, { states: { menuUnreadable: true } });
    const { document: broken } = await myRolesPage(unreadable, { viewer: officer });
    expect(callouts(broken)).toEqual([
      "The saved role menu can't be read by this TaruBot version, so members and guests have nothing to pick. Reset it on Role menu.",
    ]);
    expect(broken.querySelector(".empty-state")?.textContent).toBe(
      "There are no roles to pick here right now.",
    );
    // A member with the same facts gets neither officer note.
    const { document: theirs } = await myRolesPage(
      await viewOf(member, {
        states: { menuUnreadable: true },
        overrides: { administrator: true },
      }),
    );
    expect(callouts(theirs)).toEqual([]);
    expect(theirs.querySelector(".empty-state")?.textContent).toBe(
      "There are no roles to pick here right now.",
    );
  });

  test("an empty menu says so; the privacy note is there on every page", async () => {
    const menus: HarnessMenus = new Map([
      [GUILD, { menu: { v: 1, categories: [] }, revision: MENU_REVISION }],
    ]);
    const { document } = await myRolesPage(await viewOf(member, { menus }));
    expect(
      [...document.querySelectorAll(".empty-state p")].map((line) => line.textContent),
    ).toEqual([
      "Your officers haven't set up any roles to pick yet.",
      "Roles they offer, such as pronouns or games, will show up here.",
    ]);
    expect(document.querySelectorAll("main form, main fieldset")).toHaveLength(0);
    expect(document.querySelector(".my-roles-intro__privacy")?.textContent).toBe(PRIVACY);
    expect(document.querySelector(".my-roles-intro .lead")?.textContent).toBe(
      "Pick the roles you'd like here, and TaruBot adds or removes them in Discord.",
    );
  });

  test("a refused save comes back: 422 with what was picked and each category marked, 409 as it is now", async () => {
    const pronouns = MENU_CATEGORY.pronouns;
    const refused: RefusedChoice = {
      kind: "invalid",
      errors: [
        { categoryId: pronouns, max: 2, message: CHOICE_MESSAGES.max(2) },
        {
          categoryId: pronouns,
          roleId: MENU_ROLE.theyThem,
          message: CHOICE_MESSAGES.unavailableRole(MENU_ROLE.theyThem),
        },
        // A category this person can't see any more: said at the top of the form instead.
        { categoryId: MENU_CATEGORY.content, max: 1, message: CHOICE_MESSAGES.max(1) },
      ],
      submitted: [
        {
          categoryId: pronouns,
          seen: [MENU_ROLE.sheHer, MENU_ROLE.askMe],
          picked: [MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem],
        },
      ],
    };
    const { document } = await myRolesPage(await viewOf(member), { refused });
    expect(document.title).toBe("Error: My roles · TaruBot");
    const links = [...document.querySelectorAll(".error-summary a")];
    // Away from its card a limit names its category (WCAG 2.4.4, 3.3.1); a role's own refusal
    // names its role; a category this person can't see has no name to give.
    expect(links.map((link) => link.textContent)).toEqual([
      "Pronouns: pick at most 2 roles.",
      "@They/Them can't be picked right now. Choose something else, then save again.",
      "Pick only one role here.",
    ]);
    // Every link lands on something on the page that can take focus.
    for (const link of links) {
      const target = document.getElementById((link.getAttribute("href") ?? "").slice(1));
      expect(target).not.toBeNull();
      expect(target?.getAttribute("tabindex")).toBe("-1");
    }
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `#category-${pronouns}`,
      `#category-${pronouns}`,
      "#my-roles-error",
    ]);
    const fieldset = group(document, pronouns);
    expect(fieldset?.getAttribute("aria-describedby")).toBe(
      `category-${pronouns}-hint category-${pronouns}-error`,
    );
    expect(document.getElementById(`category-${pronouns}-error`)?.textContent).toBe(
      "Error: Pick at most 2 roles here. @They/Them can't be picked right now. Choose something else, then save again.",
    );
    expect(document.getElementById("my-roles-error")?.textContent).toBe(
      "Error: Pick only one role here.",
    );
    // What was picked comes back ticked; `seen` is still what the first render showed.
    expect(
      inputs(document, pronouns)
        .filter((row) => row.checked)
        .map((row) => row.value),
    ).toEqual([MENU_ROLE.heHim, MENU_ROLE.sheHer, MENU_ROLE.theyThem]);
    expect(hiddenValues(document, `seen:${pronouns}`)).toEqual([MENU_ROLE.sheHer, MENU_ROLE.askMe]);
    // The other categories are as they are now.
    expect(hiddenValues(document, `seen:${MENU_CATEGORY.games}`)).toEqual([MENU_ROLE.valheim]);

    const { document: conflict } = await myRolesPage(await viewOf(member), {
      refused: { kind: "conflict" },
    });
    expect([...conflict.querySelectorAll(".error-summary a")].map((a) => a.textContent)).toEqual([
      CHOICE_MESSAGES.conflict,
    ]);
    expect(conflict.querySelector(".error-summary a")?.getAttribute("href")).toBe(
      "#my-roles-error",
    );
    expect(conflict.getElementById("my-roles-error")?.textContent).toBe(
      `Error: ${CHOICE_MESSAGES.conflict}`,
    );
    expect(
      inputs(conflict, pronouns)
        .filter((row) => row.checked)
        .map((row) => row.value),
    ).toEqual([MENU_ROLE.sheHer, MENU_ROLE.askMe]);

    // A limit reached with a role the person keeps: the card says which role; the summary also
    // names the category.
    const { document: fixed } = await myRolesPage(await viewOf(member), {
      refused: {
        kind: "invalid",
        errors: [
          {
            categoryId: MENU_CATEGORY.games,
            message: CHOICE_MESSAGES.fixedMax([MENU_ROLE.valheim], 1),
          },
        ],
        submitted: [
          {
            categoryId: MENU_CATEGORY.games,
            seen: [MENU_ROLE.valheim],
            picked: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
          },
        ],
      },
    });
    const fixedLimit =
      "@Valheim can't be changed here right now and counts toward this category's limit of one role, so you can't pick another role here.";
    expect([...fixed.querySelectorAll(".error-summary a")].map((a) => a.textContent)).toEqual([
      `Games: ${fixedLimit}`,
    ]);
    expect(fixed.getElementById(`category-${MENU_CATEGORY.games}-error`)?.textContent).toBe(
      `Error: ${fixedLimit}`,
    );
  });

  test("every control's accessible name is unique, and every button has visible text", async () => {
    for (const [roles, viewer] of [
      [await viewOf(member), member],
      [await viewOf(officer), officer],
      [await viewOf(person(HARNESS_ACCOUNTS.member.id, {}, SECOND)), member],
    ] as const) {
      const { document } = await myRolesPage(roles, { viewer });
      const names = [
        ...document.querySelectorAll('main input:not([type="hidden"]), main button'),
      ].map((control) => accessibleName(document, control));
      expect(new Set(names).size).toBe(names.length);
      for (const button of document.querySelectorAll("main button"))
        expect(visibleText(button)).not.toBe("");
    }
    // Two pick-one categories each have their own None, told apart by the category's name.
    const { document } = await myRolesPage(
      await viewOf(person(HARNESS_ACCOUNTS.member.id, {}, SECOND)),
    );
    const none = document.querySelector(`input[value=""]`);
    expect(accessibleName(document, none as Element)).toBe("No role from this category: Main role");
  });

  test("nothing about anyone else: no other person's ID, and role names of the menu only", async () => {
    const roles = await viewOf(member);
    expect([...roles.roleNames.keys()].sort()).toEqual([...menuRoleIds(HARNESS_MENU)].sort());
    const { document, markup } = await myRolesPage(roles);
    const main = document.querySelector("main")?.innerHTML ?? "";
    for (const account of Object.values(HARNESS_ACCOUNTS))
      expect({ account: account.id, shown: markup.includes(account.id) }).toEqual({
        account: account.id,
        shown: false,
      });
    // Not even the server's access roles or its staff: only the menu's own roles.
    for (const name of ["Officer", "FC Leader", "Moderator", "Dyno", "Announcer", "Council"])
      expect({ name, shown: main.includes(name) }).toEqual({ name, shown: false });
  });

  test("the Role menu's lead links to My roles, with its address to share", async () => {
    const editor = await harnessSelfRoles().editor({
      guildId: GUILD,
      userId: USER,
      officer: true,
      manageRoles: false,
    });
    const markup = await render(
      renderRoleMenu({
        editor,
        names: guildNames(harnessGateway(), GUILD),
        action: `/g/${GUILD}/role-menu`,
        token: TOKEN,
        url: new URL(`/g/${GUILD}/role-menu`, "https://example.org"),
        newCategoryId: "00000000-0000-4000-8000-000000000301",
      }),
    );
    const lead = parseHTML(`<main>${markup}</main>`).document.getElementById("role-menu-intro");
    expect(lead?.querySelector("a")?.getAttribute("href")).toBe(`/g/${GUILD}/my-roles`);
    expect(lead?.querySelector("a")?.textContent).toBe("My roles");
    expect(lead?.querySelector("code")?.textContent).toBe(
      `https://example.org/g/${GUILD}/my-roles`,
    );
    // Owner decision Q3 B is the one change TaruBot makes to listed roles unasked, also to people
    // who never had Member or Guest, so the lead says so where officers read what the menu does.
    expect(lead?.textContent).toContain(
      "TaruBot adds or removes a listed role only when that person asks, apart from roles that open channels, which it takes from anyone with none of the Member, Guest, Officer and FC Leader roles.",
    );
  });

  test("every class the view renders has a rule in the stylesheet", async () => {
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    const second = person(HARNESS_ACCOUNTS.member.id, {}, SECOND);
    const held = HELD[GUILD]?.[member.userId] ?? [];
    const documents = [
      (await myRolesPage(await viewOf(member, { states: { roles: "queued" } }))).document,
      (await myRolesPage(await viewOf(officer), { viewer: officer, url: "/x?notice=unchanged" }))
        .document,
      (await myRolesPage(await viewOf(second))).document,
      (
        await myRolesPage(
          await viewOf(member, {
            overrides: {
              categories: choiceMenu(HARNESS_MENU, {
                held,
                waiting: null,
                check: refusing(MENU_ROLE.sheHer),
                officer: false,
              }),
              status: {
                state: "applied",
                skipped: 0,
                changed: true,
                recent: true,
                completedAt: null,
              },
            },
          }),
        )
      ).document,
      (await myRolesPage(await viewOf(person(HARNESS_ACCOUNTS.timedOut.id, { timedOut: true }))))
        .document,
      (await myRolesPage(await viewOf(member), { refused: { kind: "conflict" } })).document,
      (
        await myRolesPage(
          await viewOf(member, {
            menus: new Map([[GUILD, { menu: { v: 1, categories: [] }, revision: MENU_REVISION }]]),
          }),
        )
      ).document,
    ];
    const classes = new Set<string>();
    for (const document of documents)
      for (const element of document.querySelectorAll("main [class]"))
        for (const name of element.classList) classes.add(name);
    for (const name of [
      "my-category",
      "my-category--draft",
      "my-categories--locked",
      "my-category__fixed",
      "my-category__note",
      "my-category__draft",
      "my-roles-status",
      "notice--success",
      "form-error",
      "empty-state",
    ])
      expect({ name, rendered: classes.has(name) }).toEqual({ name, rendered: true });
    for (const name of classes)
      expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
        name,
        styled: true,
      });
  });
});
