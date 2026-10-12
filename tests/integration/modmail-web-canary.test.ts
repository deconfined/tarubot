/**
 * Mod mail's plaintext never leaves the page render on the web path either (2.43.0, delta review):
 * a member opens a case on the Mod mail page and replies to it, through the real web app
 * (createWebApp with the real page modules), the real ModMail, the real reporter and issue
 * reports, real database sessions and the job dispatcher with a recorded Discord, all with a
 * canary in the text; then a refused form (422) and a database error forced mid-open. Every web
 * log line, recent log, Discord call and the rows of every table that could hold it (issue
 * reports, delivery attempts, jobs, audit, sessions and mod mail's own) are searched for the
 * canary, as text, hex and base64. Only the encrypted columns hold it, encrypted, and only the
 * author's own pages show it. Disposable PostgreSQL in its own schema (modmail_web_canary_it),
 * invented IDs and a key derived from a phrase.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { multistream, pino } from "pino";
import type { GuildAccess } from "../../src/application/guild-access.js";
import { IssueReports } from "../../src/application/issue-reports.js";
import { modmailKey } from "../../src/application/keys.js";
import { ModMail } from "../../src/application/modmail.js";
import type { DiscordPort } from "../../src/application/records.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { createReporter, type Reporter } from "../../src/application/reporting.js";
import { Service } from "../../src/application/service.js";
import type { Synchronization } from "../../src/application/synchronization.js";
import { Services } from "../../src/bot/services.js";
import type { Configuration } from "../../src/config/env.js";
import { pingKey } from "../../src/domain/modmail.js";
import type { Actor } from "../../src/domain/policy.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { readModMailKey } from "../../src/infrastructure/modmail/cipher.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import type { Job } from "../../src/jobs/queue.js";
import { AccessResolver } from "../../src/web/access.js";
import { DiscordSignIn } from "../../src/web/oauth.js";
import { loadPages } from "../../src/web/pages.js";
import { createWebApp } from "../../src/web/server.js";
import { formToken, PgSessions } from "../../src/web/sessions.js";
import { webSettings } from "../../src/web/settings.js";
import { actorOf } from "../fixtures/actors.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "modmail_web_canary_it";
const GUILD = "666666666666666821";
const CHANNEL = "623456789012345821";
const ORIGIN = "http://localhost:8080";
/** What the member typed on the web; it must turn up nowhere but their own pages. */
const CANARY = "canary-plaintext-modmail-web-6c1a";

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

