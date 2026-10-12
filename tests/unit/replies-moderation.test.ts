/**
 * Moderation replies (2.45.0): every catalog state follows the house style; the /moderate block and
 * lift receipts and the status card are pinned exactly; the paused person's view shows the feature,
 * the end and the reason and never who set the pause, whatever the row carries; reasons are
 * officer-written text and render escaped and cut; a lift that found nothing is the info
 * "= NO CHANGE" card; the largest status card fits Discord's limits without cutting anything; and
 * the refusal sentences the catalog pins are the ones the moderation service throws.
 */
import { describe, expect, test } from "bun:test";
import { Moderation } from "../../src/application/moderation.js";
import { Service } from "../../src/application/service.js";
import {
  blockReply,
  liftReply,
  MODERATION_REPLY_KINDS,
  statusReply,
} from "../../src/discord/presenters/moderation.js";
import { classifyFailure } from "../../src/domain/failures.js";
import { PAUSE_FEATURE_IDS } from "../../src/domain/moderation.js";
import type { Actor } from "../../src/domain/policy.js";
import type { PermissionId } from "../../src/domain/rbac.js";
import { Failure } from "../../src/domain/values.js";
import { expectHouseStyle, onlyEmbed, stress, visibleText } from "../fixtures/replies.js";
import { actorOf } from "../fixtures/actors.js";
import { catalogTests } from "../fixtures/replies/index.js";
import { MODERATION_REFUSALS } from "../fixtures/replies/failures.js";
import {
  ALL_MEMBER_FEATURES,
  BLOCK_REASON,
  blockResult,
  liftResult,
  MODERATION_CASES,
  officerStatus,
  ownStatus,
  PAUSED_ID,
  pause,
} from "../fixtures/replies/moderation.js";
import { GUEST_ID, GUILD_ID, OFFICER_ID, VIEWERS } from "../fixtures/results.js";

