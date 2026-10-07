/**
 * The officer alert about missing channel overrides (2.35.0, #46) against real PostgreSQL:
 * VisibilityAlerts reads crafted gateway snapshots through the Discord port, opens and closes
 * episodes in the audit table, and queues the held alert and the recovery line as officer.notify
 * rows. Nothing runs the queue here; tests move job rows by hand the way the dispatcher would
 * (posted, running, parked). Covered: the two-pass debounce and its streak rule (skipped and busy
 * passes), Administrator held, withdrawal before posting, the recovery line only after a post,
 * the 24-hour window turned into a delay, rows from earlier episodes, onboarding and out-of-scope
 * servers, a restart's lazy reload, the lock, records re-read under it and their cache, the pass
 * budget, and the readiness counts. Confined to its own schema, visibility_alerts_it, with
 * invented IDs throughout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import { eq } from "drizzle-orm";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import {
  VISIBILITY_HOLD_SECONDS,
  VISIBILITY_MISSING_NOTICE,
  VISIBILITY_PASS_BUDGET_MS,
  VISIBILITY_RECORDS_TTL_MS,
  VISIBILITY_REPEAT_SECONDS,
  VISIBILITY_RESTORED_NOTICE,
  VisibilityAlerts,
  visibilityNoticeKey,
  visibilityRestoredKey,
} from "../../src/application/visibility-alerts.js";
import type { Configuration } from "../../src/config/env.js";
import {
  type ApiOverwrite,
  type ApiRole,
  CORE_PERMISSIONS,
  DENY_MASK,
} from "../../src/domain/permissions.js";
import type { VisibilityChannel, VisibilityGuild } from "../../src/domain/visibility.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import {
  audit,
  Database,
  ensureUser,
  orm,
  SESSION_OPTIONS,
} from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { enqueue } from "../../src/jobs/queue.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "visibility_alerts_it";

/** Two servers without onboarding, and one with it. */
const GUILD = "923500000000000100";
const OTHER = "923500000000000101";
const ONBOARDING = "923500000000000102";
const BOT = "923500000000000900";
const BOT_ROLE = "923500000000000600";
const OFFICERS = "923500000000000301";
const APPLICANT = "923500000000000201";
/** Onboarding's four access roles. */
const ACCESS = [
  "923500000000000311",
  "923500000000000312",
  "923500000000000313",
  "923500000000000314",
];
const CHANNEL = {
  /** The officer notifications channel: public. */
  notices: "923500000000000701",
  /** A private channel TaruBot can't see without Administrator. */
  secret: "923500000000000702",
  /** An obfuscated entry: its overwrites are synthetic. */
  hidden: "923500000000000703",
  /** A public channel whose @everyone entry denies Embed Links. */
  plain: "923500000000000704",
  /** A private category holding the ledger, and a sibling. */
  category: "923500000000000710",
  ledger: "923500000000000711",
  sibling: "923500000000000712",
  /** Onboarding's rooms, a channel its pass hasn't reached, and its Community Updates channel. */
  lobby: "923500000000000721",
  officerRoom: "923500000000000722",
  unreached: "923500000000000723",
  updates: "923500000000000724",
} as const;

/** The core seven as one mask. */
const CORE = Object.values(CORE_PERMISSIONS).reduce((all, bit) => all | bit, 0n);

/** A raw overwrite. */
const ow = (id: string, type: 0 | 1, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});
/** A cached text channel. */
const channel = (
  id: string,
  overwrites: ApiOverwrite[],
  extra: Partial<VisibilityChannel> = {},
): VisibilityChannel => ({
  id,
  type: 0,
  parentId: null,
  position: 0,
  overwrites,
  obfuscated: false,
  ...extra,
});
/** Private to officers; readable (two entries), so TaruBot's lack of View is real. */
const privateTo = (guild: string): ApiOverwrite[] => [
  ow(guild, 0, 0n, P.ViewChannel),
  ow(OFFICERS, 0, P.ViewChannel),
];
/** TaruBot's own entry as /setup overrides writes it in a channel no setting names. */
const OWN_ENTRY = ow(BOT, 1, P.ViewChannel, DENY_MASK);

/** A role in a snapshot. */
const role = (id: string, position: number, permissions: bigint, managed = false): ApiRole => ({
  id,
  name: `role ${id.slice(-3)}`,
  position,
  permissions: String(permissions),
  hoist: false,
  managed,
});
/**
 * TaruBot's view of a server: @everyone reads and sends, TaruBot's own role holds the core seven
 * (plus Administrator with `admin`), and the channels are as given.
 */
