/**
 * The shared presentation primitives: formatting helpers keep gil exact, times as Discord
 * timestamps and user text inert; the builders keep every message inside Discord's limits, never
 * ping, and are the only way to create a Presented; audiences mirror the authorization policy.
 */
import { describe, expect, test } from "bun:test";
import { embedLength, EmbedBuilder } from "discord.js";
import type { InteractionEditReplyOptions, InteractionReplyOptions } from "discord.js";
import { parseControl } from "../../src/discord/custom-ids.js";
import { audienceOf, isOfficer, viewerOf } from "../../src/discord/presenters/audience.js";
import {
  detailsButton,
  editProfileButton,
  ledgerPager,
  lodestoneProfileButton,
  recheckButton,
  syncStatusButton,
  verifyButton,
  viewHistoryButton,
} from "../../src/discord/presenters/controls.js";
import {
  characterName,
  choice,
  cmd,
  code,
  count,
  cut,
  deadline,
  fcName,
  fcTagText,
  fcTitleName,
  footerText,
  gilText,
  link,
  list,
  lodestone,
  member,
  plain,
  quote,
  retryWhen,
  shortId,
  signedGilText,
  splitFields,
  title,
  titleText,
  when,
} from "../../src/discord/presenters/format.js";
import {
  applicationState,
  grantProvenance,
  linkProvenance,
} from "../../src/discord/presenters/labels.js";
import {
  dataReply,
  embed,
  post,
  Presented,
  reply,
  type ButtonSpec,
} from "../../src/discord/presenters/reply.js";
import { MARKER, marker, TONE_COLOR } from "../../src/discord/presenters/style.js";
import { Failure, MAX_GIL } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectHouseStyle,
  onlyEmbed,
  stress,
  TONE_COLORS,
  visibleText,
} from "../fixtures/replies.js";
import { catalogTests, type ReplyCatalog } from "../fixtures/replies/index.js";
import { ACTORS, CHARACTER, FC, NOW, REF, VIEWERS } from "../fixtures/results.js";
import { actorOf } from "../fixtures/actors.js";