catalogTests("moderation", MODERATION_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof MODERATION_CASES) => onlyEmbed(MODERATION_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;

test("the catalog covers every moderation reply kind", () => {
  expect(Object.keys(MODERATION_CASES).sort()).toEqual([...MODERATION_REPLY_KINDS].sort());
});

describe("/moderate block receipts", () => {
  test("a timed pause names the member, the feature and the end, and tells what the member sees", () => {
    expect(embedOf("block.paused")).toMatchObject({
      title: "Use paused",
      description: `<@${PAUSED_ID}> can't use **Suggesting features (/suggest)** until <t:1790773800:f>. Their Discord roles are untouched.`,
      fields: [
        { name: "Member", value: `<@${PAUSED_ID}>\n\`${PAUSED_ID}\``, inline: true },
        { name: "Ends", value: "<t:1790773800:f> (<t:1790773800:R>)", inline: true },
        { name: "Reason", value: BLOCK_REASON },
        {
          name: "What they see",
          value:
            "The feature, when it ends and this reason. They are never told who paused them. What they already posted or opened stays.",
        },
        { name: "To lift it early", value: `\`/moderate lift member:${PAUSED_ID}\`` },
      ],
    });
  });

  test("a pause with no end says it lasts until it is lifted", () => {
    const embed = embedOf("block.forever");
    expect(embed.description).toBe(
      `<@${PAUSED_ID}> can't use **Opening mod mail cases** until the pause is lifted. Their Discord roles are untouched.`,
    );
    expect(fieldOf(embed, "Ends")).toBe("Until lifted");
  });

  test("all member features lists each one and leaves out mod mail", () => {
    const embed = embedOf("block.many");
    expect(embed.description).toStartWith(`<@${PAUSED_ID}> can't use 8 features until <t:`);
    const listed = (fieldOf(embed, "Features") ?? "").split("\n");
    expect(listed).toEqual([
      "• Linking characters (/claim and /verify)",
      "• Roster checks (/refresh)",
      "• Guest applications (/apply)",
      "• Reading the ledger",
      "• Recording ledger deposits",
      "• Picking roles on My roles",
      "• Suggesting features (/suggest)",
      "• Reporting problems (/issue)",
    ]);
    expect(ALL_MEMBER_FEATURES).toHaveLength(8);
    expect(visibleText(MODERATION_CASES["block.many"].render())).not.toContain("mod mail");
  });

  test("a feature that was already paused is listed as replaced", () => {
    expect(fieldOf(embedOf("block.replaced"), "Replaced")).toBe(
      "These were already paused; the new end and reason take their place.\n• Suggesting features (/suggest)",
    );
    expect(fieldOf(embedOf("block.paused"), "Replaced")).toBeUndefined();
  });

  test("the receipt shows no row or batch ID, and escapes the reason it echoes", () => {
    const hostile = "# **loud** <@123456789012345678> [x](https://example.org)";
    const presented = blockReply(blockResult({ reason: hostile }), VIEWERS.officer);
    const text = visibleText(presented);
    expect(text).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(fieldOf(onlyEmbed(presented), "Reason")).toBe(
      "\\# \\*\\*loud\\*\\* \\<@123456789012345678> \\[x](https://example.org)",
    );
    const long = blockReply(blockResult({ reason: "y".repeat(1_000) }), VIEWERS.officer);
    expect(fieldOf(onlyEmbed(long), "Reason")?.length).toBeLessThanOrEqual(300);
  });

  test("it is success, one embed, and never says nothing changed", () => {
    for (const kind of ["block.paused", "block.forever", "block.many", "block.replaced"] as const) {
      expect(MODERATION_CASES[kind].tone).toBe("success");
      expect(visibleText(MODERATION_CASES[kind].render())).not.toContain("Nothing was changed");
    }
  });
});

describe("/moderate lift receipts", () => {
  test("a lifted pause says the member can use the feature again", () => {
    expect(embedOf("lift.lifted")).toMatchObject({
      title: "Pause lifted",
      description: `<@${PAUSED_ID}> can use **Suggesting features (/suggest)** again.`,
      fields: [
        { name: "Member", value: `<@${PAUSED_ID}>\n\`${PAUSED_ID}\``, inline: true },
        { name: "Reason", value: "Agreed to follow the rules" },
      ],
    });
  });

  test("lifting several lists what was lifted, what wasn't paused and what a manager keeps", () => {
    const embed = embedOf("lift.many");
    expect(embed.title).toBe("Pauses lifted");
    expect(embed.description).toBe(`<@${PAUSED_ID}> can use 2 features again.`);
    expect(embed.fields?.map((field) => field.name)).toEqual([
      "Member",
      "Lifted",
      "Weren't paused",
      "Left in place",
      "Reason",
    ]);
    expect(fieldOf(embed, "Left in place")).toBe(
      "A server manager set these, so only a server manager can lift them.\n• Opening mod mail cases",
    );
  });

  test("nothing paused is the info '= NO CHANGE' card, and so is a pause only a manager can lift", () => {
    expect(embedOf("lift.none")).toMatchObject({
      title: "Nothing to lift",
      description: `\`= NO CHANGE\` <@${PAUSED_ID}> has no pause on **Suggesting features (/suggest)**, so nothing changed.`,
    });
    expect(embedOf("lift.held")).toMatchObject({
      title: "Nothing to lift",
      description: `\`= NO CHANGE\` <@${PAUSED_ID}>'s pause was set by a server manager, so only a server manager can lift it.`,
    });
    expect(fieldOf(embedOf("lift.held"), "Set by a server manager")).toBe(
      "• Opening mod mail cases",
    );
    for (const kind of ["lift.none", "lift.held"] as const) {
      expect(MODERATION_CASES[kind].tone).toBe("info");
      expect(MODERATION_CASES[kind].noOp).toBe(true);
    }
    // "All" with nothing paused at all reads the same way, without naming a feature.
    const empty = onlyEmbed(liftReply(liftResult({ lifted: [], notPaused: [] }), VIEWERS.officer));
    expect(empty.description).toBe(
      `\`= NO CHANGE\` <@${PAUSED_ID}> has nothing paused, so nothing changed.`,
    );
  });

  test("a lift never claims more than was lifted", () => {
    const text = visibleText(
      liftReply(liftResult({ lifted: ["issue.use"], notPaused: ["suggest.use"] }), VIEWERS.officer),
    );
    expect(text).toContain("can use **Reporting problems (/issue)** again");
    expect(text).not.toContain("Pauses lifted");
  });
});

describe("/moderate status", () => {
  test("a person's own pauses: the feature, the end and the reason, in the second person", () => {
    expect(embedOf("status.self")).toEqual(
      expect.objectContaining({
        title: "What's paused for you",
        description:
          "Your use of 2 features here is paused. Use **/modmail** to reach the officers.",
        fields: [
          {
            name: "Suggesting features (/suggest)",
            value: `Until <t:1790687400:f> (<t:1790687400:R>)\nReason: ${BLOCK_REASON}`,
          },
          {
            name: "Reporting problems (/issue)",
            value: "Until an officer lifts it\nReason: Reporting the same problem daily",
          },
        ],
      }),
    );
    expect(embedOf("status.self_clear")).toMatchObject({
      title: "Nothing is paused for you",
      description: "None of TaruBot's features are paused for you here.",
    });
  });

  test("a person's own view never names who set a pause, even if the row carries it", () => {
    const withIssuer = [
      pause({ by: { userId: OFFICER_ID, level: "moderator" } }),
      pause({ permission: "issue.use", by: { userId: GUEST_ID, level: "manager" } }),
    ];
    const text = visibleText(statusReply(ownStatus(withIssuer), VIEWERS.member));
    expect(text).not.toContain(OFFICER_ID);
    expect(text).not.toContain(GUEST_ID);
    expect(text).not.toMatch(/set by|server manager|officer\)/iu);
    // An officer looking at their own pauses is the same person: the same view.
    expect(visibleText(statusReply(ownStatus(withIssuer), VIEWERS.officer))).not.toContain(
      OFFICER_ID,
    );
  });

  test("/modmail is offered only where the paused person can use it, otherwise an officer in the server", () => {
    const MODMAIL = "Use **/modmail** to reach the officers.";
    const ASK = "Ask an officer in the server.";
    const description = (...permissions: PermissionId[]) =>
      onlyEmbed(
        statusReply(
          ownStatus(permissions.map((permission) => pause({ permission, until: null }))),
          VIEWERS.member,
        ),
      ).description;
    // Written out per case, not derived from the catalog. A member feature's holders have the
    // Member or Guest role, so /modmail is theirs ...
    expect(description("suggest.use")).toBe(`Your use of 1 feature here is paused. ${MODMAIL}`);
    expect(description("selfroles.use")).toContain(MODMAIL);
    expect(description("ledger.view")).toContain(MODMAIL);
    expect(description("ledger.deposit")).toContain(MODMAIL);
    expect(embedOf("status.self").description).toContain(MODMAIL);
    // ... a baseline feature is used by lobby newcomers, who hold neither role ...
    for (const baseline of [
      "characters.claim",
      "roster.refresh",
      "guests.apply",
      "issue.use",
    ] as const)
      expect(description(baseline)).toBe(`Your use of 1 feature here is paused. ${ASK}`);
    // ... and a person who can't open cases is not pointed at the command.
    expect(description("modmail.open")).toBe(`Your use of 1 feature here is paused. ${ASK}`);
    // A mixed list offers /modmail when some member feature is paused and opening cases is not.
    expect(description("guests.apply", "suggest.use")).toContain(MODMAIL);
    expect(description("suggest.use", "modmail.open")).toContain(ASK);
    expect(description("guests.apply", "issue.use")).toContain(ASK);
  });

  test("an officer sees who set each pause and at what level, and the newest ended ones", () => {
    const embed = embedOf("status.officer");
    expect(embed).toMatchObject({
      title: "Pauses for this member",
      description: `<@${PAUSED_ID}> (\`${PAUSED_ID}\`) has 2 active pauses.`,
    });
    expect(fieldOf(embed, "Suggesting features (/suggest)")).toBe(
      `Until <t:1790687400:f> (<t:1790687400:R>)\nReason: ${BLOCK_REASON}\nSet by <@${OFFICER_ID}> (officer) on <t:1790082600:d>`,
    );
    expect(fieldOf(embed, "Opening mod mail cases")).toBe(
      `Until an officer lifts it\nReason: Opening cases without a reason\nSet by <@${GUEST_ID}> (server manager) on <t:1789996200:d>`,
    );
    expect(fieldOf(embed, "Earlier")).toBe(
      [
        `**Recording ledger deposits** · lifted by <@${OFFICER_ID}> <t:1789477800:d> · Apologised and promised to be careful`,
        "**Picking roles on My roles** · ran out <t:1788441000:d>",
      ].join("\n"),
    );
  });

  test("an officer's view of someone with nothing active still lists what ended", () => {
    const embed = embedOf("status.officer_clear");
    expect(embed.title).toBe("Nothing is paused for this member");
    expect(embed.description).toBe(`<@${PAUSED_ID}> (\`${PAUSED_ID}\`) has no active pauses.`);
    expect(fieldOf(embed, "Earlier")).toBeDefined();
    const none = onlyEmbed(statusReply(officerStatus([]), VIEWERS.officer));
    expect(none.fields ?? []).toEqual([]);
  });

  test("it is read-only, so every status card is info and carries no timestamp", () => {
    for (const kind of [
      "status.self",
      "status.self_clear",
      "status.officer",
      "status.officer_clear",
    ] as const) {
      expect(MODERATION_CASES[kind].tone).toBe("info");
      expect(embedOf(kind).timestamp).toBeUndefined();
    }
  });
});

