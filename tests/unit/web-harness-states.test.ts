/**
 * The development harness's opt-in review states: harnessOptions maps each --state-* flag, and
 * the harness, started on loopback with a state and signed in as the invented officer, shows that
 * state on the rendered pages. The default data stays web-server.test.ts's and
 * web-mentions.test.ts's. Assertions use the pinned semantic hooks (bracketed .check tokens,
 * .marker-* classes, .featured, dt/dd facts, the work-sample table) and approved copy, not layout
 * markup. Credential-free: invented IDs, no network beyond loopback.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { configurationChecks } from "../../src/discord/presenters/configuration.js";
import {
  HARNESS_GUILDS,
  HARNESS_MENU,
  type HarnessStates,
  HOSTILE_NAMES,
  harnessOptions,
  harnessReport,
  MENU_REVISION,
  startHarness,
} from "../fixtures/web-dev.js";

type Page = ReturnType<typeof parseHTML>["document"];

/** Whether this host can bind the IPv6 loopback, the harness's default interface. */
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

/** Every flag at once, as the command line spells them. */
const EVERY_FLAG = [
  "--state-checks=fail",
  "--state-activation",
  "--state-deploy-disabled",
  "--state-empty",
  "--state-cooling",
  "--state-hostile-names",
];

describe("harnessOptions", () => {
  test("turns on no review state unless asked", () => {
    expect(harnessOptions([])).toEqual({ hostname: "::1", states: {} });
  });

  test("maps each --state flag to its startHarness state", () => {
    expect(harnessOptions(EVERY_FLAG).states).toEqual({
      checks: "fail",
      activation: true,
      deploymentDisabled: true,
      empty: true,
      cooling: true,
      hostileNames: true,
    });
    expect(harnessOptions(["--state-checks", "warn"]).states).toEqual({ checks: "warn" });
  });

  test("refuses an unknown check level, a misspelt flag and a lone --cert", () => {
    expect(() => harnessOptions(["--state-checks=maybe"])).toThrow(
      "Pass --state-checks=warn or --state-checks=fail.",
    );
    expect(() => harnessOptions(["--state-cooldown"])).toThrow();
    expect(() => harnessOptions(["--cert", "cert.pem"])).toThrow("Pass --cert and --key together.");
  });
});

describe("the harness's Role menu health check (UX-12)", () => {
  const rows = (menu: typeof HARNESS_MENU | null, states: HarnessStates = {}) =>
    configurationChecks(
      harnessReport(
        HARNESS_GUILDS.example.id,
        states,
        new Map([[HARNESS_GUILDS.example.id, { menu, revision: MENU_REVISION }]]),
      ),
    )
      .filter((row) => row.section === "Role menu")
      .map((row) => `${row.check} ${row.text}`);

  test("OFF while every category is a draft, OK when all pass, WARN for drift or an unreadable menu", () => {
    const drafts = {
      ...HARNESS_MENU,
      categories: HARNESS_MENU.categories.map((category) => ({
        ...category,
        state: "draft" as const,
      })),
    };
    expect(rows(drafts)).toEqual(["off No roles outside drafts"]);
    expect(rows(HARNESS_MENU)).toEqual(["ok 7 roles outside drafts; all pass"]);
    expect(rows(HARNESS_MENU, { menuProblems: true })).toEqual([
      "warn 4 roles outside drafts have a problem; open Role menu to see which",
      "warn TaruBot can't read 2 channels, so it can't check menu roles there",
    ]);
    expect(rows(null)).toEqual([
      "warn The saved role menu can't be read by this TaruBot version; open Role menu to reset it",
    ]);
  });
});

