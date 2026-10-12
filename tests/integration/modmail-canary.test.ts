/**
 * Mod mail's plaintext never leaves the page render (2.43.0): a /modmail form submission carrying a
 * canary string goes through the real interaction router, the real reporter and issue reports, the
 * job dispatcher and a recorded Discord, once successfully and once with a database error forced
 * mid-open; then every log line, recorded Discord request and call, issue report, job, delivery
 * attempt, audit row and mod mail row is searched for the canary. The form's receipt stays private
 * even with DevBot's public-response override on. Disposable PostgreSQL, its own schema
 * (modmail_canary_it), invented IDs and a key derived from a phrase.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MessageFlags } from "discord.js";
import { multistream, pino } from "pino";
import { IssueReports } from "../../src/application/issue-reports.js";
import { modmailKey } from "../../src/application/keys.js";
import { ModMail } from "../../src/application/modmail.js";
import type { DiscordPort } from "../../src/application/records.js";
import type { GuildAccess } from "../../src/application/guild-access.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { createReporter, type Reporter } from "../../src/application/reporting.js";
import { Service } from "../../src/application/service.js";
import type { Synchronization } from "../../src/application/synchronization.js";
import type { BotContext } from "../../src/bot/context.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import modmailCommand from "../../src/commands/utility/modmail.command.js";
import modmailComponent from "../../src/components/modmail.component.js";
import type { Configuration } from "../../src/config/env.js";
import { dmKey, pingKey } from "../../src/domain/modmail.js";
import type { Actor } from "../../src/domain/policy.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { readModMailKey } from "../../src/infrastructure/modmail/cipher.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import type { Job } from "../../src/jobs/queue.js";
import { actorOf } from "../fixtures/actors.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "modmail_canary_it";
const GUILD = "666666666666666811";
const MEMBER_ROLE = "523456789012345811";
const CHANNEL = "623456789012345811";
const ORIGIN = "https://tarubot.example.org";
/** The text a member typed; it must turn up nowhere but a page. */
const CANARY = "canary-plaintext-modmail-router-91d3";