describe("formatting", () => {
  test("gil is exact, grouped and signed with '+' or U+2212, never routed through Number()", () => {
    expect(gilText(9_223_372_036_854_775_807n)).toBe("9,223,372,036,854,775,807 gil");
    expect(gilText(0n)).toBe("0 gil");
    expect(signedGilText(10_005_000n)).toBe("+10,005,000 gil");
    expect(signedGilText(-2_500_000n)).toBe("\u22122,500,000 gil");
    expect(signedGilText(-MAX_GIL)).toBe("\u22129,223,372,036,854,775,807 gil");
    expect(signedGilText(0n)).toBe("0 gil");
    expect(signedGilText(-1n)).not.toContain("-");
  });

  test("count() groups digits and chooses singular or plural", () => {
    expect(count(1, "member")).toBe("1 member");
    expect(count(1_204, "member")).toBe("1,204 members");
    expect(count(0, "entry", "entries")).toBe("0 entries");
    expect(count(1n, "entry", "entries")).toBe("1 entry");
    expect(count(12_345_678_901_234_567_890n, "entry", "entries")).toBe(
      "12,345,678,901,234,567,890 entries",
    );
  });

  test("when() and deadline() emit Discord timestamps floored to whole seconds", () => {
    const instant = new Date(1_790_169_000_999);
    expect(when(instant, "R")).toBe("<t:1790169000:R>");
    expect(when(instant)).toBe("<t:1790169000:f>");
    expect(when(instant, "D")).toBe("<t:1790169000:D>");
    expect(deadline(new Date(1_790_123_400_000))).toBe("<t:1790123400:R> (<t:1790123400:t>)");
  });

  test("retryWhen() says 'shortly', 'in a few seconds', or relative plus absolute time", () => {
    expect(retryWhen(0, NOW)).toBe("shortly");
    expect(retryWhen(-3, NOW)).toBe("shortly");
    expect(retryWhen(4.5, NOW)).toBe("in a few seconds");
    expect(retryWhen(60, NOW)).toBe("<t:1790169060:R> (<t:1790169060:T>)");
    expect(retryWhen(59.2, NOW)).toBe("<t:1790169060:R> (<t:1790169060:T>)");
  });

  test("plain() escapes markdown and neutralizes mentions, timestamps and commands", () => {
    const escaped = plain(
      "# Head **bold** `tick` [x](https://example.com) <@123> <#456> <@&789> <t:1790169000:R> </ping:1> <:e:1> ||s|| ~~t~~",
    );
    expect(escaped).toStartWith("\\# Head");
    expect(escaped).toContain("\\*\\*bold\\*\\*");
    expect(escaped).toContain("\\`tick\\`");
    expect(escaped).toContain("\\[x](https://example.com)");
    for (const syntax of ["<@123>", "<#456>", "<@&789>", "<t:1790169000:R>", "</ping:1>", "<:e:1>"])
      expect(escaped).toContain(`\\${syntax}`);
    expect(escaped).toContain("\\|\\|s\\|\\|");
    expect(escaped).toContain("\\~\\~t\\~\\~");
    // A leading list, numbered list, quote or subtext marker can't render either.
    expect(plain("- item")).toBe("\\- item");
    expect(plain("1. item")).toBe("1\\. item");
    expect(plain("> quote")).toBe("\\> quote");
    expect(plain("-# small")).toBe("\\-# small");
    // Newlines collapse, so user text can't start a heading or list on a later line.
    expect(plain("first\n# second\n- third")).toBe("first # second - third");
  });

  test("plain() fits its budget and never leaves a dangling escape", () => {
    for (let max = 1; max <= 60; max += 1) {
      const escaped = plain("*".repeat(100), max);
      expect(escaped.length).toBeLessThanOrEqual(max);
      expect(/(?<!\\)(\\\\)*\\…$/u.test(escaped)).toBe(false);
    }
    expect(plain(stress.text(5_000), 300).length).toBeLessThanOrEqual(300);
  });

  test("quote() prefixes each non-empty line and escapes its content", () => {
    expect(quote("line one **b**\n\n# two\n- three")).toBe(
      "> line one \\*\\*b\\*\\*\n> \\# two\n> \\- three",
    );
    expect(quote(stress.text(5_000), 250).length).toBeLessThanOrEqual(250);
  });

  test("titles escape inline markdown only, footers nothing, and sections use ' · '", () => {
    expect(titleText("Ex*ample*  Character")).toBe("Ex\\*ample\\* Character");
    expect(titleText("x".repeat(300), 60)).toHaveLength(60);
    expect(footerText("Ref 1 ·  **raw**\nline")).toBe("Ref 1 · **raw** line");
    expect(title("Sync status", null, "server", false)).toBe("Sync status · server");
  });

  test("cut() never splits a grapheme and always returns well-formed text", () => {
    const family = "👩‍👩‍👧‍👦";
    expect(cut(`${family}${family}`, family.length + 1)).toBe(`${family}…`);
    expect(cut(`${family}${family}`, family.length)).toBe("…");
    expect(cut("e\u0302\u0302e\u0302\u0302", 4)).toBe("e\u0302\u0302…");
    expect(cut("🇯🇵🇯🇵", 3)).toBe("…");
    expect(cut("abc", 3)).toBe("abc");
    expect(cut("abc", 0)).toBe("");
    for (let max = 0; max <= 120; max += 1) {
      const text = cut(stress.text(200), max);
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text.isWellFormed()).toBe(true);
    }
    expect(cut("a\ud800b", 10).isWellFormed()).toBe(true);
  });

  test("list() stays within its budget, including the '…and N more' line", () => {
    const items = Array.from({ length: 25 }, (_, index) => `line ${index}`);
    expect(list(items)).toBe([...items.slice(0, 10), "…and 15 more"].join("\n"));
    expect(list(items.slice(0, 3))).toBe(items.slice(0, 3).join("\n"));
    expect(list([])).toBe("");
    const long = Array.from({ length: 1_500 }, () => "x".repeat(120));
    for (const budget of [16, 100, 500, 1_024]) {
      const text = list(long, { max: 1_500, budget });
      expect(text.length).toBeLessThanOrEqual(budget);
      const shown = text.split("\n").length - 1;
      expect(text).toEndWith(`…and ${(1_500 - shown).toLocaleString("en-US")} more`);
    }
  });

  test("splitFields() packs whole lines into numbered fields within the value limit", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `${index} ${"y".repeat(240)}`);
    const fields = splitFields("Needs attention", lines);
    expect(fields.length).toBe(3);
    expect(fields.map((field) => field.name)).toEqual([
      "Needs attention (1/3)",
      "Needs attention (2/3)",
      "Needs attention (3/3)",
    ]);
    for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1_024);
    expect(fields.flatMap((field) => field.value.split("\n"))).toEqual(lines);
    expect(splitFields("Runs", ["one"])).toEqual([{ name: "Runs", value: "one" }]);
  });

  test("splitFields() joins with a given separator and counts it against the budget (2.29.0)", () => {
    // The status post's mention groups: 21-character mentions joined with ', ' fill a 1,024
    // field with 44 each ((1,024 + 2) / 23), so 100 of them take three fields.
    const mentions = Array.from(
      { length: 100 },
      (_, index) => `<@${100_000_000_000_000_000n + BigInt(index)}>`,
    );
    const fields = splitFields("Member → Guest", mentions, 1_024, ", ");
    expect(fields.map((field) => field.name)).toEqual([
      "Member → Guest (1/3)",
      "Member → Guest (2/3)",
      "Member → Guest (3/3)",
    ]);
    expect(fields.map((field) => field.value.split(", ").length)).toEqual([44, 44, 12]);
    for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1_024);
    expect(fields.flatMap((field) => field.value.split(", "))).toEqual(mentions);
    // Exactly at the budget still fits; one more character moves the line to a new field.
    expect(splitFields("Pair", ["a".repeat(5), "b".repeat(5)], 12, ", ")).toEqual([
      { name: "Pair", value: "aaaaa, bbbbb" },
    ]);
    expect(splitFields("Pair", ["a".repeat(5), "b".repeat(6)], 12, ", ")).toEqual([
      { name: "Pair (1/2)", value: "aaaaa" },
      { name: "Pair (2/2)", value: "bbbbbb" },
    ]);
  });

  test("code() rejects backticks and line breaks; cmd() and member() build inline code", () => {
    expect(code("1a2b3c4d")).toBe("`1a2b3c4d`");
    expect(() => code("a`b")).toThrow();
    expect(() => code("a\nb")).toThrow();
    expect(() => code("")).toThrow();
    expect(cmd("ledger adjust", { balance: 10_005_000n })).toBe(
      "`/ledger adjust balance:10005000`",
    );
    expect(cmd("sync status", { run_id: stress.uuid })).toBe(
      `\`/sync status run_id:${stress.uuid}\``,
    );
    const id = "123456789012345678";
    expect(member(id, VIEWERS.member)).toBe(`<@${id}>`);
    expect(member(id, VIEWERS.member, "stacked")).toBe(`<@${id}>`);
    expect(member(id, VIEWERS.officer)).toBe(`<@${id}> (\`${id}\`)`);
    expect(member(id, VIEWERS.manager, "stacked")).toBe(`<@${id}>\n\`${id}\``);
    expect(() => member("<@1>", VIEWERS.member)).toThrow();
    expect(shortId(stress.uuid)).toBe("ffffffff");
  });

  test("choice() keeps autocomplete labels at 100 characters and refuses a cut value", () => {
    const long = choice(stress.text(400), stress.uuid);
    expect(long.name.length).toBeLessThanOrEqual(100);
    expect(long.value).toBe(stress.uuid);
    expect(choice("  ", "value")).toEqual({ name: "value", value: "value" });
    expect(() => choice("name", "v".repeat(101))).toThrow();
  });

  test("Lodestone links, names and masked links escape user text for where it renders", () => {
    expect(lodestone.character(CHARACTER.id)).toBe(
      "https://na.finalfantasyxiv.com/lodestone/character/12345678/",
    );
    expect(lodestone.freeCompany(FC.id)).toBe(
      "https://na.finalfantasyxiv.com/lodestone/freecompany/9234567890123456789/",
    );
    expect(lodestone.profileEdit).toBe(
      "https://na.finalfantasyxiv.com/lodestone/my/setting/profile/",
    );
    expect(() => lodestone.character("../../admin")).toThrow();
    expect(characterName(CHARACTER)).toBe("Example Character @ Diabolos");
    expect(characterName({ name: "_Ex*", world: "Diabolos" }, "title")).toBe("\\_Ex\\* @ Diabolos");
    expect(characterName({ name: stress.text(400), world: "Diabolos" }).length).toBeLessThanOrEqual(
      100,
    );
    expect(fcName(FC)).toBe("Example Free Company «EXFC» · Diabolos");
    expect(fcName({ ...FC, tag: "" }, "footer")).toBe("Example Free Company · Diabolos");
    // The Lodestone's own guillemets are stored with the tag; the house pair is added once (D1).
    expect(fcName({ ...FC, tag: "«EXFC»" })).toBe("Example Free Company «EXFC» · Diabolos");
    expect(fcTagText("«Souls»")).toBe("Souls");
    expect(fcTagText(" « Souls » ")).toBe("Souls");
    expect(fcTagText("EXFC")).toBe("EXFC");
    expect(fcTagText("«»")).toBeNull();
    expect(fcTagText("  ")).toBeNull();
    // Only one surrounding pair is the Lodestone's; anything inside it is the tag itself.
    expect(fcTagText("««x»»")).toBe("«x»");
    expect(fcTitleName(FC)).toBe("Example Free Company");
    expect(fcTitleName({ id: FC.id, name: " " })).toBe(`FC ${FC.id}`);
    expect(link("Example [Char](x)", lodestone.character(CHARACTER.id))).toBe(
      "[Example \\[Char\\](x)](https://na.finalfantasyxiv.com/lodestone/character/12345678/)",
    );
    // A typed backslash stays literal, so '\]' or a trailing '\' can't close the link early.
    expect(link("Bad\\]x", lodestone.character(CHARACTER.id))).toBe(
      "[Bad\\\\\\]x](https://na.finalfantasyxiv.com/lodestone/character/12345678/)",
    );
    expect(link("Trail\\", lodestone.character(CHARACTER.id))).toBe(
      "[Trail\\\\](https://na.finalfantasyxiv.com/lodestone/character/12345678/)",
    );
    expect(() => link("x", "javascript:alert(1)")).toThrow();
  });
});

