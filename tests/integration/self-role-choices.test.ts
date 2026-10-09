/**
 * Members' role choices (2.40.0) over real PostgreSQL: My roles (SelfRoles.view), saving
 * (SelfRoles.choose: the changed categories only, the merge into a waiting change under concurrent
 * saves, the equal-state rule and every refusal), the roles.self job through the real queue and
 * dispatcher (the user lock it shares with reconcile.user, every role checked again on a fresh
 * snapshot and skipped and counted when it fails, a member who left, a cleared payload completing
 * before the effects gate, a paused server parking it, no delivery_attempts row),
 * Synchronization.user's removal of channel-opening menu roles from someone left without Member
 * or Guest (owner decision Q3 B), the 7-day expiry and 30-day retention in schedule(), migration
 * 012's trigger clearing the payload on every terminal path, and privacy: no role ID in a result,
 * diagnostic, log event, issue report or officer view. The Discord port is a fake that records
 * every call: web operations only ever read the gateway cache. Confined to its own schema,
 * self_role_choices_it, with invented IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import { GuildAccess } from "../../src/application/guild-access.js";
import { IssueReports } from "../../src/application/issue-reports.js";
import type { DiscordPort } from "../../src/application/records.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { type RoleChoiceRequest, SelfRoles } from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type { Configuration } from "../../src/config/env.js";
import type { ApiOverwrite, ApiRole } from "../../src/domain/permissions.js";
import type { Actor } from "../../src/domain/policy.js";
import {
  type CategoryChoice,
  CHOICE_MESSAGES,
  type SelfRoleMenu,
} from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import type { VisibilityGuild } from "../../src/domain/visibility.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import {
  Database,
  ensureUser,
  SESSION_OPTIONS,
} from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import {
  closeUnstarted,
  enqueue,
  type Job,
  Queue,
  type QueueEvent,
  requeueParked,
} from "../../src/jobs/queue.js";
import { FakeGuildAccess } from "../fixtures/guild-access.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "self_role_choices_it";
const GUILD = "100000000000000001";
/** Invented role IDs: the access roles, a moderation role, TaruBot's role, and menu roles. */
const ROLE = {
  member: "100000000000000011",
  guest: "100000000000000012",
  officer: "100000000000000013",
  leader: "100000000000000014",
  retired: "100000000000000015",
  kick: "100000000000000018",
  bot: "100000000000000019",
  /** Cosmetic: opens nothing. */
  pronoun: "100000000000000021",
  pronoun2: "100000000000000022",
  /** Opens #game. */
  game: "100000000000000023",
  /** Opens #game too, but sits above TaruBot, so TaruBot can't remove it. */
  above: "100000000000000025",
} as const;
/** Every role a menu here holds: none may ever appear in a result, diagnostic or report. */
const MENU_ROLES = [ROLE.pronoun, ROLE.pronoun2, ROLE.game, ROLE.above];
const CHANNEL = { general: "100000000000000031", game: "100000000000000032" } as const;
const USER = {
  member: "200000000000000001",
  guest: "200000000000000002",
  officer: "200000000000000003",
} as const;
const CATEGORY = {
  pronouns: "00000000-0000-4000-8000-000000000001",
  games: "00000000-0000-4000-8000-000000000002",
} as const;
const JOINED = new Date("2026-01-01T00:00:00Z");

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

const role = (id: string, position: number, permissions = 0n, managed = false): ApiRole => ({
  id,
  name: `role ${id}`,
  position,
  permissions: String(permissions),
  hoist: false,
  managed,
});
const ow = (id: string, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type: 0,
  allow: String(allow),
  deny: String(deny),
});
const EVERYONE = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect;

/** The server as TaruBot sees it; `game` gives the game role extra server permissions. */
function snapshot(game = 0n): VisibilityGuild {
  return {
    guildId: GUILD,
    bot: { id: "100000000000000099", roles: [ROLE.bot], botRoleId: ROLE.bot },
    roles: [
      role(GUILD, 0, EVERYONE),
      role(ROLE.member, 1),
      role(ROLE.guest, 2),
      role(ROLE.pronoun, 3),
      role(ROLE.pronoun2, 4),
      role(ROLE.game, 5, game),
      role(ROLE.retired, 6),
      // The lowest moderation role: every menu role must sit below it.
      role(ROLE.kick, 7, P.KickMembers),
      role(ROLE.officer, 8),
      role(ROLE.leader, 9),
      role(ROLE.bot, 20, P.ManageRoles, true),
      role(ROLE.above, 30),
    ],
    channels: [
      {
        id: CHANNEL.general,
        type: ChannelType.GuildText,
        parentId: null,
        position: 0,
        overwrites: [],
        obfuscated: false,
      },
      {
        id: CHANNEL.game,
        type: ChannelType.GuildText,
        parentId: null,
        position: 1,
        overwrites: [
          ow(GUILD, 0n, P.ViewChannel),
          ow(ROLE.game, P.ViewChannel),
          ow(ROLE.above, P.ViewChannel),
        ],
        obfuscated: false,
      },
    ],
    heldRoles: [],
    communityUpdatesId: null,
  };
}

const option = (roleId: string, removalOnly = false) => ({ roleId, description: "", removalOnly });
/** Pronouns (pick one, cosmetic) and Games (any number; Game opens #game). */
const MENU: SelfRoleMenu = {
  v: 1,
  categories: [
    {
      id: CATEGORY.pronouns,
      name: "Pronouns",
      description: "",
      max: 1,
      state: "published",
      options: [option(ROLE.pronoun), option(ROLE.pronoun2)],
    },
    {
      id: CATEGORY.games,
      name: "Games",
      description: "",
      max: null,
      state: "published",
      options: [option(ROLE.game)],
    },
  ],
};

/** One category of a My roles submission. */
const sent = (categoryId: string, seen: string[], picked: string[]): CategoryChoice => ({
  categoryId,
  seen,
  picked,
});

/** Collapse whitespace, so a statement compares the same however a document indents it. */
const squash = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * The restore step's SQL from the owner's restore checklist, checked to match the copies in
 * docs/PERSISTENCE.md and the site's recovery steps, so the statement this file runs is the one
 * people are told to run.
 */
async function restoreStep(): Promise<string> {
  const statement = (text: string): string => {
    const found = text
      .split("```")
      .find((block) => block.includes(`'{"skipped":"restored"}'`) && block.includes("UPDATE jobs"));
    if (!found) throw new Error("The restore step's SQL is missing");
    const sql = found.slice(found.indexOf("UPDATE jobs"));
    return squash(sql.slice(0, sql.indexOf(";") + 1));
  };
  const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();
  const checklist = statement(await read("docs/DEPLOYMENT.md"));
  expect(statement(await read("docs/PERSISTENCE.md"))).toBe(checklist);
  expect(statement(await read("site/src/content/docs/deploy/operations.md"))).toBe(checklist);
  return checklist;
}

