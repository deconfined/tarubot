/**
 * The failure presenter: every catalog code in every audience follows the house style and ends
 * with 'Code <code> · Ref <ref>'; the approved cards are reproduced exactly; members never see
 * diagnostics, owners or raw error text; and the no-change sentence follows each concept's
 * approved copy.
 */
import { describe, expect, test } from "bun:test";
import { ApplicationCommandOptionType, RateLimitError } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { z } from "zod";
import type { Viewer } from "../../src/discord/presenters/audience.js";
import {
  EXAMPLES,
  FAILURE_CONCEPTS,
  failureConcept,
  failureReply,
  type FailureReplyOptions,
  rendersInPlace,
} from "../../src/discord/presenters/failure.js";
import { entryRef, userId, uuid } from "../../src/discord/selectors.js";
import { FAILURE_CATEGORY, type FailureCode } from "../../src/domain/failures.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../src/domain/guest-application.js";
import { Failure, id } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  visibleText,
} from "../fixtures/replies.js";
import { catalogTests } from "../fixtures/replies/index.js";
import { discordError, FAILURE_CASES, FAILURE_SOURCES } from "../fixtures/replies/failures.js";
import { at, CHARACTER, GUEST_ID, NOW, REF, VIEWERS } from "../fixtures/results.js";

catalogTests("failure", FAILURE_CASES);

/** The viewers a failure can be rendered for, including none before the actor is resolved. */
const AUDIENCES: readonly [string, Viewer | undefined][] = [
  ["member", VIEWERS.member],
  ["officer", VIEWERS.officer],
  ["manager", VIEWERS.manager],
  ["no viewer", undefined],
];

/** Render with the mockups' clock and Ref. */
const render = (error: unknown, options: Partial<FailureReplyOptions> = {}) =>
  failureReply(error, { ref: REF, now: NOW, ...options });

/** A field's value by name, or undefined. */
const field = (error: unknown, name: string, options: Partial<FailureReplyOptions> = {}) =>
  onlyEmbed(render(error, options)).fields?.find((item) => item.name === name)?.value;

/** Text that never renders in titles, field names or footers: mentions, timestamps, links. */
const RENDERED_ONLY_IN_BODY = /<@|<#|<t:|\]\(/u;

describe("every catalog code in every audience", () => {
  const codes = Object.keys(FAILURE_CATEGORY) as FailureCode[];
  for (const code of codes)
    for (const [audience, viewer] of AUDIENCES)
      test(`${code} for ${audience}`, () => {
        const presented = render(new Failure(code, "An approved sample message."), {
          viewer,
          scope: "/ledger deposit",
        });
        const embed = expectFailure(presented, { code, ref: REF });
        expect(embed.title?.length ?? 0).toBeLessThanOrEqual(60);
        expect(embed.title ?? "").not.toMatch(RENDERED_ONLY_IN_BODY);
        expect(embed.footer?.text ?? "").not.toMatch(RENDERED_ONLY_IN_BODY);
        for (const item of embed.fields ?? []) expect(item.name).not.toMatch(RENDERED_ONLY_IN_BODY);
        // Members, and replies before the actor is known, never get officer-only fields.
        if (viewer === undefined || viewer.audience === "member")
          for (const item of embed.fields ?? [])
            expect(item.name).not.toMatch(/^(Diagnostic|Affected)/u);
      });
});

describe("the failure catalog", () => {
  test("covers every concept, and each case renders the concept it names", () => {
    const covered = new Set(Object.values(FAILURE_CASES).map((reply) => reply.concept));
    expect([...covered].sort()).toEqual([...FAILURE_CONCEPTS].sort());
    for (const reply of Object.values(FAILURE_CASES)) {
      const source = FAILURE_SOURCES.get(reply);
      if (!source) throw new Error("Missing failure source");
      expect(
        failureConcept(source.error, {
          ref: REF,
          viewer: source.audience === "any" ? undefined : VIEWERS[source.audience],
          scope: source.scope,
        }),
      ).toBe(reply.concept as (typeof FAILURE_CONCEPTS)[number]);
    }
  });

  test("every case ends with its classified code and the Ref", () => {
    for (const reply of Object.values(FAILURE_CASES))
      expect(onlyEmbed(reply.render()).footer?.text).toMatch(
        /^Code [a-z_]+ · Ref 1290000000000000001$/u,
      );
  });
});

