/**
 * Guest replies: every catalog state follows the house style; the approved cards (guests#0, #7,
 * #10 and #11, with the gen.py overrides and the approved job-line component) are reproduced
 * exactly; the member headline follows the approved order and its Roles field raises the tone;
 * members never see officer-authored reasons, reviewers, IDs or diagnostics, but do see their own
 * denial reason (C6); receipts branch on all three effects modes (C5); decisions read the same from
 * the command and the review buttons; application receipts never echo answers; autocomplete labels
 * carry only a short ID (C12); and the guest failures render as their approved concepts.
 */
import { describe, expect, test } from "bun:test";
import type { AutocompleteInteraction } from "discord.js";
import { applicationKey } from "../../src/application/keys.js";
import type { EffectsMode, GuestStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import guestCommand from "../../src/commands/guests/guest.command.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import {
  applicationChoice,
  applicationReceivedReply,
  decisionReply,
  GUEST_REPLY_KINDS,
  guestActionReply,
  guestStatusReply,
} from "../../src/discord/presenters/guests.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import type { FailureCode, FailureDetail } from "../../src/domain/failures.js";
import { authorizeOwner, type Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import {
  ACTION_RESULTS as A,
  APPLICATION_ID,
  applicationRow,
  applied,
  decision,
  GUEST_CASES,
  GUEST_RESULTS as R,
  guestStatus,
} from "../fixtures/replies/guests.js";
import { catalogTests } from "../fixtures/replies/index.js";
import {
  ACTORS,
  at,
  GUEST_ID,
  job,
  MEMBER_ID,
  NOW,
  OFFICER_ID,
  REF,
  VIEWERS,
} from "../fixtures/results.js";

catalogTests("guests", GUEST_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof GUEST_CASES) => onlyEmbed(GUEST_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** The member's own view of a record, and the officer record view of it. */
const self = (status: GuestStatusView) =>
  guestStatusReply(status, VIEWERS.member, { owner: MEMBER_ID, memberOption: false, now: NOW });
const record = (status: GuestStatusView) =>
  guestStatusReply(status, VIEWERS.officer, { owner: GUEST_ID, memberOption: true, now: NOW });
/** The three effects modes every change receipt branches on (C5). */
const PAUSED_MODES: readonly EffectsMode[] = ["awaiting_activation", "deployment_disabled"];

test("the catalog covers every guest reply kind", () => {
  expect(Object.keys(GUEST_CASES).sort()).toEqual([...GUEST_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("guests#0: a member's grandfathered Guest access", () => {
    expect(embedOf("status.granted")).toEqual({
      color: 0x57f287,
      title: "Your guest access",
      description: "**Active.** You have Guest access in this server.",
      fields: [
        {
          name: "How you qualify",
          value:
            "Granted at launch: you were in the server when TaruBot took over (<t:1790121600:D>).",
        },
        { name: "Roles", value: "Up to date", inline: true },
        { name: "Application", value: "None", inline: true },
      ],
      footer: {
        text: "Guest access lasts until an officer removes it. A confirmed FC character gives Member instead.",
      },
    });
  });

  test("guests#7: the officer record, with the approved job lines and Full details", () => {
    const presented = GUEST_CASES["status.officer"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x5865f2,
      title: "Guest access · member record",
      description: "<@234567890123456789> · `234567890123456789`\n**Active:** grandfathered grant.",
      fields: [
        {
          name: "Grants (2)",
          value:
            "Granted at launch · <t:1790121600:f>\n> Grandfathered Guest at first activation\nGranted by an officer · <t:1790150400:f>\n> Rejoined after a break; vouched for by staff.",
        },
        { name: "Revocation", value: "None", inline: true },
        { name: "Former FC member", value: "No", inline: true },
        { name: "Registered character", value: "Not eligible", inline: true },
        {
          name: "Applications (1)",
          value:
            "`3f2b8c1e` Approved <t:1790078400:R> by <@345678901234567890> · [review message](https://discord.com/channels/123456789012345678/678901234567890123/789012345678901234)",
        },
        {
          // The approved errors-and-style#28 officer job line replaces the draft's plain words.
          name: "Deliveries (latest 3)",
          value: [
            "`✓ DONE` reconcile.user `4d3c2b1a` · <t:1790160000:R> · +<@&456789012345678901> −<@&567890123456789012>",
            "`✓ DONE` guest.review `5e4d3c2b` · <t:1790150460:R>",
            "`✗ FAILED` guest.dm `6f5e4d3c` · attempt 1",
            "> dm\\_blocked: The recipient has disabled DMs.",
          ].join("\n"),
        },
      ],
      footer: { text: "Officer view · Grants last until /guest revoke or /guest reset" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      {
        type: 2,
        style: 2,
        label: "Full details (JSON)",
        custom_id: `details:guest:${GUEST_ID}`,
        disabled: false,
      },
    ]);
  });

  test("guests#10: an officer grant", () => {
    expect(embedOf("grant.granted")).toEqual({
      color: 0x57f287,
      title: "Guest access granted",
      description:
        "<@234567890123456789> now has a durable Guest grant. Their roles update shortly.",
      fields: [
        { name: "Member", value: "<@234567890123456789>\n`234567890123456789`", inline: true },
        { name: "Role update", value: "Queued", inline: true },
        { name: "Reason", value: "Long-time friend of the FC; vouched for by staff." },
      ],
      footer: { text: "Audited · Check delivery with /guest status member:234567890123456789" },
    });
  });

  test("guests#11: a revocation, success like every committed removal", () => {
    expect(embedOf("revoke.revoked")).toEqual({
      color: 0x57f287,
      title: "Guest access revoked",
      description:
        "<@234567890123456789> loses Guest until an officer grants it again. Any pending guest application was cancelled.",
      fields: [
        { name: "Member", value: "<@234567890123456789>\n`234567890123456789`", inline: true },
        { name: "Role update", value: "Queued", inline: true },
        { name: "Reason", value: "Repeated disruption in public channels." },
      ],
      footer: {
        text: "Audited · Overrides approved, manual, imported and grandfathered grants · FC Member access is not affected",
      },
    });
  });
});

describe("/guest status, member view", () => {
  test("the headline follows the approved order", () => {
    const grant = { provenance: "manual", created_at: at(-600), reason: "Officer reason" };
    const revoked = [{ revoked: true, changed_at: at(-60), reason: "Officer revocation" }];
    const denied = applicationRow({ state: "denied", decided_at: at(-3_600) });
    const cases: [GuestStatusView, string, string][] = [
      // Member access wins over everything, including a revocation.
      [guestStatus({ membership: "member", revocation: revoked }), "success", "**Member access.**"],
      [guestStatus({ grants: [grant], revocation: revoked }), "warning", "**Removed.**"],
      [
        guestStatus({ grants: [grant], formerMember: [{ eligible: true }] }),
        "success",
        "**Active.** You have",
      ],
      [guestStatus({ formerMember: [{ eligible: true }] }), "success", "**Active.** You keep"],
      // Former membership gives no Guest while membership is uncertain.
      [
        guestStatus({ formerMember: [{ eligible: true }], membership: "uncertain" }),
        "pending",
        "**Being checked.**",
      ],
      [
        guestStatus({ verifiedGuestEligible: true, registered: true }),
        "success",
        "**Active.** You are",
      ],
      [
        guestStatus({ registered: true, rosterFresh: false }),
        "pending",
        "**Waiting for a roster check.**",
      ],
      [guestStatus({ membership: "uncertain" }), "pending", "**Being checked.**"],
      [guestStatus({ applications: [applicationRow()] }), "pending", "**Awaiting review.**"],
      [
        guestStatus({ applications: [denied] }),
        "warning",
        "**No guest access.** Your most recent application was not approved",
      ],
      [
        guestStatus({
          applications: [applicationRow({ state: "superseded", decided_at: at(-60) })],
        }),
        "neutral",
        "**No guest access.** Your most recent application was closed",
      ],
      [guestStatus(), "neutral", "**No guest access on record.**"],
    ];
    for (const [status, tone, headline] of cases) {
      const embed = expectHouseStyle(self(status), {
        tone: tone as never,
        title: "Your guest access",
      });
      expect(embed.description).toStartWith(headline);
    }
  });

  test("How you qualify names the first grant with its provenance label", () => {
    const cases: [string, string][] = [
      ["grandfathered", "Granted at launch: you were in the server when TaruBot took over"],
      ["approved", "Application approved: officers approved your guest application"],
      ["manual", "Granted by an officer"],
      ["imported_guest", "Imported from the previous bot: your Guest access carried over"],
      ["future_provenance", "future_provenance"],
    ];
    for (const [provenance, words] of cases) {
      const status = guestStatus({
        grants: [
          { provenance: "manual", created_at: at(-60), reason: null },
          { provenance, created_at: at(-86_400), reason: "Officer-only reason" },
        ],
      });
      expect(fieldOf(onlyEmbed(self(status)), "How you qualify")).toBe(
        `${words} (<t:${Math.floor(at(-86_400).getTime() / 1000)}:D>).`,
      );
    }
  });

  test("the Roles field follows the newest role update, and blocked or failed ones warn", () => {
    const cases: [Partial<Parameters<typeof job>[0]>, string, string][] = [
      [{ status: "succeeded" }, "Up to date", "success"],
      [{ status: "queued" }, "`… QUEUED` Role update", "success"],
      [{ status: "running" }, "`… IN PROGRESS` Role update", "success"],
      [
        { status: "queued", last_error: "busy: Locked.", due_at: at(60) },
        "`↻ WAITING` Role update (next <t:1790169060:R>)",
        "success",
      ],
      [
        { status: "blocked", last_error: "blocked: Missing Permissions" },
        "`! BLOCKED` Role update: an officer needs to fix permissions",
        "warning",
      ],
      [
        { status: "failed", last_error: "invalid_data: Bad" },
        "`✗ FAILED` Role update: stopped and won't retry, so ask an officer",
        "warning",
      ],
      // With effects live, a paused row is left over from an earlier pause: no activation is
      // promised (step 3 of the round-3 held-work fix).
      [
        { status: "disabled" },
        "`‖ PAUSED` Role update: held from an earlier pause, so ask an officer",
        "pending",
      ],
    ];
    for (const [overrides, value, tone] of cases) {
      const status = guestStatus({
        grants: [{ provenance: "manual", created_at: at(-600), reason: null }],
        // The newest role update decides; an older failure no longer matters.
        delivery: [job(overrides), job({ status: "failed", created_at: at(-9_000) })],
      });
      const embed = expectHouseStyle(self(status), { tone: tone as never });
      expect(fieldOf(embed, "Roles")).toBe(value);
    }
    // A paused update awaiting activation says so.
    const awaiting = guestStatus({
      delivery: [job({ status: "disabled" })],
      effectsMode: "awaiting_activation",
    });
    expect(fieldOf(onlyEmbed(self(awaiting)), "Roles")).toBe(
      "`‖ PAUSED` Role update: waiting for activation",
    );
    // A paused update while Discord changes are off for the deployment says so.
    const deployment = guestStatus({
      delivery: [job({ status: "disabled" })],
      effectsMode: "deployment_disabled",
    });
    expect(fieldOf(onlyEmbed(self(deployment)), "Roles")).toBe(
      "`‖ PAUSED` Role update: Discord changes are off for this deployment",
    );
    // A warning headline stays warning when its role update is only paused.
    const revoked = guestStatus({
      revocation: [{ revoked: true, changed_at: at(-60), reason: null }],
      delivery: [job({ status: "disabled" })],
    });
    expectHouseStyle(self(revoked), { tone: "warning" });
    // No role update on record: the field is left out.
    expect(fieldOf(onlyEmbed(self(guestStatus())), "Roles")).toBeUndefined();
  });

  test("members never see officer reasons, reviewers, IDs or diagnostics", () => {
    const everything = guestStatus({
      grants: [{ provenance: "manual", created_at: at(-600), reason: "SECRET-GRANT-REASON" }],
      revocation: [{ revoked: false, changed_at: at(-600), reason: "SECRET-STATE-REASON" }],
      applications: [
        applicationRow({
          state: "cancelled",
          decided_at: at(-60),
          reviewer_id: OFFICER_ID,
          reason: "SECRET-REVOCATION-REASON",
        }),
      ],
      delivery: [
        job({ status: "blocked", last_error: "blocked: SECRET-DIAGNOSTIC" }),
        job({ id: "99999999-9999-4999-8999-999999999999", kind: "guest.dm" }),
      ],
    });
    for (const status of [everything, R.revoked, R.closed, R.pending, R.denied]) {
      const text = visibleText(self(status));
      for (const secret of [
        "SECRET",
        "Repeated disruption",
        OFFICER_ID,
        "678901234567890123",
        "789012345678901234",
        "1a2b3c4d",
        "99999999",
        "reconcile.user",
      ])
        expect({ secret, shown: text.includes(secret) }).toEqual({ secret, shown: false });
    }
    // An officer reading their own record also gets the member wording.
    const own = guestStatusReply(everything, VIEWERS.officer, {
      owner: OFFICER_ID,
      memberOption: false,
      now: NOW,
    });
    expect(onlyEmbed(own).title).toBe("Your guest access");
    expect(visibleText(own)).not.toContain("SECRET-DIAGNOSTIC");
  });

  test("an applicant reads their own denial reason, capped at 300 characters (C6)", () => {
    expect(fieldOf(embedOf("status.denied"), "Reason")).toBe(
      "Please tell us a little more about how you found the Free Company.",
    );
    expect(fieldOf(embedOf("status.denied"), "Apply again")).toBe(
      "From <t:1790236800:R>, if applications are open",
    );
    const long = guestStatus({
      applications: [
        applicationRow({ state: "denied", decided_at: at(-200_000), reason: stress.text(1_000) }),
      ],
    });
    const embed = expectHouseStyle(self(long), { tone: "warning" });
    expect(fieldOf(embed, "Reason")?.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    // Once the cooldown has passed, the member may apply again now.
    expect(fieldOf(embed, "Apply again")).toBe("Now, if applications are open");
    // Without a reason, the field is left out.
    const bare = guestStatus({
      applications: [applicationRow({ state: "denied", decided_at: at(-60) })],
    });
    expect(fieldOf(onlyEmbed(self(bare)), "Reason")).toBeUndefined();
  });

  test("a pending application says when officers see it while Discord changes are paused", () => {
    expect(fieldOf(embedOf("status.pending"), "Status")).toBe("Awaiting officer review");
    expect(embedOf("status.pending").footer?.text).toBe(
      `You get a DM when officers decide, if your DMs are open · Application ${APPLICATION_ID}`,
    );
    const held = guestStatus({
      applications: [applicationRow()],
      effectsMode: "awaiting_activation",
    });
    expect(fieldOf(onlyEmbed(self(held)), "Status")).toBe(
      "Officers see it once this server is activated",
    );
  });
});

describe("/guest status, officer record", () => {
  test("only an officer who named a member gets the record view", () => {
    expect(onlyEmbed(record(R.record)).title).toBe("Guest access · member record");
    // An officer's own status without the member option is the member view.
    const own = guestStatusReply(R.record, VIEWERS.officer, {
      owner: GUEST_ID,
      memberOption: false,
      now: NOW,
    });
    expect(onlyEmbed(own).title).toBe("Your guest access");
    expect(buttonsOf(own)).toEqual([]);
    // A member naming themselves still gets the member view.
    const member = guestStatusReply(R.record, VIEWERS.member, {
      owner: MEMBER_ID,
      memberOption: true,
      now: NOW,
    });
    expect(onlyEmbed(member).title).toBe("Your guest access");
  });

  test("a blocked role update warns with a next step; a paused one is pending", () => {
    const blocked = embedOf("status.officer_attention");
    expect(blocked.description).toContain("**Role delivery needs attention.**");
    expect(fieldOf(blocked, "Next step")).toBe(
      "Run /config validate, fix the permission or role order it reports, then run /refresh.",
    );
    // A paused role update's next step follows the effects mode. With effects live the row is
    // left from an earlier pause, so the record names the /config step that re-queues it and never
    // promises an activation (the member view says "held from an earlier pause").
    const held = (effectsMode: EffectsMode) =>
      expectHouseStyle(
        record(
          guestStatus({
            grants: R.recordBlocked.grants,
            delivery: [job({ status: "disabled" })],
            effectsMode,
          }),
        ),
        { tone: "pending" },
      );
    const live = fieldOf(held("live"), "Next step");
    expect(live).toBe(
      "Held from an earlier pause; saving any setting with `/config` re-queues it.",
    );
    expect(live).not.toContain("activation");
    expect(fieldOf(held("awaiting_activation"), "Next step")).toBe(
      "Role changes start after activation. Nothing to fix.",
    );
    expect(fieldOf(held("deployment_disabled"), "Next step")).toBe(
      "Discord changes are off for this deployment. Nothing to fix here.",
    );
    // A DM the applicant's settings refused is no officer problem (approved guests#7 is info).
    expectHouseStyle(record(R.record), { tone: "info" });
  });

  test("long records list the newest five, with '…and N earlier', within the field limits", () => {
    const grants = Array.from({ length: 7 }, (_, index) => ({
      provenance: "manual",
      created_at: at(-index * 3_600),
      reason: stress.text(1_000),
    }));
    const applications = Array.from({ length: 7 }, (_, index) =>
      applicationRow({
        id: `${index}${stress.uuid.slice(1)}`,
        state: "denied",
        decided_at: at(-index * 3_600),
        reviewer_id: stress.id,
        guild_id: stress.id,
        channel_id: stress.id,
        message_id: stress.id,
      }),
    );
    const huge = guestStatus({
      grants,
      applications,
      revocation: [{ revoked: true, changed_at: at(-60), reason: stress.text(1_000) }],
      delivery: stress.jobs(10),
      membership: "uncertain",
      registered: true,
    });
    const presented = guestStatusReply(huge, VIEWERS.officer, {
      owner: stress.id,
      memberOption: true,
      now: NOW,
    });
    const embed = expectHouseStyle(presented, { tone: "warning" });
    expect(fieldOf(embed, "Grants (7)")).toStartWith("…and 2 earlier\n");
    expect(fieldOf(embed, "Grants (7)")?.match(/^> /gmu)).toHaveLength(5);
    expect(fieldOf(embed, "Applications (7)")).toEndWith("…and 2 earlier");
    expect(fieldOf(embed, "FC membership")).toBe("Being checked");
    expect(fieldOf(embed, "Deliveries (latest 3)")?.split("\n`")).toHaveLength(3);
    for (const button of buttonsOf(presented))
      if ("custom_id" in button)
        expect(button.custom_id.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);
  });
});

describe("/guest grant and revoke", () => {
  test("receipts state restoration, absence and a missing Guest role", () => {
    expect(embedOf("grant.restored").description).toBe(
      "<@234567890123456789> now has a durable Guest grant, and the earlier revocation is lifted. Their roles update shortly.",
    );
    expect(fieldOf(embedOf("grant.absent"), "Role update")).toBe("Applies when they join");
    const noRole = embedOf("grant.no_role");
    expect(fieldOf(noRole, "Role update")).toBe("Not applied: no Guest role is set");
    expect(fieldOf(noRole, "Next step")).toContain("`/config roles guest role:@Guest`");
    // A revocation with nothing to cancel doesn't mention applications.
    const quiet = guestActionReply({ ...A.revoked, cancelledApplications: 0 }, VIEWERS.officer);
    expect(onlyEmbed(quiet).description).toBe(
      "<@234567890123456789> loses Guest until an officer grants it again.",
    );
    const gone = guestActionReply({ ...A.revoked, present: false }, VIEWERS.officer);
    expect(fieldOf(onlyEmbed(gone), "Role update")).toBe("Applies if they rejoin");
  });

  test("while Discord changes are paused, grants and revocations are the paused-save card", () => {
    for (const effectsMode of PAUSED_MODES)
      for (const result of [A.granted, A.revoked]) {
        const presented = guestActionReply({ ...result, effectsMode }, VIEWERS.officer);
        const embed = expectHouseStyle(presented, {
          tone: "pending",
          title: "Saved, Discord changes paused",
        });
        expect(fieldOf(embed, "Saved")).toBe("`• SAVED`");
        expect(fieldOf(embed, "Discord changes")).toStartWith("`‖ PAUSED`");
        expect(visibleText(presented)).not.toContain("Queued");
        expect(fieldOf(embed, "Member")).toBe(`<@${GUEST_ID}>\n\`${GUEST_ID}\``);
      }
  });

  test("reasons are escaped and capped at 300 characters", () => {
    const presented = guestActionReply(
      { ...A.granted, reason: stress.text(1_000) },
      VIEWERS.officer,
    );
    const embed = expectHouseStyle(presented);
    expect(fieldOf(embed, "Reason")?.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    // User text can never render a mention: every '<@' arrives backslash-escaped.
    expect(fieldOf(embed, "Reason")).not.toMatch(/(?<!\\)<@/u);
  });
});

describe("/guest approve and deny, and the review buttons", () => {
  test("approvals and denials are success; closed and repeated decisions are info", () => {
    const cases: [Parameters<typeof decision>[0], string, string][] = [
      [{}, "success", "Application approved"],
      [{ status: "denied" }, "success", "Application denied"],
      [{ status: "cancelled" }, "info", "Application closed · applicant left"],
      [{ status: "superseded" }, "info", "Application no longer needed"],
      [{ effects: "unchanged", status: "denied" }, "info", "Already decided"],
    ];
    for (const [overrides, tone, title] of cases)
      for (const via of ["command", "button"] as const)
        expectHouseStyle(decisionReply(decision(overrides), VIEWERS.officer, { via }), {
          tone: tone as never,
          title,
        });
  });

  test("buttons answer briefly, commands name the queued work, and nothing claims delivery", () => {
    expect(embedOf("decision.button").description).toBe(
      "Recorded. The review message updates shortly.",
    );
    expect(embedOf("decision.approved").description).toBe(
      "The Guest role, the review message update and the applicant's DM are queued.",
    );
    expect(fieldOf(embedOf("decision.approved"), "Application")).toBe(`\`${APPLICATION_ID}\``);
    const button = decisionReply(decision({ status: "denied" }), VIEWERS.officer, {
      via: "button",
    });
    expect(fieldOf(onlyEmbed(button), "Application")).toBeUndefined();
    expect(fieldOf(onlyEmbed(button), "Reason sent to applicant")).toBe("No reason given");
    // Completion words belong to delivered work only; decisions have only queued it.
    for (const kind of Object.keys(GUEST_CASES) as (keyof typeof GUEST_CASES)[])
      if (kind.startsWith("decision."))
        expect(onlyEmbed(GUEST_CASES[kind].render()).description).not.toMatch(
          // 'no DM was sent' states a fact about a cancelled application, not a delivery.
          /\b(posted|updated|delivered)\b|(?<!no DM was )\bsent\b/u,
        );
  });

  test("the denial reason is labelled as sent to the applicant and capped (C6)", () => {
    expect(fieldOf(embedOf("decision.denied"), "Reason sent to applicant")).toBe(
      "Please tell us a little more about how you found the Free Company.",
    );
    expect(embedOf("decision.denied").footer?.text).toBe(
      "Audited · The applicant may reapply after 24 hours",
    );
    const long = decisionReply(
      decision({ status: "denied", reason: stress.text(1_000), cooldownSeconds: 5_400 }),
      VIEWERS.officer,
      { via: "command" },
    );
    const embed = expectHouseStyle(long);
    expect(fieldOf(embed, "Reason sent to applicant")?.length).toBeLessThanOrEqual(
      HOUSE_LIMITS.userText,
    );
    expect(embed.footer?.text).toBe("Audited · The applicant may reapply after 90 minutes");
  });

  test("a repeat names the stored outcome and who decided it", () => {
    expect(embedOf("decision.already").description).toBe(
      `This application was already **approved** <t:1790150400:R> by <@${OFFICER_ID}>. Nothing was changed.`,
    );
    const automatic = decisionReply(
      decision({ effects: "unchanged", status: "superseded", reviewerId: null, decidedAt: null }),
      VIEWERS.officer,
      { via: "command" },
    );
    expect(onlyEmbed(automatic).description).toBe(
      "This application was already **closed as no longer needed** automatically. Nothing was changed.",
    );
  });

  test("decisions saved while Discord changes are paused say the message and DM wait", () => {
    for (const effectsMode of PAUSED_MODES)
      for (const via of ["command", "button"] as const) {
        const presented = decisionReply(decision({ effectsMode }), VIEWERS.officer, { via });
        const embed = expectHouseStyle(presented, {
          tone: "pending",
          title: "Saved, Discord changes paused",
        });
        expect(embed.description).toStartWith("Application approved. ");
        expect(embed.description).toEndWith(
          "The review message update and the applicant's DM wait until then too.",
        );
        expect(visibleText(presented)).not.toContain("updates shortly");
      }
    const closed = decisionReply(
      decision({ status: "cancelled", effectsMode: "awaiting_activation" }),
      VIEWERS.officer,
      { via: "command" },
    );
    expect(onlyEmbed(closed).description).toEndWith(
      "The review message update waits until then too.",
    );
  });
});

describe("/apply receipts", () => {
  test("receipts never echo the answers, in any outcome or effects mode", () => {
    for (const outcome of ["created", "existing", "replaced"] as const)
      for (const effectsMode of ["live", ...PAUSED_MODES] as const) {
        const presented = applicationReceivedReply(
          applied({ outcome, effectsMode }),
          VIEWERS.member,
          { now: NOW },
        );
        // A new application saved while Discord changes are paused is the paused-save card
        // (errors-and-style#26) with that card's footer; the others name the application.
        const held = outcome !== "existing" && effectsMode !== "live";
        const embed = expectHouseStyle(presented, {
          tone: outcome === "existing" ? "info" : "pending",
          title:
            outcome === "existing"
              ? "Application already sent"
              : held
                ? "Saved, Discord changes paused"
                : "Application sent",
        });
        expect(visibleText(presented)).not.toContain("SECRET");
        expect(embed.footer?.text).toBe(
          held ? "Check progress any time with /sync status" : `Application ${APPLICATION_ID}`,
        );
      }
  });

  test("a replaced application says the earlier one closed; paused ones say when officers see it", () => {
    expect(embedOf("apply.replaced").description).toEndWith(
      "Your earlier application from a previous join was closed.",
    );
    expect(embedOf("apply.held").description).toBe(
      "Your guest application is saved. Officers see it once this server is activated. Submitting again keeps your original application and answers.",
    );
    // The paused-save card's own fields come first, then the receipt's next step.
    expect(embedOf("apply.held").fields?.map((field) => field.name)).toEqual([
      "Saved",
      "Discord changes",
      "What happens next",
    ]);
    const deployment = applicationReceivedReply(
      applied({ effectsMode: "deployment_disabled", outcome: "existing" }),
      VIEWERS.member,
    );
    expect(onlyEmbed(deployment).description).toBe(
      "You already applied <t:1790150400:R>. Your original answers are kept, and officers see them once Discord changes are turned back on.",
    );
  });
});

describe("application autocomplete (C12)", () => {
  const row = {
    id: APPLICATION_ID,
    user_id: GUEST_ID,
    created_at: new Date("2026-09-22T10:00:00Z"),
  };

  test("labels show a name, the submission date and a short ID; the value is the full UUID", () => {
    expect(applicationChoice(row, "Example Guest")).toEqual({
      name: "Example Guest · submitted 2026-09-22 · 3f2b8c1e",
      value: APPLICATION_ID,
    });
    expect(applicationChoice(row, null).name).toBe(`${GUEST_ID} · submitted 2026-09-22 · 3f2b8c1e`);
    const long = applicationChoice(row, stress.text(500));
    expect(long.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.choiceName);
    expect(long.name).toEndWith(" · submitted 2026-09-22 · 3f2b8c1e");
    expect(long.name).not.toContain(APPLICATION_ID);
  });

  test("the command filters the newest pending applications on what the label shows", async () => {
    const rows = [
      row,
      {
        id: "0aaaaaaa-0000-4000-8000-000000000000",
        user_id: "345678901234567899",
        created_at: at(-60),
      },
    ];
    const app: unknown = Object.create(Service.prototype);
    if (!(app instanceof Service)) throw new Error("Invalid application fixture");
    let reads = 0;
    Object.assign(app, {
      applicationChoices: async () => {
        reads += 1;
        return rows;
      },
    });
    const complete = (query: string, actor: Actor = ACTORS.officer) =>
      guestCommand.autocomplete?.({
        client: undefined as never,
        services: new Services().provide(applicationKey, app),
        allowsGuild: () => true,
        isStopping: () => false,
        report: () => {},
        resolveActor: async () => actor,
        actor,
        interaction: {
          // The application option is focused; member completion is tested separately.
          options: {
            getFocused: (full?: boolean) => (full ? { name: "application", value: query } : query),
          },
          guild: { members: { cache: new Map([[GUEST_ID, { displayName: "Example Guest" }]]) } },
        } as unknown as AutocompleteInteraction,
      });
    const values = async (query: string) =>
      ((await complete(query)) ?? []).map((choice) => choice.value);
    expect(await values("")).toEqual([APPLICATION_ID, "0aaaaaaa-0000-4000-8000-000000000000"]);
    expect(await values("example")).toEqual([APPLICATION_ID]);
    expect(await values("345678901234567899")).toEqual(["0aaaaaaa-0000-4000-8000-000000000000"]);
    expect(await values("3f2b8c1e")).toEqual([APPLICATION_ID]);
    expect(await values("nobody")).toEqual([]);
    expect((await complete(""))?.[1]?.name).toBe(
      `345678901234567899 · submitted ${at(-60).toISOString().slice(0, 10)} · 0aaaaaaa`,
    );
    // Completion is officer-only before any read.
    await expect(Promise.resolve().then(() => complete("", ACTORS.member))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(reads).toBe(6);
  });
});

describe("guest failures render as their approved concepts", () => {
  /** Render a failure for an audience from a command or component scope. */
  const refusal = (error: unknown, audience: "member" | "officer", scope: string) =>
    failureReply(error, { ref: REF, viewer: VIEWERS[audience], scope, now: NOW });
  const failure = (code: FailureCode, message: string, detail?: FailureDetail, retryAfter = 0) =>
    new Failure(code, message, retryAfter, detail);

  test("status, decision and review refusals", () => {
    let owner: unknown;
    try {
      authorizeOwner(ACTORS.member, ACTORS.member.guildId, GUEST_ID);
    } catch (error) {
      owner = error;
    }
    expectFailure(refusal(owner, "member", "/guest status"), {
      code: "forbidden",
      ref: REF,
      tone: "error",
      title: "Only your own records",
    });
    const officers = expectFailure(
      refusal(
        failure("forbidden", "Only officers can decide guest access.", {
          kind: "scope",
          scope: "officer",
        }),
        "member",
        "/guest approve",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Officers only" },
    );
    expect(officers.description).toStartWith("Only officers can decide guest access.");
    expectFailure(
      refusal(
        failure("stale", "A newer review message replaced this one.", {
          kind: "stale",
          what: "review",
        }),
        "officer",
        "button guest",
      ),
      { code: "stale", ref: REF, title: "This review message is out of date" },
    );
    expectFailure(
      refusal(
        failure("not_found", "There's no guest application with that ID in this server.", {
          kind: "resource",
          resource: "application",
          id: APPLICATION_ID,
        }),
        "officer",
        "/guest approve",
      ),
      { code: "not_found", ref: REF, title: "Application not found" },
    );
  });

  test("/apply submission refusals", () => {
    expectFailure(
      refusal(
        failure("eligible", "You already have member or guest access here."),
        "member",
        "modal guest-apply",
      ),
      { code: "eligible", ref: REF, tone: "info", title: "No application needed" },
    );
    expectFailure(
      refusal(
        failure(
          "cooldown",
          "Your last application was declined recently. You can apply again later.",
          { kind: "limit", limit: "apply", until: at(3_600) },
          3_600,
        ),
        "member",
        "modal guest-apply",
      ),
      { code: "cooldown", ref: REF, tone: "pending", title: "You can apply again later" },
    );
    expectFailure(
      refusal(
        failure("forbidden", "You need to be a current member of this server to apply.", {
          kind: "scope",
          scope: "current_member",
        }),
        "member",
        "modal guest-apply",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Not available here" },
    );
    expectFailure(
      refusal(
        failure("blocked", "TaruBot can't manage the Guest role.", {
          kind: "resource",
          resource: "role",
          id: "456789012345678901",
        }),
        "member",
        "modal guest-apply",
      ),
      { code: "blocked", ref: REF, tone: "warning", title: "Server setup issue" },
    );
  });
});
