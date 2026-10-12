/**
 * Service.enrichActor over real PostgreSQL: the member and guest facts (2.40.0, owner decision
 * Q6 A), set from the bound Member and Guest roles the actor holds now, for every actor (server
 * managers included), false when the role isn't bound or TaruBot isn't set up in the server; and
 * the access they resolve to (2.44.0, RBAC): a server manager needs Manage Server and Manage Roles
 * together (Q2 A), and the Officer role counts only while TaruBot's evidence backs it (a manager's
 * grant, or a trusted confirmed character with the officer rank or an unreadable one). Confined to
 * its own schema, actor_access_it, with invented IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rankAccess } from "../../src/application/rank-policy.js";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import { type Actor, can, isStaff, NO_ACCESS } from "../../src/domain/policy.js";
import { PERMISSION_IDS, permission } from "../../src/domain/rbac.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { actorOf } from "../fixtures/actors.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "actor_access_it";
const GUILD = "100000000000000001";
/** A server with no active guild row: TaruBot isn't set up there. */
const UNSET = "100000000000000002";
const USER = "200000000000000002";
/** Invented role IDs: the bound access roles and one the menu might offer. */
const ROLE = {
  member: "400000000000000001",
  guest: "400000000000000002",
  officer: "400000000000000003",
  pronoun: "400000000000000004",
} as const;
/** The linked FC, its officer rank, and the user's one character. */
const FC = "500000000000000001";
const RANK = "officer";
const CHARACTER = "600000000000000001";

const CONFIG = { ROSTER_INTERVAL_SECONDS: 21600 } as Configuration;

/** An actor as gateway.actor returns it, holding `roleIds`: no access until enrichActor. */
const actor = (roleIds: readonly string[], overrides: Partial<Actor> = {}): Actor => ({
  guildId: GUILD,
  userId: USER,
  manageRoles: false,
  serverManager: false,
  roleIds,
  access: NO_ACCESS,
  botAdministrator: false,
  timedOut: false,
  ...overrides,
});

/** The fixed permissions: what only a server manager holds. */
const FIXED = PERMISSION_IDS.filter((id) => permission(id).tier === "fixed");