describe("approved cards", () => {
  test("errors-and-style#1: input with the option's example", () => {
    const embed = onlyEmbed(FAILURE_CASES["input · /ledger deposit note · member"].render());
    expect(embed).toMatchObject({
      title: "Check your input",
      description: "Add a note of 1–1,000 characters. Nothing was changed.",
      fields: [
        {
          name: "Example",
          value: "`/ledger deposit amount:10005000 note:Weekly FC chest deposit`",
        },
      ],
      footer: { text: `Code input · Ref ${REF}` },
    });
  });

  test("errors-and-style#2: officers only, naming the command", () => {
    expect(onlyEmbed(FAILURE_CASES["forbidden officer · /config show · member"].render())).toEqual(
      expect.objectContaining({
        title: "Officers only",
        description: "Only FC officers can use **/config**. Nothing was changed.",
        fields: [
          {
            name: "What you can do",
            value: "If you think you should have officer access, ask a server manager.",
          },
        ],
        footer: { text: `Code forbidden · Ref ${REF}` },
      }),
    );
  });

  test("errors-and-style#6 and #7: setup for members and officers", () => {
    expect(onlyEmbed(FAILURE_CASES["setup guild · /claim · member"].render())).toMatchObject({
      title: "TaruBot isn't set up here yet",
      description:
        "An officer needs to finish setting up TaruBot in this server before **/claim** works. Nothing was changed.",
      fields: [
        { name: "What you can do", value: "Ask an officer, and try again once setup is done." },
      ],
      footer: { text: `Code setup · Ref ${REF}` },
    });
    expect(onlyEmbed(FAILURE_CASES["setup guild · /config show · officer"].render())).toMatchObject(
      {
        title: "Finish setup first",
        description:
          "This server has no TaruBot configuration yet. Start with **/config fc link** and **/config roles**, or **/setup onboarding** for lobby onboarding.",
        fields: [
          {
            // 2.35.0 (#46): the bare /setup is gone, and /setup onboarding is a dry run first.
            name: "Next step",
            value: [
              "`/config fc link fc_id:9230000000000000001` links the Free Company by its Lodestone ID or link.",
              "`/config roles member role:@Member` binds an existing role; do the same for guest, officer and leader.",
              "Or preview lobby onboarding with `/setup onboarding fc_id:9230000000000000001`; `confirm:true` creates the roles and rooms.",
            ].join("\n"),
          },
          { name: "Then check", value: "`/config validate` lists anything still missing." },
        ],
        footer: { text: `Code setup · Ref ${REF}` },
      },
    );
  });

  test("errors-and-style#10: the Lodestone rate limit with its retry time", () => {
    expect(onlyEmbed(FAILURE_CASES["rate limited · /claim · any"].render())).toMatchObject({
      title: "Please wait a moment",
      description:
        "The Lodestone is limiting requests right now. Nothing was changed. You can try again <t:1790169420:R>.",
      fields: [{ name: "Try again", value: "<t:1790169420:R> (<t:1790169420:T>)", inline: true }],
      footer: { text: `Code rate_limited · Ref ${REF}` },
    });
  });

  test("errors-and-style#17: settings changed, without repeating that nothing was saved", () => {
    expect(
      onlyEmbed(FAILURE_CASES["stale settings · /config ledger · any"].render()),
    ).toMatchObject({
      title: "Settings changed — try again",
      description:
        "Server settings changed while this was running, so nothing was saved. Run the command again.",
      footer: { text: `Code conflict · Ref ${REF}` },
    });
  });

  test("errors-and-style#24: the Lodestone outage, with the diagnostic for officers only", () => {
    const outage = FAILURE_CASES["lodestone unavailable · /claim · any"].render();
    expect(onlyEmbed(outage)).toMatchObject({
      title: "The Lodestone isn't responding",
      description:
        "TaruBot couldn't reach the Lodestone just now; it may be down for maintenance. Nothing was changed. Try again in a few minutes.",
      footer: { text: `Code unavailable · Ref ${REF}` },
    });
    expect(onlyEmbed(outage).fields ?? []).toEqual([]);
    const source = FAILURE_SOURCES.get(FAILURE_CASES["lodestone unavailable · /claim · any"]);
    expect(field(source?.error, "Diagnostic (officers only)", { viewer: VIEWERS.officer })).toBe(
      "`unavailable`: Lodestone work was cancelled or exceeded its job deadline.",
    );
    // /verify adds that the token stays valid through the outage.
    expect(
      onlyEmbed(FAILURE_CASES["lodestone unavailable · /verify · officer"].render()).description,
    ).toContain("Your token is still valid.");
  });

  test("retry-timed failures say 'Nothing was changed.' before their Try again (#10, #24, #25)", () => {
    // A stored message's own trailing 'Try again …' moves after the no-change sentence.
    expect(
      onlyEmbed(FAILURE_CASES["global claim limit · /claim · member"].render()).description,
    ).toBe("Verification is busy right now. Nothing was changed. Try again in a few minutes.");
    expect(
      onlyEmbed(FAILURE_CASES["member list · /config roles officer · manager"].render())
        .description,
    ).toBe(
      "Discord didn't return the complete member list. Nothing was changed. Try again in a minute.",
    );
    expect(
      onlyEmbed(FAILURE_CASES["join context · form submit · member"].render()).description,
    ).toBe("Discord didn't include your join details. Nothing was changed. Try again in a moment.");
  });

  test("join details say 'your' only to the member they are about", () => {
    const other = onlyEmbed(FAILURE_CASES["join context · /assign · officer"].render());
    expect(other).toMatchObject({
      title: "Couldn't read that member's join details",
      description: `Discord didn't include join details for <@${GUEST_ID}>. Nothing was changed. Try again in a moment.`,
    });
    // A detail that names no member keeps the self wording.
    const unnamed = new Failure("incomplete", "Missing join time.", 0, {
      kind: "discord",
      what: "join_context",
    });
    expect(onlyEmbed(render(unnamed, { viewer: VIEWERS.officer, scope: "/assign" })).title).toBe(
      "Couldn't read your join details",
    );
  });

  test("errors-and-style#27: something went wrong, with the reference and a ledger warning", () => {
    expect(
      onlyEmbed(FAILURE_CASES["unexpected · /ledger deposit · member"].render()),
    ).toMatchObject({
      title: "Something went wrong",
      description: "TaruBot hit an unexpected problem and didn't finish this request.",
      fields: [
        { name: "Reference", value: `\`${REF}\``, inline: true },
        { name: "What you can do", value: "Share the reference with an officer." },
        {
          name: "Before retrying",
          value:
            "If you were recording gil, check `/ledger history` first so the entry isn't recorded twice.",
        },
      ],
      footer: { text: `Code unexpected · Ref ${REF}` },
    });
    expect(
      field(new Error("boom"), "What you can do", { viewer: VIEWERS.officer, scope: "/ping" }),
    ).toBe("Find this reference in the bot logs (operation field).");
  });

  test("characters#10: the pending token's checklist, exactly as drawn, with Check again", () => {
    const presented = FAILURE_CASES["pending proof · /verify · member"].render();
    expect(onlyEmbed(presented)).toMatchObject({
      title: "Token not on the Lodestone yet",
      description: [
        "The Lodestone hasn't published the token for **Example Character** yet. This often takes a few minutes after you save.",
        "",
        "• Check that you saved the exact token from your latest `/claim`.",
        "• If you ran `/claim` more than once, only the newest token works.",
        "",
        "Then run `/verify character:12345678` again before your token expires.",
      ].join("\n"),
      footer: { text: `Code pending_proof · Ref ${REF}` },
    });
    expect(onlyEmbed(presented).fields ?? []).toEqual([]);
    expect(buttonsOf(presented)).toMatchObject([
      { label: "Check again", custom_id: "verify:again:12345678" },
    ]);
    const source = FAILURE_SOURCES.get(FAILURE_CASES["pending proof · /verify · member"]);
    expect(rendersInPlace(source?.error)).toBe(true);
    expect(rendersInPlace(new Failure("pending_proof", "No detail."))).toBe(false);
    expect(rendersInPlace(new Failure("input", "Other failures reply."))).toBe(false);
  });

  test("characters#31: the officer sees the current owner (O3); members never do", () => {
    const officer = onlyEmbed(FAILURE_CASES["ownership · /assign · officer"].render());
    expect(officer).toMatchObject({
      title: "Linked to another member",
      description:
        "**Example Character @ Diabolos** is already linked to a different member. Remove that link with `/unassign` first, then assign it again.",
      fields: [{ name: "Linked to", value: `<@${GUEST_ID}> (\`${GUEST_ID}\`)`, inline: true }],
      footer: { text: `Code ownership_conflict · Ref ${REF}` },
    });
    // Members, and officers on their own /claim or /verify, get the member card (O3).
    for (const key of [
      "ownership · /claim · member",
      "ownership · /verify · member",
      "ownership · /claim · officer",
      "ownership · /verify · officer",
    ] as const) {
      const presented = FAILURE_CASES[key].render();
      expect(visibleText(presented)).not.toContain(GUEST_ID);
      expect(onlyEmbed(presented)).toMatchObject({
        title: "Linked to another member",
        description:
          "**Example Character @ Diabolos** is already linked to another member of this server. Nothing was changed.",
        fields: [
          {
            name: "What you can do",
            value: "If this is your character, ask an officer to review the link.",
          },
        ],
      });
    }
    // Before the actor is known the wording is member-safe as well. The lead naming the
    // character proves the ownership detail reached the presenter.
    const owned = new Failure("ownership_conflict", "Linked.", 0, {
      kind: "ownership",
      character: CHARACTER,
      owner: GUEST_ID,
    });
    const preActor = render(owned, { scope: "/assign" });
    expect(visibleText(preActor)).not.toContain(GUEST_ID);
    expect(onlyEmbed(preActor).description).toBe(
      "**Example Character @ Diabolos** is already linked to another member of this server. Nothing was changed.",
    );
  });

  test("ledger#7: not enough recorded gil, with the exact amounts", () => {
    expect(
      onlyEmbed(FAILURE_CASES["insufficient funds · /ledger withdraw · officer"].render()),
    ).toMatchObject({
      title: "Not enough recorded gil",
      description:
        "Withdrawing **150,000,000 gil** would take the recorded balance below zero. Nothing was recorded.",
      fields: [
        { name: "Requested", value: "150,000,000 gil", inline: true },
        { name: "Recorded balance", value: "117,900,000 gil", inline: true },
      ],
      footer: { text: `Code insufficient_funds · Ref ${REF}` },
    });
  });

  test("guests#21: a closed submission reuses the closed card, with an officer next step", () => {
    const member = onlyEmbed(
      FAILURE_CASES["setup guest_applications · form submit · member"].render(),
    );
    expect(member).toMatchObject({
      title: "Guest applications are closed",
      description: GUEST_APPLICATIONS_CLOSED,
      fields: [{ name: "Already play FFXIV?" }],
      footer: { text: `Code setup · Ref ${REF}` },
    });
    expect(member.fields).toHaveLength(1);
    const officer = onlyEmbed(FAILURE_CASES["setup guest_role · form submit · officer"].render());
    expect(officer.fields?.map((item) => item.name)).toEqual(["Already play FFXIV?", "Next step"]);
    expect(officer.fields?.[1]?.value).toContain("/config roles guest");
  });
});

