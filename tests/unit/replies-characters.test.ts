/**
 * Character replies: every catalog state follows the house style; the approved cards (characters#0,
 * #9, #18, #20, #26 and #29) are reproduced exactly; the /claim token lives only in the copyable
 * content; receipts branch on effects mode and roster freshness; /characters shows officer detail
 * only to an officer who named a member; user text is escaped and capped; and the character
 * failures render as their approved concepts, with the current owner shown only to officers on
 * /assign (owner decision O3).
 */
import { describe, expect, test } from "bun:test";
import type { CharacterRow, EffectsMode } from "../../src/application/results.js";
import {
  assignReply,
  CHARACTER_REPLY_KINDS,
  characterChoice,
  charactersReply,
  claimReply,
  MAX_LISTED_CHARACTERS,
  preferencesReply,
  unlinkReply,
  verifyReply,
} from "../../src/discord/presenters/characters.js";
import { failureReply, rendersInPlace } from "../../src/discord/presenters/failure.js";
import type { Viewer } from "../../src/discord/presenters/audience.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import { userId } from "../../src/discord/selectors.js";
import type { FailureCode, FailureDetail } from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";
import { embedLength } from "discord.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import {
  CHARACTER_CASES,
  CHARACTER_RESULTS as R,
  LINK_ID,
  linkRow,
  TARGET_ID,
  TOKEN,
} from "../fixtures/replies/characters.js";
import { catalogTests } from "../fixtures/replies/index.js";
import {
  at,
  CHARACTER,
  GUEST_ID,
  MEMBER_ID,
  NOW,
  REF,
  roster,
  VIEWERS,
} from "../fixtures/results.js";