describe("builders", () => {
  test("oversized input yields a valid embed within every Discord limit", () => {
    const built = embed({
      tone: "info",
      title: stress.text(300),
      description: stress.text(5_000),
      fields: Array.from({ length: 30 }, (_, index) => ({
        name: `Field ${index}`,
        value: stress.text(2_000),
      })),
      footer: stress.text(3_000),
      timestamp: NOW,
    });
    expect(built.truncated).toBe(true);
    const data = built.data;
    expect(embedLength(data)).toBeLessThanOrEqual(6_000);
    expect(data.fields?.length ?? 0).toBeLessThanOrEqual(25);
    expect(data.title?.length ?? 0).toBeLessThanOrEqual(256);
    for (const field of data.fields ?? []) {
      expect(field.name.length).toBeGreaterThan(0);
      expect(field.value.length).toBeGreaterThan(0);
      expect(field.value.length).toBeLessThanOrEqual(1_024);
    }
    expect(data.fields?.at(-1)?.value).toMatch(/^…and \d+ more sections$/u);
    expect(() =>
      new EmbedBuilder()
        .setTitle(data.title ?? null)
        .setDescription(data.description ?? null)
        .setFooter(data.footer ?? null)
        .addFields(data.fields ?? []),
    ).not.toThrow();
    // The same spec always yields the same embed.
    const again = embed({ tone: "info", title: stress.text(300), description: stress.text(5_000) });
    expect(again).toEqual(
      embed({ tone: "info", title: stress.text(300), description: stress.text(5_000) }),
    );
  });

  test("more than 25 fields keep 24 plus a final 'More' field; empty text gets stand-ins", () => {
    const built = embed({
      tone: "neutral",
      title: "Fields",
      fields: Array.from({ length: 30 }, (_, index) => ({ name: `F${index}`, value: "v" })),
    });
    expect(built.data.fields).toHaveLength(25);
    expect(built.data.fields?.at(-1)).toEqual({ name: "More", value: "…and 6 more" });
    const empty = embed({ tone: "neutral", title: "", fields: [{ name: "", value: "" }] });
    expect(empty.data.title).toBe("\u200b");
    expect(empty.data.fields).toEqual([{ name: "\u200b", value: "—" }]);
  });

  test("falsy fields and lines are dropped, and specs map onto the embed", () => {
    const presented = reply({
      tone: "success",
      title: "Deposit recorded",
      description: ["First line", false, null, "Second line"],
      fields: [
        { name: "New balance", value: gilText(120_450_000n), inline: true },
        false,
        undefined,
        { name: "Note", value: plain("Sold furnishings") },
      ],
      footer: ["Example Free Company «EXFC»", null, "Diabolos"],
      timestamp: NOW,
    });
    const data = expectHouseStyle(presented, { tone: "success", timestamp: true });
    expect(data.color).toBe(TONE_COLOR.success);
    expect(data.description).toBe("First line\nSecond line");
    expect(data.fields).toEqual([
      { name: "New balance", value: "120,450,000 gil", inline: true },
      { name: "Note", value: "Sold furnishings" },
    ]);
    expect(data.footer?.text).toBe("Example Free Company «EXFC» · Diabolos");
    expect(data.timestamp).toBe(NOW.toISOString());
  });

  test("replies and posts always carry content, embeds and components and never ping", () => {
    for (const presented of [
      reply({ tone: "info", title: "Bare" }),
      post({ tone: "success", title: "Deposit · +1 gil", description: stress.text(2_000) }),
    ]) {
      expect(Object.keys(presented.options).sort()).toEqual(
        ["allowedMentions", "components", "content", "embeds"].sort(),
      );
      expect(presented.options.content).toBe("");
      expect(presented.options.components).toEqual([]);
      expect(presented.options.allowedMentions).toEqual({ parse: [] });
      expect(Object.isFrozen(presented.options)).toBe(true);
    }
    // Posts may carry a full ledger note in the description (the documented exemption).
    expectHouseStyle(
      post({ tone: "success", title: "Deposit · +1 gil", description: plain(stress.text(2_000)) }),
    );
    // Both shapes fit the interaction entry points without casts.
    const edit: InteractionEditReplyOptions = reply({ tone: "info", title: "Edit" }).options;
    const create: InteractionReplyOptions = reply({ tone: "info", title: "Create" }).options;
    expect(edit.allowedMentions).toEqual(create.allowedMentions);
  });

  test("copyable text is the only content, as a code block above the embed", () => {
    const presented = reply({
      tone: "pending",
      title: "Verify Example Character @ Diabolos",
      copyable: "tarubot_ExampleTokenOnly-DoNotUse_0123456789abcdefg",
    });
    expect(presented.options.content).toBe(
      "```\ntarubot_ExampleTokenOnly-DoNotUse_0123456789abcdefg\n```",
    );
    expect(JSON.stringify(onlyEmbed(presented))).not.toContain("tarubot_Example");
    expect(() => reply({ tone: "info", title: "x", copyable: "a`b" })).toThrow();
  });

  test("buttons stay within 5×5, labels within 80 characters and custom IDs within 100", () => {
    const many: ButtonSpec[] = Array.from({ length: 30 }, (_, index) => ({
      style: "secondary",
      label: `${index} ${"L".repeat(100)}`,
      customId: `sync:status:${index.toString(16).padStart(8, "0")}-ffff-4fff-bfff-ffffffffffff`,
    }));
    const presented = reply({ tone: "info", title: "Buttons", buttons: many });
    expect(presented.truncated).toBe(true);
    expect(presented.options.components).toHaveLength(5);
    for (const row of presented.options.components) expect(row.components).toHaveLength(5);
    for (const button of buttonsOf(presented)) {
      expect("label" in button && (button.label?.length ?? 0) <= 80).toBe(true);
      if ("custom_id" in button) expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
    expect(() =>
      reply({
        tone: "info",
        title: "x",
        buttons: [{ style: "secondary", label: "Long", customId: "x".repeat(101) }],
      }),
    ).toThrow();
    expect(() =>
      reply({
        tone: "info",
        title: "x",
        buttons: [recheckButton("Re-check"), recheckButton("Run health check")],
      }),
    ).toThrow();
    expect(() =>
      reply({
        tone: "info",
        title: "x",
        buttons: [{ style: "link", label: "Bad", url: "http://example.com/" }],
      }),
    ).toThrow();
  });

  test("a Presented can't be constructed outside the builders", () => {
    expect(
      () =>
        new Presented(
          Symbol("presenters/reply.ts builder"),
          "reply",
          { content: "", embeds: [], components: [], allowedMentions: { parse: [] } },
          false,
        ),
    ).toThrow("Presented messages are built only by presenters/reply.ts builders.");
  });

  test("dataReply attaches exact JSON as a file and refuses a member viewer", async () => {
    const value = { balance: MAX_GIL, sequence: 41n, at: NOW, nested: { amount: -2_500_000n } };
    const presented = dataReply(VIEWERS.officer, "balance", value, NOW);
    const data = expectHouseStyle(presented, {
      tone: "neutral",
      title: "Full details · balance",
      timestamp: true,
    });
    expect(data.footer?.text).toBe("Officer view · tarubot-balance.json");
    const files = presented.options.files ?? [];
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.name).toBe("tarubot-balance.json");
    const text = Buffer.from(file?.attachment as Buffer).toString("utf8");
    expect(text).toContain('"balance": "9223372036854775807"');
    expect(text).toContain('"amount": "-2500000"');
    expect(JSON.parse(text)).toEqual({
      balance: "9223372036854775807",
      sequence: "41",
      at: NOW.toISOString(),
      nested: { amount: "-2500000" },
    });
    expect(presented.options.content).toBe("");
    // Even a tiny value is a file: the JSON is never inlined in the reply.
    expect(dataReply(VIEWERS.manager, "sync", {}).options.files).toHaveLength(1);
    let refusal: unknown;
    try {
      dataReply(VIEWERS.member, "balance", value);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Failure);
    expect(refusal).toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "officer" },
    });
    expect(() => dataReply(VIEWERS.officer, "../secret", value)).toThrow();
  });

  test("the tone palette is the approved discord.js colors", () => {
    expect(TONE_COLOR).toEqual({
      success: 0x57f287,
      pending: 0xfee75c,
      info: 0x5865f2,
      warning: 0xe67e22,
      error: 0xed4245,
      neutral: 0x99aab5,
    });
    expect(TONE_COLORS.size).toBe(6);
    expect(marker("paused")).toBe("`‖ PAUSED`");
    expect(Object.values(MARKER)).toEqual([
      "✓ DONE",
      "• SAVED",
      "… QUEUED",
      "… IN PROGRESS",
      "↻ WAITING",
      "! BLOCKED",
      "‖ PAUSED",
      "✗ FAILED",
      "= NO CHANGE",
      "– SKIPPED",
    ]);
  });

  test("the harness rejects a reply outside the house limits", () => {
    expect(() => expectHouseStyle(reply({ tone: "info", title: "x".repeat(61) }))).toThrow();
    expect(() =>
      expectHouseStyle(reply({ tone: "info", title: "Long", description: "d".repeat(1_001) })),
    ).toThrow();
    const eleven = Array.from({ length: 11 }, (_, index) => ({ name: `F${index}`, value: "v" }));
    expect(() =>
      expectHouseStyle(reply({ tone: "info", title: "Wide", fields: eleven })),
    ).toThrow();
    expectHouseStyle(reply({ tone: "info", title: "Wide", fields: eleven }), { maxFields: 15 });
    expect(() =>
      expectHouseStyle(reply({ tone: "info", title: "Ping <@123456789012345678>" })),
    ).toThrow();
    expect(visibleText(reply({ tone: "info", title: "T", buttons: [editProfileButton()] }))).toBe(
      "\nT\nEdit Character Profile",
    );
  });
});

