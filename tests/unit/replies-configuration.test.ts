/**
 * Configuration replies: every catalog state follows the house style; the approved cards
 * (configuration#4, #7, #8, #9, #34, #37 and #41, with the gen.py title overrides) are reproduced
 * exactly and #18 as far as owner decision O2 allows; the health checklist's tokens, verdicts and
 * budgets; /config show's collapses and its documented field exemption (C3); every change receipt
 * and its three effects modes (C5); /setup and /officer; the changelog channel's receipts, show
 * field and checklist lines (2.25.0); TaruBot's role and Visibility sections and /config show's
 * count of them (2.35.0, #46); and the configuration failures render as their approved concepts.
 * The approved cards predate the changelog channel, which they show unset, and the #46 sections,
 * which they show healthy.
 */
import { describe, expect, test } from "bun:test";
import type { EffectsMode } from "../../src/application/results.js";
import { ON_MENU } from "../../src/application/self-roles.js";
import { fcLinked } from "../../src/application/service.js";
import {
  administratorRemoval,
  changeReply,
  CONFIG_REPLY_KINDS,
  configurationChecks,
  fcUnlinkReply,
  guestApplicationsReply,
  healthReply,
  officerOverrideReply,
  officerRankReply,
  roleLayoutReply,
  setupReply,
  showReply,
} from "../../src/discord/presenters/configuration.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import type { FailureCode, FailureDetail } from "../../src/domain/failures.js";
import { authorize, authorizeRoleManager } from "../../src/domain/policy.js";
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
  applications,
  CHANNEL,
  CONFIG_CASES,
  CONFIG_FC,
  CONFIG_RESULTS as R,
  configChange,
  configGuild,
  configReport,
  fcRow,
  layoutOn,
  override,
  rankResult,
  ROLE,
  selfRoleHealth,
  setupResult,
  unlinked,
  visibilityReport,
} from "../fixtures/replies/configuration.js";
import { catalogTests } from "../fixtures/replies/index.js";
import { ACTORS, at, GUILD_ID, NOW, REF, VIEWERS } from "../fixtures/results.js";

