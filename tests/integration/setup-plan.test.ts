/**
 * /setup onboarding's dry run (2.35.0, #46) end to end: RoleAdministration.planSetup over real
 * PostgreSQL, with DiscordGuildAccess over the access fixture (tests/fixtures/discord-access.ts),
 * which spies on REST and never logs in. The dry run writes nothing anywhere (no Discord write,
 * no ensureRole, no row, job or audit), and lists every refusal the real run would stop at, each
 * channel separately, while saying what it would create, reuse, rename and change. The test is
 * confined to its own schema, setup_plan_it, and uses the fixture's invented IDs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { GuildAccess } from "../../src/application/guild-access.js";
import type { MemberView } from "../../src/application/records.js";
import {
  RoleAdministration,
  type RoleProvisioner,
} from "../../src/application/role-administration.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import { DENY_MASK } from "../../src/domain/permissions.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { discordAccessFixture } from "../fixtures/discord-access.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "setup_plan_it";
/** The fixture's server and its owner. */
const GUILD = "100";
const OWNER = "300";
/** Invented Free Company IDs. */
const LINKED_FC = "9230000000000000101";
const OTHER_FC = "9230000000000000102";

const CONFIG: Configuration = {
  DATABASE_URL: url ?? "postgresql://unused/unused",
  DISCORD_TOKEN: "test-only",
  DISCORD_APPLICATION_ID: "123",
  LOG_LEVEL: "error",
  ENABLE_EFFECTS: true,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: false,
  ROSTER_INTERVAL_SECONDS: 21600,
  VERIFICATION_SECONDS: 1800,
  GUEST_COOLDOWN_SECONDS: 86400,
  HEALTH_PORT: 3000,
  GITHUB_REPORTS_TOKEN: "",
  GITHUB_REPORTS_REPO: "deconfined/tarubot-reports",
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_PRIVATE_KEY: "",
  HEALTHCHECKS_PING_URL: "",
};
/** The Lodestone answers the company lookup for a new FC; the dry run reads nothing else there. */
const LODESTONE = {
  company: async (id: string) => ({
    id,
    name: "Example Free Company",
    tag: "EXFC",
    world: "Diabolos",
    dc: "Crystal",
    count: 3,
  }),
} as unknown as Lodestone;

