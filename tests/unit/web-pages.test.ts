/**
 * Web pages (#43, D12, E2, E12): definePage's validation, discovery of *.page.ts modules, and the
 * rendered markup of the shell, the / page, the "no access" page, error pages and Status, with
 * invented data parsed by linkedom. The markup rules: lang="en", one <h1>, no style attribute or
 * script (the CSP allows neither), a text label on every control, hostile names escaped inside
 * dir="auto" elements, and no global process metrics or diagnostics on Status.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { applicationKey, gatewayKey, lifecycleKey } from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import type { JobView, SyncRunRow, SyncStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { ServiceKey, Services } from "../../src/bot/services.js";
import { project } from "../../src/config/project.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { PAGE_ACCESS } from "../../src/web/access.js";
import { FAVICON, STYLESHEET } from "../../src/web/assets.js";
import { html, type SafeHtml } from "../../src/web/html.js";
import { problemOf } from "../../src/web/http.js";
import { errorPage, layout, navLinks } from "../../src/web/layout.js";
import { definePage, PAGE_PATH, Page, type PageContext } from "../../src/web/page.js";
import { loadPages } from "../../src/web/pages.js";
import type { WebNames } from "../../src/web/mentions.js";
import type { Session } from "../../src/web/sessions.js";
import { renderHome, renderNoAccess } from "../../src/web/views/servers.js";
import { renderStatus } from "../../src/web/views/status.js";

const GUILD = "100000000000000001";
const USER = "200000000000000002";
const REF = "00000000-0000-4000-8000-000000000000";
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
  // Every control has a visible or programmatic label, and every link has text.
  for (const control of document.querySelectorAll("button, input, select, textarea"))
    expect(accessibleName(document, control)).not.toBe("");
  for (const link of document.querySelectorAll("a")) {
    expect((link.textContent ?? "").trim()).not.toBe("");
    expect(link.getAttribute("href")).not.toBe("#");
  }
  // Forms post here only (the CSP's form-action agrees).
  for (const form of document.querySelectorAll("form")) {
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toMatch(/^\/[^/\\]/u);
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
    const page = definePage({ ...base, nav: "Status", post: async () => ({ redirect: "/" }) });
    expect(page).toBeInstanceOf(Page);
    expect(page.href(GUILD)).toBe(`/g/${GUILD}/status`);
    expect(page.nav).toBe("Status");
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
      [{ nav: "" }, "A page's navigation label must be text."],
      [{ nav: " " }, "A page's navigation label must be text."],
      [{ nav: 1 }, "A page's navigation label must be text."],
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
  });

  test("a signed-in user gets both sign-out forms and their servers, names escaped and isolated", async () => {
    const servers = HOSTILE.map((name, index) => ({
      name,
      links: [{ href: `/g/10000000000000000${index}/status`, label: "Status", current: false }],
    }));
    const markup = await render(
      layout({ title: "Your servers", signedIn: true }, renderHome({ signedIn: true, servers })),
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
    // Hostile names are text inside dir="auto" elements, never markup.
    expect(document.querySelectorAll("main img")).toHaveLength(0);
    expect(isolated(document)).toEqual(HOSTILE);
    expect(document.querySelectorAll('.servers a[href$="/status"]')).toHaveLength(HOSTILE.length);
  });

  test("a signed-in user with no servers is told so, with who the pages are for", async () => {
    const document = inspect(
      await render(
        layout(
          { title: "Your servers", signedIn: true },
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
        layout({ title: "Status", signedIn: true, guild: { name, nav } }, html`<p>Body</p>`),
      ),
    );
    expect(isolated(document)).toEqual([name]);
    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute("href")).toBe(`/g/${GUILD}/status`);
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Server pages");
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
    const markup = await render(errorPage(details, true));
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
    const markup = await render(errorPage(problemOf(new Error(secret), REF), false));
    expect(markup).not.toContain("postgres://");
    expect(inspect(markup).querySelector("h1")?.textContent).toBe("Something went wrong");
    const wait = await render(
      errorPage(problemOf(new Failure("cooldown", "Slow down.", 30), REF), false),
    );
    expect(inspect(wait).querySelector("main")?.textContent).toContain(
      "Try again in about 30 seconds.",
    );
  });

  test("every status has a heading and a sentence", async () => {
    for (const status of [400, 403, 404, 405, 409, 413, 415, 429, 500, 503, 418, 502] as const) {
      const document = inspect(
        await render(
          errorPage(
            { status, code: "input", ref: REF, message: null, retryAfter: 0, level: "info" },
            false,
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
          guild: { name: "Example FC", nav: navLinks([page], actor, page.path) },
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
});