describe("controls", () => {
  test("every control's custom ID comes from the codec and parses back", () => {
    const buttons: ButtonSpec[] = [
      verifyButton("claim", CHARACTER.id),
      verifyButton("again", CHARACTER.id),
      viewHistoryButton("c", FC.id),
      detailsButton({ action: "balance", scope: "h", fcId: FC.id }),
      detailsButton({ action: "history", scope: "c", fcId: FC.id, before: 34n }),
      detailsButton({ action: "sync", run: null }),
      detailsButton({ action: "guest", userId: "234567890123456789" }),
      detailsButton({ action: "characters", userId: "234567890123456789" }),
      detailsButton({ action: "config" }),
      recheckButton("Run health check"),
      syncStatusButton(stress.uuid),
    ];
    for (const button of buttons) {
      if (button.style === "link") throw new Error("Expected an action button");
      expect(() => parseControl(button.customId)).not.toThrow();
    }
    expect(buttons.map((button) => button.label)).toEqual([
      "I've added it — verify now",
      "Check again",
      "View history",
      "Full details (JSON)",
      "Full details (JSON)",
      "Full details (JSON)",
      "Full details (JSON)",
      "Full details (JSON)",
      "Full details (JSON)",
      "Run health check",
      "Check sync status",
    ]);
    expect(verifyButton("claim", CHARACTER.id)).toMatchObject({
      style: "primary",
      customId: "verify:claim:12345678",
    });
    expect(verifyButton("again", CHARACTER.id)).toMatchObject({
      style: "secondary",
      customId: "verify:again:12345678",
    });
    expect(lodestoneProfileButton(CHARACTER.id)).toEqual({
      style: "link",
      label: "Open Lodestone profile",
      url: "https://na.finalfantasyxiv.com/lodestone/character/12345678/",
    });
    expect(syncStatusButton()).toMatchObject({ customId: "sync:status" });
    expect(recheckButton("Re-check")).toMatchObject({ customId: "config:validate" });
  });

  test("the pager enables Newer and Latest whenever a newer entry exists", () => {
    // Page 1 (as approved ledger#21): Newer disabled, Latest hidden, Older enabled.
    expect(ledgerPager({ scope: "c", fcId: FC.id, above: 0, newer: null, older: 33n })).toEqual([
      { style: "secondary", label: "Newer", disabled: true, customId: `ledger:newer:c:${FC.id}` },
      {
        style: "secondary",
        label: "Older",
        disabled: false,
        customId: `ledger:older:c:${FC.id}:33`,
      },
    ]);
    // A typed cursor that isn't a multiple of ten: 9 newer entries, the next newer page is the
    // newest one, and the oldest page is reached (Older disabled). Latest follows Older, as
    // approved in ledger#21 and #23.
    const middle = ledgerPager({ scope: "h", fcId: FC.id, above: 9, newer: "latest", older: null });
    expect(middle.map((button) => [button.label, "disabled" in button && button.disabled])).toEqual(
      [
        ["Newer", false],
        ["Older", true],
        ["Latest", false],
      ],
    );
    expect(middle.map((button) => ("customId" in button ? button.customId : ""))).toEqual([
      `ledger:newer:h:${FC.id}`,
      `ledger:older:h:${FC.id}`,
      `ledger:latest:h:${FC.id}`,
    ]);
    // Past the newest entry's range: an empty page still offers Latest and Newer.
    const past = ledgerPager({ scope: "c", fcId: FC.id, above: 43, newer: 44n, older: null });
    expect(past.map((button) => button.label)).toEqual(["Newer", "Older", "Latest"]);
    expect(past[0]).toMatchObject({ disabled: false, customId: `ledger:newer:c:${FC.id}:44` });
    // IDs stay unique inside one message, so the reply builder accepts them.
    for (const buttons of [middle, past])
      expectHouseStyle(reply({ tone: "info", title: "Ledger history · Example", buttons }));
  });
});