describe("audience rules", () => {
  test("blocked: officers get the affected role and how to fix it; members a reference", () => {
    const officer = onlyEmbed(
      FAILURE_CASES["blocked role · /config roles guest · officer"].render(),
    );
    expect(officer.fields?.map((item) => item.name)).toEqual(["Affected", "How to fix", "Then"]);
    expect(officer.fields?.[0]?.value).toBe("<@&223456789012345602> (`223456789012345602`)");
    const member = FAILURE_CASES["blocked channel · /ledger deposit · member"].render();
    expect(onlyEmbed(member)).toMatchObject({
      title: "Server setup issue",
      description:
        "Something in this server's Discord setup is stopping TaruBot from doing this. Nothing was changed.",
    });
    // The member never sees which channel or what permission, only that an officer can fix it.
    expect(visibleText(member)).not.toContain("323456789012345601");
    expect(visibleText(member)).not.toContain("View Channel");
  });

  test("blocked: How to fix appears only where the throw site names the remedy", () => {
    // The chosen role or channel is itself unusable: dragging TaruBot's role would not help.
    for (const key of [
      "blocked ordinary role · /config roles member · officer",
      "blocked admin role · /officer grant · manager",
      "blocked reserved channel · /setup onboarding · manager",
    ] as const) {
      const embed = onlyEmbed(FAILURE_CASES[key].render());
      expect({ key, fields: embed.fields?.map((item) => item.name) }).toEqual({
        key,
        fields: ["Affected", "Then"],
      });
    }
    // /setup overrides without Administrator on TaruBot names no role or channel (2.35.0).
    expect(
      onlyEmbed(
        FAILURE_CASES["blocked administrator · /setup overrides · manager"].render(),
      ).fields?.map((item) => item.name),
    ).toEqual(["Then"]);
    // A channel-permission refusal names the permission remedy.
    const channel = onlyEmbed(
      render(
        new Failure(
          "blocked",
          "TaruBot needs View Channel, Manage Channels and Manage Roles in <#323456789012345601>.",
          0,
          {
            kind: "resource",
            resource: "channel",
            id: "323456789012345601",
            fix: "channel_permissions",
          },
        ),
        { viewer: VIEWERS.manager, scope: "/setup onboarding" },
      ),
    );
    expect(channel.fields?.map((item) => item.name)).toEqual(["Affected", "How to fix", "Then"]);
    expect(channel.fields?.[1]?.value).toContain("give the TaruBot role the permissions");
    // A deleted or non-text channel (the gateway's refusal without a fix) gets no permissions
    // remedy: changing permissions can't bring it back.
    const unavailable = onlyEmbed(
      render(
        new Failure(
          "blocked",
          "<#323456789012345601> is unavailable: it no longer exists or isn't a text channel in this server. Choose another with /config.",
          0,
          { kind: "resource", resource: "channel", id: "323456789012345601" },
        ),
        { viewer: VIEWERS.officer, scope: "/config ledger" },
      ),
    );
    expect(unavailable.fields?.map((item) => item.name)).toEqual(["Affected", "Then"]);
    expect(unavailable.description).toContain("is unavailable");
  });

  test("error text never reaches Discord: a raw Error and a ZodError are 'Something went wrong'", () => {
    const zod = (() => {
      try {
        z.uuid().parse("secret-token-abc");
      } catch (error) {
        return error;
      }
      throw new Error("Expected a ZodError");
    })();
    for (const error of [new Error("secret token abc"), zod])
      for (const [, viewer] of AUDIENCES) {
        const presented = render(error, { viewer, scope: "/config show" });
        expect(onlyEmbed(presented).title).toBe("Something went wrong");
        expect(visibleText(presented)).not.toMatch(/secret|token abc|uuid|Invalid/iu);
        expectFailure(presented, { code: "unexpected", ref: REF, tone: "error" });
      }
    // Officers get the error class only, as the diagnostic.
    expect(field(zod, "Diagnostic (officers only)", { viewer: VIEWERS.officer })).toBe(
      "`unexpected`: ZodError",
    );
  });

  test("forbidden names the command, the subcommand of a mixed root, or the guest decision", () => {
    const refused = new Failure("forbidden", "Only FC officers can do that.", 0, {
      kind: "scope",
      scope: "officer",
    });
    const sentence = (scope: string) =>
      onlyEmbed(render(refused, { viewer: VIEWERS.member, scope })).description;
    expect(sentence("/config roles officer")).toBe(
      "Only FC officers can use **/config**. Nothing was changed.",
    );
    expect(sentence("/guest grant")).toBe(
      "Only FC officers can use **/guest grant**. Nothing was changed.",
    );
    expect(sentence("button guest")).toBe(
      "Only officers can decide guest access. Nothing was changed.",
    );
    // A refusal with its own approved wording is shown as written.
    expect(
      onlyEmbed(FAILURE_CASES["forbidden officer · /ledger withdraw · member"].render())
        .description,
    ).toBe(
      "Only officers can record withdrawals, opening balances and corrections. Members can record deposits with /ledger deposit. Nothing was changed.",
    );
  });

  test("the manager refusal names the permissions the viewer lacks", () => {
    const refused = FAILURE_SOURCES.get(
      FAILURE_CASES["forbidden manager · /config roles officer · officer"],
    )?.error;
    expect(field(refused, "Missing permission", { viewer: VIEWERS.officer })).toBe(
      "Manage Server and Manage Roles",
    );
    const holder: Viewer = { ...VIEWERS.officer, manageGuild: true };
    expect(field(refused, "Missing permission", { viewer: holder })).toBe("Manage Roles");
    const roles = FAILURE_SOURCES.get(
      FAILURE_CASES["forbidden manage_roles · /config roles member · officer"],
    )?.error;
    expect(field(roles, "Missing permission", { viewer: VIEWERS.officer })).toBe("Manage Roles");
  });

  test("/setup's channel check names Manage Channels and all three permissions", () => {
    // A manager with Manage Server and Manage Roles passes the role check, so the third
    // permission is the one /setup's channel provisioning found missing.
    const refused = new Failure(
      "forbidden",
      "Setting up onboarding needs Manage Server, Manage Roles and Manage Channels.",
      0,
      { kind: "scope", scope: "manage_channels" },
    );
    const manager: Viewer = { ...VIEWERS.officer, manageGuild: true, manageRoles: true };
    const embed = onlyEmbed(render(refused, { viewer: manager, scope: "/setup onboarding" }));
    expect(embed.title).toBe("Server managers only");
    expect(embed.fields).toEqual([
      { name: "Missing permission", value: "Manage Channels", inline: true },
      {
        name: "Who can do this",
        value: "Anyone with all three permissions, such as the server owner",
        inline: true,
      },
    ]);
    // Without Manage Server, only what the viewer is known to lack is named.
    expect(
      field(refused, "Missing permission", { viewer: VIEWERS.officer, scope: "/setup onboarding" }),
    ).toBe("Manage Server and Manage Roles");
  });

  test("a member-entry refusal (text 22) keeps text 20's How to fix (2.35.0)", () => {
    const embed = onlyEmbed(
      FAILURE_CASES["blocked member entry · /setup onboarding · manager"].render(),
    );
    expect(embed.title).toBe("Discord permissions need attention");
    expect(embed.fields?.map((item) => item.name)).toEqual(["Affected", "How to fix", "Then"]);
    expect(embed.fields?.[1]?.value).toBe(
      "Channel settings → Permissions → TaruBot (the member entry, not the role): remove the denies named above.",
    );
  });

  test("/setup overrides confirm:true names Administrator (2.35.0)", () => {
    const embed = onlyEmbed(
      FAILURE_CASES["forbidden administrator · /setup overrides · manager"].render(),
    );
    // The caller passed the server-manager check, so the title names what they lack instead.
    expect(embed).toMatchObject({
      title: "Administrator or server owner only",
      description:
        "Only someone with Administrator, or the server owner, can run /setup overrides confirm:true. Nothing was changed.",
      fields: [
        { name: "Missing permission", value: "Administrator", inline: true },
        {
          name: "Who can do this",
          value: "Anyone with Administrator, or the server owner",
          inline: true,
        },
      ],
      footer: { text: `Code forbidden · Ref ${REF}` },
    });
  });
});

