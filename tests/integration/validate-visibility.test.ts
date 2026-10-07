/**
 * /config validate's visibility report (2.35.0, #46) against real PostgreSQL: Service.validate
 * reads TaruBot's view from the Discord port and the stored records from the database, and the
 * analysis uses all three records (retired roles, pending applications' review channels, and the
 * newest /setup overrides run's hidden-on-purpose set), plus the channels of decided applications
 * whose review redraw hasn't finished. A view that can't be read is null, never a failed
 * checklist; an unexpected error goes to the caller's reporter and shows as unknown, or, with no
 * reporter, propagates. The test is confined to its own schema, validate_visibility_it, so it
 * never touches persistence.test.ts's rows, and uses invented IDs throughout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import { loadVisibilityRecords } from "../../src/application/visibility-records.js";
import type { Configuration } from "../../src/config/env.js";
import type { ApiOverwrite } from "../../src/domain/permissions.js";
import type { Actor } from "../../src/domain/policy.js";
import type { VisibilityChannel, VisibilityGuild } from "../../src/domain/visibility.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { enqueue } from "../../src/jobs/queue.js";
import {
  audit,
  Database,
  ensureUser,
  orm,
  SESSION_OPTIONS,
} from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "validate_visibility_it";

const GUILD = "923400000000000100";
const OFFICER = "923400000000000200";
const APPLICANT = "923400000000000201";
const BOT = "923400000000000900";
const BOT_ROLE = "923400000000000600";
/** Access roles, and one retired role still held by a member. */
const ROLE = {
  member: "923400000000000301",
  guest: "923400000000000302",
  officer: "923400000000000303",
  leader: "923400000000000304",
  retired: "923400000000000305",
} as const;
/** Channels: the ledger, the kept review channel, a pending application's old review channel. */
const CHANNEL = {
  ledger: "923400000000000701",
  reviews: "923400000000000702",
  oldReviews: "923400000000000703",
  secret: "923400000000000704",
} as const;

/** A raw overwrite. */
const ow = (id: string, type: 0 | 1, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});
/** A cached channel. */
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
/** @everyone can read the ledger but not embed there; the old review channel likewise. */
const NO_EMBEDS = [ow(GUILD, 0, 0n, P.EmbedLinks)];

/**
 * TaruBot's view: its role holds the core seven, below the retired role; the ledger and the old
 * review channel deny @everyone Embed Links; the secret channel is obfuscated.
 */
const VIEW: VisibilityGuild = {
  guildId: GUILD,
  bot: { id: BOT, roles: [BOT_ROLE], botRoleId: BOT_ROLE },
  roles: [
    {
      id: GUILD,
      name: "@everyone",
      position: 0,
      permissions: String(P.ViewChannel | P.SendMessages | P.ReadMessageHistory),
      hoist: false,
      managed: false,
    },
    ...[ROLE.member, ROLE.guest, ROLE.officer, ROLE.leader].map((id, index) => ({
      id,
      name: `access ${index}`,
      position: index + 1,
      permissions: "0",
      hoist: false,
      managed: false,
    })),
    {
      id: BOT_ROLE,
      name: "TaruBot",
      position: 5,
      permissions: String(
        P.ManageRoles |
          P.ManageNicknames |
          P.ViewChannel |
          P.SendMessages |
          P.EmbedLinks |
          P.AttachFiles |
          P.ReadMessageHistory,
      ),
      hoist: false,
      managed: true,
    },
    {
      id: ROLE.retired,
      name: "retired",
      position: 6,
      permissions: "0",
      hoist: false,
      managed: false,
    },
  ],
  channels: [
    channel(CHANNEL.ledger, NO_EMBEDS),
    channel(CHANNEL.reviews, []),
    channel(CHANNEL.oldReviews, NO_EMBEDS),
    channel(CHANNEL.secret, [ow(GUILD, 0, 0n, P.ViewChannel)], { obfuscated: true }),
  ],
  heldRoles: [ROLE.member, ROLE.retired],
};

