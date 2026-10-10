/**
 * The Role menu's writes (2.39.0) over real PostgreSQL: SelfRoles.edit's locks, revision and audit
 * rows, the equal-state rule, conflicts and refusals, the shutdown rollback, two officers editing at
 * once; the invariant that a menu role is never an access role, in configure() and /setup
 * onboarding; the "Role menu" health check in validate(); and members' role choices left by 2.40.0
 * after a rollback: the dispatcher stub and the schedule pass close them, the migration's trigger
 * clears each, officers' job views, /guest status and issue reports never name the member, and the
 * pass reaches them through migration 012's partial indexes. Any officer may make every change,
 * with no Discord permission check (owner decision, 2026-10-09). The Discord port records every
 * call: web edits read Discord, never write to it. Confined to its own schema, self_roles_it, with
 * invented IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import { GuildAccess } from "../../src/application/guild-access.js";
import type { DiscordPort, MemberView } from "../../src/application/records.js";
import { IssueReports } from "../../src/application/issue-reports.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import {
  RoleAdministration,
  type RoleProvisioner,
} from "../../src/application/role-administration.js";
import {
  ON_MENU,
  type SelfRoleEditOutcome,
  type SelfRoleEditRequest,
  SelfRoles,
} from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type { Configuration } from "../../src/config/env.js";
import type { ApiRole } from "../../src/domain/permissions.js";
import type { Actor } from "../../src/domain/policy.js";
import { EMPTY_MENU, type MenuOperation, SELF_ROLE_MESSAGES } from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import type { VisibilityChannel, VisibilityGuild } from "../../src/domain/visibility.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import { enqueue, Queue } from "../../src/jobs/queue.js";
import { FakeGuildAccess } from "../fixtures/guild-access.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "self_roles_it";
const GUILD = "666666666666666792";
/** Invented role IDs: the four access roles, TaruBot's role and candidates. */
const ROLE = {
  member: "523456789012345601",
  guest: "523456789012345602",
  officer: "523456789012345603",
  leader: "523456789012345604",
  retired: "523456789012345605",
  pronoun: "523456789012345611",
  game: "523456789012345612",
  kick: "523456789012345613",
  spare: "523456789012345614",
  bot: "523456789012345690",
} as const;
const CHANNEL = { general: "623456789012345601", hidden: "623456789012345602" } as const;
const CATEGORY = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const OTHER_CATEGORY = "0b6f3c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

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

/** The server manager: Manage Server and Manage Roles. */
const MANAGER: Actor = {
  guildId: GUILD,
  userId: "723456789012345601",
  officer: true,
  manageRoles: true,
  serverManager: true,
};
/** A delegated officer (the Officer role with rank access): no Discord permissions at all. */
const DELEGATED: Actor = {
  guildId: GUILD,
  userId: "723456789012345602",
  officer: true,
  manageRoles: false,
  serverManager: false,
};
const MEMBER: Actor = {
  guildId: GUILD,
  userId: "723456789012345603",
  officer: false,
  manageRoles: false,
};

const role = (id: string, position: number, permissions = 0n, managed = false): ApiRole => ({
  id,
  name: `role ${id}`,
  position,
  permissions: String(permissions),
  hoist: false,
  managed,
});
const EVERYONE = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect;

/** The server as TaruBot sees it; `unreadable` adds a channel whose overwrites are obfuscated. */
function snapshot(unreadable = false): VisibilityGuild {
  const channels: VisibilityChannel[] = [
    {
      id: CHANNEL.general,
      type: ChannelType.GuildText,
      parentId: null,
      position: 0,
      overwrites: [],
      obfuscated: false,
    },
  ];
  if (unreadable)
    channels.push({
      id: CHANNEL.hidden,
      type: ChannelType.GuildText,
      parentId: null,
      position: 1,
      overwrites: [],
      obfuscated: true,
    });
  return {
    guildId: GUILD,
    bot: { id: "823456789012345601", roles: [ROLE.bot], botRoleId: ROLE.bot },
    roles: [
      role(GUILD, 0, EVERYONE),
      role(ROLE.member, 1),
      role(ROLE.guest, 2),
      role(ROLE.retired, 3),
      role(ROLE.pronoun, 4),
      role(ROLE.game, 5),
      role(ROLE.spare, 6),
      // The lowest moderation role: every menu role must sit below it.
      role(ROLE.kick, 7, P.KickMembers),
      role(ROLE.officer, 8),
      role(ROLE.leader, 9),
      role(ROLE.bot, 20, P.ManageRoles, true),
    ],
    channels,
    heldRoles: [],
    communityUpdatesId: null,
  };
}