describe("the no-change sentence follows each concept's approved copy", () => {
  const description = (error: unknown, options: Partial<FailureReplyOptions> = {}) =>
    onlyEmbed(render(error, options)).description ?? "";

  test("refusals say nothing was changed; ledger funds say nothing was recorded", () => {
    expect(description(new Failure("input", "Bad value."), { scope: "/claim" })).toBe(
      "Bad value. Nothing was changed.",
    );
    const funds = description(
      FAILURE_SOURCES.get(FAILURE_CASES["insufficient funds · /ledger withdraw · officer"])?.error,
      { viewer: VIEWERS.officer, scope: "/ledger withdraw" },
    );
    expect(funds).toEndWith("Nothing was recorded.");
    expect(funds).not.toContain("Nothing was changed.");
  });

  test("/setup onboarding confirm:true says what it reuses instead; its dry run and /setup overrides don't", () => {
    const text = description(new Failure("input", "Bad prefix."), {
      scope: "/setup onboarding",
      confirmed: true,
    });
    expect(text).toBe(
      "Bad prefix. Anything already created is reused when you run /setup onboarding confirm:true again.",
    );
    // The dry run (confirm absent or false) created nothing and may be the first run: it says so,
    // rather than telling the person to run confirm:true "again".
    for (const confirmed of [undefined, false])
      expect(
        description(new Failure("input", "Bad prefix."), { scope: "/setup onboarding", confirmed }),
      ).toBe("Bad prefix. Nothing was changed.");
    // Its own message already says so, and is not repeated.
    expect(
      onlyEmbed(FAILURE_CASES["stale settings · /setup onboarding · manager"].render()).description,
    ).toBe(
      "Server settings changed during setup, so nothing was saved. Run /setup onboarding confirm:true again; anything already created is reused.",
    );
    // /setup overrides creates nothing to reuse (2.35.0): its refusals take the ordinary sentence.
    expect(description(new Failure("busy", "Busy."), { scope: "/setup overrides" })).toBe(
      "Busy. Nothing was changed.",
    );
  });

  test("concepts whose approved copy has none never add it", () => {
    for (const key of [
      "forbidden human · DM · any",
      "forbidden test_guild · any",
      "setup guild · /config show · officer",
      "ownership · /assign · officer",
      "pending proof · /verify · member",
      "eligible · form submit · member",
      "unexpected · /ledger deposit · member",
      "setup guest_applications · form submit · member",
    ] as const)
      expect(onlyEmbed(FAILURE_CASES[key].render()).description).not.toMatch(
        /Nothing was (changed|recorded)/u,
      );
  });

  test("after execute returned, the request may have been saved", () => {
    const text = description(new Error("socket hang up"), {
      phase: "deliver",
      scope: "/ledger deposit",
    });
    expect(text).toBe("Your request may have been saved, but TaruBot couldn't show the result.");
    // Even a classified failure never claims nothing changed once the request ran.
    const late = render(new Failure("input", "Late."), { phase: "deliver", scope: "/claim" });
    expect(onlyEmbed(late).title).toBe("Something went wrong");
    expect(onlyEmbed(late).description).not.toContain("Nothing was changed.");
    expect(onlyEmbed(late).footer?.text).toBe(`Code input · Ref ${REF}`);
  });

  test("only ledger commands that record gil warn before retrying", () => {
    for (const scope of [
      "/ledger deposit",
      "/ledger withdraw",
      "/ledger initialize",
      "/ledger adjust",
    ])
      expect(field(new Error("x"), "Before retrying", { scope })).toBeDefined();
    for (const scope of ["/ledger balance", "/claim", "button ledger", undefined])
      expect(field(new Error("x"), "Before retrying", { scope })).toBeUndefined();
  });
});

