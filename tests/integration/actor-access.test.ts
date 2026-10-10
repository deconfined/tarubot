/**
 * Service.enrichActor's member and guest facts (2.40.0, owner decision Q6 A) over real PostgreSQL:
 * set from the bound Member and Guest roles the actor holds now, for every actor (server managers
 * included), false when the role isn't bound or TaruBot isn't set up in the server, and delegated
 * officer authority unchanged beside them. Confined to its own schema, actor_access_it, with
 * invented IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import type { Actor } from "../../src/domain/policy.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";

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

const CONFIG = { ROSTER_INTERVAL_SECONDS: 21600 } as Configuration;

/** An actor as gateway.actor returns it, holding `roleIds`. */
const actor = (roleIds: readonly string[], overrides: Partial<Actor> = {}): Actor => ({
  guildId: GUILD,
  userId: USER,
  officer: false,
  manageRoles: false,
  serverManager: false,
  roleIds,
  botAdministrator: false,
  timedOut: false,
  ...overrides,
});

describe.skipIf(!url)("Service.enrichActor's member and guest facts", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  // enrichActor reads only the database; any Discord call would be a bug.
  const app = new Service(db, {} as DiscordPort, {} as Lodestone, CONFIG);

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
    await db.query("TRUNCATE guilds, users, officer_overrides CASCADE");
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

  test("server managers get the flags too; the resolver's own facts pass through", async () => {
    const manager = actor([ROLE.member], {
      officer: true,
      serverManager: true,
      manageRoles: true,
      botAdministrator: true,
      timedOut: true,
    });
    expect(await app.enrichActor(manager)).toEqual({ ...manager, member: true, guest: false });
  });

  test("delegated officer authority is unchanged beside the flags", async () => {
    // The Officer role without rank access or a grant confers no authority.
    expect(await app.enrichActor(actor([ROLE.officer, ROLE.member]))).toMatchObject({
      officer: false,
      member: true,
    });
    // An officer grant, as /config officer records it: for a known member of the server.
    await db.orm.insert(t.users).values({ id: USER });
    await db.orm.insert(t.guildUsers).values({ guild_id: GUILD, user_id: USER, present: true });
    await db.orm.insert(t.officerOverrides).values({
      guild_id: GUILD,
      user_id: USER,
      state: "granted",
      reason: "Invented grant",
      actor_id: "200000000000000001",
    });
    expect(await app.enrichActor(actor([ROLE.officer, ROLE.guest]))).toMatchObject({
      officer: true,
      member: false,
      guest: true,
    });
  });
});