describe.skipIf(!url)("Service.enrichActor's member and guest facts and access", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  // enrichActor reads only the database; any Discord call would be a bug.
  const app = new Service(db, {} as DiscordPort, {} as Lodestone, CONFIG);

  /** The user as a known member of the server, which links and grants need. */
  const known = async () => {
    await db.orm.insert(t.users).values({ id: USER }).onConflictDoNothing();
    await db.orm
      .insert(t.guildUsers)
      .values({ guild_id: GUILD, user_id: USER, present: true })
      .onConflictDoNothing();
  };
  /** A manager's grant or revocation, as /officer records it. */
  const override = async (state: "granted" | "revoked") => {
    await known();
    await db.orm.insert(t.officerOverrides).values({
      guild_id: GUILD,
      user_id: USER,
      state,
      reason: "Invented override",
      actor_id: "200000000000000001",
    });
  };
  /** The FC linked with its officer rank chosen, and one trusted link no roster has checked. */
  const linked = async () => {
    await db.orm.insert(t.freeCompanies).values({ id: FC, name: "Example FC", world: "Diabolos" });
    await db.orm.update(t.guilds).set({ fc_id: FC, officer_rank_key: RANK });
    await known();
    await db.orm
      .insert(t.characters)
      .values({ id: CHARACTER, name: "Example Character", world: "Diabolos" });
    await db.orm.insert(t.links).values({
      guild_id: GUILD,
      user_id: USER,
      character_id: CHARACTER,
      provenance: "profile_token",
    });
  };
  /** A roster that confirms the character with `rank`; null when it didn't carry the rank. */
  const confirmed = async (rank: string | null) => {
    const [snapshot] = await db.orm
      .insert(t.rosterSnapshots)
      .values({
        fc_id: FC,
        started_at: new Date(),
        observed_at: new Date(),
        member_count: 1,
        evidence: { fixture: true },
      })
      .returning({ id: t.rosterSnapshots.id });
    if (!snapshot) throw new Error("Missing roster snapshot");
    await db.orm.insert(t.rosterMembers).values({
      snapshot_id: snapshot.id,
      character_id: CHARACTER,
      fc_rank_key: rank,
      is_fc_leader: false,
    });
    const state = { state: "present" as const, snapshot_id: snapshot.id };
    await db.orm
      .insert(t.membership)
      .values({ guild_id: GUILD, fc_id: FC, character_id: CHARACTER, ...state })
      .onConflictDoUpdate({
        target: [t.membership.guild_id, t.membership.fc_id, t.membership.character_id],
        set: state,
      });
    await db.orm.update(t.membership).set({ confirmed_snapshot_id: snapshot.id });
  };
  /** What rank policy says about the user's officer rank now. */
  const officerRank = async () => {
    const [guild] = await db.orm.select().from(t.guilds);
    if (!guild) throw new Error("Missing guild");
    return (await rankAccess(db, guild, USER, CONFIG.ROSTER_INTERVAL_SECONDS)).officer;
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
      "TRUNCATE guilds, users, officer_overrides, free_companies, characters, roster_snapshots CASCADE",
    );
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      member_role_id: ROLE.member,
      guest_role_id: ROLE.guest,
      officer_role_id: ROLE.officer,
    });
  });

  test("the flags follow the bound roles held now, and nothing else", async () => {
    const flags = async (roleIds: readonly string[]) => {
      const { member, guest } = await app.enrichActor(actor(roleIds));
      return { member, guest };
    };
    expect(await flags([ROLE.member, ROLE.pronoun])).toEqual({ member: true, guest: false });
    expect(await flags([ROLE.guest])).toEqual({ member: false, guest: true });
    // Holding both (a hand edit) sets both; reconciliation corrects the roles, not this read.
    expect(await flags([ROLE.member, ROLE.guest])).toEqual({ member: true, guest: true });
    // A lobby newcomer, or someone holding only a menu role.
    expect(await flags([])).toEqual({ member: false, guest: false });
    expect(await flags([ROLE.pronoun])).toEqual({ member: false, guest: false });
  });

  test("an unbound role, an inactive or missing guild row means no flag", async () => {
    await db.orm.update(t.guilds).set({ guest_role_id: null });
    expect(await app.enrichActor(actor([ROLE.member, ROLE.guest]))).toMatchObject({
      member: true,
      guest: false,
    });
    await db.orm.update(t.guilds).set({ active: false });
    expect(await app.enrichActor(actor([ROLE.member, ROLE.guest]))).toMatchObject({
      member: false,
      guest: false,
    });
    expect(
      await app.enrichActor(actor([ROLE.member, ROLE.guest], { guildId: UNSET })),
    ).toMatchObject({ member: false, guest: false });
  });

  test("the flags carry the roles' permissions", async () => {
    const member = await app.enrichActor(actor([ROLE.member]));
    expect(member.access.roles).toEqual(["member"]);
    expect(can(member, "ledger.deposit")).toBe(true);
    expect(can(member, "suggest.use")).toBe(true);
    const guest = await app.enrichActor(actor([ROLE.guest]));
    expect(guest.access.roles).toEqual(["guest"]);
    expect(can(guest, "ledger.view")).toBe(false);
    expect(can(guest, "modmail.open")).toBe(true);
    // Nobody here is staff, and a newcomer keeps only the baseline.
    expect([member, guest].some(isStaff)).toBe(false);
    expect((await app.enrichActor(actor([ROLE.pronoun]))).access).toEqual(NO_ACCESS);
  });

  test("server managers get the flags too; the resolver's own facts pass through", async () => {
    const manager = actor([ROLE.member], {
      serverManager: true,
      manageRoles: true,
      botAdministrator: true,
      timedOut: true,
    });
    expect(await app.enrichActor(manager)).toEqual(
      actorOf({ ...manager, member: true, guest: false }),
    );
  });

  test("Manage Server without Manage Roles grants nothing (owner decision Q2 A)", async () => {
    // 2.43.0 made this person a full officer.
    const serverOnly = await app.enrichActor(actor([ROLE.member], { serverManager: true }));
    expect(serverOnly.access).toMatchObject({ manager: false, roles: ["member"] });
    expect(isStaff(serverOnly)).toBe(false);
    expect(can(serverOnly, "config.view")).toBe(false);
    // Manage Roles alone is nothing either.
    const rolesOnly = await app.enrichActor(actor([], { manageRoles: true }));
    expect(rolesOnly.access).toEqual(NO_ACCESS);
  });

  test("a server manager holds every permission but the member-side ones, without a rank read", async () => {
    const manager = (roleIds: readonly string[]) =>
      app.enrichActor(actor(roleIds, { serverManager: true, manageRoles: true }));
    // A revocation doesn't reach a manager, and their Officer role isn't counted separately.
    await override("revoked");
    const officerRole = await manager([ROLE.officer]);
    expect(officerRole.access).toMatchObject({ manager: true, roles: [] });
    for (const id of FIXED) expect(can(officerRole, id)).toBe(true);
    // /suggest and opening mod mail follow the manager's own Member or Guest role.
    expect(can(officerRole, "suggest.use")).toBe(false);
    expect(can(officerRole, "modmail.open")).toBe(false);
    const member = await manager([ROLE.member, ROLE.officer]);
    expect(can(member, "suggest.use")).toBe(true);
    expect(can(member, "modmail.open")).toBe(true);
    // With the override table unreadable, a manager still resolves: the rank read is skipped.
    // An Officer-role holder without manager authority needs it, and fails.
    await db.query("ALTER TABLE officer_overrides RENAME TO officer_overrides_hidden");
    try {
      expect((await manager([ROLE.officer])).access.manager).toBe(true);
      await expect(app.enrichActor(actor([ROLE.officer]))).rejects.toThrow();
    } finally {
      await db.query("ALTER TABLE officer_overrides_hidden RENAME TO officer_overrides");
    }
  });

  test("the Officer role counts only with a grant, never after a revocation", async () => {
    // The Officer role without rank evidence or a grant confers no authority.
    const unbacked = await app.enrichActor(actor([ROLE.officer, ROLE.member]));
    expect(unbacked).toMatchObject({ member: true, access: { roles: ["member"] } });
    expect(isStaff(unbacked)).toBe(false);
    // An officer grant, as /config officer records it: for a known member of the server.
    await override("granted");
    const granted = await app.enrichActor(actor([ROLE.officer, ROLE.guest]));
    expect(granted).toMatchObject({
      member: false,
      guest: true,
      access: { manager: false, roles: ["guest", "officer"] },
    });
    expect(isStaff(granted)).toBe(true);
    // A grant counts only through the role it backs.
    expect(isStaff(await app.enrichActor(actor([ROLE.guest])))).toBe(false);
    // A revocation wins over the officer rank itself.
    await db.orm.update(t.officerOverrides).set({ state: "revoked" });
    await linked();
    await confirmed(RANK);
    expect(await officerRank()).toBe("no");
    expect(isStaff(await app.enrichActor(actor([ROLE.officer])))).toBe(false);
  });

  test("the Officer role counts with the rank, or a rank the roster didn't carry, never before a roster", async () => {
    const officer = async () => isStaff(await app.enrichActor(actor([ROLE.officer])));
    // Only a trusted link no roster has checked yet: the role is kept, but grants nothing.
    await linked();
    expect(await officerRank()).toBe("unresolved");
    expect(await officer()).toBe(false);
    // A confirmed character whose rank the roster didn't carry keeps authority.
    await confirmed(null);
    expect(await officerRank()).toBe("unreadable");
    expect(await officer()).toBe(true);
    // The officer rank itself, then another rank.
    await confirmed(RANK);
    expect(await officerRank()).toBe("yes");
    expect(await officer()).toBe(true);
    await confirmed("member");
    expect(await officerRank()).toBe("no");
    expect(await officer()).toBe(false);
    // Rank backs only the role: without it, the officer rank grants nothing.
    await confirmed(RANK);
    expect(isStaff(await app.enrichActor(actor([ROLE.member])))).toBe(false);
  });
});