describe("details", () => {
  test("a character search lists ten matches, then how many more", () => {
    const ids = Array.from({ length: 13 }, (_, index) => String(99000001 + index));
    const presented = render(
      new Failure("ambiguous", "Many.", 0, {
        kind: "matches",
        resource: "character",
        name: "Example Character",
        world: "Diabolos",
        ids,
      }),
      { scope: "/claim" },
    );
    expectHouseStyle(presented);
    const matches = onlyEmbed(presented).fields?.find((item) => item.name === "Matches")?.value;
    const lines = matches?.split("\n") ?? [];
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(
      "`99000001` · [Lodestone profile](https://na.finalfantasyxiv.com/lodestone/character/99000001/)",
    );
    expect(lines.at(-1)).toBe("…and 3 more");
    expect(onlyEmbed(presented).description).toBe(
      "13 characters named **Example Character** on **Diabolos** were found. Run the command again with the right one's ID or Lodestone link. Nothing was changed.",
    );
    expect(
      field(
        new Failure("ambiguous", "Many.", 0, {
          kind: "matches",
          resource: "character",
          name: "Example Character",
          ids,
        }),
        "Example",
        { scope: "/claim" },
      ),
    ).toBe("`/claim character:99000001`");
  });

  test("names from Discord and the Lodestone are escaped where they render", () => {
    const presented = render(
      new Failure("ambiguous", "Several roles.", 0, {
        kind: "matches",
        resource: "role",
        name: "**Officer** <@&1>",
        ids: ["223456789012345601"],
      }),
      { viewer: VIEWERS.manager, scope: "/setup onboarding" },
    );
    expect(onlyEmbed(presented).description).toStartWith(
      "Several roles are named **\\*\\*Officer\\*\\* \\<@&1>**",
    );
    expectHouseStyle(presented);
  });

  test("typed names, @names, spaced IDs and mentions are 'Check your input' (DevBot 2.12.3)", () => {
    for (const typed of ["Wrenfield", "@Wrenfield", "12 34", "<@&123456789012345678>"]) {
      for (const action of [() => userId(typed), () => id(typed, "member")]) {
        let error: unknown;
        try {
          action();
        } catch (caught) {
          error = caught;
        }
        const presented = render(error, { viewer: VIEWERS.officer, scope: "/assign" });
        expect(onlyEmbed(presented).title).toBe("Check your input");
        expect(onlyEmbed(presented).fields?.[0]?.name).toBe("Example");
      }
    }
  });

  test("raw Discord errors map to blocked, not-available and upstream cards (C8)", () => {
    const title = (error: unknown, viewer?: Viewer) =>
      onlyEmbed(render(error, { viewer, scope: "/setup onboarding" })).title;
    for (const code of [50001, 50013, 10003, 10011]) {
      expect(title(discordError(code, 403), VIEWERS.manager)).toBe(
        "Discord permissions need attention",
      );
      expect(title(discordError(code, 403), VIEWERS.member)).toBe("Server setup issue");
    }
    for (const code of [10007, 10013])
      expect(title(discordError(code, 404))).toBe("Not available here");
    expect(title(discordError(0, 500))).toBe("Discord isn't responding");
    expect(title(discordError(0, 429))).toBe("Discord isn't responding");
    const limited = new RateLimitError({
      timeToReset: 1_000,
      limit: 1,
      method: "POST",
      hash: "hash",
      url: "https://discord.com/api",
      route: "/route",
      majorParameter: "major",
      global: false,
      retryAfter: 1_000,
      sublimitTimeout: 0,
      scope: "user",
    });
    expect(title(limited)).toBe("Discord isn't responding");
    // A raw error may have hit partway through /setup onboarding confirm:true, so its card only
    // promises reuse; in the dry run, which writes nothing, it promises nothing either way.
    const raw = onlyEmbed(
      render(discordError(50013, 403), {
        viewer: VIEWERS.manager,
        scope: "/setup onboarding",
        confirmed: true,
      }),
    );
    expect(raw.description).toEndWith(
      "Anything already created is reused when you run /setup onboarding confirm:true again.",
    );
    expect(
      onlyEmbed(
        render(discordError(50013, 403), { viewer: VIEWERS.manager, scope: "/setup onboarding" }),
      ).description,
    ).toBe(
      "Discord refused the change: TaruBot is missing a permission, or a role or channel it needs was deleted.",
    );
    // /setup overrides audits what it wrote; a raw error there promises nothing either way.
    expect(
      onlyEmbed(
        render(discordError(50013, 403), { viewer: VIEWERS.manager, scope: "/setup overrides" }),
      ).description,
    ).toBe(
      "Discord refused the change: TaruBot is missing a permission, or a role or channel it needs was deleted.",
    );
    expect(raw.fields?.find((item) => item.name.startsWith("Diagnostic"))?.value).toBe(
      "`blocked`: DiscordAPIError[50013]",
    );
    expect(
      onlyEmbed(render(discordError(0, 502), { viewer: VIEWERS.member, scope: "/claim" }))
        .description,
    ).toBe("Discord didn't answer TaruBot just now. Try again in a minute.");
  });

  test("time-bound refusals are pending with a Try again field from their end time", () => {
    const limit = onlyEmbed(FAILURE_CASES["claims limit · /claim · member"].render());
    expect(limit.fields).toEqual([
      { name: "Try again", value: "<t:1790169900:R> (<t:1790169900:T>)", inline: true },
    ]);
    const soon = render(new Failure("busy", "Busy.", 3), { scope: "/setup onboarding" });
    expect(onlyEmbed(soon).fields?.[0]?.value).toBe("in a few seconds");
    const until = render(
      new Failure("cooldown", "Declined recently.", 0, {
        kind: "limit",
        limit: "apply",
        until: at(90),
      }),
      { scope: "modal guest-apply" },
    );
    expect(onlyEmbed(until).fields?.[0]?.value).toBe("<t:1790169090:R> (<t:1790169090:T>)");
  });
});