describe.skipIf(!url)("self-service role menu writes", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  /** Every Discord call, by method and freshness: edits may read, never write. */
  let calls: string[];
  /** What the next visibility read returns. */
  let view: VisibilityGuild | null;
  /** The lifecycle's shutdown flag, as SelfRoles reads it each time. */
  let stopping: () => boolean;
  const unused = async (): Promise<never> => {
    throw new Error("Discord writes are not expected here");
  };
  const discord: DiscordPort = {
    member: unused,
    members: async () => {
      calls.push("members");
      return [];
    },
    validateRole: async () => {
      calls.push("validateRole");
    },
    validateChannel: async () => {
      calls.push("validateChannel");
    },
    roles: unused,
    layoutRoles: unused,
    nickname: unused,
    send: unused,
    editReview: unused,
    dm: unused,
    visibility: async (_guild, fresh) => {
      calls.push(`visibility ${fresh ? "fresh" : "cache"}`);
      return view;
    },
  };
  const app = new Service(db, discord, {} as Lodestone, CONFIG);
  const selfRoles = new SelfRoles(app, () => stopping());
  const edit = (actor: Actor, revision: bigint, operation: MenuOperation) =>
    selfRoles.edit(actor, { revision, operation } satisfies SelfRoleEditRequest);
  const create = (categoryId = CATEGORY, name = "Pronouns"): MenuOperation => ({
    op: "category.create",
    categoryId,
    name,
    description: "",
    max: 1,
  });
  const add = (roleIds: string[], unreadableAcknowledged = false): MenuOperation => ({
    op: "options.add",
    categoryId: CATEGORY,
    roleIds,
    unreadableAcknowledged,
  });
  const stored = async () => {
    const [row] = await db.orm
      .select({ menu: t.selfRoleMenus.menu, revision: t.selfRoleMenus.revision })
      .from(t.selfRoleMenus)
      .where(eq(t.selfRoleMenus.guild_id, GUILD));
    return row;
  };
  const audits = () =>
    db.orm
      .select({
        actor: t.auditEvents.actor_id,
        action: t.auditEvents.action,
        target: t.auditEvents.target,
        details: t.auditEvents.details,
      })
      .from(t.auditEvents)
      .where(eq(t.auditEvents.guild_id, GUILD))
      .orderBy(asc(t.auditEvents.id));
  const guildRevision = async () =>
    (
      await db.orm
        .select({ revision: t.guilds.revision })
        .from(t.guilds)
        .where(eq(t.guilds.id, GUILD))
    )[0]?.revision;
  const saved = (outcome: SelfRoleEditOutcome): bigint => {
    if (outcome.status !== "saved") throw new Error(`Expected saved, got ${outcome.status}`);
    return outcome.revision;
  };

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.close();
    await admin.close();
  });
  beforeEach(async () => {
    await db.query(
      "TRUNCATE guilds, users, jobs, audit, retired_roles, channel_access_policies, self_role_menus, delivery_attempts CASCADE",
    );
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      member_role_id: ROLE.member,
      guest_role_id: ROLE.guest,
      officer_role_id: ROLE.officer,
      leader_role_id: ROLE.leader,
      effects_enabled: true,
      role_layout_enabled: false,
      revision: 7n,
    });
    await db.orm
      .insert(t.retiredRoles)
      .values({ guild_id: GUILD, role_id: ROLE.retired, revision: 3n });
    calls = [];
    view = snapshot();
    stopping = () => false;
  });

  test("an edit bumps the menu's revision, writes one exact audit row, and nothing else", async () => {
    // Parked work stays parked: a menu edit requeues nothing (unlike a /config save).
    const parked = await enqueue(db.pool, "reconcile.user", `user:${GUILD}:1`, {}, GUILD, "1");
    await db.orm.update(t.jobs).set({ status: "blocked" }).where(eq(t.jobs.id, parked));
    const before = await selfRoles.editor(DELEGATED);
    expect(before).toMatchObject({
      configured: true,
      revision: 1n,
      menu: EMPTY_MENU,
      unreadableChannels: 0,
      administrator: false,
      memberRoleId: ROLE.member,
      onboarding: false,
      effectsMode: "live",
    });
    expect(before.roles?.find((check) => check.roleId === ROLE.pronoun)?.problems).toEqual([]);
    expect(before.roles?.find((check) => check.roleId === ROLE.member)?.problems[0]?.code).toBe(
      "access_role",
    );
    expect(await edit(DELEGATED, 1n, create())).toEqual({ status: "saved", revision: 2n });
    expect(await edit(DELEGATED, 2n, add([ROLE.pronoun, ROLE.game]))).toEqual({
      status: "saved",
      revision: 3n,
    });
    const row = await stored();
    expect(row?.revision).toBe(3n);
    expect(row?.menu).toEqual({
      v: 1,
      categories: [
        {
          id: CATEGORY,
          name: "Pronouns",
          description: "",
          max: 1,
          state: "draft",
          options: [
            { roleId: ROLE.pronoun, description: "", removalOnly: false },
            { roleId: ROLE.game, description: "", removalOnly: false },
          ],
        },
      ],
    });
    // Configuration identifiers only; the revision is the menu's after the edit.
    expect(await audits()).toEqual([
      {
        actor: DELEGATED.userId,
        action: "self_roles",
        target: "category.create",
        details: { revision: "2", categoryId: CATEGORY, max: 1 },
      },
      {
        actor: DELEGATED.userId,
        action: "self_roles",
        target: "options.add",
        details: { revision: "3", categoryId: CATEGORY, roleIds: [ROLE.pronoun, ROLE.game] },
      },
    ]);
    // The reconciliation fence and the queue are untouched: a menu edit changes nobody's roles.
    expect(await guildRevision()).toBe(7n);
    expect(await db.orm.select({ id: t.jobs.id, status: t.jobs.status }).from(t.jobs)).toEqual([
      { id: parked, status: "blocked" },
    ]);
    // The editor read the cache; the add read a fresh view. Nothing else reached Discord.
    expect(calls).toEqual(["visibility cache", "visibility fresh"]);
  });

  test("every other edit writes its own exact audit row", async () => {
    saved(await edit(DELEGATED, 1n, create()));
    saved(await edit(DELEGATED, 2n, create(OTHER_CATEGORY, "Games")));
    saved(await edit(DELEGATED, 3n, add([ROLE.pronoun, ROLE.game, ROLE.spare])));
    const before = (await audits()).length;
    saved(
      await edit(DELEGATED, 4n, {
        op: "category.edit",
        categoryId: CATEGORY,
        name: "Pronouns",
        description: "Pick yours",
        max: 3,
      }),
    );
    saved(await edit(DELEGATED, 5n, { op: "category.move", categoryId: OTHER_CATEGORY, to: 0 }));
    saved(
      await edit(DELEGATED, 6n, {
        op: "category.setState",
        categoryId: CATEGORY,
        state: "published",
      }),
    );
    // Only the drafts left: Games.
    saved(await edit(DELEGATED, 7n, { op: "menu.publishAll" }));
    // The first option removed, the others untouched: only the removal is recorded, though the
    // options after it moved up a place.
    saved(
      await edit(DELEGATED, 8n, {
        op: "options.edit",
        categoryId: CATEGORY,
        rows: [
          { roleId: ROLE.pronoun, description: "", position: 1, state: "remove" },
          { roleId: ROLE.game, description: "", position: 2, state: "offered" },
          { roleId: ROLE.spare, description: "", position: 3, state: "offered" },
        ],
      }),
    );
    // Spare moved first and no longer offered; Game moved down a place by it.
    saved(
      await edit(DELEGATED, 9n, {
        op: "options.edit",
        categoryId: CATEGORY,
        rows: [
          { roleId: ROLE.game, description: "", position: 2, state: "offered" },
          { roleId: ROLE.spare, description: "", position: 1, state: "removal_only" },
        ],
      }),
    );
    // Its roles in option order.
    saved(await edit(DELEGATED, 10n, { op: "category.delete", categoryId: CATEGORY }));
    const row = (target: string, details: Record<string, unknown>) => ({
      actor: DELEGATED.userId,
      action: "self_roles",
      target,
      details,
    });
    expect((await audits()).slice(before)).toEqual([
      row("category.edit", { revision: "5", categoryId: CATEGORY, max: 3 }),
      row("category.move", { revision: "6", categoryId: OTHER_CATEGORY, to: 0 }),
      row("category.setState", { revision: "7", categoryId: CATEGORY, state: "published" }),
      row("menu.publishAll", { revision: "8", categoryIds: [OTHER_CATEGORY] }),
      row("options.edit", {
        revision: "9",
        categoryId: CATEGORY,
        changes: { [ROLE.pronoun]: "removed" },
      }),
      row("options.edit", {
        revision: "10",
        categoryId: CATEGORY,
        changes: { [ROLE.game]: "edited", [ROLE.spare]: "not_offered" },
      }),
      row("category.delete", {
        revision: "11",
        categoryId: CATEGORY,
        roleIds: [ROLE.spare, ROLE.game],
      }),
    ]);
  });

  test("a double submit is the same success, and a stale form that changes something is a 409", async () => {
    saved(await edit(MANAGER, 1n, create()));
    // The same create again (a double tap): the category exists, so nothing is written.
    expect(await edit(MANAGER, 1n, create())).toEqual({ status: "unchanged", revision: 2n });
    saved(
      await edit(MANAGER, 2n, {
        op: "category.edit",
        categoryId: CATEGORY,
        name: "Pronouns",
        description: "Pick one",
        max: 1,
      }),
    );
    // Another officer's form from revision 2 that would change something else.
    expect(
      await edit(DELEGATED, 2n, {
        op: "category.setState",
        categoryId: CATEGORY,
        state: "published",
      }),
    ).toEqual({ status: "conflict", reason: "changed" });
    // The same stale form asking for what is already there succeeds without a write.
    expect(
      await edit(DELEGATED, 2n, { op: "category.setState", categoryId: CATEGORY, state: "draft" }),
    ).toEqual({ status: "unchanged", revision: 3n });
    // A category another officer deleted is a conflict too; deleting it again is not.
    saved(await edit(MANAGER, 3n, { op: "category.delete", categoryId: CATEGORY }));
    expect(await edit(DELEGATED, 4n, { op: "category.move", categoryId: CATEGORY, to: 0 })).toEqual(
      { status: "conflict", reason: "changed" },
    );
    expect(await edit(DELEGATED, 3n, { op: "category.delete", categoryId: CATEGORY })).toEqual({
      status: "unchanged",
      revision: 4n,
    });
    expect(await audits()).toHaveLength(3);
    // Validation is per field, and nothing is written.
    expect(
      await edit(MANAGER, 4n, { ...create(OTHER_CATEGORY), name: "Pro‮nouns" } as MenuOperation),
    ).toEqual({
      status: "invalid",
      errors: [{ field: "name", message: "Remove hidden formatting characters." }],
    });
    expect((await stored())?.revision).toBe(4n);
  });

  test("adds are checked against a fresh view, with bound and retired roles read under the lock", async () => {
    saved(await edit(DELEGATED, 1n, create()));
    const refused = await edit(DELEGATED, 2n, add([ROLE.member, ROLE.retired, ROLE.kick]));
    expect(refused.status).toBe("invalid");
    if (refused.status !== "invalid") return;
    expect(refused.errors.map((error) => error.field)).toEqual(["roleIds", "roleIds", "roleIds"]);
    expect(refused.errors[0]?.message).toBe(
      `<@&${ROLE.member}> can't be added. It's TaruBot's Member role. Access roles can't be on the role menu.`,
    );
    expect(refused.errors[1]?.message).toStartWith(
      `<@&${ROLE.retired}> can't be added. It used to be`,
    );
    expect(refused.errors[2]?.message).toContain("Kick Members");
    // A role dragged above the moderation roles since the editor was read: the fresh view refuses
    // it, naming the role to move it below.
    view = {
      ...snapshot(),
      roles: snapshot().roles.map((candidate) =>
        candidate.id === ROLE.pronoun ? { ...candidate, position: 10 } : candidate,
      ),
    };
    expect(await edit(DELEGATED, 2n, add([ROLE.pronoun]))).toEqual({
      status: "invalid",
      errors: [
        {
          field: "roleIds",
          message: `<@&${ROLE.pronoun}> can't be added. It's above <@&${ROLE.kick}>, which has Kick Members, so people with that role couldn't kick anyone who picks it. Move it below <@&${ROLE.kick}>.`,
        },
      ],
    });
    view = snapshot();
    // A role bound since the view was read is refused under the lock, though the view passed it.
    await db.orm.update(t.guilds).set({ guest_role_id: ROLE.spare }).where(eq(t.guilds.id, GUILD));
    expect((await edit(DELEGATED, 2n, add([ROLE.spare]))).status).toBe("invalid");
    expect((await stored())?.revision).toBe(2n);
    // No view of the server: an add can't be checked, so it refuses before the transaction.
    view = null;
    await expect(edit(DELEGATED, 2n, add([ROLE.pronoun]))).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("channels TaruBot can't read need the officer's confirmation, which the audit records", async () => {
    saved(await edit(DELEGATED, 1n, create()));
    view = snapshot(true);
    expect(await edit(DELEGATED, 2n, add([ROLE.pronoun]))).toEqual({
      status: "invalid",
      errors: [{ field: "acknowledged", message: SELF_ROLE_MESSAGES.acknowledge(1) }],
    });
    expect(await edit(DELEGATED, 2n, add([ROLE.pronoun], true))).toEqual({
      status: "saved",
      revision: 3n,
    });
    expect((await audits()).at(-1)?.details).toEqual({
      revision: "3",
      categoryId: CATEGORY,
      roleIds: [ROLE.pronoun],
      unreadableChannels: 1,
    });
    expect((await selfRoles.editor(MANAGER)).unreadableChannels).toBe(1);
  });

  test("any officer may edit, with no Discord permission check; anyone else is refused", async () => {
    // A delegated officer with no Discord permissions adds a role: no Manage Roles requirement,
    // no check of their own role position.
    saved(await edit(DELEGATED, 1n, create()));
    saved(await edit(DELEGATED, 2n, add([ROLE.pronoun])));
    await expect(edit(MEMBER, 3n, create(OTHER_CATEGORY))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(selfRoles.editor(MEMBER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      edit({ ...DELEGATED, guildId: "666666666666666793" }, 3n, create(OTHER_CATEGORY)),
    ).rejects.toMatchObject({ code: "setup" });
  });

  test("a menu this build can't read is never edited; any officer may reset it, audited", async () => {
    saved(await edit(DELEGATED, 1n, create()));
    // As a newer release might have written it before a rollback.
    await db.query("UPDATE self_role_menus SET menu=$1::jsonb WHERE guild_id=$2", [
      JSON.stringify({ v: 2, categories: [], groups: [ROLE.game] }),
      GUILD,
    ]);
    const editor = await selfRoles.editor(DELEGATED);
    expect(editor.menu).toBeNull();
    expect(await edit(DELEGATED, 2n, create(OTHER_CATEGORY))).toEqual({
      status: "conflict",
      reason: "unreadable",
    });
    expect(await edit(DELEGATED, 2n, { op: "menu.reset" })).toEqual({
      status: "saved",
      revision: 3n,
    });
    expect((await stored())?.menu).toEqual(EMPTY_MENU);
    expect((await audits()).at(-1)).toEqual({
      actor: DELEGATED.userId,
      action: "self_roles",
      target: "menu.reset",
      details: { revision: "3", unreadable: true },
    });
    // The same reset again (a double tap, or a second officer): the menu is already empty.
    expect(await edit(MANAGER, 2n, { op: "menu.reset" })).toEqual({
      status: "unchanged",
      revision: 3n,
    });
    // A reset of a menu that reads fine, even at its current revision, would wipe it: refused.
    saved(await edit(DELEGATED, 3n, create()));
    expect(await edit(DELEGATED, 4n, { op: "menu.reset" })).toEqual({
      status: "conflict",
      reason: "changed",
    });
    expect((await stored())?.revision).toBe(4n);
    expect((await audits()).map((row) => row.target)).toEqual([
      "category.create",
      "menu.reset",
      "category.create",
    ]);
  });

  test("shutdown refuses an edit, and one it overtakes rolls back whole", async () => {
    saved(await edit(MANAGER, 1n, create()));
    stopping = () => true;
    await expect(edit(MANAGER, 2n, add([ROLE.pronoun]))).rejects.toMatchObject({
      code: "stopping",
      retryAfter: 30,
    });
    // Not stopping at the start, stopping by the pre-commit check.
    let checks = 0;
    stopping = () => ++checks > 1;
    await expect(edit(MANAGER, 2n, add([ROLE.pronoun]))).rejects.toMatchObject({
      code: "stopping",
    });
    expect(checks).toBe(2);
    expect((await stored())?.revision).toBe(2n);
    expect(await audits()).toHaveLength(1);
  });

  test("two officers saving different changes at once: exactly one conflict", async () => {
    saved(await edit(MANAGER, 1n, create()));
    const outcomes = await Promise.all([
      edit(MANAGER, 2n, { op: "category.setState", categoryId: CATEGORY, state: "published" }),
      edit(DELEGATED, 2n, {
        op: "category.edit",
        categoryId: CATEGORY,
        name: "Pronouns",
        description: "Changed",
        max: null,
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["conflict", "saved"]);
    expect((await stored())?.revision).toBe(3n);
    expect(await audits()).toHaveLength(2);
  });

  test("an edit waits for configure()'s lock on the guild row", async () => {
    saved(await edit(MANAGER, 1n, create()));
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM guilds WHERE id=$1 FOR UPDATE", [GUILD]);
      let settled = false;
      const pending = edit(MANAGER, 2n, add([ROLE.pronoun])).finally(() => {
        settled = true;
      });
      await Bun.sleep(300);
      expect(settled).toBeFalse();
      await holder.query("COMMIT");
      expect(saved(await pending)).toBe(3n);
    } finally {
      holder.release();
    }
  });

  test("an edit checks the bound roles under the lock: a binding committed while it waited refuses it", async () => {
    saved(await edit(MANAGER, 1n, create()));
    const holder = await db.pool.connect();
    try {
      // configure() binding the role the edit is about to add, holding the row as it does. The
      // editor's view passed the role; only a check that reads the guild row (and the settings)
      // after taking FOR SHARE sees the new binding.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM guilds WHERE id=$1 FOR UPDATE", [GUILD]);
      await holder.query("UPDATE guilds SET guest_role_id=$2 WHERE id=$1", [GUILD, ROLE.pronoun]);
      let settled = false;
      const pending = edit(MANAGER, 2n, add([ROLE.pronoun])).finally(() => {
        settled = true;
      });
      await Bun.sleep(300);
      expect(settled).toBeFalse();
      await holder.query("COMMIT");
      const outcome = await pending;
      expect(outcome.status).toBe("invalid");
      if (outcome.status !== "invalid") return;
      expect(outcome.errors[0]?.message).toBe(
        `<@&${ROLE.pronoun}> can't be added. It's TaruBot's Guest role. Access roles can't be on the role menu.`,
      );
    } finally {
      holder.release();
    }
    expect((await stored())?.revision).toBe(2n);
  });

  test("configure() checks the menu under its lock: a menu edit committed while it waited refuses it", async () => {
    saved(await edit(MANAGER, 1n, create()));
    const holder = await db.pool.connect();
    try {
      // A menu edit adding the role configure() is about to bind, holding the guild row FOR SHARE
      // as SelfRoles.edit does. Only a menu read after configure()'s FOR UPDATE sees it.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM guilds WHERE id=$1 FOR SHARE", [GUILD]);
      await holder.query(
        "UPDATE self_role_menus SET menu=$2::jsonb, revision=revision+1 WHERE guild_id=$1",
        [
          GUILD,
          JSON.stringify({
            v: 1,
            categories: [
              {
                id: CATEGORY,
                name: "Pronouns",
                description: "",
                max: 1,
                state: "draft",
                options: [{ roleId: ROLE.spare, description: "", removalOnly: false }],
              },
            ],
          }),
        ],
      );
      let settled = false;
      const pending = app.configure(MANAGER, "guest_role_id", ROLE.spare).finally(() => {
        settled = true;
      });
      // Catch the refusal now, so it isn't unhandled while the holder still waits to commit.
      const refusal = pending.then(
        () => null,
        (error: unknown) => error,
      );
      await Bun.sleep(300);
      expect(settled).toBeFalse();
      await holder.query("COMMIT");
      expect(await refusal).toMatchObject({ code: "input", message: ON_MENU });
    } finally {
      holder.release();
    }
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, GUILD));
    expect(row?.guest_role_id).toBe(ROLE.guest);
  });

  test("configure() refuses to bind a menu role as an access role, even from a menu it can't read", async () => {
    saved(await edit(MANAGER, 1n, create()));
    saved(await edit(MANAGER, 2n, add([ROLE.pronoun])));
    await expect(app.configure(MANAGER, "guest_role_id", ROLE.pronoun)).rejects.toMatchObject({
      code: "input",
      message: ON_MENU,
    });
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, GUILD));
    expect(row?.guest_role_id).toBe(ROLE.guest);
    expect(row?.revision).toBe(7n);
    // A role not on the menu binds as before.
    expect((await app.configure(MANAGER, "guest_role_id", ROLE.spare)).status).toBe("saved");
    // An unreadable menu still names its roles somewhere: fail closed.
    await db.query("UPDATE self_role_menus SET menu=$1::jsonb WHERE guild_id=$2", [
      JSON.stringify({ v: 2, categories: [], somewhere: { deep: [ROLE.game] } }),
      GUILD,
    ]);
    await expect(app.configure(MANAGER, "member_role_id", ROLE.game)).rejects.toMatchObject({
      message: ON_MENU,
    });
    // A newer menu might key its options by role: a role ID held only as a key counts too.
    await db.query("UPDATE self_role_menus SET menu=$1::jsonb WHERE guild_id=$2", [
      JSON.stringify({ v: 2, categories: [], options: { [ROLE.pronoun]: { description: "" } } }),
      GUILD,
    ]);
    await expect(app.configure(MANAGER, "member_role_id", ROLE.pronoun)).rejects.toMatchObject({
      message: ON_MENU,
    });
    const [after] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, GUILD));
    expect(after?.member_role_id).toBe(ROLE.member);
  });

  test("/setup onboarding names a menu role it would reuse, and refuses it before changing anything", async () => {
    saved(await edit(MANAGER, 1n, create()));
    saved(await edit(MANAGER, 2n, add([ROLE.pronoun])));
    // A role named "Member" that officers put on the menu: setup would reuse it by name, under
    // any prefix (the canonical name matches too), and rename it to the prefixed name.
    const access = new FakeGuildAccess();
    access.roleLists.set(GUILD, [{ id: ROLE.pronoun, name: "Member" }]);
    const ensured: string[] = [];
    const provisioner: RoleProvisioner = {
      ...discord,
      members: async (): Promise<MemberView[]> => [],
      async ensureRole(_guild, name) {
        ensured.push(name);
        return name.endsWith("Member")
          ? { id: ROLE.pronoun, created: false }
          : { id: `5234567890123457${String(name.length).padStart(2, "0")}`, created: true };
      },
    };
    const administration = new RoleAdministration(app, provisioner, new GuildAccess(app, access));
    const plan = await administration.planSetup(MANAGER, "", null, null);
    expect(plan.blockers).toContainEqual({
      code: "input",
      message: `<@&${ROLE.pronoun}> is on the self-service role menu, so /setup onboarding can't use it as the Member role. Remove it on the Role menu page first, rename it in Discord, or choose the access role with /config roles first.`,
      detail: { kind: "resource", resource: "role", id: ROLE.pronoun },
    });
    for (const prefix of ["", "FC"]) {
      const refusal = administration.setup(MANAGER, prefix, null, null);
      await expect(refusal).rejects.toBeInstanceOf(Failure);
      await expect(refusal).rejects.toMatchObject({
        code: "input",
        detail: { kind: "resource", resource: "role", id: ROLE.pronoun },
      });
    }
    // Refused before any role was created or renamed, before onboarding wrote any channel, and
    // nothing was saved.
    expect(ensured).toEqual([]);
    expect(access.writes).toEqual([]);
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, GUILD));
    expect(row?.member_role_id).toBe(ROLE.member);
    expect(row?.access_policy_enabled).toBe(false);
    // The same from a menu this build can't read that holds the role only as an object key.
    await db.query("UPDATE self_role_menus SET menu=$1::jsonb WHERE guild_id=$2", [
      JSON.stringify({ v: 2, categories: [], options: { [ROLE.pronoun]: { description: "" } } }),
      GUILD,
    ]);
    expect((await administration.planSetup(MANAGER, "", null, null)).blockers).toContainEqual(
      expect.objectContaining({ detail: { kind: "resource", resource: "role", id: ROLE.pronoun } }),
    );
    await expect(administration.setup(MANAGER, "", null, null)).rejects.toMatchObject({
      code: "input",
      detail: { kind: "resource", resource: "role", id: ROLE.pronoun },
    });
    expect(ensured).toEqual([]);
  });

  test("validate() reports the Role menu from the same fresh view", async () => {
    saved(await edit(MANAGER, 1n, create()));
    saved(await edit(MANAGER, 2n, add([ROLE.pronoun, ROLE.game])));
    saved(await edit(MANAGER, 3n, { op: "menu.publishAll" }));
    // Kick Members granted after the role was added: the health check sees it.
    view = {
      ...snapshot(true),
      roles: snapshot().roles.map((candidate) =>
        candidate.id === ROLE.game
          ? { ...candidate, permissions: String(P.KickMembers) }
          : candidate,
      ),
    };
    calls = [];
    const report = await app.validate(MANAGER);
    expect(report.selfRoles).toEqual({
      listed: 2,
      problems: 1,
      unreadableChannels: 1,
      unreadableMenu: false,
    });
    expect(calls.filter((call) => call.startsWith("visibility"))).toEqual(["visibility fresh"]);
  });

  test("2.39.0 completes a roles.self job as skipped, and the trigger clears its payload", async () => {
    const choice = {
      chosen: [ROLE.pronoun],
      offered: [ROLE.pronoun, ROLE.game],
      savedAt: "2026-10-09T12:00:00.000Z",
    };
    const id = await enqueue(
      db.pool,
      "roles.self",
      `self-roles:${GUILD}:${MEMBER.userId}`,
      choice,
      GUILD,
      MEMBER.userId,
    );
    const run = dispatcher(
      app,
      new Synchronization(app),
      new GuildAccess(app, new FakeGuildAccess()),
    );
    const queue = new Queue(db, run, () => {});
    const job = await queue.claim();
    expect(job?.id).toBe(id);
    expect(job?.payload).toEqual(choice);
    if (!job) return;
    await queue.perform(job);
    const [row] = await db.orm
      .select({ status: t.jobs.status, payload: t.jobs.payload, result: t.jobs.result })
      .from(t.jobs)
      .where(eq(t.jobs.id, id));
    expect(row).toEqual({
      status: "succeeded",
      payload: {},
      result: { skipped: "needs a newer TaruBot" },
    });
    expect(await db.orm.$count(t.deliveryAttempts, and(eq(t.deliveryAttempts.job_id, id)))).toBe(0);
    expect(calls).toEqual([]);
  });

  test("2.39.0's schedule pass closes every waiting role choice at once, and the trigger clears each", async () => {
    // A server TaruBot left: Queue.claim() never takes its work, so only the pass can close it.
    const left = "666666666666666793";
    await db.orm.insert(t.guilds).values({ id: left, active: false });
    const choice = {
      chosen: [ROLE.pronoun],
      offered: [ROLE.pronoun, ROLE.game],
      savedAt: "2026-10-09T12:00:00.000Z",
    };
    /** Each waiting state, as the SET clause that puts a fresh job in it. */
    const states = {
      queued: "due_at=now()+interval '1 hour'",
      blocked: "status='blocked', due_at=now(), last_error='blocked: invented'",
      disabled: "status='disabled', last_error='disabled: invented'",
      lapsed:
        "status='running', lease_token=gen_random_uuid(), lease_until=now()-interval '1 second'",
      leaseless: "status='running'",
      live: "status='running', lease_token=gen_random_uuid(), lease_until=now()+interval '1 minute'",
    } as const;
    let user = 0;
    /** A job of `kind` for a user of its own, in `guild`, put in a state by `set`. */
    const job = async (kind: string, set: string, guild = GUILD) => {
      const owner = String(++user);
      const payload = kind === "roles.self" ? choice : { characterId: "1" };
      const id = await enqueue(db.pool, kind, `${kind}:${guild}:${owner}`, payload, guild, owner);
      await db.query(`UPDATE jobs SET ${set} WHERE id=$1`, [id]);
      return id;
    };
    const choices: Record<string, string> = {};
    const others: string[] = [];
    for (const [state, set] of Object.entries(states)) {
      choices[state] = await job("roles.self", set);
      // The same state for another kind, which the pass must leave alone.
      others.push(await job("reconcile.user", set));
    }
    choices.left = await job("roles.self", states.queued, left);
    // A finished role choice, inside the 30-day retention, keeps its row and its end time.
    const finished = await job(
      "roles.self",
      "status='succeeded', completed_at=now()-interval '29 days'",
    );
    type Row = {
      id: string;
      status: string;
      payload: unknown;
      result: unknown;
      lease_until: Date | null;
      last_error: string | null;
      completed_at: Date | null;
    };
    const rows = async () =>
      Object.fromEntries(
        (
          await db.query<Row>(
            "SELECT id, kind, status, payload, result, lease_until, last_error, completed_at, due_at FROM jobs",
          )
        ).map((row) => [row.id, row]),
      );
    /** What closing changes on a row, compared exactly: a cleared payload is `{}` and nothing more. */
    const ending = (row: Row | undefined) =>
      row && {
        status: row.status,
        payload: row.payload,
        result: row.result,
        lease_until: row.lease_until,
        last_error: row.last_error,
        ended: row.completed_at instanceof Date,
      };
    const closed = {
      status: "succeeded",
      payload: {},
      result: { skipped: "needs a newer TaruBot" },
      lease_until: null,
      last_error: null,
      ended: true,
    };
    const before = await rows();
    for (const id of Object.values(choices)) expect(before[id]?.payload).toEqual(choice);
    const sync = new Synchronization(app);
    await sync.schedule();
    const after = await rows();
    // Every waiting change, whatever holds it, closed with its role IDs gone; but not the one a
    // live lease holds, which a worker is completing.
    for (const state of ["queued", "blocked", "disabled", "lapsed", "leaseless", "left"])
      expect(ending(after[choices[state] ?? ""])).toEqual(closed);
    expect(after[choices.live ?? ""]).toEqual(before[choices.live ?? ""]);
    // Other kinds in the same states, and finished role choices, are untouched.
    for (const id of [...others, finished]) expect(after[id]).toEqual(before[id]);
    // A repeat changes nothing.
    await sync.schedule();
    expect(await rows()).toEqual(after);
    // Once the live lease runs out, the next pass closes that one too.
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
      choices.live,
    ]);
    await sync.schedule();
    expect(ending((await rows())[choices.live ?? ""])).toEqual(closed);
    expect(calls).toEqual([]);
  });

  test("officers see a member's role choices as 'a member', never who (Q4 A)", async () => {
    const choice = {
      chosen: [ROLE.pronoun],
      offered: [ROLE.pronoun],
      savedAt: "2026-10-09T12:00:00Z",
    };
    const member = await enqueue(
      db.pool,
      "roles.self",
      `self-roles:${GUILD}:${MEMBER.userId}`,
      choice,
      GUILD,
      MEMBER.userId,
    );
    const own = await enqueue(
      db.pool,
      "roles.self",
      `self-roles:${GUILD}:${MANAGER.userId}`,
      choice,
      GUILD,
      MANAGER.userId,
    );
    const other = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${GUILD}:${MEMBER.userId}`,
      {},
      GUILD,
      MEMBER.userId,
    );
    const users = async (actor: Actor) =>
      Object.fromEntries(
        (await app.syncStatus(actor, null)).work.map((job) => [job.id, job.user_id]),
      );
    // An officer: someone else's role choices without the user; their own, and other work, with.
    expect(await users(DELEGATED)).toEqual({
      [member]: null,
      [own]: null,
      [other]: MEMBER.userId,
    });
    expect(await users(MANAGER)).toEqual({
      [member]: null,
      [own]: MANAGER.userId,
      [other]: MEMBER.userId,
    });
    // A member sees only their own work, their own name on it.
    expect(await users(MEMBER)).toEqual({ [member]: MEMBER.userId, [other]: MEMBER.userId });
  });

  test("the schedule pass deletes finished role choices after 30 days, and nothing else", async () => {
    const job = (kind: string, user: string) =>
      enqueue(db.pool, kind, `${kind}:${GUILD}:${user}`, {}, GUILD, user);
    const finish = (id: string, status: "succeeded" | "failed", days: number) =>
      db.query("UPDATE jobs SET status=$2, completed_at=now()-$3*interval '1 day' WHERE id=$1", [
        id,
        status,
        days,
      ]);
    const expired = await job("roles.self", "1");
    const failed = await job("roles.self", "2");
    const recent = await job("roles.self", "3");
    const waiting = await job("roles.self", "4");
    const history = await job("reconcile.user", "5");
    await finish(expired, "succeeded", 31);
    await finish(failed, "failed", 31);
    await finish(recent, "succeeded", 29);
    await db.query("UPDATE jobs SET created_at=now()-interval '40 days' WHERE id=$1", [waiting]);
    await finish(history, "succeeded", 31);
    await new Synchronization(app).schedule();
    const left = await db.orm.select({ id: t.jobs.id }).from(t.jobs);
    expect(left.map((row) => row.id).sort()).toEqual([recent, waiting, history].sort());
  });

  test("/guest status and an issue report's member section never list a member's role choices, for anyone (Q4 A)", async () => {
    // The member's reconcile.user, then a dozen newer role choices, finished as 2.40.0 leaves them.
    const reconcile = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${GUILD}:${MEMBER.userId}`,
      {},
      GUILD,
      MEMBER.userId,
    );
    await db.query(
      "UPDATE jobs SET status='succeeded', completed_at=now(), created_at=now()-interval '1 hour' WHERE id=$1",
      [reconcile],
    );
    for (let save = 0; save < 12; save++) {
      const id = await enqueue(
        db.pool,
        "roles.self",
        `self-roles:${GUILD}:${MEMBER.userId}`,
        { chosen: [ROLE.pronoun], offered: [ROLE.pronoun], savedAt: "2026-10-09T12:00:00.000Z" },
        GUILD,
        MEMBER.userId,
      );
      await db.query("UPDATE jobs SET status='succeeded', completed_at=now() WHERE id=$1", [id]);
    }
    expect(await db.orm.$count(t.jobs, eq(t.jobs.kind, "roles.self"))).toBe(12);
    // Any officer, delegated ones included, and the member: the record's deliveries, and with them
    // its card, its health and its Full details (JSON), hold the reconcile.user behind them all.
    for (const viewer of [DELEGATED, MANAGER, MEMBER])
      expect(
        (await app.guestStatus(viewer, MEMBER.userId)).delivery.map((job) => [job.kind, job.id]),
      ).toEqual([["reconcile.user", reconcile]]);
    // An issue report's member section lists the same work. Every role choice here has finished, so
    // the report's queue and failure tables, which list waiting and failed jobs by kind and never by
    // member, hold none either.
    const reports = new IssueReports(CONFIG, db, {} as Lodestone, new RecentLogs(), null);
    await reports.user(MEMBER, "a member", "1300000000000000001", "My roles didn't change at all.");
    const [report] = await db.orm
      .select({ body: t.issueReports.body })
      .from(t.issueReports)
      .where(eq(t.issueReports.fingerprint, "user:1300000000000000001"));
    expect(report?.body).toContain("reconcile.user");
    expect(report?.body).not.toContain("roles.self");
  });

  test("the schedule pass reaches role choices through migration 012's partial indexes", async () => {
    // Plenty of other work and finished role choices, two waiting ones, and fresh statistics.
    await db.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, guild_id, user_id, status, completed_at)
       SELECT CASE WHEN n % 5 = 0 THEN 'roles.self' ELSE 'reconcile.user' END, 'bulk:' || n, '{}',
              $1, n::text, 'succeeded', now()
         FROM generate_series(1, 500) AS n`,
      [GUILD],
    );
    for (const user of ["1", "2"])
      await enqueue(db.pool, "roles.self", `self-roles:${GUILD}:${user}`, {}, GUILD, user);
    await db.query("ANALYZE jobs");
    // The pass's statements with their bound values, as Drizzle hands them to the pool.
    const sent: { text: string; values: unknown[] }[] = [];
    const pool = db.pool as unknown as { query: (...args: unknown[]) => unknown };
    const query = pool.query;
    pool.query = (...args: unknown[]) => {
      const [config, values] = args;
      if (
        typeof config === "object" &&
        config !== null &&
        "text" in config &&
        Array.isArray(values)
      )
        sent.push({ text: String(config.text), values });
      return query.apply(db.pool, args);
    };
    try {
      await new Synchronization(app).schedule();
    } finally {
      pool.query = query;
    }
    // The waiting rows' close, then the finished rows' retention.
    const [close, retention, ...rest] = sent.filter(({ values }) => values.includes("roles.self"));
    expect([close?.text.split(" ")[0], retention?.text.split(" ")[0], rest]).toEqual([
      "update",
      "delete",
      [],
    ]);
    /**
     * Each index PostgreSQL plans `statement` with, once, its values bound as the pool binds them.
     * No index at all would mean a sequential scan; one index can serve both arms of an OR.
     */
    const client = await db.pool.connect();
    const indexes = async (statement: { text: string; values: unknown[] } | undefined) => {
      const result = await client.query(
        `EXPLAIN (FORMAT JSON) ${statement?.text}`,
        statement?.values,
      );
      const names = JSON.stringify(result.rows[0]).matchAll(/"Index Name":"([^"]+)"/g);
      return [...new Set([...names].map((match) => match[1]))];
    };
    try {
      await client.query("BEGIN");
      // Whether each predicate proves its partial index is under test, not the plan this small
      // table would get, so sequential scans are off.
      await client.query("SET LOCAL enable_seqscan = off");
      expect(await indexes(close)).toEqual(["self_role_waiting"]);
      expect(await indexes(retention)).toEqual(["self_role_jobs"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