function view(
  guild: string,
  channels: VisibilityChannel[],
  options: { admin?: boolean; communityUpdatesId?: string } = {},
): VisibilityGuild {
  return {
    guildId: guild,
    bot: { id: BOT, roles: [BOT_ROLE], botRoleId: BOT_ROLE },
    roles: [
      role(guild, 0, P.ViewChannel | P.SendMessages | P.ReadMessageHistory),
      role(OFFICERS, 1, 0n),
      ...ACCESS.map((id, index) => role(id, 2 + index, 0n)),
      role(BOT_ROLE, 10, CORE | (options.admin ? P.Administrator : 0n), true),
    ],
    channels,
    heldRoles: [],
    ...(options.communityUpdatesId ? { communityUpdatesId: options.communityUpdatesId } : {}),
  };
}
/** One private channel is missing TaruBot's override (count 1). */
const missing = (guild = GUILD, admin = false) =>
  view(guild, [channel(CHANNEL.notices, []), channel(CHANNEL.secret, privateTo(guild))], { admin });
/** The same server once TaruBot's entry is there (count 0). */
const complete = (guild = GUILD) =>
  view(guild, [
    channel(CHANNEL.notices, []),
    channel(CHANNEL.secret, [...privateTo(guild), OWN_ENTRY]),
  ]);

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
/** The monitor never reaches the Lodestone. */
const NO_LODESTONE: Lodestone = Object.create(null);

/** A Discord port whose only used method is the cache read; `visibility` is the test's. */
function port(visibility?: DiscordPort["visibility"]): DiscordPort {
  const unused = async (): Promise<never> => {
    throw new Error("Not used by the visibility monitor");
  };
  return {
    member: unused,
    members: unused,
    validateRole: unused,
    validateChannel: unused,
    roles: unused,
    layoutRoles: unused,
    nickname: unused,
    send: unused,
    editReview: unused,
    dm: unused,
    ...(visibility ? { visibility } : {}),
  };
}