describe("every option has an Example (owner decision, 2026-09-24)", () => {
  /** A registered option: its command path without the slash, and its name. */
  interface OptionRow {
    readonly path: string;
    readonly name: string;
  }
  /** Walk subcommand groups and subcommands down to the options a user types or picks. */
  const optionsOf = (
    path: string[],
    options: readonly { type: number; name: string; options?: unknown }[] | undefined,
  ): OptionRow[] =>
    (options ?? []).flatMap((option) =>
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
        ? optionsOf(
            [...path, option.name],
            option.options as readonly { type: number; name: string }[] | undefined,
          )
        : [{ path: path.join(" "), name: option.name }],
    );

  test("each command path's examples use every option it declares", async () => {
    const rows = [...(await loadCommands()).values()].flatMap((command) =>
      optionsOf([command.name], command.toJSON().options),
    );
    expect(rows.length).toBeGreaterThan(50);
    const missing = rows.filter(
      (row) => !EXAMPLES[row.path]?.some((example) => example.includes(` ${row.name}:`)),
    );
    expect(missing).toEqual([]);
    // Every example names its own command path, so a copied line can't point elsewhere; a path
    // whose only option is optional (/setup overrides, 2.35.0) may show it bare, the dry run.
    for (const [path, examples] of Object.entries(EXAMPLES))
      for (const example of examples)
        expect(example === `/${path}` || example.startsWith(`/${path} `)).toBe(true);
  });

  test("the reply-session input cards now carry their Example", () => {
    // DevBot 2.14.0: a bad /ledger adjust entry and a bad /sync status run_id had none.
    const entry = field(
      (() => {
        try {
          entryRef("abc");
        } catch (error) {
          return error;
        }
      })(),
      "Example",
      { scope: "/ledger adjust" },
    );
    expect(entry).toBe(
      "`/ledger adjust balance:10005000 note:Withdrawal #42 was 2,550,000 gil entry:42`",
    );
    const run = field(
      (() => {
        try {
          uuid("nope", "run");
        } catch (error) {
          return error;
        }
      })(),
      "Example",
      { scope: "/sync status" },
    );
    expect(run).toBe("`/sync status run_id:9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a`");
  });
});