catalogTests("characters", CHARACTER_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof CHARACTER_CASES) => onlyEmbed(CHARACTER_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** The approved cards' timestamp: every <t:…> and the embed stamp render against NOW. */
const STAMP = NOW.toISOString();
/**
 * A 100-character name for titles and field names, with the markdown characters a title must
 * escape. Lodestone names hold only letters, apostrophes and hyphens, so hostile markup (mentions,
 * links) is exercised in body text instead.
 */
const LONG_NAME = "Aa'Bb-Cc_*".repeat(10);

test("the catalog covers every character reply kind", () => {
  expect(Object.keys(CHARACTER_CASES).sort()).toEqual([...CHARACTER_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("characters#0: the claim card, with the token above it and three buttons", () => {
    const presented = CHARACTER_CASES["claim.pending"].render();
    expect(presented.options.content).toBe(`\`\`\`\n${TOKEN}\n\`\`\``);
    expect(onlyEmbed(presented)).toEqual({
      color: 0xfee75c,
      title: "Verify Example Character @ Diabolos",
      description:
        "Prove this character is yours by adding a one-time token to its Lodestone biography.\n\n**1.** Copy the token shown above this card.\n**2.** Paste it anywhere in the character's **Character Profile** on the Lodestone, then save.\n**3.** Run `/verify character:12345678`.\n\nThe Lodestone can take several minutes to publish changes. Your roles and nickname don't change until verification succeeds.",
      fields: [
        {
          name: "Character",
          value:
            "[Example Character](https://na.finalfantasyxiv.com/lodestone/character/12345678/) · Diabolos",
          inline: true,
        },
        {
          name: "Token expires",
          value: "<t:1790123400:R> (<t:1790123400:t>)",
          inline: true,
        },
        {
          name: "Good to know",
          value:
            "The token only works for you, in this server, for this character. Running `/claim` again for this character replaces the token.",
        },
      ],
      footer: { text: "You can delete the token from your biography once you're verified." },
    });
    expect(buttonsOf(presented)).toEqual([
      {
        type: 2,
        style: 5,
        label: "Open Lodestone profile",
        url: "https://na.finalfantasyxiv.com/lodestone/character/12345678/",
      },
      {
        type: 2,
        style: 5,
        label: "Edit Character Profile",
        url: "https://na.finalfantasyxiv.com/lodestone/my/setting/profile/",
      },
      {
        type: 2,
        style: 1,
        label: "I've added it — verify now",
        custom_id: "verify:claim:12345678",
        disabled: false,
      },
    ]);
  });

  test("characters#9: verified, first link, fresh roster", () => {
    expect(embedOf("verify.verified")).toEqual({
      color: 0x57f287,
      title: "Example Character is verified",
      description:
        "The Lodestone shows your token, so **Example Character @ Diabolos** is now linked to your Discord account in this server. You can remove the token from your biography.",
      fields: [
        {
          name: "Main character",
          value: "Set as your main because it's your first linked character.",
          inline: true,
        },
        {
          name: "Nickname",
          value:
            "Changes to **Example Character** shortly. Turn this off with `/nickname enabled:false`.",
          inline: true,
        },
        { name: "Server roles", value: "Updating shortly, based on the Free Company roster." },
      ],
      footer: { text: "Track updates with /sync status" },
      timestamp: STAMP,
    });
  });

  test("characters#18: the member's own list", () => {
    expect(embedOf("characters.self")).toEqual({
      color: 0x5865f2,
      title: "Your characters",
      description:
        "2 characters are linked to your Discord account in this server. Your main sets your server nickname.",
      fields: [
        {
          name: "Example Character @ Diabolos · Main",
          value:
            "[Lodestone profile](https://na.finalfantasyxiv.com/lodestone/character/12345678/)\nVerified with a Lodestone token · linked <t:1787270400:R>",
        },
        {
          name: "Example Alt @ Diabolos",
          value:
            "[Lodestone profile](https://na.finalfantasyxiv.com/lodestone/character/23456789/)\nAssigned by an officer · linked <t:1789000000:R>",
        },
        { name: "Nickname sync", value: "On. Your nickname follows your main.", inline: true },
        {
          name: "Previously linked",
          value: "Example Old Character @ Diabolos, linked <t:1780000000:D>",
        },
      ],
      footer: { text: "Switch main: /main · Remove: /unclaim · Add: /claim" },
    });
    expect(buttonsOf(CHARACTER_CASES["characters.self"].render())).toEqual([]);
  });

  test("characters#20: the officer list, plus Full details (the style guide's JSON list)", () => {
    const presented = CHARACTER_CASES["characters.officer"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x5865f2,
      title: "Linked characters",
      description: `Member: <@${TARGET_ID}> (\`${TARGET_ID}\`)\n2 active · 1 previous`,
      fields: [
        {
          name: "Example Character @ Diabolos · Main",
          value: `[Lodestone](https://na.finalfantasyxiv.com/lodestone/character/12345678/) · ID \`12345678\`\nOfficer assignment · <t:1787270400:f>\nLink \`${LINK_ID}\``,
        },
        {
          name: "Example Alt @ Diabolos",
          value:
            "[Lodestone](https://na.finalfantasyxiv.com/lodestone/character/23456789/) · ID `23456789`\nLodestone token · <t:1789000000:f>\nLink `8a1b2c3d-4e5f-4a6b-9c7d-0e1f2a3b4c5d`",
        },
        { name: "Nickname sync", value: "Paused (manual nickname detected)", inline: true },
        {
          name: "Previously linked",
          value:
            "Example Old Character @ Diabolos (`34567890`), linked <t:1780000000:D>, link `5d4c3b2a-1f0e-4d9c-8b7a-6e5f4d3c2b1a`",
        },
      ],
      footer: { text: "Officer view · Assign: /assign · Remove: /unassign" },
    });
    expect(buttonsOf(presented)).toMatchObject([
      { label: "Full details (JSON)", custom_id: `details:characters:${TARGET_ID}` },
    ]);
  });

  test("characters#26: nickname sync on", () => {
    expect(embedOf("nickname.on")).toEqual({
      color: 0x57f287,
      title: "Nickname sync on",
      description:
        "Your server nickname will follow your main, **Example Character**. If you change your nickname yourself later, sync pauses automatically.",
      footer: { text: "Turn off anytime with /nickname enabled:false" },
      timestamp: STAMP,
    });
  });

  test("characters#29: the officer assignment receipt", () => {
    expect(embedOf("assign.assigned")).toEqual({
      color: 0x57f287,
      title: "Character assigned",
      description: `**Example Character @ Diabolos** is now linked to <@${TARGET_ID}>.`,
      fields: [
        { name: "Member", value: `<@${TARGET_ID}>\n\`${TARGET_ID}\``, inline: true },
        {
          name: "Character",
          value:
            "[Example Character](https://na.finalfantasyxiv.com/lodestone/character/12345678/) · Diabolos\n`12345678`",
          inline: true,
        },
        { name: "Reason", value: "Confirmed in-game with the member." },
        {
          name: "Effects",
          value: "Role and nickname update queued for this member. Track it with `/sync status`.",
        },
      ],
      footer: { text: `Link ${LINK_ID} · Recorded in the audit log` },
      timestamp: STAMP,
    });
  });
});

describe("/claim", () => {
  test("the token appears only in the copyable content; the challenge and instructions never", () => {
    const presented = CHARACTER_CASES["claim.pending"].render();
    expect(JSON.stringify(presented.options.embeds)).not.toContain(TOKEN);
    expect(JSON.stringify(presented.options.components)).not.toContain(TOKEN);
    expect(visibleText(presented)).not.toContain(R.claimPending.challenge);
    expect(visibleText(presented)).not.toContain(R.claimPending.instructions);
    const verifyNow = buttonsOf(presented).find((button) => "custom_id" in button);
    expect(verifyNow && "custom_id" in verifyNow && verifyNow.custom_id.length).toBeLessThanOrEqual(
      DISCORD_LIMITS.customId,
    );
  });

  test("a maximal ID and long name stay within the limits and escape the name", () => {
    const presented = claimReply(
      { ...R.claimPending, character: stress.id, name: LONG_NAME, world: LONG_NAME },
      VIEWERS.member,
    );
    const embed = expectHouseStyle(presented, { tone: "pending", timestamp: false });
    expect(embed.title?.length).toBeLessThanOrEqual(HOUSE_LIMITS.title);
    expect(embed.title).toStartWith("Verify Aa'Bb-Cc\\_\\*");
    expect(embed.title).toEndWith("…");
    expect(buttonsOf(presented).at(-1)).toMatchObject({ custom_id: `verify:claim:${stress.id}` });
    // A hostile world only reaches body text, where mentions and links are escaped.
    const hostile = onlyEmbed(
      claimReply({ ...R.claimPending, world: stress.text(80) }, VIEWERS.member),
    );
    expect(hostile.fields?.[0]?.value).not.toMatch(/(?<!\\)<@123456789012345678>/u);
  });

  test("an existing link of the caller's own says when the re-check runs, per effects mode", () => {
    const description = (effectsMode: EffectsMode) =>
      onlyEmbed(claimReply({ ...R.claimLinked, effectsMode }, VIEWERS.member)).description;
    expect(description("live")).toContain("TaruBot has queued a fresh check");
    expect(description("awaiting_activation")).toContain(
      "TaruBot will check your roles and nickname once this server is activated.",
    );
    expect(description("deployment_disabled")).toContain("once Discord changes are turned back on");
  });
});

describe("/verify", () => {
  test("a link that isn't the first leaves the main unchanged and has no Nickname field", () => {
    const embed = onlyEmbed(verifyReply({ ...R.verified, primary: false }, VIEWERS.member));
    expect(fieldOf(embed, "Main character")).toBe(
      "Unchanged. Switch with `/main character:12345678`.",
    );
    expect(fieldOf(embed, "Nickname")).toBeUndefined();
  });

  test("a re-link with no main becomes the main and keeps the sync setting (2026-09-24)", () => {
    // The officer tester in the 2.14.0 session: an officer assignment removed, then a verified re-link
    // left one active link and no main while the reply said "Unchanged".
    const relink = { ...R.verified, primary: true, firstLink: false };
    const on = onlyEmbed(verifyReply({ ...relink, nicknameSync: true }, VIEWERS.member));
    expect(fieldOf(on, "Main character")).toBe("Set as your main because you didn't have one.");
    expect(fieldOf(on, "Nickname")).toStartWith("Changes to **Example Character**");
    const off = onlyEmbed(verifyReply({ ...relink, nicknameSync: false }, VIEWERS.member));
    expect(fieldOf(off, "Nickname")).toBe(
      "Nickname sync is off. Turn it on with `/nickname enabled:true` to use this name.",
    );
  });

  test("the server owner's first link says Discord keeps their nickname, live and paused", () => {
    // The gateway always refuses the owner's nickname, so no receipt may promise that change.
    for (const effectsMode of ["live", "awaiting_activation", "deployment_disabled"] as const) {
      const presented = verifyReply({ ...R.verified, primary: true, effectsMode }, VIEWERS.member, {
        now: NOW,
        guildOwner: true,
      });
      expect(fieldOf(onlyEmbed(presented), "Nickname")).toBe(
        "Discord doesn't let bots change the server owner's nickname.",
      );
      expect(visibleText(presented)).not.toContain("Changes to");
    }
    // Everyone else is still told the nickname changes.
    const everyone = verifyReply({ ...R.verified, primary: true }, VIEWERS.member);
    expect(fieldOf(onlyEmbed(everyone), "Nickname")).toStartWith(
      "Changes to **Example Character**",
    );
    // Live, the owner's card stays the verify.verified success card, as /main's does: the owner
    // line is information, and only `/nickname enabled:true` by the owner is the warning caveat
    // card (C4 tone table).
    const owner = verifyReply(
      { ...R.verified, primary: true, effectsMode: "live" },
      VIEWERS.member,
      {
        now: NOW,
        guildOwner: true,
      },
    );
    expectHouseStyle(owner, { tone: "success", title: onlyEmbed(everyone).title ?? "" });
  });

  test("stale roster evidence adds the ↻ WAITING Member role field to the success card", () => {
    const embed = expectHouseStyle(
      verifyReply(
        { ...R.verified, roster: roster({ fresh: false, checkedAt: at(-3_180) }) },
        VIEWERS.member,
        { now: NOW },
      ),
      { tone: "success", title: "Example Character is verified" },
    );
    expect(fieldOf(embed, "Member role")).toBe(
      "`↻ WAITING` for the next roster check (last one <t:1790165820:R>)",
    );
  });

  test("without a linked FC the roles field doesn't mention a roster", () => {
    const embed = onlyEmbed(
      verifyReply(
        { ...R.verified, roster: roster({ fcLinked: false, fresh: false, checkedAt: null }) },
        VIEWERS.member,
      ),
    );
    expect(fieldOf(embed, "Server roles")).toBe("Updating shortly.");
    expect(fieldOf(embed, "Member role")).toBeUndefined();
  });

  test("paused effects give the pending paused-save card, never QUEUED or 'shortly'", () => {
    for (const effectsMode of ["awaiting_activation", "deployment_disabled"] as const)
      for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
        const presented = verifyReply({ ...R.verified, effectsMode }, viewer, { now: NOW });
        const embed = expectHouseStyle(presented, {
          tone: "pending",
          title: "Saved, Discord changes paused",
          timestamp: false,
        });
        expect(fieldOf(embed, "Saved")).toBe("`• SAVED`");
        expect(fieldOf(embed, "Discord changes")).toStartWith("`‖ PAUSED`");
        expect(visibleText(presented)).not.toMatch(/QUEUED|shortly/u);
        expect(fieldOf(embed, "Nickname")).toContain(
          effectsMode === "awaiting_activation"
            ? "once this server is activated"
            : "once Discord changes are turned back on",
        );
        // Only officers see why the changes wait.
        expect(fieldOf(embed, "Discord changes")?.includes("Why:")).toBe(
          viewer === VIEWERS.officer,
        );
      }
  });
});

describe("/unclaim and /unassign", () => {
  test("the main sentence appears only when the main was cleared; Guest only with no links left", () => {
    const fields = (primaryCleared: boolean, remainingActive: number) =>
      onlyEmbed(
        unlinkReply({ ...R.unclaimed, primaryCleared, remainingActive }, VIEWERS.member, {
          command: "unclaim",
        }),
      );
    expect(fieldOf(fields(false, 1), "Main character")).toBeUndefined();
    expect(fieldOf(fields(false, 1), "Server roles")).not.toContain("Guest");
    expect(fieldOf(fields(true, 0), "Main character")).toBe(
      "This was your main. Your previous nickname will be restored.",
    );
    expect(fieldOf(fields(true, 0), "Server roles")).toContain(
      "You have no linked characters left, so you may lose Guest access unless an officer granted it.",
    );
  });

  test("/unassign speaks in the officer voice with the audited reason capped at 300", () => {
    const presented = unlinkReply(
      { ...R.unassigned, reason: stress.text(1_000) },
      VIEWERS.officer,
      { command: "unassign", now: NOW },
    );
    const embed = expectHouseStyle(presented, { tone: "success", title: "Character unassigned" });
    expect(fieldOf(embed, "Reason")?.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    expect(fieldOf(embed, "Effects")).toStartWith("Role and nickname update queued.");
    expect(visibleText(presented)).not.toContain("your main");
  });
});

/** An active link row numbered `n`, created `n` days after the approved main. */
const numbered = (n: number, overrides: Partial<CharacterRow> = {}): CharacterRow =>
  linkRow({
    id: `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    character_id: String(40_000_000 + n),
    name: `Character ${n}`,
    created_at: new Date(1_787_270_400_000 + n * 86_400_000),
    primary_character_id: null,
    ...overrides,
  });

describe("/characters", () => {
  test("officer detail needs both an officer viewer and the member option", () => {
    const layouts: [Viewer, boolean, string][] = [
      [VIEWERS.officer, true, "Linked characters"],
      [VIEWERS.manager, true, "Linked characters"],
      [VIEWERS.officer, false, "Your characters"],
      [VIEWERS.member, true, "Your characters"],
    ];
    for (const [viewer, memberOption, title] of layouts) {
      const presented = charactersReply(R.officerList, viewer, {
        owner: viewer.userId,
        memberOption,
      });
      expect(onlyEmbed(presented).title).toBe(title);
      const officerLayout = title === "Linked characters";
      // Link UUIDs, raw IDs and the JSON button belong to the officer layout only.
      expect(visibleText(presented).includes(LINK_ID)).toBe(officerLayout);
      expect(visibleText(presented).includes("Full details (JSON)")).toBe(officerLayout);
      // Each layout uses its own approved provenance words.
      expect(visibleText(presented).includes("Officer assignment ·")).toBe(officerLayout);
      expect(visibleText(presented).includes("Assigned by an officer ·")).toBe(!officerLayout);
    }
  });

  test("the main comes first, then the oldest links; ended links newest first", () => {
    const rows = [
      numbered(3),
      numbered(1),
      numbered(2, { primary_character_id: String(40_000_002) }),
      numbered(4, { active: false, ended_at: new Date(1_788_000_000_000) }),
      numbered(5, { active: false, ended_at: new Date(1_789_000_000_000) }),
    ].map((row) => ({ ...row, primary_character_id: String(40_000_002) }));
    const embed = onlyEmbed(
      charactersReply({ characters: rows }, VIEWERS.member, {
        owner: MEMBER_ID,
        memberOption: false,
      }),
    );
    expect(embed.fields?.slice(0, 3).map((field) => field.name)).toEqual([
      "Character 2 @ Diabolos · Main",
      "Character 1 @ Diabolos",
      "Character 3 @ Diabolos",
    ]);
    expect(fieldOf(embed, "Previously linked")?.split("\n")).toEqual([
      "Character 5 @ Diabolos, linked <t:1787702400:D>",
      "Character 4 @ Diabolos, linked <t:1787616000:D>",
    ]);
  });

  test("nickname sync reads On, Paused, Off or no main, in each layout's words", () => {
    const states: [Partial<CharacterRow>, string, string][] = [
      [{}, "On. Your nickname follows your main.", "On"],
      [
        { nickname_suspended: true },
        "Paused because you changed your nickname yourself. Resume with `/nickname enabled:true`.",
        "Paused (manual nickname detected)",
      ],
      [{ nickname_enabled: false }, "Off. Turn it on with `/nickname enabled:true`.", "Off"],
      [
        { primary_character_id: null },
        "On, but no main is set. Choose one with `/main`.",
        "On (no main set)",
      ],
    ];
    for (const [overrides, self, officer] of states) {
      const result = { characters: [linkRow(overrides)] };
      const own = onlyEmbed(
        charactersReply(result, VIEWERS.member, { owner: MEMBER_ID, memberOption: false }),
      );
      const other = onlyEmbed(
        charactersReply(result, VIEWERS.officer, { owner: TARGET_ID, memberOption: true }),
      );
      expect([fieldOf(own, "Nickname sync"), fieldOf(other, "Nickname sync")]).toEqual([
        self,
        officer,
      ]);
      // The description's nickname sentence holds only while sync is on with a main.
      expect(own.description?.includes("Your main sets your server nickname.")).toBe(
        self.startsWith("On. "),
      );
    }
  });

  test("neither layout shows a profile FC: profiles are read only to verify ownership (#86)", () => {
    for (const officer of [false, true]) {
      const value = onlyEmbed(
        charactersReply({ characters: [linkRow()] }, officer ? VIEWERS.officer : VIEWERS.member, {
          owner: TARGET_ID,
          memberOption: officer,
        }),
      ).fields?.[0]?.value;
      expect(value).toBeDefined();
      expect(value).not.toContain("Profile FC");
    }
  });

  test("many links show 8 plus 'Showing 8 of N', within 10 fields and 6,000 characters", () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, index) =>
        numbered(index + 1, {
          name: LONG_NAME,
          world: LONG_NAME,
          character_id: String(stress.id).slice(0, 19 - String(index).length) + index,
        }),
      ),
      ...Array.from({ length: 9 }, (_, index) =>
        numbered(100 + index, {
          active: false,
          ended_at: at(-index * 3_600),
          name: stress.text(HOUSE_LIMITS.characterName),
          world: stress.text(40),
        }),
      ),
    ];
    for (const [viewer, memberOption, title] of [
      [VIEWERS.member, false, "Your characters"],
      [VIEWERS.officer, true, "Linked characters"],
    ] as const) {
      const presented = charactersReply({ characters: rows }, viewer, {
        owner: MEMBER_ID,
        memberOption,
      });
      const embed = expectHouseStyle(presented, { tone: "info", title, timestamp: false });
      expect(embed.fields).toHaveLength(HOUSE_LIMITS.fields);
      expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
      expect(
        embed.fields?.filter(
          (field) => !["Nickname sync", "Previously linked"].includes(field.name),
        ),
      ).toHaveLength(MAX_LISTED_CHARACTERS);
      expect(embed.description).toContain(
        memberOption ? "14 active · 9 previous · showing 8" : "Showing 8 of 14.",
      );
      expect(fieldOf(embed, "Previously linked")).toEndWith("…and 4 more");
    }
  });

  test("an empty record with history still lists the ended links", () => {
    const history = { characters: [linkRow({ active: false, ended_at: at(-60) })] };
    const own = onlyEmbed(
      charactersReply(history, VIEWERS.member, { owner: MEMBER_ID, memberOption: false }),
    );
    expect(own.title).toBe("No linked characters");
    expect(fieldOf(own, "Previously linked")).toBe(
      "Example Character @ Diabolos, linked <t:1787270400:D>",
    );
    const other = charactersReply(history, VIEWERS.officer, {
      owner: TARGET_ID,
      memberOption: true,
    });
    expect(onlyEmbed(other).description).toBe(
      `<@${TARGET_ID}> (\`${TARGET_ID}\`) has no active characters linked in this server. Link one with \`/assign\`.`,
    );
    expect(buttonsOf(other)).toHaveLength(1);
    expect(buttonsOf(CHARACTER_CASES["characters.officer_empty"].render())).toEqual([]);
  });
});

