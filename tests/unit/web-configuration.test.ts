/** Configuration memo boundaries and pure rendering with typed, adversarial server state. */
import { describe, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ConfigurationReport, EffectsMode } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { CHECK } from "../../src/discord/presenters/style.js";
import type { Actor } from "../../src/domain/policy.js";
import { EMPTY_NAMES, type WebNames } from "../../src/web/mentions.js";
import { STYLESHEET } from "../../src/web/assets.js";
import { validateConfiguration } from "../../src/web/pages/configuration.page.js";
import { renderConfiguration } from "../../src/web/views/configuration.js";
import {
  CHANNEL,
  CONFIG_FC,
  configGuild,
  configReport,
  fcRow,
  ROLE,
} from "../fixtures/replies/configuration.js";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const USER = "200000000000000001";
const CHECKED_AT = new Date("2026-10-07T12:30:42.000Z");
const ROSTER_AT = new Date("2026-10-07T12:10:32.000Z");
const OFFICER: Actor = { guildId: GUILD, userId: USER, officer: true, manageRoles: false };
const ignore = (_error: unknown): void => {};

/** Only the costly validation is controlled; the real page memo and authorization run unchanged. */
function service(validate: Service["validate"]): Service {
  const value: unknown = Object.create(Service.prototype);
  if (!(value instanceof Service)) throw new Error("Invalid application fixture");
  value.validate = validate;
  return value;
}

async function documentOf(report: ConfigurationReport, names: WebNames = EMPTY_NAMES) {
  const markup = String(await renderConfiguration({ report, names, checkedAt: CHECKED_AT }));
  const { document } = parseHTML(`<html><body><main>${markup}</main></body></html>`);
  return { markup, document };
}

function fact(document: Document, label: string): Element {
  const term = [...document.querySelectorAll("dt")].find((item) => item.textContent === label);
  const value = term?.nextElementSibling;
  if (value?.tagName !== "DD") throw new Error(`Missing configuration fact: ${label}`);
  return value;
}