describe("audiences and labels", () => {
  test("audienceOf mirrors the authorization policy", () => {
    expect(audienceOf(ACTORS.member)).toBe("member");
    // An officer by rank or override, even holding Manage Roles, can't change officer authority.
    expect(audienceOf(ACTORS.officer)).toBe("officer");
    expect(audienceOf(actorOf({ ...ACTORS.officer, officer: true, manageRoles: true }))).toBe(
      "officer",
    );
    // Manage Server without Manage Roles is no manager: an officer through the Officer role, and
    // otherwise a member (Q2 A, 2.44.0; in 2.43.0 Manage Server alone made an officer).
    expect(audienceOf(actorOf({ ...ACTORS.manager, officer: true, manageRoles: false }))).toBe(
      "officer",
    );
    expect(audienceOf(actorOf({ ...ACTORS.manager, manageRoles: false }))).toBe("member");
    expect(audienceOf(ACTORS.manager)).toBe("manager");
    // The audience follows the resolved access, never the Discord flags beside it: without the
    // serverManager flag nobody is a manager (2.43.0 fell back to the removed officer flag).
    expect(
      audienceOf(actorOf({ guildId: "1", userId: "2", officer: true, manageRoles: true })),
    ).toBe("officer");
    expect(audienceOf({ ...ACTORS.member, serverManager: true, manageRoles: true })).toBe("member");
    expect(viewerOf(ACTORS.manager, REF)).toEqual({
      audience: "manager",
      userId: ACTORS.manager.userId,
      guildId: ACTORS.manager.guildId,
      ref: REF,
      manageGuild: true,
      manageRoles: true,
    });
    expect([VIEWERS.member, VIEWERS.officer, VIEWERS.manager].map(isOfficer)).toEqual([
      false,
      true,
      true,
    ]);
  });

  test("provenance and application states use each audience's approved words", () => {
    expect(linkProvenance("profile_token", VIEWERS.member)).toBe("Verified with a Lodestone token");
    expect(linkProvenance("officer_assignment", VIEWERS.member)).toBe("Assigned by an officer");
    expect(linkProvenance("imported_link", VIEWERS.member)).toBe("Imported from the previous bot");
    expect(linkProvenance("profile_token", VIEWERS.officer)).toBe("Lodestone token");
    expect(linkProvenance("officer_assignment", VIEWERS.manager)).toBe("Officer assignment");
    expect(linkProvenance("imported_link", VIEWERS.officer)).toBe("Imported link");
    expect(grantProvenance("grandfathered")).toBe("Granted at launch");
    expect(grantProvenance("approved")).toBe("Application approved");
    expect(grantProvenance("manual")).toBe("Granted by an officer");
    expect(grantProvenance("imported_guest")).toBe("Imported from the previous bot");
    expect(applicationState("superseded")).toBe("No longer needed");
    expect(applicationState("pending")).toBe("Pending");
    // A value from a newer release shows raw rather than failing.
    expect(grantProvenance("future_kind")).toBe("future_kind");
    expect(linkProvenance("toString", VIEWERS.member)).toBe("toString");
  });
});

/** The officer details reply, run through the catalog harness as group catalogs will be. */
const PRIMITIVE_CASES = {
  details: {
    spec: null,
    audience: "officer",
    tone: "neutral",
    title: "Full details · history",
    timestamp: true,
    render: () => dataReply(VIEWERS.officer, "history", { entries: [], total: 0 }, NOW),
  },
} as const satisfies ReplyCatalog<"details">;

catalogTests("primitive", PRIMITIVE_CASES);