describe("/main and /nickname", () => {
  test("/main's Nickname field: on (cut to 32 graphemes), off, paused, or the owner caveat", () => {
    const nickname = (
      nickname: { enabled: boolean; suspended: boolean },
      guildOwner = false,
      name = CHARACTER.name,
    ) =>
      fieldOf(
        onlyEmbed(
          preferencesReply(
            { ...R.mainSaved, nickname, primary: { ...CHARACTER, name } },
            VIEWERS.member,
            { command: "main", guildOwner },
          ),
        ),
        "Nickname",
      );
    expect(nickname({ enabled: true, suspended: false }, false, "A".repeat(40))).toBe(
      `Changes to **${"A".repeat(32)}** shortly.`,
    );
    expect(nickname({ enabled: false, suspended: false })).toBe(
      "Nickname sync is off. Turn it on with `/nickname enabled:true` to use this name.",
    );
    expect(nickname({ enabled: true, suspended: true })).toBe(
      "Paused because you changed your nickname yourself. Resume with `/nickname enabled:true`.",
    );
    expect(nickname({ enabled: true, suspended: false }, true)).toBe(
      "Discord doesn't let bots change the server owner's nickname.",
    );
    // The owner's live /main receipt stays success: its Nickname line is information, not a
    // caveat to fix (only `/nickname enabled:true` by the owner is the warning card).
    expectHouseStyle(
      preferencesReply(
        {
          ...R.mainSaved,
          effectsMode: "live",
          nickname: { enabled: true, suspended: false },
        },
        VIEWERS.member,
        { command: "main", guildOwner: true },
      ),
      { tone: "success" },
    );
  });

  test("the server owner turning sync on gets the warning variant with the owner caveat", () => {
    const embed = embedOf("nickname.on_owner");
    expect(embed.description).toBe(embedOf("nickname.on").description);
    expect(fieldOf(embed, "Server owner")).toBe(
      "Discord doesn't allow bots to change the server owner's nickname, so this won't have a visible effect for you.",
    );
  });

  test("turning off sync TaruBot never managed is the neutral = NO CHANGE card", () => {
    const embed = embedOf("nickname.unchanged");
    expect(embed.description).toStartWith("`= NO CHANGE`");
    expect(embed.footer?.text).toBe("Turn it on with /nickname enabled:true");
  });
});