const MANAGER: Actor = {
  guildId: GUILD,
  userId: OWNER,
  officer: true,
  manageRoles: true,
  serverManager: true,
};
/** @everyone may not view. */
const PRIVATE = () => [
  { id: GUILD, type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
];

/** A member as the gateway lists them. */
const member = (id: string, roles: string[], bot = false): MemberView => ({
  id,
  guildId: GUILD,
  joinedAt: new Date("2026-09-01T00:00:00Z"),
  nickname: null,
  roles,
  bot,
});

describe.skipIf(!url)("/setup onboarding's dry run", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  let fixture: ReturnType<typeof discordAccessFixture>;
  let administration: RoleAdministration;
  /** What the provisioner was asked, and which roles its validateRole refuses. */
  let calls: string[];
  let refusedRoles: Set<string>;
  let members: MemberView[];

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE guilds, users, jobs, audit, free_companies CASCADE");
    fixture = discordAccessFixture();
    calls = [];
    refusedRoles = new Set();
    members = [];
    const unused = async (): Promise<never> => {
      throw new Error("Not used by the dry run");
    };
    const provisioner: RoleProvisioner = {
      member: unused,
      members: async () => {
        calls.push("members");
        return members;
      },
      validateRole: async (_guild, role, actor) => {
        calls.push(`validateRole ${role} ${actor ?? ""}`);
        if (refusedRoles.has(role))
          throw new Failure(
            "blocked",
            `TaruBot can't manage <@&${role}>. Its own role must be above that role, and it needs Manage Roles.`,
            0,
            { kind: "resource", resource: "role", id: role, fix: "hierarchy" },
          );
      },
      validateChannel: async (_guild, channel) => {
        calls.push(`validateChannel ${channel}`);
      },
      roles: unused,
      layoutRoles: unused,
      nickname: unused,
      send: unused,
      editReview: unused,
      dm: unused,
      ensureRole: async () => {
        calls.push("ensureRole");
        throw new Error("The dry run must never create a role");
      },
    };
    const service = new Service(db, provisioner, LODESTONE, CONFIG);
    administration = new RoleAdministration(
      service,
      provisioner,
      new GuildAccess(service, fixture.port),
    );
  });
  afterEach(async () => {
    await fixture.close();
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  /** Nothing anywhere was written: no Discord write, no role, row, job or audit. */
  async function nothingWritten() {
    expect(fixture.writes).toEqual([]);
    expect(fixture.puts).toEqual([]);
    expect(calls).not.toContain("ensureRole");
    expect(await db.orm.select().from(t.guilds)).toEqual([]);
    expect(await db.orm.select().from(t.jobs)).toEqual([]);
    expect(await db.orm.select().from(t.auditEvents)).toEqual([]);
  }

  test("a new server: what it would create, reuse and rename, the count, and no write at all", async () => {
    // Role names: 'member' (renamed to the canonical label), 'Guest' (reused as is), 'officer'
    // (renamed, with two holders adopted); no FC Leader role yet, so one is created.
    const guest = fixture.roles.find((role) => role.id === "202");
    if (guest) guest.name = "Guest";
    const lobby = fixture.add("lobby");
    // Private areas TaruBot's role can see, as onboarding needs.
    const seen = { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" };
    const officers = fixture.add("officer-chat", ChannelType.GuildText, [
      ...PRIVATE(),
      { id: "203", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      seen,
    ]);
    const general = fixture.add("general");
    const category = fixture.add("staff", ChannelType.GuildCategory, [...PRIVATE(), seen]);
    fixture.add("staff-chat", ChannelType.GuildText, [], category.id);
    members = [
      member("403", ["201", "203"]),
      member("404", ["203"]),
      member("900", ["600", "203"], true),
      member("401", ["201"]),
    ];
    const plan = await administration.planSetup(MANAGER, "", null, "Officer");
    expect(plan.blockers).toEqual([]);
    expect(plan.roles).toEqual([
      { field: "member_role_id", name: "Member", action: "rename", id: "201" },
      { field: "guest_role_id", name: "Guest", action: "reuse", id: "202" },
      { field: "officer_role_id", name: "Officer", action: "rename", id: "203" },
      { field: "leader_role_id", name: "FC Leader", action: "create", id: null },
    ]);
    expect(plan.lobby).toEqual({ action: "reuse", id: lobby.id });
    expect(plan.officerRoom).toEqual({ action: "reuse", id: officers.id });
    // A role still to be created is new in every managed channel, so all of them change.
    expect(plan.onboarding).toEqual({
      alreadyOn: false,
      channels: 5,
      sample: [lobby.id, officers.id, general.id, category.id, String(Number(category.id) + 1)],
      everyoneLosesView: true,
    });
    expect(plan.adopt).toBe(2);
    expect(plan).toMatchObject({
      guestApplications: { switchesOn: true, channel: null },
      officerNotifications: { channel: officers.id, defaulted: true },
      fc: { id: null, company: null },
      officerRank: "Officer",
      // A server first configured here starts with the role layout off (CFG-07, 2.35.0).
      roleLayout: false,
      effectsMode: "live",
    });
    // Reused roles are checked as ensureRole would, with the manager's hierarchy.
    expect(calls).toEqual([
      `validateRole 201 ${OWNER}`,
      `validateRole 202 ${OWNER}`,
      `validateRole 203 ${OWNER}`,
      "members",
    ]);
    await nothingWritten();
  });

  test("rooms to create, a kept review channel checked, and an existing server's own settings", async () => {
    const reviews = fixture.add("reviews");
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      effects_enabled: true,
      guest_application_channel_id: reviews.id,
      guest_applications_enabled: false,
      officer_notifications_channel_id: reviews.id,
      officer_role_id: "203",
      officer_rank_name: "Captain",
      officer_rank_key: "captain",
    });
    const plan = await administration.planSetup(MANAGER, "EXFC", null, null);
    expect(plan.blockers).toEqual([]);
    expect(plan.lobby).toEqual({ action: "create", id: null });
    expect(plan.officerRoom).toEqual({ action: "create", id: null });
    expect(plan.roles.map((role) => [role.name, role.action])).toEqual([
      ["EXFC Member", "rename"],
      ["EXFC Guest", "rename"],
      ["EXFC Officer", "rename"],
      ["EXFC FC Leader", "create"],
    ]);
    // The officer role is the one already bound, so nobody is adopted.
    expect(plan.adopt).toBe(0);
    expect(calls).toContain(`validateChannel ${reviews.id}`);
    expect(plan).toMatchObject({
      guestApplications: { switchesOn: true, channel: reviews.id },
      officerNotifications: { channel: reviews.id, defaulted: false },
      officerRank: "Captain",
      // An existing row keeps its own switch (the column default here).
      roleLayout: true,
    });
    expect(fixture.writes).toEqual([]);
  });

  test("every blocker at once: fc_linked, a bad role hierarchy and two hidden channels", async () => {
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: LINKED_FC, name: "Linked", world: "Diabolos" });
    await db.orm.insert(t.guilds).values({ id: GUILD, effects_enabled: true, fc_id: LINKED_FC });
    // The Member role sits above TaruBot's role.
    const high = fixture.roles.find((role) => role.id === "201");
    if (high) high.position = 9;
    refusedRoles.add("201");
    const first = fixture.add("secret-one", ChannelType.GuildText, PRIVATE());
    const second = fixture.add("secret-two", ChannelType.GuildText, PRIVATE());
    fixture.add("lobby");
    const plan = await administration.planSetup(MANAGER, "", OTHER_FC, null);
    expect(plan.blockers.map((blocker) => [blocker.code, blocker.message])).toEqual([
      [
        "fc_linked",
        `This server is linked to FC ${LINKED_FC}. Unlink it with /config fc unlink fc_id:${LINKED_FC}, then link the new one. History and ledgers are kept.`,
      ],
      [
        "blocked",
        "TaruBot can't manage <@&201>. Its own role must be above that role, and it needs Manage Roles.",
      ],
      [
        "blocked",
        "Each access role must be an ordinary role below TaruBot without management permissions. Run /setup onboarding again to repair.",
      ],
      [
        "blocked",
        `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${first.id}>.`,
      ],
      [
        "blocked",
        `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${second.id}>.`,
      ],
    ]);
    for (const [index, channel] of [first, second].entries())
      expect(plan.blockers[3 + index]?.detail).toEqual({
        kind: "resource",
        resource: "channel",
        id: channel.id,
        fix: "channel_permissions",
      });
    // The new FC was still looked up, and the rest of the plan read.
    expect(plan.fc).toEqual({
      id: OTHER_FC,
      company: { id: OTHER_FC, name: "Example Free Company", tag: "EXFC", world: "Diabolos" },
    });
    expect(fixture.writes).toEqual([]);
    expect(calls).not.toContain("ensureRole");
  });

  test("a channel an earlier /setup overrides masked is its own member-entry blocker", async () => {
    const masked = fixture.add("masked", ChannelType.GuildText, [
      {
        id: "900",
        type: OverwriteType.Member,
        allow: String(P.ViewChannel),
        deny: String(DENY_MASK),
      },
    ]);
    fixture.add("lobby");
    const plan = await administration.planSetup(MANAGER, "", null, null);
    expect(plan.blockers).toEqual([
      {
        code: "blocked",
        message: `TaruBot's member entry in <#${masked.id}> denies Manage Channels and Manage Permissions; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels and Manage Permissions there.`,
        detail: { kind: "resource", resource: "channel", id: masked.id, fix: "member_entry" },
      },
    ]);
    // With Administrator the same channel passes.
    fixture.botAdministrator(true);
    expect((await administration.planSetup(MANAGER, "", null, null)).blockers).toEqual([]);
  });

  test("ambiguous rooms and a scope it can't read leave the rooms unknown", async () => {
    fixture.add("lobby");
    fixture.add("Lobby");
    const plan = await administration.planSetup(MANAGER, "", null, null);
    expect(plan.lobby).toEqual({ action: "unknown", id: null });
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous"]);
    // The Community Updates channel isn't cached: the whole scope is unknown.
    fixture.community.updatesChannelId = "999999999999999999";
    const unknown = await administration.planSetup(MANAGER, "", null, null);
    expect(unknown.onboarding).toMatchObject({ channels: null, everyoneLosesView: null });
    expect(unknown.officerRoom).toEqual({ action: "unknown", id: null });
    expect(unknown.blockers.map((blocker) => blocker.code)).toEqual(["blocked"]);
  });

  test("the caller's own refusals stay thrown", async () => {
    await expect(
      administration.planSetup({ ...MANAGER, manageRoles: false }, "", null, null),
    ).rejects.toMatchObject({ code: "forbidden", detail: { kind: "scope", scope: "manager" } });
    await expect(
      administration.planSetup(MANAGER, "x".repeat(51), null, null),
    ).rejects.toMatchObject({ code: "input", detail: { kind: "option", option: "prefix" } });
    // A manager without Manage Channels, by the fixture's member 301's roles without it.
    const manager = fixture.roles.find((role) => role.id === "700");
    if (manager) manager.permissions = String(P.ManageGuild | P.ManageRoles);
    await expect(
      administration.planSetup({ ...MANAGER, userId: "301" }, "", null, null),
    ).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "manage_channels" },
    });
  });
});
