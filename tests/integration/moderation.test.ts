/**
 * Per-person moderation over real PostgreSQL (2.45.0, migration 015): the Moderation service's
 * writes (a pause, its end on the database clock, a batch, a replacement that keeps history, the
 * closing of a pause that ran out, a lift, and the audit rows that never hold a reason), the rules
 * for who may pause or lift whom (a server manager, an officer holding moderation.block, a plain
 * member; yourself, bots, other managers, staff, mod mail), what the paused person and an officer
 * each read back (status, the Moderation page's overview, the suggestion finder), the shutdown
 * rollback, concurrent writes, and Service.enrichActor's reading of active pauses. Confined to its
 * own schema, moderation_it, with invented IDs. The Discord port is a fake that refuses everything
 * a pause must never need; targets are resolved by a closure over a table of who is who.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { ACTIVE_LIMIT, ENDED_LIMIT, Moderation } from "../../src/application/moderation.js";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import type { ForbiddenScope } from "../../src/domain/failures.js";
import { PAUSE_DURATIONS, type PauseDuration } from "../../src/domain/moderation.js";
import {
  type Actor,
  can,
  holds,
  NO_ACCESS,
  pauseOn,
  requirePermission,
} from "../../src/domain/policy.js";
import { BLOCKABLE, type PermissionId } from "../../src/domain/rbac.js";
import { Failure } from "../../src/domain/values.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { type ActorSpec, actorOf } from "../fixtures/actors.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "moderation_it";
const GUILD = "666666666666666911";
const OTHER_GUILD = "666666666666666912";
const ROLE = {
  member: "523456789012345911",
  guest: "523456789012345912",
  officer: "523456789012345913",
} as const;
const USER = {
  manager: "723456789012345921",
  otherManager: "723456789012345922",
  officer: "723456789012345923",
  secondOfficer: "723456789012345924",
  staff: "723456789012345925",
  member: "723456789012345931",
  otherMember: "723456789012345932",
  guest: "723456789012345933",
  newcomer: "723456789012345934",
  departed: "723456789012345935",
  stranger: "723456789012345936",
  bot: "723456789012345937",
} as const;
const JOINED = new Date("2026-01-01T00:00:00Z");
const ZERO_BATCH = "00000000-0000-4000-8000-000000000000";

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

/** An actor as a command would carry them, with the access their facts give (actorOf). */
const person = (userId: string, facts: Partial<ActorSpec> = {}): Actor =>
  actorOf({
    guildId: GUILD,
    userId,
    manageRoles: false,
    member: false,
    guest: false,
    botAdministrator: false,
    ...facts,
  });
const MANAGER = person(USER.manager, { manageRoles: true, serverManager: true });
/** Holds moderation.block and moderation.view through the Officer role, and is no server manager. */
const OFFICER = person(USER.officer, { officer: true });
const SECOND_OFFICER = person(USER.secondOfficer, { officer: true });
const MEMBER = person(USER.member, { member: true });
const OTHER_MEMBER = person(USER.otherMember, { member: true });

/** The ways a target can be: what the resolver closure answers for each user ID. */
type Standing = "manager" | "officer" | "member" | "guest" | "bot";
const STANDING: ReadonlyMap<string, Standing> = new Map([
  [USER.manager, "manager"],
  [USER.otherManager, "manager"],
  [USER.officer, "officer"],
  [USER.secondOfficer, "officer"],
  [USER.staff, "officer"],
  [USER.member, "member"],
  [USER.otherMember, "member"],
  [USER.newcomer, "member"],
  [USER.guest, "guest"],
  [USER.bot, "bot"],
]);

/** What a refusal must look like; throws if the operation did not refuse with a Failure. */
async function refused(operation: Promise<unknown>): Promise<Failure> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
  }
  throw new Error("Expected the operation to be refused");
}
/** A forbidden refusal whose detail is exactly this scope (and permission, when it names one). */
async function scoped(
  operation: Promise<unknown>,
  scope: ForbiddenScope,
  permission?: PermissionId,
): Promise<Failure> {
  const failure = await refused(operation);
  expect(failure.code).toBe("forbidden");
  expect(failure.detail).toEqual({ kind: "scope", scope, ...(permission && { permission }) });
  return failure;
}

