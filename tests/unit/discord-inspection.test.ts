/**
 * Pure helpers behind the read-only production inspection and command maintenance: intent flags,
 * Discord's role order and permission/overwrite algorithm on raw REST payloads, the managed-role
 * hierarchy report, inventory diffs and command-path flattening.
 */
import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  type ApiOverwrite,
  type ApiRole,
  ascendingRoles,
  channelPermissions,
  commandPaths,
  guildPermissions,
  inventoryDiff,
  managedRoleReport,
  memberIntent,
  missingPermissions,
  requiredBotPermissions,
  targetReport,
  unlistedState,
  unlistedTargets,
} from "../../src/discord/inspection.js";

const GUILD = "100";
const BOT = "900";
const P = PermissionFlagsBits;
/** Build a raw role payload; permissions are a decimal bitfield string as Discord sends them. */
const role = (
  id: string,
  position: number,
  permissions = 0n,
  extra: Partial<ApiRole> = {},
): ApiRole => ({
  id,
  name: `role ${id}`,
  position,
  permissions: permissions.toString(),
  hoist: false,
  managed: false,
  ...extra,
});
const overwrite = (id: string, type: number, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type,
  allow: allow.toString(),
  deny: deny.toString(),
});

test("the Server Members intent decodes from application flags", () => {
  expect(memberIntent(1 << 14)).toBe("enabled");
  expect(memberIntent(1 << 15)).toBe("limited");
  expect(memberIntent((1 << 14) | (1 << 15) | 1)).toBe("enabled");
  expect(memberIntent(0)).toBe("disabled");
  expect(memberIntent(undefined)).toBe("disabled");
});

test("roles sort lowest first and equal positions put the higher ID lower, like discord.js", () => {
  const roles = [role("10", 1), role("300", 2), role("20", 1), role(GUILD, 0), role("9", 1)];
  expect(ascendingRoles(roles).map((entry) => entry.id)).toEqual([GUILD, "20", "10", "9", "300"]);
  // The input is not reordered in place.
  expect(roles.map((entry) => entry.id)).toEqual(["10", "300", "20", GUILD, "9"]);
});

describe("permissions", () => {
  const roles = [
    role(GUILD, 0, P.ViewChannel | P.SendMessages),
    role("200", 1, P.ManageRoles),
    role("300", 2, P.ManageNicknames),
    role("400", 3, P.Administrator),
  ];

  test("guild permissions union @everyone and the member's roles only", () => {
    const bits = guildPermissions(GUILD, roles, ["200"]);
    expect(bits).toBe(P.ViewChannel | P.SendMessages | P.ManageRoles);
    expect(guildPermissions(GUILD, roles, [])).toBe(P.ViewChannel | P.SendMessages);
  });

  test("Administrator implies everything unless it is being ignored", () => {
    expect(guildPermissions(GUILD, roles, ["200", "400"])).toBe(PermissionsBitField.All);
    expect(guildPermissions(GUILD, roles, ["200", "400"], { ignoreAdministrator: true })).toBe(
      P.ViewChannel | P.SendMessages | P.ManageRoles,
    );
  });

  test("channel overwrites apply @everyone, then roles, then the member", () => {
    const base = P.ViewChannel | P.SendMessages;
    const member = { id: BOT, roles: ["200"] };
    // @everyone loses View; the bot's role allows it back.
    const restricted = [overwrite(GUILD, 0, 0n, P.ViewChannel), overwrite("200", 0, P.ViewChannel)];
    expect(channelPermissions(GUILD, base, restricted, member) & P.ViewChannel).toBe(P.ViewChannel);
    // A role overwrite for a role the bot lacks does not apply.
    const other = [overwrite(GUILD, 0, 0n, P.ViewChannel), overwrite("300", 0, P.ViewChannel)];
    expect(channelPermissions(GUILD, base, other, member) & P.ViewChannel).toBe(0n);
    // A member-specific deny beats a role allow.
    const denied = [...restricted, overwrite(BOT, 1, 0n, P.ViewChannel)];
    expect(channelPermissions(GUILD, base, denied, member) & P.ViewChannel).toBe(0n);
  });

  test("Administrator bypasses channel overwrites unless it is being ignored", () => {
    const base = P.Administrator | P.ViewChannel;
    const denied = [overwrite(GUILD, 0, 0n, P.ViewChannel)];
    const member = { id: BOT, roles: [] };
    expect(channelPermissions(GUILD, base, denied, member)).toBe(PermissionsBitField.All);
    const without = channelPermissions(GUILD, base, denied, member, { ignoreAdministrator: true });
    expect(without & P.ViewChannel).toBe(0n);
    expect(without & P.Administrator).toBe(0n);
  });

  test("missing permissions are named", () => {
    expect(missingPermissions(P.ManageRoles | P.ViewChannel, requiredBotPermissions)).toEqual([
      "ManageNicknames",
      "SendMessages",
      "EmbedLinks",
      "AttachFiles",
      "ReadMessageHistory",
    ]);
    // The core seven (2.35.0): Manage Channels belongs to onboarding's permissions, not these.
    expect(Object.keys(requiredBotPermissions)).not.toContain("ManageChannels");
  });
});

