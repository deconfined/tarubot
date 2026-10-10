/**
 * Setup replies (2.35.0, #46): every catalog state follows the house style; the kind follows the
 * status, the blockers and N, what the server owner must fix in Discord, so denied channels,
 * private categories, permissions to grant and refused channels never read as an all-clear; the
 * overrides fields keep their pinned order; a production-sized dry run stays within ten fields
 * with nothing cut; and the onboarding dry run lists every blocker.
 */
import { describe, expect, test } from "bun:test";
import type { OverridesResult } from "../../src/application/overrides.js";
import {
  overridesKind,
  overridesReply,
  SETUP_REPLY_KINDS,
  setupPlanKind,
  setupPlanReply,
} from "../../src/discord/presenters/setup.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import { expectHouseStyle, onlyEmbed } from "../fixtures/replies.js";
import { catalogTests } from "../fixtures/replies/index.js";
import {
  applied,
  channelId,
  nothing,
  OVERRIDES_RESULTS as R,
  PRIVATE_CATEGORY,
  plan,
  postingWrite,
  productionPlan,
  roleId,
  SETUP_CASES,
  SETUP_PLANS,
} from "../fixtures/replies/setup.js";
import { NOW, VIEWERS } from "../fixtures/results.js";

catalogTests("setup", SETUP_CASES);

/** The rendered embed of a result, for a server manager. */
const embedOf = (result: OverridesResult) =>
  onlyEmbed(overridesReply(result, VIEWERS.manager, { now: NOW }));
/** Field names in order. */
const names = (result: OverridesResult) =>
  (embedOf(result).fields ?? []).map((field) => field.name);
/** A field's value by name. */
const fieldOf = (result: OverridesResult, name: string) =>
  embedOf(result).fields?.find((field) => field.name === name)?.value;

test("the catalog covers every setup reply kind", () => {
  expect(Object.keys(SETUP_CASES).sort()).toEqual([...SETUP_REPLY_KINDS].sort());
});

describe("kind selection", () => {
  test("a dry run is plan, plan_blocked (blockers first) or plan_attention (N > 0)", () => {
    expect(overridesKind(plan())).toBe("overrides.plan");
    expect(overridesKind(plan({ blockers: ["administrator"] }))).toBe("overrides.plan_blocked");
    // Blockers outrank attention: confirm:true would refuse outright.
    expect(overridesKind(plan({ blockers: ["caller"], denied: [channelId(80)] }))).toBe(
      "overrides.plan_blocked",
    );
    for (const extra of [
      { denied: [channelId(80)] },
      { privateCategories: [PRIVATE_CATEGORY] },
      { grantBeforeRemoving: ["ManageNicknames" as const] },
    ])
      expect(overridesKind(plan(extra))).toBe("overrides.plan_attention");
  });

  test("nothing to add is nothing only when N = 0", () => {
    expect(overridesKind(nothing())).toBe("overrides.nothing");
    // Hidden on purpose is a choice, not something to fix.
    expect(overridesKind(nothing({ hiddenOnPurpose: [channelId(90)] }))).toBe("overrides.nothing");
    expect(overridesKind(nothing({ denied: [channelId(80)] }))).toBe("overrides.nothing_attention");
    expect(overridesKind(nothing({ privateCategories: [PRIVATE_CATEGORY] }))).toBe(
      "overrides.nothing_attention",
    );
  });

  test("a real run is applied for N = 0 and applied_attention otherwise, refused channels counted", () => {
    expect(overridesKind(applied())).toBe("overrides.applied");
    expect(overridesKind(applied({ refused: [channelId(20)], skipped: [channelId(20)] }))).toBe(
      "overrides.applied_attention",
    );
    expect(overridesKind(applied({ privateCategories: [PRIVATE_CATEGORY] }))).toBe(
      "overrides.applied_attention",
    );
    expect(overridesKind(applied({ denied: [channelId(80)] }))).toBe("overrides.applied_attention");
    // Stopped whatever N is; onboarding whatever else.
    expect(overridesKind(applied({ status: "stopped", stopped: "time" }))).toBe(
      "overrides.stopped",
    );
    expect(overridesKind({ status: "onboarding", effectsMode: "live" })).toBe(
      "overrides.onboarding",
    );
  });

  test("titles count blockers, or N", () => {
    expect(embedOf(plan({ blockers: ["administrator"] })).title).toBe(
      "Channel overrides · dry run · 1 blocker",
    );
    expect(
      embedOf(
        plan({ denied: [channelId(80), channelId(81)], privateCategories: [PRIVATE_CATEGORY] }),
      ).title,
    ).toBe("Channel overrides · dry run · 3 to fix in Discord");
    expect(embedOf(applied({ refused: [channelId(20)] })).title).toBe(
      "Channel overrides added · 1 to fix in Discord",
    );
  });

  test("the onboarding dry run is blocked exactly when it has blockers", () => {
    expect(setupPlanKind(SETUP_PLANS.plan)).toBe("onboarding.plan");
    expect(setupPlanKind(SETUP_PLANS.blocked)).toBe("onboarding.plan_blocked");
  });
});