describe("/suggest's cards (2.28.0)", () => {
  test("the membership card's steps lead to the Member or the Guest role on /suggest only", () => {
    const suggest = onlyEmbed(FAILURE_CASES["forbidden membership · /suggest · member"].render());
    expect(suggest.title).toBe("FC membership needed");
    expect(suggest.description).toBe(
      "Only members and guests of this server can suggest features. Nothing was changed.",
    );
    expect(suggest.fields?.[0]?.value).toContain("the Guest role, or the Member role");
    expect(suggest.fields?.[0]?.value).toContain("/guest grant");
    // The ledger keeps its FC-only steps.
    const ledger = onlyEmbed(
      FAILURE_CASES["forbidden membership · /ledger deposit · member"].render(),
    );
    expect(ledger.fields?.[0]?.value).toContain("in the Free Company on the Lodestone");
    expect(ledger.fields?.[0]?.value).not.toContain("Guest role");
  });

  test("an unconfirmed post asks the member to check GitHub, and blames neither upstream", () => {
    const embed = onlyEmbed(FAILURE_CASES["github unconfirmed · /suggest · member"].render());
    expect(embed.title).toBe("GitHub didn't confirm your suggestion");
    expect(embed.description).toBe(
      "TaruBot couldn't get an answer from GitHub, so your suggestion may or may not have been posted. Check TaruBot's GitHub issues before sending it again. This try counts toward your limits either way.",
    );
    expect(embed.description).not.toMatch(/Lodestone|Discord/u);
    // Members get no diagnostic; officers do.
    expect(embed.fields ?? []).toEqual([]);
    const officer = onlyEmbed(FAILURE_CASES["github unconfirmed · /suggest · officer"].render());
    expect(officer.fields?.[0]?.name).toBe("Diagnostic (officers only)");
  });

  test("GitHub's rate limit reads like /suggest's own limits", () => {
    const limit = onlyEmbed(FAILURE_CASES["suggest limit · /suggest · member"].render());
    const github = onlyEmbed(FAILURE_CASES["github rate limit · /suggest · member"].render());
    expect([limit.title, github.title]).toEqual([
      "You can suggest again later",
      "You can suggest again later",
    ]);
    expect(github.description).toBe(
      "GitHub is limiting new issues right now. Nothing was changed.",
    );
    expect(github.fields?.[0]?.name).toBe("Try again");
  });
});