describe("/assign", () => {
  test("a delegated officer's new link carries the Officer rank field; a manager's doesn't", () => {
    expect(fieldOf(embedOf("assign.delegated"), "Officer rank")).toStartWith(
      "You assigned this as a delegated officer",
    );
    expect(fieldOf(embedOf("assign.assigned"), "Officer rank")).toBeUndefined();
    // The idempotent repeat creates no link, so the rank caveat doesn't apply.
    expect(
      fieldOf(
        onlyEmbed(
          assignReply(
            { ...R.assigned, status: "already_assigned", officerAuthority: false },
            VIEWERS.officer,
          ),
        ),
        "Officer rank",
      ),
    ).toBeUndefined();
  });

  test("a first link says it became the main; stale evidence adds ↻ WAITING", () => {
    const embed = onlyEmbed(
      assignReply(
        {
          ...R.assigned,
          primary: true,
          firstLink: true,
          nicknameSync: true,
          roster: roster({ fresh: false, checkedAt: null }),
        },
        VIEWERS.manager,
      ),
    );
    expect(fieldOf(embed, "Effects")).toContain(
      "It's their first link, so it's also their main, with nickname sync on.",
    );
    expect(fieldOf(embed, "Member role")).toBe("`↻ WAITING` for the first roster check");
  });

  test("a link for a member with no main says it became their main (2026-09-24)", () => {
    const embed = onlyEmbed(assignReply({ ...R.assigned, primary: true }, VIEWERS.manager));
    expect(fieldOf(embed, "Effects")).toContain(
      "They had no main character, so it's now their main.",
    );
    expect(fieldOf(embed, "Effects")).not.toContain("first link");
  });

  test("an escaped 1,000-character reason is capped at 300 and renders no markup", () => {
    const presented = assignReply({ ...R.assigned, reason: stress.text(1_000) }, VIEWERS.manager, {
      now: NOW,
    });
    const embed = expectHouseStyle(presented, { tone: "success", title: "Character assigned" });
    const reason = fieldOf(embed, "Reason") ?? "";
    expect(reason.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    expect(reason).toEndWith("…");
    expect(reason).not.toMatch(/(?<!\\)<@123456789012345678>/u);
    expect(reason).toContain("\\*\\*bold\\*\\*");
  });

  test("paused receipts carry the approved #26 footer and branch the re-check wording", () => {
    const paused = onlyEmbed(
      assignReply({ ...R.assigned, effectsMode: "deployment_disabled" }, VIEWERS.manager),
    );
    expect(paused.title).toBe("Saved, Discord changes paused");
    // Every paused-save card ends as errors-and-style#26 does, whichever command saved it.
    expect(paused.footer?.text).toBe("Check progress any time with /sync status");
    expect(fieldOf(paused, "Discord changes")).toBe(
      "`‖ PAUSED` Discord changes are off for this deployment\nWhy: Disabled globally (ENABLE_EFFECTS)",
    );
    const repeat = onlyEmbed(
      assignReply(
        { ...R.assigned, status: "already_assigned", effectsMode: "awaiting_activation" },
        VIEWERS.officer,
      ),
    );
    expect(repeat.title).toBe("Already linked to this member");
    expect(repeat.description).toContain("once this server is activated");
  });
});

test("character autocomplete labels stay within 100 characters and keep the ID as the value", () => {
  expect(
    characterChoice({ name: "Example Character @ Diabolos (12345678)", value: "12345678" }),
  ).toEqual({ name: "Example Character @ Diabolos (12345678)", value: "12345678" });
  const long = characterChoice({ name: `${stress.text(300)} (12345678)`, value: "12345678" });
  expect(long.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.choiceName);
  expect(long.value).toBe("12345678");
});

// ---------------------------------------------------------------------------------------------
// Failure pins: the character refusals, through the one failure presenter.

/** Render a failure as the router would for this audience and command. */
function failed(
  code: FailureCode,
  detail: FailureDetail | undefined,
  viewer: Viewer | undefined,
  scope: string,
  retryAfter = 0,
) {
  return failureReply(new Failure(code, "An approved sample message.", retryAfter, detail), {
    ref: REF,
    viewer,
    scope,
    now: NOW,
  });
}

describe("character failures", () => {
  const owned: FailureDetail = { kind: "ownership", character: CHARACTER, owner: GUEST_ID };

  test("ownership_conflict: one concept; only an officer on /assign sees the owner (O3)", () => {
    const officer = failed("ownership_conflict", owned, VIEWERS.officer, "/assign");
    const embed = expectFailure(officer, {
      code: "ownership_conflict",
      ref: REF,
      tone: "error",
      title: "Linked to another member",
    });
    expect(fieldOf(embed, "Linked to")).toBe(`<@${GUEST_ID}> (\`${GUEST_ID}\`)`);
    expect(embed.description).toContain("Remove that link with `/unassign` first");
    // Officers and managers on their own /claim, /verify or verify button get the member card
    // too: the owner reveal and the /unassign next step belong to /assign only.
    for (const [viewer, scope] of [
      [VIEWERS.member, "/claim"],
      [VIEWERS.member, "/verify"],
      [VIEWERS.member, "button verify"],
      [VIEWERS.officer, "/claim"],
      [VIEWERS.officer, "/verify"],
      [VIEWERS.officer, "button verify"],
      [VIEWERS.manager, "/claim"],
      [VIEWERS.manager, "button verify"],
      [undefined, "/assign"],
    ] as const) {
      const presented = failed("ownership_conflict", owned, viewer, scope);
      expectFailure(presented, {
        code: "ownership_conflict",
        ref: REF,
        tone: "error",
        title: "Linked to another member",
      });
      // No other user's ID, as a mention or raw, and no /assign-only next step.
      const embed = onlyEmbed(presented);
      expect(visibleText(presented)).not.toContain(GUEST_ID);
      expect(fieldOf(embed, "Linked to")).toBeUndefined();
      expect(embed.description).not.toContain("/unassign");
    }
  });

  test("pending_proof shows the approved checklist and Check again, and re-renders in place", () => {
    const error = new Failure("pending_proof", "Not yet.", 0, {
      kind: "proof",
      character: CHARACTER,
      expiresAt: at(1_200),
    });
    const presented = failureReply(error, {
      ref: REF,
      viewer: VIEWERS.member,
      scope: "/verify",
      now: NOW,
    });
    const embed = expectFailure(presented, {
      code: "pending_proof",
      ref: REF,
      tone: "pending",
      title: "Token not on the Lodestone yet",
    });
    // Approved characters#10 has no fields; /claim's card carries the token's deadline.
    expect(embed.fields ?? []).toEqual([]);
    expect(buttonsOf(presented)).toMatchObject([
      { label: "Check again", custom_id: "verify:again:12345678" },
    ]);
    expect(rendersInPlace(error)).toBe(true);
  });

  test("claim limits: own is 'Too many unfinished claims', global 'Please wait a moment'", () => {
    for (const [limit, title] of [
      ["claims_own", "Too many unfinished claims"],
      ["claims_all", "Please wait a moment"],
    ] as const) {
      const embed = expectFailure(
        failed("cooldown", { kind: "limit", limit, until: at(900) }, VIEWERS.member, "/claim"),
        { code: "cooldown", ref: REF, tone: "pending", title },
      );
      expect(fieldOf(embed, "Try again")).toBe("<t:1790169900:R> (<t:1790169900:T>)");
    }
  });

  test("the Check again throttle is a pending wait with its retry time", () => {
    const embed = expectFailure(failed("cooldown", undefined, VIEWERS.member, "button verify", 9), {
      code: "cooldown",
      ref: REF,
      tone: "pending",
      title: "Please wait a moment",
    });
    expect(fieldOf(embed, "Try again")).toBe("<t:1790169009:R> (<t:1790169009:T>)");
  });

  test("claim and token states keep their approved titles", () => {
    const cases: [FailureCode, FailureDetail | undefined, string, string][] = [
      [
        "not_found",
        { kind: "resource", resource: "challenge", id: CHARACTER.id },
        "warning",
        "No active claim for this character",
      ],
      ["expired", undefined, "warning", "Token expired during verification"],
      [
        "invalid_response",
        { kind: "resource", resource: "biography" },
        "warning",
        "Couldn't read the biography",
      ],
    ];
    for (const [code, detail, tone, title] of cases)
      expectFailure(failed(code, detail, VIEWERS.member, "/verify"), {
        code,
        ref: REF,
        tone: tone as "warning",
        title,
      });
  });

  test("missing links and members are 'Link not found' and 'Member not found'", () => {
    const link: FailureDetail = { kind: "resource", resource: "link", id: CHARACTER.id };
    const own = expectFailure(failed("not_found", link, VIEWERS.member, "/unclaim"), {
      code: "not_found",
      ref: REF,
      tone: "warning",
      title: "Link not found",
    });
    expect(fieldOf(own, "Check")).toBe("`/characters` lists your linked characters.");
    const officer = expectFailure(failed("not_found", link, VIEWERS.officer, "/unassign"), {
      code: "not_found",
      ref: REF,
      title: "Link not found",
    });
    expect(fieldOf(officer, "Check")).toBe(
      "`/characters member:` lists that member's current links.",
    );
    expectFailure(
      failed(
        "not_found",
        { kind: "resource", resource: "member", id: TARGET_ID },
        VIEWERS.officer,
        "/assign",
      ),
      { code: "not_found", ref: REF, tone: "warning", title: "Member not found" },
    );
  });

  test("'Several characters match' lists 10 profiles, then '…and N more'", () => {
    const ids = Array.from({ length: 12 }, (_, index) => String(99_000_001 + index));
    const embed = expectFailure(
      failed(
        "ambiguous",
        {
          kind: "matches",
          resource: "character",
          name: "Example Character",
          world: "Diabolos",
          ids,
        },
        VIEWERS.member,
        "/claim",
      ),
      { code: "ambiguous", ref: REF, tone: "warning", title: "Several characters match" },
    );
    const lines = fieldOf(embed, "Matches")?.split("\n") ?? [];
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(
      "`99000001` · [Lodestone profile](https://na.finalfantasyxiv.com/lodestone/character/99000001/)",
    );
    expect(lines.at(-1)).toBe("…and 2 more");
    expect(fieldOf(embed, "Example")).toBe("`/claim character:99000001`");
  });

  test("a typed name in /assign member: is 'Check your input', never a raw error", () => {
    let error: unknown;
    try {
      userId("Wrenfield");
    } catch (caught) {
      error = caught;
    }
    const embed = expectFailure(
      failureReply(error, { ref: REF, viewer: VIEWERS.officer, scope: "/assign", now: NOW }),
      { code: "input", ref: REF, tone: "warning", title: "Check your input" },
    );
    expect(fieldOf(embed, "Example")).toContain("/assign member:123456789012345678");
  });
});