/** A Discord port whose resource checks pass; `visibility` is whatever the test supplies. */
function port(visibility?: DiscordPort["visibility"]): DiscordPort {
  const unused = async (): Promise<never> => {
    throw new Error("Not used by validate");
  };
  return {
    member: unused,
    members: unused,
    validateRole: async () => {},
    validateChannel: async () => {},
    roles: unused,
    layoutRoles: unused,
    nickname: unused,
    send: unused,
    editReview: unused,
    dm: unused,
    ...(visibility ? { visibility } : {}),
  };
}

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
/** validate() never reaches the Lodestone. */
const NO_LODESTONE: Lodestone = Object.create(null);
const ACTOR: Actor = {
  guildId: GUILD,
  userId: OFFICER,
  officer: true,
  manageRoles: true,
  serverManager: true,
};

describe.skipIf(!url)("/config validate reads TaruBot's view and the stored records", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  // Connection-string options replace the pool's own, so UTC and the statement timeout are restated.
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  const service = (discord: DiscordPort) => new Service(db, discord, NO_LODESTONE, CONFIG);

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE guilds, users CASCADE");
    await db.transaction(async (client) => {
      const q = orm(client);
      // No onboarding; the review channel is kept while applications are closed.
      await q.insert(t.guilds).values({
        id: GUILD,
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: ROLE.officer,
        leader_role_id: ROLE.leader,
        ledger_channel_id: CHANNEL.ledger,
        guest_application_channel_id: CHANNEL.reviews,
        guest_applications_enabled: false,
        effects_enabled: true,
      });
      await q
        .insert(t.retiredRoles)
        .values({ guild_id: GUILD, role_id: ROLE.retired, revision: 1n });
      await ensureUser(client, GUILD, APPLICANT, new Date("2026-09-01T00:00:00Z"));
      // An application still waits in the old review channel, which reviews are redrawn in.
      await q.insert(t.guestApplications).values({
        guild_id: GUILD,
        user_id: APPLICANT,
        joined_at: new Date("2026-09-01T00:00:00Z"),
        channel_id: CHANNEL.oldReviews,
      });
    });
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  test("the report uses retired roles, pending review channels and the recorded hidden set", async () => {
    await db.transaction(async (client) => {
      // An older run recorded nothing; the newest one recorded the secret channel.
      await audit(client, GUILD, OFFICER, "setup.overrides", GUILD, { hiddenOnPurpose: [] });
      await audit(client, GUILD, OFFICER, "setup.overrides", GUILD, {
        written: [],
        hiddenOnPurpose: [CHANNEL.secret],
      });
    });
    const requests: [string, boolean][] = [];
    const report = await service(
      port(async (guild, fresh) => {
        requests.push([guild, fresh]);
        return VIEW;
      }),
    ).validate(ACTOR);
    // /config validate asks for a fresh view (roles refetched), once.
    expect(requests).toEqual([[GUILD, true]]);
    const visibility = report.visibility;
    expect(visibility).not.toBeNull();
    // The retired role someone holds sits above TaruBot's role.
    expect(visibility?.roleOrder).toEqual({
      highest: BOT_ROLE,
      notBelow: [ROLE.retired],
      throughShared: [],
    });
    // Both posting channels lack Embed Links: the ledger, and the pending application's channel,
    // even though applications are closed and the kept review channel is elsewhere.
    expect(visibility?.missing.posting).toEqual([
      { id: CHANNEL.ledger, lacks: ["EmbedLinks"] },
      { id: CHANNEL.oldReviews, lacks: ["EmbedLinks"] },
    ]);
    // The obfuscated channel is hidden on purpose, as the newest run recorded.
    expect(visibility?.hiddenOnPurpose).toEqual([CHANNEL.secret]);
    expect(visibility?.missingCount).toBe(2);
  });

  test("without a recorded run, or with a malformed one, the obfuscated channel is missing", async () => {
    const validate = () => service(port(async () => VIEW)).validate(ACTOR);
    expect((await validate()).visibility?.missing.unreadable).toEqual([CHANNEL.secret]);
    await db.transaction(async (client) => {
      await audit(client, GUILD, OFFICER, "setup.overrides", GUILD, {
        hiddenOnPurpose: [CHANNEL.secret, "not an id"],
      });
    });
    expect((await validate()).visibility?.missing.unreadable).toEqual([CHANNEL.secret]);
    expect(await loadVisibilityRecords(db.orm, GUILD)).toEqual({
      retiredRoles: [ROLE.retired],
      pendingReviewChannels: [CHANNEL.oldReviews],
      recordedHidden: [],
    });
  });

  test("decided applications and other guilds' rows don't count", async () => {
    await db.query("UPDATE guest_applications SET state='denied'");
    expect(await loadVisibilityRecords(db.orm, "923400000000000999")).toEqual({
      retiredRoles: [],
      pendingReviewChannels: [],
      recordedHidden: [],
    });
    expect((await loadVisibilityRecords(db.orm, GUILD)).pendingReviewChannels).toEqual([]);
  });

  test("a decided application's unfinished review redraw keeps its channel a posting channel", async () => {
    // The decision moved it out of 'pending'; its guest.review redraw is queued on review:<id>.
    const [application] = await db.orm
      .update(t.guestApplications)
      .set({ state: "approved" })
      .returning({ id: t.guestApplications.id });
    if (!application) throw new Error("Missing application");
    const key = `review:${application.id}`;
    // Another kind on the same key, and the same key in another guild, never count. Both are
    // parked 'disabled', outside the active-key unique index, so they can sit beside the real one.
    await db.orm.insert(t.guilds).values({ id: "923400000000000999", effects_enabled: true });
    await db.orm.insert(t.jobs).values([
      { kind: "guest.dm", dedupe_key: key, guild_id: GUILD, status: "disabled", payload: {} },
      {
        kind: "guest.review",
        dedupe_key: key,
        guild_id: "923400000000000999",
        status: "disabled",
        payload: {},
      },
    ]);
    const channels = async () => (await loadVisibilityRecords(db.orm, GUILD)).pendingReviewChannels;
    expect(await channels()).toEqual([]);
    const job = await db.transaction(async (client) => {
      return enqueue(
        client,
        "guest.review",
        key,
        { applicationId: application.id },
        GUILD,
        APPLICANT,
      );
    });
    expect(await channels()).toEqual([CHANNEL.oldReviews]);
    // Parked (blocked or disabled) still counts: /setup overrides requeues it.
    for (const status of ["running", "blocked", "disabled"]) {
      await db.query("UPDATE jobs SET status=$1 WHERE id=$2", [status, job]);
      expect({ status, channels: await channels() }).toEqual({
        status,
        channels: [CHANNEL.oldReviews],
      });
    }
    // Once the redraw has finished, the channel is no longer one TaruBot posts in.
    await db.query("UPDATE jobs SET status='succeeded', completed_at=now() WHERE id=$1", [job]);
    expect(await channels()).toEqual([]);
    await db.query("UPDATE jobs SET status='failed', completed_at=now() WHERE id=$1", [job]);
    expect(await channels()).toEqual([]);
  });

  test("a view that can't be read is null, and the rest of the checklist still runs", async () => {
    for (const discord of [port(async () => null), port()]) {
      const reports: unknown[] = [];
      const report = await service(discord).validate(ACTOR, (error) => reports.push(error));
      expect(report.visibility).toBeNull();
      expect(report.capabilities.ledger_channel_id).toBe("available");
      // Nothing went wrong, so nothing is reported.
      expect(reports).toEqual([]);
    }
  });

  test("an unexpected error is reported and shown as unknown, or propagates without a reporter", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'cache')");
    // A role whose permissions aren't bits: the analysis itself throws.
    const malformed: VisibilityGuild = {
      ...VIEW,
      roles: VIEW.roles.map((role) =>
        role.id === BOT_ROLE ? { ...role, permissions: "not bits" } : role,
      ),
    };
    const cases: [string, DiscordPort][] = [
      [
        "the port rejects",
        port(async () => {
          throw bug;
        }),
      ],
      [
        "the port throws before returning a promise",
        port(() => {
          throw bug;
        }),
      ],
      ["the analysis throws", port(async () => malformed)],
    ];
    for (const [label, discord] of cases) {
      const reports: unknown[] = [];
      const report = await service(discord).validate(ACTOR, (error) => reports.push(error));
      expect({ label, visibility: report.visibility }).toEqual({ label, visibility: null });
      expect(report.capabilities.ledger_channel_id).toBe("available");
      expect({ label, reports: reports.length }).toEqual({ label, reports: 1 });
      if (label !== "the analysis throws") expect(reports[0]).toBe(bug);
      else expect(reports[0]).toBeInstanceOf(SyntaxError);
      // Without a reporter nothing is swallowed.
      const rejected = await service(discord)
        .validate(ACTOR)
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (label !== "the analysis throws")
        expect({ label, rejected }).toEqual({ label, rejected: bug });
      else expect(rejected).toBeInstanceOf(SyntaxError);
    }
  });
});