describe("managed roles", () => {
  const member = { field: "member", id: "500" };
  const guest = { field: "guest", id: "600" };

  test("a Member role above the bot and a blocking permission are flagged", () => {
    const roles = [
      role(GUILD, 0),
      role("600", 1, 0n, { hoist: true }),
      role("700", 2, 0n, { name: "bot role", managed: true }),
      role("500", 3, P.ManageRoles, { hoist: true }),
    ];
    const report = managedRoleReport(GUILD, roles, ["700"], [member, guest]);
    expect(report.botHighest).toEqual({ id: "700", name: "bot role", position: 2 });
    expect(report.roles).toEqual([
      {
        field: "member",
        id: "500",
        name: "role 500",
        exists: true,
        position: 3,
        hoist: true,
        belowBot: false,
        blockingPermissions: ["ManageRoles"],
      },
      {
        field: "guest",
        id: "600",
        name: "role 600",
        exists: true,
        position: 1,
        hoist: true,
        belowBot: true,
        blockingPermissions: [],
      },
    ]);
    expect(report.layout.consecutive).toBe(false);
  });

  test("non-adjacent or unhoisted Member/Guest would change under a layout pass", () => {
    const top = role("900", 9, 0n, { managed: true });
    const apart = managedRoleReport(
      GUILD,
      [
        role(GUILD, 0),
        role("600", 1, 0n, { hoist: true }),
        role("650", 2),
        role("500", 3, 0n, { hoist: true }),
        top,
      ],
      ["900"],
      [member, guest],
    );
    expect(apart.layout).toEqual({
      hoisted: true,
      consecutive: false,
      wouldChange: true,
      blocked: null,
    });
    const flat = managedRoleReport(
      GUILD,
      [role(GUILD, 0), role("600", 1), role("500", 2, 0n, { hoist: true }), top],
      ["900"],
      [member, guest],
    );
    expect(flat.layout).toEqual({
      hoisted: false,
      consecutive: true,
      wouldChange: true,
      blocked: null,
    });
    const converged = managedRoleReport(
      GUILD,
      [
        role(GUILD, 0),
        role("600", 1, 0n, { hoist: true }),
        role("500", 2, 0n, { hoist: true }),
        top,
      ],
      ["900"],
      [member, guest],
    );
    expect(converged.layout).toEqual({
      hoisted: true,
      consecutive: true,
      wouldChange: false,
      blocked: null,
    });
    expect(converged.roles.every((entry) => entry.belowBot)).toBe(true);
  });

  test("a missing managed role is reported and blocks the layout plan", () => {
    const report = managedRoleReport(
      GUILD,
      [role(GUILD, 0), role("500", 1), role("900", 2)],
      ["900"],
      [member, guest],
    );
    expect(report.roles[1]).toMatchObject({ exists: false, position: null, belowBot: false });
    expect(report.layout.wouldChange).toBeNull();
    expect(report.layout.blocked).toContain("missing");
  });
});