describe("field order", () => {
  test("blockers, denied, private categories, grants, writes, unsynced, not changed, next steps", () => {
    const everything = plan({
      blockers: ["administrator"],
      denied: [channelId(80)],
      privateCategories: [PRIVATE_CATEGORY],
      grantBeforeRemoving: ["ManageNicknames"],
      hiddenOnPurpose: [channelId(90)],
      writes: [...plan().writes, postingWrite(channelId(5), true)],
    });
    expect(names(everything)).toEqual([
      "Blockers",
      "Configured but denied to TaruBot",
      "Private categories holding a configured channel",
      "Grant before removing Administrator",
      "Categories (1)",
      "Synced channels (2)",
      "Posting channels (2)",
      "No longer synced with their category",
      "Not changed",
      "Next steps",
    ]);
  });

  test("each field appears only when it has something to say", () => {
    // Nothing to add while TaruBot still holds Administrator: the window's last rerun says what
    // comes next; without Administrator there is nothing to add or remove.
    expect(names(R.nothing)).toEqual(["Next steps"]);
    expect(names(nothing({ administratorRoles: [] }))).toEqual([]);
    // The sample real run put one parked job back in the queue.
    expect(names(R.applied)).toEqual([
      "Categories (1)",
      "Synced channels (2)",
      "Posting channels (1)",
      "Held work",
      "Next steps",
    ]);
    expect(names(applied({ requeued: 0 }))).not.toContain("Held work");
  });

  test("a real run's requeued jobs show as held work, as /config saves do; a dry run never does", () => {
    expect(fieldOf(applied({ requeued: 2 }), "Held work")).toBe(
      "`… QUEUED` 2 held jobs queued again",
    );
    expect(fieldOf(nothing({ requeued: 1 }), "Held work")).toBe(
      "`… QUEUED` 1 held job queued again",
    );
    expect(
      fieldOf(
        applied({ status: "stopped", stopped: "time", remaining: 3, requeued: 1 }),
        "Held work",
      ),
    ).toBe("`… QUEUED` 1 held job queued again");
    // Paused: the jobs retry when the pause ends.
    expect(
      fieldOf(applied({ requeued: 1, effectsMode: "awaiting_activation" }), "Held work"),
    ).toStartWith("1 held job will retry");
    expect(names(nothing())).not.toContain("Held work");
  });

  test("channels hidden only through their category's deny are counted apart", () => {
    const [shown, inside] = [channelId(90), channelId(91)];
    expect(
      fieldOf(
        plan({ hiddenOnPurpose: [shown, inside], hiddenByCategory: [inside] }),
        "Not changed",
      ),
    ).toBe(
      `Hidden on purpose: <#${shown}> and <#${inside}> (1 inside a category hidden from TaruBot)`,
    );
    expect(fieldOf(plan({ hiddenOnPurpose: [shown] }), "Not changed")).toBe(
      `Hidden on purpose: <#${shown}>`,
    );
  });

  test("nothing to add while Administrator is held ends the window: validate, then remove it", () => {
    expect(fieldOf(R.nothing, "Next steps")).toBe(
      fieldOf(applied({ administratorRoles: R.nothing.administratorRoles }), "Next steps"),
    );
    expect(fieldOf(R.nothing, "Next steps")).toStartWith(
      "1. Run /config validate.\n2. When it says Administrator is no longer needed, ",
    );
    expect(fieldOf(R.nothingAttention, "Next steps")).toStartWith("1. Run /config validate.");
  });

  test("a plan left with unreadable channels says why: no Administrator, or still hidden", () => {
    const unread = [channelId(70)];
    expect(
      embedOf(plan({ writes: [], unreadable: unread, blockers: ["administrator"] })).description,
    ).toStartWith(
      "TaruBot can't read 1 channel until Administrator is on, so it can't plan them yet.",
    );
    // TaruBot holds Administrator and a fresh read still couldn't see it.
    const held = embedOf(plan({ writes: [], unreadable: unread, blockers: [] }));
    expect(held.description).toStartWith(
      "TaruBot still can't read 1 channel, so it can't plan them yet.",
    );
    expect(held.fields?.find((field) => field.name === "Not changed")?.value).toContain(
      "TaruBot still can't read",
    );
  });

  test("write groups share a field by what they write; synced children say they copy it", () => {
    const text = fieldOf(plan(), "Synced channels (2)");
    expect(text).toContain("They copy their category's entry, so they stay synced.");
    expect(fieldOf(plan(), "Categories (1)")).toStartWith(
      "Allow View Channel; deny Read Message History, Manage Permissions, Manage Channels, Create Invite and Connect.",
    );
    // A masked configured channel only has its history deny lifted.
    const masked = plan({
      writes: [
        {
          id: channelId(6),
          kind: "channel",
          posting: true,
          allow: [],
          deny: [],
          cleared: ["ReadMessageHistory"],
          inherited: false,
          unsyncs: false,
        },
      ],
    });
    expect(fieldOf(masked, "Posting channels (1)")).toStartWith(
      "Lift the Read Message History deny.",
    );
  });

  test("lists show six mentions, then 'and K more'", () => {
    const denied = Array.from({ length: 9 }, (_, index) => channelId(800 + index));
    expect(fieldOf(nothing({ denied }), "Configured but denied to TaruBot")).toBe(
      `${denied
        .slice(0, 5)
        .map((id) => `<#${id}>`)
        .join(
          ", ",
        )}, <#${denied[5]}> and 3 more; lift the deny or change the setting before removing Administrator`,
    );
  });
});