describe("limits", () => {
  /** A pause on every pausable feature, each with a hostile reason of the longest length. */
  const everyFeature = (extra: Partial<Parameters<typeof pause>[0]> = {}) =>
    PAUSE_FEATURE_IDS.map((permission) =>
      pause({ permission, reason: stress.text(1_000), ...extra }),
    );

  test("the largest officer view (nine pauses with 1,000-character reasons, 25 ended) fits whole", () => {
    const ended = Array.from({ length: 25 }, () =>
      pause({
        permission: "ledger.view",
        reason: stress.text(1_000),
        ended: { at: new Date(0), by: stress.id, reason: stress.text(1_000) },
      }),
    );
    const active = everyFeature({ by: { userId: stress.id, level: "manager" } });
    // expectHouseStyle: at most ten fields, within 6,000 characters, and nothing cut.
    const embed = expectHouseStyle(statusReply(officerStatus(active, ended), VIEWERS.officer), {
      tone: "info",
    });
    expect(embed.fields).toHaveLength(10);
    expect(fieldOf(embed, "Earlier")).toMatch(/…and \d+ more$/u);
  });

  test("the largest own view fits whole, and so do a block and a lift of every feature", () => {
    expectHouseStyle(statusReply(ownStatus(everyFeature()), VIEWERS.member), { tone: "info" });
    expectHouseStyle(
      blockReply(
        blockResult({ permissions: ALL_MEMBER_FEATURES, reason: stress.text(1_000) }),
        VIEWERS.officer,
      ),
      { tone: "success" },
    );
    expectHouseStyle(
      liftReply(
        liftResult({
          lifted: ALL_MEMBER_FEATURES,
          notPaused: ALL_MEMBER_FEATURES,
          managerSet: ALL_MEMBER_FEATURES,
          reason: stress.text(1_000),
        }),
        VIEWERS.officer,
      ),
      { tone: "success" },
    );
  });
});