describe.skipIf(!ipv6Loopback)("each review state, end to end over loopback", () => {
  const configuration = `/g/${HARNESS_GUILDS.example.id}/configuration`;
  const status = `/g/${HARNESS_GUILDS.example.id}/status`;

  /** The text of every isolated (dir=auto) span: where untrusted names render. */
  const isolated = (document: Page) =>
    [...document.querySelectorAll('[dir="auto"]')].map((node) => node.textContent);

  /** The dd that follows the dt whose text is exactly `label`. */
  const fact = (document: Page, label: string) =>
    [...document.querySelectorAll("dt")].find((dt) => dt.textContent?.trim() === label)
      ?.nextElementSibling;

  /** Server configuration's health checklist, and Background work's process health. */
  const checklist = (document: Page) =>
    document.querySelector('section[aria-labelledby="configuration-checklist"]');
  const health = (document: Page) => document.querySelector(".featured");

  /**
   * Start the harness in `states`, sign in as the officer through the fake authorize page (as
   * web-server.test.ts does), and read `/` plus each path as the signed-in officer.
   */
  async function officerPages(states: HarnessStates, paths: readonly string[]) {
    const harness = await startHarness({ states });
    try {
      const jar = new Map<string, string>();
      const browse = async (url: string | URL) => {
        const response = await fetch(url, {
          headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
          redirect: "manual",
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [pair = ""] = cookie.split(";");
          const [name = "", value = ""] = pair.split("=");
          jar.set(name, value);
        }
        return response;
      };
      const login = await browse(new URL("/login", harness.url));
      expect(login.status).toBe(302);
      const authorize = login.headers.get("location") ?? "";
      const choice = await (await browse(authorize)).text();
      const approve = /href="(\/oauth2\/approve\/[0-9a-f-]+\/officer)"/u.exec(choice)?.[1];
      expect(approve).toBeDefined();
      const approved = await browse(new URL(approve ?? "", authorize));
      const callback = await browse(approved.headers.get("location") ?? "");
      expect(callback.status).toBe(303);
      const pages = new Map<string, Page>();
      for (const path of ["/", ...paths]) {
        const response = await browse(new URL(path, harness.url));
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        pages.set(path, parseHTML(await response.text()).document);
      }
      const page = (path: string): Page => {
        const document = pages.get(path);
        if (!document) throw new Error(`Not read: ${path}`);
        return document;
      };
      return page;
    } finally {
      await harness.stop();
    }
  }

  /** The rows of the checklist's "Role menu" section (2.39.0), as text. */
  const menuRows = (document: Page) =>
    [
      ...([...(checklist(document)?.querySelectorAll(".check-group") ?? [])]
        .find((group) => group.querySelector("h3")?.textContent === "Role menu")
        ?.querySelectorAll(".check-row") ?? []),
    ].map((row) => row.textContent);

  test("without a state, the pages keep the healthy, live defaults", async () => {
    const page = await officerPages({}, [configuration, status]);
    expect(
      checklist(page(configuration))?.querySelectorAll(".check-fail, .check-warn"),
    ).toHaveLength(0);
    // The Role menu's health check, over the same saved menu the Role menu page shows (UX-12).
    expect(menuRows(page(configuration))).toEqual(["[OK]7 roles outside drafts; all pass"]);
    expect(fact(page(configuration), "Discord changes")?.querySelector("code")?.textContent).toBe(
      "live",
    );
    expect(health(page(status))?.querySelectorAll(".check-ok")).toHaveLength(5);
    const work = page(status).querySelector('table[aria-describedby="work-sample"]');
    for (const marker of ["queued", "running", "failed", "blocked"])
      expect(work?.querySelectorAll(`.marker-${marker}`)).toHaveLength(1);
    expect(work?.querySelectorAll(".marker-waiting, .marker-paused")).toHaveLength(0);
    expect(isolated(page("/"))).toEqual([HARNESS_GUILDS.example.name]);
  });

  test("--state-menu-problems: Server configuration warns about the Role menu and Administrator too", async () => {
    const page = await officerPages({ menuProblems: true }, [configuration]);
    expect(menuRows(page(configuration))).toEqual([
      "[WARN]4 roles outside drafts have a problem; open Role menu to see which",
      "[WARN]TaruBot can't read 2 channels, so it can't check menu roles there",
    ]);
    // TaruBot holds Administrator there, as the Role menu page's banner says.
    expect(checklist(page(configuration))?.textContent).toContain("Administrator");
    expect(health(page(configuration))?.textContent).not.toContain("All checks passed");
  });

  test("--state-checks=warn: configuration warnings without failures, a waiting Lodestone", async () => {
    const page = await officerPages({ checks: "warn" }, [configuration, status]);
    const checks = checklist(page(configuration));
    const warnings = checks?.querySelectorAll(".check-warn") ?? [];
    expect(warnings.length).toBeGreaterThan(1);
    for (const warning of warnings) expect(warning.textContent).toBe("[WARN]");
    expect(checks?.querySelectorAll(".check-fail")).toHaveLength(0);
    // The health snapshot counts what needs attention: here, the warnings.
    expect(health(page(configuration))?.querySelector("h2")?.textContent).toContain(
      String(warnings.length),
    );
    expect(fact(page(configuration), "Roster read")?.querySelector(".check")?.textContent).toBe(
      "[WARN]",
    );
    const process = health(page(status));
    expect(process?.querySelectorAll(".check-fail")).toHaveLength(0);
    expect(process?.querySelectorAll(".check-wait")).toHaveLength(1);
    expect(process?.textContent).toContain("Lodestone cooling down");
  });

  test("--state-checks=fail: failures, a hidden channel, a disconnected gateway, a retry", async () => {
    const page = await officerPages({ checks: "fail" }, [configuration, status]);
    const checks = checklist(page(configuration));
    const attention = checks?.querySelectorAll(".check-fail, .check-warn").length ?? 0;
    expect(checks?.querySelectorAll(".check-fail").length).toBeGreaterThan(1);
    expect(health(page(configuration))?.querySelector("h2")?.textContent).toContain(
      String(attention),
    );
    // Denied View Channel, the officer notifications channel shows without its name or a chip.
    const notices = fact(page(configuration), "Officer notifications");
    expect(notices?.textContent).toContain("can't see");
    expect(notices?.querySelectorAll(".mention")).toHaveLength(0);
    expect(page(configuration).body.textContent).not.toContain("officer-notices");
    const process = health(page(status));
    expect(process?.querySelectorAll(".check-fail")).toHaveLength(2);
    expect(process?.querySelectorAll(".check-ok")).toHaveLength(3);
    expect(process?.textContent).toContain("Not connected to Discord");
    const retry = page(status).querySelector(
      'table[aria-describedby="work-sample"] .marker-waiting',
    );
    expect(retry?.closest("tr")?.textContent).toContain("Retry");
  });

  test("--state-activation: paused until activation, grandfathering pending, work parked", async () => {
    const page = await officerPages({ activation: true }, [configuration, status]);
    const changes = fact(page(configuration), "Discord changes");
    expect(changes?.querySelector(".check")?.textContent).toBe("[WAIT]");
    expect(changes?.querySelector("code")?.textContent).toBe("awaiting_activation");
    expect(fact(page(configuration), "Guest grandfathering")?.textContent).toContain("Pending");
    expect(health(page(status))?.querySelectorAll(".check-wait")).toHaveLength(1);
    const rows = page(status).querySelectorAll('table[aria-describedby="work-sample"] tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.querySelectorAll(".marker-paused")).toHaveLength(1);
    expect(page(status).querySelector("main")?.textContent).toContain("Paused");
    expect(page(status).querySelector("main")?.textContent).toMatch(/\d+ held/u);
  });

  test("--state-deploy-disabled: off for the deployment, and it wins over activation", async () => {
    for (const states of [
      { deploymentDisabled: true },
      { deploymentDisabled: true, activation: true },
    ]) {
      const page = await officerPages(states, [configuration, status]);
      const changes = fact(page(configuration), "Discord changes");
      expect(changes?.querySelector(".check")?.textContent).toBe("[OFF]");
      expect(changes?.querySelector("code")?.textContent).toBe("deployment_disabled");
      const warnings = [...(checklist(page(configuration))?.querySelectorAll(".check-row") ?? [])];
      expect(
        warnings.some(
          (row) =>
            row.querySelector(".check-warn") &&
            row.textContent?.includes("Disabled for this deployment"),
        ),
      ).toBe(true);
      expect(health(page(status))?.querySelectorAll(".check-off")).toHaveLength(1);
      expect(
        page(status).querySelectorAll('table[aria-describedby="work-sample"] .marker-paused')
          .length,
      ).toBeGreaterThan(0);
      expect(page(status).querySelector("main")?.textContent).toMatch(/\d+ held/u);
    }
  });

  test("--state-empty: no outstanding work and no runs, even with other states on", async () => {
    for (const states of [{ empty: true }, { empty: true, cooling: true, activation: true }]) {
      const page = await officerPages(states, [status]);
      const main = page(status).querySelector("main");
      expect(main?.querySelectorAll("table")).toHaveLength(0);
      expect(main?.textContent).toContain("No outstanding work in this limited sample.");
      expect(main?.textContent).toContain("No recent refresh runs to display.");
      const counts = [...(main?.querySelectorAll(".metrics dd") ?? [])].map((dd) => dd.textContent);
      expect(counts).toEqual(["0", "0", "0", "0", "0", "0"]);
    }
  });

  test("--state-cooling: a waiting Lodestone, its waiting fetch, a fresh roster", async () => {
    const page = await officerPages({ cooling: true }, [configuration, status]);
    const process = health(page(status));
    expect(process?.querySelectorAll(".check-wait")).toHaveLength(1);
    expect(process?.textContent).toContain("Lodestone cooling down");
    const waiting = page(status).querySelector(
      'table[aria-describedby="work-sample"] .marker-waiting',
    );
    expect(waiting?.closest("tr")?.textContent).toContain("Next");
    expect(waiting?.closest("tr")?.textContent).toContain("rate_limited");
    expect(page(status).querySelector("main")?.textContent).toContain("In progress");
    expect(fact(page(configuration), "Roster read")?.querySelector(".check")?.textContent).toBe(
      "[OK]",
    );
    expect(fact(page(configuration), "Last roster error")?.textContent).toContain("rate_limited");
  });

  test("--state-hostile-names: every name stays isolated text on every server", async () => {
    const servers = HOSTILE_NAMES.guilds.map((guild) => `/g/${guild.id}/configuration`);
    const page = await officerPages({ hostileNames: true }, [...servers, status]);
    const home = page("/");
    expect(home.querySelectorAll('.servers a[href$="/status"]')).toHaveLength(
      HOSTILE_NAMES.guilds.length,
    );
    expect(isolated(home)).toEqual(HOSTILE_NAMES.guilds.map((guild) => guild.name));
    for (const [index, guild] of HOSTILE_NAMES.guilds.entries()) {
      const document = page(servers[index] ?? "");
      // Each server's name is isolated exactly once, in the shell.
      expect(isolated(document).filter((text) => text === guild.name)).toHaveLength(1);
    }
    const names = isolated(page(configuration));
    expect(names).toEqual(
      expect.arrayContaining([
        HOSTILE_NAMES.fc.name,
        HOSTILE_NAMES.rank,
        ...Object.values(HOSTILE_NAMES.roles).map((name) => `@${name}`),
        `#${HOSTILE_NAMES.channels.ledger}`,
        `#${HOSTILE_NAMES.channels.notices}`,
        `#${HOSTILE_NAMES.channels.reviews}`,
      ]),
    );
    expect(isolated(page(status))).toContain(HOSTILE_NAMES.members.member);
    for (const path of ["/", configuration, status]) {
      expect(page(path).querySelectorAll("script")).toHaveLength(0);
      expect(page(path).querySelectorAll("main img, main b, main i")).toHaveLength(0);
    }
  });
});