describe("attention is never an all-clear", () => {
  test("nothing_attention names the denied channels and the private categories", () => {
    const embed = embedOf(R.nothingAttention);
    expect(embed.title).toBe("Channel overrides · nothing to add · 2 to fix in Discord");
    expect(fieldOf(R.nothingAttention, "Configured but denied to TaruBot")).toContain(
      `<#${channelId(80)}>`,
    );
    const categories = fieldOf(
      R.nothingAttention,
      "Private categories holding a configured channel",
    );
    expect(categories).toContain(
      `<#${PRIVATE_CATEGORY.id}> (holds <#${PRIVATE_CATEGORY.configured[0]}>)`,
    );
    expect(categories).toContain(
      "Left alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself, then run /setup overrides again.",
    );
  });

  test("applied_attention lists the refused channels under Not changed", () => {
    expect(fieldOf(R.appliedAttention, "Not changed")).toBe(
      `Discord refused TaruBot's entry: <#${channelId(20)}>; they stay missing in /config validate`,
    );
    expect(overridesReply(R.appliedAttention, VIEWERS.manager).options.embeds[0]?.color).toBe(
      onlyEmbed(overridesReply(plan({ blockers: ["caller"] }), VIEWERS.manager)).color,
    );
  });

  test("the applied next steps name how to take Administrator away", () => {
    expect(fieldOf(R.applied, "Next steps")).toBe(
      `1. Run /config validate.\n2. When it says Administrator is no longer needed, turn it off in <@&${R.applied.administratorRoles[0]}>, and remove <@&${R.applied.administratorShared[0]}> from TaruBot.`,
    );
  });

  test("a dry run without Administrator lists the entries it can't read yet", () => {
    expect(fieldOf(R.planBlocked, "Not changed")).toBe(
      `Hidden from TaruBot until Administrator is on: <#${channelId(70)}>`,
    );
  });

  test("the blocker lines are the pinned ones, in order", () => {
    expect(
      fieldOf(
        plan({ blockers: ["caller", "effects", "administrator", "base_permissions"] }),
        "Blockers",
      ),
    ).toBe(
      [
        "Only someone with Administrator, or the server owner, can run `confirm:true`.",
        "Discord changes are paused here, so `confirm:true` would refuse until they're on.",
        "TaruBot doesn't hold Administrator. Turn it on for TaruBot's role before `confirm:true`, and remove it once `/config validate` says it is no longer needed.",
        "Give TaruBot's role View Channel, Send Messages, Embed Links and Read Message History first, so it keeps them once Administrator is off.",
      ].join("\n"),
    );
  });
});