describe.skipIf(!url)("the officer alert about missing channel overrides", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  // Connection-string options replace the pool's own, so UTC and the statement timeout are restated.
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());

  /** Each server's snapshot (null: not delivered), and a hook run on every read. */
  let views: Map<string, VisibilityGuild | null>;
  let onRead: (guild: string) => void | Promise<void>;
  let allowed: Set<string>;
  let reads: [string, boolean][];
  let logs: { level: string; fields: Record<string, unknown>; message: string }[];
  let reports: { error: unknown; operation: string }[];
  /** A fresh monitor, as after a restart. */
  const monitor = (discord = port(readView)) =>
    new VisibilityAlerts(new Service(db, discord, NO_LODESTONE, CONFIG), (g) => allowed.has(g), {
      log: (level, fields, message) => logs.push({ level, fields, message }),
      report: (error, operation) => reports.push({ error, operation }),
    });
  async function readView(guild: string, fresh: boolean): Promise<VisibilityGuild | null> {
    reads.push([guild, fresh]);
    await onRead(guild);
    const snapshot = views.get(guild);
    if (snapshot === undefined) throw new Error(`No view for ${guild}`);
    return snapshot;
  }
  /** Run `count` passes. */
  async function passes(alerts: VisibilityAlerts, count: number): Promise<void> {
    for (let pass = 0; pass < count; pass++) await alerts.check();
  }

  /** A key's officer.notify rows, oldest first, with each row's delay in seconds. */
  const notices = (key: string) =>
    db.orm
      .select({
        id: t.jobs.id,
        kind: t.jobs.kind,
        guild: t.jobs.guild_id,
        status: t.jobs.status,
        generation: t.jobs.generation,
        payload: t.jobs.payload,
        result: t.jobs.result,
        due: t.jobs.due_at,
        created: t.jobs.created_at,
      })
      .from(t.jobs)
      .where(eq(t.jobs.dedupe_key, key))
      .orderBy(t.jobs.created_at)
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          delay: Math.round((row.due.getTime() - row.created.getTime()) / 1000),
        })),
      );
  /** The server's episode audit rows, oldest first. */
  const episodes = (guild = GUILD) =>
    db.query<{ action: string; actor_id: string | null; target: string; details: unknown }>(
      `SELECT action, actor_id, target, details FROM audit
        WHERE guild_id = $1 AND action IN ('visibility.missing','visibility.restored') ORDER BY id`,
      [guild],
    );
  /** Move the key's newest row as the dispatcher would. */
  async function mark(
    key: string,
    status: string,
    options: { messageId?: string; completedAgo?: string } = {},
  ): Promise<void> {
    await db.query(
      `UPDATE jobs SET status = $2, message_id = coalesce($3, message_id),
          completed_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() - $4::interval END
        WHERE id = (SELECT id FROM jobs WHERE dedupe_key = $1 ORDER BY created_at DESC LIMIT 1)`,
      [key, status, options.messageId ?? null, options.completedAgo ?? "0 seconds"],
    );
  }

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
  });
  beforeEach(async () => {
    views = new Map([
      [GUILD, missing()],
      [OTHER, missing(OTHER)],
    ]);
    onRead = () => {};
    allowed = new Set([GUILD]);
    reads = [];
    logs = [];
    reports = [];
    await db.query("TRUNCATE guilds, users CASCADE");
    await db.transaction(async (client) => {
      const q = orm(client);
      // Neither server has onboarding; both post officer notices in a public channel.
      for (const id of [GUILD, OTHER])
        await q.insert(t.guilds).values({
          id,
          officer_notifications_channel_id: CHANNEL.notices,
          effects_enabled: true,
        });
      await q.insert(t.guilds).values({
        id: ONBOARDING,
        member_role_id: ACCESS[0],
        guest_role_id: ACCESS[1],
        officer_role_id: ACCESS[2],
        leader_role_id: ACCESS[3],
        lobby_channel_id: CHANNEL.lobby,
        officer_channel_id: CHANNEL.officerRoom,
        ledger_channel_id: CHANNEL.updates,
        access_policy_enabled: true,
        effects_enabled: true,
      });
    });
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  test("the texts are the ones @deconfined approved, character for character", () => {
    // #46 comment 5869082017; never reword them.
    expect(VISIBILITY_MISSING_NOTICE).toBe(
      "Some channels are missing TaruBot's channel override, so without Administrator TaruBot can't see them or can't post where it should. /config validate lists them and what to do; /setup overrides adds missing overrides while TaruBot holds Administrator.",
    );
    expect(VISIBILITY_RESTORED_NOTICE).toBe(
      "TaruBot's channel overrides are complete again: /config validate shows every channel visible.",
    );
  });

  test("one missing pass writes nothing; the second opens one episode with one held alert; later passes add nothing", async () => {
    const alerts = monitor();
    await alerts.check();
    expect(await episodes()).toEqual([]);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual([]);
    // Every pass reads the cache only.
    expect(reads).toEqual([[GUILD, false]]);
    expect(alerts.status()).toMatchObject({ missing: 1, onboardingPending: 0, checked: 1 });

    await alerts.check();
    expect(await episodes()).toEqual([
      {
        action: "visibility.missing",
        actor_id: null,
        target: GUILD,
        details: { categories: 0, channels: 1, masked: 0, denied: 0, private: 0 },
      },
    ]);
    const queued = await notices(visibilityNoticeKey(GUILD));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "officer.notify",
      guild: GUILD,
      status: "queued",
      generation: 1,
      payload: { message: VISIBILITY_MISSING_NOTICE },
      delay: VISIBILITY_HOLD_SECONDS,
    });
    const opened = logs.find((line) => line.message === "Channel overrides missing");
    expect(opened).toMatchObject({
      level: "info",
      fields: { guild: GUILD, missing: 1, channels: 1, delaySeconds: VISIBILITY_HOLD_SECONDS },
    });

    await passes(alerts, 10);
    expect(await episodes()).toHaveLength(1);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual(queued);
    expect(reports).toEqual([]);
  });

  test("the alert is queued while TaruBot still holds Administrator", async () => {
    // Counted as if Administrator were off (answer 5): the alert says what must be in place first.
    views.set(GUILD, missing(GUILD, true));
    const alerts = monitor();
    await passes(alerts, 2);
    expect(await episodes()).toHaveLength(1);
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
      { status: "queued", payload: { message: VISIBILITY_MISSING_NOTICE } },
    ]);
    await passes(alerts, 10);
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([{ generation: 1 }]);
    expect(await episodes()).toHaveLength(1);
  });

  test("without an officer notifications channel the alert waits for one, then posts with the hold", async () => {
    // The documented setup order links the FC first and sets the officer channel near the end.
    await db.orm
      .update(t.guilds)
      .set({ officer_notifications_channel_id: null })
      .where(eq(t.guilds.id, GUILD));
    const alerts = monitor();
    await passes(alerts, 10);
    // The episode opens, but nothing is queued that would reach nobody.
    expect((await episodes()).map((row) => row.action)).toEqual(["visibility.missing"]);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual([]);
    expect(logs.find((line) => line.message === "Channel overrides missing")).toMatchObject({
      fields: { guild: GUILD, delaySeconds: null },
    });
    await db.orm
      .update(t.guilds)
      .set({ officer_notifications_channel_id: CHANNEL.notices })
      .where(eq(t.guilds.id, GUILD));
    await alerts.check();
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
      {
        status: "queued",
        payload: { message: VISIBILITY_MISSING_NOTICE },
        delay: VISIBILITY_HOLD_SECONDS,
      },
    ]);
    await passes(alerts, 5);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(1);
    expect(await episodes()).toHaveLength(1);
  });

  test("an alert skipped because the channel was unset when it came due is queued again", async () => {
    const alerts = monitor();
    await passes(alerts, 2);
    // The dispatcher's answer for a notice with no channel set (src/jobs/dispatch.ts).
    await db.query(
      `UPDATE jobs SET status = 'succeeded', completed_at = now(), lease_until = NULL,
          result = '{"skipped":"officer notifications unconfigured"}' WHERE dedupe_key = $1`,
      [visibilityNoticeKey(GUILD)],
    );
    // After a restart (the in-memory state is gone), the next pass owes the alert again.
    const restarted = monitor();
    await restarted.check();
    const rows = await notices(visibilityNoticeKey(GUILD));
    expect(rows).toMatchObject([
      { status: "succeeded", result: { skipped: "officer notifications unconfigured" } },
      { status: "queued", payload: { message: VISIBILITY_MISSING_NOTICE } },
    ]);
    expect(rows[1]?.delay).toBe(VISIBILITY_HOLD_SECONDS);
    await passes(restarted, 5);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(2);
    expect(await episodes()).toHaveLength(1);
  });

  test("in the same process, an alert skipped while the channel was unset is queued again once it is set", async () => {
    const alerts = monitor();
    await passes(alerts, 2);
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([{ status: "queued" }]);
    // An officer unsets the channel before the alert comes due; the dispatcher then skips it.
    const channel = (id: string | null) =>
      db.orm
        .update(t.guilds)
        .set({ officer_notifications_channel_id: id })
        .where(eq(t.guilds.id, GUILD));
    await channel(null);
    await alerts.check();
    await db.query(
      `UPDATE jobs SET status = 'succeeded', completed_at = now(), lease_until = NULL,
          result = '{"skipped":"officer notifications unconfigured"}' WHERE dedupe_key = $1`,
      [visibilityNoticeKey(GUILD)],
    );
    await passes(alerts, 2);
    // Nothing reaches nobody while it is unset.
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(1);
    await channel(CHANNEL.notices);
    await alerts.check();
    const rows = await notices(visibilityNoticeKey(GUILD));
    expect(rows).toMatchObject([
      { status: "succeeded", result: { skipped: "officer notifications unconfigured" } },
      { status: "queued", payload: { message: VISIBILITY_MISSING_NOTICE } },
    ]);
    expect(rows[1]?.delay).toBe(VISIBILITY_HOLD_SECONDS);
    await passes(alerts, 5);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(2);
    expect(await episodes()).toHaveLength(1);
  });

  test("a channel unset and set again before the alert comes due queues no second alert", async () => {
    const alerts = monitor();
    await passes(alerts, 2);
    const channel = (id: string | null) =>
      db.orm
        .update(t.guilds)
        .set({ officer_notifications_channel_id: id })
        .where(eq(t.guilds.id, GUILD));
    await channel(null);
    await passes(alerts, 2);
    await channel(CHANNEL.notices);
    await passes(alerts, 3);
    // The pending alert is found again in the database and kept: still one row.
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
      { status: "queued", payload: { message: VISIBILITY_MISSING_NOTICE } },
    ]);
  });

  test("restoring before the alert posts withdraws it, queued, blocked or parked, with no recovery line", async () => {
    for (const status of ["queued", "blocked", "disabled"]) {
      await db.query("TRUNCATE audit, jobs CASCADE");
      views.set(GUILD, missing());
      const alerts = monitor();
      await passes(alerts, 2);
      await mark(visibilityNoticeKey(GUILD), status);
      views.set(GUILD, complete());
      await alerts.check();
      // One clear pass is a possible blip: nothing yet.
      expect((await episodes()).map((row) => row.action)).toEqual(["visibility.missing"]);
      await alerts.check();
      expect(await episodes()).toMatchObject([
        { action: "visibility.missing" },
        { action: "visibility.restored", actor_id: null, target: GUILD, details: {} },
      ]);
      expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
        { status: "succeeded", result: { skipped: "restored before posting" } },
      ]);
      expect(await notices(visibilityRestoredKey(GUILD))).toEqual([]);
      expect(logs.at(-1)).toMatchObject({
        message: "Channel overrides restored",
        fields: { guild: GUILD, recovery: false },
      });
    }
  });

  test("restoring after the alert posted queues exactly one recovery line", async () => {
    const alerts = monitor();
    await passes(alerts, 2);
    await mark(visibilityNoticeKey(GUILD), "succeeded", { messageId: "923500000000000801" });
    views.set(GUILD, complete());
    await passes(alerts, 2);
    expect(await notices(visibilityRestoredKey(GUILD))).toMatchObject([
      {
        kind: "officer.notify",
        guild: GUILD,
        status: "queued",
        generation: 1,
        payload: { message: VISIBILITY_RESTORED_NOTICE },
        delay: 5,
      },
    ]);
    await passes(alerts, 5);
    expect(await notices(visibilityRestoredKey(GUILD))).toMatchObject([{ generation: 1 }]);
    expect(await episodes()).toHaveLength(2);
  });

  test("a one-pass return to 0, or a one-pass count, changes nothing", async () => {
    const alerts = monitor();
    // Clear, one missing pass, clear: no episode.
    views.set(GUILD, complete());
    await alerts.check();
    views.set(GUILD, missing());
    await alerts.check();
    views.set(GUILD, complete());
    await alerts.check();
    views.set(GUILD, missing());
    await alerts.check();
    expect(await episodes()).toEqual([]);
    // A second consecutive missing pass opens it.
    await alerts.check();
    expect(await episodes()).toHaveLength(1);
    // Open, one clear pass between missing ones: still open, the alert untouched.
    for (const snapshot of [complete(), missing(), complete(), missing()]) {
      views.set(GUILD, snapshot);
      await alerts.check();
    }
    expect((await episodes()).map((row) => row.action)).toEqual(["visibility.missing"]);
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
      { status: "queued", generation: 1 },
    ]);
  });

  test("a pass that doesn't compute the count leaves the streak alone", async () => {
    // Missing, not delivered, missing: the skipped pass neither confirms nor resets.
    const alerts = monitor();
    await alerts.check();
    views.set(GUILD, null);
    await alerts.check();
    expect(alerts.status()).toMatchObject({ missing: 0, checked: 0 });
    expect(await episodes()).toEqual([]);
    views.set(GUILD, missing());
    await alerts.check();
    expect(await episodes()).toHaveLength(1);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(1);

    // An error reading one server is reported, and skips it the same way.
    await db.query("TRUNCATE audit, jobs CASCADE");
    const failing = monitor();
    await failing.check();
    onRead = () => {
      throw new Error("cache read failed");
    };
    await failing.check();
    expect(reports.map((entry) => entry.operation)).toEqual(["visibility alerts"]);
    expect(await episodes()).toEqual([]);
    onRead = () => {};
    await failing.check();
    expect(await episodes()).toHaveLength(1);
  });

  test("a confirmed streak whose server is locked elsewhere waits for the next pass", async () => {
    const alerts = monitor();
    await alerts.check();
    // Another session holds the server's lock during the confirming pass: skipped, no error.
    const holder = await db.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `visibility:${GUILD}`,
      ]);
      await alerts.check();
      expect(await episodes()).toEqual([]);
      expect(reports).toEqual([]);
      // The pass still counted the server.
      expect(alerts.status()).toMatchObject({ missing: 1, checked: 1 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `visibility:${GUILD}`,
      ]);
      holder.release();
    }
    // The streak stayed confirmed: the third pass opens exactly one episode.
    await alerts.check();
    expect(await episodes()).toHaveLength(1);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(1);
    await passes(alerts, 3);
    expect(await episodes()).toHaveLength(1);
  });

  describe("the 24-hour window", () => {
    /** An episode whose alert posted an hour ago, then restored with its recovery line. */
    async function postedEarlier(alerts: VisibilityAlerts): Promise<void> {
      await passes(alerts, 2);
      await mark(visibilityNoticeKey(GUILD), "succeeded", {
        messageId: "923500000000000802",
        completedAgo: "1 hour",
      });
      views.set(GUILD, complete());
      await passes(alerts, 2);
      expect(await notices(visibilityRestoredKey(GUILD))).toHaveLength(1);
      views.set(GUILD, missing());
    }
    /** Seconds from the key's newest posted alert's completion to `due`, less 24 hours. */
    const offWindow = async (due: string) => {
      const [row] = await db.query<{ off: number }>(
        `SELECT extract(epoch FROM $2::timestamptz - (completed_at + $3 * interval '1 second'))::float AS off
           FROM jobs WHERE dedupe_key = $1 AND message_id IS NOT NULL`,
        [visibilityNoticeKey(GUILD), due, VISIBILITY_REPEAT_SECONDS],
      );
      return row?.off;
    };

    test("a new episode within 24 hours of a posted alert delays its alert to the window's end, once", async () => {
      const alerts = monitor();
      await postedEarlier(alerts);
      await passes(alerts, 2);
      const waiting = (await notices(visibilityNoticeKey(GUILD))).filter(
        (row) => row.status === "queued",
      );
      expect(waiting).toHaveLength(1);
      // About 23 hours, not the 5-minute hold, and not dropped.
      const [due] = await db.query<{ due: string }>(
        "SELECT due_at::text AS due FROM jobs WHERE dedupe_key = $1 AND status = 'queued'",
        [visibilityNoticeKey(GUILD)],
      );
      expect(Math.abs((await offWindow(due?.due ?? "")) ?? 99)).toBeLessThan(5);
      expect(waiting[0]?.delay).toBeGreaterThan(VISIBILITY_REPEAT_SECONDS - 3700);
      // Persisting: still exactly one alert, due at the window's end.
      await passes(alerts, 5);
      expect(
        (await notices(visibilityNoticeKey(GUILD))).filter((row) => row.status === "queued"),
      ).toEqual(waiting);
    });

    test("a new episode withdraws the last one's recovery line if it hasn't started", async () => {
      // A retry after a failed send (due later, one attempt spent), blocked, or parked while
      // Discord changes are paused: none may say "complete again" once channels are missing.
      const states = [
        `status = 'queued', attempts = 1, due_at = now() + interval '10 minutes'`,
        `status = 'blocked', last_error = 'blocked: TaruBot needs View Channel.'`,
        `status = 'disabled'`,
      ];
      for (const state of states) {
        await db.query("TRUNCATE audit, jobs CASCADE");
        views.set(GUILD, missing());
        const alerts = monitor();
        await postedEarlier(alerts);
        await db.query(`UPDATE jobs SET ${state} WHERE dedupe_key = $1`, [
          visibilityRestoredKey(GUILD),
        ]);
        await passes(alerts, 2);
        expect((await episodes()).map((row) => row.action)).toEqual([
          "visibility.missing",
          "visibility.restored",
          "visibility.missing",
        ]);
        expect(await notices(visibilityRestoredKey(GUILD))).toMatchObject([
          { status: "succeeded", result: { skipped: "superseded by a new episode" } },
        ]);
        // The new episode's alert waits for the window's end, as before.
        expect((await notices(visibilityNoticeKey(GUILD))).at(-1)).toMatchObject({
          status: "queued",
          payload: { message: VISIBILITY_MISSING_NOTICE },
        });
      }
      // One already sending is left alone, like a running alert.
      await db.query("TRUNCATE audit, jobs CASCADE");
      views.set(GUILD, missing());
      const alerts = monitor();
      await postedEarlier(alerts);
      await mark(visibilityRestoredKey(GUILD), "running");
      await passes(alerts, 2);
      expect(await notices(visibilityRestoredKey(GUILD))).toMatchObject([
        { status: "running", result: null },
      ]);
    });

    test("an episode that ends inside the window withdraws its delayed alert, with no recovery line", async () => {
      const alerts = monitor();
      await postedEarlier(alerts);
      await passes(alerts, 2);
      views.set(GUILD, complete());
      await passes(alerts, 2);
      const rows = await notices(visibilityNoticeKey(GUILD));
      expect(rows.at(-1)).toMatchObject({
        status: "succeeded",
        result: { skipped: "restored before posting" },
      });
      // Only the first episode's recovery line, never merged into again.
      expect(await notices(visibilityRestoredKey(GUILD))).toMatchObject([{ generation: 1 }]);
    });
  });

  test("a notice still sending from an earlier episode is never merged into; the next pass after it finishes queues the delayed alert", async () => {
    const alerts = monitor();
    await passes(alerts, 2);
    await mark(visibilityNoticeKey(GUILD), "running");
    // Restored while it sends: it counts as posted, so a recovery line follows.
    views.set(GUILD, complete());
    await passes(alerts, 2);
    expect(await notices(visibilityRestoredKey(GUILD))).toHaveLength(1);
    views.set(GUILD, missing());
    await passes(alerts, 4);
    expect(await episodes()).toHaveLength(3);
    expect(await notices(visibilityNoticeKey(GUILD))).toMatchObject([
      { status: "running", generation: 1 },
    ]);
    // It finishes, posted: the next pass queues this episode's alert at the window's end.
    await mark(visibilityNoticeKey(GUILD), "succeeded", { messageId: "923500000000000803" });
    await alerts.check();
    const rows = await notices(visibilityNoticeKey(GUILD));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "queued", generation: 1 });
    expect(rows[1]?.delay).toBeGreaterThan(VISIBILITY_REPEAT_SECONDS - 60);
    await passes(alerts, 3);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(2);
  });

  test("an earlier episode's unstarted row is closed as superseded before the new alert", async () => {
    await db.transaction(async (client) => {
      await enqueue(
        client,
        "officer.notify",
        visibilityNoticeKey(GUILD),
        { message: "an older alert" },
        GUILD,
      );
    });
    const alerts = monitor();
    await passes(alerts, 2);
    const rows = await notices(visibilityNoticeKey(GUILD));
    expect(rows).toMatchObject([
      {
        payload: { message: "an older alert" },
        status: "succeeded",
        result: { skipped: "superseded by a new episode" },
      },
      { payload: { message: VISIBILITY_MISSING_NOTICE }, status: "queued", generation: 1 },
    ]);
    await passes(alerts, 5);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual(rows);
  });

  test("onboarding servers, servers out of scope and undelivered servers never open an episode", async () => {
    // Onboarding: a channel its pass hasn't reached, and the configured Community Updates channel.
    allowed = new Set([GUILD, OTHER, ONBOARDING]);
    views.set(GUILD, null);
    views.set(
      ONBOARDING,
      view(
        ONBOARDING,
        [
          channel(CHANNEL.lobby, []),
          channel(CHANNEL.officerRoom, [
            ...privateTo(ONBOARDING),
            ow(BOT, 1, P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks),
          ]),
          channel(CHANNEL.unreached, privateTo(ONBOARDING)),
          channel(CHANNEL.updates, privateTo(ONBOARDING)),
        ],
        { communityUpdatesId: CHANNEL.updates },
      ),
    );
    // OTHER is missing, but this deployment doesn't serve it.
    allowed.delete(OTHER);
    const alerts = monitor();
    await passes(alerts, 4);
    // Onboarding's two pending channels show in readiness only; nothing counts as missing.
    expect(alerts.status()).toMatchObject({ missing: 0, onboardingPending: 2, checked: 1 });
    for (const guild of [GUILD, OTHER, ONBOARDING]) {
      expect(await episodes(guild)).toEqual([]);
      expect(await notices(visibilityNoticeKey(guild))).toEqual([]);
    }
    expect(reads.map(([guild]) => guild)).not.toContain(OTHER);

    // A port with no cache reader skips every server.
    const blind = monitor(port());
    await passes(blind, 3);
    expect(blind.status()).toMatchObject({ missing: 0, onboardingPending: 0, checked: 0 });
    expect(reports).toEqual([]);
  });

  test("after a restart the episode reloads lazily: no second alert, and the restore still follows", async () => {
    await passes(monitor(), 2);
    const alert = await notices(visibilityNoticeKey(GUILD));
    const restarted = monitor();
    await passes(restarted, 3);
    expect(await episodes()).toHaveLength(1);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual(alert);
    views.set(GUILD, complete());
    await passes(restarted, 2);
    expect((await episodes()).map((row) => row.action)).toEqual([
      "visibility.missing",
      "visibility.restored",
    ]);
  });

  test("records re-read under the lock can cancel a transition", async () => {
    // Only an obfuscated entry is missing; nothing records it as hidden on purpose yet.
    views.set(
      GUILD,
      view(GUILD, [
        channel(CHANNEL.notices, []),
        channel(CHANNEL.hidden, [ow(GUILD, 0, 0n, P.ViewChannel)], { obfuscated: true }),
      ]),
    );
    const alerts = monitor();
    await alerts.check();
    expect(alerts.status()).toMatchObject({ missing: 1 });
    // A /setup overrides run records it before the confirming pass, whose cached records are stale.
    await db.transaction(async (client) => {
      await audit(client, GUILD, OFFICERS, "setup.overrides", GUILD, {
        written: [],
        hiddenOnPurpose: [CHANNEL.hidden],
      });
    });
    await alerts.check();
    // Under the lock the count is 0: cancelled, and that is the pass's observation.
    expect(await episodes()).toEqual([]);
    expect(alerts.status()).toMatchObject({ missing: 0 });
    await passes(alerts, 3);
    expect(await episodes()).toEqual([]);
    expect(await notices(visibilityNoticeKey(GUILD))).toEqual([]);
  });

  test("stored records are reused for ten minutes between passes", async () => {
    // TaruBot sees this channel but can't embed there, which matters only for a posting channel.
    views.set(
      GUILD,
      view(GUILD, [
        channel(CHANNEL.notices, []),
        channel(CHANNEL.plain, [ow(GUILD, 0, 0n, P.EmbedLinks)]),
      ]),
    );
    const alerts = monitor();
    try {
      await alerts.check();
      expect(alerts.status()).toMatchObject({ missing: 0 });
      // An application now waits there, which makes it a posting channel.
      await db.transaction(async (client) => {
        await ensureUser(client, GUILD, APPLICANT, new Date("2026-09-01T00:00:00Z"));
        await orm(client)
          .insert(t.guestApplications)
          .values({
            guild_id: GUILD,
            user_id: APPLICANT,
            joined_at: new Date("2026-09-01T00:00:00Z"),
            channel_id: CHANNEL.plain,
          });
      });
      await alerts.check();
      expect(alerts.status()).toMatchObject({ missing: 0 });
      setSystemTime(new Date(Date.now() + VISIBILITY_RECORDS_TTL_MS + 1000));
      await alerts.check();
      expect(alerts.status()).toMatchObject({ missing: 1 });
    } finally {
      setSystemTime();
    }
  });

  test("a private category counts: it opens an episode", async () => {
    await db.query("UPDATE guilds SET ledger_channel_id = $2 WHERE id = $1", [
      GUILD,
      CHANNEL.ledger,
    ]);
    views.set(
      GUILD,
      view(GUILD, [
        channel(CHANNEL.notices, []),
        channel(CHANNEL.category, privateTo(GUILD), { type: 4 }),
        channel(CHANNEL.ledger, privateTo(GUILD), { parentId: CHANNEL.category }),
        channel(CHANNEL.sibling, privateTo(GUILD), { parentId: CHANNEL.category, position: 1 }),
      ]),
    );
    const alerts = monitor();
    await passes(alerts, 2);
    // The category and both channels inside it: 1 + 2.
    expect(await episodes()).toMatchObject([
      {
        action: "visibility.missing",
        details: { categories: 0, channels: 0, masked: 0, denied: 0, private: 3 },
      },
    ]);
    expect(await notices(visibilityNoticeKey(GUILD))).toHaveLength(1);
    expect(alerts.status()).toMatchObject({ missing: 3 });
  });

  test("the pass budget stops new transitions and further servers, keeping every streak", async () => {
    allowed = new Set([GUILD, OTHER]);
    const alerts = monitor();
    try {
      await alerts.check();
      // The confirming pass spends its budget reading the first server.
      onRead = (guild) => {
        if (guild === GUILD) setSystemTime(new Date(Date.now() + VISIBILITY_PASS_BUDGET_MS + 1000));
      };
      await alerts.check();
      expect(await episodes(GUILD)).toEqual([]);
      expect(await episodes(OTHER)).toEqual([]);
      expect(alerts.status()).toMatchObject({ checked: 1, missing: 1 });
      expect(logs.at(-1)).toMatchObject({
        level: "warn",
        fields: { checked: 1, skipped: 1 },
        message: "Channel override check stopped at its time budget",
      });
      onRead = () => {};
      // Both streaks held: the first confirmed, the second untouched. Both open now.
      await alerts.check();
      expect(await episodes(GUILD)).toHaveLength(1);
      expect(await episodes(OTHER)).toHaveLength(1);
      expect(alerts.status()).toMatchObject({ checked: 2, missing: 2 });
    } finally {
      setSystemTime();
    }
  });
});