describe("configuration validation memo", () => {
  test("joins concurrent officers in one server but isolates servers and Service instances", async () => {
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const validate: Service["validate"] = async (actor) => {
      calls.push(actor.guildId);
      await release.promise;
      return configReport({ guild: configGuild({ id: actor.guildId }) });
    };
    const first = service(validate);
    const second = service(validate);
    const pending = [
      validateConfiguration(first, OFFICER, ignore),
      validateConfiguration(first, { ...OFFICER, userId: "200000000000000002" }, ignore),
      validateConfiguration(first, { ...OFFICER, guildId: OTHER_GUILD }, ignore),
      validateConfiguration(second, OFFICER, ignore),
    ];
    await Promise.resolve();
    expect(calls).toEqual([GUILD, OTHER_GUILD, GUILD]);
    release.resolve();
    const [a, same, other, separate] = await Promise.all(pending);
    expect(a).toBe(same);
    expect(other?.report.configuration.id).toBe(OTHER_GUILD);
    expect(a).not.toBe(separate);
  });

  test("refuses non-officers before a miss, an in-flight join and a completed cache hit", async () => {
    const release = Promise.withResolvers<ConfigurationReport>();
    let calls = 0;
    const app = service(async () => {
      calls++;
      return release.promise;
    });
    const denied = { ...OFFICER, officer: false };
    const refusal = { code: "forbidden", detail: { kind: "scope", scope: "officer" } };
    await expect(validateConfiguration(app, denied, ignore)).rejects.toMatchObject(refusal);
    expect(calls).toBe(0);
    const allowed = validateConfiguration(app, OFFICER, ignore);
    await Promise.resolve();
    await expect(validateConfiguration(app, denied, ignore)).rejects.toMatchObject(refusal);
    expect(calls).toBe(1);
    release.resolve(configReport());
    await allowed;
    await expect(validateConfiguration(app, denied, ignore)).rejects.toMatchObject(refusal);
    expect(calls).toBe(1);
  });

  test("starts its TTL and checkedAt at completion, including a validation longer than 30 seconds", async () => {
    let now = CHECKED_AT.getTime();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const release = Promise.withResolvers<ConfigurationReport>();
    let calls = 0;
    const app = service(async () => {
      calls++;
      return calls === 1 ? release.promise : configReport();
    });
    try {
      const start = validateConfiguration(app, OFFICER, ignore);
      await Promise.resolve();
      now += 90_000;
      const join = validateConfiguration(app, OFFICER, ignore);
      expect(calls).toBe(1);
      release.resolve(configReport());
      const completed = await start;
      expect(await join).toBe(completed);
      expect(completed.checkedAt.getTime()).toBe(now);
      now += 29_999;
      expect(await validateConfiguration(app, OFFICER, ignore)).toBe(completed);
      expect(calls).toBe(1);
      now++;
      const renewed = await validateConfiguration(app, OFFICER, ignore);
      expect(calls).toBe(2);
      expect(renewed).not.toBe(completed);
      expect(renewed.checkedAt.getTime()).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });

  test("evicts a shared rejected validation so the next request can succeed", async () => {
    const release = Promise.withResolvers<ConfigurationReport>();
    const error = new TypeError("validation unavailable");
    let calls = 0;
    const app = service(async () => {
      calls++;
      return calls === 1 ? release.promise : configReport();
    });
    const first = validateConfiguration(app, OFFICER, ignore);
    const join = validateConfiguration(app, OFFICER, ignore);
    const failures = Promise.allSettled([first, join]);
    await Promise.resolve();
    expect(calls).toBe(1);
    release.reject(error);
    expect(await failures).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    const recovered = await validateConfiguration(app, OFFICER, ignore);
    expect(recovered.report.effectsMode).toBe("live");
    expect(calls).toBe(2);
  });

  test("does not retain synchronous validation errors either", async () => {
    let calls = 0;
    const error = new Error("synchronous validation failure");
    const app = service(() => {
      if (++calls === 1) throw error;
      return Promise.resolve(configReport());
    });
    await expect(validateConfiguration(app, OFFICER, ignore)).rejects.toBe(error);
    await validateConfiguration(app, OFFICER, ignore);
    expect(calls).toBe(2);
  });
});

describe("configuration rendering", () => {
  test("escapes and isolates FC identity, cached names and rank while resolving configured mentions", async () => {
    const hostile = '<img src=x onerror="alert(1)"> ‮txt.exe‬ & FC';
    const report = configReport({
      guild: configGuild({
        id: GUILD,
        officer_rank_name: hostile,
        changelog_channel_id: CHANNEL.changelog,
        changelog_version: "3.1.0",
      }),
      fc: fcRow({ name: hostile, tag: "«SKY»", world: hostile }),
      capabilities: {
        member_role_id: `Missing permissions for <@&${ROLE.member}> in <#${CHANNEL.ledger}> ${hostile}`,
      },
    });
    const names: WebNames = {
      roles: new Map([
        [ROLE.member, hostile],
        [ROLE.guest, "Guest"],
        [ROLE.officer, "Officer"],
        [ROLE.leader, "Leader"],
      ]),
      channels: new Map([
        [CHANNEL.ledger, hostile],
        [CHANNEL.notices, "officer-notices"],
        [CHANNEL.reviews, "guest-review"],
        [CHANNEL.lobby, "lobby"],
        [CHANNEL.officers, "officer-room"],
        [CHANNEL.changelog, "updates"],
      ]),
      users: new Map(),
    };
    const { markup, document } = await documentOf(report, names);
    expect(
      document.querySelectorAll("img, script, style, iframe, object, embed, [style]"),
    ).toHaveLength(0);
    for (const element of document.querySelectorAll("*"))
      expect(element.getAttributeNames().some((attribute) => /^on/iu.test(attribute))).toBe(false);
    expect(markup).not.toContain("<@&");
    expect(markup).not.toContain("<#");
    const isolated = [...document.querySelectorAll('[dir="auto"]')].map((item) => item.textContent);
    expect(isolated).toContain(hostile);
    expect(isolated).toContain(`@${hostile}`);
    expect(isolated).toContain(`#${hostile}`);
    expect(isolated).toContain("«SKY»");
    expect(isolated).not.toContain("««SKY»»");
    expect(fact(document, "Company").querySelector("a")?.getAttribute("href")).toBe(
      `https://na.finalfantasyxiv.com/lodestone/freecompany/${CONFIG_FC.id}/`,
    );
    expect(fact(document, "Officer access").textContent).toContain(hostile);
    expect(fact(document, "Configuration revision").textContent).toBe("42");
  });

  test("does not expose hidden channel IDs, and still shows all saved channels and rooms when switches are off", async () => {
    const guild = configGuild({
      guest_applications_enabled: false,
      access_policy_enabled: false,
      changelog_channel_id: CHANNEL.changelog,
      changelog_version: "3.1.0",
    });
    const names: WebNames = {
      roles: new Map(),
      channels: new Map([
        [CHANNEL.ledger, "ledger"],
        [CHANNEL.notices, "notices"],
        [CHANNEL.reviews, "reviews-kept"],
        [CHANNEL.lobby, "lobby-kept"],
        [CHANNEL.officers, null],
        [CHANNEL.changelog, "updates"],
      ]),
      users: new Map(),
    };
    const { markup, document } = await documentOf(configReport({ guild }), names);
    expect(markup).not.toContain(CHANNEL.officers);
    expect(fact(document, "Officer room").querySelector(".mention")).toBeNull();
    expect(fact(document, "Officer room").textContent?.trim()).not.toBe("");
    for (const [label, expected] of [
      ["Ledger", "#ledger"],
      ["Officer notifications", "#notices"],
      ["Guest application reviews", "#reviews-kept"],
      ["Changelog", "#updates"],
      ["Lobby", "#lobby-kept"],
    ]) {
      if (!label || !expected) throw new Error("Invalid channel fixture");
      expect(fact(document, label).textContent).toContain(expected);
    }
    expect(fact(document, "Guest applications").textContent).toContain("Off");
    expect(fact(document, "Onboarding").textContent).toBe("Off");
    expect(document.querySelectorAll("button, form, input, select, textarea")).toHaveLength(0);
    expect(document.querySelector("main")?.textContent).toContain("/config");
  });

  test("distinguishes failed and warning checks from pending and disabled state", async () => {
    const report = configReport({
      guild: configGuild({ effects_enabled: false, guest_grandfather: "pending" }),
      capabilities: { member_role_id: "Role is above TaruBot" },
      fc: fcRow({ fresh: false, last_successful_roster_at: ROSTER_AT }),
      visibility: null,
    });
    const { document } = await documentOf(report);
    const full = document.querySelector('section[aria-labelledby="configuration-checklist"]');
    expect(full?.querySelectorAll(".check-fail")).toHaveLength(1);
    expect(full?.querySelectorAll(".check-warn")).toHaveLength(3);
    expect(full?.querySelectorAll(".check-wait")).toHaveLength(1);
    expect(document.querySelector(".featured h2")?.textContent).toContain("4");
    const checked = document.querySelector(".featured time");
    expect(checked?.getAttribute("datetime")).toBe(CHECKED_AT.toISOString());
    expect(checked?.textContent).toContain("UTC");
    expect(fact(document, "Roster read").querySelector("time")?.getAttribute("datetime")).toBe(
      ROSTER_AT.toISOString(),
    );
    for (const element of document.querySelectorAll("time"))
      expect(element.textContent).toContain("UTC");
  });

  test("renders awaiting activation and deployment-disabled as distinct exact effects modes", async () => {
    for (const mode of [
      "live",
      "awaiting_activation",
      "deployment_disabled",
    ] as const satisfies readonly EffectsMode[]) {
      const { document } = await documentOf(configReport({ effectsMode: mode }));
      const changes = fact(document, "Discord changes");
      expect(changes.querySelector("code")?.textContent).toBe(mode);
      expect(changes.querySelector(".check")?.textContent).toBe(
        CHECK[mode === "live" ? "ok" : mode === "awaiting_activation" ? "wait" : "off"],
      );
    }
  });

  test("keeps a real FC ID linked when identity is unavailable, but never invents identity for an unlinked server", async () => {
    const linked = await documentOf({ ...configReport(), fc: [] });
    expect(fact(linked.document, "FC ID").textContent).toBe(CONFIG_FC.id);
    expect(fact(linked.document, "Company").querySelector("a")?.getAttribute("href")).toContain(
      `/freecompany/${CONFIG_FC.id}/`,
    );
    expect(fact(linked.document, "Roster read").querySelector("time")).toBeNull();
    const unlinked = await documentOf(configReport({ guild: configGuild({ fc_id: null }) }));
    expect(fact(unlinked.document, "Company").querySelector("a")).toBeNull();
    expect(unlinked.markup).not.toContain(CONFIG_FC.id);
  });

  test("guest applications are closed whenever the switch, review channel or Guest role is absent", async () => {
    for (const settings of [
      { guest_applications_enabled: false },
      { guest_application_channel_id: null },
      { guest_role_id: null },
    ]) {
      const { document } = await documentOf(configReport({ guild: configGuild(settings) }));
      expect(fact(document, "Guest applications").textContent).not.toContain("Open");
    }
    const open = await documentOf(configReport());
    expect(fact(open.document, "Guest applications").textContent).toContain("Open");
  });

  test("has one featured card, whose readouts count the checklist's own tokens", async () => {
    for (const report of [
      configReport(),
      configReport({
        guild: configGuild({ effects_enabled: false, guest_grandfather: "pending" }),
        capabilities: { member_role_id: "Role is above TaruBot" },
        fc: fcRow({ fresh: false, last_successful_roster_at: ROSTER_AT }),
        visibility: null,
      }),
    ]) {
      const { document } = await documentOf(report);
      // The design's one holographic card per view is the health snapshot.
      expect(document.querySelectorAll(".featured")).toHaveLength(1);
      expect(document.querySelectorAll(".orr-holo-edge")).toHaveLength(1);
      expect(document.querySelector(".orr-holo-edge")?.classList.contains("featured")).toBe(true);
      const full = document.querySelector('section[aria-labelledby="configuration-checklist"]');
      const tokens = (check: string) => full?.querySelectorAll(`.check-${check}`).length ?? 0;
      const readouts = [...document.querySelectorAll(".featured dd")].map((dd) => dd.textContent);
      expect(readouts).toEqual([
        String(tokens("ok")),
        String(tokens("wait")),
        String(tokens("off")),
      ]);
      const attention = tokens("fail") + tokens("warn");
      expect(document.querySelector(".featured h2")?.textContent).toBe(
        attention > 0
          ? `${attention} ${attention === 1 ? "check needs" : "checks need"} attention.`
          : tokens("wait") > 0
            ? "Ready, with work waiting."
            : "All checks passed.",
      );
    }
  });

  test("folds only long groups whose every check passed; anything else stays open", async () => {
    const healthy = await documentOf(configReport());
    const folds = healthy.document.querySelectorAll("details.check-group__fold");
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      expect(fold.querySelector("summary")?.textContent?.trim()).toMatch(
        /^All \d+ checks passed$/u,
      );
      const rows = fold.querySelectorAll(".check-row");
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(fold.querySelectorAll(".check-row .check-ok")).toHaveLength(rows.length);
    }
    // One failing role keeps its whole group open, beside the other three that passed.
    const failing = await documentOf(
      configReport({ capabilities: { member_role_id: "Role is above TaruBot" } }),
    );
    const roles = [...failing.document.querySelectorAll(".check-group")].find(
      (group) => group.querySelector("h3")?.textContent === "Access roles",
    );
    expect(roles?.querySelectorAll(".check-row")).toHaveLength(4);
    expect(roles?.querySelector("details")).toBeNull();
    // Across every state, no token but [OK] is ever inside a fold.
    for (const { document } of [healthy, failing])
      expect(
        document.querySelectorAll(
          "details.check-group__fold :is(.check-fail, .check-warn, .check-wait, .check-off)",
        ),
      ).toHaveLength(0);
  });

  test("defines each fact once, and gives every disclosure a summary", async () => {
    const { document } = await documentOf(
      configReport({
        guild: configGuild({ guest_grandfather: "completed" }),
        fc: fcRow({ last_attempt_at: ROSTER_AT, last_error: "rate_limited" }),
      }),
    );
    // The state row repeats three labels as a list, never as a second dt for the same term.
    const labels = [...document.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      [...document.querySelectorAll('[aria-label="Current configuration state"] li')].map(
        (item) => item.querySelector(".orr-label")?.textContent,
      ),
    ).toEqual(["Discord changes", "Onboarding", "Role layout"]);
    for (const details of document.querySelectorAll("details"))
      expect(details.querySelector(":scope > summary")?.textContent?.trim()).not.toBe("");
    expect(fact(document, "Last roster error").querySelector("pre code")?.textContent).toBe(
      "rate_limited",
    );
  });

  test("every class the view renders has a rule in the stylesheet", async () => {
    const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");
    // Hooks drawn entirely by the classes beside them: .featured is the holographic card, and
    // [OFF] wears the neutral look every .check starts with (components.ts).
    const hooks = new Set(["featured", "check-off"]);
    const classes = new Set<string>();
    for (const report of [
      configReport(),
      configReport({
        guild: configGuild({ fc_id: null, guest_grandfather: "pending" }),
        effectsMode: "deployment_disabled",
      }),
      configReport({
        capabilities: { member_role_id: `Missing permissions for <@&${ROLE.member}>` },
        fc: fcRow({ fresh: false, last_successful_roster_at: ROSTER_AT, last_error: "x" }),
        effectsMode: "awaiting_activation",
      }),
    ]) {
      const names: WebNames = {
        roles: new Map([[ROLE.member, "Member"]]),
        channels: new Map([[CHANNEL.ledger, "ledger"]]),
        users: new Map(),
      };
      const { document } = await documentOf(report, names);
      for (const element of document.querySelectorAll("[class]"))
        for (const name of element.classList) classes.add(name);
    }
    expect(classes.size).toBeGreaterThan(30);
    for (const name of classes)
      if (!hooks.has(name))
        expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
          name,
          styled: true,
        });
  });
});