test("a production-sized dry run stays within ten fields with nothing cut", () => {
  const presented = overridesReply(productionPlan(), VIEWERS.manager, { now: NOW });
  const embed = expectHouseStyle(presented, {
    tone: "warning",
    title: "Channel overrides · dry run · 1 blocker",
    timestamp: true,
  });
  expect(presented.truncated).toBe(false);
  const fields = embed.fields ?? [];
  expect(fields.length).toBeLessThanOrEqual(HOUSE_LIMITS.fields);
  for (const field of fields)
    expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
  const fieldNames = fields.map((field) => field.name);
  expect(fieldNames[0]).toBe("Blockers");
  expect(fieldNames.at(-1)).toBe("Next steps");
  // The groups the slots can't hold merge into one field that still counts every channel.
  expect(fieldNames).toContain("Other changes");
  const counted = fields
    .map((field) => /\((\d+)\)$/u.exec(field.name)?.[1])
    .filter((value): value is string => value !== undefined)
    .reduce((total, value) => total + Number(value), 0);
  const other = /in (\d+) channels/u.exec(
    fields.find((field) => field.name === "Other changes")?.value ?? "",
  );
  expect(counted + Number(other?.[1] ?? 0)).toBe(productionPlan().writes.length);
});

describe("/setup onboarding's dry run", () => {
  test("it lists every blocker first, and says nothing was changed", () => {
    const embed = onlyEmbed(setupPlanReply(SETUP_PLANS.blocked, VIEWERS.manager, { now: NOW }));
    expect(embed.fields?.[0]?.name).toBe("Blockers");
    const lines = embed.fields?.[0]?.value.split("\n") ?? [];
    expect(lines).toHaveLength(SETUP_PLANS.blocked.blockers.length);
    expect(lines[2]).toBe(
      `• TaruBot needs View Channel, Manage Channels and Manage Roles in <#${channelId(3)}>.`,
    );
    expect(embed.description).toContain("Nothing was changed.");
  });

  test("a member-entry blocker keeps its whole remedy (TaruBot's own text, not cut at 300)", () => {
    // Text 22 for a voice channel, the longest form, as src/discord/guild-access.ts words it.
    const message = `TaruBot's member entry in <#${channelId(9)}> denies Manage Channels, Manage Permissions and Connect; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels, Manage Permissions and Connect there.`;
    expect(message.length).toBeGreaterThan(HOUSE_LIMITS.userText);
    const embed = onlyEmbed(
      setupPlanReply(
        { ...SETUP_PLANS.blocked, blockers: [{ code: "blocked", message }] },
        VIEWERS.manager,
        { now: NOW },
      ),
    );
    expect(embed.fields?.[0]?.value).toBe(`• ${message}`);
  });

  test("a role on the self-service role menu is a blocker naming the role and the fix (2.39.0)", () => {
    const presented = setupPlanReply(SETUP_PLANS.onMenu, VIEWERS.manager, { now: NOW });
    const embed = expectHouseStyle(presented, {
      tone: "warning",
      title: "Server setup · dry run · 1 blocker",
    });
    expect(embed.fields?.[0]).toMatchObject({
      name: "Blockers",
      value: `• <@&${roleId(11)}> is on the self-service role menu, so /setup onboarding can't use it as the Member role. Remove it on the Role menu page first, rename it in Discord, or choose the access role with /config roles first.`,
    });
  });

  test("a clean plan says what confirm:true would create, reuse and change", () => {
    const embed = onlyEmbed(setupPlanReply(SETUP_PLANS.plan, VIEWERS.manager, { now: NOW }));
    const value = (name: string) => embed.fields?.find((field) => field.name === name)?.value;
    expect(value("Access roles")).toContain("· reuse, renamed to EXFC Member");
    expect(value("Rooms")).toBe(`Lobby · create #lobby\nOfficer room <#${channelId(2)}> · reuse`);
    expect(value("Channel access")).toContain("and 8 more.");
    expect(value("Channel access")).toContain("@everyone would lose View Channel");
    expect(value("Settings")).toContain("Role layout: off");
  });

  test("many blockers stay within ten fields, counted exactly", () => {
    const blockers = Array.from({ length: 40 }, (_, index) => ({
      code: "blocked" as const,
      message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${channelId(1000 + index)}>. ${"Padding. ".repeat(12)}`,
    }));
    const presented = setupPlanReply({ ...SETUP_PLANS.blocked, blockers }, VIEWERS.manager, {
      now: NOW,
    });
    const embed = expectHouseStyle(presented, { tone: "warning" });
    const values = (embed.fields ?? [])
      .filter((field) => field.name.startsWith("Blockers"))
      .map((field) => field.value);
    const shown = values
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("• ")).length;
    const more = Number(/…and (\d+) more/u.exec(values.at(-1) ?? "")?.[1] ?? 0);
    expect(shown + more).toBe(40);
  });
});