const CONFIG: Configuration = {
  DATABASE_URL: url ?? "postgresql://unused/unused",
  DISCORD_TOKEN: "test-only",
  DISCORD_APPLICATION_ID: "123",
  LOG_LEVEL: "debug",
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

describe.skipIf(!url)("mod mail plaintext through the router and reporter", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  const fixture = interactionFixture();
  fixture.member.guildId = GUILD;
  fixture.member.userId = "723456789012345811";
  const member: Actor = actorOf({
    guildId: GUILD,
    userId: fixture.member.userId,
    manageRoles: false,
    member: true,
    guest: false,
    botAdministrator: false,
  });
  const officer: Actor = actorOf({
    ...member,
    userId: "723456789012345801",
    officer: true,
    member: false,
  });
  /** Every Discord port call, as JSON. */
  const discordCalls: string[] = [];
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
    editReview: unused,
    send: async (...args) => {
      discordCalls.push(
        JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
      );
      return "999999999999999911";
    },
    dm: async (...args) => {
      discordCalls.push(
        JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
      );
    },
    visibility: async () => null,
    displayNames: async () => new Map(),
  };
  const lines: string[] = [];
  const recent = new RecentLogs();
  const log = pino(
    {
      level: "debug",
      redact: ["token", "biography", "authorization", "password", "interaction.token"],
    },
    multistream([
      { level: "debug", stream: { write: (line: string) => void lines.push(line) } },
      { level: "info", stream: recent },
    ]),
  );
  const app = new Service(db, discord, new Lodestone(), CONFIG);
  const reports = new IssueReports(CONFIG, db, new Lodestone(), recent, null);
  const pending: Promise<void>[] = [];
  const logReport = createReporter(log);
  /** main.ts's reporter: the log line, and an issue report for every error-level one. */
  const report: Reporter = (error, operation, options = {}) => {
    logReport(error, operation, options);
    if ((options.level ?? "error") === "error")
      pending.push(reports.error(error, operation, options.scope));
  };
  const key = readModMailKey(
    createHash("sha256").update("canary modmail key").digest().toString("base64"),
  );
  const modmail = new ModMail(app, key, ORIGIN, () => false, report);
  const services = new Services().provide(modmailKey, modmail);
  const context: BotContext = {
    client: fixture.client,
    services,
    report,
    allowsGuild: () => true,
    isStopping: () => false,
    // DevBot's public-response override, on for this very server: /modmail must stay private.
    publicResponseGuildId: GUILD,
    resolveActor: async (_guild, userId) => (userId === member.userId ? member : officer),
  };
  const router = new InteractionRouter(
    context,
    new Map([[modmailCommand.name, modmailCommand]]),
    new Map([[modmailComponent.prefix, modmailComponent]]),
  );
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
  const asJob = async (dedupe: string): Promise<Job> => {
    const [row] = await db.orm.select().from(t.jobs).where(eq(t.jobs.dedupe_key, dedupe));
    if (!row) throw new Error("No such job");
    return { ...row, lease_token: "00000000-0000-4000-8000-000000000000" };
  };

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      member_role_id: MEMBER_ROLE,
      officer_role_id: "523456789012345813",
      officer_notifications_channel_id: CHANNEL,
      effects_enabled: true,
      role_layout_enabled: false,
    });
    expect(await modmail.toggle(officer, { enabled: true, revision: 1n })).toEqual({
      status: "saved",
    });
  });
  afterAll(async () => {
    await fixture.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.close();
    await admin.close();
  });

  test("a form submission, its jobs and a forced failure leave the text nowhere but the page", async () => {
    const custom = `modmail:${GUILD}:${member.userId}`;
    await router.handle(
      fixture.submit(custom, { topic: `Topic ${CANARY}`, message: `Body ${CANARY}` }),
    );
    // The receipt: deferred privately despite the public-response override, then "Case #1 opened".
    const [ack, receipt] = fixture.requests;
    const acknowledged = ack?.body as { data?: { flags?: number } } | undefined;
    expect(acknowledged?.data?.flags).toBe(MessageFlags.Ephemeral);
    expect(JSON.stringify(receipt?.body)).toContain("Case #1 opened");
    // The ping and, after an officer's reply, the DM, through the dispatcher.
    const caseId =
      (await db.orm.select({ id: t.modmailCases.id }).from(t.modmailCases))[0]?.id ?? "";
    expect(await dispatch(await asJob(pingKey(caseId)), async () => {})).toMatchObject({
      status: "delivered",
    });
    await modmail.reply(officer, 1n, {
      messageId: "00000000-0000-4000-8000-000000003001",
      body: `Reply ${CANARY}`,
      signing: "officers",
    });
    expect(await dispatch(await asJob(dmKey(caseId)), async () => {})).toMatchObject({
      status: "delivered",
    });
    // The page decrypts it for those allowed.
    expect((await modmail.caseView(member, 1n))?.topic).toBe(`Topic ${CANARY}`);

    // A database error mid-open (after the case row, at the message insert): reported, nothing kept.
    await db.query(
      "CREATE FUNCTION fail_modmail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
    );
    await db.query(
      "CREATE TRIGGER fail_modmail_insert BEFORE INSERT ON modmail_messages FOR EACH ROW EXECUTE FUNCTION fail_modmail_insert()",
    );
    try {
      await router.handle(
        fixture.submit(custom, { topic: `Second ${CANARY}`, message: `Failing ${CANARY}` }),
      );
    } finally {
      await db.query("DROP TRIGGER fail_modmail_insert ON modmail_messages");
      await db.query("DROP FUNCTION fail_modmail_insert()");
    }
    await Promise.all(pending);
    const failureCard = JSON.stringify(fixture.requests.at(-1)?.body);
    expect(failureCard).toContain("Something went wrong");
    // The failure was reported and saved as an issue report.
    const saved = await db.query<{ body: string; title: string }>(
      "SELECT body, title FROM issue_reports",
    );
    expect(saved.length).toBeGreaterThan(0);
    // Its message is the failed statement with the bound values left out (only ciphertext was
    // bound anyway).
    const bodies = saved.map((row) => row.body).join("\n");
    expect(bodies).toContain("modmail_messages");
    expect(bodies).toContain("params: (left out of reports)");
    // Rolled back: still one case.
    expect(await db.orm.select({ id: t.modmailCases.id }).from(t.modmailCases)).toHaveLength(1);

    // Now the search: logs, recent logs, Discord requests and calls, and every table.
    const everywhere = [
      ...lines,
      ...recent.recent(1000),
      ...fixture.requests.map((request) => JSON.stringify(request)),
      ...discordCalls,
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of everywhere) expect(entry).not.toContain(CANARY);
    const rows = await db.query<{ row: string }>(
      `SELECT row_to_json(x)::text AS row FROM (SELECT * FROM issue_reports) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM delivery_attempts) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM jobs) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM audit) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_cases) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_messages) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_reads) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_settings) x`,
    );
    expect(rows.some(({ row }) => row.includes("delivered"))).toBe(true);
    for (const { row } of rows) expect(row).not.toContain(CANARY);
    // Nor any spelling the bytes might take as hex or base64 in a dump.
    const hex = Buffer.from(CANARY).toString("hex");
    const base64 = Buffer.from(CANARY).toString("base64");
    for (const { row } of rows) {
      expect(row).not.toContain(hex);
      expect(row).not.toContain(base64);
    }
  });
});