describe.skipIf(!url)("members' role choices", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());

  /** What each user holds in the fake Discord. */
  let held: Map<string, Set<string>>;
  /** Every Discord call, by method (and freshness or reason). */
  let calls: string[];
  /** What a cache read and a fresh read of TaruBot's view return. */
  let cached: VisibilityGuild | null;
  let fresh: VisibilityGuild | null;
  /** Roles the fake skips one at a time, as the gateway does for 10011 or a role above it. */
  let refused: Set<string>;
  /** What the next selfRoles write throws, if anything. */
  let writeFailure: Error | null;
  /** What the next access write (roles) throws, if anything: a failed access change. */
  let rolesFailure: Error | null;
  /** The lifecycle's shutdown flag, as SelfRoles reads it. */
  let stopping: () => boolean;
  /** Every queue event, for the privacy scan of what the worker logs. */
  let events: QueueEvent[];

  const unused = async (): Promise<never> => {
    throw new Error("Not expected here");
  };
  const discord: DiscordPort = {
    member: async (_guild, user) => {
      calls.push("member");
      const roles = held.get(user);
      return roles
        ? {
            id: user,
            guildId: GUILD,
            joinedAt: JOINED,
            nickname: null,
            roles: [...roles],
            bot: false,
          }
        : null;
    },
    members: async () => [],
    validateRole: async () => {
      calls.push("validateRole");
    },
    validateChannel: unused,
    roles: async (_guild, user, add, remove) => {
      calls.push(`roles +${add.join(",")} -${remove.join(",")}`);
      if (rolesFailure) throw rolesFailure;
      const roles = held.get(user) ?? new Set<string>();
      for (const id of remove) roles.delete(id);
      for (const id of add) roles.add(id);
      held.set(user, roles);
    },
    layoutRoles: unused,
    nickname: unused,
    send: unused,
    editReview: unused,
    dm: unused,
    visibility: async (_guild, isFresh) => {
      calls.push(`visibility ${isFresh ? "fresh" : "cache"}`);
      return isFresh ? fresh : cached;
    },
    selfRoles: async (_guild, user, add, remove, reason) => {
      calls.push(`selfRoles ${reason} +${add.join(",")} -${remove.join(",")}`);
      if (writeFailure) throw writeFailure;
      const roles = held.get(user) ?? new Set<string>();
      const written = { added: 0, removed: 0, skipped: 0 };
      for (const id of remove)
        if (refused.has(id)) written.skipped++;
        else {
          roles.delete(id);
          written.removed++;
        }
      for (const id of add)
        if (refused.has(id)) written.skipped++;
        else {
          roles.add(id);
          written.added++;
        }
      held.set(user, roles);
      return written;
    },
    cachedRoles: (_guild, user) => {
      calls.push("cachedRoles");
      const roles = held.get(user);
      return roles ? [...roles] : null;
    },
  };
  const app = new Service(db, discord, {} as Lodestone, CONFIG);
  const sync = new Synchronization(app);
  const selfRoles = new SelfRoles(app, () => stopping());
  const queue = new Queue(
    db,
    dispatcher(app, sync, new GuildAccess(app, new FakeGuildAccess())),
    (event) => events.push(event),
  );

  /** A member, guest or officer as a POST resolves them: their roles from the fake Discord now. */
  const actor = (userId: string, extra: Partial<Actor> = {}): Actor => ({
    guildId: GUILD,
    userId,
    officer: false,
    manageRoles: false,
    roleIds: [...(held.get(userId) ?? [])],
    member: userId === USER.member,
    guest: userId === USER.guest,
    botAdministrator: false,
    timedOut: false,
    ...extra,
  });
  const save = (userId: string, ...categories: CategoryChoice[]) =>
    selfRoles.choose(actor(userId), { categories } satisfies RoleChoiceRequest);
  /** Every roles.self row, oldest first. */
  const choiceRows = () =>
    db.orm
      .select({
        id: t.jobs.id,
        status: t.jobs.status,
        payload: t.jobs.payload,
        result: t.jobs.result,
        generation: t.jobs.generation,
        attempts: t.jobs.attempts,
        last_error: t.jobs.last_error,
        user_id: t.jobs.user_id,
        dedupe_key: t.jobs.dedupe_key,
      })
      .from(t.jobs)
      .where(eq(t.jobs.kind, "roles.self"))
      .orderBy(asc(t.jobs.created_at));
  const onlyRow = async () => {
    const rows = await choiceRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error("Missing roles.self row");
    return row;
  };
  /** Claim and run the next due job, as one worker would. */
  const runNext = async (): Promise<Job> => {
    const job = await queue.claim();
    if (!job) throw new Error("Nothing to run");
    await queue.perform(job);
    return job;
  };
  /** A roles.self row as the queue would hold it, queued with `payload`. */
  const queueChoice = (userId: string, payload: unknown) =>
    enqueue(db.pool, "roles.self", `self-roles:${GUILD}:${userId}`, payload, GUILD, userId);
  const choice = (chosen: string[], offered: string[], savedAt = new Date().toISOString()) => ({
    chosen,
    offered,
    savedAt,
  });
  /**
   * What main.ts logs for each queue event: a job's identifiers, its classified outcome (code,
   * status, source, diagnostic) and timings, never its payload; a worker error is reported whole.
   */
  const logged = () =>
    events.map((event) =>
      event.type === "job"
        ? { kind: event.job.kind, generation: event.job.generation, outcome: event.outcome }
        : { error: String(event.error) },
    );
  /** No menu role ID anywhere in `value`, nor a role mention. */
  const roleFree = (value: unknown) => {
    const text = JSON.stringify(value) ?? "";
    expect(text).not.toContain("<@&");
    for (const roleId of MENU_ROLES) expect(text).not.toContain(roleId);
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
      "TRUNCATE guilds, users, jobs, audit, retired_roles, channel_access_policies, self_role_menus, delivery_attempts, issue_reports CASCADE",
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
    await db.orm.insert(t.selfRoleMenus).values({ guild_id: GUILD, menu: MENU, revision: 5n });
    held = new Map([
      [USER.member, new Set([GUILD, ROLE.member, ROLE.pronoun])],
      [USER.guest, new Set([GUILD, ROLE.guest])],
      [USER.officer, new Set([GUILD, ROLE.officer])],
    ]);
    calls = [];
    cached = snapshot();
    fresh = snapshot();
    refused = new Set();
    writeFailure = null;
    rolesFailure = null;
    stopping = () => false;
    events = [];
  });

  describe("My roles and saving", () => {
    test("the page shows the person's roles ticked, from the caches alone", async () => {
      const page = await selfRoles.view(actor(USER.member));
      expect(page).toMatchObject({
        guildId: GUILD,
        configured: true,
        unreadableMenu: false,
        available: true,
        status: null,
        effectsMode: "live",
        timedOut: false,
        canSave: true,
        administrator: null,
      });
      expect(
        page.categories.map((category) => ({
          id: category.id,
          input: category.input,
          ticked: category.options.filter((row) => row.ticked).map((row) => row.roleId),
        })),
      ).toEqual([
        { id: CATEGORY.pronouns, input: "one", ticked: [ROLE.pronoun] },
        { id: CATEGORY.games, input: "many", ticked: [] },
      ]);
      // No Discord request: the cached view and the cached member only.
      expect(calls).toEqual(["visibility cache", "cachedRoles"]);
      // Officers are admitted too, and see whether TaruBot holds Administrator.
      expect(
        (await selfRoles.view(actor(USER.officer, { officer: true, member: false }))).administrator,
      ).toBeFalse();
    });

    test("a save queues one role-free job; the job applies it, and the payload is cleared", async () => {
      expect(
        await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2])),
      ).toEqual({ status: "saved" });
      // The web read the cache and wrote nothing to Discord.
      expect(calls).toEqual(["visibility cache"]);
      const queued = await onlyRow();
      expect(queued).toMatchObject({
        status: "queued",
        user_id: USER.member,
        dedupe_key: `self-roles:${GUILD}:${USER.member}`,
        generation: 1,
      });
      expect(queued.payload).toMatchObject({
        chosen: [ROLE.pronoun2],
        offered: [ROLE.pronoun, ROLE.pronoun2],
      });
      // No audit row per member save (owner decision Q4 A).
      expect(await db.orm.$count(t.auditEvents)).toBe(0);
      // The page shows the waiting change as it asks, and says it is on its way.
      const waiting = await selfRoles.view(actor(USER.member));
      expect(waiting.status).toEqual({
        state: "waiting",
        skipped: 0,
        changed: false,
        recent: false,
        completedAt: null,
      });
      expect(
        waiting.categories[0]?.options.map((row) => [row.roleId, row.held, row.ticked]),
      ).toEqual([
        [ROLE.pronoun, true, false],
        [ROLE.pronoun2, false, true],
      ]);
      calls = [];
      const job = await runNext();
      expect(calls).toEqual([
        "member",
        "visibility fresh",
        `selfRoles chosen +${ROLE.pronoun2} -${ROLE.pronoun}`,
      ]);
      expect([...(held.get(USER.member) ?? [])].sort()).toEqual(
        [GUILD, ROLE.member, ROLE.pronoun2].sort(),
      );
      const done = await onlyRow();
      expect(done).toMatchObject({
        status: "succeeded",
        payload: {},
        result: { status: "applied", added: 1, removed: 1, skipped: 0 },
        last_error: null,
      });
      // A role change records no delivery attempt.
      expect(await db.orm.$count(t.deliveryAttempts, eq(t.deliveryAttempts.job_id, job.id))).toBe(
        0,
      );
      const after = await selfRoles.view(actor(USER.member));
      // Dated by the database's completion time, which the banners show when they warn.
      const [ended] = await db.orm
        .select({ completed_at: t.jobs.completed_at })
        .from(t.jobs)
        .where(eq(t.jobs.id, job.id));
      expect(ended?.completed_at).toBeInstanceOf(Date);
      expect(after.status).toEqual({
        state: "applied",
        skipped: 0,
        changed: true,
        recent: true,
        completedAt: ended?.completed_at ?? null,
      });
      expect(after.categories[0]?.options.find((row) => row.ticked)?.roleId).toBe(ROLE.pronoun2);
      roleFree(done.result);
      roleFree(logged());
    });

    test("a double submit is the same success; nothing changed, or nothing to do, is unchanged", async () => {
      const form = sent(CATEGORY.games, [], [ROLE.game]);
      expect(await save(USER.member, form)).toEqual({ status: "saved" });
      const first = await onlyRow();
      expect(await save(USER.member, form)).toEqual({ status: "saved" });
      // The repeat wrote nothing: same generation, same payload (savedAt included).
      expect(await onlyRow()).toEqual(first);
      // A form that came back as it was shown.
      expect(
        await save(
          USER.member,
          sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun]),
          sent(CATEGORY.games, [], []),
        ),
      ).toEqual({ status: "unchanged" });
      await runNext();
      // Minutes later (a change that ended within the last 5 minutes makes the roles a POST read
      // untrustworthy: see the next test), Dyno gave Pronoun 2 after the page rendered; the
      // member picks it too: they already hold what they ask, and nothing waits, so nothing is
      // queued.
      await db.query("UPDATE jobs SET completed_at=completed_at-interval '6 minutes'");
      held.get(USER.member)?.add(ROLE.pronoun2);
      held.get(USER.member)?.delete(ROLE.pronoun);
      expect(
        await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2])),
      ).toEqual({ status: "unchanged" });
      expect((await choiceRows()).map((row) => row.status)).toEqual(["succeeded"]);
    });

    test("a save just after a change of theirs ended is queued, though it matches the roles the POST read", async () => {
      // The POST resolved the member (holding Pronoun) while their last change, Pronoun to
      // Pronoun 2, was still running; it finished before the save's transaction.
      const resolved = actor(USER.member);
      await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2]));
      await runNext();
      expect(held.get(USER.member)?.has(ROLE.pronoun2)).toBeTrue();
      // From a page whose waiting change ticked Pronoun 2, they pick Pronoun again. Against the
      // roles read before the change ended that is nothing to do, but Discord now holds Pronoun 2,
      // so the undo is queued rather than lost.
      const undo = { categories: [sent(CATEGORY.pronouns, [ROLE.pronoun2], [ROLE.pronoun])] };
      expect(await selfRoles.choose(resolved, undo)).toEqual({ status: "saved" });
      await runNext();
      expect([...(held.get(USER.member) ?? [])].sort()).toEqual(
        [GUILD, ROLE.member, ROLE.pronoun].sort(),
      );
      // Once no change of theirs ended in the last 5 minutes, the shortcut stands again: the
      // same request, from roles read now, is nothing to save.
      await db.query("UPDATE jobs SET completed_at=completed_at-interval '6 minutes'");
      expect(await selfRoles.choose(actor(USER.member), undo)).toEqual({ status: "unchanged" });
      expect((await choiceRows()).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    });

    test("a second save merges into the waiting one, and savedAt moves with it", async () => {
      await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2]));
      const first = await onlyRow();
      await save(USER.member, sent(CATEGORY.games, [], [ROLE.game]));
      const second = await onlyRow();
      expect(second.id).toBe(first.id);
      expect(second.generation).toBe(2);
      expect(second.payload).toMatchObject({
        chosen: [ROLE.pronoun2, ROLE.game],
        offered: [ROLE.pronoun, ROLE.pronoun2, ROLE.game],
      });
      const at = (row: { payload: unknown }) =>
        new Date(String(Reflect.get(row.payload as object, "savedAt"))).getTime();
      expect(at(second)).toBeGreaterThanOrEqual(at(first));
      // Changing Pronouns again replaces only what the waiting change asked there.
      await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun2], [""]));
      expect((await onlyRow()).payload).toMatchObject({
        chosen: [ROLE.game],
        offered: [ROLE.game, ROLE.pronoun, ROLE.pronoun2],
      });
    });

    test("saves at the same moment merge rather than one overwriting the other", async () => {
      const results = await Promise.all([
        save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2])),
        save(USER.member, sent(CATEGORY.games, [], [ROLE.game])),
      ]);
      expect(results).toEqual([{ status: "saved" }, { status: "saved" }]);
      const row = await onlyRow();
      const payload = row.payload as { chosen: string[]; offered: string[] };
      expect(payload.chosen.sort()).toEqual([ROLE.pronoun2, ROLE.game].sort());
      expect(payload.offered.sort()).toEqual([ROLE.pronoun, ROLE.pronoun2, ROLE.game].sort());
    });

    test("a save while the job runs gives it a new generation, and it runs again with the merge", async () => {
      await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2]));
      const running = await queue.claim();
      if (!running) throw new Error("Nothing to run");
      await save(USER.member, sent(CATEGORY.games, [], [ROLE.game]));
      await queue.perform(running);
      // The first run applied what it read; completion saw the newer generation and re-queued.
      const requeued = await onlyRow();
      expect(requeued).toMatchObject({ status: "queued", generation: 2 });
      expect(requeued.payload).toMatchObject({ chosen: [ROLE.pronoun2, ROLE.game] });
      await runNext();
      expect(await onlyRow()).toMatchObject({
        status: "succeeded",
        payload: {},
        result: { status: "applied", added: 1, removed: 0, skipped: 0 },
      });
      expect(held.get(USER.member)?.has(ROLE.game)).toBeTrue();
    });

    test("refusals: paused, timed out, no access, shutdown, setup and an unreadable view", async () => {
      const refusal = (promise: Promise<unknown>) =>
        promise.then(
          () => {
            throw new Error("Expected a refusal");
          },
          (error: unknown) =>
            error instanceof Failure ? { code: error.code, message: error.message } : error,
        );
      const form = sent(CATEGORY.games, [], [ROLE.game]);
      expect(
        await refusal(
          selfRoles.choose(actor(USER.member, { timedOut: true }), { categories: [form] }),
        ),
      ).toEqual({ code: "forbidden", message: CHOICE_MESSAGES.timedOut });
      expect(
        await refusal(
          selfRoles.choose(actor(USER.member, { botAdministrator: true }), { categories: [form] }),
        ),
      ).toEqual({ code: "forbidden", message: CHOICE_MESSAGES.noAccess });
      expect(
        await refusal(
          selfRoles.choose(actor(USER.member, { member: false }), { categories: [form] }),
        ),
      ).toEqual({ code: "forbidden", message: CHOICE_MESSAGES.noAccess });
      cached = null;
      expect(await refusal(save(USER.member, form))).toEqual({
        code: "unavailable",
        message: CHOICE_MESSAGES.unavailable,
      });
      cached = snapshot();
      stopping = () => true;
      expect(await refusal(save(USER.member, form))).toMatchObject({ code: "stopping" });
      // Shutdown starting mid-save rolls the save back.
      let checks = 0;
      stopping = () => ++checks > 1;
      expect(await refusal(save(USER.member, form))).toMatchObject({ code: "stopping" });
      stopping = () => false;
      expect(await choiceRows()).toEqual([]);
      await db.orm.update(t.guilds).set({ effects_enabled: false }).where(eq(t.guilds.id, GUILD));
      expect(await refusal(save(USER.member, form))).toEqual({
        code: "disabled",
        message: CHOICE_MESSAGES.paused,
      });
      const paused = await selfRoles.view(actor(USER.member));
      expect(paused).toMatchObject({ effectsMode: "awaiting_activation", canSave: false });
      // A timed-out member may still look.
      await db.orm.update(t.guilds).set({ effects_enabled: true }).where(eq(t.guilds.id, GUILD));
      expect(await selfRoles.view(actor(USER.member, { timedOut: true }))).toMatchObject({
        timedOut: true,
        canSave: false,
      });
      await db.orm.update(t.guilds).set({ active: false }).where(eq(t.guilds.id, GUILD));
      expect(await refusal(save(USER.member, form))).toMatchObject({ code: "setup" });
      expect(await choiceRows()).toEqual([]);
    });

    test("a role the menu no longer offers is a 409, too many picked or a failing role a 422", async () => {
      expect(await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.game]))).toEqual(
        { status: "conflict" },
      );
      expect(
        await save(
          USER.member,
          sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun, ROLE.pronoun2]),
        ),
      ).toEqual({
        status: "invalid",
        errors: [{ categoryId: CATEGORY.pronouns, max: 1, message: CHOICE_MESSAGES.max(1) }],
      });
      // A pick-one category where the member holds a role above TaruBot, which can't be changed
      // here: it counts toward the limit, so picking another role there is refused too.
      await db.orm
        .update(t.selfRoleMenus)
        .set({
          menu: {
            ...MENU,
            categories: MENU.categories.map((category) =>
              category.id === CATEGORY.pronouns
                ? { ...category, options: [...category.options, option(ROLE.above)] }
                : category,
            ),
          },
        })
        .where(eq(t.selfRoleMenus.guild_id, GUILD));
      held.set(USER.member, new Set([GUILD, ROLE.member, ROLE.above]));
      expect(await save(USER.member, sent(CATEGORY.pronouns, [], [ROLE.pronoun]))).toEqual({
        status: "invalid",
        errors: [
          { categoryId: CATEGORY.pronouns, message: CHOICE_MESSAGES.fixedMax([ROLE.above], 1) },
        ],
      });
      // "No role from this category" stays open: it touches only what they can change.
      expect(await save(USER.member, sent(CATEGORY.pronouns, [], [""]))).toEqual({
        status: "unchanged",
      });
      held.set(USER.member, new Set([GUILD, ROLE.member, ROLE.pronoun]));
      await db.orm
        .update(t.selfRoleMenus)
        .set({ menu: MENU })
        .where(eq(t.selfRoleMenus.guild_id, GUILD));
      cached = snapshot(P.KickMembers);
      expect(await save(USER.member, sent(CATEGORY.games, [], [ROLE.game]))).toEqual({
        status: "invalid",
        errors: [
          {
            categoryId: CATEGORY.games,
            roleId: ROLE.game,
            message: CHOICE_MESSAGES.unavailableRole(ROLE.game),
          },
        ],
      });
      expect(await choiceRows()).toEqual([]);
    });

    test("a parked change is replaced by the next save, and its role IDs go at once", async () => {
      const parked = await queueChoice(
        USER.member,
        choice([ROLE.pronoun2], [ROLE.pronoun, ROLE.pronoun2]),
      );
      await db.orm.update(t.jobs).set({ status: "disabled" }).where(eq(t.jobs.id, parked));
      await save(USER.member, sent(CATEGORY.games, [], [ROLE.game]));
      const [old, next] = await choiceRows();
      expect(old).toMatchObject({
        id: parked,
        status: "succeeded",
        payload: {},
        result: { skipped: "superseded" },
      });
      // The parked change's picks carried over into the new row.
      expect(next).toMatchObject({ status: "queued" });
      expect(next?.payload).toMatchObject({
        chosen: [ROLE.pronoun2, ROLE.game],
        offered: [ROLE.pronoun, ROLE.pronoun2, ROLE.game],
      });
    });
  });

  describe("the roles.self job", () => {
    test("it shares the member's lock with reconcile.user: busy waits without spending an attempt", async () => {
      await queueChoice(USER.member, choice([ROLE.game], [ROLE.game]));
      const holder = await db.pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          `user:${GUILD}:${USER.member}`,
        ]);
        await runNext();
        expect(await onlyRow()).toMatchObject({ status: "queued", attempts: 0 });
        expect((await onlyRow()).last_error).toStartWith("busy: ");
        expect(calls).toEqual([]);
        await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          `user:${GUILD}:${USER.member}`,
        ]);
      } finally {
        holder.release();
      }
      await db.query("UPDATE jobs SET due_at=now()");
      await runNext();
      expect(await onlyRow()).toMatchObject({ status: "succeeded" });
    });

    test("every role is checked again on a fresh view: failures and Discord's refusals are counted", async () => {
      // Wants Game and Pronoun 2, not Pronoun. Game gained Kick Members since the save; Pronoun 2
      // was deleted in Discord just before the write (the gateway skips a 10011).
      await queueChoice(
        USER.member,
        choice([ROLE.game, ROLE.pronoun2], [ROLE.game, ROLE.pronoun, ROLE.pronoun2]),
      );
      fresh = snapshot(P.KickMembers);
      refused = new Set([ROLE.pronoun2]);
      await runNext();
      expect(calls).toEqual([
        "member",
        "visibility fresh",
        `selfRoles chosen +${ROLE.pronoun2} -${ROLE.pronoun}`,
      ]);
      const row = await onlyRow();
      expect(row).toMatchObject({
        status: "succeeded",
        payload: {},
        result: { status: "applied", added: 0, removed: 1, skipped: 2 },
      });
      roleFree(row);
      roleFree(logged());
    });

    test("someone who lost every access role since saving gets no channel-opening role", async () => {
      await queueChoice(
        USER.member,
        choice([ROLE.game, ROLE.pronoun2], [ROLE.game, ROLE.pronoun, ROLE.pronoun2]),
      );
      held.get(USER.member)?.delete(ROLE.member);
      await runNext();
      // The cosmetic choice still applies; Game would open #game without Member (Q3 B).
      expect(calls.at(-1)).toBe(`selfRoles chosen +${ROLE.pronoun2} -${ROLE.pronoun}`);
      expect(await onlyRow()).toMatchObject({
        result: { status: "applied", added: 1, removed: 1, skipped: 1 },
      });
    });

    test("someone with Officer or FC Leader but neither Member nor Guest still gets a channel-opening role", async () => {
      // Officer and FC Leader count as access too (owner decision Q3 B), so Game, which opens
      // #game, is added for either alone.
      for (const rank of [ROLE.officer, ROLE.leader]) {
        await db.query("DELETE FROM jobs");
        held.set(USER.officer, new Set([GUILD, rank]));
        await queueChoice(USER.officer, choice([ROLE.game], [ROLE.game]));
        calls = [];
        await runNext();
        expect({ rank, last: calls.at(-1) }).toEqual({
          rank,
          last: `selfRoles chosen +${ROLE.game} -`,
        });
        expect(await onlyRow()).toMatchObject({
          result: { status: "applied", added: 1, removed: 0, skipped: 0 },
        });
        expect(held.get(USER.officer)?.has(ROLE.game)).toBeTrue();
      }
    });

    test("a held role that no longer passes the add rules can still be removed", async () => {
      held.get(USER.member)?.add(ROLE.game);
      await queueChoice(USER.member, choice([], [ROLE.game]));
      fresh = snapshot(P.KickMembers);
      await runNext();
      expect(await onlyRow()).toMatchObject({
        result: { status: "applied", added: 0, removed: 1, skipped: 0 },
      });
      expect(held.get(USER.member)?.has(ROLE.game)).toBeFalse();
      expect((await selfRoles.view(actor(USER.member))).status).toMatchObject({
        state: "applied",
        skipped: 0,
        changed: true,
      });
    });

    test("only the menu as it is now: a role taken off since the save is skipped, never touched", async () => {
      await queueChoice(USER.member, choice([ROLE.game], [ROLE.game]));
      await db.orm
        .update(t.selfRoleMenus)
        .set({ menu: { v: 1, categories: [MENU.categories[0]] } })
        .where(eq(t.selfRoleMenus.guild_id, GUILD));
      await runNext();
      // Nothing to write, so not even a fresh view is read.
      expect(calls).toEqual(["member"]);
      expect(await onlyRow()).toMatchObject({
        result: { status: "applied", added: 0, removed: 0, skipped: 1 },
      });
      // Nothing was applied, so the page doesn't call it updated (RoleChoiceStatus.changed).
      expect((await selfRoles.view(actor(USER.member))).status).toMatchObject({
        state: "applied",
        skipped: 1,
        changed: false,
      });
    });

    test("a member who left completes as skipped, and the payload is cleared", async () => {
      await queueChoice(USER.member, choice([ROLE.game], [ROLE.game]));
      held.delete(USER.member);
      await runNext();
      expect(await onlyRow()).toMatchObject({
        status: "succeeded",
        payload: {},
        result: { skipped: "member left" },
      });
    });

    test("a cleared payload completes before the effects gate; a paused server parks the rest", async () => {
      await db.orm.update(t.guilds).set({ effects_enabled: false }).where(eq(t.guilds.id, GUILD));
      // An operator retried a failed change, whose payload the trigger already cleared.
      const retried = await queueChoice(USER.member, {});
      await runNext();
      expect(await onlyRow()).toMatchObject({
        id: retried,
        status: "succeeded",
        result: { skipped: "nothing to apply" },
      });
      await db.query("TRUNCATE jobs CASCADE");
      await queueChoice(USER.guest, choice([ROLE.game], [ROLE.game]));
      await runNext();
      // Parked, the payload kept for when changes resume (within the 7 days).
      const parked = await onlyRow();
      expect(parked).toMatchObject({ status: "disabled" });
      expect(parked.payload).toMatchObject({ chosen: [ROLE.game] });
      expect(calls).toEqual([]);
    });

    test("TaruBot losing Manage Roles blocks the job, role-free; the payload waits, and a save retries", async () => {
      await queueChoice(USER.member, choice([ROLE.game], [ROLE.game]));
      writeFailure = new Failure(
        "blocked",
        "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.",
      );
      await runNext();
      const blocked = await onlyRow();
      expect(blocked).toMatchObject({ status: "blocked" });
      expect(blocked.payload).toMatchObject({ chosen: [ROLE.game] });
      roleFree(blocked.last_error);
      roleFree(logged());
      // Saving again re-queues the blocked job with the merged change.
      writeFailure = null;
      await save(USER.member, sent(CATEGORY.pronouns, [ROLE.pronoun], [ROLE.pronoun2]));
      expect(await onlyRow()).toMatchObject({ status: "queued", generation: 2 });
      await db.query("UPDATE jobs SET due_at=now()");
      await runNext();
      expect(await onlyRow()).toMatchObject({
        status: "succeeded",
        result: { status: "applied", added: 2, removed: 1, skipped: 0 },
      });
    });

    test("a fresh view without Manage Roles blocks the job before any write, role-free, keeping the payload", async () => {
      // An add and a removal: without Manage Roles every role fails bot_cannot_manage, which
      // blocks both, so the job must wait as blocked rather than finish with everything skipped.
      held.get(USER.member)?.add(ROLE.game);
      await queueChoice(
        USER.member,
        choice([ROLE.pronoun2], [ROLE.pronoun, ROLE.pronoun2, ROLE.game]),
      );
      const lost = snapshot();
      fresh = {
        ...lost,
        roles: lost.roles.map((entry) =>
          entry.id === ROLE.bot ? { ...entry, permissions: "0" } : entry,
        ),
      };
      await runNext();
      const blocked = await onlyRow();
      expect(blocked).toMatchObject({
        status: "blocked",
        result: null,
        last_error:
          "blocked: TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.",
      });
      expect(blocked.payload).toMatchObject({ chosen: [ROLE.pronoun2] });
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      roleFree(blocked.last_error);
      roleFree(logged());
      // The member is told it is blocked, never that their roles were updated.
      expect((await selfRoles.view(actor(USER.member))).status).toMatchObject({
        state: "blocked",
      });
      // Once Manage Roles is back, the retry applies all of it.
      fresh = snapshot();
      await db.query("UPDATE jobs SET status='queued', due_at=now()");
      await runNext();
      expect(await onlyRow()).toMatchObject({
        status: "succeeded",
        payload: {},
        result: { status: "applied", added: 1, removed: 2, skipped: 0 },
      });
    });

    test("an unreadable payload fails the job with a fixed sentence, and the trigger clears it", async () => {
      await queueChoice(USER.member, { chosen: [ROLE.game], offered: [] });
      await runNext();
      const row = await onlyRow();
      expect(row).toMatchObject({
        status: "failed",
        payload: {},
        last_error: "invalid_job: A role choice job's payload can't be read.",
      });
      roleFree(logged());
    });
  });

  describe("losing Member and Guest (owner decision Q3 B)", () => {
    /** A guest with a grant, so reconciliation keeps Guest unless the guest is revoked. */
    const guestWithGrant = async (revoked: boolean) => {
      await ensureUser(db.pool, GUILD, USER.guest, JOINED);
      await db.orm.insert(t.guestGrants).values({
        guild_id: GUILD,
        user_id: USER.guest,
        provenance: "manual",
        source_key: `manual:${GUILD}:${USER.guest}`,
      });
      if (revoked)
        await db.orm.insert(t.guestState).values({
          guild_id: GUILD,
          user_id: USER.guest,
          revoked: true,
        });
    };
    const reconcile = async (preview = false) => {
      const id = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${GUILD}:${USER.guest}`,
        {},
        GUILD,
        USER.guest,
      );
      const [job] = await db.query<Job>(
        "UPDATE jobs SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE id=$1 RETURNING *",
        [id],
      );
      if (!job) throw new Error("Missing reconcile job");
      return sync.user(job, async () => {}, preview);
    };

    test("a revoked guest loses channel-opening menu roles and keeps cosmetic ones", async () => {
      await guestWithGrant(true);
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.game, ROLE.pronoun]));
      // The preview shows the removal as a count.
      expect(await reconcile(true)).toMatchObject({ remove: [ROLE.guest], selfRoles: 1 });
      calls = [];
      const result = await reconcile();
      expect(calls).toContain(`roles + -${ROLE.guest}`);
      expect(calls).toContain(`selfRoles access + -${ROLE.game}`);
      expect([...(held.get(USER.guest) ?? [])].sort()).toEqual([GUILD, ROLE.pronoun].sort());
      // The result names the access roles it changed, and only counts the menu role.
      expect(result).toMatchObject({ remove: [ROLE.guest], selfRoles: 1, status: "applied" });
      roleFree(result);
    });

    test("someone with no access role and nothing to change about it loses channel-opening roles too", async () => {
      // A lobby user another bot gave Game, or someone who lost Member and Guest before this
      // release or before the category was published: no grant, no guild facts and no access
      // role, so the pass changes no access role, and its removal still runs.
      held.set(USER.guest, new Set([GUILD, ROLE.game, ROLE.pronoun]));
      expect(await reconcile(true)).toMatchObject({ add: [], remove: [], selfRoles: 1 });
      calls = [];
      const result = await reconcile();
      // The empty access delta still reaches the port, naming no role.
      const access = calls.filter((call) => call.startsWith("roles "));
      expect(access.every((call) => call === "roles + -")).toBeTrue();
      expect(calls).toContain(`selfRoles access + -${ROLE.game}`);
      // The cosmetic Pronoun stays.
      expect([...(held.get(USER.guest) ?? [])].sort()).toEqual([GUILD, ROLE.pronoun].sort());
      expect(result).toMatchObject({ add: [], remove: [], selfRoles: 1, status: "applied" });
      roleFree(result);
    });

    test("nothing changes while Guest is kept", async () => {
      await guestWithGrant(false);
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.game]));
      const result = await reconcile();
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect(result).not.toHaveProperty("selfRoles");
      expect(held.get(USER.guest)?.has(ROLE.game)).toBeTrue();
    });

    test("drafts are never acted on", async () => {
      await guestWithGrant(true);
      await db.orm
        .update(t.selfRoleMenus)
        .set({
          menu: {
            v: 1,
            categories: [{ ...MENU.categories[1], state: "draft" }],
          },
        })
        .where(eq(t.selfRoleMenus.guild_id, GUILD));
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.game]));
      await reconcile();
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect(held.get(USER.guest)?.has(ROLE.game)).toBeTrue();
    });

    test("an officer losing Guest keeps their menu roles: Officer counts as access", async () => {
      await guestWithGrant(true);
      // Officer by a manual grant: with no FC linked, rank evidence alone would say no, and
      // reconciliation would take Officer too.
      await db.orm.insert(t.officerOverrides).values({
        guild_id: GUILD,
        user_id: USER.guest,
        state: "granted",
        reason: "Invented grant",
        actor_id: USER.officer,
      });
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.officer, ROLE.game]));
      const preview = await reconcile(true);
      expect(preview).toMatchObject({ add: [], remove: [ROLE.guest] });
      expect(preview).not.toHaveProperty("selfRoles");
      calls = [];
      const result = await reconcile();
      expect(calls).toContain(`roles + -${ROLE.guest}`);
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect(result).not.toHaveProperty("selfRoles");
      expect([...(held.get(USER.guest) ?? [])].sort()).toEqual(
        [GUILD, ROLE.officer, ROLE.game].sort(),
      );
    });

    test("an FC Leader losing Guest keeps their menu roles: FC Leader counts as access", async () => {
      await guestWithGrant(true);
      // An FC linked and a link whose membership isn't known yet: FC Leader is "unknown", so the
      // pass keeps the held role (missing evidence never takes a rank role away).
      const FC = "300000000000000001";
      const CHARACTER = "400000000000000001";
      await db.orm
        .insert(t.freeCompanies)
        .values({ id: FC, name: "Invented FC", world: "Invented" })
        .onConflictDoNothing();
      await db.orm
        .insert(t.characters)
        .values({ id: CHARACTER, name: "Invented Character", world: "Invented" })
        .onConflictDoNothing();
      await db.orm.update(t.guilds).set({ fc_id: FC }).where(eq(t.guilds.id, GUILD));
      await db.orm.insert(t.links).values({
        guild_id: GUILD,
        user_id: USER.guest,
        character_id: CHARACTER,
        provenance: "imported_link",
      });
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.leader, ROLE.game]));
      const preview = await reconcile(true);
      expect(preview).toMatchObject({ add: [], remove: [ROLE.guest] });
      expect(preview).not.toHaveProperty("selfRoles");
      calls = [];
      await reconcile();
      expect(calls).toContain(`roles + -${ROLE.guest}`);
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect([...(held.get(USER.guest) ?? [])].sort()).toEqual(
        [GUILD, ROLE.leader, ROLE.game].sort(),
      );
    });

    test("a server that binds neither Member nor Guest has no access TaruBot manages: nothing is taken", async () => {
      await guestWithGrant(true);
      await db.orm
        .update(t.guilds)
        .set({ member_role_id: null, guest_role_id: null })
        .where(eq(t.guilds.id, GUILD));
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.game]));
      expect(await reconcile(true)).not.toHaveProperty("selfRoles");
      calls = [];
      const result = await reconcile();
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect(result).not.toHaveProperty("selfRoles");
      expect(held.get(USER.guest)?.has(ROLE.game)).toBeTrue();
    });

    test("a failed access change takes no menu role: the pass fails with the access refusal", async () => {
      await guestWithGrant(true);
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.game]));
      const refusal = new Failure(
        "blocked",
        "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.",
      );
      rolesFailure = refusal;
      calls = [];
      await expect(reconcile()).rejects.toBe(refusal);
      expect(calls).toContain(`roles + -${ROLE.guest}`);
      expect(calls.filter((call) => call.startsWith("selfRoles"))).toEqual([]);
      expect([...(held.get(USER.guest) ?? [])].sort()).toEqual(
        [GUILD, ROLE.guest, ROLE.game].sort(),
      );
    });

    test("a role TaruBot can't remove is left alone, and the access change still applies", async () => {
      await guestWithGrant(true);
      await db.orm
        .update(t.selfRoleMenus)
        .set({
          menu: {
            v: 1,
            categories: [
              { ...MENU.categories[1], options: [option(ROLE.game), option(ROLE.above)] },
            ],
          },
        })
        .where(eq(t.selfRoleMenus.guild_id, GUILD));
      held.set(USER.guest, new Set([GUILD, ROLE.guest, ROLE.above, ROLE.game]));
      // Pronoun refusals one at a time don't block either: the fake skips Game like a 10011.
      refused = new Set([ROLE.game]);
      const result = await reconcile();
      expect(calls).toContain(`roles + -${ROLE.guest}`);
      expect(calls).toContain(`selfRoles access + -${ROLE.game}`);
      expect(result).toMatchObject({ status: "applied", selfRoles: 0 });
      expect(held.get(USER.guest)?.has(ROLE.above)).toBeTrue();
      expect(held.get(USER.guest)?.has(ROLE.guest)).toBeFalse();
    });
  });

  describe("retention, the trigger and privacy", () => {
    test("the trigger clears the payload on every path that ends a change", async () => {
      const payloadOf = async (id: string) =>
        (await db.orm.select({ payload: t.jobs.payload }).from(t.jobs).where(eq(t.jobs.id, id)))[0]
          ?.payload;
      const waiting = choice([ROLE.game], [ROLE.game]);
      // Supersede: two parked rows for one key; the older one closes when they resume.
      const older = await queueChoice(USER.member, waiting);
      await db.orm.update(t.jobs).set({ status: "disabled" }).where(eq(t.jobs.id, older));
      const newer = await queueChoice(USER.member, waiting);
      await db.orm.update(t.jobs).set({ status: "disabled" }).where(eq(t.jobs.id, newer));
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await requeueParked(client, [GUILD], ["disabled"]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(await payloadOf(older)).toEqual({});
      // The survivor waits again, its payload kept.
      expect(await payloadOf(newer)).toEqual(waiting);
      // closeUnstarted, as any "this is pointless now" path closes a key.
      await closeUnstarted(db.pool, `self-roles:${GUILD}:${USER.member}`, "test");
      expect(await payloadOf(newer)).toEqual({});
      // The restore step, exactly as the owner's checklist gives it (docs/DEPLOYMENT.md), run
      // before the bot starts on a restored copy.
      const restored = await queueChoice(USER.guest, waiting);
      await db.query(await restoreStep());
      expect(await payloadOf(restored)).toEqual({});
      expect(await selfRoles.view(actor(USER.guest))).toMatchObject({
        status: { state: "dropped" },
      });
      // An operator's own SQL.
      const direct = await queueChoice(USER.officer, waiting);
      await db.query("UPDATE jobs SET status='failed' WHERE id=$1", [direct]);
      expect(await payloadOf(direct)).toEqual({});
    });

    test("the payload survives every waiting state", async () => {
      const waiting = choice([ROLE.game], [ROLE.game]);
      const id = await queueChoice(USER.member, waiting);
      for (const status of ["running", "blocked", "disabled", "queued"]) {
        await db.orm.update(t.jobs).set({ status }).where(eq(t.jobs.id, id));
        expect(await onlyRow()).toMatchObject({ status, payload: waiting });
      }
    });

    test("expiry follows the last save, not the first; a running change is left to finish while its lease lives", async () => {
      const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      // A server TaruBot left while a worker held a change there: Queue.claim() never reclaims
      // anything in an inactive server.
      const LEFT = "100000000000000002";
      await db.orm.insert(t.guilds).values({ id: LEFT, active: false });
      const row = async (
        user: string,
        savedAt: string | null,
        status: string,
        guildId: string = GUILD,
      ) => {
        const id = await enqueue(
          db.pool,
          "roles.self",
          `self-roles:${guildId}:${user}`,
          savedAt === null ? {} : choice([ROLE.game], [ROLE.game], savedAt),
          guildId,
          user,
        );
        // Created on day 0, eight days ago.
        await db.query(
          "UPDATE jobs SET created_at=now()-interval '8 days', status=$2 WHERE id=$1",
          [id, status],
        );
        return id;
      };
      const resaved = await row("200000000000000011", at(1), "blocked");
      const expired = await row("200000000000000012", at(8), "blocked");
      const parked = await row("200000000000000013", at(7.5), "disabled");
      // A worker holds it now, with a live lease: left to finish.
      const running = await row("200000000000000014", at(8), "running");
      await db.query("UPDATE jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1", [
        running,
      ]);
      // Its worker died (a crash, or killed past the deploy's grace) in the server TaruBot left:
      // the lease ran out and nothing will ever reclaim it, so it is closed like a waiting one.
      const dead = await row("200000000000000017", at(8), "running", LEFT);
      await db.query("UPDATE jobs SET lease_until=now()-interval '1 hour' WHERE id=$1", [dead]);
      // A running row with no lease at all is just as dead.
      const unleased = await row("200000000000000018", at(8), "running", LEFT);
      const cleared = await row("200000000000000015", null, "queued");
      // A malformed clock can't fail the pass; it falls back to created_at.
      const malformed = await row("200000000000000016", at(1), "queued");
      await db.query(
        `UPDATE jobs SET payload=jsonb_set(payload,'{savedAt}','"not a time"') WHERE id=$1`,
        [malformed],
      );
      await sync.schedule();
      const states = Object.fromEntries(
        (await choiceRows()).map((entry) => [
          entry.id,
          [entry.status, entry.result, entry.payload],
        ]),
      );
      const closed = ["succeeded", { skipped: "expired" }, {}];
      expect(states[resaved]?.[0]).toBe("blocked");
      expect(states[expired]).toEqual(closed);
      expect(states[parked]).toEqual(closed);
      expect(states[running]?.[0]).toBe("running");
      expect(states[dead]).toEqual(closed);
      expect(states[unleased]).toEqual(closed);
      expect(states[cleared]).toEqual(closed);
      expect(states[malformed]).toEqual(closed);
      // The banner says the change was dropped.
      held.set("200000000000000012", new Set([GUILD, ROLE.member]));
      expect((await selfRoles.view(actor("200000000000000012", { member: true }))).status).toEqual({
        state: "expired",
        skipped: 0,
        changed: false,
        recent: true,
        completedAt: expect.any(Date),
      });
    });

    test("retention deletes a finished change the worker ran, with nothing referencing it", async () => {
      await save(USER.member, sent(CATEGORY.games, [], [ROLE.game]));
      const job = await runNext();
      const waiting = await queueChoice(USER.guest, choice([ROLE.game], [ROLE.game]));
      await db.query("UPDATE jobs SET created_at=now()-interval '40 days'");
      await db.query("UPDATE jobs SET completed_at=now()-interval '31 days' WHERE id=$1", [job.id]);
      await sync.schedule();
      expect((await choiceRows()).map((row) => row.id)).toEqual([waiting]);
    });

    test("/guest status never carries role choices: an officer's record of a member, or the member's own", async () => {
      // The reconcile.user row the member's own record reads, then a dozen newer role saves:
      // eleven applied and one blocked.
      const reconcileJob = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${GUILD}:${USER.member}`,
        {},
        GUILD,
        USER.member,
      );
      await db.query(
        "UPDATE jobs SET status='succeeded', completed_at=now(), created_at=now()-interval '1 hour' WHERE id=$1",
        [reconcileJob],
      );
      for (let save = 0; save < 12; save++) {
        const id = await queueChoice(USER.member, choice([ROLE.game], [ROLE.game]));
        await db.query(
          save < 11
            ? `UPDATE jobs SET status='succeeded', completed_at=now(), result='{"status":"applied","added":1,"removed":0,"skipped":0}' WHERE id=$1`
            : "UPDATE jobs SET status='blocked', last_error='blocked: TaruBot needs Manage Roles.' WHERE id=$1",
          [id],
        );
      }
      expect(await choiceRows()).toHaveLength(12);
      // Any officer, delegated ones included, may open the member's record: it holds no roles.self
      // row, so neither the card's deliveries, its health, nor its Full details (JSON) can give a
      // timeline of when the member changed roles (owner decision Q4 A).
      const officer = actor(USER.officer, { officer: true, member: false });
      const record = await app.guestStatus(officer, USER.member);
      expect(record.delivery.map((job) => [job.kind, job.id])).toEqual([
        ["reconcile.user", reconcileJob],
      ]);
      roleFree(record);
      // The member's own record still finds its reconcile.user behind a dozen newer saves.
      const own = await app.guestStatus(actor(USER.member), USER.member);
      expect(own.delivery.map((job) => job.kind)).toEqual(["reconcile.user"]);
      // The member still sees their own role choices in /sync status.
      const mine = await app.syncStatus(actor(USER.member), null);
      expect(mine.work.filter((job) => job.kind === "roles.self").map((job) => job.status)).toEqual(
        ["blocked"],
      );
    });

    test("issue reports and officers' job views show a change happened, never which roles", async () => {
      await queueChoice(USER.member, choice([ROLE.game], [ROLE.game, ROLE.pronoun]));
      writeFailure = new Failure(
        "blocked",
        "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.",
      );
      await runNext();
      const reports = new IssueReports(CONFIG, db, {} as Lodestone, new RecentLogs(), null);
      await reports.user(actor(USER.member), "a member", "REF1", "My roles didn't change at all.");
      const [report] = await db.orm
        .select({ body: t.issueReports.body })
        .from(t.issueReports)
        .where(and(eq(t.issueReports.source, "user"), eq(t.issueReports.user_id, USER.member)));
      expect(report?.body).toContain("roles.self");
      expect(report?.body).toContain("blocked");
      roleFree(report?.body);
      // An officer sees "a member" (no user) and nothing that names a role.
      const officer = await app.syncStatus(
        actor(USER.officer, { officer: true, member: false }),
        null,
      );
      const work = officer.work.filter((job) => job.kind === "roles.self");
      expect(work.map((job) => [job.status, job.user_id])).toEqual([["blocked", null]]);
      roleFree(work);
      // The member sees their own.
      const own = await app.syncStatus(actor(USER.member), null);
      expect(own.work.filter((job) => job.kind === "roles.self")[0]?.user_id).toBe(USER.member);
    });
  });
});