describe.skipIf(!url)("mod mail plaintext through the web app and reporter", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  const member: Actor = actorOf({
    guildId: GUILD,
    userId: "723456789012345821",
    manageRoles: false,
    member: true,
    guest: false,
    botAdministrator: false,
  });
  const officer: Actor = actorOf({
    ...member,
    userId: "723456789012345822",
    officer: true,
    member: false,
  });
  /** Every Discord port call, as JSON. */
  const discordCalls: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("Not expected in mod mail");
  };
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item));
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
      discordCalls.push(json(args));
      return "999999999999999921";
    },
    dm: async (...args) => {
      discordCalls.push(json(args));
    },
    visibility: async () => null,
    displayNames: async () => new Map(),
  };
  const lines: string[] = [];
  const recent = new RecentLogs();
  const log = pino(
    { level: "debug" },
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
    createHash("sha256").update("web canary modmail key").digest().toString("base64"),
  );
  const modmail = new ModMail(app, key, ORIGIN, () => false, report);
  const sessions = new PgSessions(db);
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

  /** The real web app over the real pages, signed in as the member. */
  async function browser() {
    const parsed = webSettings({
      WEB_PUBLIC_ORIGIN: ORIGIN,
      DISCORD_CLIENT_SECRET: "invented-client-secret",
      DISCORD_APPLICATION_ID: "300000000000000021",
    });
    if (parsed.status !== "on") throw new Error("Invalid test settings");
    const resolve = async (guildId: string, userId: string): Promise<Actor> => ({
      ...(userId === member.userId ? member : officer),
      guildId,
    });
    const web = createWebApp({
      settings: parsed.settings,
      context: {
        services: new Services().provide(modmailKey, modmail),
        allowsGuild: () => true,
        isStopping: () => false,
        resolveActor: resolve,
        report,
        guilds: () => [{ id: GUILD, name: "Example FC" }],
      },
      pages: await loadPages(),
      sessions,
      signIn: new DiscordSignIn({
        clientId: parsed.settings.clientId,
        clientSecret: parsed.settings.clientSecret,
        redirectUri: parsed.settings.redirectUri,
      }),
      access: new AccessResolver(resolve),
      log,
    });
    const { token } = await sessions.create(member.userId);
    const cookie = `tarubot=${token}`;
    const get = async (path: string) => {
      const response = await web.request(`${ORIGIN}${path}`, { headers: { cookie } });
      return { status: response.status, text: await response.text() };
    };
    const post = async (path: string, fields: Record<string, string>) => {
      const response = await web.request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ form_token: formToken(token), ...fields }),
      });
      return {
        status: response.status,
        location: response.headers.get("location"),
        text: await response.text(),
      };
    };
    return { get, post };
  }

  /** A hidden field's value in the form whose op is `op`, on a page's markup. */
  const field = (markup: string, op: string, name: string) =>
    parseHTML(markup)
      .document.querySelector(`form:has(input[name="op"][value="${op}"]) input[name="${name}"]`)
      ?.getAttribute("value") ?? "";

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      member_role_id: "523456789012345821",
      officer_role_id: "523456789012345823",
      officer_notifications_channel_id: CHANNEL,
      effects_enabled: true,
      role_layout_enabled: false,
    });
    expect(await modmail.toggle(officer, { enabled: true, revision: 1n })).toEqual({
      status: "saved",
    });
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.close();
    await admin.close();
  });

  test("opening and replying on the web, a refused form and a forced failure leave the text nowhere but the author's pages", async () => {
    const web = await browser();
    const inbox = `/g/${GUILD}/modmail`;
    const page = await web.get(inbox);
    expect(page.status).toBe(200);
    const opened = await web.post(inbox, {
      op: "open",
      case: field(page.text, "open", "case"),
      topic: `Topic ${CANARY}`,
      body: `Body ${CANARY}`,
    });
    expect(opened.status).toBe(303);
    expect(opened.location).toBe(`${inbox}/1?notice=opened#status`);
    // The author's own page shows it: the one place it may appear.
    const thread = await web.get(`${inbox}/1`);
    expect(thread.text).toContain(`Body ${CANARY}`);
    const replied = await web.post(`${inbox}/1`, {
      op: "reply",
      id: field(thread.text, "reply", "id"),
      body: `Reply ${CANARY}`,
    });
    expect(replied.status).toBe(303);
    // A refused form comes back to its author with what they typed: their own response.
    const refused = await web.post(inbox, {
      op: "open",
      case: field((await web.get(inbox)).text, "open", "case"),
      topic: "   ",
      body: `Refused ${CANARY}`,
    });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain(`Refused ${CANARY}`);
    // The officers' ping, through the dispatcher.
    const caseId =
      (await db.orm.select({ id: t.modmailCases.id }).from(t.modmailCases))[0]?.id ?? "";
    expect(await dispatch(await asJob(pingKey(caseId)), async () => {})).toMatchObject({
      status: "delivered",
    });

    // A database error mid-open on the web: a 500 page, reported, saved as an issue report.
    await db.query(
      "CREATE FUNCTION fail_web_modmail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
    );
    await db.query(
      "CREATE TRIGGER fail_web_modmail_insert BEFORE INSERT ON modmail_messages FOR EACH ROW EXECUTE FUNCTION fail_web_modmail_insert()",
    );
    let failed: { status: number; text: string };
    try {
      failed = await web.post(inbox, {
        op: "open",
        case: field((await web.get(inbox)).text, "open", "case"),
        topic: `Second ${CANARY}`,
        body: `Failing ${CANARY}`,
      });
    } finally {
      await db.query("DROP TRIGGER fail_web_modmail_insert ON modmail_messages");
      await db.query("DROP FUNCTION fail_web_modmail_insert()");
    }
    await Promise.all(pending);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(CANARY);
    const saved = await db.query<{ body: string }>("SELECT body FROM issue_reports");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.map((row) => row.body).join("\n")).toContain("params: (left out of reports)");
    // Rolled back: still one case.
    expect(await db.orm.select({ id: t.modmailCases.id }).from(t.modmailCases)).toHaveLength(1);

    // The search: web logs, recent logs, Discord calls, and every table that could hold it.
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of [...lines, ...recent.recent(1000), ...discordCalls])
      expect(entry).not.toContain(CANARY);
    const rows = await db.query<{ row: string }>(
      `SELECT row_to_json(x)::text AS row FROM (SELECT * FROM issue_reports) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM delivery_attempts) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM jobs) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM audit) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM web_sessions) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_cases) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_messages) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_reads) x
       UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM modmail_settings) x`,
    );
    expect(rows.some(({ row }) => row.includes("delivered"))).toBe(true);
    const hex = Buffer.from(CANARY).toString("hex");
    const base64 = Buffer.from(CANARY).toString("base64");
    for (const { row } of rows) {
      expect(row).not.toContain(CANARY);
      expect(row).not.toContain(hex);
      expect(row).not.toContain(base64);
    }
    // The text is there, encrypted: the page decrypts it for its author.
    expect((await modmail.caseView(member, 1n))?.topic).toBe(`Topic ${CANARY}`);
  });
});