catalogTests("configuration", CONFIG_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof CONFIG_CASES) => onlyEmbed(CONFIG_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** Every field name of an embed, in order. */
const namesOf = (embed: ReturnType<typeof onlyEmbed>) =>
  (embed.fields ?? []).map((field) => field.name);
/** The two modes that hold Discord changes. */
const PAUSED_MODES: readonly Exclude<EffectsMode, "live">[] = [
  "awaiting_activation",
  "deployment_disabled",
];
/** The officer viewer, the audience of /config show, validate and most changes. */
const officer = VIEWERS.officer;
const manager = VIEWERS.manager;
/** Every case renders against the mockups' clock. */
const now = NOW;
/** A mention that would render: '<@' not preceded by the escaping backslash. */
const UNESCAPED_MENTION = /(?<!\\)<@/u;

test("the catalog covers every configuration reply kind", () => {
  expect(Object.keys(CONFIG_CASES).sort()).toEqual([...CONFIG_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("configuration#4: /config show for a configured, live server", () => {
    const presented = CONFIG_CASES["show.configured"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x5865f2,
      title: "Server configuration",
      description:
        "**Example Company** «EXMPL» · Diabolos\nDiscord changes **Live** · Onboarding **On** · Role layout **On**\nHealth: all 9 resource checks passed.",
      fields: [
        {
          name: "Free Company",
          value:
            "[Example Company «EXMPL»](https://na.finalfantasyxiv.com/lodestone/freecompany/9234567890123456789/) · Diabolos\nRoster read <t:1790143200:R>\nFC ID 9234567890123456789",
        },
        { name: "FC Leader role", value: "<@&223456789012345604>", inline: true },
        { name: "Officer role", value: "<@&223456789012345603>", inline: true },
        { name: "Member role", value: "<@&223456789012345601>", inline: true },
        { name: "Guest role", value: "<@&223456789012345602>", inline: true },
        {
          name: "Officer access",
          value: "In-game rank **Officer** + manual grants (/officer grant)",
        },
        { name: "Ledger channel", value: "<#323456789012345601>", inline: true },
        { name: "Officer notifications", value: "<#323456789012345602>", inline: true },
        { name: "Guest applications", value: "Open · <#323456789012345603>", inline: true },
        // 2.25.0: the changelog channel, unset until officers choose one.
        { name: "Changelog", value: "Not set", inline: true },
        {
          name: "Onboarding",
          value: "On · lobby <#323456789012345604> · officer room <#323456789012345605>",
        },
        { name: "Discord changes", value: "Live", inline: true },
        { name: "Role layout", value: "On", inline: true },
      ],
      footer: { text: "Configuration revision 42 · /config validate tests each resource" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      {
        type: 2,
        style: 2,
        label: "Run health check",
        custom_id: "config:validate",
        disabled: false,
      },
    ]);
  });

  test("configuration#7: every check passed", () => {
    const presented = CONFIG_CASES["validate.healthy"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x57f287,
      title: "Configuration health · all checks passed",
      description: "19 checks passed. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value: "[OK] Example Company «EXMPL» linked\n[OK] Roster read <t:1790143200:R>",
        },
        {
          name: "Access roles",
          value:
            "[OK] FC Leader <@&223456789012345604>\n[OK] Officer <@&223456789012345603>\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[OK] Officer notifications <#323456789012345602>\n[OFF] Changelog: not set, so update posts are skipped\n[OK] Guest applications <#323456789012345603>",
        },
        {
          name: "Onboarding",
          value: "[OK] Lobby <#323456789012345604>\n[OK] Officer room <#323456789012345605>",
        },
        // 2.35.0 (#46): TaruBot's role and channel view, healthy, between Onboarding and the switches.
        {
          name: "TaruBot's role",
          value:
            "[OK] Administrator: off\n[OK] Manage Roles, Manage Nicknames, View Channel, Send Messages, Embed Links, Attach Files and Read Message History\n[OK] Onboarding permissions\n[OK] Role order: <@&223456789012345690> is above the access roles\n[OK] No permissions it never needs",
        },
        { name: "Visibility", value: "[OK] Onboarding manages TaruBot's channel access" },
        { name: "Discord changes", value: "[OK] Live", inline: true },
        { name: "Role layout", value: "[OK] On", inline: true },
      ],
      footer: { text: "Read-only check · configuration revision 42" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      { type: 2, style: 2, label: "Re-check", custom_id: "config:validate", disabled: false },
    ]);
  });

  test("configuration#8: two problems and two warnings, with the approved paused warning", () => {
    expect(embedOf("validate.problems")).toEqual({
      color: 0xed4245,
      title: "Configuration health · 2 problems, 2 warnings",
      description:
        "Fix the items marked [FAIL], then run /config validate again. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value:
            "[OK] Example Company «EXMPL» linked\n[WARN] Roster is stale: last good read <t:1790056800:R>; the attempt <t:1790146800:R> failed (Lodestone unavailable)",
        },
        {
          name: "Access roles",
          value:
            "[OK] FC Leader <@&223456789012345604>\n[FAIL] Officer <@&223456789012345603>: Give the bot Manage Roles and place its role above the configured access role.\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[FAIL] Officer notifications <#323456789012345602>: Choose a text channel in this guild where the bot can view, send, embed links, and read message history.\n[OFF] Changelog: not set, so update posts are skipped\n[OFF] Guest applications: not set, so /apply is closed",
        },
        { name: "Onboarding", value: "[OFF] Onboarding is off" },
        // 2.35.0 (#46): TaruBot's role and channel view, healthy, between Onboarding and the switches.
        {
          name: "TaruBot's role",
          value:
            "[OK] Administrator: off\n[OK] Manage Roles, Manage Nicknames, View Channel, Send Messages, Embed Links, Attach Files and Read Message History\n[OK] Role order: <@&223456789012345690> is above the access roles\n[OK] No permissions it never needs",
        },
        { name: "Visibility", value: "[OK] TaruBot can see every channel" },
        {
          name: "Discord changes",
          value: "[WARN] Paused: this server has not been activated",
          inline: true,
        },
        { name: "Role layout", value: "[OFF] Off: display and order untouched", inline: true },
      ],
      footer: { text: "Read-only check · configuration revision 42" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#9: an imported server ready for activation", () => {
    expect(embedOf("validate.ready")).toEqual({
      color: 0xfee75c,
      title: "Configuration health · ready for activation",
      description:
        "All configured resources passed. Discord changes stay paused until activation. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value: "[OK] Example Company «EXMPL» linked\n[OK] Roster read <t:1790143200:R>",
        },
        {
          name: "Access roles",
          value:
            "[OFF] FC Leader: not managed\n[OK] Officer <@&223456789012345603>\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[OK] Officer notifications <#323456789012345602>\n[OFF] Changelog: not set, so update posts are skipped\n[OFF] Guest applications: closed, so /apply refuses",
        },
        { name: "Onboarding", value: "[OFF] Onboarding is off" },
        // 2.35.0 (#46): TaruBot's role and channel view, healthy, between Onboarding and the switches.
        {
          name: "TaruBot's role",
          value:
            "[OK] Administrator: off\n[OK] Manage Roles, Manage Nicknames, View Channel, Send Messages, Embed Links, Attach Files and Read Message History\n[OK] Role order: <@&223456789012345690> is above the access roles\n[OK] No permissions it never needs",
        },
        { name: "Visibility", value: "[OK] TaruBot can see every channel" },
        { name: "Discord changes", value: "[WAIT] Paused until activation", inline: true },
        { name: "Role layout", value: "[OFF] Off: display and order untouched", inline: true },
        {
          name: "Guest grandfathering",
          value: "[WAIT] Pending: runs once at activation",
          inline: true,
        },
      ],
      footer: { text: "Read-only check · configuration revision 7" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#18: adopt_holders:false, live, and its drawn paused state as errors#26", () => {
    // The drawn card shows a paused save as success; owner decision O2 makes a paused save the
    // pending errors-and-style#26 card, so #18 renders as drawn only while changes are live.
    const live = embedOf("role.officer_not_adopted");
    expect(live).toMatchObject({
      color: 0x57f287,
      title: "Officer role set without adopting holders",
      description:
        "<@&223456789012345603> is now the bot-managed Officer role. No manual grants were created for its current holders.",
      footer: { text: "Audited · adopt_holders:false" },
      timestamp: NOW.toISOString(),
    });
    expect(live.fields).toEqual([
      {
        name: "Who keeps the role",
        value:
          "Members whose linked character holds in-game rank **Officer**, plus anyone given /officer grant. Other holders lose the role once the roster confirms they don't hold that rank.",
      },
      { name: "Officer rank", value: "Officer", inline: true },
      { name: "Discord changes", value: "`… QUEUED` Server-wide role check", inline: true },
    ]);
    const held = embedOf("role.paused");
    expect(held.title).toBe("Saved, Discord changes paused");
    expect(held.description).toStartWith(live.description ?? "");
    expect(namesOf(held)).toEqual([
      "Saved",
      "Discord changes",
      "Who keeps the role",
      "Officer rank",
    ]);
  });

  test("configuration#34: role layout turned off", () => {
    expect(embedOf("layout.off")).toEqual({
      color: 0x57f287,
      title: "Role layout turned off",
      description:
        "Current role display and order are left as they are; the bot will no longer change them.",
      fields: [{ name: "Access roles", value: "Still assigned and removed as usual" }],
      footer: { text: "Audited as config.role_layout" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#37: a fresh /setup, with Check sync status", () => {
    const presented = CONFIG_CASES["setup.created"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x57f287,
      title: "Server setup complete",
      description:
        "TaruBot created 4 access roles, a lobby and an officer room. Channel permissions are being secured in the background.",
      fields: [
        {
          name: "Access roles",
          value:
            "FC Leader <@&223456789012345604> · created\nOfficer <@&223456789012345603> · created\nMember <@&223456789012345601> · created\nGuest <@&223456789012345602> · created",
        },
        { name: "Lobby", value: "<#323456789012345604> · created", inline: true },
        { name: "Officer room", value: "<#323456789012345605> · created", inline: true },
        {
          name: "Free Company",
          value: "FC 9234567890123456789 · roster read queued",
          inline: true,
        },
        { name: "Officer rank", value: "Officer", inline: true },
        {
          name: "Guest applications",
          value: "Open · reviews in <#323456789012345605>",
          inline: true,
        },
        { name: "Officer notifications", value: "<#323456789012345605>", inline: true },
        {
          name: "Role layout",
          value: "On · FC Leader > Officer > Member > Guest, displayed separately",
        },
        { name: "Channel access", value: "[WAIT] Securing channels · job 0b6f3c2e" },
        {
          name: "Next steps",
          value:
            "1. Run /sync status until channel access shows as completed.\n2. If you use the gil ledger, set a channel with /config ledger.\n3. Run /config validate.",
        },
      ],
      footer: { text: "Setup is safe to rerun: existing roles and rooms are reused" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      { type: 2, style: 2, label: "Check sync status", custom_id: "sync:status", disabled: false },
    ]);
  });

  test("configuration#41: an officer grant", () => {
    expect(embedOf("officer.granted")).toEqual({
      color: 0x57f287,
      title: "Officer access granted",
      description:
        "<@423456789012345678> now has bot officer access and will receive the Officer role. This grant doesn't depend on in-game rank and lasts until a server manager runs /officer revoke or /officer reset.",
      fields: [
        { name: "Member", value: "<@423456789012345678>", inline: true },
        { name: "Discord role", value: "Assignment queued", inline: true },
        { name: "Reason", value: "Runs FC events while the officer rank is vacant." },
      ],
      footer: { text: "Audited as officer.grant" },
      timestamp: NOW.toISOString(),
    });
  });
});

describe("/config validate", () => {
  /** One checklist section's lines for a report. */
  const checklist = (report: ReturnType<typeof configReport>, section: string) =>
    fieldOf(onlyEmbed(healthReply(report, officer, { now })), section);

  test("ENABLE_EFFECTS=false is a warning, whatever else the checklist says", () => {
    const embed = embedOf("validate.warnings");
    expect(fieldOf(embed, "Discord changes")).toBe("[WARN] Disabled for this deployment");
    expect(embed.description).toBe(
      "No problems found, but review the items marked [WARN]. Nothing was changed.",
    );
    // Beside a problem it still counts as one of the warnings.
    const failing = configReport({
      effectsMode: "deployment_disabled",
      capabilities: { ledger_channel_id: "TaruBot can't post there." },
    });
    expect(onlyEmbed(healthReply(failing, officer, { now })).title).toBe(
      "Configuration health · 1 problem, 1 warning",
    );
  });

  test("a review channel without a Guest role warns that /apply stays closed", () => {
    const report = configReport({ guild: configGuild({ guest_role_id: null }) });
    expect(checklist(report, "Channels")).toContain(
      "[WARN] Guest applications <#323456789012345603>: open, but no Guest role is set, so /apply stays closed",
    );
    expect(checklist(report, "Access roles")).toContain(
      "[WARN] Guest: not set, so no one receives Guest access",
    );
  });

  test("the roster lines: never read, stale, and a failure only when newer than the success", () => {
    const line = (row: Parameters<typeof fcRow>[0]) =>
      checklist(configReport({ fc: fcRow(row) }), "Free Company")?.split("\n")[1];
    expect(line({ last_successful_roster_at: null, fresh: false })).toBe(
      "[WARN] No successful roster read yet",
    );
    expect(
      line({
        last_successful_roster_at: null,
        fresh: false,
        last_attempt_at: at(-60),
        last_error: "rate_limited",
        attemptFailed: true,
      }),
    ).toBe(
      "[WARN] No successful roster read yet; the attempt <t:1790168940:R> failed (Lodestone rate limited)",
    );
    // A stale read whose latest attempt came before it has no failure clause.
    expect(
      line({
        last_successful_roster_at: at(-86_400),
        last_attempt_at: at(-90_000),
        fresh: false,
        last_error: "unavailable",
        attemptFailed: true,
      }),
    ).toBe("[WARN] Roster is stale: last good read <t:1790082600:R>");
    // An unknown stored code falls back to generic words; the code itself is never shown.
    expect(
      line({
        last_successful_roster_at: at(-86_400),
        last_attempt_at: at(-60),
        fresh: false,
        last_error: "lease_lost",
        attemptFailed: true,
      }),
    ).toEndWith("failed (roster read failed)");
    expect(checklist(configReport({ guild: configGuild({ fc_id: null }) }), "Free Company")).toBe(
      "[WARN] No FC linked, so no one can receive Member",
    );
  });

  test("activation pending is [WAIT] without problems and the approved [WARN] beside them", () => {
    const paused = configGuild({ effects_enabled: false });
    expect(checklist(configReport({ guild: paused }), "Discord changes")).toBe(
      "[WAIT] Paused until activation",
    );
    expect(
      checklist(
        configReport({ guild: paused, capabilities: { member_role_id: "Pick an ordinary role." } }),
        "Discord changes",
      ),
    ).toBe("[WARN] Paused: this server has not been activated");
  });

  test("with all ten capabilities failing, fields stay within 1,024 and the embed within 6,000", () => {
    // The gateway's rewritten messages name the resource; its mention survives the escaping.
    const rewritten = configReport({
      capabilities: {
        member_role_id: `TaruBot can't manage <@&${ROLE.member}>. Its own role must be above that role, and it needs Manage Roles.`,
        ledger_channel_id: `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${CHANNEL.ledger}>, and it must be a text channel in this server.`,
      },
    });
    expect(checklist(rewritten, "Access roles")).toContain(
      `[FAIL] Member <@&${ROLE.member}>: TaruBot can't manage <@&${ROLE.member}>. Its own role must be above that role, and it needs Manage Roles.`,
    );
    const capabilities: Record<string, string> = {};
    for (const column of [
      "member_role_id",
      "guest_role_id",
      "officer_role_id",
      "leader_role_id",
      "ledger_channel_id",
      "officer_notifications_channel_id",
      "guest_application_channel_id",
      "lobby_channel_id",
      "officer_channel_id",
      "changelog_channel_id",
    ])
      capabilities[column] = stress.text(900);
    const presented = healthReply(
      configReport({
        // Four failing channels share the Channels field, the changelog's hidden audience too.
        guild: configGuild({
          revision: 9_007_199_254_740_993n,
          changelog_channel_id: CHANNEL.changelog,
          changelog_version: "2.25.0",
        }),
        effectsMode: "deployment_disabled",
        capabilities,
        changelogAudience: "hidden",
      }),
      officer,
      { now },
    );
    const embed = expectHouseStyle(presented, {
      tone: "error",
      title: "Configuration health · 10 problems, 1 warning",
    });
    for (const field of embed.fields ?? [])
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    // The revision is a bigint and is printed exactly, never through Number().
    expect(embed.footer?.text).toBe("Read-only check · configuration revision 9007199254740993");
  });

  test("configurationChecks marks exactly the configured roles and channels as resources", () => {
    const checks = configurationChecks(R.healthy);
    expect(checks.filter((row) => row.resource)).toHaveLength(9);
    expect(configurationChecks(R.partial).filter((row) => row.resource)).toHaveLength(0);
  });
});

describe("Role menu (2.39.0)", () => {
  /** The Role menu rows of a validate embed, or undefined without the section. */
  const rows = (health: Parameters<typeof selfRoleHealth>[0] | undefined) =>
    fieldOf(
      onlyEmbed(
        healthReply(
          configReport(health === undefined ? {} : { selfRoles: selfRoleHealth(health) }),
          officer,
          { now },
        ),
      ),
      "Role menu",
    )?.split("\n");

  test("off while every role is in a draft, OK while every role outside drafts passes", () => {
    expect(rows(undefined)).toBeUndefined();
    expect(rows({})).toEqual(["[OFF] No roles outside drafts"]);
    expect(rows({ listed: 1 })).toEqual(["[OK] 1 role outside drafts; all pass"]);
    expect(rows({ listed: 12 })).toEqual(["[OK] 12 roles outside drafts; all pass"]);
  });

  test("problems, an unknown view and unreadable channels warn, counting only", () => {
    expect(rows({ listed: 5, problems: 1 })).toEqual([
      "[WARN] 1 role outside drafts has a problem; open Role menu to see which",
    ]);
    expect(rows({ listed: 5, problems: 3, unreadableChannels: 2 })).toEqual([
      "[WARN] 3 roles outside drafts have a problem; open Role menu to see which",
      "[WARN] TaruBot can't read 2 channels, so it can't check menu roles there",
    ]);
    expect(rows({ listed: 5, problems: null })).toEqual([
      "[WARN] Couldn't check the menu's roles; try again in a minute",
    ]);
    expect(rows({ listed: 5, unreadableChannels: 1 })).toEqual([
      "[OK] 5 roles outside drafts; all pass",
      "[WARN] TaruBot can't read 1 channel, so it can't check menu roles there",
    ]);
    expect(rows({ unreadableMenu: true })).toEqual([
      "[WARN] The saved role menu can't be read by this TaruBot version; open Role menu to reset it",
    ]);
  });

  test("the section counts toward the verdict, sits after Visibility, and keeps ten fields", () => {
    const healthy = onlyEmbed(
      healthReply(configReport({ selfRoles: selfRoleHealth({ listed: 2 }) }), officer, { now }),
    );
    const before = onlyEmbed(healthReply(R.healthy, officer, { now }));
    expect(healthy.title).toBe("Configuration health · all checks passed");
    const passed = (embed: typeof healthy) =>
      Number(/^(\d+) checks? passed/u.exec(embed.description ?? "")?.[1]);
    expect(passed(healthy)).toBe(passed(before) + 1);
    const names = namesOf(healthy);
    expect(names.indexOf("Role menu")).toBe(names.indexOf("Visibility") + 1);
    const warned = onlyEmbed(
      healthReply(
        configReport({ selfRoles: selfRoleHealth({ listed: 2, problems: 2 }) }),
        officer,
        {
          now,
        },
      ),
    );
    expect(warned.title).toBe("Configuration health · 1 warning");
    // Every section at once, Guest grandfathering included: still within the house limit.
    const crowded = healthReply(
      configReport({
        guild: configGuild({ guest_grandfather: "pending", effects_enabled: false }),
        selfRoles: selfRoleHealth({ listed: 2, problems: 1, unreadableChannels: 3 }),
      }),
      officer,
      { now },
    );
    expect(onlyEmbed(crowded).fields?.length).toBeLessThanOrEqual(HOUSE_LIMITS.fields);
    expect(namesOf(onlyEmbed(crowded))).toContain("Guest grandfathering");
  });
});

describe("TaruBot's role and Visibility (2.35.0, #46)", () => {
  /** A checked (onboarding off) server's report: the imported guild, which has onboarding off. */
  const offGuild = configGuild({
    access_policy_enabled: false,
    lobby_channel_id: null,
    officer_channel_id: null,
  });
  /** The validate embed for a visibility report on the onboarding-off guild. */
  const validate = (visibility: ReturnType<typeof visibilityReport> | null, guild = offGuild) =>
    onlyEmbed(healthReply(configReport({ guild, visibility }), officer, { now }));
  /** A checked report with these changes. */
  const checked = (overrides: Parameters<typeof visibilityReport>[0] = {}) =>
    visibilityReport(overrides, false);
  /** A section's rows. */
  const rowsOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
    fieldOf(embed, name)?.split("\n");
  /** Distinct decimal IDs, as many as asked, from a base. */
  const ids = (base: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${base}${String(index).padStart(3, "0")}`);
  /** Administrator held from these roles, `shared` the ones neither TaruBot's role nor @everyone. */
  const holding = (roles: string[], shared: string[] = []) => ({
    administrator: { held: true, roles, shared },
  });
  /** Nothing held. */
  const NOT_HELD = { administrator: { held: false, roles: [], shared: [] } };
  const ROLE_A = "523456789012345601";
  const ROLE_B = "523456789012345602";
  const ROLE_C = "523456789012345603";
  const ROLE_D = "523456789012345604";
  /** A missing list with these channels. */
  const missing = (
    lists: Partial<ReturnType<typeof visibilityReport>["missing"]>,
  ): ReturnType<typeof visibilityReport>["missing"] => ({
    categories: [],
    inside: [],
    channels: [],
    posting: [],
    unreadable: [],
    ...lists,
  });

  test("Administrator: off, on and still needed, or on and no longer needed", () => {
    expect(rowsOf(validate(checked()), "TaruBot's role")?.[0]).toBe("[OK] Administrator: off");
    const needed = checked({
      ...holding([ROLE.bot, GUILD_ID]),
      administratorNeeded: true,
      missing: missing({ channels: [CHANNEL.ledger] }),
      missingCount: 1,
    });
    expect(rowsOf(validate(needed), "TaruBot's role")?.[0]).toBe(
      `[WARN] Administrator: on (from <@&${ROLE.bot}> and @everyone); still needed until the items below are fixed`,
    );
    const done = checked({ ...holding([ROLE.bot]), administratorNeeded: false });
    // Either way it is a warning to act on, never a problem.
    expect(validate(done).title).toBe("Configuration health · 1 warning");
  });

  test("no longer needed: turn it off in TaruBot's role or @everyone, remove a shared role", () => {
    const first = (roles: string[], shared: string[]) =>
      rowsOf(
        validate(checked({ ...holding(roles, shared), administratorNeeded: false })),
        "TaruBot's role",
      )?.[0];
    const lead = "[WARN] Administrator: no longer needed; ";
    // TaruBot's own bot role only.
    expect(first([ROLE.bot], [])).toBe(`${lead}turn it off in <@&${ROLE.bot}>`);
    // A shared role only, such as an Officer role people also hold.
    expect(first([ROLE_A], [ROLE_A])).toBe(`${lead}remove <@&${ROLE_A}> from TaruBot`);
    // Both.
    expect(first([ROLE.bot, ROLE_A], [ROLE_A])).toBe(
      `${lead}turn it off in <@&${ROLE.bot}>, and remove <@&${ROLE_A}> from TaruBot`,
    );
    // @everyone is turned off like TaruBot's own role, named in plain text.
    expect(first([ROLE.bot, GUILD_ID], [])).toBe(
      `${lead}turn it off in <@&${ROLE.bot}> and @everyone`,
    );
    // Three mentions per list, then the count.
    expect(
      first([ROLE.bot, ROLE_A, ROLE_B, ROLE_C, ROLE_D], [ROLE_A, ROLE_B, ROLE_C, ROLE_D]),
    ).toBe(
      `${lead}turn it off in <@&${ROLE.bot}>, and remove <@&${ROLE_A}>, <@&${ROLE_B}>, <@&${ROLE_C}> and 1 more from TaruBot`,
    );
    // The exported helper setup reuses, down to counts only.
    expect(administratorRemoval([ROLE.bot, ROLE_A], [ROLE_A], GUILD_ID, 3)).toBe(
      `turn it off in <@&${ROLE.bot}>, and remove <@&${ROLE_A}> from TaruBot`,
    );
    expect(administratorRemoval([ROLE.bot, ROLE_A, ROLE_B], [ROLE_A, ROLE_B], GUILD_ID, 0)).toBe(
      "turn it off in 1 role, and remove 2 roles from TaruBot",
    );
  });

  test("core permissions: own role, only from @everyone or other roles, and missing", () => {
    const rows = (core: ReturnType<typeof visibilityReport>["core"], held = false) =>
      rowsOf(
        validate(checked({ core, ...(held ? holding([ROLE.bot]) : NOT_HELD) })),
        "TaruBot's role",
      );
    const own = { source: "own_role", roles: [] } as const;
    expect(
      rows([
        { permission: "ManageRoles", ...own },
        { permission: "ManageNicknames", source: "everyone", roles: [GUILD_ID] },
        { permission: "ViewChannel", source: "other_roles", roles: [ROLE_A, GUILD_ID] },
        { permission: "SendMessages", ...own },
        { permission: "EmbedLinks", source: "other_roles", roles: [ROLE_A, GUILD_ID] },
        { permission: "AttachFiles", source: "missing", roles: [] },
        { permission: "ReadMessageHistory", ...own },
      ]),
    ).toEqual([
      "[OK] Administrator: off",
      "[OK] Manage Roles, Send Messages and Read Message History",
      "[WARN] Manage Nicknames: only from @everyone, so a change to that role removes it",
      `[WARN] View Channel and Embed Links: only from <@&${ROLE_A}> and @everyone, so a change to those roles removes them`,
      "[FAIL] Attach Files: missing",
      `[OK] Role order: <@&${ROLE.bot}> is above the access roles`,
      "[OK] No permissions it never needs",
    ]);
    // While Administrator is on, a missing permission is what it still covers.
    expect(
      rows(
        [
          { permission: "ManageRoles", source: "missing", roles: [] },
          { permission: "ManageNicknames", source: "missing", roles: [] },
          ...(
            [
              "ViewChannel",
              "SendMessages",
              "EmbedLinks",
              "AttachFiles",
              "ReadMessageHistory",
            ] as const
          ).map((permission) => ({ permission, ...own })),
        ],
        true,
      )?.[1],
    ).toBe(
      "[WARN] Manage Roles and Manage Nicknames: missing without Administrator; grant them before removing Administrator",
    );
  });

  test("onboarding permissions: one row for all five, and only on onboarding servers", () => {
    const five = [
      "ManageChannels",
      "UseApplicationCommands",
      "CreatePublicThreads",
      "CreatePrivateThreads",
      "Connect",
    ] as const;
    expect(
      rowsOf(
        validate(visibilityReport({ onboardingMissing: [...five] }), configGuild()),
        "TaruBot's role",
      )?.[2],
    ).toBe(
      "[FAIL] Onboarding permissions: missing Manage Channels, Use Application Commands, Create Public Threads, Create Private Threads and Connect",
    );
    const covered = visibilityReport({
      onboardingMissing: ["Connect"],
      ...holding([ROLE.bot]),
      administratorNeeded: true,
    });
    expect(rowsOf(validate(covered, configGuild()), "TaruBot's role")?.[2]).toBe(
      "[WARN] Onboarding permissions: missing Connect without Administrator; grant it before removing Administrator",
    );
    expect(rowsOf(validate(visibilityReport(), configGuild()), "TaruBot's role")?.[2]).toBe(
      "[OK] Onboarding permissions",
    );
    // Without onboarding no row names any of the five, even while TaruBot lacks them all: the
    // analysis reports none (onboardingMissing null), and the core seven never include them.
    const bare = checked({
      core: checked().core.map((row) => ({ ...row, source: "missing" as const })),
      missing: missing({ channels: [CHANNEL.ledger] }),
      missingCount: 1,
    });
    const text = visibleText(
      healthReply(configReport({ guild: offGuild, visibility: bare }), officer, { now }),
    );
    for (const name of [
      "Onboarding permissions",
      "Manage Channels",
      "Use Application Commands",
      "Create Public Threads",
      "Create Private Threads",
    ])
      expect({ name, found: text.includes(name) }).toEqual({ name, found: false });
    expect(text).not.toMatch(/\bConnect\b/u);
  });

  test("role order and never-needed permissions", () => {
    const report = visibilityReport({
      roleOrder: { highest: ROLE.bot, notBelow: [ROLE.officer, ROLE.leader], throughShared: [] },
      neverNeeded: [
        { permission: "ManageGuild", roles: [ROLE.bot] },
        { permission: "MentionEveryone", roles: [ROLE_A] },
      ],
    });
    expect(rowsOf(validate(report, configGuild()), "TaruBot's role")?.slice(3)).toEqual([
      `[FAIL] Role order: move TaruBot's highest role above <@&${ROLE.officer}> and <@&${ROLE.leader}>`,
      `[WARN] Never needed: Manage Server and Mention Everyone (from <@&${ROLE.bot}> and <@&${ROLE_A}>)`,
    ]);
    const bare = checked({ roleOrder: { highest: null, notBelow: [], throughShared: [] } });
    expect(fieldOf(validate(bare), "TaruBot's role")).toContain(
      "[OK] Role order: no access roles to stay above",
    );
  });

  test("role order kept only by a shared Administrator role is a warning to fix before removing it", () => {
    const rows = (roleOrder: ReturnType<typeof visibilityReport>["roleOrder"]) =>
      rowsOf(
        validate(checked({ ...holding([ROLE_A], [ROLE_A]), administratorNeeded: true, roleOrder })),
        "TaruBot's role",
      ) ?? [];
    const only = rows({
      highest: ROLE.bot,
      notBelow: [ROLE.member, ROLE.guest],
      throughShared: [ROLE.member, ROLE.guest],
    });
    // Administrator stays needed, and nothing reads as a failure that doesn't exist yet.
    expect(only[0]).toBe(
      `[WARN] Administrator: on (from <@&${ROLE_A}>); still needed until the items below are fixed`,
    );
    expect(only.filter((row) => row.includes("Role order"))).toEqual([
      `[WARN] Role order: TaruBot is above <@&${ROLE.member}> and <@&${ROLE.guest}> only through <@&${ROLE_A}>; move <@&${ROLE.bot}> above them before removing that role from TaruBot`,
    ]);
    // Roles it sits below whatever it holds are still a failure, in their own row.
    const mixed = rows({
      highest: ROLE.bot,
      notBelow: [ROLE.member, ROLE.officer],
      throughShared: [ROLE.member],
    });
    expect(mixed.filter((row) => row.includes("Role order"))).toEqual([
      `[FAIL] Role order: move TaruBot's highest role above <@&${ROLE.officer}>`,
      `[WARN] Role order: TaruBot is above <@&${ROLE.member}> only through <@&${ROLE_A}>; move <@&${ROLE.bot}> above it before removing that role from TaruBot`,
    ]);
    // Without a role of its own left, TaruBot needs one.
    expect(
      rows({ highest: null, notBelow: [ROLE.member], throughShared: [ROLE.member] }).filter((row) =>
        row.includes("Role order"),
      ),
    ).toEqual([
      `[WARN] Role order: TaruBot is above <@&${ROLE.member}> only through <@&${ROLE_A}>; give TaruBot a role above it before removing that role from TaruBot`,
    ]);
  });

  test("onboarding servers: what onboarding's pass hasn't reached, and what it never manages", () => {
    const onboarding = (held: boolean, managed: string[], unmanaged: string[] = []) =>
      rowsOf(
        validate(
          visibilityReport({
            ...(held ? holding([ROLE.bot]) : NOT_HELD),
            administratorNeeded: held,
            onboardingPending: { managed, unmanaged },
          }),
          configGuild(),
        ),
        "Visibility",
      );
    expect(onboarding(false, [])).toEqual(["[OK] Onboarding manages TaruBot's channel access"]);
    expect(onboarding(true, [CHANNEL.ledger, CHANNEL.notices])).toEqual([
      `[WARN] Onboarding hasn't reached 2 channels yet: <#${CHANNEL.ledger}> and <#${CHANNEL.notices}>; keep Administrator on until /sync status shows its channel pass finished`,
    ]);
    expect(onboarding(false, [CHANNEL.ledger])).toEqual([
      `[FAIL] Onboarding hasn't reached 1 channel yet: <#${CHANNEL.ledger}>; /sync status shows why its channel pass is waiting`,
    ]);
    expect(onboarding(true, [], [CHANNEL.changelog])).toEqual([
      `[WARN] Onboarding doesn't manage <#${CHANNEL.changelog}>, so TaruBot needs its own access there before Administrator comes off: give it View Channel, Send Messages, Embed Links and Read Message History`,
    ]);
    expect(onboarding(false, [CHANNEL.ledger], [CHANNEL.changelog])).toEqual([
      `[FAIL] Onboarding hasn't reached 1 channel yet: <#${CHANNEL.ledger}>; /sync status shows why its channel pass is waiting`,
      `[FAIL] Onboarding doesn't manage <#${CHANNEL.changelog}>, and TaruBot can't post there: give it View Channel, Send Messages, Embed Links and Read Message History`,
    ]);
  });

  test("Visibility: every channel visible, and hidden on purpose", () => {
    expect(fieldOf(validate(checked()), "Visibility")).toBe("[OK] TaruBot can see every channel");
    const hidden = ids("62345678901234", 8);
    expect(fieldOf(validate(checked({ hiddenOnPurpose: hidden })), "Visibility")).toBe(
      `[OK] TaruBot can see every channel, except 8 hidden on purpose: ${hidden
        .slice(0, 6)
        .map((id) => `<#${id}>`)
        .join(", ")} and 2 more`,
    );
    // Channels hidden only through their category's deny are counted apart.
    const [first = "", second = ""] = hidden;
    const byCategory = checked({ hiddenOnPurpose: [first, second], hiddenByCategory: [second] });
    expect(fieldOf(validate(byCategory), "Visibility")).toBe(
      `[OK] TaruBot can see every channel, except 2 hidden on purpose (1 inside a category hidden from TaruBot): <#${first}> and <#${second}>`,
    );
    const alongside = checked({
      hiddenOnPurpose: [first],
      hiddenByCategory: [first],
      missing: missing({ channels: [CHANNEL.ledger] }),
      missingCount: 1,
    });
    expect(rowsOf(validate(alongside), "Visibility")?.at(-1)).toBe(
      `[OFF] Hidden on purpose: <#${first}> (1 inside a category hidden from TaruBot)`,
    );
  });

  test("missing overrides: counts, six mentions then 'and K more', and the remedy", () => {
    const categories = ids("72345678901234", 2);
    const inside = ids("73345678901234", 5);
    const channels = ids("74345678901234", 7);
    const report = (held: boolean, unreadable: string[]) =>
      checked({
        ...(held ? holding([ROLE.bot]) : NOT_HELD),
        administratorNeeded: held,
        missing: missing({ categories, inside, channels, unreadable }),
        hiddenOnPurpose: [CHANNEL.changelog],
        missingCount: 14,
      });
    const lead = `[WARN] Missing TaruBot overrides: 2 categories (5 channels inside), 7 channels: ${[
      ...categories,
      ...channels,
    ]
      .slice(0, 6)
      .map((id) => `<#${id}>`)
      .join(", ")} and 3 more`;
    const unread = [inside[0] ?? "", channels[6] ?? ""];
    expect(rowsOf(validate(report(true, unread)), "Visibility")).toEqual([
      `${lead}; /setup overrides confirm:true adds them while TaruBot holds Administrator (the run re-reads the 2 TaruBot can't read yet)`,
      `[OFF] Hidden on purpose: <#${CHANNEL.changelog}>`,
    ]);
    expect(rowsOf(validate(report(true, [])), "Visibility")?.[0]).toBe(
      `${lead}; /setup overrides confirm:true adds them while TaruBot holds Administrator`,
    );
    expect(rowsOf(validate(report(false, unread)), "Visibility")?.[0]).toBe(
      `${lead}; turn Administrator on for TaruBot, then run /setup overrides confirm:true; TaruBot can't read 2 of them until then`,
    );
    expect(rowsOf(validate(report(false, [])), "Visibility")?.[0]).toBe(
      `${lead}; turn Administrator on for TaruBot, then run /setup overrides confirm:true`,
    );
    // One missing channel, no categories.
    const one = checked({ missing: missing({ channels: [CHANNEL.lobby] }), missingCount: 1 });
    expect(fieldOf(validate(one), "Visibility")).toBe(
      `[WARN] Missing TaruBot overrides: 1 channel: <#${CHANNEL.lobby}>; turn Administrator on for TaruBot, then run /setup overrides confirm:true`,
    );
  });

  test("posting channels name what they lack, in the channel's own words, with the remedy", () => {
    const report = (held: boolean) =>
      checked({
        ...(held ? holding([ROLE.bot]) : NOT_HELD),
        administratorNeeded: held,
        missing: missing({
          channels: [CHANNEL.ledger, CHANNEL.notices],
          posting: [
            { id: CHANNEL.ledger, lacks: ["ViewChannel"] },
            { id: CHANNEL.notices, lacks: ["EmbedLinks", "ReadMessageHistory"] },
          ],
          unreadable: [CHANNEL.ledger],
        }),
        missingCount: 2,
      });
    const lead = `[WARN] Posting channels without all four posting permissions: <#${CHANNEL.ledger}> (View Channel) and <#${CHANNEL.notices}> (Embed Links and Read Message History)`;
    // The same remedy as the Missing row, without its unreadable clause.
    expect(rowsOf(validate(report(true)), "Visibility")?.[1]).toBe(
      `${lead}; /setup overrides confirm:true adds them while TaruBot holds Administrator`,
    );
    expect(rowsOf(validate(report(false)), "Visibility")?.[1]).toBe(
      `${lead}; turn Administrator on for TaruBot, then run /setup overrides confirm:true`,
    );
  });

  test("masked, and denied: a warning while Administrator is on, a problem once it is off", () => {
    const report = (held: boolean) =>
      checked({
        ...(held ? holding([ROLE.bot]) : NOT_HELD),
        administratorNeeded: held,
        masked: [CHANNEL.reviews],
        denied: [CHANNEL.ledger],
        missingCount: 2,
      });
    expect(rowsOf(validate(report(true)), "Visibility")).toEqual([
      `[WARN] Configured channels where TaruBot's own entry denies Read Message History: <#${CHANNEL.reviews}>; /setup overrides lifts that deny while TaruBot holds Administrator`,
      `[WARN] Configured but denied to TaruBot on purpose: <#${CHANNEL.ledger}>; lift the deny or change the setting before removing Administrator`,
    ]);
    const off = validate(report(false));
    expect(rowsOf(off, "Visibility")?.[1]).toBe(
      `[FAIL] Configured but denied to TaruBot on purpose: <#${CHANNEL.ledger}>; lift the deny or change the setting`,
    );
    expect(off.title).toBe("Configuration health · 1 problem, 1 warning");
  });

  test("private categories: a warning with the three fixes, held or not", () => {
    const categories = ids("75345678901234", 8);
    const configured = ids("76345678901234", 3);
    const report = (held: boolean, count: number) =>
      checked({
        ...(held ? holding([ROLE.bot]) : NOT_HELD),
        administratorNeeded: held,
        privateCategories: categories.slice(0, count).map((id, index) => ({
          id,
          configured: index === 0 ? configured : [configured[index % 3] ?? ""],
          inside: index === 0 ? configured : [configured[index % 3] ?? ""],
        })),
        missingCount: count * 2,
      });
    const fixes =
      "; /setup overrides leaves them alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself";
    const [c0, c1] = categories;
    const [l0, l1, l2] = configured;
    const two = `[WARN] Private categories holding a configured channel: <#${c0}> (holds <#${l0}>, <#${l1}> and 1 more) and <#${c1}> (holds <#${l1}>)${fixes}`;
    // @deconfined: it's a warning, whether or not Administrator is held.
    expect(rowsOf(validate(report(true, 2)), "Visibility")).toEqual([two]);
    expect(rowsOf(validate(report(false, 2)), "Visibility")).toEqual([two]);
    expect(validate(report(false, 2)).title).toBe("Configuration health · 1 warning");
    // Eight categories: six named, then the count.
    const eight = rowsOf(validate(report(true, 8)), "Visibility")?.[0] ?? "";
    expect(eight).toContain(`<#${categories[5]}> (holds <#${l2}>) and 2 more; /setup overrides`);
    expect(eight).not.toContain(`<#${categories[6]}>`);
  });

  test("the rows come in their pinned order", () => {
    const report = checked({
      ...holding([ROLE.bot]),
      administratorNeeded: true,
      missing: missing({
        channels: [CHANNEL.ledger],
        posting: [{ id: CHANNEL.ledger, lacks: ["EmbedLinks"] }],
      }),
      masked: [CHANNEL.reviews],
      denied: [CHANNEL.notices],
      privateCategories: [{ id: CHANNEL.officers, configured: [CHANNEL.lobby], inside: [] }],
      hiddenOnPurpose: [CHANNEL.changelog],
      missingCount: 5,
    });
    expect(
      rowsOf(validate(report), "Visibility")?.map(
        (row) => /^\[[A-Z]+\] ([A-Z][a-z]+)/u.exec(row)?.[1],
      ),
    ).toEqual(["Missing", "Posting", "Configured", "Configured", "Private", "Hidden"]);
    expect(rowsOf(validate(report), "Visibility")?.[2]).toContain("denies Read Message History");
    expect(rowsOf(validate(report), "Visibility")?.[3]).toContain("denied to TaruBot on purpose");
  });

  test("an unreadable view drops the role section and warns once", () => {
    const embed = validate(null);
    expect(namesOf(embed)).not.toContain("TaruBot's role");
    expect(fieldOf(embed, "Visibility")).toBe(
      "[WARN] Couldn't read TaruBot's channel view; try again in a minute",
    );
    expect(embed.title).toBe("Configuration health · 1 warning");
  });

  test("the sections sit between Onboarding and Discord changes", () => {
    expect(namesOf(validate(checked()))).toEqual([
      "Free Company",
      "Access roles",
      "Channels",
      "Onboarding",
      "TaruBot's role",
      "Visibility",
      "Discord changes",
      "Role layout",
    ]);
  });

  test("/config show counts the rows to review on its health line, and adds no field", () => {
    const show = (visibility: ReturnType<typeof visibilityReport> | null) =>
      onlyEmbed(showReply(configReport({ guild: offGuild, visibility }), officer, { now }));
    const healthy = show(checked());
    expect(healthy.description?.split("\n").at(-1)).toBe("Health: all 7 resource checks passed.");
    const review = checked({
      ...holding([ROLE.bot]),
      administratorNeeded: false,
      denied: [CHANNEL.ledger],
      missingCount: 1,
    });
    expect(show(review).description?.split("\n").at(-1)).toBe(
      "Health: all 7 resource checks passed. Role and visibility: 2 to review in /config validate.",
    );
    expect(show(null).description?.split("\n").at(-1)).toBe(
      "Health: all 7 resource checks passed. Role and visibility: 1 to review in /config validate.",
    );
    // The Private categories row counts like any other warning.
    const withPrivate = checked({
      ...review,
      privateCategories: [{ id: CHANNEL.officers, configured: [CHANNEL.lobby], inside: [] }],
      missingCount: 2,
    });
    expect(show(withPrivate).description?.split("\n").at(-1)).toBe(
      "Health: all 7 resource checks passed. Role and visibility: 3 to review in /config validate.",
    );
    expect(namesOf(show(review))).toEqual(namesOf(healthy));
    // Beside a failing resource check.
    const failing = onlyEmbed(
      showReply(
        configReport({
          guild: offGuild,
          visibility: review,
          capabilities: { officer_role_id: "Pick an ordinary role." },
        }),
        officer,
        { now },
      ),
    );
    expect(failing.description?.split("\n").at(-1)).toBe(
      "Health: 1 problem. Run /config validate. Role and visibility: 2 to review in /config validate.",
    );
  });

  test("a maximal report keeps every field within 1,024 and nothing is cut", () => {
    const big = (base: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${base}${String(index).padStart(4, "0")}`);
    // Twenty-digit IDs, the longest mentions Discord can send.
    const roles = big("1844674407370955", 12);
    const channels = big("1844674407370955", 90);
    const pick = (from: number, count: number) => roles.slice(from, from + count);
    const maximal = (onboarding: boolean) =>
      visibilityReport(
        {
          ...holding(pick(0, 5), pick(1, 4)),
          administratorNeeded: false,
          core: (
            [
              "ManageRoles",
              "ManageNicknames",
              "ViewChannel",
              "SendMessages",
              "EmbedLinks",
              "AttachFiles",
              "ReadMessageHistory",
            ] as const
          ).map((permission, index) => ({
            permission,
            source: "other_roles" as const,
            roles: pick(index, 4),
          })),
          onboardingMissing: onboarding
            ? [
                "ManageChannels",
                "UseApplicationCommands",
                "CreatePublicThreads",
                "CreatePrivateThreads",
                "Connect",
              ]
            : null,
          neverNeeded: (
            [
              "ManageGuild",
              "ManageMessages",
              "MentionEveryone",
              "KickMembers",
              "BanMembers",
              "ModerateMembers",
              "ManageWebhooks",
            ] as const
          ).map((permission, index) => ({ permission, roles: pick(index, 3) })),
          roleOrder: { highest: roles[11] ?? null, notBelow: pick(0, 8), throughShared: [] },
          ...(onboarding
            ? {
                onboardingPending: {
                  managed: channels.slice(0, 40),
                  unmanaged: channels.slice(40, 42),
                },
              }
            : {
                missing: {
                  categories: channels.slice(0, 10),
                  inside: channels.slice(10, 30),
                  channels: channels.slice(30, 45),
                  posting: channels.slice(30, 35).map((id) => ({
                    id,
                    lacks: [
                      "ViewChannel",
                      "SendMessages",
                      "EmbedLinks",
                      "ReadMessageHistory",
                    ] as const,
                  })),
                  unreadable: channels.slice(10, 20),
                },
                masked: channels.slice(45, 48),
                denied: channels.slice(48, 51),
                privateCategories: channels.slice(60, 70).map((id, index) => ({
                  id,
                  configured: channels.slice(70 + index, 74 + index),
                  inside: channels.slice(70 + index, 74 + index),
                })),
                hiddenOnPurpose: channels.slice(51, 60),
                missingCount: 101,
              }),
        },
        onboarding,
      );
    const capabilities: Record<string, string> = {};
    for (const column of ["member_role_id", "officer_role_id", "ledger_channel_id"])
      capabilities[column] = stress.text(900);
    for (const onboarding of [true, false]) {
      const presented = healthReply(
        configReport({
          guild: onboarding ? configGuild() : offGuild,
          visibility: maximal(onboarding),
          capabilities,
        }),
        officer,
        { now },
      );
      const embed = expectHouseStyle(presented, { tone: "error" });
      expect(embed.fields?.length).toBeLessThanOrEqual(HOUSE_LIMITS.fields);
      for (const name of ["TaruBot's role", "Visibility"]) {
        const value = fieldOf(embed, name) ?? "";
        expect(value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
        // Rows are whole: every line starts with its token, and none was cut short.
        for (const line of value.split("\n")) expect(line).toMatch(/^\[(OK|WARN|FAIL|OFF)\] /u);
        expect(value).not.toContain("…");
      }
      // Every row kind is still there, only with fewer mentions.
      const visibility = fieldOf(embed, "Visibility") ?? "";
      for (const lead of onboarding
        ? ["Onboarding hasn't reached", "Onboarding doesn't manage"]
        : [
            "Missing TaruBot overrides",
            "Posting channels",
            "Configured channels where",
            "Configured but denied",
            "Private categories",
            "Hidden on purpose",
          ])
        expect({ onboarding, lead, found: visibility.includes(lead) }).toEqual({
          onboarding,
          lead,
          found: true,
        });
      expect(fieldOf(embed, "TaruBot's role")).toContain(
        "Administrator: no longer needed; turn it off in",
      );
    }
    // The first budget already fits a server with a few of everything.
    const modest = checked({
      ...holding(pick(0, 2)),
      administratorNeeded: true,
      missing: missing({
        categories: channels.slice(0, 2),
        inside: channels.slice(2, 8),
        channels: channels.slice(8, 20),
        posting: [{ id: channels[8] ?? "", lacks: ["ViewChannel"] }],
        unreadable: channels.slice(2, 4),
      }),
      hiddenOnPurpose: channels.slice(20, 30),
      missingCount: 20,
    });
    expect(fieldOf(validate(modest), "Visibility")).toContain("and 8 more;");
  });
});

describe("/config show", () => {
  test("unset roles and channels collapse into one field each, with next steps", () => {
    const embed = embedOf("show.partial");
    expect(namesOf(embed)).toEqual([
      "Free Company",
      "Access roles",
      "Officer access",
      "Channels",
      "Onboarding",
      "Discord changes",
      "Role layout",
      "Next steps",
    ]);
    expect(fieldOf(embed, "Channels")).toBe(
      "Ledger: not set\nOfficer notifications: not set\nGuest applications: closed\nChangelog: not set",
    );
    expect(fieldOf(embed, "Next steps")).toBe(
      "1. Create or bind the access roles.\n2. Choose a ledger channel with /config ledger.\n3. Run /config validate.",
    );
  });

  test("guest applications read open, off (keeping the channel), or what keeps them closed", () => {
    const value = (overrides: Parameters<typeof configGuild>[0]) =>
      fieldOf(
        onlyEmbed(showReply(configReport({ guild: configGuild(overrides) }), officer, { now })),
        "Guest applications",
      );
    expect(value({})).toBe(`Open · <#${CHANNEL.reviews}>`);
    expect(value({ guest_application_channel_id: null })).toBe("Closed · no review channel");
    expect(value({ guest_role_id: null })).toBe("Closed · no Guest role");
    // The switch is separate from the channel (owner decision, 2026-09-24).
    expect(value({ guest_applications_enabled: false })).toBe(
      `Off · reviews in <#${CHANNEL.reviews}>`,
    );
    expect(value({ guest_applications_enabled: false, guest_application_channel_id: null })).toBe(
      "Off",
    );
  });

  test("validate lists the switch: off, on without a channel, or the checked channel", () => {
    const channels = (overrides: Parameters<typeof configGuild>[0]) =>
      fieldOf(
        onlyEmbed(healthReply(configReport({ guild: configGuild(overrides) }), officer, { now })),
        "Channels",
      ) ?? "";
    expect(channels({})).toContain(`[OK] Guest applications <#${CHANNEL.reviews}>`);
    // Off keeps the channel unchecked: an imported legacy channel may no longer exist.
    const off = channels({ guest_applications_enabled: false });
    expect(off).toContain("[OFF] Guest applications: closed, so /apply refuses");
    expect(off).not.toContain(`<#${CHANNEL.reviews}>`);
    expect(channels({ guest_application_channel_id: null })).toContain(
      "[WARN] Guest applications: on, but no review channel is set, so /apply stays closed",
    );
  });

  test("grandfathering shows while pending and when completed, and the paused note", () => {
    const paused = embedOf("show.paused");
    expect(paused.description).toContain("**Not activated yet.**");
    expect(fieldOf(paused, "Discord changes")).toBe("Paused · pending activation");
    expect(fieldOf(paused, "Guest grandfathering")).toBe("Pending · runs once at activation");
    const completed = onlyEmbed(
      showReply(
        configReport({
          guild: configGuild({
            guest_grandfather: "completed",
            guest_grandfathered_at: at(-3_600),
          }),
        }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(completed, "Guest grandfathering")).toBe("Completed <t:1790165400:R>");
    const disabled = showReply(configReport({ effectsMode: "deployment_disabled" }), officer, {
      now,
    });
    expect(onlyEmbed(disabled).description).toContain(
      "Discord changes **Disabled for this deployment**",
    );
    expectHouseStyle(disabled, { tone: "pending", maxFields: HOUSE_LIMITS.configShowFields });
  });

  test("no FC linked, and a failing check turns the health line into a problem count", () => {
    const embed = onlyEmbed(
      showReply(
        configReport({
          guild: configGuild({ fc_id: null }),
          capabilities: { officer_role_id: "Pick an ordinary role." },
        }),
        officer,
        { now },
      ),
    );
    expect(embed.description?.split("\n")[0]).toBe("No Free Company linked");
    expect(embed.description).toContain("Health: 1 problem. Run /config validate.");
    expect(fieldOf(embed, "Free Company")).toBe(
      "Not linked. /config fc link fc_id:<ID or Lodestone URL>",
    );
  });

  test("the widest layout uses more than ten fields and stays within its exemption (C3)", () => {
    // Every role and three channels set, the ledger unset, grandfathering completed: 15 fields,
    // with the changelog channel's field (2.25.0).
    const widest = showReply(
      configReport({
        guild: configGuild({
          ledger_channel_id: null,
          guest_grandfather: "completed",
          guest_grandfathered_at: at(-60),
          revision: 9_007_199_254_740_993n,
        }),
      }),
      officer,
      { now },
    );
    const embed = expectHouseStyle(widest, { maxFields: HOUSE_LIMITS.configShowFields });
    expect(embed.fields?.length).toBe(15);
    // The cap is exactly the widest layout: a fifth channel field would fail here, loudly.
    expect(embed.fields?.length).toBe(HOUSE_LIMITS.configShowFields);
    expect(embed.fields?.length).toBeGreaterThan(HOUSE_LIMITS.fields);
    expect(embed.footer?.text).toStartWith("Configuration revision 9007199254740993 · ");
    expect(visibleText(widest)).not.toContain("```json");
  });
});

describe("buttons", () => {
  test("show and validate re-check through config:validate; no configuration view offers details", () => {
    for (const [kind, reply] of Object.entries(CONFIG_CASES)) {
      const ids = buttonsOf(reply.render()).map((button) =>
        "custom_id" in button ? button.custom_id : "",
      );
      expect({ kind, details: ids.some((id) => id.startsWith("details:")) }).toEqual({
        kind,
        details: false,
      });
      if (kind.startsWith("show.") || kind.startsWith("validate."))
        expect({ kind, ids }).toEqual({ kind, ids: ["config:validate"] });
      else if (kind.startsWith("setup."))
        expect({ kind, ids }).toEqual({ kind, ids: ["sync:status"] });
      else expect({ kind, ids }).toEqual({ kind, ids: [] });
    }
  });
});

describe("configuration changes", () => {
  test("member and guest bindings show only the fields that apply", () => {
    const full = embedOf("role.set");
    expect(namesOf(full)).toEqual(["Replaced", "Discord changes", "Role layout", "Channel access"]);
    expect(fieldOf(full, "Replaced")).toBe(
      "<@&223456789012345699> is retired: TaruBot removes it from its current holders.",
    );
    const plainGuild = configGuild({ role_layout_enabled: false, access_policy_enabled: false });
    const bare = onlyEmbed(
      changeReply(configChange("guest_role_id", ROLE.guest, { guild: plainGuild }), officer, {
        now,
      }),
    );
    expect(bare.title).toBe("Guest role set");
    expect(bare.description).toContain("approved guests, members with a verified character");
    expect(namesOf(bare)).toEqual(["Discord changes"]);
    const held = onlyEmbed(
      changeReply(
        configChange("guest_role_id", ROLE.guest, { guild: plainGuild, requeued: 3 }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(held, "Held work")).toBe("`… QUEUED` 3 held jobs queued again");
  });

  test("an adopting Officer binding lists twenty holders, then '+N more', or says no one holds it", () => {
    const sample = Array.from(
      { length: 20 },
      (_, index) => `4234567890123456${String(index).padStart(2, "0")}`,
    );
    const many = changeReply(
      configChange("officer_role_id", ROLE.officer, {
        officerHolders: { adopt: true, adopted: 27, sample },
      }),
      manager,
      { now },
    );
    const embed = expectHouseStyle(many, { tone: "success", title: "Officer role set" });
    const adopted = fieldOf(embed, "Adopted holders") ?? "";
    expect(adopted.match(/<@\d+>/gu)).toHaveLength(20);
    expect(adopted).toEndWith(" +7 more");
    expect(embed.description).toContain("27 current holders were adopted");
    const none = onlyEmbed(
      changeReply(
        configChange("officer_role_id", ROLE.officer, {
          officerHolders: { adopt: true, adopted: 0, sample: [] },
        }),
        manager,
        { now },
      ),
    );
    expect(none.description).toEndWith("No one holds this role yet.");
    expect(fieldOf(none, "Adopted holders")).toBeUndefined();
    expect(fieldOf(none, "Officer access")).toBe("Manual grants + in-game rank **Officer**");
  });

  test("re-binding the same Officer role is the info no-op that adopts nobody", () => {
    const embed = embedOf("role.unchanged");
    expect(embed.description).toBe(
      "`= NO CHANGE` <@&223456789012345603> was already the Officer role. No holders were adopted.",
    );
    // Clearing a role that was never set is the same no-op.
    const cleared = onlyEmbed(
      changeReply(configChange("leader_role_id", null, { rebound: true }), manager, { now }),
    );
    expect(cleared).toMatchObject({
      title: "FC Leader role already unset",
      description: "`= NO CHANGE` No FC Leader role was set.",
    });
  });

  test("adopt_holders:false without a rank warns that only manual grants keep the role", () => {
    const embed = embedOf("role.officer_no_rank");
    expect(fieldOf(embed, "Officer rank")).toBe(
      "Not set. Run /config officer_rank rank:<name>, or only /officer grant confers Officer.",
    );
    expect(fieldOf(embed, "Who keeps the role")).toStartWith("Only people given /officer grant");
  });

  test("a leader without a linked FC, and every unset is success", () => {
    expect(fieldOf(embedOf("role.leader_no_fc"), "Free Company")).toBe(
      "Not linked, so no one can receive this role yet. Link one with /config fc link.",
    );
    for (const [field, label] of [
      ["member_role_id", "Member"],
      ["guest_role_id", "Guest"],
      ["officer_role_id", "Officer"],
      ["leader_role_id", "FC Leader"],
    ] as const) {
      const presented = changeReply(
        configChange(field, null, {
          previous: ROLE.previous,
          guild: configGuild({ access_policy_enabled: false }),
        }),
        manager,
        { now },
      );
      const embed = expectHouseStyle(presented, {
        tone: "success",
        title: `${label} role unset`,
      });
      expect(embed.description).toContain("<@&223456789012345699> is retired");
      expect(fieldOf(embed, "Discord changes")).toBe("`… QUEUED` Role removal");
    }
    expect(embedOf("role.cleared").description).toStartWith(
      "TaruBot no longer manages an Officer role.",
    );
  });

  test("channel settings and unsets, and every /config guest_applications receipt", () => {
    expect(embedOf("applications.no_role")).toMatchObject({
      title: "Guest applications on; Guest role still needed",
      description:
        "<#323456789012345603> will receive applications, but /apply stays closed until a Guest role is set.",
    });
    expect(embedOf("applications.closed").description).toBe(
      "/apply now refuses before the form opens: “Guest applications are not open in this server. Ask an officer about Guest access.”",
    );
    expect(embedOf("applications.open").description).toBe(
      "/apply is open. Each application is posted in <#323456789012345603> with Approve and Deny buttons.",
    );
    // A new channel for applications that were already open never says they opened.
    expect(embedOf("applications.review_changed")).toMatchObject({
      title: "Review channel changed",
      description:
        "New applications are posted in <#323456789012345603>. Applications already posted stay reviewable in their original channel.",
    });
    expect(embedOf("applications.review_set").description).toBe(
      "Applications will be posted in <#323456789012345603> once you turn them on with /config guest_applications enabled:true.",
    );
    expect(embedOf("applications.no_channel").title).toBe(
      "Guest applications on; review channel needed",
    );
    expect(embedOf("applications.unchanged").description).toBe(
      "`= NO CHANGE` Applications are already on, reviewed in <#323456789012345603>.",
    );
    // Channel set and switch on in one call is the open card, with the channel named once.
    const both = onlyEmbed(
      guestApplicationsReply(
        applications({ enabled: [false, true], channel: [null, CHANNEL.reviews] }),
        officer,
        { now },
      ),
    );
    expect(both.title).toBe("Guest applications open");
    expect(fieldOf(both, "Review channel")).toBeUndefined();
    // Switching off while unsetting the channel names the unset channel on the closed card.
    const closedUnset = onlyEmbed(
      guestApplicationsReply(
        applications({ enabled: [true, false], channel: [CHANNEL.reviews, null] }),
        officer,
        { now },
      ),
    );
    expect(closedUnset.title).toBe("Guest applications closed");
    expect(fieldOf(closedUnset, "Review channel")).toBe("Unset");
    expect(fieldOf(embedOf("channel.ledger_no_fc"), "Free Company")).toBe(
      "Not linked, so ledger commands stay unavailable. Link one with /config fc link.",
    );
    expect(embedOf("channel.notifications_cleared").description).toContain("skipped, not held");
  });

  test("fc link saved and unchanged, and unlink", () => {
    const linked = embedOf("fc.linked");
    expect(linked.description).toBe(
      "[Example Company «EXMPL»](https://na.finalfantasyxiv.com/lodestone/freecompany/9234567890123456789/) on Diabolos is now linked to this server. A roster read is queued; member access updates when it finishes.",
    );
    expect(fieldOf(linked, "Roster")).toBe("`… QUEUED` Lodestone read");
    expect(fieldOf(linked, "Ledger account")).toBe("`• SAVED` Ready");
    expect(embedOf("fc.unchanged").description).toBe(
      "`= NO CHANGE` FC `9234567890123456789` is already linked to this server.",
    );
    const unlinkedEmbed = embedOf("fc.unlinked");
    expect(unlinkedEmbed.description).toStartWith(
      "**Example Company** «EXMPL» is no longer linked.",
    );
    // Before the FC's record was read, the typed ID names it.
    expect(
      onlyEmbed(fcUnlinkReply(unlinked({ company: null }), officer, { fcId: CONFIG_FC.id, now }))
        .description,
    ).toStartWith("FC `9234567890123456789` is no longer linked.");
  });

  test("officer_rank heads-up, clear, and a rank escaped and capped", () => {
    expect(fieldOf(embedOf("rank.heads_up"), "Heads-up")).toBe(
      "No FC is linked, so this rank can't match anyone yet.\nNo Officer role is bound; bind one with /config roles officer.",
    );
    expect(fieldOf(embedOf("rank.cleared"), "Mode")).toBe("Manual grants only");
    const hostile = officerRankReply(rankResult({ officerRank: stress.text(1_000) }), manager, {
      now,
    });
    // User text never renders a mention: every '<@' in it stays backslash-escaped.
    expect(onlyEmbed(hostile).description).not.toMatch(UNESCAPED_MENTION);
    expectHouseStyle(hostile, { tone: "success" });
  });

  test("role_layout on names the order and its job; repeats are no-ops", () => {
    const on = embedOf("layout.on");
    expect(fieldOf(on, "Order")).toBe(
      "<@&223456789012345604> > <@&223456789012345603> > <@&223456789012345601> > <@&223456789012345602>",
    );
    expect(fieldOf(on, "Layout pass")).toBe("`… QUEUED` job `0b6f3c2e`");
    expect(
      onlyEmbed(
        roleLayoutReply(
          { status: "unchanged", roleLayout: "disabled", effectsMode: "live" },
          manager,
          {
            now,
          },
        ),
      ).title,
    ).toBe("Role layout is already off");
  });
});

describe("/config changelog (2.25.0)", () => {
  /** The changelog channel's mention, as receipts and checklists write it. */
  const mention = `<#${CHANNEL.changelog}>`;
  /** A guild with a changelog channel set (and its baseline), otherwise the configured guild. */
  const withChangelog = (overrides: Parameters<typeof configGuild>[0] = {}) =>
    configGuild({
      changelog_channel_id: CHANNEL.changelog,
      changelog_version: "2.25.0",
      ...overrides,
    });
  /** The Channels checklist section for a report. */
  const channels = (report: ReturnType<typeof configReport>) =>
    fieldOf(onlyEmbed(healthReply(report, officer, { now })), "Channels") ?? "";

  test("setting a channel promises the next update, never a post now, and asks for readers", () => {
    expect(embedOf("channel.changelog")).toEqual({
      color: 0x57f287,
      title: "Changelog channel set",
      description: `From the next update on, TaruBot posts what's new in ${mention}. Members and guests need to be able to read this channel.`,
      footer: { text: "Audited · configuration revision 43" },
      timestamp: NOW.toISOString(),
    });
  });

  test("a channel onboarding hides is a two-sentence warning; an unmanaged one gets Visibility", () => {
    const hidden = embedOf("channel.changelog_hidden");
    expect(hidden.description).toBe(
      `Onboarding keeps <#${CHANNEL.officers}> hidden from members and guests, so they won't see update posts there. Choose a channel they can read.`,
    );
    expect(hidden.fields ?? []).toEqual([]);
    const unmanaged = expectHouseStyle(
      changeReply({ ...R.changelogSet, audience: "unmanaged" }, officer, { now }),
      { tone: "success", title: "Changelog channel set" },
    );
    expect(fieldOf(unmanaged, "Visibility")).toBe(
      "Onboarding doesn't manage this channel (a new channel joins at the next repair pass), so make sure members and guests can read it.",
    );
    // With onboarding off there is no audience, so no Visibility field: admins own permissions.
    const plainGuild = onlyEmbed(
      changeReply(
        configChange("changelog_channel_id", CHANNEL.changelog, {
          guild: withChangelog({ access_policy_enabled: false }),
        }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(plainGuild, "Visibility")).toBeUndefined();
  });

  test("unsetting turns posts off and says missed updates aren't posted later", () => {
    expect(embedOf("channel.changelog_cleared")).toMatchObject({
      title: "Changelog posts turned off",
      description:
        "Updates released while no channel is set aren't posted later. Set a channel again to resume posts.",
    });
  });

  test("repeats are the no-op card, and a paused save is the #26 card with the receipt's sentence", () => {
    const again = expectHouseStyle(
      changeReply(
        configChange("changelog_channel_id", CHANNEL.changelog, {
          previous: CHANNEL.changelog,
          rebound: true,
        }),
        officer,
        { now },
      ),
      { tone: "info", title: "Changelog channel already set", timestamp: false },
    );
    expect(again.description).toBe(`\`= NO CHANGE\` ${mention} was already the changelog channel.`);
    // A channel onboarding shows to members (or a guild without onboarding) adds nothing.
    expect(fieldOf(again, "Visibility")).toBeUndefined();
    // Repeating a channel members may not read keeps the info no-op card, with the warning as a
    // Visibility field: choosing it again (say, to release a blocked post) still says so.
    const repeat = (audience: "hidden" | "unmanaged") =>
      expectHouseStyle(
        changeReply(
          configChange("changelog_channel_id", CHANNEL.changelog, {
            previous: CHANNEL.changelog,
            rebound: true,
            audience,
            guild: withChangelog(),
          }),
          officer,
          { now },
        ),
        { tone: "info", title: "Changelog channel already set", timestamp: false },
      );
    const hiddenAgain = repeat("hidden");
    expect(hiddenAgain.description).toBe(
      `\`= NO CHANGE\` ${mention} was already the changelog channel.`,
    );
    expect(fieldOf(hiddenAgain, "Visibility")).toBe(
      "Onboarding keeps this channel hidden from members and guests, so they won't see update posts there. Choose a channel they can read.",
    );
    expect(fieldOf(repeat("unmanaged"), "Visibility")).toBe(
      "Onboarding doesn't manage this channel (a new channel joins at the next repair pass), so make sure members and guests can read it.",
    );
    const unset = onlyEmbed(
      changeReply(configChange("changelog_channel_id", null, { rebound: true }), officer, { now }),
    );
    expect(unset).toMatchObject({
      title: "Changelog channel already unset",
      description: "`= NO CHANGE` No changelog channel was set.",
    });
    for (const mode of PAUSED_MODES) {
      const paused = expectHouseStyle(
        changeReply({ ...R.changelogSet, effectsMode: mode }, officer, { now }),
        { tone: "pending", title: "Saved, Discord changes paused", timestamp: false },
      );
      expect(paused.description).toStartWith(
        `From the next update on, TaruBot posts what's new in ${mention}.`,
      );
    }
  });

  test("validate: [OK], [FAIL], [OFF], and [WARN] for a hidden or unmanaged channel", () => {
    // Unset is [OFF] and no resource, so the approved counts don't change.
    expect(channels(configReport())).toContain(
      "[OFF] Changelog: not set, so update posts are skipped",
    );
    const ok = configReport({ guild: withChangelog(), changelogAudience: "members" });
    expect(channels(ok)).toContain(`[OK] Changelog ${mention}`);
    expect(configurationChecks(ok).filter((row) => row.resource)).toHaveLength(10);
    expect(onlyEmbed(healthReply(ok, officer, { now })).title).toBe(
      "Configuration health · all checks passed",
    );
    const hidden = configReport({ guild: withChangelog(), changelogAudience: "hidden" });
    expect(channels(hidden)).toContain(
      `[WARN] Changelog ${mention}: hidden from members and guests by onboarding`,
    );
    expect(onlyEmbed(healthReply(hidden, officer, { now })).title).toBe(
      "Configuration health · 1 warning",
    );
    expect(
      channels(configReport({ guild: withChangelog(), changelogAudience: "unmanaged" })),
    ).toContain(
      `[WARN] Changelog ${mention}: not managed by onboarding, so check that members and guests can read it`,
    );
    // A failing check outranks the audience: one [FAIL] line, no warning beside it.
    const failing = channels(
      configReport({
        guild: withChangelog(),
        changelogAudience: "hidden",
        capabilities: { changelog_channel_id: "TaruBot can't post there." },
      }),
    );
    expect(failing).toContain(`[FAIL] Changelog ${mention}: TaruBot can't post there.`);
    expect(failing).not.toContain("[WARN] Changelog");
    // Onboarding off: no audience is reported, and the channel is simply checked.
    expect(
      channels(configReport({ guild: withChangelog({ access_policy_enabled: false }) })),
    ).toContain(`[OK] Changelog ${mention}`);
  });

  test("show lists the changelog channel beside the other channels", () => {
    const set = onlyEmbed(showReply(configReport({ guild: withChangelog() }), officer, { now }));
    expect(fieldOf(set, "Changelog")).toBe(mention);
    expect(namesOf(set).slice(6, 10)).toEqual([
      "Ledger channel",
      "Officer notifications",
      "Guest applications",
      "Changelog",
    ]);
    // Only the changelog set: the channels are listed one by one, not collapsed.
    const alone = onlyEmbed(showReply(R.partial, officer, { now }));
    expect(fieldOf(alone, "Changelog")).toBeUndefined();
    const only = onlyEmbed(
      showReply(
        configReport({
          guild: {
            ...R.partial.configuration,
            changelog_channel_id: CHANNEL.changelog,
            changelog_version: "2.25.0",
          },
        }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(only, "Changelog")).toBe(mention);
    expect(fieldOf(only, "Ledger channel")).toBe("Not set");
  });
});

describe("effects modes (C5)", () => {
  /** Every receipt whose own effect is Discord work, rendered in a mode. */
  const DISCORD_WORK: readonly [string, (mode: EffectsMode) => ReturnType<typeof changeReply>][] = [
    ["fc link", (mode) => changeReply({ ...R.linked, effectsMode: mode }, officer, { now })],
    [
      "fc unlink",
      (mode) =>
        fcUnlinkReply(unlinked({ effectsMode: mode }), officer, { fcId: CONFIG_FC.id, now }),
    ],
    ["member role", (mode) => changeReply({ ...R.memberSet, effectsMode: mode }, officer, { now })],
    [
      "officer role",
      (mode) => changeReply({ ...R.officerAdopted, effectsMode: mode }, manager, { now }),
    ],
    [
      "role clear",
      (mode) =>
        changeReply(
          configChange("member_role_id", null, {
            previous: ROLE.member,
            effectsMode: mode,
            guild: configGuild({ access_policy_enabled: false }),
          }),
          officer,
          { now },
        ),
    ],
    [
      "officer rank",
      (mode) => officerRankReply(rankResult({ effectsMode: mode }), manager, { now }),
    ],
    ["role layout", (mode) => roleLayoutReply(layoutOn({ effectsMode: mode }), manager, { now })],
    ["setup", (mode) => setupReply(setupResult({ effectsMode: mode }), manager, { now })],
    [
      "officer grant",
      (mode) => officerOverrideReply(override({ effectsMode: mode }), manager, { now }),
    ],
  ];

  test("live receipts queue their work; paused ones are the approved paused-save card", () => {
    for (const [name, render] of DISCORD_WORK) {
      const live = onlyEmbed(render("live"));
      expect({ name, title: live.title }).not.toEqual({
        name,
        title: "Saved, Discord changes paused",
      });
      expect({ name, paused: JSON.stringify(live).includes("‖ PAUSED") }).toEqual({
        name,
        paused: false,
      });
      for (const mode of PAUSED_MODES) {
        const presented = render(mode);
        const embed = expectHouseStyle(presented, {
          tone: "pending",
          title: "Saved, Discord changes paused",
          timestamp: false,
        });
        expect({ name, mode, queued: JSON.stringify(embed).includes("… QUEUED` Server") }).toEqual({
          name,
          mode,
          queued: false,
        });
        expect(fieldOf(embed, "Discord changes")).toStartWith("`‖ PAUSED`");
        expect(namesOf(embed).slice(0, 2)).toEqual(["Saved", "Discord changes"]);
      }
    }
  });

  test("a paused channel setting is the #26 card with its own sentence; held work waits", () => {
    for (const mode of PAUSED_MODES) {
      const embed = expectHouseStyle(
        changeReply({ ...R.ledgerSet, effectsMode: mode }, officer, { now }),
        { tone: "pending", title: "Saved, Discord changes paused", timestamp: false },
      );
      expect(embed.footer?.text).toBe("Check progress any time with /sync status");
      // The receipt's own sentence leads, then the #26 sentence says when held work applies.
      expect(embed.description).toStartWith(
        `Ledger deposits, withdrawals, adjustments and initializations will be posted in <#${CHANNEL.ledger}>.`,
      );
      expect(namesOf(embed).slice(0, 2)).toEqual(["Saved", "Discord changes"]);
      expect(fieldOf(embed, "Held work")).toBe(
        mode === "awaiting_activation"
          ? "2 held jobs will retry once this server is activated"
          : "2 held jobs will retry once Discord changes are turned back on",
      );
    }
    expect(fieldOf(embedOf("channel.ledger"), "Held work")).toBe(
      "`… QUEUED` 2 held jobs queued again",
    );
  });

  test("a paused /setup keeps within ten fields by listing the rooms together", () => {
    const embed = embedOf("setup.paused");
    expect(namesOf(embed)).toEqual([
      "Saved",
      "Discord changes",
      "Access roles",
      "Rooms",
      "Free Company",
      "Officer rank",
      "Guest applications",
      "Officer notifications",
      "Role layout",
      "Next steps",
    ]);
    expect(fieldOf(embed, "Discord changes")).toBe(
      "`‖ PAUSED` until activation\nWhy: Server activation pending",
    );
    // Channel access is held with every other Discord change, so the first step says when it
    // runs instead of asking the manager to wait for a completion that can't come yet.
    for (const mode of PAUSED_MODES) {
      const paused = onlyEmbed(setupReply(setupResult({ effectsMode: mode }), VIEWERS.manager));
      expect(fieldOf(paused, "Next steps")).toStartWith(
        mode === "awaiting_activation"
          ? "1. Channel access is secured once this server is activated; until then /sync status shows it as paused."
          : "1. Channel access is secured once Discord changes are turned back on; until then /sync status shows it as paused.",
      );
      expect(paused.footer?.text).toBe("Check progress any time with /sync status");
    }
  });
});

describe("/setup and /officer", () => {
  test("a rerun that reused everything is 'Server setup refreshed' with the adopted count", () => {
    const embed = embedOf("setup.reused");
    expect(embed.description).toBe(
      "Existing roles and rooms were reused; nothing was duplicated. Channel permissions are being re-checked in the background.",
    );
    expect(fieldOf(embed, "Access roles")).toContain(
      "Officer <@&223456789012345603> · reused, 3 holders adopted as manual grants",
    );
    // With a ledger channel already set, the ledger step is left out.
    expect(fieldOf(embed, "Next steps")).toBe(
      "1. Run /sync status until channel access shows as completed.\n2. Run /config validate.",
    );
    const partly = onlyEmbed(
      setupReply(
        setupResult({
          roles: R.setup.roles.map((role, index) => ({ ...role, created: index === 0 })),
          lobby: { id: CHANNEL.lobby, created: true },
          officerChannel: { id: CHANNEL.officers, created: false },
          fcId: null,
          officerRank: null,
        }),
        manager,
        { now },
      ),
    );
    expect(partly.title).toBe("Server setup complete");
    expect(partly.description).toStartWith(
      "TaruBot created 1 access role and a lobby, and reused the rest.",
    );
    expect(fieldOf(partly, "Free Company")).toBe("Not linked · /config fc link");
    expect(fieldOf(partly, "Officer rank")).toBe("Not set · manual grants only");
  });

  test("an override that repeats, a departed member, and no Officer role yet", () => {
    expect(embedOf("officer.repeated").description).toBe(
      "`= NO CHANGE` <@423456789012345678> already had bot officer access, so only the reason was updated.",
    );
    expect(
      onlyEmbed(
        officerOverrideReply(override({ status: "revoked", previous: "revoked" }), manager, {
          now,
        }),
      ).description,
    ).toBe(
      "`= NO CHANGE` <@423456789012345678>'s officer access was already revoked, so only the reason was updated.",
    );
    expect(fieldOf(embedOf("officer.absent"), "Discord role")).toBe("Applies if they rejoin");
    const recorded = embedOf("officer.recorded");
    expect(recorded.description).toBe(
      "The officer grant for <@423456789012345678> is recorded. No Officer role is set yet, so it takes effect once /config roles officer binds one.",
    );
    expect(fieldOf(recorded, "Discord role")).toBe("Applies once an Officer role is set");
  });

  test("the reason is the manager's own text, escaped and capped at 300 characters", () => {
    const presented = officerOverrideReply(override({ reason: stress.text(1_000) }), manager, {
      now,
    });
    const reason = fieldOf(expectHouseStyle(presented), "Reason") ?? "";
    expect(reason.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    expect(reason).not.toMatch(UNESCAPED_MENTION);
  });
});

describe("configuration failures render as their approved concepts", () => {
  /** Render a failure for an audience from a command scope. */
  const refusal = (error: unknown, viewer: (typeof VIEWERS)[keyof typeof VIEWERS], scope: string) =>
    failureReply(error, { ref: REF, viewer, scope, now });
  const failure = (code: FailureCode, message: string, detail?: FailureDetail, retryAfter = 0) =>
    new Failure(code, message, retryAfter, detail);
  /** The error a guard throws. */
  const thrown = (guard: () => void): unknown => {
    try {
      guard();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the guard to refuse");
  };

  test("permission refusals", () => {
    const officers = expectFailure(
      refusal(
        thrown(() => authorize(ACTORS.member, ACTORS.member.guildId, "officer")),
        VIEWERS.member,
        "/config show",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Officers only" },
    );
    expect(officers.description).toStartWith("Only FC officers can use **/config**.");
    const managers = expectFailure(
      refusal(
        thrown(() => authorizeRoleManager(ACTORS.officer)),
        officer,
        "/config roles officer",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Server managers only" },
    );
    expect(fieldOf(managers, "Missing permission")).toBe("Manage Server and Manage Roles");
    const manageRoles = expectFailure(
      refusal(
        failure("forbidden", "Choosing access roles needs Discord's Manage Roles permission.", {
          kind: "scope",
          scope: "manage_roles",
        }),
        officer,
        "/config roles member",
      ),
      { code: "forbidden", ref: REF, title: "Server managers only" },
    );
    expect(fieldOf(manageRoles, "Missing permission")).toBe("Manage Roles");
    expectFailure(
      refusal(
        failure("forbidden", "Your highest Discord role must be above that role to select it.", {
          kind: "scope",
          scope: "hierarchy",
        }),
        manager,
        "/config roles officer",
      ),
      { code: "forbidden", ref: REF, title: "That role is above yours" },
    );
  });

  test("blocked roles and channels name what is affected for officers only", () => {
    const blocked = failure("blocked", `TaruBot can't manage <@&${ROLE.officer}>.`, {
      kind: "resource",
      resource: "role",
      id: ROLE.officer,
    });
    const embed = expectFailure(refusal(blocked, manager, "/config roles officer"), {
      code: "blocked",
      ref: REF,
      title: "Discord permissions need attention",
    });
    expect(fieldOf(embed, "Affected")).toBe(`<@&${ROLE.officer}> (\`${ROLE.officer}\`)`);
    const channel = expectFailure(
      refusal(
        failure("blocked", "TaruBot needs permissions there.", {
          kind: "resource",
          resource: "channel",
          id: CHANNEL.ledger,
        }),
        officer,
        "/config ledger",
      ),
      { code: "blocked", ref: REF, title: "Discord permissions need attention" },
    );
    expect(fieldOf(channel, "Affected")).toBe(`<#${CHANNEL.ledger}> (\`${CHANNEL.ledger}\`)`);
    expectFailure(refusal(blocked, VIEWERS.member, "/config roles officer"), {
      code: "blocked",
      ref: REF,
      title: "Server setup issue",
    });
  });

  test("/setup onboarding busy, conflict and ambiguity", () => {
    // Busy is the approved errors-and-style#10 wait concept, with setup's own sentence, which names
    // the /setup family: both subcommands share its lock (2.35.0).
    const busy = expectFailure(
      refusal(
        failure(
          "busy",
          "Another /setup for this server is in progress. Try again in a few seconds.",
        ),
        manager,
        "/setup onboarding",
      ),
      { code: "busy", ref: REF, tone: "pending", title: "Please wait a moment" },
    );
    expect(busy.description).toStartWith("Another /setup for this server is in progress.");
    const conflict = expectFailure(
      refusal(
        failure(
          "conflict",
          "Server settings changed during setup, so nothing was saved. Run /setup onboarding confirm:true again; anything already created is reused.",
        ),
        manager,
        "/setup onboarding",
      ),
      { code: "conflict", ref: REF, title: "Settings changed — try again" },
    );
    expect(conflict.description).toContain("anything already created is reused");
    expectFailure(
      refusal(
        failure("ambiguous", "Several roles match.", {
          kind: "matches",
          resource: "role",
          name: "Officer",
          ids: [ROLE.officer, ROLE.previous],
        }),
        manager,
        "/setup onboarding",
      ),
      { code: "ambiguous", ref: REF, title: "Choose which role to use" },
    );
    expectFailure(
      refusal(
        failure("ambiguous", "Several channels match lobby.", {
          kind: "matches",
          resource: "channel",
          name: "lobby",
          ids: [CHANNEL.lobby, CHANNEL.officers],
        }),
        manager,
        "/setup onboarding",
      ),
      { code: "ambiguous", ref: REF, title: "Choose which channel to use" },
    );
  });

  test("FC link, unlink and Lodestone refusals", () => {
    expectFailure(refusal(fcLinked(CONFIG_FC.id), officer, "/config fc link"), {
      code: "fc_linked",
      ref: REF,
      title: "Another FC is linked",
    });
    expectFailure(
      refusal(
        failure("not_found", "FC 1 isn't the linked Free Company.", {
          kind: "resource",
          resource: "fc_link",
          id: "1",
        }),
        officer,
        "/config fc unlink",
      ),
      { code: "not_found", ref: REF, title: "That FC isn't linked" },
    );
    expectFailure(
      refusal(
        failure("not_found", "Lodestone not found.", {
          kind: "resource",
          resource: "freecompany",
          id: CONFIG_FC.id,
        }),
        officer,
        "/config fc link",
      ),
      { code: "not_found", ref: REF, title: "Free Company not found" },
    );
    expectFailure(
      refusal(failure("unavailable", "The Lodestone is unavailable."), officer, "/config fc link"),
      { code: "unavailable", ref: REF, title: "The Lodestone isn't responding" },
    );
  });

  test("an incomplete member list suggests adopt_holders:false", () => {
    const embed = expectFailure(
      refusal(
        failure("unavailable", "Discord didn't return the complete member list.", {
          kind: "discord",
          what: "member_list",
        }),
        manager,
        "/config roles officer",
      ),
      { code: "unavailable", ref: REF, title: "Couldn't read the member list" },
    );
    expect(fieldOf(embed, "Tip")).toContain("adopt_holders:false");
  });

  test("/officer on an unconfigured server, and for someone who isn't a member", () => {
    expectFailure(
      refusal(
        failure("setup", "This server has no TaruBot configuration yet.", {
          kind: "setup",
          missing: "guild",
        }),
        manager,
        "/officer grant",
      ),
      { code: "setup", ref: REF, tone: "warning", title: "Finish setup first" },
    );
    expectFailure(
      refusal(
        failure("not_found", "That user isn't a current member of this server, or is a bot.", {
          kind: "resource",
          resource: "member",
          id: "423456789012345678",
        }),
        manager,
        "/officer grant",
      ),
      { code: "not_found", ref: REF, title: "Member not found" },
    );
  });

  test("the input rewrites reach 'Check your input'", () => {
    for (const [message, option, scope] of [
      ["Choose a role or set clear:true, not both.", "role", "/config roles member"],
      ["Give a rank name or set clear:true, not both.", "rank", "/config officer_rank"],
      [
        "Use adopt_holders only when choosing an Officer role, not with clear:true.",
        "adopt_holders",
        "/config roles officer",
      ],
      [
        "Member, Guest, Officer and FC Leader must be four different roles.",
        "role",
        "/config roles guest",
      ],
      // A self-service menu role can't become an access role (2.39.0).
      [ON_MENU, "role", "/config roles member"],
    ] as const) {
      const embed = expectFailure(
        refusal(failure("input", message, { kind: "option", option }), officer, scope),
        { code: "input", ref: REF, tone: "warning", title: "Check your input" },
      );
      expect(embed.description).toStartWith(message);
    }
  });
});

describe("stored Lodestone tags (2.14.0 reply session, D1)", () => {
  // The parser stores a tag as the Lodestone shows it, «EXMPL»; DevBot's /config show and
  // /config validate rendered ««Souls»» until presenters stripped the stored pair.
  const stored = { ...CONFIG_FC, tag: "«EXMPL»" };
  const tagged = configReport({ fc: fcRow({ tag: stored.tag }) });

  test("show, validate, link and unlink render exactly as with a bare tag", () => {
    const officer = { now: NOW };
    const pairs = [
      [showReply(R.healthy, VIEWERS.officer, officer), showReply(tagged, VIEWERS.officer, officer)],
      [
        healthReply(R.healthy, VIEWERS.officer, officer),
        healthReply(tagged, VIEWERS.officer, officer),
      ],
      [
        changeReply(R.linked, VIEWERS.officer, officer),
        changeReply(
          configChange("fc_id", CONFIG_FC.id, { company: stored }),
          VIEWERS.officer,
          officer,
        ),
      ],
      [
        fcUnlinkReply(R.unlinked, VIEWERS.officer, { fcId: CONFIG_FC.id, now: NOW }),
        fcUnlinkReply(unlinked({ company: stored }), VIEWERS.officer, {
          fcId: CONFIG_FC.id,
          now: NOW,
        }),
      ],
    ] as const;
    for (const [bare, fromLodestone] of pairs) {
      expect(visibleText(fromLodestone)).toBe(visibleText(bare));
      expect(visibleText(fromLodestone)).toContain("«EXMPL»");
      expect(visibleText(fromLodestone)).not.toMatch(/««|»»/u);
    }
  });
});

describe("officer rank repeats (2.15.0 review)", () => {
  test("a repeat names the saved rank and what is still missing, never access it can't give", () => {
    const repeat = rankResult({ status: "unchanged", effects: "unchanged", previous: "Officer" });
    const ready = onlyEmbed(officerRankReply(repeat, VIEWERS.manager, { now: NOW }));
    expect(ready.description).toContain("is already the saved officer rank.");
    expect(ready.description).toEndWith("Members who hold it already get bot officer access.");
    expect(fieldOf(ready, "Heads-up")).toBeUndefined();
    const unbound = onlyEmbed(
      officerRankReply({ ...repeat, officerRoleId: null }, VIEWERS.manager, { now: NOW }),
    );
    expect(unbound.description).not.toContain("get bot officer access");
    expect(fieldOf(unbound, "Heads-up")).toBe(
      "No Officer role is bound; bind one with /config roles officer.",
    );
    expectHouseStyle(officerRankReply({ ...repeat, officerRoleId: null }, VIEWERS.manager), {
      tone: "info",
      title: "Officer rank already set",
    });
  });
});
