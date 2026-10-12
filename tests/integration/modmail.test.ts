/**
 * Mod mail over real PostgreSQL (2.43.0): migration 014's tables and triggers, opening cases (the
 * switch, the limits, numbering under concurrency), access (another member's case doesn't exist for
 * them), encryption at rest (no plaintext in any row, the AAD binding a ciphertext to its row),
 * the read log, replies, Close and Reopen with their revision lock, the notification jobs (case IDs
 * only, coalesced), the jobs' sends, retention, and the shutdown rollback. Confined to its own
 * schema, modmail_it, with invented IDs; keys come from readable phrases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  ModMail,
  ModMailNotices,
  ModMailRetention,
  pruneModMail,
  RETENTION_INTERVAL_MS,
} from "../../src/application/modmail.js";
import type { DirectMessage, DiscordPort, PostMessage } from "../../src/application/records.js";
import type { Reporter } from "../../src/application/reporting.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import { MODMAIL_LIMITS, pingKey, dmKey } from "../../src/domain/modmail.js";
import { type Actor, OFFICERS_ONLY } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { loadVisibilityRecords } from "../../src/application/visibility-records.js";
import {
  analyseVisibility,
  type VisibilityGuild,
  visibilitySettings,
} from "../../src/domain/visibility.js";
import { PermissionFlagsBits as P } from "discord.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import {
  fieldAad,
  readModMailKey,
  type ModMailKey,
} from "../../src/infrastructure/modmail/cipher.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import type { GuildAccess } from "../../src/application/guild-access.js";
import type { Synchronization } from "../../src/application/synchronization.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import { type Job, jobOutcome } from "../../src/jobs/queue.js";
import { type ActorSpec, actorOf } from "../fixtures/actors.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "modmail_it";
const GUILD = "666666666666666801";
const OTHER_GUILD = "666666666666666802";
const ROLE = {
  member: "523456789012345801",
  guest: "523456789012345802",
  officer: "523456789012345803",
} as const;
const CHANNEL = "623456789012345801";
const ORIGIN = "https://tarubot.example.org";
/** A string that must never appear anywhere but the page that shows it. */
const CANARY = "canary-plaintext-modmail-5e2b";

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

/** A key from a phrase, never a random-looking literal. */
const keyFor = (phrase: string): ModMailKey =>
  readModMailKey(createHash("sha256").update(phrase).digest().toString("base64"));

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
const OFFICER = person("723456789012345801", { officer: true });
const SECOND_OFFICER = person("723456789012345802", { officer: true });
const MEMBER = person("723456789012345811", { member: true });
const OTHER_MEMBER = person("723456789012345812", { member: true });
const GUEST = person("723456789012345813", { guest: true });
const LOBBY = person("723456789012345814");

/**
 * `actor` less modmail.respond: reads every case but may not answer them. No role carries that
 * set in 2.44.0; stored sets (2.46.0) can, so ModMail checks it on its own.
 */
const withoutRespond = (actor: Actor): Actor => {
  const permissions = new Set(actor.access.permissions);
  permissions.delete("modmail.respond");
  return { ...actor, access: { ...actor.access, permissions } };
};