describe("the refusal sentences the catalog pins are the service's own", () => {
  /** A guild actor for the moderation rules. */
  const actor = (spec: Partial<Parameters<typeof actorOf>[0]>): Actor =>
    actorOf({ guildId: GUILD_ID, userId: "400", manageRoles: false, ...spec });
  const OFFICER = actor({ officer: true });
  const MANAGER = actor({ serverManager: true, manageRoles: true });
  /** A Moderation whose Discord and database are never reached: the rules refuse first. */
  const service = (resolve: (guildId: string, userId: string) => Promise<Actor>) => {
    const app = Object.assign(Object.create(Service.prototype) as Service, {
      guild: async () => ({}),
    });
    return new Moderation(app, resolve, () => false);
  };
  const rejected = (action: Promise<unknown>) =>
    action.then(
      () => {
        throw new Error("Expected a refusal");
      },
      (error: unknown) => error,
    );
  const OTHER = "300000000000000001";

  test("pausing or lifting yourself", async () => {
    const moderation = service(async () => MANAGER);
    const paused = await rejected(
      moderation.block(MANAGER, MANAGER.userId, ["suggest.use"], "1w", "Testing"),
    );
    expect(paused).toMatchObject({
      message: MODERATION_REFUSALS.pauseSelf,
      detail: { kind: "scope", scope: "self" },
    });
    const lifted = await rejected(
      moderation.lift(OFFICER, OFFICER.userId, ["suggest.use"], "Testing"),
    );
    expect(lifted).toMatchObject({
      message: MODERATION_REFUSALS.liftSelf,
      detail: { kind: "scope", scope: "self" },
    });
  });

  test("pausing mod mail, a server manager, someone with officer permissions, or a bot", async () => {
    const protectedScope = { kind: "scope", scope: "protected" };
    expect(
      await rejected(
        service(async () => MANAGER).block(OFFICER, OTHER, ["modmail.open"], "1w", "Testing"),
      ),
    ).toMatchObject({ message: MODERATION_REFUSALS.mail, detail: protectedScope });
    expect(
      await rejected(
        service(async () => MANAGER).block(OFFICER, OTHER, ["suggest.use"], "1w", "Testing"),
      ),
    ).toMatchObject({ message: MODERATION_REFUSALS.manager, detail: protectedScope });
    expect(
      await rejected(
        service(async () => actor({ officer: true, userId: OTHER })).block(
          OFFICER,
          OTHER,
          ["suggest.use"],
          "1w",
          "Testing",
        ),
      ),
    ).toMatchObject({ message: MODERATION_REFUSALS.staff, detail: protectedScope });
    const bot = new Failure("forbidden", "Bots aren't members.", 0, {
      kind: "scope",
      scope: "human",
    });
    expect(
      await rejected(
        service(async () => {
          throw bot;
        }).block(OFFICER, OTHER, ["suggest.use"], "1w", "Testing"),
      ),
    ).toMatchObject({ message: MODERATION_REFUSALS.bot, detail: protectedScope });
  });

  test("each is a forbidden refusal the failure presenter has a card for", async () => {
    const error = await rejected(
      service(async () => MANAGER).block(OFFICER, OTHER, ["suggest.use"], "1w", "Testing"),
    );
    expect(error).toBeInstanceOf(Failure);
    expect(classifyFailure(error).category).toBe("forbidden");
  });
});