describe.skipIf(!url)("per-person moderation", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());

  /** Every Discord call the service made, and every target the resolver was asked about. */
  let calls: string[];
  let resolvedUsers: string[];
  /** Who is a current member (and since when), as the fake Discord answers. */
  let joined: Map<string, Date>;
  let stopping: () => boolean;
  let namesFail: boolean;
  let nameRequests: (readonly string[])[];
  const unused = async (): Promise<never> => {
    throw new Error("A pause must not need this Discord call");
  };
  const discord: DiscordPort = {
    member: async (guild, user) => {
      calls.push(`member ${user}`);
      const joinedAt = joined.get(user);
      return joinedAt
        ? { id: user, guildId: guild, joinedAt, nickname: null, roles: [], bot: false }
        : null;
    },
    members: unused,
    validateRole: unused,
    validateChannel: unused,
    roles: unused,
    layoutRoles: unused,
    nickname: unused,
    send: unused,
    editReview: unused,
    dm: unused,
    displayNames: async (_guild, users) => {
      nameRequests.push(users);
      if (namesFail) throw new Error("Discord is unavailable");
      return new Map(users.map((id) => [id, `Name ${id.slice(-2)}`]));
    },
  };
  const app = new Service(db, discord, {} as Lodestone, CONFIG);

  /** A person as the gateway would give them before enrichment: Discord facts only. */
  const raw = (userId: string, roles: readonly string[], manager = false): Actor => ({
    guildId: GUILD,
    userId,
    manageRoles: manager,
    serverManager: manager,
    roleIds: roles,
    botAdministrator: false,
    access: NO_ACCESS,
  });
  /** Resolve a member of the main server as a command would: the real enrichActor. */
  const resolved = (userId: string, ...roles: string[]): Promise<Actor> =>
    app.enrichActor(raw(userId, roles));
  const resolve = async (guildId: string, userId: string): Promise<Actor> => {
    resolvedUsers.push(userId);
    const gone = new Failure("forbidden", "Not a current member.", 0, {
      kind: "scope",
      scope: "current_member",
    });
    switch (STANDING.get(userId)) {
      case "bot":
        throw new Failure("forbidden", "Commands work only for human members.", 0, {
          kind: "scope",
          scope: "human",
        });
      case "manager":
        return app.enrichActor({ ...raw(userId, [], true), guildId });
      case "officer":
        // The Officer role needs rank evidence to count, which real resolution reads; a fixture
        // officer stands in, since only their permissions matter to a pause.
        return person(userId, { officer: true });
      case "member":
        return app.enrichActor({ ...raw(userId, [ROLE.member]), guildId });
      case "guest":
        return app.enrichActor({ ...raw(userId, [ROLE.guest]), guildId });
      default:
        throw gone;
    }
  };
  const moderation = new Moderation(app, resolve, () => stopping());

  const block = (
    actor: Actor,
    target: string,
    permissions: readonly PermissionId[],
    duration: PauseDuration = "1w",
    reason = "Paused while an officer looks into it",
  ) => moderation.block(actor, target, permissions, duration, reason);
  const lift = (
    actor: Actor,
    target: string,
    permissions: readonly PermissionId[],
    reason = "Resolved",
  ) => moderation.lift(actor, target, permissions, reason);

  /** Every pause row of a person (or of everyone), oldest first. */
  const blockRows = (user?: string) =>
    db.orm
      .select()
      .from(t.memberBlocks)
      .where(user ? eq(t.memberBlocks.user_id, user) : undefined)
      .orderBy(
        asc(t.memberBlocks.created_at),
        asc(t.memberBlocks.permission),
        asc(t.memberBlocks.id),
      );
  const openRows = async (user: string) =>
    (await blockRows(user)).filter((row) => row.lifted_at === null);
  const auditRows = () =>
    db.orm
      .select({
        actor: t.auditEvents.actor_id,
        action: t.auditEvents.action,
        target: t.auditEvents.target,
        details: t.auditEvents.details,
      })
      .from(t.auditEvents)
      .orderBy(asc(t.auditEvents.id));
  /** A pause written straight into the table, for states the service never leaves behind. */
  const seed = (pause: {
    user: string;
    permission: string;
    guild?: string;
    reason?: string;
    level?: "manager" | "moderator";
    actor?: string;
    /** How long ago it began. */
    created?: string;
    /** When it ends, relative to now: negative has ended already; null lasts until lifted. */
    ends?: string | null;
    /** How long ago it was lifted, by whom (null: it closed itself) and why. */
    lifted?: { ago: string; by: string | null; reason: string };
  }) =>
    db.query(
      `INSERT INTO member_blocks (batch_id, guild_id, user_id, permission, reason, issuer_level,
         actor_id, created_at, expires_at, lifted_at, lifted_by, lift_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - $8::interval,
         CASE WHEN $9::text IS NULL THEN NULL ELSE now() + $9::interval END,
         CASE WHEN $10::text IS NULL THEN NULL ELSE now() - $10::interval END, $11, $12)`,
      [
        ZERO_BATCH,
        pause.guild ?? GUILD,
        pause.user,
        pause.permission,
        pause.reason ?? "Seeded pause",
        pause.level ?? "manager",
        pause.actor ?? USER.manager,
        pause.created ?? "1 hour",
        pause.ends === undefined ? null : pause.ends,
        pause.lifted?.ago ?? null,
        pause.lifted?.by ?? null,
        pause.lifted?.reason ?? null,
      ],
    );
  const seedPerson = async (guild: string, user: string, present = true) => {
    await db.orm.insert(t.users).values({ id: user }).onConflictDoNothing();
    await db.orm
      .insert(t.guildUsers)
      .values({ guild_id: guild, user_id: user, present, joined_at: JOINED })
      .onConflictDoNothing();
  };
  const count = async (table: string, where = "true") =>
    Number(
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]?.n,
    );

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
    // TRUNCATE skips the history trigger, which refuses DELETE, and CASCADE reaches member_blocks.
    await db.query("TRUNCATE guilds, users, jobs, audit CASCADE");
    for (const id of [GUILD, OTHER_GUILD])
      await db.orm.insert(t.guilds).values({
        id,
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: ROLE.officer,
        effects_enabled: true,
        role_layout_enabled: false,
      });
    // TaruBot has seen everyone but the newcomer (a current member with no row yet) and the
    // stranger; the departed person's row says they left.
    for (const user of [
      USER.manager,
      USER.otherManager,
      USER.officer,
      USER.secondOfficer,
      USER.staff,
      USER.member,
      USER.otherMember,
      USER.guest,
    ])
      await seedPerson(GUILD, user);
    await seedPerson(GUILD, USER.departed, false);
    await seedPerson(OTHER_GUILD, USER.member);
    calls = [];
    resolvedUsers = [];
    joined = new Map(
      [...STANDING.keys()].filter((user) => user !== USER.bot).map((user) => [user, JOINED]),
    );
    stopping = () => false;
    namesFail = false;
    nameRequests = [];
  });

  describe("pausing", () => {
    test("a server manager pauses a member: one row on the database clock, one audit row, no reason in it", async () => {
      const result = await block(
        MANAGER,
        USER.member,
        ["suggest.use"],
        "1d",
        "Spam in suggestions",
      );
      expect(result).toMatchObject({
        target: USER.member,
        permissions: ["suggest.use"],
        duration: "1d",
        replaced: [],
      });
      const [row, ...others] = await blockRows(USER.member);
      expect(others).toEqual([]);
      expect(row).toMatchObject({
        guild_id: GUILD,
        user_id: USER.member,
        permission: "suggest.use",
        reason: "Spam in suggestions",
        issuer_level: "manager",
        actor_id: USER.manager,
        batch_id: result.batch,
        lifted_at: null,
        lifted_by: null,
        lift_reason: null,
      });
      // The end is the row's own start plus a day, both read from PostgreSQL's clock.
      expect(
        await db.query(
          "SELECT extract(epoch FROM expires_at - created_at)::float8 AS seconds FROM member_blocks",
        ),
      ).toEqual([{ seconds: 86_400 }]);
      expect(result.until).toEqual(row?.expires_at ?? null);
      expect(await auditRows()).toEqual([
        {
          actor: USER.manager,
          action: "moderation.block",
          target: USER.member,
          details: {
            permissions: ["suggest.use"],
            expiresAt: row?.expires_at?.toISOString(),
            batch: result.batch,
          },
        },
      ]);
      expect(JSON.stringify(await auditRows())).not.toContain("Spam");
      // Database writes only: no job, and the one Discord read is the join date of a member.
      expect(await db.orm.$count(t.jobs)).toBe(0);
      expect(calls).toEqual([`member ${USER.member}`]);
    });

    test("several features in one action share a batch, the end and the reason; another action has its own", async () => {
      const result = await block(
        MANAGER,
        USER.member,
        ["suggest.use", "issue.use", "ledger.deposit"],
        "1w",
        "Misusing the bot",
      );
      const rows = await openRows(USER.member);
      expect(rows.map((row) => row.permission).sort()).toEqual([
        "issue.use",
        "ledger.deposit",
        "suggest.use",
      ]);
      expect(new Set(rows.map((row) => row.batch_id))).toEqual(new Set([result.batch]));
      expect(new Set(rows.map((row) => row.expires_at?.getTime())).size).toBe(1);
      expect(new Set(rows.map((row) => row.reason))).toEqual(new Set(["Misusing the bot"]));
      // One audit row for the action, naming every feature.
      expect(await auditRows()).toEqual([
        {
          actor: USER.manager,
          action: "moderation.block",
          target: USER.member,
          details: {
            permissions: ["suggest.use", "issue.use", "ledger.deposit"],
            expiresAt: rows[0]?.expires_at?.toISOString(),
            batch: result.batch,
          },
        },
      ]);
      const second = await block(MANAGER, USER.otherMember, ["suggest.use"]);
      expect(second.batch).not.toBe(result.batch);
      // The same feature listed twice is one pause.
      const twice = await block(MANAGER, USER.guest, ["suggest.use", "suggest.use", "issue.use"]);
      expect(twice.permissions).toEqual(["suggest.use", "issue.use"]);
      expect(await openRows(USER.guest)).toHaveLength(2);
    });

    test("each duration ends when it says, 'until lifted' never, and an unknown one is refused", async () => {
      for (const duration of Object.keys(PAUSE_DURATIONS) as PauseDuration[]) {
        const result = await block(MANAGER, USER.member, ["suggest.use"], duration);
        const [open] = await openRows(USER.member);
        const seconds = PAUSE_DURATIONS[duration].seconds;
        expect(result.duration).toBe(duration);
        if (seconds === null) {
          expect(result.until).toBeNull();
          expect(open?.expires_at).toBeNull();
        } else {
          const [span] = await db.query<{ seconds: number }>(
            "SELECT extract(epoch FROM expires_at - created_at)::float8 AS seconds FROM member_blocks WHERE lifted_at IS NULL",
          );
          expect(span?.seconds).toBe(seconds);
        }
      }
      // "Until lifted" records no end in the audit row either.
      await block(MANAGER, USER.otherMember, ["suggest.use"], "forever");
      expect((await auditRows()).at(-1)?.details).toMatchObject({ expiresAt: null });

      // A value the type forbids (a forged form or command) is the person's mistake: it is
      // refused as an input failure naming the duration, never read as a week, and it is refused
      // before the target is looked up or anything is written. The person keeps the pause they had.
      const rowsBefore = await blockRows();
      const auditBefore = await auditRows();
      calls = [];
      resolvedUsers = [];
      for (const forged of [
        "fortnight",
        "1W",
        "",
        " 1w",
        "toString",
        "constructor",
        "__proto__",
        null,
        undefined,
        604_800,
      ]) {
        // The service directly: the block() helper above turns undefined into its default week.
        const failure = await refused(
          moderation.block(
            MANAGER,
            USER.member,
            ["suggest.use", "issue.use"],
            forged as PauseDuration,
            "Paused while an officer looks into it",
          ),
        );
        expect(failure).toMatchObject({
          code: "input",
          detail: { kind: "option", option: "duration" },
        });
      }
      expect(await blockRows()).toEqual(rowsBefore);
      expect(await auditRows()).toEqual(auditBefore);
      expect(calls).toEqual([]);
      expect(resolvedUsers).toEqual([]);
      // The same call with a real duration goes through, so the refusals were about the duration.
      expect((await block(MANAGER, USER.member, ["issue.use"], "1w")).duration).toBe("1w");
    });

    test("pausing again replaces the pause and keeps both in the history", async () => {
      const first = await block(
        MANAGER,
        USER.member,
        ["suggest.use", "issue.use"],
        "1w",
        "First reason",
      );
      const second = await block(MANAGER, USER.member, ["suggest.use"], "1d", "Second reason");
      expect(second.replaced).toEqual(["suggest.use"]);
      const history = await blockRows(USER.member);
      expect(history).toHaveLength(3);
      const [oldSuggest] = history.filter(
        (row) => row.permission === "suggest.use" && row.lifted_at !== null,
      );
      expect(oldSuggest).toMatchObject({
        reason: "First reason",
        batch_id: first.batch,
        lifted_by: USER.manager,
        lift_reason: "Replaced by a new pause",
      });
      const open = await openRows(USER.member);
      expect(open.map((row) => [row.permission, row.reason, row.batch_id]).sort()).toEqual([
        ["issue.use", "First reason", first.batch],
        ["suggest.use", "Second reason", second.batch],
      ]);
      // The person is held to the new pause only.
      const actor = await resolved(USER.member, ROLE.member);
      expect(pauseOn(actor, "suggest.use")?.reason).toBe("Second reason");
      expect([...actor.access.blocked.keys()].sort()).toEqual(["issue.use", "suggest.use"]);
    });

    test("a pause that ran out stops applying; the next pause closes it as expired, with no lifter", async () => {
      await seed({
        user: USER.member,
        permission: "suggest.use",
        reason: "Old pause",
        created: "2 hours",
        ends: "-1 hour",
      });
      // Nothing closed it, yet it no longer applies.
      expect((await resolved(USER.member, ROLE.member)).access.blocked.size).toBe(0);
      expect(await openRows(USER.member)).toHaveLength(1);
      const result = await block(MANAGER, USER.member, ["suggest.use"], "1h", "New pause");
      expect(result.replaced).toEqual([]);
      const [old, current] = await blockRows(USER.member);
      expect(old).toMatchObject({
        reason: "Old pause",
        lifted_by: null,
        lift_reason: "expired",
      });
      expect(old?.lifted_at).toBeInstanceOf(Date);
      expect(current).toMatchObject({ reason: "New pause", lifted_at: null });
      expect(pauseOn(await resolved(USER.member, ROLE.member), "suggest.use")?.reason).toBe(
        "New pause",
      );
    });

    test("what can't be done is refused as the person's mistake, before anything is written", async () => {
      const option = (name: string) => ({ kind: "option", option: name });
      for (const permissions of [
        [],
        ["members.view"],
        ["moderation.view"],
        ["ledger.audit"],
        ["not.a.permission"],
        ["suggest.use", "members.view"],
      ] as PermissionId[][]) {
        const failure = await refused(block(MANAGER, USER.member, permissions));
        expect(failure).toMatchObject({ code: "input", detail: option("feature") });
      }
      for (const reason of ["", "   ", "x".repeat(1001), "bad\0reason"]) {
        const failure = await refused(block(MANAGER, USER.member, ["suggest.use"], "1w", reason));
        expect(failure).toMatchObject({ code: "input", detail: option("reason") });
      }
      for (const reason of ["", "x".repeat(1001)])
        expect(await refused(lift(MANAGER, USER.member, ["suggest.use"], reason))).toMatchObject({
          code: "input",
          detail: option("reason"),
        });
      expect(
        await refused(lift(MANAGER, USER.member, ["members.view" as PermissionId])),
      ).toMatchObject({
        code: "input",
        detail: option("feature"),
      });
      expect(await blockRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    test("a reason is measured with its line breaks as one character, as the form's textarea counts them, and stored with \\n only", async () => {
      // A browser counts a line break as one character against maxlength but submits it as CRLF,
      // so a reason the field allowed is longer on the wire. These are 1,000 characters once
      // normalized (998 letters and 2 breaks) and 1,002 as typed.
      const lines = ["a".repeat(333), "b".repeat(333), "c".repeat(332)];
      const stored = lines.join("\n");
      const typed = lines.join("\r\n");
      expect([stored.length, typed.length]).toEqual([1000, 1002]);

      const paused = await block(MANAGER, USER.member, ["suggest.use"], "1w", typed);
      expect(paused.permissions).toEqual(["suggest.use"]);
      const [open] = await openRows(USER.member);
      expect(open?.reason).toBe(stored);
      expect(open?.reason).not.toContain("\r");

      const lifted = await lift(MANAGER, USER.member, ["suggest.use"], typed);
      expect(lifted.lifted).toEqual(["suggest.use"]);
      const [closed] = await blockRows(USER.member);
      expect(closed?.lift_reason).toBe(stored);
      expect(closed?.lift_reason).not.toContain("\r");
      // The stored text is what a later reader sees: no carriage return anywhere in the history.
      expect(
        await db.query(
          "SELECT 1 FROM member_blocks WHERE reason LIKE '%' || chr(13) || '%' OR lift_reason LIKE '%' || chr(13) || '%'",
        ),
      ).toEqual([]);

      // A lone carriage return (an old Mac line ending) is one break too.
      await block(MANAGER, USER.member, ["issue.use"], "1w", "first\rsecond\r\nthird");
      expect((await openRows(USER.member)).map((row) => row.reason)).toEqual([
        "first\nsecond\nthird",
      ]);
    });

    test("a reason over 1,000 characters once normalized is refused, however its line breaks are written", async () => {
      // 999 letters and 2 breaks: 1,001 characters normalized, 1,003 with CRLF.
      const tooLong = ["a".repeat(333), "b".repeat(333), "c".repeat(333)];
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Paused first");
      const rows = await blockRows();
      const audits = await auditRows();
      for (const reason of [tooLong.join("\r\n"), tooLong.join("\n"), tooLong.join("\r")]) {
        expect(reason.length).toBeGreaterThanOrEqual(1001);
        const option = { code: "input", detail: { kind: "option", option: "reason" } };
        expect(
          await refused(block(MANAGER, USER.otherMember, ["suggest.use"], "1w", reason)),
        ).toMatchObject(option);
        // The same text refuses a lift of a pause that does exist, so it is the reason refused.
        expect(await refused(lift(MANAGER, USER.member, ["suggest.use"], reason))).toMatchObject(
          option,
        );
      }
      // One character fewer is accepted, in the same CRLF form.
      const fits = [...tooLong.slice(0, 2), "c".repeat(332)];
      await block(MANAGER, USER.otherMember, ["suggest.use"], "1w", fits.join("\r\n"));
      expect(await openRows(USER.otherMember)).toHaveLength(1);
      // Nothing was written by the refusals: the first pause is still open and unchanged.
      expect(await blockRows(USER.member)).toEqual(rows);
      expect((await auditRows()).slice(0, audits.length)).toEqual(audits);
    });

    test("a server's configuration is needed, and a pause belongs to its own server", async () => {
      const failure = await refused(
        block({ ...MANAGER, guildId: "666666666666666999" }, USER.member, ["suggest.use"]),
      );
      expect(failure).toMatchObject({ code: "setup", detail: { kind: "setup", missing: "guild" } });
      expect(await blockRows()).toEqual([]);
      await block(MANAGER, USER.member, ["suggest.use"]);
      // The same person in another server is untouched.
      const elsewhere = await app.enrichActor({
        ...raw(USER.member, [ROLE.member]),
        guildId: OTHER_GUILD,
      });
      expect(elsewhere.access.blocked.size).toBe(0);
      expect((await resolved(USER.member, ROLE.member)).access.blocked.size).toBe(1);
      expect((await blockRows(USER.member)).every((row) => row.guild_id === GUILD)).toBe(true);
    });
  });

  describe("who can be paused", () => {
    test("a current member TaruBot hasn't seen is recorded from Discord's join date; a former member with a row can be paused", async () => {
      expect(await count("guild_users", `user_id='${USER.newcomer}'`)).toBe(0);
      await block(MANAGER, USER.newcomer, ["suggest.use"]);
      expect(
        await db.orm
          .select({ present: t.guildUsers.present, joined: t.guildUsers.joined_at })
          .from(t.guildUsers)
          .where(eq(t.guildUsers.user_id, USER.newcomer)),
      ).toEqual([{ present: true, joined: JOINED }]);
      expect(await openRows(USER.newcomer)).toHaveLength(1);
      // Someone who left: their row stays, the resolver says they are gone, and the pause is kept
      // for when they return.
      const result = await block(MANAGER, USER.departed, ["suggest.use", "issue.use"]);
      expect(result.permissions).toHaveLength(2);
      expect(await openRows(USER.departed)).toHaveLength(2);
      expect(
        await db.orm
          .select({ present: t.guildUsers.present })
          .from(t.guildUsers)
          .where(eq(t.guildUsers.user_id, USER.departed)),
      ).toEqual([{ present: false }]);
      // No Discord read for someone who isn't a current member.
      expect(calls).toEqual([`member ${USER.newcomer}`]);
    });

    test("a user ID TaruBot has never seen is refused and leaves no row anywhere", async () => {
      const failure = await refused(block(MANAGER, USER.stranger, ["suggest.use"]));
      expect(failure).toMatchObject({
        code: "not_found",
        detail: { kind: "resource", resource: "member", id: USER.stranger },
      });
      for (const table of ["users", "guild_users"])
        expect(
          await count(table, `${table === "users" ? "id" : "user_id"}='${USER.stranger}'`),
        ).toBe(0);
      expect(await blockRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    test("bots can't be paused, by anyone", async () => {
      for (const actor of [MANAGER, OFFICER]) {
        const failure = await scoped(block(actor, USER.bot, ["suggest.use"]), "protected");
        expect(failure.message).toBe("Bots can't be paused.");
      }
      expect(await blockRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    test("nobody pauses or lifts their own; a server manager can't be paused at all", async () => {
      for (const actor of [MANAGER, OFFICER]) {
        await scoped(block(actor, actor.userId, ["suggest.use"]), "self");
        await scoped(lift(actor, actor.userId, ["suggest.use"]), "self");
      }
      // The self rule is checked before anyone is resolved.
      expect(resolvedUsers).toEqual([]);
      for (const actor of [MANAGER, OFFICER]) {
        const failure = await scoped(block(actor, USER.otherManager, ["suggest.use"]), "protected");
        expect(failure.message).toBe("Server managers can't be paused.");
      }
      // Even a stored row for a manager (a role they held when it was written) applies to nothing.
      await seed({ user: USER.otherManager, permission: "ledger.view" });
      const manager = await app.enrichActor(raw(USER.otherManager, [], true));
      expect(manager.access.blocked.size).toBe(0);
      expect(can(manager, "ledger.view")).toBe(true);
      expect(await blockRows()).toHaveLength(1);
      expect(await auditRows()).toEqual([]);
    });

    test("a plain member can't pause or lift anyone: the permission is checked first", async () => {
      for (const target of [USER.otherMember, USER.member]) {
        await scoped(block(MEMBER, target, ["suggest.use"]), "officer", "moderation.block");
        await scoped(lift(MEMBER, target, ["suggest.use"]), "officer", "moderation.block");
      }
      expect(resolvedUsers).toEqual([]);
      expect(await blockRows()).toEqual([]);
    });
  });

  describe("an officer holding moderation.block", () => {
    test("pauses a plain member or guest at the officer level, and a server manager may then change it", async () => {
      await block(OFFICER, USER.member, ["suggest.use", "issue.use"]);
      await block(OFFICER, USER.guest, ["selfroles.use"]);
      expect((await blockRows()).map((row) => row.issuer_level)).toEqual([
        "moderator",
        "moderator",
        "moderator",
      ]);
      // A server manager replaces an officer's pause, and it becomes a manager's.
      const result = await block(MANAGER, USER.member, ["suggest.use"]);
      expect(result.replaced).toEqual(["suggest.use"]);
      const replaced = (await blockRows(USER.member)).filter(
        (row) => row.permission === "suggest.use",
      );
      expect(replaced.map((row) => [row.issuer_level, row.lifted_at === null])).toEqual([
        ["moderator", false],
        ["manager", true],
      ]);
    });

    test("can't pause a server manager, anyone with a staff permission, or mod mail", async () => {
      await scoped(block(OFFICER, USER.otherManager, ["suggest.use"]), "protected");
      for (const staff of [USER.staff, USER.secondOfficer]) {
        const failure = await scoped(block(OFFICER, staff, ["selfroles.use"]), "protected");
        expect(failure.message).toContain("server manager");
      }
      // Mod mail is the way members raise concerns about officers: only a manager pauses it, and
      // the refusal comes before anyone is looked up.
      resolvedUsers = [];
      for (const permissions of [
        ["modmail.open"],
        ["suggest.use", "modmail.open"],
      ] as PermissionId[][])
        await scoped(block(OFFICER, USER.member, permissions), "protected");
      expect(resolvedUsers).toEqual([]);
      expect(await blockRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
      // A server manager can do all three, staff included.
      await block(MANAGER, USER.member, ["modmail.open"]);
      await block(MANAGER, USER.staff, ["selfroles.use"]);
      expect(await openRows(USER.member)).toHaveLength(1);
      expect(await openRows(USER.staff)).toHaveLength(1);
    });

    test("can't change or lift a pause a server manager set; can change and lift an officer's", async () => {
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Manager's pause");
      const before = await blockRows();
      const failure = await scoped(block(OFFICER, USER.member, ["suggest.use"]), "protected");
      expect(failure.message).toContain("server manager");
      await scoped(lift(OFFICER, USER.member, ["suggest.use"]), "protected");
      expect(await blockRows()).toEqual(before);
      expect(await auditRows()).toHaveLength(1);

      await block(OFFICER, USER.otherMember, ["suggest.use"], "1w", "Officer's pause");
      // Another officer changes it (a new pause replaces it), then lifts that.
      const changed = await block(
        SECOND_OFFICER,
        USER.otherMember,
        ["suggest.use"],
        "1d",
        "Changed",
      );
      expect(changed.replaced).toEqual(["suggest.use"]);
      const lifted = await lift(OFFICER, USER.otherMember, ["suggest.use"], "Apologised");
      expect(lifted.lifted).toEqual(["suggest.use"]);
      const history = await blockRows(USER.otherMember);
      expect(history.map((row) => [row.lifted_by, row.lift_reason])).toEqual([
        [USER.secondOfficer, "Replaced by a new pause"],
        [USER.officer, "Apologised"],
      ]);
      expect(history.map((row) => row.issuer_level)).toEqual(["moderator", "moderator"]);
    });

    test("a refusal midway undoes the whole action: nothing is lifted, written or audited", async () => {
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Manager's pause");
      await block(OFFICER, USER.member, ["issue.use"], "1w", "Officer's pause");
      const rows = await blockRows();
      const audits = await auditRows();
      // The officer's own pause comes first in the list and is handled first; the manager's second
      // one refuses the action, and the first must not stay lifted or replaced.
      await scoped(lift(OFFICER, USER.member, ["issue.use", "suggest.use"]), "protected");
      await scoped(block(OFFICER, USER.member, ["issue.use", "suggest.use"]), "protected");
      expect(await blockRows()).toEqual(rows);
      expect(await auditRows()).toEqual(audits);
      expect(await openRows(USER.member)).toHaveLength(2);
    });
  });

  describe("lifting", () => {
    test("a lift ends the named pauses with its reason kept in the history, and audits without it", async () => {
      await block(MANAGER, USER.member, ["suggest.use", "issue.use"], "1w", "Spam");
      const result = await lift(MANAGER, USER.member, ["suggest.use"], "Apologised in the thread");
      expect(result).toEqual({ target: USER.member, lifted: ["suggest.use"], notPaused: [] });
      const rows = await blockRows(USER.member);
      expect(rows.map((row) => [row.permission, row.lifted_by, row.lift_reason]).sort()).toEqual([
        ["issue.use", null, null],
        ["suggest.use", USER.manager, "Apologised in the thread"],
      ]);
      const audits = await auditRows();
      expect(audits.at(-1)).toEqual({
        actor: USER.manager,
        action: "moderation.lift",
        target: USER.member,
        details: { permissions: ["suggest.use"] },
      });
      expect(JSON.stringify(audits)).not.toContain("Apologised");
      const actor = await resolved(USER.member, ROLE.member);
      expect([...actor.access.blocked.keys()]).toEqual(["issue.use"]);
      expect(can(actor, "suggest.use")).toBe(true);
    });

    test("lifting what isn't paused changes and audits nothing; a mixed list lifts what it can", async () => {
      await block(MANAGER, USER.member, ["issue.use"]);
      const audits = await auditRows();
      const none = await lift(MANAGER, USER.member, ["suggest.use"]);
      expect(none).toEqual({ target: USER.member, lifted: [], notPaused: ["suggest.use"] });
      expect(await auditRows()).toEqual(audits);
      const mixed = await lift(MANAGER, USER.member, ["suggest.use", "issue.use"]);
      expect(mixed).toMatchObject({ lifted: ["issue.use"], notPaused: ["suggest.use"] });
      // Lifted twice: the second is "not paused", and the first lift stays as it was.
      const again = await lift(OFFICER, USER.member, ["issue.use"], "A second try");
      expect(again).toMatchObject({ lifted: [], notPaused: ["issue.use"] });
      expect((await blockRows(USER.member))[0]).toMatchObject({
        lifted_by: USER.manager,
        lift_reason: "Resolved",
      });
      expect((await auditRows()).filter((row) => row.action === "moderation.lift")).toHaveLength(1);
    });

    test("a pause that has run out is closed as expired by a lift and reported as not paused", async () => {
      await seed({
        user: USER.member,
        permission: "issue.use",
        created: "2 hours",
        ends: "-1 hour",
      });
      const result = await lift(MANAGER, USER.member, ["issue.use"]);
      expect(result.notPaused).toEqual(["issue.use"]);
      expect((await blockRows(USER.member))[0]).toMatchObject({
        lifted_by: null,
        lift_reason: "expired",
      });
      expect(await auditRows()).toEqual([]);
    });

    test("a lift of someone who has left still works, and removes the pause for when they return", async () => {
      await block(OFFICER, USER.departed, ["suggest.use"]);
      const result = await lift(SECOND_OFFICER, USER.departed, ["suggest.use"]);
      expect(result.lifted).toEqual(["suggest.use"]);
      expect(await openRows(USER.departed)).toEqual([]);
    });
  });

  describe("reading", () => {
    test("a person always reads their own pauses: the reason and the end, never who set them", async () => {
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Spam in suggestions");
      const mine = await moderation.status(MEMBER, USER.member);
      expect(mine).toMatchObject({ subject: USER.member, self: true, ended: [] });
      expect(mine.active).toHaveLength(1);
      expect(mine.active[0]).toMatchObject({
        permission: "suggest.use",
        reason: "Spam in suggestions",
      });
      expect(mine.active[0]?.until).toBeInstanceOf(Date);
      expect(mine.active[0]).not.toHaveProperty("by");
      expect(JSON.stringify(mine)).not.toContain(USER.manager);
      expect(JSON.stringify(mine)).not.toContain("moderator");
      // Lifted pauses leave the person's own view entirely, and lifting reveals nothing.
      await lift(MANAGER, USER.member, ["suggest.use"], "Apologised");
      const after = await moderation.status(MEMBER, USER.member);
      expect(after.active).toEqual([]);
      expect(after.ended).toEqual([]);
      // Someone with no roles at all (a newcomer in the lobby) may ask about themselves too.
      expect(await moderation.status(person(USER.stranger), USER.stranger)).toEqual({
        subject: USER.stranger,
        self: true,
        active: [],
        ended: [],
      });
    });

    test("someone else's pauses need moderation.view, and show the officer who set them and why they ended", async () => {
      await block(OFFICER, USER.member, ["suggest.use"], "1w", "Spam");
      await block(OFFICER, USER.member, ["suggest.use"], "1d", "Still spamming");
      await block(MANAGER, USER.member, ["issue.use"], "1w", "Spam");
      await lift(MANAGER, USER.member, ["issue.use"], "Apologised");
      await seed({
        user: USER.member,
        permission: "ledger.view",
        created: "2 hours",
        ends: "-1 hour",
      });
      await scoped(moderation.status(OTHER_MEMBER, USER.member), "officer", "moderation.view");
      await scoped(moderation.status(MEMBER, USER.otherMember), "officer", "moderation.view");
      const seen = await moderation.status(OFFICER, USER.member);
      expect(seen.self).toBe(false);
      expect(seen.active).toHaveLength(1);
      expect(seen.active[0]).toMatchObject({
        permission: "suggest.use",
        reason: "Still spamming",
        by: { userId: USER.officer, level: "moderator" },
      });
      const ended = Object.fromEntries(
        seen.ended.map((view) => [`${view.permission}:${view.reason}`, view]),
      );
      // Lifted by a person, with their reason; replaced; ran out on its own with nobody to name.
      expect(ended["issue.use:Spam"]).toMatchObject({
        by: { userId: USER.manager, level: "manager" },
        ended: { by: USER.manager, reason: "Apologised" },
      });
      expect(ended["suggest.use:Spam"]).toMatchObject({
        by: { userId: USER.officer, level: "moderator" },
        ended: { by: USER.officer, reason: "Replaced by a new pause" },
      });
      expect(ended["ledger.view:Seeded pause"]?.ended).toEqual({
        at: expect.any(Date),
        by: null,
        reason: null,
      });
      expect(seen.ended).toHaveLength(3);
    });

    test("a pause that ran out ended at its own end, however late a write closed it; a lifted one ended when it was lifted", async () => {
      const DAY = 86_400_000;
      // Ran out three days ago, and nothing has written for this person since.
      await seed({
        user: USER.member,
        permission: "ledger.view",
        reason: "Ran out",
        level: "moderator",
        actor: USER.officer,
        created: "10 days",
        ends: "-3 days",
      });
      // Lifted by a manager a day ago, with two days still to run: its end is the lift.
      await seed({
        user: USER.member,
        permission: "issue.use",
        reason: "Lifted early",
        created: "5 days",
        ends: "2 days",
        lifted: { ago: "1 day", by: USER.manager, reason: "Apologised" },
      });
      // Someone else's, ran out two days ago and is still open in the table: the Moderation page
      // shows it between the two above.
      await seed({
        user: USER.otherMember,
        permission: "suggest.use",
        reason: "Unclosed",
        created: "6 days",
        ends: "-2 days",
      });
      const byPermission = <T extends { permission: string }>(views: readonly T[]) =>
        Object.fromEntries(views.map((view) => [view.permission, view]));
      const stored = async () => {
        const rows = await blockRows();
        const named = (reason: string) => {
          const found = rows.find((candidate) => candidate.reason === reason);
          if (!found) throw new Error(`Missing the pause "${reason}"`);
          return found;
        };
        return { ranOut: named("Ran out"), lifted: named("Lifted early"), open: named("Unclosed") };
      };

      // Before any write closes it, a pause that ran out already shows its own end.
      const early = await stored();
      expect(early.ranOut.lifted_at).toBeNull();
      const beforeStatus = await moderation.status(OFFICER, USER.member);
      expect(beforeStatus.ended.map((view) => view.permission)).toEqual([
        "issue.use",
        "ledger.view",
      ]);

      // A new pause days later closes it, as expired, at today's time.
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "New pause");
      const { ranOut, lifted, open } = await stored();
      expect(ranOut).toMatchObject({ lifted_by: null, lift_reason: "expired" });
      if (!ranOut.lifted_at || !ranOut.expires_at || !lifted.lifted_at || !open.expires_at)
        throw new Error(
          "Expected the closed, the lifted and the unclosed pause to have their times",
        );
      // The gap that makes this test mean something: closing came days after the end.
      expect(ranOut.lifted_at.getTime() - ranOut.expires_at.getTime()).toBeGreaterThanOrEqual(
        2 * DAY,
      );
      // The other person's pause was not touched by it.
      expect(open.lifted_at).toBeNull();

      const ranOutEnd = { at: ranOut.expires_at, by: null, reason: null };
      const liftedEnd = { at: lifted.lifted_at, by: USER.manager, reason: "Apologised" };

      // A person's history: newest end first (the lift a day ago, then the end three days ago),
      // where ordering by when the closing was written would put the ran-out pause first.
      const status = await moderation.status(OFFICER, USER.member);
      expect(status.ended.map((view) => view.permission)).toEqual(["issue.use", "ledger.view"]);
      const history = byPermission(status.ended);
      expect(history["ledger.view"]?.ended).toEqual(ranOutEnd);
      expect(history["ledger.view"]?.until).toEqual(ranOut.expires_at);
      expect(history["ledger.view"]?.by).toEqual({ userId: USER.officer, level: "moderator" });
      expect(history["issue.use"]?.ended).toEqual(liftedEnd);
      // The closing changes nothing the history showed before it.
      expect(status.ended).toEqual(beforeStatus.ended);

      // The Moderation page lists every person's, in the same order by real end.
      const overview = await moderation.overview(OFFICER);
      expect(overview.ended.map((view) => view.permission)).toEqual([
        "issue.use",
        "suggest.use",
        "ledger.view",
      ]);
      const page = byPermission(overview.ended);
      expect(page["ledger.view"]?.ended).toEqual(ranOutEnd);
      expect(page["issue.use"]?.ended).toEqual(liftedEnd);
      expect(page["suggest.use"]?.userId).toBe(USER.otherMember);
      expect(page["suggest.use"]?.ended).toEqual({
        at: open.expires_at,
        by: null,
        reason: null,
      });
      const ends = overview.ended.map((view) => view.ended?.at.getTime() ?? Number.NaN);
      expect(ends).toEqual([...ends].sort((a, b) => b - a));
      // Active pauses carry no end; only the new one is active for this person.
      expect(overview.active.map((view) => [view.userId, view.permission, view.ended])).toEqual([
        [USER.member, "suggest.use", undefined],
      ]);

      // The paused person's own view lists active pauses only, with no end and no lifter.
      const own = await moderation.status(MEMBER, USER.member);
      expect(own.ended).toEqual([]);
      expect(own.active.map((view) => view.ended)).toEqual([undefined]);
    });

    test("a person's history shows the newest ended pauses, up to the limit", async () => {
      await db.query(
        `INSERT INTO member_blocks (batch_id, guild_id, user_id, permission, reason, issuer_level, actor_id,
           lifted_at, lifted_by, lift_reason)
         SELECT $1, $2, $3, 'suggest.use', 'Ended ' || n, 'manager', $4,
           now() - n * interval '1 minute', $4, 'Seeded lift'
         FROM generate_series(1, $5::int) n`,
        [ZERO_BATCH, GUILD, USER.member, USER.manager, ENDED_LIMIT + 5],
      );
      const history = await moderation.status(OFFICER, USER.member);
      expect(history.ended).toHaveLength(ENDED_LIMIT);
      expect(history.ended[0]?.reason).toBe("Ended 1");
      expect(history.ended.at(-1)?.reason).toBe(`Ended ${ENDED_LIMIT}`);
    });

    test("an id this release doesn't know is not shown, and not applied", async () => {
      await seed({ user: USER.member, permission: "later.feature" });
      await block(MANAGER, USER.member, ["suggest.use"]);
      const seen = await moderation.status(OFFICER, USER.member);
      expect(seen.active.map((view) => view.permission)).toEqual(["suggest.use"]);
      expect((await moderation.overview(OFFICER)).active.map((view) => view.permission)).toEqual([
        "suggest.use",
      ]);
      const actor = await resolved(USER.member, ROLE.member);
      expect([...actor.access.blocked.keys()]).toEqual(["suggest.use"]);
    });

    test("the Moderation page lists this server's active and ended pauses, newest first, for those who can see them", async () => {
      await scoped(moderation.overview(MEMBER), "officer", "moderation.view");
      expect(await moderation.overview(OFFICER)).toEqual({
        active: [],
        ended: [],
        truncated: false,
      });
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Older");
      await block(MANAGER, USER.otherMember, ["issue.use"], "1w", "Newer");
      await lift(MANAGER, USER.member, ["suggest.use"], "Done");
      await block(MANAGER, USER.member, ["ledger.view"], "forever", "Newest");
      // Another server's pauses never appear here.
      await seed({ user: USER.member, permission: "roster.refresh", guild: OTHER_GUILD });
      const overview = await moderation.overview(OFFICER);
      expect(overview.truncated).toBe(false);
      expect(overview.active.map((view) => [view.userId, view.permission, view.reason])).toEqual([
        [USER.member, "ledger.view", "Newest"],
        [USER.otherMember, "issue.use", "Newer"],
      ]);
      expect(overview.active[0]).toMatchObject({
        until: null,
        by: { userId: USER.manager, level: "manager" },
      });
      expect(overview.ended).toHaveLength(1);
      expect(overview.ended[0]).toMatchObject({
        permission: "suggest.use",
        reason: "Older",
        ended: { by: USER.manager, reason: "Done" },
      });
    });

    test("an officer who is paused sees their own pauses on the page without who set them, and no ended pause of theirs; a manager sees all of it", async () => {
      // A server manager paused the officer on two features and lifted one of them, with a reason
      // meant for officers about other people. They also paused two members, one lifted since.
      await block(MANAGER, USER.officer, ["suggest.use"], "1w", "Officer's reason");
      await block(MANAGER, USER.officer, ["issue.use"], "1w", "Officer's lifted reason");
      await lift(MANAGER, USER.officer, ["issue.use"], "Private lift reason about the officer");
      await block(MANAGER, USER.member, ["selfroles.use"], "1w", "Member's lifted reason");
      await lift(MANAGER, USER.member, ["selfroles.use"], "Private lift reason about the member");
      await block(MANAGER, USER.otherMember, ["ledger.view"], "1w", "Other member's reason");

      const own = await moderation.overview(OFFICER);
      const ownRows = own.active.filter((view) => view.userId === USER.officer);
      expect(ownRows.map((view) => [view.permission, view.reason])).toEqual([
        ["suggest.use", "Officer's reason"],
      ]);
      // The feature, end and reason show; who set it does not, exactly as /moderate status.
      expect(ownRows[0]?.until).toBeInstanceOf(Date);
      for (const view of ownRows) expect(view).not.toHaveProperty("by");
      expect(JSON.stringify(ownRows)).not.toContain(USER.manager);
      expect(JSON.stringify(ownRows)).not.toContain("moderator");
      expect(await moderation.status(OFFICER, USER.officer)).toMatchObject({
        self: true,
        active: [{ permission: "suggest.use", reason: "Officer's reason" }],
        ended: [],
      });
      // Other people's active pauses keep who set them.
      const others = own.active.find((view) => view.userId === USER.otherMember);
      expect(others).toMatchObject({
        permission: "ledger.view",
        by: { userId: USER.manager, level: "manager" },
      });
      // Their own lifted pause is left out of the ended list entirely, with its lift reason.
      expect(own.ended.map((view) => [view.userId, view.permission])).toEqual([
        [USER.member, "selfroles.use"],
      ]);
      expect(own.ended[0]).toMatchObject({
        by: { userId: USER.manager, level: "manager" },
        ended: { by: USER.manager, reason: "Private lift reason about the member" },
      });
      expect(JSON.stringify(own)).not.toContain("Private lift reason about the officer");
      expect(JSON.stringify(own)).not.toContain("Officer's lifted reason");

      // A server manager sees the same pauses of the officer with who set them and the lift reason.
      const all = await moderation.overview(MANAGER);
      expect(
        all.active
          .filter((view) => view.userId === USER.officer)
          .map((view) => [view.permission, view.by]),
      ).toEqual([["suggest.use", { userId: USER.manager, level: "manager" }]]);
      const endedOfficer = all.ended.filter((view) => view.userId === USER.officer);
      expect(endedOfficer).toHaveLength(1);
      expect(endedOfficer[0]).toMatchObject({
        permission: "issue.use",
        reason: "Officer's lifted reason",
        by: { userId: USER.manager, level: "manager" },
        ended: { by: USER.manager, reason: "Private lift reason about the officer" },
      });
      expect(all.ended).toHaveLength(2);
      // Another officer, not paused, sees the first officer's rows as a manager does.
      const second = await moderation.overview(SECOND_OFFICER);
      expect(second.ended.map((view) => [view.userId, view.ended?.reason])).toEqual(
        all.ended.map((view) => [view.userId, view.ended?.reason]),
      );
      expect(second.active.find((view) => view.userId === USER.officer)?.by).toEqual({
        userId: USER.manager,
        level: "manager",
      });
    });

    test("the viewer's own ended pauses don't use up the page's limit for ended ones", async () => {
      // The officer's ENDED_LIMIT pauses ended in the last half hour; another person's
      // ENDED_LIMIT + 2 ended earlier than any of those.
      const seedEnded = (user: string, label: string, count: number, minutesAgo: number) =>
        db.query(
          `INSERT INTO member_blocks (batch_id, guild_id, user_id, permission, reason, issuer_level, actor_id,
             lifted_at, lifted_by, lift_reason)
           SELECT $1, $2, $3, 'suggest.use', $4 || ' ' || n, 'manager', $5,
             now() - ($6::int + n) * interval '1 minute', $5, 'Seeded lift'
           FROM generate_series(1, $7::int) n`,
          [ZERO_BATCH, GUILD, user, label, USER.manager, minutesAgo, count],
        );
      await seedEnded(USER.officer, "Own ended", ENDED_LIMIT, 0);
      await seedEnded(USER.member, "Other ended", ENDED_LIMIT + 2, 100);

      const own = await moderation.overview(OFFICER);
      expect(own.ended).toHaveLength(ENDED_LIMIT);
      expect(own.ended.every((view) => view.userId === USER.member)).toBe(true);
      expect(own.ended[0]?.reason).toBe("Other ended 1");
      expect(own.ended.at(-1)?.reason).toBe(`Other ended ${ENDED_LIMIT}`);
      // Ordering is still newest end first.
      const ends = own.ended.map((view) => view.ended?.at.getTime() ?? Number.NaN);
      expect(ends).toEqual([...ends].sort((a, b) => b - a));

      // A manager has no ended pauses of their own to leave out, and the officer's are newest.
      const all = await moderation.overview(MANAGER);
      expect(all.ended).toHaveLength(ENDED_LIMIT);
      expect(all.ended.every((view) => view.userId === USER.officer)).toBe(true);
      expect(all.ended[0]?.reason).toBe("Own ended 1");
      // With fewer of the other person's than the limit, the page is just those.
      await db.query("TRUNCATE member_blocks");
      await seedEnded(USER.officer, "Own ended", ENDED_LIMIT + 3, 0);
      await seedEnded(USER.member, "Other ended", 3, 100);
      const few = await moderation.overview(OFFICER);
      expect(few.ended.map((view) => view.reason)).toEqual([
        "Other ended 1",
        "Other ended 2",
        "Other ended 3",
      ]);
    });

    test("a long list is cut at the page's limit and says so; ended pauses show the newest", async () => {
      const seedMany = async (active: number, ended: number) => {
        await db.query("TRUNCATE guilds, users, audit CASCADE");
        await db.orm.insert(t.guilds).values({ id: GUILD, effects_enabled: true });
        await db.query(
          `INSERT INTO users (id) SELECT (800000000000000000 + n)::text FROM generate_series(1, $1::int) n`,
          [Math.max(active, ended)],
        );
        await db.query(
          `INSERT INTO guild_users (guild_id, user_id)
           SELECT $1, (800000000000000000 + n)::text FROM generate_series(1, $2::int) n`,
          [GUILD, Math.max(active, ended)],
        );
        await db.query(
          `INSERT INTO member_blocks (batch_id, guild_id, user_id, permission, reason, issuer_level, actor_id)
           SELECT $1, $2, (800000000000000000 + n)::text, 'suggest.use', 'Seeded active', 'manager', $3
           FROM generate_series(1, $4::int) n`,
          [ZERO_BATCH, GUILD, USER.manager, active],
        );
        // Lifted n minutes ago: the smaller n is the newer.
        await db.query(
          `INSERT INTO member_blocks (batch_id, guild_id, user_id, permission, reason, issuer_level, actor_id,
             lifted_at, lifted_by, lift_reason)
           SELECT $1, $2, (800000000000000000 + n)::text, 'issue.use', 'Seeded ended', 'manager', $3,
             now() - n * interval '1 minute', $3, 'Seeded lift'
           FROM generate_series(1, $4::int) n`,
          [ZERO_BATCH, GUILD, USER.manager, ended],
        );
      };
      await seedMany(ACTIVE_LIMIT + 1, ENDED_LIMIT + 5);
      const cut = await moderation.overview(OFFICER);
      expect(cut.active).toHaveLength(ACTIVE_LIMIT);
      expect(cut.truncated).toBe(true);
      expect(cut.ended).toHaveLength(ENDED_LIMIT);
      expect(cut.ended[0]?.userId).toBe("800000000000000001");
      expect(cut.ended.at(-1)?.userId).toBe(String(800000000000000000n + BigInt(ENDED_LIMIT)));
      // Exactly the limit is not a cut.
      await seedMany(ACTIVE_LIMIT, 0);
      const whole = await moderation.overview(OFFICER);
      expect(whole.active).toHaveLength(ACTIVE_LIMIT);
      expect(whole.truncated).toBe(false);
    });

    test("an officer who can see pauses finds who sent a suggestion, in this server only", async () => {
      await db.orm.insert(t.auditEvents).values([
        { guild_id: GUILD, actor_id: USER.member, action: "suggestion.posted", target: "#7" },
        {
          guild_id: OTHER_GUILD,
          actor_id: USER.otherMember,
          action: "suggestion.posted",
          target: "#7",
        },
        { guild_id: GUILD, actor_id: USER.guest, action: "suggestion.posted", target: "#12" },
        { guild_id: GUILD, actor_id: USER.guest, action: "suggestion.unconfirmed", target: "#8" },
        { guild_id: GUILD, actor_id: USER.guest, action: "suggestion.posted", target: "7" },
        {
          guild_id: OTHER_GUILD,
          actor_id: USER.otherMember,
          action: "suggestion.posted",
          target: "#9",
        },
      ]);
      expect(await moderation.senderOfSuggestion(OFFICER, 7)).toBe(USER.member);
      expect(await moderation.senderOfSuggestion(MANAGER, 12)).toBe(USER.guest);
      expect(await moderation.senderOfSuggestion({ ...OFFICER, guildId: OTHER_GUILD }, 7)).toBe(
        USER.otherMember,
      );
      // Not found: another server's number, a suggestion that was never confirmed, an unknown one.
      expect(await moderation.senderOfSuggestion(OFFICER, 9)).toBeNull();
      expect(await moderation.senderOfSuggestion(OFFICER, 8)).toBeNull();
      expect(await moderation.senderOfSuggestion(OFFICER, 99)).toBeNull();
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
        expect(await moderation.senderOfSuggestion(OFFICER, bad)).toBeNull();
      await scoped(moderation.senderOfSuggestion(MEMBER, 7), "officer", "moderation.view");
      // A repeated number answers with the newest record.
      await db.orm.insert(t.auditEvents).values({
        guild_id: GUILD,
        actor_id: USER.otherMember,
        action: "suggestion.posted",
        target: "#7",
      });
      expect(await moderation.senderOfSuggestion(OFFICER, 7)).toBe(USER.otherMember);
    });

    test("names come from the gateway when it can say, and are left out when it can't", async () => {
      expect(await moderation.names(GUILD, [])).toEqual(new Map());
      expect(nameRequests).toEqual([]);
      const names = await moderation.names(GUILD, [USER.member, USER.member, USER.guest]);
      expect(names).toEqual(
        new Map([
          [USER.member, "Name 31"],
          [USER.guest, "Name 33"],
        ]),
      );
      expect(nameRequests).toEqual([[USER.member, USER.guest]]);
      namesFail = true;
      expect(await moderation.names(GUILD, [USER.member])).toEqual(new Map());
    });
  });

  describe("shutdown", () => {
    test("writes are refused once shutdown starts, and written nothing", async () => {
      stopping = () => true;
      expect(await refused(block(MANAGER, USER.member, ["suggest.use"]))).toMatchObject({
        code: "stopping",
      });
      expect(await refused(lift(MANAGER, USER.member, ["suggest.use"]))).toMatchObject({
        code: "stopping",
      });
      // The permission is judged first, so a plain member still hears the officer-only refusal.
      await scoped(block(MEMBER, USER.member, ["suggest.use"]), "officer", "moderation.block");
      expect(await blockRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
      // Reading goes on.
      expect((await moderation.status(MEMBER, USER.member)).active).toEqual([]);
    });

    test("a write that shutdown catches midway rolls back, audit row included", async () => {
      // How often a clean block asks whether shutdown began: on entry, at the start of its
      // transaction, and once more after every write, which is the ask that must undo them all.
      // Stopping at the last ask is shutdown catching the write midway.
      let asked = 0;
      stopping = () => {
        asked++;
        return false;
      };
      await block(MANAGER, USER.otherMember, ["suggest.use"]);
      const total = asked;
      expect(total).toBeGreaterThanOrEqual(3);
      const rows = await blockRows();
      const audits = await auditRows();
      asked = 0;
      stopping = () => ++asked >= total;
      expect(
        await refused(block(MANAGER, USER.member, ["suggest.use", "issue.use"])),
      ).toMatchObject({
        code: "stopping",
      });
      expect(await blockRows()).toEqual(rows);
      expect(await auditRows()).toEqual(audits);
      // Likewise a lift: counted on a clean run, then stopped at its last ask.
      asked = 0;
      stopping = () => {
        asked++;
        return false;
      };
      await lift(MANAGER, USER.otherMember, ["suggest.use"]);
      const liftAsks = asked;
      expect(liftAsks).toBeGreaterThanOrEqual(3);
      await block(MANAGER, USER.otherMember, ["suggest.use"]);
      const held = await blockRows();
      const heldAudits = await auditRows();
      asked = 0;
      stopping = () => ++asked >= liftAsks;
      expect(await refused(lift(MANAGER, USER.otherMember, ["suggest.use"]))).toMatchObject({
        code: "stopping",
      });
      expect(await blockRows()).toEqual(held);
      expect(await auditRows()).toEqual(heldAudits);
      expect(await openRows(USER.otherMember)).toHaveLength(1);
    });
  });

  describe("concurrent writes", () => {
    test("two pauses of the same person and feature at once leave exactly one open", async () => {
      const results = await Promise.all([
        block(OFFICER, USER.member, ["suggest.use"], "1w", "From the first"),
        block(SECOND_OFFICER, USER.member, ["suggest.use"], "1d", "From the second"),
      ]);
      const open = await openRows(USER.member);
      expect(open).toHaveLength(1);
      const history = await blockRows(USER.member);
      expect(history).toHaveLength(2);
      // Whichever ran second replaced the first; the one that ran first replaced nothing.
      expect(results.map((result) => result.replaced.length).sort()).toEqual([0, 1]);
      const closed = history.filter((row) => row.lifted_at !== null);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.lift_reason).toBe("Replaced by a new pause");
      expect(await auditRows()).toHaveLength(2);
    });

    test("many at once across features never trip the open-pause rule", async () => {
      const permissions = BLOCKABLE.filter((id) => id !== "modmail.open");
      await Promise.all(
        permissions.flatMap((id) => [
          block(MANAGER, USER.member, [id]),
          block(MANAGER, USER.member, [id]),
        ]),
      );
      expect(await openRows(USER.member)).toHaveLength(permissions.length);
      expect(await blockRows(USER.member)).toHaveLength(permissions.length * 2);
    });

    test("a lift and a pause racing leave at most one open pause, and the original lifted either way", async () => {
      await block(MANAGER, USER.member, ["suggest.use"], "1w", "Original");
      await Promise.all([
        lift(MANAGER, USER.member, ["suggest.use"]),
        block(MANAGER, USER.member, ["suggest.use"], "1d", "Raced"),
      ]);
      const history = await blockRows(USER.member);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ reason: "Original" });
      expect(history[0]?.lifted_at).toBeInstanceOf(Date);
      // Lift first: the new pause stays. Pause first: it replaced the original and the lift took it.
      const open = history.filter((row) => row.lifted_at === null);
      expect(open.length).toBeLessThanOrEqual(1);
      for (const row of open) expect(row.reason).toBe("Raced");
    });
  });

  describe("Service.enrichActor reading pauses", () => {
    test("a paused member keeps the permission but can't use it; the rest of their access is untouched", async () => {
      await block(MANAGER, USER.member, ["suggest.use"], "1d", "Spam in suggestions");
      const [row] = await openRows(USER.member);
      const actor = await resolved(USER.member, ROLE.member);
      expect(actor.member).toBe(true);
      expect(holds(actor, "suggest.use")).toBe(true);
      expect(can(actor, "suggest.use")).toBe(false);
      expect(actor.access.blocked.get("suggest.use")).toEqual({
        until: row?.expires_at ?? null,
        reason: "Spam in suggestions",
      });
      expect(pauseOn(actor, "suggest.use")?.until).toBeInstanceOf(Date);
      for (const id of BLOCKABLE.filter((id) => id !== "suggest.use"))
        expect(can(actor, id)).toBe(true);
      // The one decision point reports a pause as one, naming the feature, end and reason.
      const failure = await refused(
        Promise.resolve().then(() => requirePermission(actor, GUILD, "suggest.use")),
      );
      expect(failure.detail).toEqual({
        kind: "scope",
        scope: "blocked",
        permission: "suggest.use",
        ...(row?.expires_at && { until: row.expires_at }),
        reason: "Spam in suggestions",
      });
      // Until lifted carries no end.
      await block(MANAGER, USER.member, ["suggest.use"], "forever", "Indefinitely");
      const forever = await resolved(USER.member, ROLE.member);
      expect(forever.access.blocked.get("suggest.use")).toEqual({
        until: null,
        reason: "Indefinitely",
      });
    });

    test("a pause on a permission the person doesn't hold takes nothing from them", async () => {
      // A newcomer without roles holds the baseline only; ledger.view is a Member role's.
      await block(MANAGER, USER.member, ["ledger.view"]);
      const lobby = await resolved(USER.member);
      expect(holds(lobby, "ledger.view")).toBe(false);
      expect(lobby.access.blocked.size).toBe(0);
      // Given the Member role, it applies.
      expect(pauseOn(await resolved(USER.member, ROLE.member), "ledger.view")).toBeDefined();
    });

    test("ended, lifted, other-server and unknown pauses are not applied", async () => {
      await seed({
        user: USER.member,
        permission: "suggest.use",
        created: "2 hours",
        ends: "-1 hour",
      });
      await seed({
        user: USER.member,
        permission: "issue.use",
        lifted: { ago: "5 minutes", by: USER.manager, reason: "Resolved" },
      });
      await seed({ user: USER.member, permission: "selfroles.use", guild: OTHER_GUILD });
      await seed({ user: USER.member, permission: "later.feature" });
      await seed({ user: USER.member, permission: "ledger.deposit", ends: "1 hour" });
      const actor = await resolved(USER.member, ROLE.member);
      expect([...actor.access.blocked.keys()]).toEqual(["ledger.deposit"]);
    });

    test("a server manager gets no pauses whatever is stored", async () => {
      await seed({ user: USER.manager, permission: "ledger.view" });
      await seed({ user: USER.manager, permission: "issue.use" });
      const manager = await app.enrichActor(raw(USER.manager, [], true));
      expect(manager.access.manager).toBe(true);
      expect(manager.access.blocked.size).toBe(0);
      expect(can(manager, "ledger.view")).toBe(true);
      // The same stored rows do apply to the same person without Manage Server and Manage Roles.
      const demoted = await app.enrichActor(raw(USER.manager, [ROLE.member]));
      expect([...demoted.access.blocked.keys()].sort()).toEqual(["issue.use", "ledger.view"]);
    });

    test("a pause takes effect on the next resolution and ends with the next one after a lift", async () => {
      expect((await resolved(USER.member, ROLE.member)).access.blocked.size).toBe(0);
      await block(MANAGER, USER.member, ["suggest.use", "issue.use"]);
      expect((await resolved(USER.member, ROLE.member)).access.blocked.size).toBe(2);
      await lift(MANAGER, USER.member, ["suggest.use", "issue.use"]);
      expect((await resolved(USER.member, ROLE.member)).access.blocked.size).toBe(0);
    });
  });
});