describe.skipIf(!url)("mod mail", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  let sends: { channel: string; message: PostMessage; key: string }[];
  let dms: { user: string; message: DirectMessage }[];
  let reports: { error: unknown; operation: string; scope: string | undefined }[];
  let stopping: () => boolean;
  /** TaruBot's view of the server, as the gateway cache would give it; none by default. */
  let view: VisibilityGuild | null;
  const unused = async (): Promise<never> => {
    throw new Error("Not expected in mod mail");
  };
  const discord: DiscordPort = {
    member: unused,
    members: unused,
    validateRole: unused,
    validateChannel: unused,
    roles: unused,
    layoutRoles: unused,
    nickname: unused,
    send: async (_guild, channel, message, key) => {
      sends.push({ channel, message, key });
      return "999999999999999901";
    },
    editReview: unused,
    dm: async (user, message) => {
      dms.push({ user, message });
    },
    visibility: async () => view,
    displayNames: async (_guild, users) =>
      new Map(users.map((id) => [id, id === OTHER_MEMBER.userId ? null : `Name ${id.slice(-2)}`])),
  };
  const app = new Service(db, discord, {} as Lodestone, CONFIG);
  const report: Reporter = (error, operation, options = {}) => {
    reports.push({ error, operation, scope: options.scope });
  };
  const modmail = (key: ModMailKey = keyFor("test modmail key"), origin: string | null = ORIGIN) =>
    new ModMail(app, key, origin, () => stopping(), report);
  const notices = new ModMailNotices(app, ORIGIN);
  const enable = async (service = modmail()) => {
    const outcome = await service.toggle(OFFICER, { enabled: true, revision: 1n });
    expect(outcome).toEqual({ status: "saved" });
  };
  const open = async (actor: Actor, service = modmail(), topic = "A topic", body = "A message") =>
    service.open(actor, { topic, body });
  const opened = async (actor: Actor, service = modmail(), body = "A message"): Promise<bigint> => {
    const outcome = await open(actor, service, "A topic", body);
    if (outcome.status !== "opened") throw new Error(`Expected opened, got ${outcome.status}`);
    return outcome.number;
  };
  const caseRow = async (number: bigint) => {
    const [row] = await db.orm
      .select()
      .from(t.modmailCases)
      .where(and(eq(t.modmailCases.guild_id, GUILD), eq(t.modmailCases.number, number)));
    if (!row) throw new Error("No such case");
    return row;
  };
  const jobRows = () =>
    db.orm
      .select({
        kind: t.jobs.kind,
        key: t.jobs.dedupe_key,
        payload: t.jobs.payload,
        user: t.jobs.user_id,
        guild: t.jobs.guild_id,
        status: t.jobs.status,
        delay: sql<number>`extract(epoch FROM ${t.jobs.due_at} - now())::float8`,
      })
      .from(t.jobs)
      .orderBy(asc(t.jobs.created_at));
  /** A job as the queue hands it over, for ModMailNotices. */
  const asJob = async (key: string): Promise<Job> => {
    const [row] = await db.orm.select().from(t.jobs).where(eq(t.jobs.dedupe_key, key));
    if (!row) throw new Error("No such job");
    return { ...row, lease_token: "00000000-0000-4000-8000-000000000000" };
  };
  const guildRow = async () => {
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, GUILD));
    if (!row) throw new Error("No guild");
    return row;
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
      "TRUNCATE guilds, users, jobs, audit, delivery_attempts, modmail_settings, modmail_cases CASCADE",
    );
    for (const id of [GUILD, OTHER_GUILD])
      await db.orm.insert(t.guilds).values({
        id,
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: ROLE.officer,
        officer_notifications_channel_id: CHANNEL,
        effects_enabled: true,
        role_layout_enabled: false,
      });
    sends = [];
    dms = [];
    reports = [];
    stopping = () => false;
    view = null;
  });

  describe("the switch", () => {
    test("turning it on needs every prerequisite, is audited, and repeats are unchanged", async () => {
      expect(await modmail().enabledIn(GUILD)).toBe(false);
      // No key, an invalid key, no web, no officer channel: each refuses with what's missing.
      for (const [service, missing] of [
        [modmail(readModMailKey("")), { key: "missing" }],
        [modmail(readModMailKey("not a key")), { key: "invalid" }],
        [modmail(undefined, null), { web: false }],
      ] as const) {
        const outcome = await service.toggle(OFFICER, { enabled: true, revision: 1n });
        expect(outcome.status).toBe("invalid");
        if (outcome.status === "invalid") expect(outcome.prerequisites).toMatchObject(missing);
      }
      await db.orm
        .update(t.guilds)
        .set({ officer_notifications_channel_id: null })
        .where(eq(t.guilds.id, GUILD));
      const noChannel = await modmail().toggle(OFFICER, { enabled: true, revision: 1n });
      expect(noChannel).toMatchObject({ status: "invalid", prerequisites: { channel: false } });
      await db.orm
        .update(t.guilds)
        .set({ officer_notifications_channel_id: CHANNEL })
        .where(eq(t.guilds.id, GUILD));
      await enable();
      expect(await modmail().enabledIn(GUILD)).toBe(true);
      // A double submit lands on unchanged, whatever revision it carried.
      expect(await modmail().toggle(OFFICER, { enabled: true, revision: 1n })).toEqual({
        status: "unchanged",
      });
      // A stale form that would change something is a conflict.
      expect(await modmail().toggle(SECOND_OFFICER, { enabled: false, revision: 1n })).toEqual({
        status: "conflict",
      });
      expect(await modmail().toggle(SECOND_OFFICER, { enabled: false, revision: 2n })).toEqual({
        status: "saved",
      });
      const audit = await db.orm
        .select({
          actor: t.auditEvents.actor_id,
          action: t.auditEvents.action,
          target: t.auditEvents.target,
          details: t.auditEvents.details,
        })
        .from(t.auditEvents)
        .orderBy(asc(t.auditEvents.id));
      expect(audit).toEqual([
        { actor: OFFICER.userId, action: "modmail", target: "enable", details: { revision: "2" } },
        {
          actor: SECOND_OFFICER.userId,
          action: "modmail",
          target: "disable",
          details: { revision: "3" },
        },
      ]);
      // Members can't flip it.
      await expect(modmail().toggle(MEMBER, { enabled: true, revision: 3n })).rejects.toThrow(
        Failure,
      );
    });

    test("turning it off stops new cases only: existing ones stay readable and repliable", async () => {
      await enable();
      const number = await opened(MEMBER);
      await modmail().toggle(OFFICER, { enabled: false, revision: 2n });
      expect(await open(OTHER_MEMBER)).toEqual({ status: "refused", reason: "off" });
      expect(await modmail().caseView(MEMBER, number)).not.toBeNull();
      const reply = await modmail().reply(MEMBER, number, {
        messageId: "00000000-0000-4000-8000-000000000101",
        body: "Still here",
        signing: null,
      });
      expect(reply?.status).toBe("saved");
      expect(await modmail().close(OFFICER, number, (await caseRow(number)).revision)).toEqual({
        status: "saved",
      });
    });
  });

  describe("opening a case", () => {
    test("members and guests, not lobby newcomers or officers without either role, nor under A2", async () => {
      await enable();
      expect((await open(MEMBER)).status).toBe("opened");
      expect((await open(GUEST)).status).toBe("opened");
      expect(await open(LOBBY)).toEqual({ status: "refused", reason: "not_member" });
      expect(await open(OFFICER)).toEqual({ status: "refused", reason: "not_member" });
      expect(await open({ ...OTHER_MEMBER, botAdministrator: true })).toEqual({
        status: "refused",
        reason: "administrator",
      });
      // An officer who also holds Member may open one; a member in a time-out may too (appeals).
      expect(
        (await open(person(SECOND_OFFICER.userId, { officer: true, member: true }))).status,
      ).toBe("opened");
      expect((await open({ ...OTHER_MEMBER, timedOut: true })).status).toBe("opened");
      expect(await open(MEMBER, modmail(readModMailKey("")))).toEqual({
        status: "refused",
        reason: "key",
      });
      expect(await open(MEMBER, modmail(undefined, null))).toEqual({
        status: "refused",
        reason: "web",
      });
    });

    test("3 open cases and 5 a day per member per server; the gate agrees with the transaction", async () => {
      await enable();
      for (let index = 0; index < MODMAIL_LIMITS.openCases; index++) await opened(MEMBER);
      expect(await open(MEMBER)).toEqual({ status: "refused", reason: "open_limit" });
      expect(await modmail().openGate(GUILD, MEMBER.userId, [ROLE.member], false)).toBe(
        "open_limit",
      );
      // Closing frees a slot for the open limit, but the 24-hour count keeps going.
      for (let number = 1n; number <= 3n; number++)
        await modmail().close(MEMBER, number, (await caseRow(number)).revision);
      await opened(MEMBER);
      await opened(MEMBER);
      expect(await open(MEMBER)).toEqual({ status: "refused", reason: "daily_limit" });
      expect(await modmail().openGate(GUILD, MEMBER.userId, [ROLE.member], false)).toBe(
        "daily_limit",
      );
      // Another member, and the same member in another server, are counted apart.
      expect((await open(OTHER_MEMBER)).status).toBe("opened");
      expect(await modmail().openGate(GUILD, OTHER_MEMBER.userId, [ROLE.member], false)).toBeNull();
      expect(await modmail().openGate(GUILD, LOBBY.userId, [], false)).toBe("not_member");
      expect(await modmail().openGate(GUILD, OTHER_MEMBER.userId, [ROLE.member], true)).toBe(
        "administrator",
      );
      expect(await modmail().openGate(OTHER_GUILD, MEMBER.userId, [ROLE.member], false)).toBe(
        "off",
      );
    });

    test("text is checked: empty, too long or unsavable text opens nothing", async () => {
      await enable();
      expect(await open(MEMBER, modmail(), "   ", "body")).toEqual({
        status: "invalid",
        field: "topic",
        error: "empty",
      });
      expect(await open(MEMBER, modmail(), "t".repeat(101), "body")).toMatchObject({
        field: "topic",
        error: "long",
      });
      expect(await open(MEMBER, modmail(), "topic", "b".repeat(4001))).toMatchObject({
        field: "message",
        error: "long",
      });
      expect(await open(MEMBER, modmail(), "topic", "nul \u0000 inside")).toMatchObject({
        error: "unsavable",
      });
      // 4,000 emoji are 4,000 characters, as Discord's form counts them.
      expect((await open(MEMBER, modmail(), "topic", "🙂".repeat(4000))).status).toBe("opened");
      expect(await db.orm.select({ id: t.modmailCases.id }).from(t.modmailCases)).toHaveLength(1);
    });

    test("concurrent opens in one server get distinct numbers in order, never reused", async () => {
      await enable();
      const members = Array.from({ length: 12 }, (_, index) =>
        person(`7234567890123459${String(index).padStart(2, "0")}`, { member: true }),
      );
      const outcomes = await Promise.all(members.map((actor) => open(actor)));
      const numbers = outcomes.map((outcome) =>
        outcome.status === "opened" ? outcome.number : 0n,
      );
      expect([...numbers].sort((a, b) => (a < b ? -1 : 1))).toEqual(
        Array.from({ length: 12 }, (_, index) => BigInt(index + 1)),
      );
      // Retention deleting a case doesn't free its number.
      await db.query(
        "UPDATE modmail_cases SET state='closed', closed_at=now()-interval '91 days', delete_after=now()-interval '1 day' WHERE number=12",
      );
      expect(await pruneModMail(db.orm)).toBe(1);
      expect(await opened(MEMBER)).toBe(13n);
      // Each server counts on its own.
      await modmail().toggle({ ...OFFICER, guildId: OTHER_GUILD }, { enabled: true, revision: 1n });
      expect(await opened({ ...MEMBER, guildId: OTHER_GUILD })).toBe(1n);
    });

    test("one member's two forms at once can't both pass the open limit", async () => {
      await enable();
      await opened(MEMBER);
      await opened(MEMBER);
      const both = await Promise.all([open(MEMBER), open(MEMBER)]);
      expect(both.map((outcome) => outcome.status).sort()).toEqual(["opened", "refused"]);
    });

    test("a shutdown starting mid-open rolls everything back", async () => {
      await enable();
      let checks = 0;
      // The first check (before the transaction) passes; the pre-commit one finds the drain.
      stopping = () => ++checks > 1;
      await expect(open(MEMBER)).rejects.toMatchObject({ code: "stopping" });
      expect(await db.orm.select().from(t.modmailCases)).toHaveLength(0);
      expect(await db.orm.select().from(t.jobs)).toHaveLength(0);
      const [settings] = await db.orm.select().from(t.modmailSettings);
      expect(settings?.last_number).toBe(0n);
    });
  });

  /**
   * Opening on the web (owner decision of 2026-10-11): the Mod mail page's form goes through the
   * same ModMail.open as /modmail, with a case ID minted by its page, so a member in a time-out
   * (whom Discord keeps from running /modmail) can still reach the officers.
   */
  describe("opening a case on the web", () => {
    /** Readable minted IDs: all zeros but the last digits. */
    const minted = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const web = (actor: Actor, caseId: string, service = modmail()) =>
      service.open(actor, { topic: "A web topic", body: `A web message ${CANARY}`, caseId });

    test("the same form twice finds its case; someone else's ID is a conflict; stored lowercase", async () => {
      await enable();
      const first = await web(MEMBER, minted(1));
      expect(first).toMatchObject({ status: "opened", number: 1n });
      // A double submit: the same case, nothing added, one ping.
      expect(await web(MEMBER, minted(1))).toEqual(first);
      expect(await db.orm.select().from(t.modmailCases)).toHaveLength(1);
      expect(await db.orm.select().from(t.modmailMessages)).toHaveLength(1);
      expect((await jobRows()).map((job) => job.key)).toEqual([pingKey(minted(1))]);
      expect((await caseRow(1n)).id).toBe(minted(1));
      // Another member's form, and the same member's in another server, never take it over.
      expect(await web(OTHER_MEMBER, minted(1))).toEqual({ status: "conflict" });
      await modmail().toggle({ ...OFFICER, guildId: OTHER_GUILD }, { enabled: true, revision: 1n });
      expect(await web({ ...MEMBER, guildId: OTHER_GUILD }, minted(1))).toEqual({
        status: "conflict",
      });
      // An uppercase ID is the stored, lowercase one: the case's AAD names it, so it still reads.
      const upper = minted(10).replace("010", "00A");
      expect(await web(MEMBER, upper)).toMatchObject({ status: "opened", number: 2n });
      expect((await caseRow(2n)).id).toBe(upper.toLowerCase());
      expect(await web(MEMBER, upper.toLowerCase())).toMatchObject({ number: 2n });
      expect((await modmail().caseView(MEMBER, 2n))?.topic).toBe("A web topic");
      // A minted ID that isn't a UUID is a form the page never drew.
      await expect(web(MEMBER, "not-a-uuid")).rejects.toMatchObject({ code: "input" });
    });

    test("the same form with other text is already_opened, never a silent drop; a reply's too", async () => {
      await enable();
      const service = modmail();
      const send = (topic: string, body: string) =>
        service.open(MEMBER, { topic, body, caseId: minted(30) });
      const first = await send("Raid times", "First version");
      expect(first).toMatchObject({ status: "opened", number: 1n });
      // Cleaned the same way as the first send, so whitespace alone isn't a difference.
      expect(await send("  Raid   times ", "First version\r\n")).toEqual(first);
      expect(await send("Raid times", "Second version")).toEqual({
        status: "already_opened",
        number: 1n,
        url: `${ORIGIN}/g/${GUILD}/modmail/1`,
      });
      expect(await send("Other topic", "First version")).toMatchObject({
        status: "already_opened",
      });
      // Nothing was added or opened by the edited sends.
      expect(await db.orm.select().from(t.modmailCases)).toHaveLength(1);
      expect(await db.orm.select().from(t.modmailMessages)).toHaveLength(1);
      // A reply: the same text again is unchanged, other text is resent, another author a conflict.
      const id = minted(31);
      const reply = (actor: Actor, body: string) =>
        service.reply(actor, 1n, { messageId: id, body, signing: null });
      expect(await reply(MEMBER, "Reply one")).toEqual({ status: "saved", messageId: id });
      expect(await reply(MEMBER, "Reply one")).toEqual({ status: "unchanged", messageId: id });
      expect(await reply(MEMBER, "Reply two")).toEqual({ status: "resent", messageId: id });
      expect(
        await service.reply(OFFICER, 1n, { messageId: id, body: "Reply one", signing: "name" }),
      ).toEqual({
        status: "conflict",
      });
      expect(await db.orm.select().from(t.modmailMessages)).toHaveLength(2);
      // Under another key the stored text can't be compared: never "opened" on trust.
      expect(
        await modmail(keyFor("another modmail key")).open(MEMBER, {
          topic: "Raid times",
          body: "First version",
          caseId: minted(30),
        }),
      ).toMatchObject({ status: "already_opened" });
    });

    test("a repeat lands on its case even after the switch went off or the limit was reached", async () => {
      await enable();
      await opened(MEMBER);
      await opened(MEMBER);
      const third = await web(MEMBER, minted(3));
      expect(third).toMatchObject({ status: "opened", number: 3n });
      // At 3 open cases now, but the form that made the third finds it, not the limit.
      expect(await web(MEMBER, minted(3))).toEqual(third);
      expect(await web(MEMBER, minted(4))).toEqual({ status: "refused", reason: "open_limit" });
      const settings = await modmail().settings(OFFICER);
      await modmail().toggle(OFFICER, { enabled: false, revision: settings.revision });
      expect(await web(MEMBER, minted(3))).toEqual(third);
      expect(await web(OTHER_MEMBER, minted(5))).toEqual({ status: "refused", reason: "off" });
    });

    test("a web form and /modmail at once can't both pass the open limit", async () => {
      await enable();
      await opened(MEMBER);
      await opened(MEMBER);
      for (let attempt = 0; attempt < 3; attempt++) {
        const both = await Promise.all([open(MEMBER), web(MEMBER, minted(100 + attempt))]);
        if (attempt === 0)
          expect(both.map((outcome) => outcome.status).sort()).toEqual(["opened", "refused"]);
        else
          expect(both).toEqual([
            { status: "refused", reason: "open_limit" },
            { status: "refused", reason: "open_limit" },
          ]);
      }
      const open3 = await db.orm
        .select({ id: t.modmailCases.id })
        .from(t.modmailCases)
        .where(eq(t.modmailCases.opener_id, MEMBER.userId));
      expect(open3).toHaveLength(MODMAIL_LIMITS.openCases);
    });

    test("one minted ID from two people at once: one case, and a conflict for the other", async () => {
      await enable();
      const both = await Promise.all([web(MEMBER, minted(7)), web(OTHER_MEMBER, minted(7))]);
      expect(both.map((outcome) => outcome.status).sort()).toEqual(["conflict", "opened"]);
      expect(await db.orm.select().from(t.modmailCases)).toHaveLength(1);
    });

    test("the same gates as /modmail: Member or Guest now, A2, a valid key; a time-out is no bar", async () => {
      await enable();
      expect(await web(LOBBY, minted(20))).toEqual({ status: "refused", reason: "not_member" });
      expect(await web(OFFICER, minted(21))).toEqual({ status: "refused", reason: "not_member" });
      expect(await web({ ...MEMBER, botAdministrator: true }, minted(22))).toEqual({
        status: "refused",
        reason: "administrator",
      });
      expect(await web(MEMBER, minted(23), modmail(readModMailKey("")))).toEqual({
        status: "refused",
        reason: "key",
      });
      expect(await web({ ...GUEST, timedOut: true }, minted(24))).toMatchObject({
        status: "opened",
        number: 1n,
      });
      expect(await db.orm.select().from(t.modmailCases)).toHaveLength(1);
    });

    test("the member's page says why it can't offer the form, by the same rules", async () => {
      expect((await modmail().mine(MEMBER)).openRefusal).toBe("off");
      await enable();
      expect((await modmail().mine(MEMBER)).openRefusal).toBeNull();
      expect((await modmail().mine({ ...MEMBER, timedOut: true })).openRefusal).toBeNull();
      expect((await modmail(readModMailKey("")).mine(MEMBER)).openRefusal).toBe("key");
      for (let index = 0; index < MODMAIL_LIMITS.openCases; index++) await opened(MEMBER);
      expect((await modmail().mine(MEMBER)).openRefusal).toBe("open_limit");
      for (let number = 1n; number <= 3n; number++)
        await modmail().close(MEMBER, number, (await caseRow(number)).revision);
      await opened(MEMBER);
      await opened(MEMBER);
      expect((await modmail().mine(MEMBER)).openRefusal).toBe("daily_limit");
      expect((await modmail().mine(GUEST)).openRefusal).toBeNull();
    });
  });

  /**
   * The officers' ping needs TaruBot to mention the Officer role in the officer notifications
   * channel (owner decision of 2026-10-11): the settings card and /config validate's analysis read
   * the same view, and validate's records know whether mod mail is on.
   */
  describe("Mention Everyone for the officers' ping", () => {
    /** A view: TaruBot's role without Mention Everyone, the channel with or without its allow. */
    const snapshot = (allow: boolean, mentionable = false): VisibilityGuild => ({
      guildId: GUILD,
      bot: {
        id: "823456789012345801",
        roles: ["823456789012345802"],
        botRoleId: "823456789012345802",
      },
      roles: [
        {
          id: GUILD,
          name: "@everyone",
          position: 0,
          permissions: String(P.ViewChannel),
          hoist: false,
          managed: false,
        },
        {
          id: ROLE.officer,
          name: "Officer",
          position: 1,
          permissions: "0",
          hoist: false,
          managed: false,
          mentionable,
        },
        {
          id: "823456789012345802",
          name: "TaruBot",
          position: 2,
          permissions: String(P.ViewChannel | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory),
          hoist: false,
          managed: true,
        },
      ],
      channels: [
        {
          id: CHANNEL,
          type: 0,
          parentId: null,
          position: 0,
          overwrites: allow
            ? [{ id: "823456789012345801", type: 1, allow: String(P.MentionEveryone), deny: "0" }]
            : [],
          obfuscated: false,
        },
      ],
      heldRoles: [],
    });

    test("the settings card says whether pings notify officers, and never blocks turning it on", async () => {
      view = snapshot(false);
      expect((await modmail().settings(OFFICER)).officerPing).toBe("silent");
      await enable();
      view = snapshot(true);
      expect((await modmail().settings(OFFICER)).officerPing).toBe("allowed");
      view = snapshot(false, true);
      expect((await modmail().settings(OFFICER)).officerPing).toBe("mentionable");
      view = null;
      expect((await modmail().settings(OFFICER)).officerPing).toBeNull();
    });

    test("validate's records carry the switch, so the allow is expected only while mod mail is on", async () => {
      const mentions = async () =>
        analyseVisibility(
          snapshot(true),
          visibilitySettings(await guildRow(), await loadVisibilityRecords(db.orm, GUILD)),
        ).mentions;
      expect(await mentions()).toEqual({
        officerPing: null,
        unneeded: [],
        officerChannel: "unneeded",
      });
      await enable();
      expect(await mentions()).toEqual({
        officerPing: "allowed",
        unneeded: [],
        officerChannel: "expected",
      });
    });
  });

  describe("encryption at rest", () => {
    test("no row holds the plaintext: topics and bodies are ciphertext, jobs carry the case ID", async () => {
      await enable();
      const outcome = await open(MEMBER, modmail(), `Topic ${CANARY}`, `Body ${CANARY}`);
      if (outcome.status !== "opened") throw new Error("not opened");
      await modmail().reply(OFFICER, outcome.number, {
        messageId: "00000000-0000-4000-8000-000000000201",
        body: `Reply ${CANARY}`,
        signing: "officers",
      });
      // Every table's every row, as text: the canary appears nowhere.
      const dump = await db.query<{ row: string }>(
        `SELECT row_to_json(x)::text AS row FROM (
           SELECT * FROM modmail_cases) x
         UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_messages) x
         UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_reads) x
         UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_settings) x
         UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM jobs) x
         UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM audit) x`,
      );
      expect(dump.length).toBeGreaterThan(0);
      for (const { row } of dump) expect(row).not.toContain(CANARY);
      const bytes = await db.orm.select({ body: t.modmailMessages.body }).from(t.modmailMessages);
      for (const { body } of bytes) expect(body?.includes(Buffer.from(CANARY))).toBe(false);
      // The jobs: a ping with the case ID and the event, a DM with the case ID; no user attached.
      const jobs = await jobRows();
      expect(
        jobs.map(({ kind, payload, user }) => ({
          kind,
          keys: Object.keys(payload as object).sort(),
          user,
        })),
      ).toEqual([
        { kind: "modmail.ping", keys: ["caseId", "event"], user: null },
        { kind: "modmail.dm", keys: ["caseId"], user: null },
      ]);
      // Nothing was reported, and so nothing reported could carry it.
      expect(reports).toEqual([]);
      // The page shows it, decrypted, to those who may see it.
      const view = await modmail().caseView(MEMBER, outcome.number);
      expect(view?.topic).toBe(`Topic ${CANARY}`);
      expect(view?.entries.map((entry) => entry.body)).toEqual([
        `Body ${CANARY}`,
        `Reply ${CANARY}`,
      ]);
    });

    test("a ciphertext moved to another row doesn't decrypt; one report, without the text", async () => {
      await enable();
      const first = await opened(MEMBER, modmail(), `Secret ${CANARY}`);
      const second = await opened(OTHER_MEMBER, modmail(), "Other body");
      const [source] = await db.orm
        .select()
        .from(t.modmailMessages)
        .where(eq(t.modmailMessages.case_id, (await caseRow(first)).id));
      if (!source?.body || !source.key_id) throw new Error("no source");
      // Someone with database access copies the body into the other case as a new message.
      await db.orm.insert(t.modmailMessages).values({
        id: "00000000-0000-4000-8000-000000000301",
        case_id: (await caseRow(second)).id,
        kind: "message",
        author_id: OTHER_MEMBER.userId,
        side: "member",
        body: source.body,
        key_id: source.key_id,
      });
      const view = await modmail().caseView(OTHER_MEMBER, second);
      expect(view?.entries.map((entry) => entry.body)).toEqual(["Other body", null]);
      expect(reports).toHaveLength(1);
      const [filed] = reports;
      expect(filed?.scope).toBe("modmail:decrypt-altered");
      expect(filed?.error).toBeInstanceOf(Failure);
      const message = filed?.error instanceof Error ? filed.error.message : "";
      expect(message).toContain("altered, moved or re-attributed");
      expect(message).not.toContain(CANARY);
      // Under another key every field fails, told apart as another key ID; still one report.
      reports = [];
      const other = await modmail(keyFor("another modmail key")).caseView(MEMBER, first);
      expect(other?.topic).toBeNull();
      expect(other?.entries.map((entry) => entry.body)).toEqual([null]);
      expect(reports).toHaveLength(1);
      const another = reports[0]?.error;
      expect(another instanceof Error ? another.message : "").toContain("another MODMAIL_KEY");
      // Its own scope, so a key change and a tamper report never share one fingerprint.
      expect(reports[0]?.scope).toBe("modmail:decrypt-key");
      // The AAD named this exact row: re-binding by hand gives the same refusal.
      const cipher = keyFor("test modmail key");
      if (cipher.status !== "on") throw new Error("key");
      expect(
        cipher.cipher.decrypt(
          source.body,
          source.key_id,
          fieldAad(
            { guildId: GUILD, caseId: (await caseRow(second)).id, openerId: OTHER_MEMBER.userId },
            {
              message: {
                id: source.id,
                authorId: OTHER_MEMBER.userId,
                side: "member",
                signedAs: null,
                kind: "message",
              },
            },
          ),
        ),
      ).toBeNull();
    });
  });

  describe("migration 014's guards", () => {
    test("messages and reads are append-only, a case's identity and topic are fixed, deletes cascade", async () => {
      await enable();
      const number = await opened(MEMBER);
      await modmail().caseView(MEMBER, number);
      const row = await caseRow(number);
      await expect(db.query("UPDATE modmail_messages SET author_id='1'")).rejects.toThrow();
      await expect(db.query("UPDATE modmail_messages SET body=body")).rejects.toThrow();
      await expect(db.query("UPDATE modmail_reads SET reader_id='1'")).rejects.toThrow();
      await expect(
        db.query("UPDATE modmail_cases SET topic=topic || '\\x00'::bytea"),
      ).rejects.toThrow();
      await expect(db.query("UPDATE modmail_cases SET opener_id='1'")).rejects.toThrow();
      await expect(db.query("UPDATE modmail_cases SET number=99")).rejects.toThrow();
      // State and times may change; retention's delete cascades to the thread and the reads.
      await db.query(
        "UPDATE modmail_cases SET state='closed', closed_at=now()-interval '91 days', delete_after=now()-interval '1 minute' WHERE id=$1",
        [row.id],
      );
      const retention = new ModMailRetention(db.orm, () => 0);
      expect(await retention.tick()).toBe(1);
      for (const table of ["modmail_cases", "modmail_messages", "modmail_reads"])
        expect(await db.query(`SELECT 1 FROM ${table}`)).toEqual([]);
      // At most one pass per interval.
      expect(await new ModMailRetention(db.orm, () => RETENTION_INTERVAL_MS).tick()).toBe(0);
      // The state CHECKs: closed needs both dates, open neither.
      await expect(db.query("UPDATE modmail_cases SET state='closed'")).resolves.toBeDefined();
    });

    test("the retention pass plans through the expiry index and leaves open and unexpired cases", async () => {
      await enable();
      const open = await opened(MEMBER);
      const recent = await opened(GUEST);
      await modmail().close(GUEST, recent, (await caseRow(recent)).revision);
      expect(await pruneModMail(db.orm)).toBe(0);
      expect((await caseRow(open)).state).toBe("officers");
      const closed = await caseRow(recent);
      // 90 days from closing, to the second.
      expect(
        Math.round(
          ((closed.delete_after?.getTime() ?? 0) - (closed.closed_at?.getTime() ?? 0)) / 86_400_000,
        ),
      ).toBe(90);
      // A tiny table plans a sequential scan anyway, so seq scans are switched off for this check.
      const plan = await db.transaction(async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        const result = await client.query<{ "QUERY PLAN": string }>(
          "EXPLAIN DELETE FROM modmail_cases WHERE delete_after < now()",
        );
        return result.rows.map((line) => line["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("modmail_cases_expiry");
    });
  });

  describe("access and the read log", () => {
    test("another member's case doesn't exist for them; officers see every case", async () => {
      await enable();
      const number = await opened(MEMBER);
      for (const outsider of [
        OTHER_MEMBER,
        GUEST,
        LOBBY,
        // The opener after losing the Member role: access follows the roles held now.
        person(MEMBER.userId),
        { ...MEMBER, botAdministrator: true },
      ]) {
        expect(await modmail().caseView(outsider, number)).toBeNull();
        expect(
          await modmail().reply(outsider, number, {
            messageId: "00000000-0000-4000-8000-000000000401",
            body: "Let me in",
            signing: null,
          }),
        ).toBeNull();
        expect(await modmail().close(outsider, number, 1n)).toBeNull();
      }
      // A number that doesn't exist reads the same.
      expect(await modmail().caseView(MEMBER, 999n)).toBeNull();
      // Nobody refused left a read.
      expect(await db.query("SELECT reader_id FROM modmail_reads")).toEqual([]);
      expect(await modmail().caseView(OFFICER, number)).not.toBeNull();
      // In another server the same number is another case or none.
      expect(await modmail().caseView({ ...OFFICER, guildId: OTHER_GUILD }, number)).toBeNull();
      expect(await modmail().mine(OTHER_MEMBER)).toMatchObject({ cases: [] });
      await expect(modmail().inbox(MEMBER, "open")).rejects.toThrow(Failure);
    });

    test("every view is read-logged once a minute per reader; only officers see the log", async () => {
      await enable();
      const number = await opened(MEMBER);
      await modmail().caseView(MEMBER, number);
      await modmail().caseView(MEMBER, number);
      const officerView = await modmail().caseView(OFFICER, number);
      expect(officerView?.reads?.map((read) => [read.readerId, read.side])).toEqual([
        [OFFICER.userId, "officer"],
        [MEMBER.userId, "member"],
      ]);
      expect(officerView?.readCount).toBe(2);
      const memberView = await modmail().caseView(MEMBER, number);
      expect(memberView?.reads).toBeNull();
      expect(memberView?.readCount).toBe(0);
    });

    test("the member never learns who signed as the officers; officers always do", async () => {
      await enable();
      const number = await opened(MEMBER);
      await modmail().reply(OFFICER, number, {
        messageId: "00000000-0000-4000-8000-000000000501",
        body: "Signed as the officers",
        signing: "officers",
      });
      await modmail().reply(SECOND_OFFICER, number, {
        messageId: "00000000-0000-4000-8000-000000000502",
        body: "Signed with a name",
        signing: "name",
      });
      const member = await modmail().caseView(MEMBER, number);
      expect(member?.entries.map((entry) => entry.author)).toEqual([
        { kind: "you" },
        { kind: "officers" },
        { kind: "officer", userId: SECOND_OFFICER.userId },
      ]);
      // Not even in the names the view carries.
      expect([...(member?.names.keys() ?? [])]).not.toContain(OFFICER.userId);
      expect(
        JSON.stringify(member, (_key, value) =>
          typeof value === "bigint" ? String(value) : value instanceof Map ? [...value] : value,
        ),
      ).not.toContain(OFFICER.userId);
      const officer = await modmail().caseView(SECOND_OFFICER, number);
      expect(officer?.entries.map((entry) => entry.author)).toEqual([
        { kind: "person", userId: MEMBER.userId, side: "member", asOfficers: false },
        { kind: "person", userId: OFFICER.userId, side: "officer", asOfficers: true },
        { kind: "person", userId: SECOND_OFFICER.userId, side: "officer", asOfficers: false },
      ]);
    });
  });

  describe("replies, Close and Reopen", () => {
    test("states follow who replied; a reply reopens; close sets and reopen clears the deletion date", async () => {
      await enable();
      const number = await opened(MEMBER);
      expect((await caseRow(number)).state).toBe("officers");
      const reply = (actor: Actor, id: string, signing: "name" | "officers" | null = null) =>
        modmail().reply(actor, number, { messageId: id, body: "text", signing });
      expect(await reply(OFFICER, "00000000-0000-4000-8000-000000000601", "name")).toEqual({
        status: "saved",
        messageId: "00000000-0000-4000-8000-000000000601",
      });
      expect((await caseRow(number)).state).toBe("member");
      // The same form twice lands on the same message.
      expect(await reply(OFFICER, "00000000-0000-4000-8000-000000000601", "name")).toEqual({
        status: "unchanged",
        messageId: "00000000-0000-4000-8000-000000000601",
      });
      // Another person reusing that ID is a form this page didn't make.
      expect(await reply(MEMBER, "00000000-0000-4000-8000-000000000601")).toEqual({
        status: "conflict",
      });
      expect(await reply(MEMBER, "00000000-0000-4000-8000-000000000602")).toMatchObject({
        status: "saved",
      });
      expect((await caseRow(number)).state).toBe("officers");
      // Close with a stale revision: refused; with the current one: closed, 90 days on.
      const before = (await caseRow(number)).revision;
      expect(await modmail().close(OFFICER, number, before - 1n)).toEqual({ status: "conflict" });
      expect(await modmail().close(OFFICER, number, before)).toEqual({ status: "saved" });
      const closed = await caseRow(number);
      expect(closed.state).toBe("closed");
      expect(closed.delete_after).not.toBeNull();
      // Closing again is unchanged, whatever the revision.
      expect(await modmail().close(MEMBER, number, 1n)).toEqual({ status: "unchanged" });
      // The member's reply reopens it, waiting on officers, deletion date gone.
      expect(await reply(MEMBER, "00000000-0000-4000-8000-000000000603")).toMatchObject({
        status: "saved",
      });
      const reopened = await caseRow(number);
      expect([reopened.state, reopened.closed_at, reopened.delete_after]).toEqual([
        "officers",
        null,
        null,
      ]);
      // Members reopen by replying, never with Reopen.
      await modmail().close(MEMBER, number, reopened.revision);
      await expect(
        modmail().reopen(MEMBER, number, (await caseRow(number)).revision),
      ).rejects.toThrow(Failure);
      expect(await modmail().reopen(OFFICER, number, (await caseRow(number)).revision)).toEqual({
        status: "saved",
      });
      expect((await caseRow(number)).state).toBe("officers");
      const lines = await db.orm
        .select({
          kind: t.modmailMessages.kind,
          side: t.modmailMessages.side,
          signedAs: t.modmailMessages.signed_as,
        })
        .from(t.modmailMessages)
        .where(eq(t.modmailMessages.case_id, reopened.id))
        .orderBy(asc(t.modmailMessages.seq));
      expect(lines).toEqual([
        { kind: "message", side: "member", signedAs: null },
        { kind: "message", side: "officer", signedAs: "name" },
        { kind: "message", side: "member", signedAs: null },
        // The officer's close takes their own last signing here.
        { kind: "closed", side: "officer", signedAs: "name" },
        { kind: "reopened", side: "member", signedAs: null },
        { kind: "message", side: "member", signedAs: null },
        { kind: "closed", side: "member", signedAs: null },
        // The officer's Reopen takes their own last signing here too.
        { kind: "reopened", side: "officer", signedAs: "name" },
      ]);
    });

    test("a reply between drawing Close and pressing it makes Close a conflict", async () => {
      await enable();
      const number = await opened(MEMBER);
      const drawn = (await caseRow(number)).revision;
      await modmail().reply(MEMBER, number, {
        messageId: "00000000-0000-4000-8000-000000000701",
        body: "One more thing",
        signing: null,
      });
      expect(await modmail().close(OFFICER, number, drawn)).toEqual({ status: "conflict" });
      // Two closes at once with the same revision: one closes, the other finds it closed.
      const current = (await caseRow(number)).revision;
      const both = await Promise.all([
        modmail().close(OFFICER, number, current),
        modmail().close(SECOND_OFFICER, number, current),
      ]);
      expect(both.map((outcome) => outcome?.status).sort()).toEqual(["saved", "unchanged"]);
    });

    test("reading every case isn't answering them: the officer side needs modmail.respond, the opener's doesn't (2.44.0)", async () => {
      await enable();
      const number = await opened(MEMBER);
      const reader = withoutRespond(SECOND_OFFICER);
      const view = await modmail().caseView(reader, number);
      expect(view).toMatchObject({ audience: "officer", side: "officer", state: "officers" });
      expect(view?.reads).not.toBeNull();
      // The page offers the reader no reply, close or reopen form; a full officer on someone
      // else's case, and the member on their own, get them.
      expect(view?.canRespond).toBe(false);
      expect(await modmail().caseView(OFFICER, number)).toMatchObject({
        side: "officer",
        canRespond: true,
      });
      expect(await modmail().caseView(MEMBER, number)).toMatchObject({
        side: "member",
        canRespond: true,
      });
      const refusal = {
        code: "forbidden",
        message: OFFICERS_ONLY,
        detail: { kind: "scope", scope: "officer", permission: "modmail.respond" },
      };
      await expect(
        modmail().reply(reader, number, {
          messageId: "00000000-0000-4000-8000-000000000901",
          body: "An answer",
          signing: "name",
        }),
      ).rejects.toMatchObject(refusal);
      await expect(
        modmail().close(reader, number, (await caseRow(number)).revision),
      ).rejects.toMatchObject(refusal);
      // Nothing changed and nothing was queued: the case still waits, with only the open's ping.
      const id = (await caseRow(number)).id;
      expect((await caseRow(number)).state).toBe("officers");
      expect((await jobRows()).map((job) => job.key)).toEqual([pingKey(id)]);
      await modmail().close(OFFICER, number, (await caseRow(number)).revision);
      await expect(
        modmail().reopen(reader, number, (await caseRow(number)).revision),
      ).rejects.toMatchObject(refusal);
      expect((await caseRow(number)).state).toBe("closed");
      // No line of the reader's in the thread.
      const authors = await db.orm
        .select({ author: t.modmailMessages.author_id })
        .from(t.modmailMessages)
        .where(eq(t.modmailMessages.author_id, reader.userId));
      expect(authors).toEqual([]);
      // The opener holds no modmail.respond and answers their own case: the reply reopens it.
      expect(MEMBER.access.permissions.has("modmail.respond")).toBe(false);
      expect(
        (
          await modmail().reply(MEMBER, number, {
            messageId: "00000000-0000-4000-8000-000000000902",
            body: "Reopening it myself",
            signing: null,
          })
        )?.status,
      ).toBe("saved");
      expect(await modmail().close(MEMBER, number, (await caseRow(number)).revision)).toEqual({
        status: "saved",
      });
      // A reader who opened a case of their own answers it as its member, without modmail.respond.
      const own = withoutRespond(person(SECOND_OFFICER.userId, { officer: true, member: true }));
      const mine = await opened(own);
      expect(await modmail().caseView(own, mine)).toMatchObject({
        side: "member",
        canRespond: true,
      });
      expect(
        (
          await modmail().reply(own, mine, {
            messageId: "00000000-0000-4000-8000-000000000903",
            body: "One more thing",
            signing: null,
          })
        )?.status,
      ).toBe("saved");
      expect(await modmail().close(own, mine, (await caseRow(mine)).revision)).toEqual({
        status: "saved",
      });
    });

    test("a member can't reopen past the open limit, and a case holds at most 500 messages", async () => {
      await enable();
      const first = await opened(MEMBER);
      await modmail().close(MEMBER, first, (await caseRow(first)).revision);
      await opened(MEMBER);
      await opened(MEMBER);
      await opened(MEMBER);
      expect(
        await modmail().reply(MEMBER, first, {
          messageId: "00000000-0000-4000-8000-000000000801",
          body: "Reopen please",
          signing: null,
        }),
      ).toEqual({ status: "invalid", reason: "open_limit" });
      // An officer may reopen it whatever the member's count.
      expect(
        (
          await modmail().reply(OFFICER, first, {
            messageId: "00000000-0000-4000-8000-000000000802",
            body: "Reopening for you",
            signing: "name",
          })
        )?.status,
      ).toBe("saved");
      // Fill a case to the limit with stand-in rows (the bodies are never read here).
      const full = (await caseRow(2n)).id;
      await db.query(
        `INSERT INTO modmail_messages (id, case_id, kind, author_id, side, body, key_id)
         SELECT gen_random_uuid(), $1, 'message', $2, 'member', decode(repeat('00', 284), 'hex'), repeat('0', 16)
         FROM generate_series(1, $3)`,
        [full, MEMBER.userId, MODMAIL_LIMITS.messagesPerCase - 1],
      );
      expect(
        await modmail().reply(OFFICER, 2n, {
          messageId: "00000000-0000-4000-8000-000000000803",
          body: "One too many",
          signing: "name",
        }),
      ).toEqual({ status: "invalid", reason: "case_full" });
    });
  });

  describe("notifications", () => {
    test("pings on open and member replies, DMs on officer replies and closes, coalesced per case", async () => {
      await enable();
      const number = await opened(MEMBER);
      const id = (await caseRow(number)).id;
      let jobs = await jobRows();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        kind: "modmail.ping",
        key: pingKey(id),
        payload: { caseId: id, event: "opened" },
        guild: GUILD,
        user: null,
      });
      expect(jobs[0]?.delay ?? 99).toBeLessThan(2);
      // A member reply while the ping waits adds nothing: that ping covers it.
      await modmail().reply(MEMBER, number, {
        messageId: "00000000-0000-4000-8000-000000000901",
        body: "more",
        signing: null,
      });
      expect(await jobRows()).toHaveLength(1);
      // Once the ping went out, the next reply's ping waits out the rest of the 10 minutes.
      await db.query(
        "UPDATE jobs SET status='succeeded', completed_at=now() - interval '4 minutes' WHERE dedupe_key=$1",
        [pingKey(id)],
      );
      await modmail().reply(MEMBER, number, {
        messageId: "00000000-0000-4000-8000-000000000902",
        body: "again",
        signing: null,
      });
      jobs = (await jobRows()).filter((job) => job.status === "queued");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({ caseId: id, event: "reply" });
      expect(jobs[0]?.delay ?? 0).toBeGreaterThan(355);
      expect(jobs[0]?.delay ?? 999).toBeLessThan(365);
      // An officer reply DMs the member; their close later coalesces into that DM.
      await modmail().reply(OFFICER, number, {
        messageId: "00000000-0000-4000-8000-000000000903",
        body: "answer",
        signing: "name",
      });
      await modmail().close(OFFICER, number, (await caseRow(number)).revision);
      const dmJobs = (await jobRows()).filter((job) => job.kind === "modmail.dm");
      expect(dmJobs).toEqual([
        expect.objectContaining({
          key: dmKey(id),
          payload: { caseId: id },
          user: null,
          status: "queued",
        }),
      ]);
      // A member's close notifies nobody.
      const second = await opened(GUEST);
      const before = (await jobRows()).length;
      await modmail().close(GUEST, second, (await caseRow(second)).revision);
      expect(await jobRows()).toHaveLength(before);
    });

    test("the jobs send the number, event and link only: a role ping and a DM; skips before the gate", async () => {
      await enable();
      const number = await opened(MEMBER, modmail(), `Body ${CANARY}`);
      const id = (await caseRow(number)).id;
      const guild = await guildRow();
      const ping = await asJob(pingKey(id));
      expect(await notices.skip(ping, guild)).toBeNull();
      expect(await notices.ping(ping, guild)).toEqual({
        messageId: "999999999999999901",
        channelId: CHANNEL,
      });
      expect(sends).toEqual([
        {
          channel: CHANNEL,
          message: {
            kind: "modmail",
            view: {
              number,
              event: "opened",
              url: `${ORIGIN}/g/${GUILD}/modmail/${number}`,
              roleId: ROLE.officer,
            },
          },
          key: `${ping.id}:${ping.generation}`,
        },
      ]);
      // No officer channel: the ping completes as skipped, before the effects gate.
      expect(await notices.skip(ping, { ...guild, officer_notifications_channel_id: null })).toBe(
        "officer notifications unconfigured",
      );
      // The DM: replied, then closed by an officer; skipped once the member has seen it.
      await modmail().reply(OFFICER, number, {
        messageId: "00000000-0000-4000-8000-000000001001",
        body: "hi",
        signing: "officers",
      });
      const dm = await asJob(dmKey(id));
      expect(await notices.skip(dm, guild)).toBeNull();
      await notices.dm(dm, guild);
      expect(dms).toEqual([
        {
          user: MEMBER.userId,
          message: {
            kind: "modmail",
            guildId: GUILD,
            number,
            event: "reply",
            url: `${ORIGIN}/g/${GUILD}/modmail/${number}`,
          },
        },
      ]);
      await modmail().close(OFFICER, number, (await caseRow(number)).revision);
      await notices.dm(dm, guild);
      expect(dms[1]?.message).toMatchObject({ event: "closed" });
      await modmail().caseView(MEMBER, number);
      expect(await notices.skip(dm, guild)).toBe("seen on the dashboard");
      expect(
        JSON.stringify({ sends, dms }, (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      ).not.toContain(CANARY);
      // A case retention removed: nothing to send.
      await db.query("DELETE FROM modmail_cases");
      expect(await notices.skip(ping, guild)).toBe("case gone");
      expect(await notices.skip(dm, guild)).toBe("case gone");
    });

    test("through the dispatcher: skips before the effects gate, parks while paused, records deliveries", async () => {
      await enable();
      const number = await opened(MEMBER);
      const id = (await caseRow(number)).id;
      const dispatch = dispatcher(
        app,
        {} as Synchronization,
        {} as GuildAccess,
        undefined,
        {},
        {
          dashboardOrigin: ORIGIN,
        },
      );
      const guard = async () => {};
      // Paused Discord changes park the ping as `disabled`, as every post does.
      await db.orm.update(t.guilds).set({ effects_enabled: false }).where(eq(t.guilds.id, GUILD));
      const paused = await dispatch(await asJob(pingKey(id)), guard).catch(
        (error: unknown) => error,
      );
      expect(jobOutcome(paused, 1).status).toBe("disabled");
      expect(sends).toEqual([]);
      await db.orm.update(t.guilds).set({ effects_enabled: true }).where(eq(t.guilds.id, GUILD));
      expect(await dispatch(await asJob(pingKey(id)), guard)).toEqual({
        status: "delivered",
        messageId: "999999999999999901",
        channelId: CHANNEL,
      });
      const attempts = await db.orm
        .select({ status: t.deliveryAttempts.status })
        .from(t.deliveryAttempts)
        .orderBy(asc(t.deliveryAttempts.id));
      expect(attempts.map((row) => row.status)).toEqual(["started", "delivered"]);
      // With the channel unset, the ping completes as skipped even while paused.
      await db.orm
        .update(t.guilds)
        .set({ officer_notifications_channel_id: null, effects_enabled: false })
        .where(eq(t.guilds.id, GUILD));
      expect(await dispatch(await asJob(pingKey(id)), guard)).toEqual({
        skipped: "officer notifications unconfigured",
      });
      // A DM to closed DMs ends failed at once, logged at info: no retry storm, no issue report.
      await db.orm.update(t.guilds).set({ effects_enabled: true }).where(eq(t.guilds.id, GUILD));
      await modmail().reply(OFFICER, number, {
        messageId: "00000000-0000-4000-8000-000000001101",
        body: "Answer",
        signing: "name",
      });
      discord.dm = async () => {
        throw new Failure("dm_blocked", "The recipient has disabled DMs.");
      };
      try {
        const blocked = await dispatch(await asJob(dmKey(id)), guard).catch(
          (error: unknown) => error,
        );
        const outcome = jobOutcome(blocked, 1);
        expect([outcome.status, outcome.level]).toEqual(["failed", "info"]);
      } finally {
        discord.dm = async (user, message) => {
          dms.push({ user, message });
        };
      }
    });
  });

  /**
   * The security review's findings (2.43.0), each a regression test built from its proof: the
   * uppercase message ID, identity in the AAD, padding at rest, list reads, the concurrent
   * duplicate ID, the close DM lost behind a running DM job, one member's pings across cases, and
   * the officers' deliberate exemption from the open-case limit.
   */
  describe("review regressions", () => {
    const reply = (
      actor: Actor,
      number: bigint,
      id: string,
      body = "text",
      signing: "name" | "officers" | null = null,
    ) => modmail().reply(actor, number, { messageId: id, body, signing });

    test("an uppercase message ID is stored and sealed lowercase: it reads back, with no tamper report", async () => {
      await enable();
      const number = await opened(MEMBER);
      const upper = "0A1B2C3D-0000-4000-8000-00000000ABCD";
      expect(await reply(MEMBER, number, upper, "My real reply text")).toEqual({
        status: "saved",
        messageId: upper.toLowerCase(),
      });
      for (const actor of [OFFICER, SECOND_OFFICER, MEMBER]) {
        const view = await modmail().caseView(actor, number);
        expect(view?.entries.map((entry) => entry.body)).toEqual([
          "A message",
          "My real reply text",
        ]);
      }
      expect(reports).toEqual([]);
      // The same form again, in either spelling, lands on the same message.
      expect(await reply(MEMBER, number, upper.toLowerCase(), "My real reply text")).toEqual({
        status: "unchanged",
        messageId: upper.toLowerCase(),
      });
    });

    test("a database writer can't re-attribute an encrypted message or move a case to another opener", async () => {
      await enable();
      const number = await opened(MEMBER, modmail(), "I want to report the raid leader");
      const [row] = await db.query<{ id: string; case_id: string; body: Buffer; key_id: string }>(
        "SELECT id::text AS id, case_id::text AS case_id, body, key_id FROM modmail_messages LIMIT 1",
      );
      if (!row) throw new Error("no row");
      // Without the key: DELETE and INSERT the same ciphertext as another officer's reply.
      await db.query("DELETE FROM modmail_messages WHERE id=$1", [row.id]);
      await db.query(
        "INSERT INTO modmail_messages (id, case_id, kind, author_id, side, signed_as, body, key_id) VALUES ($1,$2,'message',$3,'officer','name',$4,$5)",
        [row.id, row.case_id, SECOND_OFFICER.userId, row.body, row.key_id],
      );
      const memberView = await modmail().caseView(MEMBER, number);
      expect(memberView?.entries[0]?.body).toBeNull();
      expect(reports.map((entry) => entry.scope)).toEqual(["modmail:decrypt-altered"]);
      // The whole case re-inserted under another opener: neither its topic nor its text opens.
      reports = [];
      const [c] = await db.query<Record<string, unknown>>("SELECT * FROM modmail_cases");
      const msgs = await db.query<Record<string, unknown>>("SELECT * FROM modmail_messages");
      if (!c) throw new Error("no case");
      await db.query("DELETE FROM modmail_cases WHERE id=$1", [c.id]);
      await db.query(
        "INSERT INTO modmail_cases (id, guild_id, number, opener_id, state, topic, topic_key_id) VALUES ($1,$2,$3,$4,'officers',$5,$6)",
        [c.id, c.guild_id, c.number, OTHER_MEMBER.userId, c.topic, c.topic_key_id],
      );
      for (const m of msgs)
        await db.query(
          "INSERT INTO modmail_messages (id, case_id, kind, author_id, side, signed_as, body, key_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [m.id, m.case_id, m.kind, OTHER_MEMBER.userId, "member", null, m.body, m.key_id],
        );
      const asOther = await modmail().caseView(OTHER_MEMBER, number);
      expect(asOther?.topic).toBeNull();
      expect(asOther?.entries.map((entry) => entry.body)).toEqual([null]);
      expect(await modmail().caseView(MEMBER, number)).toBeNull();
      expect(reports.map((entry) => entry.scope)).toEqual(["modmail:decrypt-altered"]);
    });

    test("padding: every topic is 540 bytes at rest and bodies grow in 256-byte blocks", async () => {
      await enable();
      await open(MEMBER, modmail(), "a", "b");
      await open(GUEST, modmail(), "t".repeat(100), "x".repeat(300));
      const sizes = await db.query<{ topic: number; body: number }>(
        "SELECT octet_length(c.topic) AS topic, octet_length(m.body) AS body FROM modmail_cases c JOIN modmail_messages m ON m.case_id=c.id ORDER BY c.number",
      );
      expect(sizes).toEqual([
        { topic: 540, body: 28 + 256 },
        { topic: 540, body: 28 + 512 },
      ]);
      // The CHECKs refuse a ciphertext of any other shape.
      await expect(db.query("UPDATE modmail_cases SET topic=topic")).resolves.toBeDefined();
      await expect(
        db.query(
          "INSERT INTO modmail_messages (id, case_id, kind, author_id, side, body, key_id) SELECT gen_random_uuid(), id, 'message', opener_id, 'member', decode(repeat('00', 300), 'hex'), repeat('0', 16) FROM modmail_cases LIMIT 1",
        ),
      ).rejects.toThrow();
    });

    test("lists record a read of each readable topic, once an hour per reader, apart from case views", async () => {
      await enable();
      const first = await opened(MEMBER);
      await opened(GUEST);
      const inbox = await modmail().inbox(OFFICER, "open");
      expect(inbox.cases).toHaveLength(2);
      await modmail().inbox(OFFICER, "open");
      await modmail().mine(MEMBER);
      const reads = await db.query<{ reader: string; side: string; kind: string }>(
        "SELECT reader_id AS reader, side, kind FROM modmail_reads ORDER BY id",
      );
      expect(reads).toEqual([
        { reader: OFFICER.userId, side: "officer", kind: "list" },
        { reader: OFFICER.userId, side: "officer", kind: "list" },
        { reader: MEMBER.userId, side: "member", kind: "list" },
      ]);
      // An hour later the next list counts again; a case view is its own kind.
      await db.query("DELETE FROM modmail_reads");
      await db.query(
        "INSERT INTO modmail_reads (case_id, reader_id, side, kind, read_at) SELECT id, $1, 'officer', 'list', now()-interval '61 minutes' FROM modmail_cases",
        [OFFICER.userId],
      );
      await modmail().inbox(OFFICER, "open");
      const view = await modmail().caseView(OFFICER, first);
      expect(view?.reads?.map((read) => read.kind)).toEqual(["case", "list", "list"]);
      // A list read isn't the member reading a reply: the DM still goes.
      await reply(OFFICER, first, "00000000-0000-4000-8000-000000002001", "answer", "name");
      await modmail().mine(MEMBER);
      expect(
        await notices.skip(await asJob(dmKey((await caseRow(first)).id)), await guildRow()),
      ).toBeNull();
      // Under another key nothing was readable, so nothing counts as seen.
      await db.query("DELETE FROM modmail_reads");
      await modmail(keyFor("another modmail key")).inbox(OFFICER, "open");
      expect(await db.query("SELECT 1 FROM modmail_reads")).toEqual([]);
    });

    test("the same minted ID sent at once to two cases: one saves, the other is a conflict, nothing reported", async () => {
      await enable();
      const a = await opened(MEMBER);
      const b = await opened(GUEST);
      const id = "00000000-0000-4000-8000-000000002101";
      for (let round = 0; round < 5; round++) {
        const shared = round === 0 ? id : `00000000-0000-4000-8000-00000000210${round + 1}`;
        const results = await Promise.all([
          reply(OFFICER, a, shared, "one", "name"),
          reply(OFFICER, b, shared, "two", "name"),
        ]);
        expect(results.map((result) => result?.status).sort()).toEqual(["conflict", "saved"]);
      }
      // The same form sent twice at once to one case: one saves, the repeat lands on it.
      const twice = await Promise.all([
        reply(MEMBER, a, "00000000-0000-4000-8000-000000002201", "dup"),
        reply(MEMBER, a, "00000000-0000-4000-8000-000000002201", "dup"),
      ]);
      expect(twice.map((result) => result?.status).sort()).toEqual(["saved", "unchanged"]);
      expect(reports).toEqual([]);
    });

    test("a close while the reply DM job is running isn't lost: the job runs again, a window later, as closed", async () => {
      await enable();
      const number = await opened(MEMBER);
      const caseId = (await caseRow(number)).id;
      await reply(OFFICER, number, "00000000-0000-4000-8000-000000002301", "answer", "name");
      // The worker has claimed the DM job and is mid-send; it read "reply".
      await db.query(
        "UPDATE jobs SET status='running', lease_until=now()+interval '1 minute' WHERE dedupe_key=$1",
        [dmKey(caseId)],
      );
      const running = await asJob(dmKey(caseId));
      await notices.dm(running, await guildRow());
      await modmail().close(OFFICER, number, (await caseRow(number)).revision);
      const [fenced] = await db.query<{ generation: number; delay: number }>(
        "SELECT generation, extract(epoch FROM due_at-now())::float8 AS delay FROM jobs WHERE dedupe_key=$1",
        [dmKey(caseId)],
      );
      expect(fenced?.generation).toBe(running.generation + 1);
      expect(fenced?.delay ?? 0).toBeGreaterThan(590);
      // The queue's completion sees the newer generation and puts the row back in the queue.
      await db.query(
        `UPDATE jobs SET status = CASE WHEN generation=$2 THEN 'succeeded' ELSE 'queued' END,
           completed_at=now(), lease_until=NULL WHERE id=$1`,
        [running.id, running.generation],
      );
      const [after] = await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [
        running.id,
      ]);
      expect(after?.status).toBe("queued");
      await notices.dm(await asJob(dmKey(caseId)), await guildRow());
      expect(dms.map((entry) => (entry.message as { event: string }).event)).toEqual([
        "reply",
        "closed",
      ]);
    });

    test("one member's reply pings across cases: at most one per window, not one per case", async () => {
      await enable();
      const numbers = [await opened(MEMBER), await opened(MEMBER), await opened(MEMBER)];
      // The three "opened" pings went out 11 minutes ago.
      await db.query(
        "UPDATE jobs SET status='succeeded', completed_at=now()-interval '11 minutes'",
      );
      for (const [index, number] of numbers.entries())
        await reply(MEMBER, number, `00000000-0000-4000-8000-00000000240${index + 1}`, "again");
      const due = await db.query<{ delay: number }>(
        "SELECT extract(epoch FROM due_at-now())::float8 AS delay FROM jobs WHERE status='queued' AND kind='modmail.ping' ORDER BY due_at",
      );
      const delays = due.map((entry) => Math.round(entry.delay));
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBeLessThan(2);
      expect(Math.abs((delays[1] ?? 0) - 600)).toBeLessThan(3);
      expect(Math.abs((delays[2] ?? 0) - 1200)).toBeLessThan(3);
      // Opened pings stay per case: another member's open isn't delayed by this one's replies.
      await opened(GUEST);
      const [guest] = await db.query<{ delay: number }>(
        "SELECT extract(epoch FROM due_at-now())::float8 AS delay FROM jobs WHERE status='queued' AND kind='modmail.ping' AND payload->>'event'='opened'",
      );
      expect(guest?.delay ?? 99).toBeLessThan(2);
    });

    test("officers may lift a member past the open-case limit on purpose, by replying or by Reopen", async () => {
      await enable();
      const numbers = [await opened(MEMBER), await opened(MEMBER), await opened(MEMBER)];
      await modmail().close(MEMBER, numbers[0] ?? 0n, (await caseRow(numbers[0] ?? 0n)).revision);
      await modmail().close(MEMBER, numbers[1] ?? 0n, (await caseRow(numbers[1] ?? 0n)).revision);
      await opened(MEMBER);
      await opened(MEMBER);
      const openCount = async () =>
        (
          await db.query<{ open: number }>(
            "SELECT count(*)::int AS open FROM modmail_cases WHERE opener_id=$1 AND state<>'closed'",
            [MEMBER.userId],
          )
        )[0]?.open;
      expect(await openCount()).toBe(3);
      // The member can't reopen one, but an officer's reply and an officer's Reopen both may.
      expect(await reply(MEMBER, numbers[0] ?? 0n, "00000000-0000-4000-8000-000000002501")).toEqual(
        {
          status: "invalid",
          reason: "open_limit",
        },
      );
      expect(
        (
          await reply(
            OFFICER,
            numbers[0] ?? 0n,
            "00000000-0000-4000-8000-000000002502",
            "x",
            "name",
          )
        )?.status,
      ).toBe("saved");
      expect(
        await modmail().reopen(
          OFFICER,
          numbers[1] ?? 0n,
          (await caseRow(numbers[1] ?? 0n)).revision,
        ),
      ).toEqual({
        status: "saved",
      });
      expect(await openCount()).toBe(5);
      // And with five open, the member still can't open another.
      expect(await open(MEMBER)).toEqual({ status: "refused", reason: "open_limit" });
    });

    test("the ping never mentions @everyone, even when the Officer role setting holds the server's ID", async () => {
      await enable();
      const number = await opened(MEMBER);
      await db.orm.update(t.guilds).set({ officer_role_id: GUILD }).where(eq(t.guilds.id, GUILD));
      await notices.ping(await asJob(pingKey((await caseRow(number)).id)), await guildRow());
      expect(sends[0]?.message).toMatchObject({ kind: "modmail", view: { roleId: null } });
    });
  });
});