test("the target report previews channel access with and without Administrator", () => {
  const roles = [
    role(GUILD, 0, P.ViewChannel | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory),
    role("700", 2, P.Administrator | P.ManageRoles | P.ManageNicknames | P.AttachFiles),
    role("500", 1),
  ];
  const report = targetReport({
    guildId: GUILD,
    roles,
    channels: [
      { id: "31", name: "ledger", type: 0, permission_overwrites: [] },
      {
        id: "32",
        name: "staff",
        type: 0,
        permission_overwrites: [overwrite(GUILD, 0, 0n, P.ViewChannel)],
      },
    ],
    bot: { id: BOT, roles: ["700"] },
    managedRoles: [{ field: "member", id: "500" }],
    channelTargets: [
      { field: "ledger", id: "31", imported: true },
      { field: "guest_applications", id: "32", imported: false },
      { field: "officer_notifications", id: "33", imported: true },
    ],
  });
  expect(report.administrator).toBe(true);
  expect(report.permissions).toContain("Administrator");
  expect(report.missingRequired).toEqual([]);
  expect(report.withoutAdministrator.missingRequired).toEqual([]);
  expect(report.managedRoles[0]?.belowBot).toBe(true);
  const [ledger, staff, missing] = report.channels;
  expect(ledger).toMatchObject({ exists: true, imported: true });
  expect(ledger?.withoutAdministrator.view).toBe(true);
  // The staff room hides from @everyone: only Administrator lets the bot see it today.
  expect(staff?.bot.view).toBe(true);
  expect(staff?.withoutAdministrator.view).toBe(false);
  expect(staff?.imported).toBe(false);
  expect(missing).toMatchObject({ exists: false, state: "unchecked", name: null, type: null });
  expect(missing?.bot.view).toBe(false);
  expect(ledger?.state).toBe("listed");
});

test("a destination missing from the list reads as hidden (or another server's) or deleted, as Discord answered (#47)", () => {
  // Without Administrator, and from 2026-11-16 in any case, the channel list leaves out every
  // channel the bot can't view, so a missing destination is not necessarily deleted.
  const roles = [role(GUILD, 0, P.ViewChannel | P.SendMessages), role("700", 2, P.ManageRoles)];
  const channels = [{ id: "31", name: "ledger", type: 0, permission_overwrites: [] }];
  const channelTargets = [
    { field: "ledger", id: "31", imported: true },
    { field: "officer_notifications", id: "33", imported: true },
    { field: "guest_applications", id: "34", imported: false },
    { field: "changelog", id: "35", imported: null },
    { field: "status", id: "36", imported: null },
  ];
  // Only the unlisted IDs are probed, each once.
  expect(
    unlistedTargets(
      [...channelTargets, { field: "officer_notifications", id: "33", imported: true }],
      channels,
    ),
  ).toEqual(["33", "34", "35", "36"]);
  expect([
    unlistedState({ ok: false, code: 50001 }, GUILD),
    unlistedState({ ok: false, code: 10003 }, GUILD),
    unlistedState({ ok: true, guildId: "999" }, GUILD),
    unlistedState({ ok: true, guildId: GUILD }, GUILD),
    unlistedState({ ok: false, code: 0 }, GUILD),
    unlistedState({ ok: false }, GUILD),
  ]).toEqual(["hidden_or_other_server", "deleted", "other_server", null, null, null]);
  const report = targetReport({
    guildId: GUILD,
    roles,
    channels,
    bot: { id: BOT, roles: ["700"] },
    managedRoles: [],
    channelTargets,
    unlisted: { "33": "hidden_or_other_server", "34": "deleted", "35": "other_server" },
  });
  expect(report.administrator).toBe(false);
  expect(
    report.channels.map(({ id, state, exists, name }) => ({ id, state, exists, name })),
  ).toEqual([
    { id: "31", state: "listed", exists: true, name: "ledger" },
    // 50001 can't tell a hidden channel from another server's, so it isn't claimed to exist here.
    { id: "33", state: "hidden_or_other_server", exists: false, name: null },
    { id: "34", state: "deleted", exists: false, name: null },
    { id: "35", state: "other_server", exists: false, name: null },
    { id: "36", state: "unchecked", exists: false, name: null },
  ]);
  // A hidden destination has no readable overwrites, so its access reads as none.
  expect(report.channels[1]?.bot.view).toBe(false);
});

test("inventory diffs report both directions, sorted and de-duplicated", () => {
  expect(inventoryDiff(["b", "a", "c"], ["c", "d", "d", "a"])).toEqual({
    missing: ["b"],
    unexpected: ["d"],
  });
  expect(inventoryDiff([], [])).toEqual({ missing: [], unexpected: [] });
});

test("command paths flatten subcommand groups and stop at argument options", () => {
  const options = [
    {
      type: 2,
      name: "roles",
      options: [
        { type: 1, name: "member", options: [{ type: 8, name: "role" }] },
        { type: 1, name: "guest" },
      ],
    },
    { type: 1, name: "show" },
  ];
  expect(commandPaths("config", options)).toEqual([
    "config roles member",
    "config roles guest",
    "config show",
  ]);
  expect(commandPaths("claim", [{ type: 3, name: "character" }])).toEqual(["claim"]);
  expect(commandPaths("ping")).toEqual(["ping"]);
});
