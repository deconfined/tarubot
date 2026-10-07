/** Real PostgreSQL invariants/recovery with supplied or synthetic SQL and controlled external effects. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChannelType,
  InteractionResponseType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import type { AccessChannel } from "../../src/domain/channel-access.js";
import { channelAccessOverwrites } from "../../src/domain/channel-access.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { capabilityMetrics } from "../../src/application/metrics.js";
import { Service } from "../../src/application/service.js";
import { GuildEvents } from "../../src/application/guild-events.js";
import { IssueReports } from "../../src/application/issue-reports.js";
import { Suggestions, type SuggestionTarget } from "../../src/application/suggestions.js";
import { project } from "../../src/config/project.js";
import { suggestionReply } from "../../src/discord/presenters/utility.js";
import { SUGGESTION_HEADER } from "../../src/domain/suggestions.js";
import { classifyFailure } from "../../src/domain/failures.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { GitHubIssues, type IssueRef } from "../../src/infrastructure/github/issues.js";
import {
  RoleAdministration,
  type RoleProvisioner,
} from "../../src/application/role-administration.js";
import { rankAccess, desiredRankRole } from "../../src/application/rank-policy.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type {
  ApplicationRecord,
  DirectMessage,
  DiscordPort,
  MemberView,
  PostMessage,
} from "../../src/application/records.js";
import type { Configuration } from "../../src/config/env.js";
import type { Actor } from "../../src/domain/policy.js";
import { desiredAccess } from "../../src/domain/policy.js";
import { Failure, json } from "../../src/domain/values.js";
import { audit, Database, ensureUser, orm } from "../../src/infrastructure/postgres/database.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import type { Roster } from "../../src/infrastructure/lodestone/client.js";
import { readDump } from "../../src/import/dump.js";
import { importLegacy, mappings, type Snapshot } from "../../src/import/importer.js";
import {
  enqueue,
  layoutGuildRoles,
  Queue,
  reconcileUser,
  requeueParked,
  retryJob,
  scheduleJob,
  STALE_WAIT_MS,
  type Job,
  type QueueEvent,
} from "../../src/jobs/queue.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import { announceChangelog } from "../../src/jobs/queue.js";
import { notesSince } from "../../src/domain/changelog.js";
import { GuildAccess } from "../../src/application/guild-access.js";
import { NEW_GUILD_ROW } from "../../src/application/guild-defaults.js";
import { FakeGuildAccess } from "../fixtures/guild-access.js";
import { discordAccessFixture } from "../fixtures/discord-access.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { applicationKey } from "../../src/application/keys.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import applyCommand from "../../src/commands/guests/apply.command.js";
import applyComponent from "../../src/components/guest-application.component.js";
import reviewComponent from "../../src/components/guest-review.component.js";
import { guestApplicationModal } from "../../src/discord/guest-application.js";
import { ledgerPost } from "../../src/discord/presenters/ledger.js";
import { statusFits, statusPost } from "../../src/discord/presenters/officer.js";
import { recordStatus, statusNoticeKey } from "../../src/application/status-notices.js";
import { type StatusState, statusObservation } from "../../src/domain/status.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../src/domain/guest-application.js";
import {
  activateGuild,
  assertFreshRoster,
  GrandfatherPlanMismatch,
} from "../../src/application/activation.js";
import {
  lateJoiners,
  pendingDepartures,
  planGrandfathering,
} from "../../src/application/grandfathering.js";
import { grandfatherReport, reviewedPlan } from "../../src/domain/grandfathering.js";

const url = process.env.TEST_DATABASE_URL;
// These tests deliberately recreate a disposable schema; production connections are rejected below.
const sourceText = url
  ? await Bun.file(
      process.env.LEGACY_FIXTURE_PATH ?? new URL("../../tarubot_backup.sql", import.meta.url),
    ).text()
  : "";
describe.skipIf(!url)("PostgreSQL invariants and selected migration fixture", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const db = new Database(url);
  const members = new Map<string, MemberView>();
  const absent = new Set<string>();
  let proof = "";
  let sendBlocked = false;
  let nicknameBlocked = false;
  let nicknameRace = false;
  /** Posts and DMs the dispatcher handed over, so tests can check the data (not text) it passes. */
  const sent: { guild: string; channel: string; message: PostMessage; key: string }[] = [];
  const dms: { user: string; message: DirectMessage }[] = [];
  const discord: DiscordPort = {
    // Mutable observations and injected delivery failures model Discord races without credentials.
    async member(guild, user) {
      if (absent.has(user)) return null;
      const current = members.get(user);
      if (current) return current;
      const member = {
        id: user,
        guildId: guild,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        nickname: "Before",
        roles: [],
        bot: false,
      };
      members.set(user, member);
      return member;
    },
    async members() {
      return [...members.values()];
    },
    async validateRole() {},
    async validateChannel() {},
    /** Simulate role metadata independently from membership deltas in persistence scenarios. */
    async layoutRoles(_guild, priority, guard) {
      await guard();
      return { order: [...priority], hoisted: [...priority] };
    },
    async roles(_guild, user, add, remove) {
      const member = members.get(user);
      if (member)
        member.roles = [
          ...new Set([...member.roles.filter((role) => !remove.includes(role)), ...add]),
        ];
    },
    async nickname(_guild, user, value, expected) {
      if (nicknameBlocked) throw new Failure("blocked", "Test nickname hierarchy blocked.");
      const member = members.get(user);
      if (member && nicknameRace) {
        nicknameRace = false;
        member.nickname = "Race override";
      }
      if (!member || member.nickname !== expected) return false;
      member.nickname = value;
      return true;
    },
    async send(guild, channel, message, key) {
      if (sendBlocked) throw new Failure("blocked", "Test channel delivery blocked.");
      sent.push({ guild, channel, message, key });
      return "123456789";
    },
    async editReview(_application: ApplicationRecord) {
      return "123456789";
    },
    async dm(user, message) {
      dms.push({ user, message });
    },
  };
  class FakeLodestone extends Lodestone {
    // Explicit observation timestamps advance departure evidence without waiting a real minute.
    rosterValue: Roster | null = null;
    rosterFailure = false;
    /** A specific acquisition failure, such as Lodestone throttling (2.17.0). */
    rosterError: Failure | null = null;
    /** Setup validates public FC identity without making a live request in persistence tests. */
    override async company(fcId: string) {
      return {
        id: fcId,
        name: "Setup FC",
        tag: "TEST",
        world: "Diabolos",
        dc: "Crystal",
        count: 0,
      };
    }
    /** Every profile read, in order (#86: only verification and lookups read profiles). */
    profileReads: string[] = [];
    override async profile(characterId: string) {
      this.profileReads.push(characterId);
      return {
        id: characterId,
        name: "Verified Character",
        world: "Diabolos",
        dc: "Crystal",
        fcId: null,
        biography: proof,
      };
    }
    override async roster(): Promise<Roster> {
      if (this.rosterError) throw this.rosterError;
      if (this.rosterFailure) throw new Failure("incomplete", "Test incomplete observation");
      if (!this.rosterValue) throw new Error("Configure roster fixture");
      return this.rosterValue;
    }
  }
  const source = readDump(sourceText);
  const legacyGuild = source.guilds[0];
  if (!legacyGuild) throw new Error("Missing fixture guild");
  const guild = legacyGuild.guild_id;
  const fc = legacyGuild.fc;
  if (!fc) throw new Error("Missing fixture FC");
  const historical = source.characters.find((row) => row.owner && row.fc === fc);
  if (!historical?.owner) throw new Error("Missing owned FC member fixture");
  const historicalOwner = historical.owner;
  const snapshot: Snapshot = {
    // Synthetic humans test grandfathering; this artifact is never used for production cutover.
    capturedAt: "2026-09-21T00:00:00Z",
    guilds: [
      {
        id: guild,
        complete: true,
        expectedCount: 2,
        enumeratedCount: 2,
        members: [
          {
            id: "987654321012345678",
            roles: [legacyGuild.guest_role_id ?? "1"],
            nickname: "Preserved Nickname",
            joinedAt: "2020-01-01T00:00:00Z",
          },
          {
            id: historicalOwner,
            roles: [legacyGuild.member_role_id ?? "2"],
            nickname: "Imported nickname",
            joinedAt: "2020-01-01T00:00:00Z",
          },
        ],
      },
    ],
  };
  const config: Configuration = {
    DATABASE_URL: url,
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
  const lodestone = new FakeLodestone();
  const service = new Service(db, discord, lodestone, config);
  /** Existing decision scenarios now submit the same bounded form contract as Discord visitors. */
  async function applicationInput(applicant: Actor) {
    const member = await discord.member(applicant.guildId, applicant.userId);
    if (!member) throw new Error("Missing application fixture member");
    return {
      joinedAt: new Date(member.joinedAt),
      introduction: "I enjoy playing games with friends.",
      interest: "A friend invited me to meet your community.",
    };
  }
  const sync = new Synchronization(service);
  const accessPort = new FakeGuildAccess();
  const access = new GuildAccess(service, accessPort);
  const actor: Actor = {
    guildId: guild,
    userId: "999999999999999990",
    officer: true,
    manageRoles: true,
  };
  beforeAll(async () => {
    // A fresh schema verifies migration installation as well as import publication.
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await db.migrate();
    await db.schema();
    await importLegacy(db, source, snapshot, mappings(source));
    // Imports keep the legacy review channel with applications switched off (owner decisions
    // 2026-09-23 and 2026-09-24), so the form scenarios below switch them on explicitly. A dedicated
    // test covers the closed state.
    await db.orm
      .update(t.guilds)
      .set({ guest_applications_enabled: true })
      .where(eq(t.guilds.id, guild));
    for (const member of snapshot.guilds[0]?.members ?? [])
      members.set(member.id, {
        ...member,
        guildId: guild,
        joinedAt: new Date(member.joinedAt),
        bot: false,
      });
  }, 30000);
  afterAll(async () => {
    await db.close();
  });
  test("selected dump reconciles counts, opening states and exact configured balance", async () => {
    const row = (
      await db.query<{
        fc: bigint;
        characters: bigint;
        users: bigint;
        links: bigint;
        accounts: bigint;
        entries: bigint;
        unknown: bigint;
      }>(
        "SELECT (SELECT count(*) FROM free_companies) AS fc,(SELECT count(*) FROM characters) AS characters,(SELECT count(*) FROM users) AS users,(SELECT count(*) FROM links) AS links,(SELECT count(*) FROM ledger_accounts) AS accounts,(SELECT count(*) FROM ledger_entries) AS entries,(SELECT count(*) FROM ledger_accounts WHERE balance IS NULL) AS unknown",
      )
    )[0];
    expect(row).toEqual({
      fc: 40n,
      characters: 4251n,
      users: 242n,
      links: 161n,
      accounts: 40n,
      entries: 36n,
      unknown: 4n,
    });
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(349279945n);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM guild_users WHERE nickname_enabled OR primary_character_id IS NOT NULL",
        )
      )[0]?.count,
    ).toBe(0n);
    expect(
      (await db.query<{ provenance: string }>("SELECT provenance FROM guest_grants"))[0]
        ?.provenance,
    ).toBe("imported_guest");
    // Launch defaults: the imported layout stays untouched and one grandfathering run is owed.
    const [launch] = await db.orm
      .select({
        layout: t.guilds.role_layout_enabled,
        grandfather: t.guilds.guest_grandfather,
        grandfatheredAt: t.guilds.guest_grandfathered_at,
      })
      .from(t.guilds)
      .where(eq(t.guilds.id, guild));
    expect(launch).toEqual({ layout: false, grandfather: "pending", grandfatheredAt: null });
    // Until activation, every queued Discord change of the imported guild is held.
    expect((await service.validate(actor)).effectsMode).toBe("awaiting_activation");
    // Applications were imported closed (beforeAll reopens them); the audit and the stored
    // report keep the legacy review channel for a later explicit /config choice.
    const closed = {
      state: "closed",
      legacyChannelId: legacyGuild.guest_application_channel_id,
    };
    const [imported] = await db.orm
      .select({ details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.guild_id, guild), eq(t.auditEvents.action, "migration.import")));
    expect(imported?.details).toMatchObject({
      guestApplications: closed,
      roleLayout: false,
      guestGrandfather: "pending",
    });
    const [stored] = await db.orm
      .select({ report: t.imports.report })
      .from(t.imports)
      .where(eq(t.imports.fingerprint, source.fingerprint));
    expect(stored?.report).toMatchObject({
      guildSettings: [
        {
          guildId: guild,
          ledgerChannelId: legacyGuild.ledger_channel_id,
          officerNotificationsChannelId: legacyGuild.officer_notifications_channel_id,
          guestApplications: closed,
        },
      ],
      bootstrap: {
        guestApplications: "closed",
        roleLayout: "disabled",
        guestGrandfathering: "pending_first_activation",
      },
    });
  });
  test("competing withdrawals retain funds and repeated interactions mutate once", async () => {
    const outcomes = await Promise.allSettled([
      service.ledger(actor, "withdraw", 349279945, "Concurrency test", randomUUID()),
      service.ledger(actor, "withdraw", 349279945, "Concurrency test", randomUUID()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const key = randomUUID();
    await Promise.all([
      service.ledger(actor, "deposit", 17, "Retry test", key),
      service.ledger(actor, "deposit", 17, "Retry test", key),
    ]);
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(17n);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM ledger_entries WHERE idempotency_key=$1",
          [key],
        )
      )[0]?.count,
    ).toBe(1n);
    await expect(
      db.query("UPDATE ledger_entries SET note='changed' WHERE idempotency_key=$1", [key]),
    ).rejects.toThrow("immutable");
  });
  test("only one competing owner succeeds and wrong-owner removal fails", async () => {
    const identity = {
      id: "77777777",
      name: "Concurrent Character",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const results = await Promise.allSettled([
      service.assign(actor, "90001", identity, "Assignment A"),
      service.assign(actor, "90002", identity, "Assignment B"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
          [guild, identity.id],
        )
      )[0]?.count,
    ).toBe(1n);
    await expect(service.unclaim(actor, "90003", identity.id, "Wrong owner")).rejects.toMatchObject(
      { code: "not_found", detail: { kind: "resource", resource: "link", id: identity.id } },
    );
  });
  test("hash-only verification survives a new service instance and concurrent completion", async () => {
    const self = { ...actor, userId: "90004", officer: false, manageRoles: false };
    const identity = {
      id: "77777778",
      name: "Verified Character",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const claim = z.object({ token: z.string() }).parse(await service.claim(self, identity));
    proof = claim.token;
    const persisted = (
      await db.query<{ token_hash: string }>(
        "SELECT token_hash FROM challenges WHERE character_id=$1",
        [identity.id],
      )
    )[0];
    expect(persisted?.token_hash).not.toBe(proof);
    const restarted = new Service(db, discord, new FakeLodestone(), config);
    await Promise.all([restarted.verify(self, identity.id), service.verify(self, identity.id)]);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
          [guild, identity.id],
        )
      )[0]?.count,
    ).toBe(1n);
    await service.unclaim(self, self.userId, identity.id);
    expect(
      (
        await db.query<{ active: boolean }>("SELECT active FROM links WHERE character_id=$1", [
          identity.id,
        ])
      )[0]?.active,
    ).toBe(false);
  });
  test("concurrent applications and opposing decisions have one durable outcome", async () => {
    const applicant = { ...actor, userId: "90005", officer: false, manageRoles: false };
    const input = await applicationInput(applicant);
    const applications = await Promise.all([
      service.apply(applicant, input),
      service.apply(applicant, input),
    ]);
    const first = z.object({ id: z.string() }).parse(applications[0]);
    expect(z.object({ id: z.string() }).parse(applications[1]).id).toBe(first.id);
    await Promise.all([
      service.decide(actor, first.id, true),
      service.decide(actor, first.id, false),
    ]);
    const row = (
      await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
        first.id,
      ])
    )[0];
    expect(row?.state === "approved" || row?.state === "denied").toBe(true);
    await service.guestAction(actor, applicant.userId, true, "Revoked", randomUUID());
    expect(
      (
        await db.query<{ revoked: boolean }>(
          "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id=$2",
          [guild, applicant.userId],
        )
      )[0]?.revoked,
    ).toBe(true);
  });
  test("repeat import preserves subsequent ledger and revocation decisions", async () => {
    const before = (
      await db.query<{ balance: bigint }>(
        "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
        [guild, fc],
      )
    )[0]?.balance;
    const result = z
      .object({ status: z.string() })
      .parse(await importLegacy(db, source, snapshot, mappings(source)));
    expect(result.status).toBe("already_imported");
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(before);
    expect(
      (
        await db.query<{ revoked: boolean }>(
          "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id='90005'",
          [guild],
        )
      )[0]?.revoked,
    ).toBe(true);
  });
  /** Claim a particular test job so unrelated queued fixture work cannot affect the scenario. */
  async function leased(jobId: string): Promise<Job> {
    const job = (
      await db.query<Job>(
        "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE id=$1 RETURNING *",
        [jobId, randomUUID()],
      )
    )[0];
    if (!job) throw new Error("Missing test job");
    return job;
  }
  test("imported member protection, two absences, reappearance, and failed publication", async () => {
    const publish = async (appears: boolean, instant: Date) => {
      lodestone.rosterValue = {
        company: {
          id: fc,
          name: "Woven Souls",
          tag: "Souls",
          world: "Diabolos",
          dc: "Crystal",
          count: appears ? 1 : 0,
        },
        members: appears
          ? [
              {
                id: historical.char_id,
                name: `${historical.forename} ${historical.surname}`,
                world: historical.world,
                dc: "Crystal",
                fcId: fc,
              },
            ]
          : [],
        startedAt: new Date(instant.getTime() - 1000),
        observedAt: instant,
        pages: 1,
      };
      await db.query(
        "UPDATE free_companies SET last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
        [fc],
      );
      const key = await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc });
      const job = await leased(key);
      try {
        return await sync.roster(job, async () => {});
      } finally {
        await db.query("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=$1", [key]);
      }
    };
    const initial = Date.now();
    await publish(false, new Date(initial));
    expect(
      (
        await db.query<{ state: string }>(
          "SELECT state FROM membership WHERE guild_id=$1 AND character_id=$2 AND fc_id=$3",
          [guild, historical.char_id, fc],
        )
      )[0]?.state,
    ).toBe("missing");
    const currentGuild = await service.guild(actor);
    const member = await discord.member(guild, historicalOwner);
    if (!member) throw new Error("Missing member");
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
    await expect(
      service.ledger(
        { ...actor, userId: historicalOwner, officer: false },
        "deposit",
        1,
        "Needs confirmed roster evidence",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "forbidden", detail: { scope: "membership" } });
    await publish(false, new Date(initial + 61000));
    expect(desiredAccess(await sync.facts(currentGuild, member))).toEqual({
      member: false,
      guest: true,
    });
    await publish(true, new Date(initial + 122000));
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
    const before = (
      await db.query<{ last_successful_roster_at: Date }>(
        "SELECT last_successful_roster_at FROM free_companies WHERE id=$1",
        [fc],
      )
    )[0]?.last_successful_roster_at;
    lodestone.rosterFailure = true;
    await expect(publish(false, new Date(initial + 183000))).rejects.toThrow("incomplete");
    lodestone.rosterFailure = false;
    // Throttling is a wait, not degradation (2.17.0): the FC records it for /config validate, but
    // the queued degraded notice (its own key since #29) is not re-enqueued, which would bump its
    // generation.
    const notice = async () =>
      (
        await db.query<{ generation: number }>(
          "SELECT generation FROM jobs WHERE dedupe_key=$1 AND status='queued'",
          [`officer:${guild}:degraded:${fc}`],
        )
      )[0]?.generation;
    const noticed = await notice();
    expect(noticed).toBeNumber();
    lodestone.rosterError = new Failure("rate_limited", "Lodestone rate limited.", 30);
    await expect(publish(false, new Date(initial + 184000))).rejects.toMatchObject({
      code: "rate_limited",
    });
    lodestone.rosterError = null;
    expect(await notice()).toBe(noticed);
    expect(
      (
        await db.query<{ last_error: string | null }>(
          "SELECT last_error FROM free_companies WHERE id=$1",
          [fc],
        )
      )[0]?.last_error,
    ).toBe("rate_limited");
    expect(
      (
        await db.query<{ last_successful_roster_at: Date }>(
          "SELECT last_successful_roster_at FROM free_companies WHERE id=$1",
          [fc],
        )
      )[0]?.last_successful_roster_at,
    ).toEqual(before);
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
  });
  test("imported owners without a legacy-FC character are registered Guests with onboarding disabled", async () => {
    // Relies on the accepted rosters the previous test published, which evaluated every imported
    // link in the imported guild; that guild never ran /setup, so onboarding stays disabled.
    const ownership = mappings(source).ownership;
    const humans = new Set(snapshot.guilds[0]?.members.map((member) => member.id));
    const owned = new Map<string, (typeof source.characters)[number][]>();
    for (const row of source.characters)
      if (row.owner) owned.set(row.owner, [...(owned.get(row.owner) ?? []), row]);
    const owner = [...owned].find(
      ([user, rows]) =>
        !humans.has(user) &&
        rows.every((row) => row.fc !== fc) &&
        rows.some((row) => (ownership[row.char_id] ?? []).includes(guild)),
    )?.[0];
    if (!owner) throw new Error("Missing imported owner outside the legacy FC");
    const currentGuild = await service.guild(actor);
    expect(currentGuild.access_policy_enabled).toBe(false);
    const member = await discord.member(guild, owner);
    if (!member) throw new Error("Missing imported owner");
    const facts = await sync.facts(currentGuild, member);
    // Imported links are trusted registration; no grant, history or held role explains this Guest.
    expect(facts).toMatchObject({
      membership: "ineligible",
      verified: true,
      fresh: true,
      former: false,
      grant: false,
      revoked: false,
      hasGuest: false,
    });
    expect(desiredAccess(facts)).toEqual({ member: false, guest: true });
  });
  test("a grandfathering plan on the imported fixture is read-only and stable", async () => {
    // Runs on the accepted rosters published above (the fixture's baseline reappeared, so no
    // departure is pending) and never activates, so the shared fixture guild stays pending.
    const ownership = mappings(source).ownership;
    const humans = new Set(snapshot.guilds[0]?.members.map((member) => member.id));
    const outsider = source.characters.find(
      (row) =>
        row.owner &&
        !humans.has(row.owner) &&
        source.characters.every((other) => other.owner !== row.owner || other.fc !== fc) &&
        (ownership[row.char_id] ?? []).includes(guild),
    )?.owner;
    if (!outsider) throw new Error("Missing imported owner outside the legacy FC");
    const currentGuild = await service.guild(actor);
    expect(currentGuild.guest_grandfather).toBe("pending");
    const views: MemberView[] = [
      ...(snapshot.guilds[0]?.members ?? []).map((member) => ({
        ...member,
        guildId: guild,
        joinedAt: new Date(member.joinedAt),
        bot: false,
      })),
      // A registered owner present in Discord but outside the FC, and a bot.
      {
        id: outsider,
        guildId: guild,
        joinedAt: new Date("2021-01-01T00:00:00Z"),
        nickname: null,
        roles: [],
        bot: false,
      },
      {
        id: "999999999999999901",
        guildId: guild,
        joinedAt: new Date("2021-01-01T00:00:00Z"),
        nickname: null,
        roles: [],
        bot: true,
      },
    ];
    const counts = async () =>
      (
        await db.query<{ grants: bigint; audits: bigint; users: bigint }>(
          "SELECT (SELECT count(*) FROM guest_grants) AS grants,(SELECT count(*) FROM audit) AS audits,(SELECT count(*) FROM guild_users) AS users",
        )
      )[0];
    const before = await counts();
    expect(await pendingDepartures(db.orm, currentGuild)).toEqual({ count: 0, sample: [] });
    const first = await planGrandfathering(db.orm, currentGuild, views, 21600, new Date());
    // A later enumeration of the same members, in another order, with changed nicknames and the
    // planned outsider now holding Guest, reproduces the checksum (C8).
    const second = await planGrandfathering(
      db.orm,
      currentGuild,
      views
        .map((view) => ({
          ...view,
          nickname: "Renamed",
          roles:
            view.id === outsider ? [...view.roles, currentGuild.guest_role_id ?? ""] : view.roles,
        }))
        .reverse(),
      21600,
      new Date(Date.now() + 60_000),
    );
    expect(second.checksum).toBe(first.checksum);
    expect(second.candidates.find((row) => row.userId === outsider)?.heldGuest).toBe(true);
    expect(first).toMatchObject({
      importFingerprint: source.fingerprint,
      humans: 3,
      bots: 1,
      grants: [outsider],
    });
    expect(first.rosterSnapshotId).toEqual(expect.any(String));
    const report = grandfatherReport({ state: "pending", plan: first, completedAt: null });
    expect(report).toMatchObject({
      memberEligible: 1,
      planned: { count: 1, sample: [outsider] },
      plannedDetail: { registeredVisitors: { count: 1, sample: [outsider] } },
      skipped: {
        existingGrant: {
          count: 1,
          sample: ["987654321012345678"],
          byProvenance: { imported_guest: 1 },
        },
        revoked: { count: 0 },
      },
    });
    expect(await counts()).toEqual(before);
  });
  test("local loss overrides uncertain new links; imported nickname opt-in respects manual overrides", async () => {
    const identity = {
      id: "77777779",
      name: "Nickname Target",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(actor, historicalOwner, identity, "Additional pending character");
    await service.unclaim(
      actor,
      historicalOwner,
      historical.char_id,
      "Local unlink while another character is uncertain",
    );
    const guildRecord = await service.guild(actor);
    const member = await discord.member(guild, historicalOwner);
    if (!member) throw new Error("Missing member");
    expect(desiredAccess(await sync.facts(guildRecord, member))).toEqual({
      member: false,
      guest: true,
    });
    await db.query("UPDATE guilds SET effects_enabled=true WHERE id=$1", [guild]);
    const self = { ...actor, userId: historicalOwner, officer: false };
    await service.preferences(self, identity.id, true);
    const reconcile = async () => {
      const key = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${guild}:${historicalOwner}`,
        {},
        guild,
        historicalOwner,
      );
      const job = await leased(key);
      await sync.user(job, async () => {});
      await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [key]);
    };
    await reconcile();
    expect(member.nickname).toBe("Nickname Target");
    await service.preferences(self, null, false);
    await reconcile();
    expect(member.nickname).toBe("Imported nickname");
    await service.preferences(self, null, true);
    await reconcile();
    member.nickname = "Manual override";
    await reconcile();
    expect(
      (
        await db.query<{ nickname_suspended: boolean }>(
          "SELECT nickname_suspended FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, historicalOwner],
        )
      )[0]?.nickname_suspended,
    ).toBe(true);
    await service.preferences(self, null, false);
    await reconcile();
    expect(member.nickname).toBe("Manual override");
  });
  test("unknown account initializes once, including a known zero opening", async () => {
    const unknown = source.companies.find((row) => row.gil_balance === null);
    if (!unknown) throw new Error("Missing unknown account");
    await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, unknown.fc_id]);
    try {
      const results = await Promise.allSettled([
        service.ledger(actor, "initialize", "0", "Known opening", randomUUID()),
        service.ledger(actor, "initialize", "0", "Competing opening", randomUUID()),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await db.query<{ count: bigint }>(
            "SELECT count(*) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.guild_id=$1 AND a.fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.count,
      ).toBe(1n);
      expect(
        (
          await db.query<{ balance: bigint | null }>(
            "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.balance,
      ).toBe(0n);
    } finally {
      await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, fc]);
    }
  });
  test("notification failure preserves one entry and an independent retry delivers it", async () => {
    await db.query("UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify'");
    const key = randomUUID();
    const result = z
      .object({ entry: z.object({ id: z.string() }) })
      .parse(await service.ledger(actor, "deposit", 5, "Delivery recovery", key));
    const queued = (
      await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
        [result.entry.id],
      )
    )[0];
    if (!queued) throw new Error("Missing notification");
    const queue = new Queue(db, dispatcher(service, sync, access), () => {});
    sendBlocked = true;
    await queue.perform(await leased(queued.id));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("blocked");
    sendBlocked = false;
    await queue.perform(await leased(queued.id));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("succeeded");
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM ledger_entries WHERE idempotency_key=$1",
          [key],
        )
      )[0]?.count,
    ).toBe(1n);
    // The dispatcher hands over the stored entry, not text, under the unchanged nonce key.
    expect(sent.at(-1)).toMatchObject({
      guild,
      key: `ledger:${result.entry.id}`,
      message: {
        kind: "ledger",
        view: { entry: { id: result.entry.id, operation: "deposit" }, correctionSequence: null },
      },
    });
  });
  test("a correction's post names the corrected entry by its number from one read", async () => {
    await db.query("UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify'");
    const deposit = await service.ledger(actor, "deposit", 7, "Corrected below", randomUUID());
    if (deposit.status !== "recorded") throw new Error("Missing deposit");
    const correction = await service.ledger(
      actor,
      "adjust",
      (deposit.entry.balance - 2n).toString(),
      "The deposit was 5 gil",
      randomUUID(),
      { id: deposit.entry.id },
    );
    if (correction.status !== "recorded") throw new Error("Missing correction");
    // Posts go out in entry order, so the deposit's post is delivered first.
    await db.query(
      "UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
      [deposit.entry.id],
    );
    const queued = (
      await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
        [correction.entry.id],
      )
    )[0];
    if (!queued) throw new Error("Missing correction notification");
    await new Queue(db, dispatcher(service, sync, access), () => {}).perform(
      await leased(queued.id),
    );
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("succeeded");
    const post = sent.at(-1);
    expect(post).toMatchObject({
      key: `ledger:${correction.entry.id}`,
      message: {
        kind: "ledger",
        view: {
          entry: { id: correction.entry.id, operation: "adjust", delta: -2n },
          correctionSequence: deposit.entry.sequence,
        },
      },
    });
    // The gateway renders that view as the approved correction post (ledger#32).
    if (post?.message.kind !== "ledger") throw new Error("Expected a ledger post");
    expect(ledgerPost(post.message.view).options.embeds[0]?.fields).toContainEqual({
      name: "Corrects",
      value: `#${deposit.entry.sequence}`,
      inline: true,
    });
  });
  test("PostgreSQL bigint maximum round-trips and overflow is rejected atomically", async () => {
    const unknown = source.companies.filter((row) => row.gil_balance === null)[1];
    if (!unknown) throw new Error("Missing second unknown account");
    await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, unknown.fc_id]);
    try {
      await service.ledger(
        actor,
        "initialize",
        "9223372036854775807",
        "Exact bigint boundary",
        randomUUID(),
      );
      // Passing the storable maximum is an input failure on the amount, not a funds refusal.
      await expect(
        service.ledger(actor, "deposit", 1, "Overflow must fail", randomUUID()),
      ).rejects.toMatchObject({ code: "input", detail: { kind: "option", option: "amount" } });
      expect(
        (
          await db.query<{ balance: bigint }>(
            "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.balance,
      ).toBe(9223372036854775807n);
    } finally {
      await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, fc]);
    }
  });
  test("accounts, eligibility and private reads remain independent across guilds", async () => {
    const owner = "90010";
    await service.assign(
      actor,
      owner,
      { id: historical.char_id, name: "Guild Scoped", world: "Diabolos", dc: "Crystal", fcId: fc },
      "Relink for guild-scoping test",
    );
    const original = await service.guild(actor);
    expect(await service.memberEligible(db.pool, original, owner)).toBe(true);
    const otherGuild = "777777777777777777";
    await db.query("INSERT INTO guilds(id,fc_id,ledger_channel_id) VALUES($1,$2,'777888999')", [
      otherGuild,
      fc,
    ]);
    await db.query("INSERT INTO ledger_accounts(guild_id,fc_id) VALUES($1,$2)", [otherGuild, fc]);
    await service.ledger(
      { ...actor, guildId: otherGuild },
      "initialize",
      "42",
      "Second guild opening",
      randomUUID(),
    );
    const visitor: Actor = {
      ...actor,
      guildId: otherGuild,
      userId: owner,
      officer: false,
      manageRoles: false,
    };
    const second = await service.guild(visitor);
    expect(await service.memberEligible(db.pool, second, owner)).toBe(false);
    await expect(service.ledgerRead(visitor, null, null, false)).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "membership" },
    });
    expect(await service.characters(visitor, owner)).toEqual({ characters: [] });
    const balance = z
      .object({ account: z.object({ balance: z.bigint() }) })
      .parse(await service.ledgerRead({ ...visitor, officer: true }, null, null, false));
    expect(balance.account.balance).toBe(42n);
  });
  test("obsolete join context cancels pending review and forged message identity is rejected", async () => {
    const applicant = { ...actor, userId: "90006", officer: false };
    const application = z
      .object({ id: z.string() })
      .parse(await service.apply(applicant, await applicationInput(applicant)));
    await db.query("UPDATE guest_applications SET message_id='112233' WHERE id=$1", [
      application.id,
    ]);
    await expect(service.decide(actor, application.id, true, null, "445566")).rejects.toMatchObject(
      { code: "stale", detail: { kind: "stale", what: "review" } },
    );
    absent.add(applicant.userId);
    await service.decide(actor, application.id, true);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          application.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
  });
  test("rejoining replaces an obsolete pending application", async () => {
    const actorInGuild = { ...actor, userId: "90007", officer: false };
    const opened = await applicationInput(actorInGuild);
    const old = z.object({ id: z.string() }).parse(await service.apply(actorInGuild, opened));
    const member = members.get(actorInGuild.userId);
    if (!member) throw new Error("Missing rejoining member");
    member.joinedAt = new Date("2026-09-21T12:00:00Z");
    await expect(service.apply(actorInGuild, opened)).rejects.toMatchObject({ code: "stale" });
    const current = z
      .object({ id: z.string() })
      .parse(await service.apply(actorInGuild, await applicationInput(actorInGuild)));
    expect(current.id).not.toBe(old.id);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          old.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
  });
  test("an import publication failure rolls all staged application rows back", async () => {
    // Fail the final publication statement, after identities/links/accounts have already been staged.
    const copy = structuredClone(source);
    copy.fingerprint = "rejected-transaction-test";
    const first = copy.guilds[0];
    if (!first) throw new Error("Missing guild");
    first.guild_id = "888888888888888888";
    const empty: Snapshot = {
      capturedAt: new Date().toISOString(),
      guilds: [
        { id: first.guild_id, complete: true, expectedCount: 0, enumeratedCount: 0, members: [] },
      ],
    };
    await db.query(
      "CREATE FUNCTION reject_test_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected import publication failure'; END $$",
    );
    await db.query(
      "CREATE TRIGGER reject_test_import BEFORE INSERT ON imports FOR EACH ROW EXECUTE FUNCTION reject_test_import()",
    );
    try {
      // Drizzle retains the PostgreSQL failure as cause; assert the actual injected trigger error.
      await expect(importLegacy(db, copy, empty, mappings(copy))).rejects.toMatchObject({
        cause: { code: "P0001", message: "injected import publication failure" },
      });
      expect(await db.query("SELECT id FROM guilds WHERE id=$1", [first.guild_id])).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER reject_test_import ON imports");
      await db.query("DROP FUNCTION reject_test_import()");
    }
  });
  test("imported guilds keep notification channels but open no guest applications", async () => {
    // A copy with no FC, characters or source users cannot disturb shared counts, metrics or
    // roster dedupe. 777777777777777777 is already another test's second guild.
    const closedGuild = "555555555555555555";
    const copy = structuredClone(source);
    copy.fingerprint = "closed-applications-test";
    copy.companies = [];
    copy.characters = [];
    copy.users = [];
    const first = copy.guilds[0];
    if (!first?.guest_role_id || !first.guest_application_channel_id)
      throw new Error("The fixture guild needs a guest role and a legacy review channel");
    copy.guilds = [{ ...first, guild_id: closedGuild, fc: null }];
    const visitor = { id: "555555555555555001", joinedAt: "2026-01-01T00:00:00Z" };
    members.set(visitor.id, {
      id: visitor.id,
      guildId: closedGuild,
      joinedAt: new Date(visitor.joinedAt),
      nickname: null,
      roles: [],
      bot: false,
    });
    const capture: Snapshot = {
      capturedAt: new Date().toISOString(),
      guilds: [
        {
          id: closedGuild,
          complete: true,
          expectedCount: 1,
          enumeratedCount: 1,
          members: [{ id: visitor.id, roles: [], nickname: null, joinedAt: visitor.joinedAt }],
        },
      ],
    };
    const closed = { state: "closed", legacyChannelId: first.guest_application_channel_id };
    expect(await importLegacy(db, copy, capture, mappings(copy))).toMatchObject({
      status: "imported",
      report: { guildSettings: [{ guildId: closedGuild, guestApplications: closed }] },
    });
    // Ledger, roster and review channels keep their legacy destinations; applications start off.
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, closedGuild));
    expect(row).toMatchObject({
      guest_application_channel_id: first.guest_application_channel_id,
      guest_applications_enabled: false,
      ledger_channel_id: first.ledger_channel_id,
      officer_notifications_channel_id: first.officer_notifications_channel_id,
      effects_enabled: false,
      role_layout_enabled: false,
      guest_grandfather: "pending",
    });
    const [imported] = await db.orm
      .select({ details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(
        and(eq(t.auditEvents.guild_id, closedGuild), eq(t.auditEvents.action, "migration.import")),
      );
    expect(imported?.details).toMatchObject({ guestApplications: closed });
    // The real /apply module refuses before the form opens, using one read of this database.
    const interactions = interactionFixture();
    interactions.member.guildId = closedGuild;
    interactions.member.userId = visitor.id;
    const router = new InteractionRouter(
      {
        client: interactions.client,
        services: new Services().provide(applicationKey, service),
        allowsGuild: (id) => id === closedGuild,
        isStopping: () => false,
        report: () => {},
        resolveActor: async () => {
          throw new Error("The pre-form check must not fetch an actor");
        },
      },
      new Map([[applyCommand.name, applyCommand]]),
      new Map(),
    );
    try {
      await router.handle(interactions.slash());
      // The approved closed card (guests#21): an expected state, so no Code · Ref footer.
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "",
          embeds: [
            { title: "Guest applications are closed", description: GUEST_APPLICATIONS_CLOSED },
          ],
          flags: MessageFlags.Ephemeral,
        },
      });
      expect(interactions.requests.at(-1)?.body).not.toMatchObject({
        data: { embeds: [{ footer: expect.anything() }] },
      });
      // A form opened earlier, or a forged submission, is refused again at submission.
      const applicant: Actor = {
        guildId: closedGuild,
        userId: visitor.id,
        officer: false,
        manageRoles: false,
      };
      await expect(
        service.apply(applicant, await applicationInput(applicant)),
      ).rejects.toMatchObject({ code: "setup", message: GUEST_APPLICATIONS_CLOSED });
      const applications = () =>
        db.orm
          .select()
          .from(t.guestApplications)
          .where(eq(t.guestApplications.guild_id, closedGuild));
      expect(await applications()).toHaveLength(0);
      // An explicit, audited /config choice opens applications; the form then opens and a
      // submission queues its officer review.
      expect(
        await service.configureGuestApplications(
          { ...actor, guildId: closedGuild },
          { enabled: true, channel: "81003" },
        ),
      ).toMatchObject({
        status: "saved",
        enabled: { previous: false, value: true },
        channel: { previous: first.guest_application_channel_id, value: "81003" },
      });
      await router.handle(interactions.slash());
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.Modal,
      });
      const application = await service.apply(applicant, await applicationInput(applicant));
      expect(application).toMatchObject({ state: "pending", channel_id: "81003" });
      expect(await applications()).toHaveLength(1);
      expect(
        await db.orm
          .select({ kind: t.jobs.kind })
          .from(t.jobs)
          .where(eq(t.jobs.dedupe_key, `review:${application.id}`)),
      ).toEqual([{ kind: "guest.review" }]);
    } finally {
      await interactions.close();
    }
  });
  test("expired job ownership is fenced and committed work can resume", async () => {
    // The old worker runs after recovery deliberately; its lease token must no longer authorize writes.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:lease", {});
    expect(await enqueue(db.pool, "probe", "test:lease", {})).toBe(key);
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (_job, guard) => {
        await guard();
        return { ok: true };
      },
      (event) => {
        events.push(event);
      },
    );
    const old = await queue.claim();
    if (!old) throw new Error("Missing lease");
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [key]);
    const recovered = await queue.claim();
    if (!recovered) throw new Error("Missing recovered lease");
    expect(recovered.lease_token).not.toBe(old.lease_token);
    await queue.perform(old);
    // The stale worker reports the actual cause at warn and leaves the new owner's row untouched.
    const stale = events.find((event) => event.type === "job" && event.job === old);
    expect(stale?.type === "job" ? stale.outcome : undefined).toMatchObject({
      code: "lease_lost",
      status: "unchanged",
      level: "warn",
    });
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "running",
      lease_token: recovered.lease_token,
      last_error: null,
    });
    await queue.perform(recovered);
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("succeeded");
  });
  test("an expired, unreclaimed lease writes nothing and is reclaimed as a counted attempt", async () => {
    // The worker outlived its lease but nobody reclaimed it yet: it must not refund or requeue the row.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:unreclaimed", {});
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (_job, guard) => {
        await guard();
        return { ok: true };
      },
      (event) => {
        events.push(event);
      },
    );
    const old = await queue.claim();
    if (!old || old.id !== key) throw new Error("Missing lease");
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [key]);
    await queue.perform(old);
    const event = events.at(-1);
    expect(event?.type === "job" ? event.outcome : undefined).toMatchObject({
      code: "lease_lost",
      status: "unchanged",
      delaySeconds: 0,
      level: "warn",
    });
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "running",
      lease_token: old.lease_token,
      attempts: 1,
      last_error: null,
    });
    // claim() reclaims the expired running row directly, counting the new attempt.
    const again = await queue.claim();
    if (!again || again.id !== key) throw new Error("Missing reclaimed lease");
    expect(again.lease_token).not.toBe(old.lease_token);
    expect(again.attempts).toBe(2);
    await queue.perform(again);
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]?.status).toBe(
      "succeeded",
    );
  });
  test("only a continuous wait streak escalates, never a first wait on an old row", async () => {
    // Activation re-queues long-lived disabled rows; their first echo supersession stays at debug.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:wait-streak", {});
    await db.orm
      .update(t.jobs)
      .set({ created_at: sql`now()-interval '1 day'` })
      .where(eq(t.jobs.id, key));
    let clock = Date.now();
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async () => {
        throw new Failure("busy", "Held elsewhere.");
      },
      (event) => {
        events.push(event);
      },
      () => clock,
    );
    /** Make the row due now, run one attempt, and return its job event. */
    const attempt = async () => {
      await db.orm.update(t.jobs).set({ due_at: sql`now()` }).where(eq(t.jobs.id, key));
      const job = await queue.claim();
      if (!job || job.id !== key) throw new Error("Missing wait-streak candidate");
      await queue.perform(job);
      const event = events.at(-1);
      if (event?.type !== "job") throw new Error("Missing job event");
      return event;
    };
    const first = await attempt();
    expect(first.outcome).toMatchObject({ code: "busy", status: "queued", level: "debug" });
    expect(first.ageMs).toBeGreaterThan(STALE_WAIT_MS);
    clock += STALE_WAIT_MS;
    expect((await attempt()).outcome.level).toBe("debug");
    clock += 1;
    expect((await attempt()).outcome).toMatchObject({
      code: "busy",
      status: "queued",
      level: "warn",
    });
    // Escalation changes visibility only: every wait still returned its attempt.
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error: "busy: Held elsewhere.",
    });
    await db.orm.delete(t.jobs).where(eq(t.jobs.id, key));
  });
  test("application operations enforce officer and target-owner authorization", async () => {
    const ordinary = { ...actor, officer: false, manageRoles: false };
    // Each refusal names its rule in the scope detail; officer-only actions and another member's
    // records are refused differently, and nothing matches on message text.
    const officerOnly = { code: "forbidden", detail: { kind: "scope", scope: "officer" } };
    const ownerOnly = { code: "forbidden", detail: { kind: "scope", scope: "owner" } };
    await expect(
      service.guestAction(ordinary, "90005", false, "Unauthorized", randomUUID()),
    ).rejects.toMatchObject(officerOnly);
    await expect(
      service.ledger(ordinary, "withdraw", 1, "Unauthorized", randomUUID()),
    ).rejects.toMatchObject(officerOnly);
    await expect(
      service.unclaim(ordinary, "90005", "77777777", "Unauthorized"),
    ).rejects.toMatchObject(officerOnly);
    await expect(service.characters(ordinary, "90005")).rejects.toMatchObject(ownerOnly);
    await expect(service.guestStatus(ordinary, "90005")).rejects.toMatchObject(ownerOnly);
    await expect(service.applicationChoices(ordinary)).rejects.toMatchObject(officerOnly);
  });
  test("sync status includes child delivery work and protects other requesters' runs", async () => {
    const requestor = { ...actor, userId: "90007", officer: false };
    const requested = await sync.refresh(requestor, false);
    expect(requested).toMatchObject({
      forced: false,
      intervalSeconds: config.ROSTER_INTERVAL_SECONDS,
    });
    const run = (
      await db.query<{ job_id: string }>("SELECT job_id FROM sync_runs WHERE id=$1", [
        requested.runId,
      ])
    )[0];
    if (!run) throw new Error("Missing run");
    await sync.guild(guild, run.job_id);
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [run.job_id]);
    const status = await service.syncStatus(requestor, requested.runId);
    expect(status.runs[0]?.status).toBe("queued");
    expect(status.runs[0]?.work_total).toBeGreaterThan(1);
    // An unfinished run has no completion time; its requester is recorded.
    expect(status.runs[0]).toMatchObject({ completed_at: null, requester_id: requestor.userId });
    for (const row of status.work)
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["user_id", "created_at"]));
    const attachedLayout = () =>
      db.query(
        "SELECT j.id FROM jobs j JOIN sync_run_jobs r ON r.job_id=j.id WHERE r.run_id=$1 AND j.kind='roles.layout'",
        [requested.runId],
      );
    // The imported guild launches with its role layout off, so a refresh attaches no layout pass.
    expect(await attachedLayout()).toHaveLength(0);
    // Once the switch is on, the next guild pass attaches the coalesced layout job to the run.
    // The switch is restored afterwards because later scenarios share the imported guild.
    await db.orm.update(t.guilds).set({ role_layout_enabled: true }).where(eq(t.guilds.id, guild));
    try {
      await sync.guild(guild, run.job_id);
      expect(await attachedLayout()).toHaveLength(1);
    } finally {
      await db.orm
        .update(t.guilds)
        .set({ role_layout_enabled: false })
        .where(eq(t.guilds.id, guild));
    }
    const other = z
      .object({ runs: z.array(z.unknown()) })
      .parse(await service.syncStatus({ ...requestor, userId: "90008" }, requested.runId));
    expect(other.runs).toHaveLength(0);
    await db.query(
      "UPDATE jobs SET status='succeeded',completed_at=now() WHERE id IN (SELECT job_id FROM sync_run_jobs WHERE run_id=$1)",
      [requested.runId],
    );
    const completed = await service.syncStatus(requestor, requested.runId);
    expect(completed.runs[0]?.status).toBe("completed");
    // A completed run finished when its last child job did, decoded as a Date.
    expect(completed.runs[0]?.completed_at).toBeInstanceOf(Date);
  });
  test("sync status leaves out failures whose work later succeeded (2.24.1)", async () => {
    // A guild of its own, so the 25 newest listed jobs are only this scenario's.
    const statusGuild = "888888888888888813";
    const officer = await displayGuild(statusGuild, "9230000000000098013");
    const key = (name: string) => `user:${statusGuild}:status-${name}`;
    // A job row as history leaves it: created, and finished (a success, or a failure since 2.24.1)
    // some minutes ago; `finished: null` is a failure from before 2.24.1, with no failure time.
    const insert = (
      name: string,
      status: "failed" | "succeeded",
      created: number,
      finished: number | null,
    ) =>
      db.query<{ id: string }>(
        `INSERT INTO jobs (kind, dedupe_key, payload, guild_id, user_id, status, last_error, created_at, completed_at)
         VALUES ('reconcile.user', $1, '{}'::jsonb, $2, '98070', $3, $4,
           now() - make_interval(mins => $5),
           CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $6::int) END)
         RETURNING id::text`,
        [
          key(name),
          statusGuild,
          status,
          status === "failed" ? "unavailable: Lodestone unavailable." : null,
          created,
          finished,
        ],
      );
    // Resolved: it failed, then the same work succeeded. Left out.
    const [resolved] = await insert("resolved", "failed", 120, 110);
    await insert("resolved", "succeeded", 60, 60);
    // A failure alone, and a failure after an earlier success: both still listed.
    const [lone] = await insert("lone", "failed", 90, 90);
    await insert("relapsed", "succeeded", 120, 120);
    const [relapse] = await insert("relapsed", "failed", 60, 55);
    // Retried in place (retry.js keeps the row and its creation time) and failed again after a
    // newer row succeeded: still listed, because it failed after that success (review of 2.24.1).
    const [retried] = await insert("retried", "failed", 180, 5);
    await insert("retried", "succeeded", 60, 60);
    // A failure from before 2.24.1, with no failure time: its creation time decides. Left out.
    const [legacy] = await insert("legacy", "failed", 120, null);
    await insert("legacy", "succeeded", 60, 60);
    if (!resolved || !lone || !relapse || !retried || !legacy)
      throw new Error("Missing inserted jobs");
    const listed = (await service.syncStatus(officer, null)).work.map((row) => row.id).sort();
    expect(listed).toEqual([lone.id, relapse.id, retried.id].sort());
    expect(listed).not.toContain(resolved.id);
    expect(listed).not.toContain(legacy.id);
  });

  test("the queue stamps when a job failed, and retry.js clears it (2.24.1)", async () => {
    const failGuild = "888888888888888814";
    await displayGuild(failGuild, "9230000000000098014");
    // Only this job may be claimed.
    await db.query("UPDATE jobs SET status='disabled' WHERE status IN ('queued','running')");
    const id = await enqueue(db.pool, "probe", `probe:${failGuild}:failure-time`, {}, failGuild);
    const queue = new Queue(
      db,
      async () => {
        throw new Failure("invalid_job", "The probe always fails.");
      },
      () => {},
    );
    const job = await queue.claim();
    if (job?.id !== id) throw new Error("Missing lease");
    await queue.perform(job);
    const row = async () =>
      (
        await db.query<{ status: string; completed_at: Date | null }>(
          "SELECT status, completed_at FROM jobs WHERE id=$1",
          [id],
        )
      )[0];
    const failed = await row();
    expect(failed?.status).toBe("failed");
    expect(failed?.completed_at).toBeInstanceOf(Date);
    await db.transaction((client) => retryJob(client, failGuild, id));
    expect(await row()).toMatchObject({ status: "queued", completed_at: null });
    await db.query("UPDATE jobs SET status='disabled' WHERE id=$1", [id]);
  });

  test("failed nickname writes do not invent a successful write; manual races are preserved", async () => {
    const owner = "90011";
    await service.assign(
      actor,
      owner,
      { id: "77777781", name: "Blocked Nickname", world: "Diabolos", dc: "Crystal", fcId: null },
      "Nickname failure fixture",
    );
    const queue = new Queue(db, dispatcher(service, sync, access), () => {});
    const reconcile = async () => {
      const key = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${guild}:${owner}`,
        {},
        guild,
        owner,
      );
      await queue.perform(await leased(key));
      return (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]
        ?.status;
    };
    nicknameBlocked = true;
    expect(await reconcile()).toBe("blocked");
    expect(
      (
        await db.query<{ nickname_last: string | null; nickname_written: boolean }>(
          "SELECT nickname_last,nickname_written FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0],
    ).toEqual({ nickname_last: null, nickname_written: false });
    await service.preferences({ ...actor, userId: owner }, null, false);
    expect(await reconcile()).toBe("succeeded");
    nicknameBlocked = false;
    await service.preferences({ ...actor, userId: owner }, null, true);
    nicknameRace = true;
    expect(await reconcile()).toBe("succeeded");
    expect(members.get(owner)?.nickname).toBe("Race override");
    expect(
      (
        await db.query<{ nickname_suspended: boolean }>(
          "SELECT nickname_suspended FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.nickname_suspended,
    ).toBe(true);
  });
  test("the server owner's nickname is skipped, never a blocked job (2.14.0 reply session)", async () => {
    const serverOwner = "90012";
    await service.assign(
      actor,
      serverOwner,
      { id: "77777783", name: "Owner Nickname", world: "Diabolos", dc: "Crystal", fcId: null },
      "Server owner fixture",
    );
    const member = await discord.member(guild, serverOwner);
    if (!member) throw new Error("Missing member");
    member.owner = true;
    const before = member.nickname;
    const queue = new Queue(db, dispatcher(service, sync, access), () => {});
    // Discord would refuse the write (modelled by nicknameBlocked); the worker never attempts it.
    const reconcileOwner = async () => {
      const key = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${guild}:${serverOwner}`,
        {},
        guild,
        serverOwner,
      );
      await queue.perform(await leased(key));
      return (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]
        ?.status;
    };
    nicknameBlocked = true;
    try {
      expect(await reconcileOwner()).toBe("succeeded");
      // Turning sync off queues a restore; for the owner it is dropped, never attempted.
      await db.query(
        "UPDATE guild_users SET nickname_restore=true, nickname_pending=true, nickname_baseline_set=true, nickname_written=true WHERE guild_id=$1 AND user_id=$2",
        [guild, serverOwner],
      );
      expect(await reconcileOwner()).toBe("succeeded");
    } finally {
      nicknameBlocked = false;
    }
    expect(member.nickname).toBe(before);
    expect(
      (
        await db.query<{ nickname_restore: boolean; nickname_pending: boolean }>(
          "SELECT nickname_restore, nickname_pending FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, serverOwner],
        )
      )[0],
    ).toEqual({ nickname_restore: false, nickname_pending: false });
    // A preview plans no nickname change for the owner either, even with a restore pending.
    await db.query(
      "UPDATE guild_users SET nickname_restore=true, nickname_baseline_set=true, nickname_written=true, nickname_before='Original' WHERE guild_id=$1 AND user_id=$2",
      [guild, serverOwner],
    );
    const previewKey = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${guild}:${serverOwner}`,
      {},
      guild,
      serverOwner,
    );
    expect(await sync.user(await leased(previewKey), async () => {}, true)).toMatchObject({
      nickname: { current: before, desired: before },
    });
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [previewKey]);
  });
  test("replacement, tuple binding and expiry prevent invalid proof completion", async () => {
    const owner = { ...actor, userId: "90013", officer: false };
    const identity = {
      id: "77777782",
      name: "Proof Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const first = z.object({ token: z.string() }).parse(await service.claim(owner, identity));
    const second = z
      .object({ token: z.string(), challenge: z.string() })
      .parse(await service.claim(owner, identity));
    proof = first.token;
    // A replaced token is not proof; the newest claim stays valid until it expires.
    await expect(service.verify(owner, identity.id)).rejects.toMatchObject({
      code: "pending_proof",
      detail: { kind: "proof", character: { id: identity.id } },
    });
    proof = second.token;
    const noClaim = { code: "not_found", detail: { kind: "resource", resource: "challenge" } };
    await expect(service.verify({ ...owner, userId: "90014" }, identity.id)).rejects.toMatchObject(
      noClaim,
    );
    await db.query("UPDATE challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [
      second.challenge,
    ]);
    await expect(service.verify(owner, identity.id)).rejects.toMatchObject(noClaim);
    expect(
      await db.query("SELECT id FROM links WHERE guild_id=$1 AND character_id=$2 AND active", [
        guild,
        identity.id,
      ]),
    ).toHaveLength(0);
  });
  test("extracted guild event operations preserve policy and cancel departed-user reviews", async () => {
    const observations = new GuildEvents(db);
    const owner = "90100";
    const member = await discord.member(guild, owner);
    if (!member) throw new Error("Missing event fixture member");
    await observations.memberJoined(guild, owner, member.joinedAt);
    const pending = z
      .object({ id: z.string() })
      .parse(
        await service.apply(
          { ...actor, userId: owner, officer: false },
          await applicationInput({ ...actor, userId: owner }),
        ),
      );
    await service.assign(
      actor,
      owner,
      { id: "77777790", name: "Event Fixture", world: "Diabolos", dc: "Crystal", fcId: null },
      "Event observation fixture",
    );
    await service.guestAction(actor, owner, false, "Grant survives departure", randomUUID());
    await observations.memberLeft(guild, owner);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          pending.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
    expect(
      (
        await db.query<{ active: boolean }>(
          "SELECT active FROM links WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.active,
    ).toBe(true);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM guest_grants WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.count,
    ).toBe(1n);
    await observations.memberJoined(guild, owner, new Date("2026-09-22T00:00:00Z"));
    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT present FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.present,
    ).toBe(true);
    await observations.guildLeft(guild);
    expect(
      (await db.query<{ active: boolean }>("SELECT active FROM guilds WHERE id=$1", [guild]))[0]
        ?.active,
    ).toBe(false);
    await observations.guildJoined(guild);
    expect(
      (await db.query<{ active: boolean }>("SELECT active FROM guilds WHERE id=$1", [guild]))[0]
        ?.active,
    ).toBe(true);
    // Observing an unconfigured server must not create policy/configuration as a side effect.
    await observations.memberJoined("999999888", owner, member.joinedAt);
    expect(await db.query("SELECT id FROM guilds WHERE id='999999888'")).toHaveLength(0);
  });

  test("setup is repeatable and officer rank authority honors explicit manager overrides", async () => {
    const setupGuild = "666666666666666666";
    const manager: Actor = { ...actor, guildId: setupGuild, serverManager: true };
    const created = new Map<string, string>();
    const hoists: boolean[] = [];
    let serial = 60000;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, name, _actor, configured, _canonical, hoist) {
        // Record the layout switch each provisioning call receives.
        hoists.push(hoist);
        if (configured) return { id: configured, created: false };
        const existing = created.get(name);
        if (existing) return { id: existing, created: false };
        const role = String(++serial);
        created.set(name, role);
        return { id: role, created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    await expect(
      administration.setup({ ...manager, serverManager: false }, "DevBot", fc, "Officer"),
    ).rejects.toThrow("Manage Server");
    const first = z
      .object({ roleLayout: z.string() })
      .parse(await administration.setup(manager, "DevBot", fc, "Officer"));
    const configured = await service.guild(manager);
    expect(configured.access_policy_enabled).toBe(true);
    // A guild first created by /setup onboarding starts with the layout off (NEW_GUILD_ROW,
    // CFG-07 as of 2.35.0): roles are created unhoisted and no layout pass is queued.
    expect(configured.role_layout_enabled).toBe(false);
    expect(first.roleLayout).toStartWith("disabled");
    expect(hoists).toEqual([false, false, false, false]);
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, setupGuild), eq(t.jobs.kind, "roles.layout"))),
    ).toHaveLength(0);
    expect(configured.officer_notifications_channel_id).toBe(configured.officer_channel_id);
    expect(configured.guest_application_channel_id).toBe(configured.officer_channel_id);
    // /setup opens /apply: the switch goes on with the review channel.
    expect(configured.guest_applications_enabled).toBe(true);
    await administration.setup(manager, "DevBot", null, null);
    // Switching applications on validates a kept review channel first (an import's legacy channel
    // may be gone), as /config guest_applications enabled:true does (2.15.0 review).
    await db.orm
      .update(t.guilds)
      .set({ guest_application_channel_id: "89999", guest_applications_enabled: false })
      .where(eq(t.guilds.id, setupGuild));
    const keptChannel = provisioner.validateChannel;
    provisioner.validateChannel = async (guildId, channel) => {
      if (channel === "89999")
        throw new Failure("blocked", "<#89999> is unavailable.", 0, {
          kind: "resource",
          resource: "channel",
          id: channel,
        });
      return keptChannel(guildId, channel);
    };
    try {
      await expect(administration.setup(manager, "DevBot", null, null)).rejects.toMatchObject({
        code: "blocked",
      });
    } finally {
      provisioner.validateChannel = keptChannel;
    }
    expect((await service.guild(manager)).guest_applications_enabled).toBe(false);
    await db.orm
      .update(t.guilds)
      .set({
        guest_application_channel_id: configured.guest_application_channel_id,
        guest_applications_enabled: true,
      })
      .where(eq(t.guilds.id, setupGuild));
    expect(created.size).toBe(4);
    expect((await service.guild(manager)).officer_role_id).toBe(configured.officer_role_id);
    const officerRole = configured.officer_role_id;
    if (!officerRole) throw new Error("Missing officer role");
    await administration.officer(manager, "90030", true, "Manual officer fixture");
    const base: Actor = {
      guildId: setupGuild,
      userId: "90030",
      officer: false,
      serverManager: false,
      manageRoles: false,
      roleIds: [officerRole],
    };
    const delegated = await service.enrichActor(base);
    expect(delegated.officer).toBe(true);
    await expect(
      administration.officer(
        { ...delegated, manageRoles: true },
        "90031",
        true,
        "Unauthorized delegation",
      ),
    ).rejects.toThrow("Manage Server");
    await expect(
      service.configureOfficerRank({ ...delegated, manageRoles: true }, "Member"),
    ).rejects.toThrow("Manage Server");

    const leader = {
      id: "77777111",
      name: "Leader Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Fussy Bunbun",
      isFcLeader: true,
    };
    const officer = {
      id: "77777112",
      name: "Officer Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Officer",
      isFcLeader: false,
    };
    const indirect = {
      id: "77777113",
      name: "Indirect Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Officer",
      isFcLeader: false,
    };
    await service.assign(manager, "90031", leader, "Leader link");
    await service.assign(manager, "90032", officer, "Officer link");
    await service.assign(delegated, "90033", indirect, "Delegated membership assignment");
    lodestone.rosterValue = {
      company: {
        id: fc,
        name: "Setup FC",
        tag: "TEST",
        world: "Diabolos",
        dc: "Crystal",
        count: 3,
      },
      members: [leader, officer, indirect],
      startedAt: new Date(Date.now() - 1000),
      observedAt: new Date(),
      pages: 1,
    };
    await db.query(
      "UPDATE free_companies SET last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
      [fc],
    );
    const job = await leased(await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc }));
    await sync.roster(job, async () => {});
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [job.id]);
    expect((await rankAccess(db, configured, "90031", 21600)).leader).toBe("yes");
    expect((await rankAccess(db, configured, "90032", 21600)).officer).toBe("yes");
    expect((await rankAccess(db, configured, "90033", 21600)).officer).toBe("no");
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(true);
    await administration.officer(manager, "90032", false, "Rank override fixture");
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(false);
    const revoked = await rankAccess(db, configured, "90032", 21600);
    expect(desiredRankRole(revoked.officer, true, true)).toBe(false);
    // Like grant and revoke, a manager below the Officer role is refused and the revoke stands.
    const validateRole = provisioner.validateRole;
    const refusals: unknown[][] = [];
    provisioner.validateRole = async (...args) => {
      refusals.push(args);
      throw new Failure("forbidden", "Your highest Discord role must be above @Officer.", 0, {
        kind: "scope",
        scope: "hierarchy",
      });
    };
    try {
      await expect(
        administration.officerReset(manager, "90032", "Below the role"),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      provisioner.validateRole = validateRole;
    }
    expect(refusals).toEqual([[configured.id, configured.officer_role_id, manager.userId, false]]);
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(false);
    // /officer reset removes the revoke, so the in-game rank decides again; a second reset has
    // nothing to remove (owner decision, 2026-09-24).
    expect(await administration.officerReset(manager, "90032", "Rank decides")).toMatchObject({
      status: "reset",
      previous: "revoked",
      rankConfigured: true,
    });
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(true);
    expect(await administration.officerReset(manager, "90032", "Again")).toMatchObject({
      status: "unchanged",
      effects: "unchanged",
      previous: null,
    });
    await expect(
      administration.officerReset({ ...manager, serverManager: false }, "90032", "Not allowed"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.configureOfficerRank(manager, null);
    expect((await rankAccess(db, await service.guild(manager), "90030", 21600)).manualOfficer).toBe(
      true,
    );
  });

  test("/guest reset lifts the revoke and ends every grant, keeping them as history (2026-09-24)", async () => {
    const user = "90095";
    await service.guestAction(actor, user, false, "Manual fixture", randomUUID());
    await db.orm.insert(t.guestGrants).values({
      guild_id: guild,
      user_id: user,
      provenance: "imported_guest",
      source_key: `import:reset-fixture:${user}`,
    });
    await service.guestAction(actor, user, true, "Revoke fixture", randomUUID());
    expect(await service.guestReset(actor, user, "Back to the automatic rules")).toMatchObject({
      status: "reset",
      effects: "queued",
      revocationLifted: true,
      grantsEnded: ["imported_guest", "manual"],
    });
    // Both grant rows remain as history, ended by this officer with the reason.
    expect(
      await db.query<{ provenance: string; ended: boolean; by: string | null; why: string | null }>(
        "SELECT provenance, ended_at IS NOT NULL AS ended, ended_by AS by, ended_reason AS why FROM guest_grants WHERE guild_id=$1 AND user_id=$2 ORDER BY provenance",
        [guild, user],
      ),
    ).toEqual([
      {
        provenance: "imported_guest",
        ended: true,
        by: actor.userId,
        why: "Back to the automatic rules",
      },
      { provenance: "manual", ended: true, by: actor.userId, why: "Back to the automatic rules" },
    ]);
    // Status and access see no grant and no revocation; the audit records what was removed.
    const status = await service.guestStatus(actor, user);
    expect(status.grants).toEqual([]);
    expect(status.revocation.some((row) => row.revoked)).toBe(false);
    expect(
      (
        await db.orm
          .select({ details: t.auditEvents.details })
          .from(t.auditEvents)
          .where(and(eq(t.auditEvents.guild_id, guild), eq(t.auditEvents.action, "guest.reset")))
      ).map((row) => row.details),
    ).toContainEqual({
      reason: "Back to the automatic rules",
      revocationLifted: true,
      grantsEnded: ["imported_guest", "manual"],
    });
    // Nothing left to remove; a later grant is a fresh, active one.
    expect(await service.guestReset(actor, user, "Again")).toMatchObject({
      status: "unchanged",
      effects: "unchanged",
      revocationLifted: false,
      grantsEnded: [],
    });
    await service.guestAction(actor, user, false, "Welcome back", randomUUID());
    expect((await service.guestStatus(actor, user)).grants).toHaveLength(1);
    await expect(
      service.guestReset({ ...actor, officer: false, serverManager: false }, user, "No"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("a lost roster lease is an ownership change, not Lodestone degradation", async () => {
    // The reclaiming worker owns FC state: no FC error, degraded metric, or officer notice here.
    await db.query(
      "UPDATE free_companies SET last_error=NULL,last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
      [fc],
    );
    const notices = () =>
      db.query<{ id: string; generation: number }>(
        "SELECT id,generation FROM jobs WHERE kind='officer.notify' ORDER BY id",
      );
    const before = await notices();
    const job = await leased(await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc }));
    // The lease expires after the Lodestone fetch, so the publication transaction finds no live lease.
    const expire = async (): Promise<void> => {
      await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    };
    await expect(sync.roster(job, expire)).rejects.toMatchObject({ code: "lease_lost" });
    await db.query("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=$1", [job.id]);
    expect(
      (
        await db.query<{ last_error: string | null }>(
          "SELECT last_error FROM free_companies WHERE id=$1",
          [fc],
        )
      )[0]?.last_error,
    ).toBeNull();
    // A degraded notice would insert a row or bump a pending notice's generation.
    expect(await notices()).toEqual(before);
  });

  test("role layout checks activation, setup exclusion and current configuration before writes", async () => {
    const layoutGuild = "666666666666666667";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,member_role_id,guest_role_id,officer_role_id,leader_role_id) VALUES($1,true,'70001','70002','70003','70004')",
      [layoutGuild],
    );
    const job = await leased(await layoutGuildRoles(db.pool, layoutGuild));
    let writes = 0;
    let changeConfiguration = false;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // A concurrent configuration edit must fence the next external write, even with a valid lease.
        if (changeConfiguration)
          await db.query("UPDATE guilds SET revision=revision+1 WHERE id=$1", [guildId]);
        await guard();
        writes++;
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, lodestone, config);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    const disabled = new Service(db, layoutPort, lodestone, { ...config, ENABLE_EFFECTS: false });
    await expect(
      dispatcher(
        disabled,
        new Synchronization(disabled),
        new GuildAccess(disabled, accessPort),
      )(job, async () => {}),
    ).rejects.toMatchObject({ code: "disabled" });
    await db.query("UPDATE guilds SET effects_enabled=false WHERE id=$1", [layoutGuild]);
    await expect(run(job, async () => {})).rejects.toMatchObject({ code: "disabled" });
    await db.query("UPDATE guilds SET effects_enabled=true WHERE id=$1", [layoutGuild]);
    const setup = await db.pool.connect();
    try {
      await setup.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `setup:${layoutGuild}`,
      ]);
      await expect(run(job, async () => {})).rejects.toMatchObject({ code: "busy" });
    } finally {
      await setup.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `setup:${layoutGuild}`,
      ]);
      setup.release();
    }
    changeConfiguration = true;
    await expect(run(job, async () => {})).rejects.toMatchObject({ code: "superseded" });
    expect(writes).toBe(0);
    changeConfiguration = false;
    expect(await run(job, async () => {})).toEqual({ order: ["70004", "70003", "70001", "70002"] });
    expect(writes).toBe(1);
  });

  test("role layout coalesces its own Discord events and converges on a follow-up pass", async () => {
    const layoutGuild = "666666666666666668";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,member_role_id) VALUES($1,true,'71001')",
      [layoutGuild],
    );
    const key = await layoutGuildRoles(db.pool, layoutGuild);
    let calls = 0;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // Discord echoes the first role mutation; the second observation requires no new write/event.
        if (++calls === 1) expect(await layoutGuildRoles(db.pool, guildId)).toBe(key);
        await guard();
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, lodestone, config);
    const queue = new Queue(
      db,
      dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort)),
      () => {},
    );
    await queue.perform(await leased(key));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("queued");
    await queue.perform(await leased(key));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("succeeded");
    expect(calls).toBe(2);
  });

  test("disabled role layout completes as skipped before activation, after requeue and after a mid-pass disable", async () => {
    // Decision 4: with the switch off no pass reaches Discord, yet the job completes instead of
    // parking as `disabled`, so activation or a /config change has nothing to requeue.
    const layoutGuild = "666666666666666690";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,role_layout_enabled,member_role_id,guest_role_id,officer_role_id,leader_role_id) VALUES($1,false,false,'72001','72002','72003','72004')",
      [layoutGuild],
    );
    let writes = 0;
    let disableMidPass = false;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // An operator switching layout off mid-pass, without a revision bump, fences the next write.
        if (disableMidPass)
          await db.orm
            .update(t.guilds)
            .set({ role_layout_enabled: false })
            .where(eq(t.guilds.id, guildId));
        await guard();
        writes++;
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, lodestone, config);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    const queue = new Queue(db, run, () => {});
    const outcome = async (id: string) =>
      (
        await db.orm
          .select({ status: t.jobs.status, result: t.jobs.result })
          .from(t.jobs)
          .where(eq(t.jobs.id, id))
      )[0];
    const skipped = { status: "succeeded", result: { skipped: "layout disabled" } };
    // 1. Before activation: the switch is checked before effects, so this is no `disabled` park.
    const before = await layoutGuildRoles(db.pool, layoutGuild);
    expect(await run(await leased(before), async () => {})).toEqual({ skipped: "layout disabled" });
    await queue.perform(await leased(before));
    expect(await outcome(before)).toEqual(skipped);
    // 2. A job parked `disabled` by an older build, requeued exactly as scripts/activate.ts does.
    const parked = await layoutGuildRoles(db.pool, layoutGuild);
    await db.query("UPDATE jobs SET status='disabled' WHERE id=$1", [parked]);
    await db.transaction(async (client) => {
      const store = orm(client);
      await store
        .update(t.guilds)
        .set({ effects_enabled: true, revision: sql`${t.guilds.revision}+1` })
        .where(eq(t.guilds.id, layoutGuild));
      await store
        .update(t.jobs)
        .set({ status: "queued", due_at: sql`now()`, attempts: 0 })
        .where(
          and(eq(t.jobs.guild_id, layoutGuild), inArray(t.jobs.status, ["disabled", "blocked"])),
        );
    });
    await queue.perform(await leased(parked));
    expect(await outcome(parked)).toEqual(skipped);
    expect(writes).toBe(0);
    // 3. Opting in lets the next pass write once.
    await db.orm
      .update(t.guilds)
      .set({ role_layout_enabled: true })
      .where(eq(t.guilds.id, layoutGuild));
    const enabled = await layoutGuildRoles(db.pool, layoutGuild);
    await queue.perform(await leased(enabled));
    expect(await outcome(enabled)).toEqual({
      status: "succeeded",
      result: { order: ["72004", "72003", "72001", "72002"] },
    });
    expect(writes).toBe(1);
    // 4. Disabling mid-pass supersedes the pass before its write; the retry completes skipped.
    disableMidPass = true;
    const fenced = await layoutGuildRoles(db.pool, layoutGuild);
    await expect(run(await leased(fenced), async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(writes).toBe(1);
    disableMidPass = false;
    await queue.perform(await leased(fenced));
    expect(await outcome(fenced)).toEqual(skipped);
    expect(writes).toBe(1);
  });

  test("/config role_layout requires server-manager authority, audits, fences revisions and queues layout only when enabling", async () => {
    const layoutGuild = "666666666666666691";
    await db.orm.insert(t.guilds).values({
      id: layoutGuild,
      effects_enabled: true,
      role_layout_enabled: false,
      member_role_id: "73001",
      guest_role_id: "73002",
      officer_role_id: "73003",
      leader_role_id: "73004",
    });
    // The enabling preflight repeats AUTH-03 per managed role; one role can be made unmanageable.
    const checked: string[] = [];
    let unmanageable: string | null = null;
    const port: DiscordPort = {
      ...discord,
      async validateRole(_guild, role, actorId) {
        checked.push(`${role}:${actorId}`);
        if (role === unmanageable)
          throw new Failure("forbidden", "Your highest role must be above the selected role.");
      },
    };
    const app = new Service(db, port, lodestone, config);
    const manager: Actor = { ...actor, guildId: layoutGuild, serverManager: true };
    const state = async () =>
      (
        await db.orm
          .select({ revision: t.guilds.revision, layout: t.guilds.role_layout_enabled })
          .from(t.guilds)
          .where(eq(t.guilds.id, layoutGuild))
      )[0];
    const audits = () =>
      db.orm
        .select({ actor: t.auditEvents.actor_id, details: t.auditEvents.details })
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, layoutGuild),
            eq(t.auditEvents.action, "config.role_layout"),
          ),
        )
        .orderBy(t.auditEvents.id);
    const layoutJobs = () =>
      db.orm
        .select({ id: t.jobs.id, status: t.jobs.status })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, layoutGuild), eq(t.jobs.kind, "roles.layout")));
    // Officer-only actors and managers without Manage Roles cannot change presentation.
    await expect(
      app.configureRoleLayout({ ...manager, serverManager: false }, true),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      app.configureRoleLayout({ ...manager, manageRoles: false }, true),
    ).rejects.toMatchObject({ code: "forbidden" });
    unmanageable = "73003";
    await expect(app.configureRoleLayout(manager, true)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await state()).toEqual({ revision: 1n, layout: false });
    expect(await audits()).toEqual([]);
    unmanageable = null;
    checked.length = 0;
    const enabled = z
      .object({ status: z.string(), roleLayout: z.string(), layoutJob: z.string() })
      .parse(await app.configureRoleLayout(manager, true));
    expect(enabled).toMatchObject({ status: "saved", roleLayout: "enabled" });
    expect(checked).toEqual(
      ["73004", "73003", "73001", "73002"].map((r) => `${r}:${actor.userId}`),
    );
    expect(await state()).toEqual({ revision: 2n, layout: true });
    expect(await audits()).toEqual([
      { actor: actor.userId, details: { enabled: true, previous: false } },
    ]);
    expect(await layoutJobs()).toEqual([{ id: enabled.layoutJob, status: "queued" }]);
    // Repeating the choice changes nothing: no revision bump, no audit, no new work.
    expect(await app.configureRoleLayout(manager, true)).toEqual({
      status: "unchanged",
      roleLayout: "enabled",
      effectsMode: "live",
    });
    expect(await state()).toEqual({ revision: 2n, layout: true });
    expect(await audits()).toHaveLength(1);
    // Disabling needs no hierarchy preflight and queues nothing; the queued pass will skip.
    checked.length = 0;
    expect(await app.configureRoleLayout(manager, false)).toMatchObject({
      status: "saved",
      roleLayout: "disabled",
      effects: "none",
      layoutJob: null,
    });
    expect(checked).toEqual([]);
    expect(await state()).toEqual({ revision: 3n, layout: false });
    expect((await audits()).at(-1)).toEqual({
      actor: actor.userId,
      details: { enabled: false, previous: true },
    });
    expect(await layoutJobs()).toEqual([{ id: enabled.layoutJob, status: "queued" }]);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    expect(await run(await leased(enabled.layoutJob), async () => {})).toEqual({
      skipped: "layout disabled",
    });
    expect(await app.validate(manager)).toMatchObject({
      configuration: { role_layout_enabled: false },
      roleLayout: "disabled (role display and order are not changed by the bot)",
    });
    // The setting never creates configuration for an unconfigured guild.
    await expect(
      app.configureRoleLayout({ ...manager, guildId: "666666666666666699" }, true),
    ).rejects.toMatchObject({ code: "setup" });
    expect(await db.query("SELECT id FROM guilds WHERE id='666666666666666699'")).toHaveLength(0);
  });

  test("layout-disabled guilds enqueue no layout work until the switch is enabled", async () => {
    const fixture = await accessFixture("666666666666666692");
    const guildId = fixture.guild.id;
    await db.orm
      .update(t.guilds)
      .set({ role_layout_enabled: false })
      .where(eq(t.guilds.id, guildId));
    const events = new GuildEvents(db);
    const jobsOf = (kind: string) =>
      db.orm
        .select({ id: t.jobs.id, key: t.jobs.dedupe_key, generation: t.jobs.generation })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.kind, kind)));
    // A refresh run, with a member-less enumeration so only guild-wide children are attached.
    const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
    const [runRow] = await db.orm
      .insert(t.syncRuns)
      .values({ guild_id: guildId, requester_id: actor.userId, job_id: parent })
      .returning();
    if (!runRow) throw new Error("Missing refresh run");
    await db.orm.insert(t.syncRunJobs).values({ run_id: runRow.id, job_id: parent });
    const app = new Service(
      db,
      {
        ...discord,
        async members() {
          return [];
        },
      },
      lodestone,
      config,
    );
    const refresh = new Synchronization(app);
    const children = async () =>
      (
        await db.orm
          .select({ kind: t.jobs.kind })
          .from(t.syncRunJobs)
          .innerJoin(t.jobs, eq(t.jobs.id, t.syncRunJobs.job_id))
          .where(eq(t.syncRunJobs.run_id, runRow.id))
      )
        .map((row) => row.kind)
        .sort();
    // Every enqueue path: rejoin, role events, a role binding and a refresh pass.
    const everyPath = async (guestRole: string) => {
      await events.guildJoined(guildId);
      await events.roleChanged(guildId);
      await service.configure(fixture.manager, "guest_role_id", guestRole);
      await refresh.guild(guildId, parent);
    };
    await everyPath("81902");
    expect(await jobsOf("roles.layout")).toEqual([]);
    // Reconciliation and channel work are unchanged, each coalesced into one job.
    expect(await jobsOf("reconcile.guild")).toHaveLength(1);
    expect(await jobsOf("channels.access")).toHaveLength(1);
    expect(await children()).toEqual(["channels.access", "reconcile.guild"]);
    // After enabling, every path feeds the single coalesced role-layout:<guild> job.
    const enabled = z
      .object({ layoutJob: z.string() })
      .parse(await service.configureRoleLayout(fixture.manager, true));
    await everyPath("81903");
    expect(await jobsOf("roles.layout")).toEqual([
      { id: enabled.layoutJob, key: `role-layout:${guildId}`, generation: 5 },
    ]);
    expect(await children()).toEqual(["channels.access", "reconcile.guild", "roles.layout"]);
  });

  test("setup keeps a layout-disabled guild's display: created roles are not hoisted and no layout is queued", async () => {
    // An imported (layout-off) guild that later runs /setup keeps its switch and role display.
    const setupGuild = "666666666666666693";
    await db.orm
      .insert(t.guilds)
      .values({ id: setupGuild, effects_enabled: true, role_layout_enabled: false });
    const hoists: boolean[] = [];
    let serial = 74000;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, _name, _actor, _configured, _canonical, hoist) {
        hoists.push(hoist);
        return { id: String(++serial), created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    const manager: Actor = { ...actor, guildId: setupGuild, serverManager: true };
    const result = z
      .object({ roleLayout: z.string() })
      .parse(await administration.setup(manager, "Imported", null, null));
    expect(result.roleLayout).toStartWith("disabled");
    expect(hoists).toEqual([false, false, false, false]);
    const configured = await service.guild(manager);
    expect(configured).toMatchObject({ role_layout_enabled: false, access_policy_enabled: true });
    const kinds = await db.orm
      .select({ kind: t.jobs.kind })
      .from(t.jobs)
      .where(eq(t.jobs.guild_id, setupGuild));
    expect(kinds.map((row) => row.kind).sort()).toEqual(["channels.access", "reconcile.guild"]);
  });

  /** A guild's roles.layout jobs, by ID: the work a layout-on switch queues. */
  const layoutJobIds = (guildId: string) =>
    db.orm
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.kind, "roles.layout")));

  test("a server first configured by /config starts with the role layout off until a manager opts in", async () => {
    // CFG-07 as of 2.35.0: the first save inserts NEW_GUILD_ROW, whichever setting it saves, and
    // never relies on the column default (still on, schema 010). Before 2.35.0 the role save
    // below would also have queued a layout pass.
    const byChannel: Actor = { ...actor, guildId: "666666666666666650" };
    expect(await service.configure(byChannel, "ledger_channel_id", "76501")).toMatchObject({
      status: "saved",
    });
    const byRole: Actor = { ...actor, guildId: "666666666666666651" };
    expect(await service.configure(byRole, "member_role_id", "76502")).toMatchObject({
      status: "saved",
    });
    for (const first of [byChannel, byRole]) {
      expect(await service.guild(first)).toMatchObject({
        effects_enabled: true,
        role_layout_enabled: false,
      });
      expect(await layoutJobIds(first.guildId)).toEqual([]);
    }
    // Opting in is unchanged: /config role_layout enabled:true turns it on and queues one pass.
    const manager: Actor = { ...byRole, serverManager: true };
    const enabled = z
      .object({ status: z.literal("saved"), layoutJob: z.string() })
      .parse(await service.configureRoleLayout(manager, true));
    expect((await service.guild(manager)).role_layout_enabled).toBe(true);
    expect(await layoutJobIds(manager.guildId)).toEqual([{ id: enabled.layoutJob }]);
  });

  test("a server first configured by /config guest_applications starts with the role layout off", async () => {
    // The guest-application save has its own insert; it spreads the same NEW_GUILD_ROW.
    const first: Actor = { ...actor, guildId: "666666666666666652" };
    expect(
      await service.configureGuestApplications(first, { channel: "76503", enabled: true }),
    ).toMatchObject({ status: "saved" });
    expect(await service.guild(first)).toMatchObject({
      effects_enabled: true,
      role_layout_enabled: false,
      guest_application_channel_id: "76503",
      guest_applications_enabled: true,
    });
    expect(await layoutJobIds(first.guildId)).toEqual([]);
  });

  test("a server with the role layout on keeps it through /config saves and /setup onboarding", async () => {
    // A server configured before 2.35.0 took the column default, so its layout is on; the new
    // default applies only where a row is created, never to an existing one.
    const guildId = "666666666666666653";
    await db.orm
      .insert(t.guilds)
      .values({ id: guildId, effects_enabled: true, role_layout_enabled: true });
    const manager: Actor = { ...actor, guildId, serverManager: true };
    await service.configure(manager, "ledger_channel_id", "76504");
    await service.configure(manager, "member_role_id", "76505");
    await service.configureGuestApplications(manager, { channel: "76506", enabled: true });
    expect((await service.guild(manager)).role_layout_enabled).toBe(true);
    // The role save queued the coalesced layout pass, as a layout-on server always has.
    const [queued] = await layoutJobIds(guildId);
    if (!queued) throw new Error("Missing layout pass");
    const hoists: boolean[] = [];
    let serial = 76510;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, _name, _actor, configured, _canonical, hoist) {
        hoists.push(hoist);
        return configured
          ? { id: configured, created: false }
          : { id: String(++serial), created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    const result = z
      .object({ roleLayoutEnabled: z.boolean(), layoutJob: z.string() })
      .parse(await administration.setup(manager, "Kept", null, null));
    // Setup keeps the switch: roles are provisioned hoisted, and its pass merges into the one queued.
    expect(result.roleLayoutEnabled).toBe(true);
    expect(hoists).toEqual([true, true, true, true]);
    expect((await service.guild(manager)).role_layout_enabled).toBe(true);
    expect(await layoutJobIds(guildId)).toEqual([{ id: queued.id }]);
    expect(result.layoutJob).toBe(queued.id);
  });

  test("an imported server keeps its role layout off through /config saves", async () => {
    // As the importer writes the row: the layout off explicitly, effects held until activation.
    const guildId = "666666666666666654";
    await db.orm.insert(t.guilds).values({
      id: guildId,
      effects_enabled: false,
      role_layout_enabled: false,
      guest_grandfather: "pending",
    });
    const manager: Actor = { ...actor, guildId, serverManager: true };
    await service.configure(manager, "ledger_channel_id", "76507");
    await service.configure(manager, "member_role_id", "76508");
    await service.configureGuestApplications(manager, { channel: "76509", enabled: true });
    expect(await service.guild(manager)).toMatchObject({
      effects_enabled: false,
      role_layout_enabled: false,
      guest_grandfather: "pending",
    });
    expect(await layoutJobIds(guildId)).toEqual([]);
  });

  test("/config roles officer adopts current holders by default and nobody with adopt_holders:false", async () => {
    // Owner decision O1: a rank-based launch binds the legacy Officer role without adopting holders.
    const adopting = "666666666666666694";
    const skipping = "666666666666666695";
    const officerRole = "75003";
    let enumerations = 0;
    const holder = (id: string, roles: string[], bot = false): MemberView => ({
      id,
      guildId: "",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
      nickname: null,
      roles,
      bot,
    });
    const port: DiscordPort = {
      ...discord,
      async members(guildId) {
        enumerations++;
        return [
          holder("75101", [officerRole]),
          holder("75102", [officerRole, "75001"]),
          holder("75103", [officerRole], true),
          holder("75104", ["75001"]),
        ].map((member) => ({ ...member, guildId }));
      },
    };
    const app = new Service(db, port, lodestone, config);
    for (const id of [adopting, skipping])
      await db.orm.insert(t.guilds).values({ id, effects_enabled: true });
    const overrides = (guildId: string) =>
      db.orm
        .select({ user: t.officerOverrides.user_id, state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(eq(t.officerOverrides.guild_id, guildId))
        .orderBy(t.officerOverrides.user_id);
    const audits = (guildId: string) =>
      db.orm
        .select({
          action: t.auditEvents.action,
          target: t.auditEvents.target,
          details: t.auditEvents.details,
        })
        .from(t.auditEvents)
        .where(eq(t.auditEvents.guild_id, guildId))
        .orderBy(t.auditEvents.id);
    const adopter: Actor = { ...actor, guildId: adopting, serverManager: true };
    const skipper: Actor = { ...actor, guildId: skipping, serverManager: true };
    // Manager authority is unchanged: binding the Officer role still needs Manage Server.
    await expect(
      app.configure({ ...skipper, serverManager: false }, "officer_role_id", officerRole, {
        adoptHolders: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The option belongs to an Officer role binding only.
    await expect(
      app.configure(skipper, "guest_role_id", "75002", { adoptHolders: false }),
    ).rejects.toMatchObject({ code: "input" });
    await expect(
      app.configure(skipper, "officer_role_id", null, { adoptHolders: true }),
    ).rejects.toMatchObject({ code: "input" });
    // Default (true): every current human holder gets an audited manual officer grant.
    expect(await app.configure(adopter, "officer_role_id", officerRole)).toMatchObject({
      status: "saved",
      effects: "queued",
      effectsMode: "live",
      field: "officer_role_id",
      value: officerRole,
      previous: null,
      rebound: false,
      requeued: 0,
      company: null,
      officerHolders: { adopt: true, adopted: 2, sample: ["75101", "75102"] },
    });
    expect(enumerations).toBe(1);
    expect(await overrides(adopting)).toEqual([
      { user: "75101", state: "granted" },
      { user: "75102", state: "granted" },
    ]);
    expect(await audits(adopting)).toEqual([
      {
        action: "config",
        target: "officer_role_id",
        details: { value: officerRole, adoptHolders: true, adopted: 2 },
      },
      { action: "officer.adopt", target: "75101", details: { roleId: officerRole } },
      { action: "officer.adopt", target: "75102", details: { roleId: officerRole } },
    ]);
    expect((await rankAccess(db, await app.guild(adopter), "75101", 21600)).manualOfficer).toBe(
      true,
    );
    // adopt_holders:false: holders are not even enumerated and nobody gains officer access.
    expect(
      await app.configure(skipper, "officer_role_id", officerRole, { adoptHolders: false }),
    ).toMatchObject({ status: "saved", officerHolders: { adopt: false, adopted: 0 } });
    expect(enumerations).toBe(1);
    expect(await overrides(skipping)).toEqual([]);
    expect(await audits(skipping)).toEqual([
      {
        action: "config",
        target: "officer_role_id",
        details: { value: officerRole, adoptHolders: false, adopted: 0 },
      },
    ]);
    expect((await rankAccess(db, await app.guild(skipper), "75101", 21600)).manualOfficer).toBe(
      false,
    );
    // Other role bindings keep their original audit shape.
    await app.configure(skipper, "guest_role_id", "75002");
    expect((await audits(skipping)).at(-1)).toEqual({
      action: "config",
      target: "guest_role_id",
      details: { value: "75002" },
    });
  });

  test("an officer exception granted before the Officer role is bound keeps it through adopt_holders:false", async () => {
    // Production W15 order: record the owner-approved exceptions, then bind the legacy role without
    // adopting holders. The binding's repair pass must not strip the role from an exception.
    const guildId = "666666666666666696";
    const officerRole = "75203";
    const [exception, holder] = ["75201", "75202"];
    for (const id of [exception, holder])
      members.set(id, {
        id,
        guildId,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        nickname: null,
        roles: [officerRole],
        bot: false,
      });
    await db.orm.insert(t.guilds).values({ id: guildId, effects_enabled: true });
    const manager: Actor = { ...actor, guildId, serverManager: true };
    const provisioner: RoleProvisioner = {
      ...discord,
      async ensureRole() {
        throw new Error("No role is provisioned by an officer grant.");
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    // Manager authority is unchanged even though no role is bound yet.
    await expect(
      administration.officer({ ...manager, serverManager: false }, exception, true, "Exception"),
    ).rejects.toThrow("Manage Server");
    // No role is bound, so the grant is only recorded; there is nothing to apply yet.
    expect(
      await administration.officer(manager, exception, true, "Owner-approved exception"),
    ).toEqual({
      status: "granted",
      effects: "recorded",
      effectsMode: "live",
      user: exception,
      reason: "Owner-approved exception",
      present: true,
      previous: null,
    });
    const before = await service.guild(manager);
    expect(before.officer_role_id).toBeNull();
    // Without a bound role the override confers no authority (Service.enrichActor).
    expect(
      (
        await service.enrichActor({
          guildId,
          userId: exception,
          officer: false,
          serverManager: false,
          manageRoles: false,
          roleIds: [officerRole],
        })
      ).officer,
    ).toBe(false);
    // Nothing to reconcile yet: an unbound role is skipped, so the holder keeps the Discord role.
    expect(await reconcileIn(guildId, exception, true)).toMatchObject({ add: [], remove: [] });

    expect(
      await service.configure(manager, "officer_role_id", officerRole, { adoptHolders: false }),
    ).toMatchObject({ status: "saved", officerHolders: { adopt: false, adopted: 0 } });
    // The recorded grant survives the binding, and only it: nobody was adopted.
    expect(
      await db.orm
        .select({ user: t.officerOverrides.user_id, state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(eq(t.officerOverrides.guild_id, guildId)),
    ).toEqual([{ user: exception, state: "granted" }]);
    const bound = await service.guild(manager);
    const granted = await rankAccess(db, bound, exception, 21600);
    expect(granted).toMatchObject({ officer: "yes", manualOfficer: true });
    expect(desiredRankRole(granted.officer, true, granted.fresh, granted.manualOfficer)).toBe(true);
    // The repair pass keeps the exception's role and removes it only from a holder with neither
    // the mapped rank nor a grant.
    expect(await reconcileIn(guildId, exception, true)).toMatchObject({ add: [], remove: [] });
    expect(await reconcileIn(guildId, holder, true)).toMatchObject({
      add: [],
      remove: [officerRole],
    });
    // Once bound, the exception holds bot-officer authority through the role.
    expect(
      (
        await service.enrichActor({
          guildId,
          userId: exception,
          officer: false,
          serverManager: false,
          manageRoles: false,
          roleIds: [officerRole],
        })
      ).officer,
    ).toBe(true);
    // A later grant against the bound role is queued as before.
    expect(await administration.officer(manager, holder, true, "Second exception")).toMatchObject({
      status: "granted",
      effects: "queued",
      effectsMode: "live",
      user: holder,
      reason: "Second exception",
      present: true,
      previous: null,
    });
  });

  /**
   * A pre-existing guild captures its original public/private areas before enabling the opt-in
   * channel policy. `onboarding=false` models a /config-only or imported guild: the same roles and
   * review channel, but no lobby/staff rooms, no @everyone baseline and no channel snapshots.
   */
  async function accessFixture(guildId: string, fcId: string | null = null, onboarding = true) {
    const port = new FakeGuildAccess();
    const remote = port.state(guildId);
    const room = (
      id: string,
      type: ChannelType,
      privateArea = false,
      parentId: string | null = null,
    ): AccessChannel => ({
      id,
      type,
      name: id,
      parentId,
      everyoneVisible: !privateArea,
      memberVisible: !privateArea,
      guestVisible: !privateArea,
      overwrites: privateArea
        ? [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) }]
        : [],
    });
    remote.channels = [
      room("81001", ChannelType.GuildText, false, "81003"),
      room("81002", ChannelType.GuildText, true),
      room("81003", ChannelType.GuildCategory),
      room("81004", ChannelType.GuildVoice),
      room("81005", ChannelType.GuildForum),
      room("81006", ChannelType.GuildCategory, true),
      room("81007", ChannelType.GuildMedia, true, "81006"),
    ];
    const policy = new GuildAccess(service, port);
    await db.transaction(async (client) => {
      await orm(client)
        .insert(t.guilds)
        .values({
          id: guildId,
          fc_id: fcId,
          effects_enabled: true,
          member_role_id: "81101",
          guest_role_id: "81102",
          officer_role_id: "81103",
          leader_role_id: "81104",
          lobby_channel_id: onboarding ? "81001" : null,
          officer_channel_id: onboarding ? "81002" : null,
          access_policy_enabled: onboarding,
          access_everyone_before: onboarding ? remote.everyonePermissions : null,
          guest_application_channel_id: "81002",
          guest_applications_enabled: true,
        });
      if (onboarding)
        await policy.remember(client, guildId, structuredClone(remote), "81001", "81002", false);
    });
    const manager = { ...actor, guildId, serverManager: true };
    return { port, remote, policy, manager, guild: await service.guild(manager) };
  }

  test("channel access retains first snapshots and private areas through partial failure, restart and role replacement", async () => {
    const fixture = await accessFixture("666666666666666671");
    const original = structuredClone(fixture.remote.channels);
    fixture.port.beforeWrite = async (id) => {
      if (id === "81004") throw new Failure("blocked", "Injected channel permission failure");
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toThrow(
      "Injected",
    );
    expect(fixture.port.writes.slice(0, 2)).toEqual(["81001", "everyone"]);
    expect(BigInt(fixture.remote.everyonePermissions) & P.ViewChannel).toBe(0n);
    fixture.port.beforeWrite = undefined;
    const restarted = new GuildAccess(service, fixture.port);
    expect(await restarted.reconcile(fixture.guild.id, async () => {})).toMatchObject({
      status: "secured",
    });
    const writes = fixture.port.writes.length;
    expect(await restarted.reconcile(fixture.guild.id, async () => {})).toMatchObject({
      changed: [],
      defaultChanged: false,
    });
    expect(fixture.port.writes).toHaveLength(writes);
    const saved = await db.orm
      .select()
      .from(t.channelAccessPolicies)
      .where(eq(t.channelAccessPolicies.guild_id, fixture.guild.id));
    for (const row of saved)
      expect(row.original_state).toEqual(original.find((channel) => channel.id === row.channel_id));
    expect(
      saved
        .filter((row) => row.staff_only)
        .map((row) => row.channel_id)
        .sort(),
    ).toEqual(["81002", "81006", "81007"]);
    await service.configure(fixture.manager, "member_role_id", "81109");
    await expect(service.configure(fixture.manager, "guest_role_id", null)).rejects.toThrow(
      "all four roles",
    );
    await expect(
      service.configure({ ...fixture.manager, serverManager: false }, "guest_role_id", "81110"),
    ).rejects.toThrow("Manage Server");
    await restarted.reconcile(fixture.guild.id, async () => {});
    const voice = fixture.remote.channels.find((channel) => channel.id === "81004");
    expect(
      voice?.overwrites.some(
        (overwrite) => overwrite.id === "81101" && (BigInt(overwrite.allow) & P.ViewChannel) !== 0n,
      ),
    ).toBe(false);
    expect(
      voice?.overwrites.some(
        (overwrite) => overwrite.id === "81109" && (BigInt(overwrite.allow) & P.ViewChannel) !== 0n,
      ),
    ).toBe(true);
    expect(
      (
        await db.orm
          .select()
          .from(t.channelAccessPolicies)
          .where(
            and(
              eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
              eq(t.channelAccessPolicies.channel_id, "81001"),
            ),
          )
      )[0]?.original_state,
    ).toEqual(original[0]);
  });

  test("channel effects honor activation, setup exclusion, revision fencing and missing-room readback", async () => {
    const fixture = await accessFixture("666666666666666672");
    const disabled = new Service(db, discord, lodestone, { ...config, ENABLE_EFFECTS: false });
    await expect(
      new GuildAccess(disabled, fixture.port).reconcile(fixture.guild.id, async () => {}),
    ).rejects.toMatchObject({ code: "disabled" });
    const lock = await db.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `setup:${fixture.guild.id}`,
      ]);
      await expect(
        fixture.policy.reconcile(fixture.guild.id, async () => {}),
      ).rejects.toMatchObject({ code: "busy" });
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `setup:${fixture.guild.id}`,
      ]);
      lock.release();
    }
    fixture.port.beforeWrite = async () => {
      await db.orm
        .update(t.guilds)
        .set({ revision: sql`${t.guilds.revision}+1` })
        .where(eq(t.guilds.id, fixture.guild.id));
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(fixture.port.writes).toHaveLength(0);
    fixture.port.beforeWrite = undefined;
    fixture.port.afterWrite = async (id) => {
      if (id === "81007")
        fixture.remote.channels = fixture.remote.channels.filter(
          (channel) => channel.id !== "81002",
        );
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toMatchObject({
      code: "blocked",
    });
    expect(
      await db.orm
        .select()
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, fixture.guild.id),
            eq(t.auditEvents.action, "channels.secured"),
          ),
        ),
    ).toEqual([]);
  });

  test("channel events coalesce without member enumeration and refresh status tracks channel repair", async () => {
    const fixture = await accessFixture("666666666666666673");
    const events = new GuildEvents(db);
    await events.channelChanged(fixture.guild.id);
    await events.channelChanged(fixture.guild.id);
    const pending = await db.orm
      .select()
      .from(t.jobs)
      .where(and(eq(t.jobs.guild_id, fixture.guild.id), eq(t.jobs.kind, "channels.access")));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.generation).toBe(2);
    const parent = await enqueue(
      db.pool,
      "reconcile.guild",
      `guild:${fixture.guild.id}`,
      {},
      fixture.guild.id,
    );
    const [run] = await db.orm
      .insert(t.syncRuns)
      .values({ guild_id: fixture.guild.id, requester_id: actor.userId, job_id: parent })
      .returning();
    if (!run) throw new Error("Missing refresh run");
    await db.orm.insert(t.syncRunJobs).values({ run_id: run.id, job_id: parent });
    let enumerations = 0;
    const app = new Service(
      db,
      {
        ...discord,
        async members() {
          enumerations++;
          return [];
        },
      },
      lodestone,
      config,
    );
    const sync = new Synchronization(app);
    await sync.guild(fixture.guild.id, parent);
    expect(enumerations).toBe(1);
    const children = await db.orm
      .select({ kind: t.jobs.kind })
      .from(t.syncRunJobs)
      .innerJoin(t.jobs, eq(t.jobs.id, t.syncRunJobs.job_id))
      .where(eq(t.syncRunJobs.run_id, run.id));
    expect(children.map((row) => row.kind).sort()).toEqual([
      "channels.access",
      "reconcile.guild",
      "roles.layout",
    ]);
    await dispatcher(app, sync, fixture.policy)(await leased(pending[0]?.id ?? ""), async () => {});
    // A new default-closed channel is ordinary; a newly explicit private channel stays staff-only.
    fixture.remote.channels.push({
      id: "81008",
      name: "new",
      type: ChannelType.GuildStageVoice,
      parentId: null,
      overwrites: [],
      everyoneVisible: false,
      memberVisible: false,
      guestVisible: false,
    });
    const privateChannels: AccessChannel[] = [
      { id: fixture.guild.member_role_id ?? "", type: OverwriteType.Role },
      { id: fixture.guild.guest_role_id ?? "", type: OverwriteType.Role },
      { id: "81901", type: OverwriteType.Role },
      { id: "94001", type: OverwriteType.Member },
    ].map((denied, index) => ({
      id: String(81009 + index),
      name: `private-${denied.id}`,
      type: ChannelType.GuildText,
      parentId: null,
      everyoneVisible: false,
      memberVisible: false,
      guestVisible: false,
      overwrites: [{ ...denied, allow: "0", deny: String(P.ViewChannel) }],
    }));
    fixture.remote.channels.push(...structuredClone(privateChannels));
    await events.channelChanged(fixture.guild.id);
    await fixture.policy.reconcile(fixture.guild.id, async () => {});
    expect(
      (
        await db.orm
          .select()
          .from(t.channelAccessPolicies)
          .where(
            and(
              eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
              eq(t.channelAccessPolicies.channel_id, "81008"),
            ),
          )
      )[0]?.staff_only,
    ).toBe(false);
    for (const original of privateChannels) {
      const [saved] = await db.orm
        .select()
        .from(t.channelAccessPolicies)
        .where(
          and(
            eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
            eq(t.channelAccessPolicies.channel_id, original.id),
          ),
        );
      expect(saved).toMatchObject({ staff_only: true, original_state: original });
      const channel = fixture.remote.channels.find((channel) => channel.id === original.id);
      for (const role of [fixture.guild.member_role_id, fixture.guild.guest_role_id]) {
        const overwrite = channel?.overwrites.find((overwrite) => overwrite.id === role);
        expect(BigInt(overwrite?.allow ?? "0") & P.ViewChannel).toBe(0n);
        expect(BigInt(overwrite?.deny ?? "0") & P.ViewChannel).toBe(P.ViewChannel);
      }
    }
    expect(enumerations).toBe(1);
    await db.orm.insert(t.guilds).values({ id: "666666666666666679" });
    await events.channelChanged("666666666666666679");
    expect(
      await db.orm.select().from(t.jobs).where(eq(t.jobs.guild_id, "666666666666666679")),
    ).toEqual([]);
  });

  test("reserved community resources are neither snapshotted nor enforced and cannot become onboarding bindings", async () => {
    const fixture = await accessFixture("666666666666666680");
    const reserved: AccessChannel[] = [
      {
        id: "81400",
        name: "Admin",
        type: ChannelType.GuildCategory,
        parentId: null,
        overwrites: [],
        everyoneVisible: true,
        memberVisible: true,
        guestVisible: true,
      },
      {
        id: "81401",
        name: "community-updates",
        type: ChannelType.GuildText,
        parentId: "81400",
        overwrites: [],
        everyoneVisible: true,
        memberVisible: true,
        guestVisible: true,
      },
    ];
    fixture.remote.channels.push(...structuredClone(reserved));
    fixture.remote.excludedChannelIds = reserved.map((channel) => channel.id);
    fixture.remote.preserveEveryoneView = true;
    const everyone = fixture.remote.everyonePermissions;
    const result = await fixture.policy.reconcile(fixture.guild.id, async () => {});
    expect(result).toMatchObject({
      status: "secured",
      channels: 7,
      excludedChannels: fixture.remote.excludedChannelIds,
      preservedEveryoneView: true,
      defaultChanged: false,
    });
    expect(fixture.remote.everyonePermissions).toBe(everyone);
    expect(
      fixture.remote.channels.filter((channel) =>
        fixture.remote.excludedChannelIds.includes(channel.id),
      ),
    ).toEqual(reserved);
    expect(
      await db.orm
        .select()
        .from(t.channelAccessPolicies)
        .where(
          and(
            eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
            inArray(t.channelAccessPolicies.channel_id, fixture.remote.excludedChannelIds),
          ),
        ),
    ).toEqual([]);
    expect(fixture.port.writes.some((id) => fixture.remote.excludedChannelIds.includes(id))).toBe(
      false,
    );
    const writes = fixture.port.writes.length;
    expect(
      await new GuildAccess(service, fixture.port).reconcile(fixture.guild.id, async () => {}),
    ).toMatchObject({ changed: [], defaultChanged: false });
    expect(fixture.port.writes).toHaveLength(writes);
    await db.orm
      .update(t.guilds)
      .set({ officer_channel_id: "81401", revision: sql`${t.guilds.revision}+1` })
      .where(eq(t.guilds.id, fixture.guild.id));
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toThrow(
      "reserved community channel",
    );
    expect(fixture.port.writes).toHaveLength(writes);
  });

  test("large-guild reconciliation uses two catalogues and reads only changed targets", async () => {
    // Exercise the real application loop, SDK adapter, and database together; count REST endpoints.
    // The budget is the same before 2026-11-16 ("off": REST lists the hidden community area) and
    // after it ("enforced": REST leaves it out and it is never read one by one), #47.
    for (const obfuscation of ["off", "enforced"] as const) {
      const fixture = discordAccessFixture();
      fixture.discord.obfuscation = obfuscation;
      try {
        const everyone = fixture.roles.find((role) => role.id === "100");
        if (!everyone) throw new Error("Missing everyone role");
        everyone.permissions = String(BigInt(everyone.permissions) & ~P.ViewChannel);
        const closed = [
          { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
        ];
        const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
        const updates = fixture.add(
          "community-updates",
          ChannelType.GuildText,
          structuredClone(closed),
          parent.id,
        );
        fixture.community.updatesChannelId = updates.id;
        const lobby = fixture.add(
          "lobby",
          ChannelType.GuildText,
          channelAccessOverwrites([], "100", "900", fixture.bindings, "lobby"),
        );
        const officers = fixture.add(
          "officer-chat",
          ChannelType.GuildText,
          channelAccessOverwrites([], "100", "900", fixture.bindings, "officers"),
        );
        const ordinary = Array.from({ length: 80 }, (_, index) =>
          fixture.add(
            `room-${index}`,
            ChannelType.GuildText,
            channelAccessOverwrites([], "100", "900", fixture.bindings, "members"),
          ),
        );
        // Each mode starts from the same guild row and no remembered policies.
        const binding = {
          effects_enabled: true,
          access_policy_enabled: true,
          lobby_channel_id: lobby.id,
          officer_channel_id: officers.id,
          member_role_id: fixture.bindings.member,
          guest_role_id: fixture.bindings.guest,
          officer_role_id: fixture.bindings.officer,
          leader_role_id: fixture.bindings.leader,
          access_everyone_before: everyone.permissions,
        };
        await db.orm
          .insert(t.guilds)
          .values({ id: "100", ...binding })
          .onConflictDoUpdate({
            target: t.guilds.id,
            set: { ...binding, revision: sql`${t.guilds.revision}+1` },
          });
        await db.orm
          .delete(t.channelAccessPolicies)
          .where(eq(t.channelAccessPolicies.guild_id, "100"));
        const policy = new GuildAccess(service, fixture.port);
        expect({
          obfuscation,
          result: await policy.reconcile("100", async () => {}),
        }).toMatchObject({
          obfuscation,
          result: {
            status: "secured",
            channels: 82,
            changed: [],
            defaultChanged: false,
          },
        });
        expect(fixture.reads.filter((route) => route === "/guilds/100/channels")).toHaveLength(2);
        expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toHaveLength(0);
        expect(fixture.writes).toEqual([]);
        fixture.reads.length = 0;
        const changed = ordinary[0];
        if (!changed) throw new Error("Missing drift target");
        changed.permission_overwrites = [];
        expect(await policy.reconcile("100", async () => {})).toMatchObject({
          status: "secured",
          changed: [changed.id],
        });
        expect(fixture.reads.filter((route) => route === "/guilds/100/channels")).toHaveLength(2);
        expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toEqual([
          `/channels/${changed.id}`,
          `/channels/${changed.id}`,
        ]);
        expect(fixture.writes).toEqual([`/channels/${changed.id}`]);
        expect([parent.permission_overwrites, updates.permission_overwrites]).toEqual([
          closed,
          closed,
        ]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("a whole reconcile under channel obfuscation secures around a hidden updates area and refuses a hidden managed channel (#47)", async () => {
    // Discord from 2026-11-16 (the fixture's default): REST leaves out channels the bot can't
    // view, and the gateway cache holds them obfuscated. Guild 100 is shared with the test above,
    // so its row is upserted and its policies cleared.
    const fixture = discordAccessFixture();
    try {
      const closed = [
        { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      ];
      const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
      const updates = fixture.add(
        "moderator-only",
        ChannelType.GuildText,
        structuredClone(closed),
        parent.id,
      );
      fixture.community.updatesChannelId = updates.id;
      const lobby = fixture.add("lobby");
      const officers = fixture.add("officer-chat", ChannelType.GuildText, [
        ...structuredClone(closed),
        { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      ]);
      const general = fixture.add("general");
      expect([fixture.hidden(parent), fixture.hidden(updates)]).toEqual([true, true]);
      const everyone = fixture.roles.find((role) => role.id === "100")?.permissions;
      if (!everyone) throw new Error("Missing everyone role");
      const binding = {
        effects_enabled: true,
        access_policy_enabled: true,
        lobby_channel_id: lobby.id,
        officer_channel_id: officers.id,
        member_role_id: fixture.bindings.member,
        guest_role_id: fixture.bindings.guest,
        officer_role_id: fixture.bindings.officer,
        leader_role_id: fixture.bindings.leader,
        access_everyone_before: everyone,
      };
      await db.orm
        .insert(t.guilds)
        .values({ id: "100", ...binding })
        .onConflictDoUpdate({
          target: t.guilds.id,
          set: { ...binding, revision: sql`${t.guilds.revision}+1` },
        });
      await db.orm
        .delete(t.channelAccessPolicies)
        .where(eq(t.channelAccessPolicies.guild_id, "100"));
      const policy = new GuildAccess(service, fixture.port);
      // Secured, with the area excluded and the default kept: no superseded retry loop.
      expect(await policy.reconcile("100", async () => {})).toMatchObject({
        status: "secured",
        channels: 3,
        defaultChanged: false,
        excludedChannels: [parent.id, updates.id].sort(),
        preservedEveryoneView: true,
      });
      expect(
        BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") & P.ViewChannel,
      ).toBe(P.ViewChannel);
      const guild = await fixture.client.guilds.fetch("100");
      const newcomer = await guild.members.fetch("400"),
        member = await guild.members.fetch("401");
      const room = await guild.channels.fetch(general.id);
      expect(room?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
      expect(room?.permissionsFor(member).has(P.ViewChannel)).toBe(true);
      const protectedRoutes = [`/channels/${parent.id}`, `/channels/${updates.id}`];
      expect(fixture.reads.filter((route) => protectedRoutes.includes(route))).toEqual([]);
      expect(fixture.writes.filter((route) => protectedRoutes.includes(route))).toEqual([]);
      // A second pass is a no-op.
      const writes = fixture.writes.length;
      expect(await policy.reconcile("100", async () => {})).toMatchObject({
        status: "secured",
        changed: [],
        preservedEveryoneView: true,
      });
      expect(fixture.writes).toHaveLength(writes);
      // A channel onboarding should manage but TaruBot can't see blocks the pass, named, with
      // nothing written: it isn't silently left out.
      const secret = fixture.add("secret", ChannelType.GuildText, [
        { id: "600", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      ]);
      fixture.reads.length = 0;
      await expect(policy.reconcile("100", async () => {})).rejects.toMatchObject({
        code: "blocked",
        message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${secret.id}>.`,
        detail: {
          kind: "resource",
          resource: "channel",
          id: secret.id,
          fix: "channel_permissions",
        },
      });
      expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toEqual([
        `/channels/${secret.id}`,
      ]);
      expect(fixture.writes).toHaveLength(writes);
      // Once TaruBot can see it again, the next pass manages it.
      secret.permission_overwrites = [];
      expect(await policy.reconcile("100", async () => {})).toMatchObject({
        status: "secured",
        channels: 4,
        changed: [secret.id],
        preservedEveryoneView: true,
      });
    } finally {
      await fixture.close();
    }
  });

  /**
   * Registered-visitor Guest is computed identically with lobby onboarding enabled or disabled
   * (ROLE-07, ACCESS-04); each pass uses its own guild, users and characters.
   */
  const verifiedVisitorScenario = async (pass: {
    onboarding: boolean;
    guild: string;
    users: readonly [string, string];
    characters: readonly [string, string];
  }) => {
    const [firstUser, secondUser] = pass.users;
    const fixture = await accessFixture(pass.guild, fc, pass.onboarding);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    const visitor = {
      id: pass.characters[0],
      name: "Verified Visitor",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
    };
    await service.assign(fixture.manager, firstUser, visitor, "Trusted visitor");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(false);
    const reconcile = async (user: string) =>
      sync.user(
        await leased(
          await enqueue(
            db.pool,
            "reconcile.user",
            `user:${fixture.guild.id}:${user}`,
            {},
            fixture.guild.id,
            user,
          ),
        ),
        async () => {},
      );
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).toContain(fixture.guild.guest_role_id ?? "");
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.member_role_id ?? "");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(true);
    expect(
      await db.orm
        .select()
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, fixture.guild.id), eq(t.guestGrants.user_id, firstUser)),
        ),
    ).toEqual([]);
    await expect(
      service.apply(
        { ...fixture.manager, userId: firstUser, officer: false, serverManager: false },
        await applicationInput({ ...fixture.manager, userId: firstUser }),
      ),
    ).rejects.toMatchObject({ code: "eligible" });
    await service.guestAction(fixture.manager, firstUser, true, "Explicit revoke", randomUUID());
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const events = new GuildEvents(db);
    await events.memberLeft(fixture.guild.id, firstUser);
    const rejoined = members.get(firstUser);
    if (!rejoined) throw new Error("Missing rejoining visitor");
    rejoined.joinedAt = new Date();
    await events.memberJoined(fixture.guild.id, firstUser, rejoined.joinedAt);
    const restarted = new Service(db, discord, lodestone, config);
    expect(await restarted.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(
      false,
    );
    await reconcile(firstUser);
    expect(rejoined.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    // Positive accepted roster evidence grants Member even though the independent Guest revoke persists.
    const [positive] = await db.orm
      .insert(t.rosterSnapshots)
      .values({
        fc_id: fc,
        started_at: new Date(),
        observed_at: new Date(),
        member_count: 1,
        evidence: { fixture: true },
      })
      .returning();
    if (!positive) throw new Error("Missing positive snapshot");
    await db.orm
      .insert(t.rosterMembers)
      .values({ snapshot_id: positive.id, character_id: visitor.id });
    await db.orm
      .update(t.membership)
      .set({ state: "present", snapshot_id: positive.id, confirmed_snapshot_id: positive.id })
      .where(
        and(
          eq(t.membership.guild_id, fixture.guild.id),
          eq(t.membership.character_id, visitor.id),
          eq(t.membership.fc_id, fc),
        ),
      );
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).toContain(fixture.guild.member_role_id ?? "");
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const second = { ...visitor, id: pass.characters[1] };
    await service.assign(fixture.manager, secondUser, second, "Second visitor");
    await reconcile(secondUser);
    const current = members.get(secondUser);
    if (!current) throw new Error("Missing second visitor");
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()-interval '7 hours'` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile(secondUser);
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    current.roles = [];
    await reconcile(secondUser);
    expect(current.roles).toEqual([]);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile(secondUser);
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await service.unclaim(
      { ...fixture.manager, userId: secondUser, officer: false },
      secondUser,
      second.id,
    );
    await reconcile(secondUser);
    expect(current.roles).not.toContain(fixture.guild.guest_role_id ?? "");
  };
  for (const pass of [
    {
      onboarding: true,
      guild: "666666666666666674",
      users: ["94001", "94002"],
      characters: ["77777200", "77777201"],
    },
    {
      onboarding: false,
      guild: "666666666666666682",
      users: ["94011", "94012"],
      characters: ["77777210", "77777211"],
    },
  ] as const)
    test(`verified visitors get derived Guest access while revocation, FC membership, staleness and unlink remain authoritative (onboarding ${pass.onboarding ? "enabled" : "disabled"})`, () =>
      verifiedVisitorScenario(pass));

  /** Run one leased user pass exactly as the worker would (or as a preview), without a queue loop. */
  async function reconcileIn(guildId: string, user: string, preview = false) {
    const work = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${guildId}:${user}`,
      {},
      guildId,
      user,
    );
    return sync.user(await leased(work), async () => {}, preview);
  }

  /**
   * Publish one accepted roster for an isolated FC through the real acquisition path. An explicit
   * observation instant lets departure confirmation (two absences 60 s apart) run without waiting.
   * Another Synchronization runs it under a different configuration, such as DevBot's test guild.
   */
  async function publishRoster(
    fcId: string,
    roster: Roster["members"],
    observedAt = new Date(),
    synchronization = sync,
  ) {
    lodestone.rosterValue = {
      company: {
        id: fcId,
        name: "Isolated FC",
        tag: "ISO",
        world: "Diabolos",
        dc: "Crystal",
        count: roster.length,
      },
      members: roster,
      startedAt: new Date(observedAt.getTime() - 1000),
      observedAt,
      pages: 1,
    };
    await db.orm
      .update(t.freeCompanies)
      .set({ last_attempt_at: sql`now()-interval '61 seconds'` })
      .where(eq(t.freeCompanies.id, fcId));
    // The dedupe key coalesces with an early acquisition that seedFreshLink may already have queued.
    const key = await enqueue(db.pool, "roster", `roster:${fcId}`, { fcId });
    try {
      await synchronization.roster(await leased(key), async () => {});
    } finally {
      await db.orm
        .update(t.jobs)
        .set({ status: "succeeded", lease_until: null })
        .where(eq(t.jobs.id, key));
    }
    return key;
  }

  /** No onboarding means no channel-visibility work at all: no queued job and no snapshot rows. */
  async function expectNoChannelWork(guildId: string) {
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.kind, "channels.access"))),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ channel_id: t.channelAccessPolicies.channel_id })
        .from(t.channelAccessPolicies)
        .where(eq(t.channelAccessPolicies.guild_id, guildId)),
    ).toEqual([]);
  }

  test("registered visitor access applies with onboarding disabled, is guild-scoped and works before linking an FC", async () => {
    const fixture = await accessFixture("666666666666666675");
    const character = {
      id: "77777202",
      name: "Local Registration",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(fixture.manager, "94003", character, "FC-less registration");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "94003")).toBe(true);
    await reconcileIn(fixture.guild.id, "94003");
    expect(members.get("94003")?.roles).toContain(fixture.guild.guest_role_id ?? "");
    const other = await accessFixture("666666666666666676");
    expect(await service.registrationGuestEligible(db.pool, other.guild, "94003")).toBe(false);
    // A /config-only guild (no /setup, so no onboarding) with active effects and no linked FC.
    const legacy = { ...fixture.manager, guildId: "666666666666666678" };
    await db.orm.insert(t.guilds).values({
      id: legacy.guildId,
      effects_enabled: true,
      member_role_id: "81201",
      guest_role_id: "81202",
    });
    await service.assign(legacy, "94003", character, "Legacy local link");
    const configured = await service.guild(legacy);
    expect(configured.access_policy_enabled).toBe(false);
    // Registration alone is a Guest credential in every configured guild (ROLE-07).
    expect(await service.registrationGuestEligible(db.pool, configured, "94003")).toBe(true);
    await reconcileIn(legacy.guildId, "94003");
    expect(members.get("94003")?.roles).toContain("81202");
    // Guild reconciliation still covers the user but performs no channel-visibility work.
    const visitor = members.get("94003");
    if (!visitor) throw new Error("Missing registered visitor");
    const enumerating = new Synchronization(
      new Service(
        db,
        {
          ...discord,
          async members() {
            return [visitor];
          },
        },
        lodestone,
        config,
      ),
    );
    const parent = await enqueue(
      db.pool,
      "reconcile.guild",
      `guild:${legacy.guildId}`,
      {},
      legacy.guildId,
    );
    expect(await enumerating.guild(legacy.guildId, parent)).toMatchObject({ humans: 1 });
    await expectNoChannelWork(legacy.guildId);
  });

  test("multi-character union grants Member, Officer and registered Guest with onboarding disabled", async () => {
    // An isolated FC keeps this roster from moving links in guilds bound to the legacy fixture FC.
    const unionFc = "9232097761132950001";
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: unionFc, name: "Union FC", world: "Diabolos", dc: "Crystal" });
    const fixture = await accessFixture("666666666666666683", unionFc, false);
    await service.configureOfficerRank(fixture.manager, "Officer");
    const ranked = (id: string, rank: string) => ({
      id,
      name: `Union ${rank} ${id}`,
      world: "Diabolos",
      dc: "Crystal",
      fcId: unionFc,
      fcRankName: rank,
      isFcLeader: false,
    });
    const outside = (id: string) => ({
      id,
      name: `Union Visitor ${id}`,
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    });
    const officerA = ranked("88000001", "Officer");
    const memberB = ranked("88000002", "Member");
    const officerC = ranked("88000007", "Officer");
    await publishRoster(unionFc, [officerA, memberB, officerC]);
    // Each user links one or more characters; the FC characters gain evidence from the fresh roster
    // at assignment, and the outside characters are evaluated absent by seedFreshLink.
    await service.assign(fixture.manager, "95001", officerA, "Union officer character");
    await service.assign(fixture.manager, "95001", outside("88000003"), "Union alt character");
    await service.assign(fixture.manager, "95002", memberB, "Union member character");
    await service.assign(fixture.manager, "95002", outside("88000004"), "Union alt character");
    await service.assign(fixture.manager, "95003", outside("88000005"), "Registered visitor");
    await service.assign(fixture.manager, "95003", outside("88000006"), "Registered visitor alt");
    // A bot-only officer can vouch for membership but cannot make anyone an officer.
    const botOfficer = { ...fixture.manager, userId: "95090", serverManager: false };
    await service.assign(botOfficer, "95004", officerC, "Bot-only officer assignment");
    for (const user of ["95001", "95002", "95003", "95004"])
      await reconcileIn(fixture.guild.id, user);
    const roles = (user: string) => members.get(user)?.roles ?? [];
    const {
      member_role_id: member,
      guest_role_id: guest,
      officer_role_id: officer,
    } = fixture.guild;
    expect(roles("95001")).toContain(member ?? "");
    expect(roles("95001")).toContain(officer ?? "");
    expect(roles("95001")).not.toContain(guest ?? "");
    expect(roles("95002")).toContain(member ?? "");
    expect(roles("95002")).not.toContain(officer ?? "");
    expect(roles("95002")).not.toContain(guest ?? "");
    expect(roles("95003")).toEqual([guest ?? ""]);
    // The Guest is derived from registration alone: no durable grant and no former-member history.
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, fixture.guild.id), eq(t.guestGrants.user_id, "95003")),
        ),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ id: t.membershipHistory.id })
        .from(t.membershipHistory)
        .where(
          and(
            eq(t.membershipHistory.guild_id, fixture.guild.id),
            eq(t.membershipHistory.user_id, "95003"),
          ),
        ),
    ).toEqual([]);
    expect(roles("95004")).toContain(member ?? "");
    expect(roles("95004")).not.toContain(officer ?? "");
    // Unlinking the only FC character leaves an outside link: Member and Officer end, Guest begins.
    await service.unclaim(fixture.manager, "95001", officerA.id, "Officer character moved");
    await reconcileIn(fixture.guild.id, "95001");
    expect(roles("95001")).not.toContain(member ?? "");
    expect(roles("95001")).not.toContain(officer ?? "");
    expect(roles("95001")).toContain(guest ?? "");
    expect(
      (
        await db.orm
          .select({ local_member_loss: t.guildUsers.local_member_loss })
          .from(t.guildUsers)
          .where(
            and(eq(t.guildUsers.guild_id, fixture.guild.id), eq(t.guildUsers.user_id, "95001")),
          )
      )[0]?.local_member_loss,
    ).toBe(true);
    await expectNoChannelWork(fixture.guild.id);
  });

  test("unknown and stale evidence delay registered Guest in onboarding-disabled guilds", async () => {
    // No accepted snapshot is newer than the freshness window, so a new link stays unevaluated.
    const staleFc = "9232097761132950002";
    await db.orm.insert(t.freeCompanies).values({
      id: staleFc,
      name: "Stale FC",
      world: "Diabolos",
      dc: "Crystal",
      last_successful_roster_at: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    const fixture = await accessFixture("666666666666666684", staleFc, false);
    const character = {
      id: "88000008",
      name: "Stale Visitor",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(
      fixture.manager,
      "95005",
      character,
      "Registration while evidence is stale",
    );
    await reconcileIn(fixture.guild.id, "95005");
    expect(members.get("95005")?.roles).toEqual([]);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "95005")).toBe(false);
    // seedFreshLink requested an early acquisition instead of guessing from stale evidence.
    const early = await db.orm
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(
        and(
          eq(t.jobs.kind, "roster"),
          eq(t.jobs.dedupe_key, `roster:${staleFc}`),
          eq(t.jobs.status, "queued"),
        ),
      );
    expect(early).toHaveLength(1);
    expect(
      await publishRoster(staleFc, [
        {
          id: "88000009",
          name: "Stale Member",
          world: "Diabolos",
          dc: "Crystal",
          fcId: staleFc,
          fcRankName: "Member",
        },
      ]),
    ).toBe(early[0]?.id ?? "");
    // Preview and the worker agree once the link is evaluated against fresh accepted evidence.
    expect(await reconcileIn(fixture.guild.id, "95005", true)).toMatchObject({
      desired: { member: false, guest: true },
      add: [fixture.guild.guest_role_id],
    });
    await reconcileIn(fixture.guild.id, "95005");
    expect(members.get("95005")?.roles).toEqual([fixture.guild.guest_role_id ?? ""]);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "95005")).toBe(true);
    await expectNoChannelWork(fixture.guild.id);
  });

  test("onboarding-disabled reconciliation supersedes a pending application once the applicant registers", async () => {
    const fixture = await accessFixture("666666666666666685", null, false);
    const applicant = { ...fixture.manager, userId: "95006", officer: false, serverManager: false };
    const pending = await service.apply(applicant, await applicationInput(applicant));
    const review = and(
      eq(t.jobs.kind, "guest.review"),
      eq(t.jobs.dedupe_key, `review:${pending.id}`),
    );
    // Treat the submission's review message as delivered, so a new job can only come from reconcile.
    await db.orm.update(t.jobs).set({ status: "succeeded" }).where(review);
    await service.assign(
      fixture.manager,
      applicant.userId,
      { id: "88000010", name: "Late Registration", world: "Diabolos", dc: "Crystal", fcId: null },
      "Applicant registered a character",
    );
    await reconcileIn(fixture.guild.id, applicant.userId);
    expect(
      (
        await db.orm
          .select({ state: t.guestApplications.state })
          .from(t.guestApplications)
          .where(eq(t.guestApplications.id, pending.id))
      )[0]?.state,
    ).toBe("superseded");
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(review, eq(t.jobs.status, "queued"))),
    ).toHaveLength(1);
    expect(members.get(applicant.userId)?.roles).toContain(fixture.guild.guest_role_id ?? "");
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(
            eq(t.guestGrants.guild_id, fixture.guild.id),
            eq(t.guestGrants.user_id, applicant.userId),
          ),
        ),
    ).toEqual([]);
    await expectNoChannelWork(fixture.guild.id);
  });

  /**
   * A synthetic imported guild awaiting its first activation: its own FC (so its rosters never move
   * other tests' links), four managed roles, applications closed unless a legacy review channel is
   * given, the 'pending' marker, effects off, and a migration.import audit an hour old, so a roster
   * published now counts as post-import evidence.
   */
  async function importedGuild(guildId: string, fcId: string, channel: string | null = null) {
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: fcId, name: `Cutover FC ${fcId}`, world: "Diabolos", dc: "Crystal" })
      .onConflictDoNothing();
    await db.orm.insert(t.guilds).values({
      id: guildId,
      fc_id: fcId,
      member_role_id: "82101",
      guest_role_id: "82102",
      officer_role_id: "82103",
      leader_role_id: "82104",
      guest_application_channel_id: channel,
      role_layout_enabled: false,
      guest_grandfather: "pending",
      effects_enabled: false,
    });
    await db.orm.insert(t.auditEvents).values({
      guild_id: guildId,
      action: "migration.import",
      target: `fingerprint:${guildId}`,
      details: { guestGrandfather: "pending" },
      event_at: sql`now()-interval '1 hour'`,
    });
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
    if (!row) throw new Error("Missing imported guild fixture");
    return row;
  }

  /** An imported human (guild_users.imported), optionally owning one active character link. */
  async function importedHuman(guildId: string, user: string, character?: string) {
    await ensureUser(db.pool, guildId, user, new Date("2026-01-01T00:00:00Z"));
    await db.orm
      .update(t.guildUsers)
      .set({ imported: true })
      .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, user)));
    if (character) return linkCharacter(guildId, user, character);
    return null;
  }

  /** An active link to a new character, as the importer or /assign would store it. */
  async function linkCharacter(guildId: string, user: string, character: string) {
    await db.orm
      .insert(t.characters)
      .values({ id: character, name: `Cutover ${character}`, world: "Diabolos", dc: "Crystal" })
      .onConflictDoNothing();
    const [link] = await db.orm
      .insert(t.links)
      .values({
        guild_id: guildId,
        user_id: user,
        character_id: character,
        provenance: "imported_link",
      })
      .returning({ id: t.links.id });
    if (!link) throw new Error("Missing link fixture");
    return link.id;
  }

  /** A roster member of the given FC, as the Lodestone adapter reports one. */
  const rosterMember = (id: string, fcId: string) => ({
    id,
    name: `Cutover ${id}`,
    world: "Diabolos",
    dc: "Crystal",
    fcId,
    fcRankName: "Member",
  });

  /** A current Discord member view; bots are enumerated too and must never be grandfathered. */
  const memberView = (
    guildId: string,
    id: string,
    roles: string[] = [],
    joinedAt = new Date("2026-01-01T00:00:00Z"),
    bot = false,
  ): MemberView => ({ id, guildId, joinedAt, nickname: null, roles, bot });

  /** Everything a refused activation must leave untouched in a pending guild. */
  async function expectNotActivated(guildId: string) {
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
    expect(row).toMatchObject({
      guest_grandfather: "pending",
      guest_grandfathered_at: null,
      effects_enabled: false,
    });
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, guildId), eq(t.guestGrants.provenance, "grandfathered")),
        ),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ action: t.auditEvents.action })
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, guildId),
            inArray(t.auditEvents.action, [
              "activation",
              "guest.grandfather",
              "guest.grandfather.completed",
            ]),
          ),
        ),
    ).toEqual([]);
  }

  /** Audit rows of one action in one guild. */
  const auditsOf = (guildId: string, action: string) =>
    db.orm
      .select({ target: t.auditEvents.target, details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.guild_id, guildId), eq(t.auditEvents.action, action)));

  // The first-activation scenario: the first test activates it, the second reconciles it.
  const cutover = {
    guild: "666666666666666700",
    fc: "9232097761132950010",
    present: "97001",
    memberWithoutLink: "97002",
    roleless: "97003",
    importedGuest: "97004",
    revoked: "97005",
    absentLink: "97006",
    uncertain: "97007",
    newcomer: "97008",
    bot: "97090",
    lateJoiner: "97009",
  } as const;
  let cutoverEnumeratedAt: Date | null = null;

  test("first activation grandfathers current non-member humans exactly once with audit", async () => {
    const { guild: id, fc: fcId } = cutover;
    const row = await importedGuild(id, fcId);
    const member = row.member_role_id ?? "";
    const guest = row.guest_role_id ?? "";
    await importedHuman(id, cutover.present, "88100001");
    for (const user of [
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.importedGuest,
      cutover.revoked,
      cutover.uncertain,
    ])
      await importedHuman(id, user);
    await importedHuman(id, cutover.absentLink, "88100006");
    await db.orm.insert(t.guestGrants).values({
      guild_id: id,
      user_id: cutover.importedGuest,
      provenance: "imported_guest",
      source_key: `import:cutover:guest:${id}:${cutover.importedGuest}`,
    });
    await db.orm
      .insert(t.guestState)
      .values({ guild_id: id, user_id: cutover.revoked, revoked: true, reason: "Imported ban" });
    // The accepted post-import roster: the present link is observed, the other link is absent.
    await publishRoster(fcId, [rosterMember("88100001", fcId)]);
    // A link stored after that roster has no evidence yet, so its owner is uncertain.
    await linkCharacter(id, cutover.uncertain, "88100007");
    const views = [
      memberView(id, cutover.present, [member]),
      memberView(id, cutover.memberWithoutLink, [member]),
      memberView(id, cutover.roleless),
      memberView(id, cutover.importedGuest, [guest]),
      memberView(id, cutover.revoked),
      memberView(id, cutover.absentLink),
      memberView(id, cutover.uncertain, [member]),
      // Joined after the cutover snapshot: no guild_users row yet.
      memberView(id, cutover.newcomer, [], new Date("2026-09-20T00:00:00Z")),
      memberView(id, cutover.bot, [], new Date("2026-01-01T00:00:00Z"), true),
    ];
    for (const view of views) members.set(view.id, structuredClone(view));
    const enumeratedAt = new Date();
    cutoverEnumeratedAt = enumeratedAt;
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    const planned = [
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.absentLink,
      cutover.uncertain,
      cutover.newcomer,
    ];
    expect(plan.grants).toEqual(planned);
    expect(grandfatherReport({ state: "pending", plan, completedAt: null })).toMatchObject({
      humans: 8,
      bots: 1,
      memberEligible: 1,
      planned: { count: 5 },
      plannedDetail: {
        // The uncertain holder keeps Member behind a dormant grant; only the unlinked one loses it.
        memberRoleRemoved: { count: 1, sample: [cutover.memberWithoutLink] },
        uncertainKeepsMember: { count: 1, sample: [cutover.uncertain] },
        registeredVisitors: { count: 2, sample: [cutover.absentLink, cutover.uncertain] },
        newSinceImport: { count: 1, sample: [cutover.newcomer] },
      },
      skipped: {
        existingGrant: { count: 1, sample: [cutover.importedGuest] },
        revoked: { count: 1, sample: [cutover.revoked] },
      },
    });
    const [revocation] = await db.orm
      .select()
      .from(t.guestState)
      .where(and(eq(t.guestState.guild_id, id), eq(t.guestState.user_id, cutover.revoked)));
    const result = await activateGuild(db, {
      guildId: id,
      freshnessSeconds: 21600,
      resourcesValidated: true,
      members: views,
      enumeratedAt,
      grandfatherPlan: plan.checksum,
    });
    expect(result).toMatchObject({
      status: "activated",
      requeued: false,
      revision: row.revision + 1n,
      grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 5 },
      guestApplications: "closed",
      onboarding: false,
      roleLayout: "disabled",
    });
    const grants = await db.orm
      .select({
        user: t.guestGrants.user_id,
        key: t.guestGrants.source_key,
        actor: t.guestGrants.actor_id,
        source: t.guestGrants.source,
      })
      .from(t.guestGrants)
      .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered")));
    expect(grants.map((grant) => grant.user).sort()).toEqual(planned);
    for (const grant of grants) {
      expect(grant.key).toBe(`grandfather:${id}:${grant.user}`);
      expect(grant.actor).toBeNull();
      expect(grant.source).toMatchObject({
        planChecksum: plan.checksum,
        enumeratedAt: enumeratedAt.toISOString(),
      });
    }
    expect(await auditsOf(id, "guest.grandfather")).toHaveLength(5);
    // The completion audit keeps enumeratedAt for the late-joiner report (C9).
    expect(await auditsOf(id, "guest.grandfather.completed")).toEqual([
      {
        target: id,
        details: expect.objectContaining({
          planChecksum: plan.checksum,
          granted: 5,
          enumeratedAt: enumeratedAt.toISOString(),
          counts: expect.objectContaining({ humans: 8, bots: 1, planned: 5, revoked: 1 }),
        }),
      },
    ]);
    expect(await auditsOf(id, "activation")).toEqual([
      {
        target: id,
        details: expect.objectContaining({
          grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 5 },
        }),
      },
    ]);
    const [activated] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id));
    expect(activated).toMatchObject({
      guest_grandfather: "completed",
      effects_enabled: true,
      active: true,
    });
    expect(activated?.guest_grandfathered_at).toBeInstanceOf(Date);
    expect(
      await db.orm
        .select({ status: t.jobs.status })
        .from(t.jobs)
        .where(and(eq(t.jobs.kind, "reconcile.guild"), eq(t.jobs.dedupe_key, `guild:${id}`))),
    ).toEqual([{ status: "queued" }]);
    // The revocation stands untouched, and the newcomer's guild row now exists.
    expect(
      (
        await db.orm
          .select()
          .from(t.guestState)
          .where(and(eq(t.guestState.guild_id, id), eq(t.guestState.user_id, cutover.revoked)))
      )[0],
    ).toEqual(revocation);
    expect(
      (
        await db.orm
          .select({ present: t.guildUsers.present, imported: t.guildUsers.imported })
          .from(t.guildUsers)
          .where(and(eq(t.guildUsers.guild_id, id), eq(t.guildUsers.user_id, cutover.newcomer)))
      )[0],
    ).toEqual({ present: true, imported: false });

    // A rerun on the live guild, even with a new joiner, is a no-op (amendment C11).
    const state = async () => ({
      revision: (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id)))[0]?.revision,
      audits: (
        await db.query<{ count: bigint }>("SELECT count(*) FROM audit WHERE guild_id=$1", [id])
      )[0]?.count,
      jobs: await db.query("SELECT id,status,generation FROM jobs WHERE guild_id=$1 ORDER BY id", [
        id,
      ]),
      grants: (
        await db.query<{ count: bigint }>("SELECT count(*) FROM guest_grants WHERE guild_id=$1", [
          id,
        ])
      )[0]?.count,
    });
    const settled = await state();
    const withJoiner = [...views, memberView(id, cutover.lateJoiner, [], new Date())];
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: false,
        members: withJoiner,
        enumeratedAt: new Date(),
        grandfatherPlan: plan.checksum,
      }),
    ).toMatchObject({
      status: "already_active",
      revision: row.revision + 1n,
      grandfathering: { state: "completed", granted: 0 },
    });
    expect(await state()).toEqual(settled);
    // An explicit requeue repeats only the activation writes; grandfathering never runs again.
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: withJoiner,
        enumeratedAt: new Date(),
        requeue: true,
      }),
    ).toMatchObject({
      status: "activated",
      requeued: true,
      revision: row.revision + 2n,
      grandfathering: { state: "completed", planChecksum: null, granted: 0 },
    });
    expect((await state()).grants).toBe(settled.grants);
    expect(await auditsOf(id, "guest.grandfather")).toHaveLength(5);
    expect(await auditsOf(id, "activation")).toHaveLength(2);
  });

  test("grandfathered grants behave like approved grants", async () => {
    const id = cutover.guild;
    if (!cutoverEnumeratedAt) throw new Error("Run the first-activation test first");
    const current = await service.guild({ ...actor, guildId: id });
    const member = current.member_role_id ?? "";
    const guest = current.guest_role_id ?? "";
    const roles = (user: string) => members.get(user)?.roles ?? [];
    for (const user of [
      cutover.present,
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.importedGuest,
      cutover.revoked,
      cutover.absentLink,
      cutover.uncertain,
      cutover.newcomer,
    ])
      await reconcileIn(id, user);
    expect(roles(cutover.present)).toEqual([member]);
    expect(roles(cutover.memberWithoutLink)).toEqual([guest]);
    expect(roles(cutover.roleless)).toEqual([guest]);
    expect(roles(cutover.importedGuest)).toEqual([guest]);
    expect(roles(cutover.revoked)).toEqual([]);
    expect(roles(cutover.absentLink)).toEqual([guest]);
    // Once the uncertain link is evaluated absent, the dormant grant replaces Member with Guest.
    expect(roles(cutover.uncertain)).toEqual([guest]);
    expect(roles(cutover.newcomer)).toEqual([guest]);
    const officer = { ...actor, guildId: id };
    // /guest status lists the new provenance.
    expect(await service.guestStatus(officer, cutover.memberWithoutLink)).toMatchObject({
      grants: [{ provenance: "grandfathered", reason: "Grandfathered Guest at first activation" }],
    });
    // Explicit revocation suppresses the grant through departure, rejoin and a new process.
    await service.guestAction(
      officer,
      cutover.roleless,
      true,
      "Grandfathered access withdrawn",
      randomUUID(),
    );
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([]);
    const events = new GuildEvents(db);
    await events.memberLeft(id, cutover.roleless);
    await events.memberJoined(id, cutover.roleless, new Date("2026-01-01T00:00:00Z"));
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([]);
    const restarted = new Synchronization(new Service(db, discord, lodestone, config));
    const work = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${id}:${cutover.roleless}`,
      {},
      id,
      cutover.roleless,
    );
    await restarted.user(await leased(work), async () => {});
    expect(roles(cutover.roleless)).toEqual([]);
    // An explicit officer grant restores it with a manual grant and an audited restore.
    await service.guestAction(officer, cutover.roleless, false, "Welcome back", randomUUID());
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([guest]);
    expect(await auditsOf(id, "guest.restore")).toHaveLength(1);
    // Positive roster evidence gives Member precedence over the grant.
    await publishRoster(cutover.fc, [
      rosterMember("88100001", cutover.fc),
      rosterMember("88100006", cutover.fc),
    ]);
    await reconcileIn(id, cutover.absentLink);
    expect(roles(cutover.absentLink)).toEqual([member]);
    // Someone joining after activation gets nothing automatically and is listed for officers.
    const late = memberView(id, cutover.lateJoiner, [], new Date());
    members.set(late.id, structuredClone(late));
    await events.memberJoined(id, late.id, late.joinedAt);
    await reconcileIn(id, late.id);
    expect(roles(late.id)).toEqual([]);
    // Two more late joiners the report leaves out: one registered, one already gone again.
    const registered = memberView(id, "97010", [], new Date());
    const departed = memberView(id, "97011", [], new Date());
    for (const view of [registered, departed]) {
      members.set(view.id, structuredClone(view));
      await events.memberJoined(id, view.id, view.joinedAt);
    }
    await linkCharacter(id, registered.id, "88100010");
    await events.memberLeft(id, departed.id);
    expect(await lateJoiners(db.orm, id)).toEqual({
      guildId: id,
      state: "completed",
      enumeratedAt: cutoverEnumeratedAt.toISOString(),
      count: 1,
      users: [{ userId: late.id, joinedAt: late.joinedAt }],
    });
    await service.guestAction(officer, late.id, false, "Late joiner welcomed", randomUUID());
    expect(await lateJoiners(db.orm, id)).toMatchObject({ count: 0, users: [] });
    // A guild that was never grandfathered has nothing to report.
    expect(await lateJoiners(db.orm, guild)).toMatchObject({ state: "pending", count: 0 });
  });

  test("a /guest reset before first activation is not undone by grandfathering (2.15.0)", async () => {
    const id = "666666666666666711";
    const fcId = "9232097761132950021";
    const row = await importedGuild(id, fcId);
    const [reset, untouched] = ["97111", "97112"];
    await importedHuman(id, reset);
    await importedHuman(id, untouched);
    // The first member's imported grant was ended by /guest reset; the second has no grant.
    await db.orm.insert(t.guestGrants).values({
      guild_id: id,
      user_id: reset,
      provenance: "imported_guest",
      source_key: `import:reset-before-activation:${reset}`,
      ended_at: new Date(),
      ended_by: "90001",
      ended_reason: "Back to the automatic rules",
    });
    await publishRoster(fcId, []);
    const plan = await planGrandfathering(
      db.orm,
      row,
      [memberView(id, reset), memberView(id, untouched)],
      21600,
      new Date(),
    );
    const basisOf = (user: string) =>
      plan.candidates.find((candidate) => candidate.userId === user)?.basis;
    // An ended grant still counts as an existing grant here, but no longer as provenance.
    expect(basisOf(reset)).toBe("existing_grant");
    expect(
      plan.candidates.find((candidate) => candidate.userId === reset)?.existingProvenance,
    ).toEqual([]);
    expect(basisOf(untouched)).toBe("grant");
    expect(plan.grants).toEqual([untouched]);
  });

  test("grandfathering fails closed and rolls activation back", async () => {
    const id = "666666666666666701";
    const fcId = "9232097761132950011";
    const row = await importedGuild(id, fcId);
    const user = "97101";
    await importedHuman(id, user);
    await publishRoster(fcId, []);
    const views = [memberView(id, user)];
    const reviewed = await planGrandfathering(db.orm, row, views, 21600, new Date());
    const activate = (input: Partial<Parameters<typeof activateGuild>[1]>) =>
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt: new Date(),
        grandfatherPlan: reviewed.checksum,
        ...input,
      });
    // No complete enumeration, or no Discord validation, while grandfathering is pending.
    await expect(activate({ members: null, enumeratedAt: null })).rejects.toMatchObject({
      code: "incomplete",
    });
    await expect(activate({ resourcesValidated: false })).rejects.toMatchObject({
      code: "conflict",
    });
    await expectNotActivated(id);
    // A missing checksum returns the full report and the checksum to confirm.
    const missing = await activate({ grandfatherPlan: undefined }).catch((error) => error);
    expect(missing).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(missing).toMatchObject({
      checksum: reviewed.checksum,
      difference: null,
      report: { state: "pending", planned: { count: 1, sample: [user] } },
    });
    await expectNotActivated(id);
    // Against the reviewed plan file, a new joiner shows up as the only addition (C8).
    const file = reviewedPlan(JSON.parse(json(reviewed, 2)), reviewed.checksum);
    const joined = await activate({
      members: [...views, memberView(id, "97102", [], new Date())],
      reviewedPlan: file,
    }).catch((error) => error);
    expect(joined).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(joined.difference).toEqual({
      added: ["97102"],
      removed: [],
      guildChanged: false,
      importChanged: false,
      rosterSnapshotChanged: false,
    });
    await expectNotActivated(id);
    // Any newer accepted roster changes the checksum even when the planned users do not.
    await publishRoster(fcId, []);
    const acquired = await activate({ reviewedPlan: file }).catch((error) => error);
    expect(acquired).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(acquired.difference).toMatchObject({
      added: [],
      removed: [],
      rosterSnapshotChanged: true,
    });
    expect(acquired.checksum).not.toBe(reviewed.checksum);
    await expectNotActivated(id);
    const confirmed = (await planGrandfathering(db.orm, row, views, 21600, new Date())).checksum;
    // A roster that is not newer than the import is refused.
    await db.orm
      .update(t.auditEvents)
      .set({ event_at: sql`now()+interval '1 minute'` })
      .where(and(eq(t.auditEvents.guild_id, id), eq(t.auditEvents.action, "migration.import")));
    await expect(activate({ grandfatherPlan: confirmed })).rejects.toMatchObject({ code: "stale" });
    await db.orm
      .update(t.auditEvents)
      .set({ event_at: sql`now()-interval '1 hour'` })
      .where(and(eq(t.auditEvents.guild_id, id), eq(t.auditEvents.action, "migration.import")));
    // So is a roster older than the freshness window.
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()-interval '7 hours'` })
      .where(eq(t.freeCompanies.id, fcId));
    await expect(activate({ grandfatherPlan: confirmed })).rejects.toMatchObject({ code: "stale" });
    await expectNotActivated(id);
    // A guild that was never imported activates without grandfathering.
    const plain = "666666666666666702";
    await db.orm.insert(t.guilds).values({ id: plain, guest_role_id: "82102" });
    expect(
      await activateGuild(db, {
        guildId: plain,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: null,
        enumeratedAt: null,
      }),
    ).toMatchObject({
      status: "activated",
      grandfathering: { state: "not_applicable", planChecksum: null, granted: 0 },
    });
    expect(await auditsOf(plain, "guest.grandfather.completed")).toEqual([]);
  });

  test("first activation never opens guest applications implicitly", async () => {
    const legacyChannel = "82201";
    const setup = async (id: string, fcId: string) => {
      const row = await importedGuild(id, fcId, legacyChannel);
      await publishRoster(fcId, []);
      const plan = await planGrandfathering(db.orm, row, [], 21600, new Date());
      return { row, plan };
    };
    const activate = (id: string, checksum: string, choice?: "open" | "closed") =>
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: [],
        enumeratedAt: new Date(),
        grandfatherPlan: checksum,
        guestApplications: choice,
      });
    const channelOf = async (id: string) =>
      (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id)))[0];
    // 2.15.0 imports keep the legacy review channel with the switch off: without a choice,
    // activation keeps applications closed and the channel stored (owner decision, 2026-09-24).
    const kept = await setup("666666666666666703", "9232097761132950012");
    expect(await activate(kept.row.id, kept.plan.checksum)).toMatchObject({
      status: "activated",
      guestApplications: "closed",
    });
    expect(await channelOf(kept.row.id)).toMatchObject({
      guest_application_channel_id: legacyChannel,
      guest_applications_enabled: false,
    });
    expect(await auditsOf(kept.row.id, "config")).toEqual([]);
    // --guest-applications open switches them on, audited as activation's config change.
    const opened = await setup("666666666666666704", "9232097761132950013");
    expect(await activate(opened.row.id, opened.plan.checksum, "open")).toMatchObject({
      status: "activated",
      guestApplications: "open",
      revision: opened.row.revision + 1n,
    });
    expect(await channelOf(opened.row.id)).toMatchObject({
      guest_application_channel_id: legacyChannel,
      guest_applications_enabled: true,
    });
    expect(await auditsOf(opened.row.id, "config")).toEqual([
      {
        target: "guest_applications_enabled",
        details: { value: true, source: "activation" },
      },
    ]);
    // --guest-applications closed is already the imported state: nothing changes or is audited.
    const closed = await setup("666666666666666710", "9232097761132950020");
    expect(await activate(closed.row.id, closed.plan.checksum, "closed")).toMatchObject({
      status: "activated",
      guestApplications: "closed",
    });
    expect(await channelOf(closed.row.id)).toMatchObject({
      guest_application_channel_id: legacyChannel,
      guest_applications_enabled: false,
    });
    expect(await auditsOf(closed.row.id, "config")).toEqual([]);
  });

  test("pending departures block grandfathering until a confirming roster settles them", async () => {
    const id = "666666666666666705";
    const fcId = "9232097761132950014";
    const row = await importedGuild(id, fcId);
    const [departing, staying] = ["97201", "97202"];
    // Imported Member holders keep a 'present' baseline for their legacy FC character.
    for (const [user, character] of [
      [departing, "88100201"],
      [staying, "88100202"],
    ] as const) {
      const link = await importedHuman(id, user, character);
      if (!link) throw new Error("Missing imported link");
      await db.orm
        .insert(t.membershipHistory)
        .values({ guild_id: id, user_id: user, fc_id: fcId, link_id: link });
      await db.orm
        .insert(t.membership)
        .values({ guild_id: id, fc_id: fcId, character_id: character, state: "present" });
    }
    const views = [
      memberView(id, departing, [row.member_role_id ?? ""]),
      memberView(id, staying, [row.member_role_id ?? ""]),
    ];
    const first = new Date();
    await publishRoster(fcId, [rosterMember("88100202", fcId)], first);
    // One absence only marks the departing character missing; it still counts as membership.
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 1, sample: [departing] });
    await expect(planGrandfathering(db.orm, row, views, 21600, new Date())).rejects.toMatchObject({
      code: "stale",
    });
    await expect(
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt: new Date(),
        grandfatherPlan: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "stale" });
    await expectNotActivated(id);
    // The confirming acquisition at least 60 s later settles the departure.
    await publishRoster(fcId, [rosterMember("88100202", fcId)], new Date(first.getTime() + 61_000));
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 0, sample: [] });
    const enumeratedAt = new Date();
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    expect(plan.grants).toEqual([departing]);
    expect(plan.candidates).toEqual([
      expect.objectContaining({
        userId: departing,
        basis: "grant",
        former: true,
        heldMember: true,
        projected: { member: false, guest: true },
      }),
      expect.objectContaining({ userId: staying, basis: "member" }),
    ]);
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt,
        grandfatherPlan: plan.checksum,
      }),
    ).toMatchObject({ status: "activated", grandfathering: { state: "completed", granted: 1 } });
    expect(
      await db.orm
        .select({ user: t.guestGrants.user_id })
        .from(t.guestGrants)
        .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered"))),
    ).toEqual([{ user: departing }]);
  });

  test("an imported guild with no linked FC gets a reviewable plan that activation accepts", async () => {
    // The importer accepts a guild without an FC and marks it pending. Preview and activation gate
    // on the same freshness predicate, which has no roster to wait for here, so preview can still
    // produce the plan and checksum that activation confirms (MIG-14).
    const id = "666666666666666706";
    await db.orm.insert(t.guilds).values({
      id,
      fc_id: null,
      member_role_id: "82301",
      guest_role_id: "82302",
      role_layout_enabled: false,
      guest_grandfather: "pending",
      effects_enabled: false,
    });
    await db.orm.insert(t.auditEvents).values({
      guild_id: id,
      action: "migration.import",
      target: `fingerprint:${id}`,
      details: { guestGrandfather: "pending" },
      event_at: sql`now()-interval '1 hour'`,
    });
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id));
    if (!row) throw new Error("Missing no-FC guild fixture");
    const user = "97301";
    await importedHuman(id, user);
    const views = [memberView(id, user, [row.member_role_id ?? ""])];
    // The preview's gate (scripts/preview.ts) and the departure check both pass without an FC.
    await assertFreshRoster(db.orm, row, 21600);
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 0, sample: [] });
    const enumeratedAt = new Date();
    // Read-only on the pool, exactly as preview plans it.
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    expect(plan).toMatchObject({
      guildId: id,
      importFingerprint: `fingerprint:${id}`,
      rosterSnapshotId: null,
      grants: [user],
    });
    await expectNotActivated(id);
    // The reviewed plan file and its checksum are what activation confirms.
    const file = reviewedPlan(JSON.parse(json(plan, 2)), plan.checksum);
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt,
        grandfatherPlan: plan.checksum,
        reviewedPlan: file,
      }),
    ).toMatchObject({
      status: "activated",
      grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 1 },
    });
    expect(
      await db.orm
        .select({ user: t.guestGrants.user_id })
        .from(t.guestGrants)
        .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered"))),
    ).toEqual([{ user }]);
  });

  test("Drizzle mappings agree with every migrated application column", async () => {
    // The SQL migrations are an independent authority: catch missing/default/null/type mapping drift.
    const columns = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      domain_name: string | null;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
    }>(
      "SELECT table_name,column_name,data_type,domain_name,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations'",
    );
    const mappings = Object.values(t).map((table) => getTableConfig(table));
    expect([...new Set(columns.map((column) => column.table_name))].sort()).toEqual(
      mappings.map((table) => table.name).sort(),
    );
    for (const table of mappings) {
      const actual = columns.filter((column) => column.table_name === table.name);
      expect(actual.map((column) => column.column_name).sort()).toEqual(
        table.columns.map((column) => column.name).sort(),
      );
      for (const column of table.columns) {
        const row = actual.find((row) => row.column_name === column.name);
        if (!row) throw new Error(`Missing migrated column ${table.name}.${column.name}`);
        expect({
          table: table.name,
          column: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          hasDefault: column.hasDefault,
        }).toEqual({
          table: table.name,
          column: row.column_name,
          type: row.domain_name ?? row.data_type,
          notNull: row.is_nullable === "NO",
          hasDefault: row.column_default !== null || row.is_identity === "YES",
        });
      }
    }
  });

  test("ORM values remain exact and policy, audit and outbox share rollback visibility", async () => {
    // Exercise the actual node-postgres codecs, including JSON strings that are not serialized JSON.
    const external = "18446744073709551615";
    const maximum = 9223372036854775807n;
    const sequence = 9007199254740993n;
    const instant = new Date("2026-09-22T01:45:12.123-05:00");
    const rollback = new Error("Intentional ORM visibility rollback");
    const key = `orm:rollback:${randomUUID()}`;
    await expect(
      db.transaction(async (client) => {
        const store = orm(client);
        expect(orm(client)).toBe(store);
        expect(store).not.toBe(db.orm);
        await store
          .insert(t.freeCompanies)
          .values({ id: external, name: "Exact FC", world: "Diabolos", profile_at: instant });
        await store.insert(t.guilds).values({ id: external, fc_id: external, created_at: instant });
        await ensureUser(client, external, external, instant);
        const [account] = await store
          .insert(t.ledgerAccounts)
          .values({ guild_id: external, fc_id: external, balance: maximum, sequence })
          .returning();
        expect(account).toMatchObject({
          guild_id: external,
          fc_id: external,
          balance: maximum,
          sequence,
        });
        if (!account) throw new Error("Missing exact account");
        const [entry] = await store
          .insert(t.ledgerEntries)
          .values({
            account_id: account.id,
            guild_id: external,
            sequence,
            operation: "import",
            delta: maximum,
            balance: maximum,
            note: "Exact ORM boundary",
            idempotency_key: key,
            event_at: instant,
          })
          .returning();
        expect(entry).toMatchObject({
          delta: maximum,
          balance: maximum,
          sequence,
          event_at: instant,
        });
        const [present] = await store
          .select()
          .from(t.guildUsers)
          .where(and(eq(t.guildUsers.guild_id, external), eq(t.guildUsers.user_id, external)));
        expect(present).toMatchObject({
          user_id: external,
          present: true,
          joined_at: instant,
          nickname_before: null,
        });

        for (const value of [
          "plain text",
          "00123",
          "null",
          7,
          true,
          false,
          null,
          { amount: maximum, nested: ["零", null] },
        ]) {
          await audit(client, external, external, "orm.codec", null, value);
          const queued = await enqueue(
            client,
            "probe",
            `${key}:${randomUUID()}`,
            value,
            external,
            external,
          );
          const [job] = await store
            .select({ payload: t.jobs.payload })
            .from(t.jobs)
            .where(eq(t.jobs.id, queued));
          expect(job?.payload).toEqual(
            typeof value === "object" && value !== null
              ? { amount: maximum.toString(), nested: ["零", null] }
              : value,
          );
        }
        const entries = await store
          .select({ details: t.auditEvents.details })
          .from(t.auditEvents)
          .where(eq(t.auditEvents.guild_id, external))
          .orderBy(t.auditEvents.id);
        expect(entries.map((entry) => entry.details)).toEqual([
          "plain text",
          "00123",
          "null",
          7,
          true,
          false,
          null,
          { amount: maximum.toString(), nested: ["零", null] },
        ]);
        // Raw SQL independently confirms JSON null was not turned into SQL NULL, and UTC is intact.
        const raw = (
          await client.query<{ json_null: boolean; utc: string }>(
            "SELECT EXISTS(SELECT 1 FROM audit WHERE guild_id=$1 AND details='null'::jsonb AND details IS NOT NULL) AS json_null,(SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS') FROM guilds WHERE id=$1) AS utc",
            [external],
          )
        ).rows[0];
        expect(raw).toEqual({ json_null: true, utc: "2026-09-22T06:45:12.123" });
        expect(
          await db.orm.select({ id: t.guilds.id }).from(t.guilds).where(eq(t.guilds.id, external)),
        ).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.query("SELECT id FROM guilds WHERE id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM audit WHERE guild_id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM jobs WHERE guild_id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM ledger_entries WHERE idempotency_key=$1", [key])).toEqual(
      [],
    );
  });

  test("ORM capability aggregates include empty scopes and count shared FCs only once", async () => {
    const rollback = new Error("Intentional metrics rollback");
    await expect(
      db.transaction(async (client) => {
        const store = orm(client);
        // Hide existing work/FCs inside this transaction; the rest of the suite keeps its state.
        await store.update(t.guilds).set({ active: false });
        await store.update(t.jobs).set({ status: "disabled" });
        expect(await capabilityMetrics(store)).toEqual({
          pending: 0,
          blocked: 0,
          oldest_roster_age_seconds: null,
          degraded_fcs: 0,
        });
        const company = "18446744073709551614";
        await store.insert(t.freeCompanies).values({
          id: company,
          name: "Metrics FC",
          world: "Diabolos",
          last_error: "upstream",
          last_successful_roster_at: sql`now()-interval '90 seconds'`,
        });
        await store.insert(t.guilds).values([
          { id: company, fc_id: company },
          { id: "18446744073709551613", fc_id: company },
        ]);
        for (const status of ["queued", "running", "blocked", "failed", "succeeded", "disabled"])
          await store
            .insert(t.jobs)
            .values({ kind: "probe", dedupe_key: `metrics:${status}`, payload: {}, status });
        expect(await capabilityMetrics(store)).toEqual({
          pending: 2,
          blocked: 2,
          oldest_roster_age_seconds: 90,
          degraded_fcs: 1,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  test("ORM queue claims skip held locks and superseding generations cannot publish stale results", async () => {
    // Isolate candidates from other scenarios, then hold the oldest row on a separate session.
    await db.orm.update(t.jobs).set({ status: "disabled" });
    const first = await enqueue(db.pool, "reconcile.user", "orm:claim:first", { revision: 1 });
    const second = await enqueue(db.pool, "probe", "orm:claim:second", {});
    const third = await enqueue(db.pool, "probe", "orm:claim:third", {});
    let supersede = true;
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (job, guard) => {
        await guard();
        if (job.id === first && supersede) {
          supersede = false;
          expect(await enqueue(db.pool, job.kind, "orm:claim:first", { revision: 2 })).toBe(first);
        }
        await guard();
        return { generation: job.generation };
      },
      (event) => {
        events.push(event);
      },
    );
    const lock = await db.pool.connect();
    try {
      await lock.query("BEGIN");
      await orm(lock)
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(eq(t.jobs.id, first))
        .for("update");
      const claimed = await Promise.all([queue.claim(), queue.claim()]);
      expect(claimed.map((job) => job?.id).sort()).toEqual([second, third].sort());
      expect(new Set(claimed.map((job) => job?.lease_token)).size).toBe(2);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    const old = await queue.claim();
    if (!old || old.id !== first) throw new Error("Missing unlocked candidate");
    await queue.perform(old);
    const [superseded] = await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first));
    expect(superseded).toMatchObject({
      status: "queued",
      generation: 2,
      result: null,
      payload: { revision: 2 },
    });
    // The guard names the changed generation rather than a lease expiry, and waits log at debug.
    expect(superseded?.last_error).toStartWith(
      "superseded: Reconciliation inputs changed (generation 1→2)",
    );
    const waited = events.find((event) => event.type === "job" && event.job === old);
    expect(waited?.type === "job" ? waited.outcome : undefined).toMatchObject({
      code: "superseded",
      status: "queued",
      level: "debug",
    });
    expect(await queue.claim()).toBeUndefined();
    // Advance the persisted due time instead of sleeping through the normal retry backoff, and
    // seed an earlier pass's evidence: only `applied` may carry into the new result, never stale keys.
    await db.orm
      .update(t.jobs)
      .set({ due_at: sql`now()`, result: { skipped: "stale", applied: [{ generation: 1 }] } })
      .where(eq(t.jobs.id, first));
    const current = await queue.claim();
    if (!current || current.id !== first) throw new Error("Missing superseding candidate");
    await queue.perform(current);
    const [done] = await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first));
    expect(done?.status).toBe("succeeded");
    // Exact equality: this attempt's keys plus the carried `applied` list, with `skipped` dropped.
    expect(done?.result).toEqual({ generation: 2, applied: [{ generation: 1 }] });
    await db.orm.delete(t.jobs).where(inArray(t.jobs.id, [first, second, third]));
  });

  test("the queue gives a run requeued for newer input a fresh attempt budget", async () => {
    // Status posts (2.29.0) rely on this: a busy guild's post is requeued once per change.
    const key = "queue:attempts:reset";
    const id = await enqueue(db.pool, "probe", key, {});
    const row = async () =>
      (
        await db.query<{ status: string; attempts: number; generation: number }>(
          "SELECT status, attempts, generation FROM jobs WHERE id=$1",
          [id],
        )
      )[0];
    // New input arrives while the run works: the finished run is requeued, budget reset.
    await new Queue(
      db,
      async (job) => {
        await enqueue(db.pool, job.kind, key, {});
        return {};
      },
      () => {},
    ).perform(await leased(id));
    expect(await row()).toEqual({ status: "queued", attempts: 0, generation: 2 });
    // A run with no newer input completes and keeps its count.
    await new Queue(
      db,
      async () => ({}),
      () => {},
    ).perform(await leased(id));
    expect(await row()).toEqual({ status: "succeeded", attempts: 1, generation: 2 });
    await db.query("DELETE FROM jobs WHERE id=$1", [id]);
  });

  test("superseded reconciliation retains the applied Guest delta", async () => {
    // Discord echoes the bot's own role write as a member update, superseding the running pass.
    const fixture = await accessFixture("666666666666666681");
    const user = "94004";
    const guestRole = fixture.guild.guest_role_id ?? "";
    await service.assign(
      fixture.manager,
      user,
      { id: "77777203", name: "Echoed Guest", world: "Diabolos", dc: "Crystal", fcId: null },
      "Gateway echo fixture",
    );
    let echoed = false;
    const echoPort: DiscordPort = {
      ...discord,
      async roles(guildId, userId, add, remove) {
        await discord.roles(guildId, userId, add, remove);
        if (echoed) return;
        echoed = true;
        await reconcileUser(db.pool, guildId, userId);
      },
    };
    const app = new Service(db, echoPort, lodestone, config);
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort)),
      (event) => {
        events.push(event);
      },
    );
    const key = await reconcileUser(db.pool, fixture.guild.id, user);
    const read = async () => (await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0];
    await queue.perform(await leased(key));
    const superseded = await read();
    expect(superseded?.status).toBe("queued");
    expect(superseded?.last_error).toStartWith("superseded: Reconciliation inputs changed");
    expect(members.get(user)?.roles).toContain(guestRole);
    // The follow-up pass finds nothing left to change but keeps the delta Discord already received.
    await queue.perform(await leased(key));
    const completed = await read();
    expect(completed?.status).toBe("succeeded");
    const result = z
      .object({
        add: z.array(z.string()),
        remove: z.array(z.string()),
        applied: z.array(
          z.object({
            generation: z.number(),
            at: z.iso.datetime(),
            add: z.array(z.string()),
            remove: z.array(z.string()),
            status: z.string(),
          }),
        ),
      })
      .parse(completed?.result);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.add).toContain(guestRole);
    expect(result.applied[0]?.status).toBe("applied");
    expect(
      events.flatMap((event) =>
        event.type === "job" ? [[event.outcome.code, event.outcome.level]] : [],
      ),
    ).toEqual([["superseded", "debug"]]);
    // A long-lived job keeps only the newest 20 deltas: seed a full history, then append one.
    const other = "94005";
    await service.assign(
      fixture.manager,
      other,
      { id: "77777204", name: "Bounded History", world: "Diabolos", dc: "Crystal", fcId: null },
      "Bounded history fixture",
    );
    const bounded = await reconcileUser(db.pool, fixture.guild.id, other);
    const seeded = Array.from({ length: 20 }, (_, index) => ({
      generation: 0,
      at: new Date(0).toISOString(),
      add: [],
      remove: [String(index)],
      status: "applied",
    }));
    await db.orm
      .update(t.jobs)
      .set({ result: { applied: seeded } })
      .where(eq(t.jobs.id, bounded));
    await queue.perform(await leased(bounded));
    const history = z
      .object({
        applied: z.array(z.object({ add: z.array(z.string()), remove: z.array(z.string()) })),
      })
      .parse((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, bounded)))[0]?.result);
    expect(history.applied).toHaveLength(20);
    expect(history.applied[0]?.remove).toEqual(["1"]);
    expect(history.applied[19]?.add).toContain(guestRole);
  });

  test("modal answers survive restart, duplicate submission and officer approval without granting early access", async () => {
    const fixture = await accessFixture("96000");
    const interactions = interactionFixture();
    interactions.member.guildId = fixture.guild.id;
    interactions.member.userId = "96001";
    const applicant = { ...fixture.manager, userId: "96001", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    let review: ApplicationRecord | undefined;
    const reviewPort: DiscordPort = {
      ...discord,
      async editReview(application) {
        review = application;
        return "123456789";
      },
    };
    const app = new Service(db, reviewPort, lodestone, config);
    const synchronization = new Synchronization(app);
    const services = new Services();
    services.provide(applicationKey, app);
    const router = new InteractionRouter(
      {
        client: interactions.client,
        services,
        allowsGuild: (id) => id === fixture.guild.id,
        publicResponseGuildId: fixture.guild.id,
        isStopping: () => false,
        report: () => {},
        resolveActor: async (_guild, user) =>
          user === fixture.manager.userId ? fixture.manager : applicant,
      },
      new Map([[applyCommand.name, applyCommand]]),
      new Map([
        [applyComponent.prefix, applyComponent],
        [reviewComponent.prefix, reviewComponent],
      ]),
    );
    try {
      const modalId = guestApplicationModal(interactions.slash()).toJSON().custom_id;
      // The router/service are new instances; no in-memory form session is needed after restart.
      await router.handle(interactions.submit(modalId, input));
      // The receipt is the pending 'Application sent' card; it never echoes the answers.
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        content: "",
        embeds: [
          {
            title: "Application sent",
            description: expect.stringContaining("awaiting officer review"),
          },
        ],
      });
      const pending = await db.orm
        .select()
        .from(t.guestApplications)
        .where(eq(t.guestApplications.user_id, applicant.userId));
      const application = pending[0];
      if (!application) throw new Error("Missing submitted application");
      expect(pending).toHaveLength(1);
      expect(application).toMatchObject({
        introduction: input.introduction,
        interest: input.interest,
        state: "pending",
        channel_id: fixture.guild.officer_channel_id,
      });
      await router.handle(
        interactions.submit(modalId, {
          ...input,
          introduction: "Changed answers must not replace a review.",
        }),
      );
      expect(
        await db.orm
          .select()
          .from(t.guestApplications)
          .where(eq(t.guestApplications.user_id, applicant.userId)),
      ).toEqual(pending);
      expect(
        await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
          fixture.guild.id,
          applicant.userId,
        ]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM audit WHERE action='guest.applied' AND target=$1", [
          application.id,
        ]),
      ).toHaveLength(1);
      expect(JSON.stringify(await app.guestStatus(applicant, applicant.userId))).not.toContain(
        input.introduction,
      );
      expect(JSON.stringify(interactions.requests)).not.toContain(input.introduction);
      const [job] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `review:${application.id}`));
      if (!job) throw new Error("Missing durable review work");
      const deliver = dispatcher(app, synchronization, fixture.policy);
      await deliver(await leased(job.id), async () => {});
      expect(review).toMatchObject({ introduction: input.introduction, interest: input.interest });
      // A visitor cannot approve their own application; the officer's fresh actor can.
      const refused = interactions.button(`guest:approve:${application.id}`);
      await router.handle(refused);
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        embeds: [
          {
            title: "Officers only",
            description: "Only officers can decide guest access. Nothing was changed.",
            footer: { text: `Code forbidden · Ref ${refused.id}` },
          },
        ],
      });
      interactions.member.userId = fixture.manager.userId;
      await router.handle(interactions.button(`guest:approve:${application.id}`));
      await router.handle(interactions.button(`guest:approve:${application.id}`));
      expect(
        await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
          fixture.guild.id,
          applicant.userId,
        ]),
      ).toHaveLength(1);
      const [repair] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `user:${fixture.guild.id}:${applicant.userId}`));
      if (!repair) throw new Error("Missing access reconciliation");
      await synchronization.user(await leased(repair.id), async () => {});
      expect(members.get(applicant.userId)?.roles).toContain(fixture.guild.guest_role_id ?? "");
      await deliver(await leased(job.id), async () => {});
      expect(review).toMatchObject({
        state: "approved",
        introduction: input.introduction,
        interest: input.interest,
      });
      // The decision DM carries the stored application and the configured reapply cooldown.
      const [dm] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `dm:${application.id}`));
      if (!dm) throw new Error("Missing decision DM work");
      await deliver(await leased(dm.id), async () => {});
      expect(dms.at(-1)).toMatchObject({
        user: applicant.userId,
        message: {
          kind: "decision",
          application: { id: application.id, state: "approved" },
          cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
        },
      });
      expect(JSON.stringify(interactions.requests)).not.toContain(input.introduction);
    } finally {
      await interactions.close();
    }
  });

  test("invalid answers and raced departure/newer presence cannot publish stale applications", async () => {
    const fixture = await accessFixture("96010");
    const applicant = { ...fixture.manager, userId: "96011", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    for (const introduction of ["  ", "x".repeat(301), "invalid text\0", "broken text\ud800"]) {
      await expect(service.apply(applicant, { ...input, introduction })).rejects.toMatchObject({
        code: "input",
      });
    }
    const events = new GuildEvents(db);
    await events.memberJoined(fixture.guild.id, applicant.userId, input.joinedAt);
    for (const newer of [false, true]) {
      const app = new Service(
        db,
        {
          ...discord,
          async member(guildId, userId) {
            const observed = await discord.member(guildId, userId);
            if (newer)
              await events.memberJoined(guildId, userId, new Date(input.joinedAt.getTime() + 1000));
            else await events.memberLeft(guildId, userId);
            return observed;
          },
        },
        lodestone,
        config,
      );
      await expect(app.apply(applicant, input)).rejects.toMatchObject({ code: "stale" });
    }
    expect(
      await db.query("SELECT id FROM guest_applications WHERE guild_id=$1", [fixture.guild.id]),
    ).toHaveLength(0);
    expect(
      await db.query("SELECT joined_at,present FROM guild_users WHERE guild_id=$1 AND user_id=$2", [
        fixture.guild.id,
        applicant.userId,
      ]),
    ).toEqual([{ joined_at: new Date(input.joinedAt.getTime() + 1000), present: true }]);
  });

  test("denial cooldown, database answer constraints and legacy form-less reviews remain durable", async () => {
    const fixture = await accessFixture("96020");
    const applicant = { ...fixture.manager, userId: "96021", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    const application = await service.apply(applicant, input);
    // Another guild's application is simply not found here.
    await expect(
      service.decide({ ...fixture.manager, guildId: guild }, application.id, true),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "application", id: application.id },
    });
    await service.decide(
      fixture.manager,
      application.id,
      false,
      "Please ask an officer before reapplying.",
    );
    const restarted = new Service(db, discord, lodestone, config);
    await expect(restarted.apply(applicant, input)).rejects.toMatchObject({ code: "cooldown" });
    await db.query("UPDATE guest_applications SET decided_at=now()-interval '2 days' WHERE id=$1", [
      application.id,
    ]);
    const again = await restarted.apply(applicant, input);
    expect(again.id).not.toBe(application.id);
    await expect(
      db.query("UPDATE guest_applications SET introduction=NULL WHERE id=$1", [again.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE guest_applications SET interest='short' WHERE id=$1", [again.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // Nullable paired answers preserve old pending rows during the additive migration.
    await db.query("UPDATE guest_applications SET introduction=NULL,interest=NULL WHERE id=$1", [
      again.id,
    ]);
    expect(await restarted.decide(fixture.manager, again.id, true)).toMatchObject({
      status: "approved",
    });
  });

  test("verification supersedes form approval and remains automatic unless explicitly revoked", async () => {
    const fixture = await accessFixture("96030");
    const applicant = { ...fixture.manager, userId: "96031", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    const pending = await service.apply(applicant, input);
    await service.assign(
      fixture.manager,
      applicant.userId,
      { id: "777796031", name: "Registered Visitor", world: "Diabolos", dc: "Crystal", fcId: null },
      "Verified visitor fixture",
    );
    await expect(service.apply(applicant, input)).rejects.toMatchObject({ code: "eligible" });
    expect(await service.decide(fixture.manager, pending.id, true)).toMatchObject({
      status: "superseded",
    });
    expect(
      await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
        fixture.guild.id,
        applicant.userId,
      ]),
    ).toHaveLength(0);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, applicant.userId)).toBe(
      true,
    );
    await service.guestAction(
      fixture.manager,
      applicant.userId,
      true,
      "Explicit visitor revocation",
      randomUUID(),
    );
    await expect(service.apply(applicant, input)).rejects.toMatchObject({ code: "eligible" });
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, applicant.userId)).toBe(
      false,
    );
  });

  test("form answers, submission audit and outbox roll back together on publication failure", async () => {
    const fixture = await accessFixture("96040");
    const applicant = { ...fixture.manager, userId: "96041", officer: false, serverManager: false };
    await db.query(
      "CREATE FUNCTION reject_test_guest_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='guest.review' AND NEW.guild_id='96040' THEN RAISE EXCEPTION 'injected review publication failure'; END IF; RETURN NEW; END $$",
    );
    await db.query(
      "CREATE TRIGGER reject_test_guest_review BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_test_guest_review()",
    );
    try {
      await expect(
        service.apply(applicant, await applicationInput(applicant)),
      ).rejects.toMatchObject({ cause: { code: "P0001" } });
      expect(
        await db.query("SELECT id FROM guest_applications WHERE guild_id=$1", [fixture.guild.id]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM audit WHERE guild_id=$1 AND action='guest.applied'", [
          fixture.guild.id,
        ]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM jobs WHERE guild_id=$1 AND kind='guest.review'", [
          fixture.guild.id,
        ]),
      ).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER reject_test_guest_review ON jobs");
      await db.query("DROP FUNCTION reject_test_guest_review()");
    }
  });

  /**
   * A configured guild of its own for the 2.14.0 display-data scenarios: a linked FC with a stored
   * identity and a fresh roster read, four roles, ledger and review channels, and Discord effects
   * on unless a scenario holds them.
   */
  async function displayGuild(guildId: string, fcId: string, effects = true): Promise<Actor> {
    await db.orm
      .insert(t.freeCompanies)
      .values({
        id: fcId,
        name: "Display Company",
        tag: "DISP",
        world: "Diabolos",
        last_successful_roster_at: new Date(),
      })
      .onConflictDoNothing();
    await db.orm.insert(t.guilds).values({
      id: guildId,
      fc_id: fcId,
      effects_enabled: effects,
      member_role_id: "98101",
      guest_role_id: "98102",
      officer_role_id: "98103",
      leader_role_id: "98104",
      ledger_channel_id: "98201",
      guest_application_channel_id: "98202",
      guest_applications_enabled: true,
    });
    await db.orm.insert(t.ledgerAccounts).values({ guild_id: guildId, fc_id: fcId });
    return { ...actor, guildId, serverManager: true };
  }
  /** A Lodestone identity for scenarios that pass one straight to the service. */
  const character = (id: string, name: string) => ({
    id,
    name,
    world: "Diabolos",
    dc: "Crystal",
    fcId: null,
  });

  test("character results carry identity, main-character and roster evidence, and recoded failures", async () => {
    const guildId = "888888888888888801";
    const manager = await displayGuild(guildId, "9230000000000098001");
    const self: Actor = { guildId, userId: "98001", officer: false, manageRoles: false };
    const claimed = await service.claim(self, character("77980001", "Claimed Character"));
    if (claimed.status !== "pending") throw new Error("Expected a new token");
    proof = claimed.token;
    // The fake profile publishes the token under its own stored name.
    expect(await service.verify(self, "77980001")).toMatchObject({
      status: "verified",
      effects: "queued",
      effectsMode: "live",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
      // The first link becomes the main character.
      primary: true,
      roster: { fcLinked: true, fresh: true, checkedAt: expect.any(Date), listed: false },
    });
    expect(await service.verify(self, "77980001")).toEqual({
      status: "already_verified",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
    });
    expect(await service.claim(self, character("77980001", "Verified Character"))).toEqual({
      status: "already_linked",
      effects: "queued",
      effectsMode: "live",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
    });
    const assigned = await service.assign(
      manager,
      self.userId,
      character("77980002", "Assigned Character"),
      "  Confirmed in game  ",
    );
    expect(assigned).toMatchObject({
      status: "assigned",
      owner: self.userId,
      reason: "Confirmed in game",
      character: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      primary: false,
      officerAuthority: true,
      roster: { fresh: true },
    });
    // Assigning the same character to the same member again is the idempotent repeat.
    expect(
      await service.assign(
        manager,
        self.userId,
        character("77980002", "Assigned Character"),
        "Again",
      ),
    ).toMatchObject({ status: "already_assigned", link: assigned.link, primary: false });
    // Another member's link: the detail names the character and its owner for both audiences
    // (the reply shows the owner to officers only).
    const conflict = {
      code: "ownership_conflict",
      detail: { kind: "ownership", character: { id: "77980002" }, owner: self.userId },
    };
    await expect(
      service.assign(manager, "98002", character("77980002", "Assigned Character"), "Mistake"),
    ).rejects.toMatchObject(conflict);
    await expect(
      service.claim({ ...self, userId: "98002" }, character("77980002", "Assigned Character")),
    ).rejects.toMatchObject(conflict);
    absent.add("98009");
    await expect(
      service.assign(manager, "98009", character("77980003", "Absent Owner"), "Departed"),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "member", id: "98009" },
    });
    // Preferences report the saved main character and nickname state.
    expect(await service.preferences(self, "77980002", null)).toEqual({
      status: "saved",
      effects: "queued",
      effectsMode: "live",
      primary: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      nickname: { enabled: true, suspended: false },
    });
    await expect(service.preferences(self, "77989999", null)).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "link", id: "77989999" },
    });
    // A request that matches what is saved changes nothing and queues no reconciliation: naming
    // the current main, or turning sync on or off when it already is (owner decision, 2026-09-24).
    const reconcileWork = async () =>
      (
        await db.query<{ rows: string; generations: string }>(
          "SELECT count(*)::text AS rows, coalesce(sum(generation),0)::text AS generations FROM jobs WHERE dedupe_key=$1",
          [`user:${guildId}:${self.userId}`],
        )
      )[0];
    const before = await reconcileWork();
    expect(await service.preferences(self, "77980002", null)).toEqual({
      status: "unchanged",
      effects: "unchanged",
      effectsMode: "live",
      primary: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      nickname: { enabled: true, suspended: false },
    });
    expect(await service.preferences(self, null, true)).toMatchObject({
      status: "unchanged",
      nickname: { enabled: true, suspended: false },
    });
    expect(await reconcileWork()).toEqual(before);
    expect(await service.preferences(self, null, false)).toMatchObject({
      status: "saved",
      effects: "queued",
      nickname: { enabled: false },
    });
    expect(await service.preferences(self, null, false)).toMatchObject({
      status: "unchanged",
      effects: "unchanged",
      nickname: { enabled: false },
    });
    // /main with sync off (just turned off above) keeps the restore that queued; with sync on it
    // replaces it.
    expect(await service.preferences(self, "77980001", null)).toMatchObject({ status: "saved" });
    const restorePending = async () =>
      (
        await db.query<{ nickname_restore: boolean }>(
          "SELECT nickname_restore FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guildId, self.userId],
        )
      )[0]?.nickname_restore;
    expect(await restorePending()).toBe(true);
    expect(await service.preferences(self, "77980002", null)).toMatchObject({ status: "saved" });
    expect(await service.preferences(self, null, true)).toMatchObject({ status: "saved" });
    expect(await restorePending()).toBe(false);
    // Resuming sync that a manual nickname suspended is a change, not a repeat.
    await db.query(
      "UPDATE guild_users SET nickname_enabled=true, nickname_suspended=true WHERE guild_id=$1 AND user_id=$2",
      [guildId, self.userId],
    );
    expect(await service.preferences(self, null, true)).toMatchObject({
      status: "saved",
      nickname: { enabled: true, suspended: false },
    });
    // Turning nickname sync off for someone TaruBot never tracked is a no-op, not a refusal.
    const untracked = { ...self, userId: "98010" };
    expect(await service.preferences(untracked, null, false)).toEqual({
      status: "unchanged",
      effects: "unchanged",
      effectsMode: "live",
      primary: null,
      nickname: { enabled: false, suspended: false },
    });
    // No option detail, so the card shows no Example repeating /nickname enabled:true.
    const withoutMain = await service.preferences(untracked, null, true).then(
      () => null,
      (error: unknown) => error,
    );
    expect(withoutMain).toMatchObject({
      code: "input",
      message: "Choose a main character with /main before turning on nicknames.",
    });
    expect(withoutMain instanceof Failure ? withoutMain.detail : "missing").toBeUndefined();
    // Unlinking the main character clears it; the owner keeps one active link.
    expect(await service.unclaim(self, self.userId, "77980002")).toMatchObject({
      status: "unlinked",
      owner: self.userId,
      character: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      primaryCleared: true,
      remainingActive: 1,
      reason: null,
    });
    expect(
      await service.unclaim(manager, self.userId, "77980001", "  Left the FC  "),
    ).toMatchObject({ primaryCleared: false, remainingActive: 0, reason: "Left the FC" });
    const history = await service.characters(self, self.userId);
    expect(history.characters.map((row) => [row.character_id, row.active])).toEqual([
      ["77980001", false],
      ["77980002", false],
    ]);
    for (const row of history.characters) expect(row.ended_at).toBeInstanceOf(Date);
    // With no main and no active link left, a new link becomes the main again and keeps the
    // member's sync setting (owner decision, 2026-09-24: a re-link used to leave no main). With
    // sync on, it replaces the restore the last unlink queued, so the new nickname applies.
    const userRow = async () =>
      (
        await db.query<{
          primary_character_id: string | null;
          nickname_enabled: boolean;
          nickname_restore: boolean;
        }>(
          "SELECT primary_character_id,nickname_enabled,nickname_restore FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guildId, self.userId],
        )
      )[0];
    expect(await userRow()).toMatchObject({ primary_character_id: null, nickname_restore: true });
    expect(
      await service.assign(manager, self.userId, character("77980004", "Relinked"), "Came back"),
    ).toMatchObject({ status: "assigned", primary: true, firstLink: false, nicknameSync: true });
    expect(await userRow()).toEqual({
      primary_character_id: "77980004",
      nickname_enabled: true,
      nickname_restore: false,
    });
    // With sync off, a re-link still becomes the main, but the pending restore stands.
    await service.unclaim(manager, self.userId, "77980004", "Gone again");
    expect(await service.preferences(self, null, false)).toMatchObject({ status: "saved" });
    expect(
      await service.assign(manager, self.userId, character("77980006", "Relinked Again"), "Back"),
    ).toMatchObject({ status: "assigned", primary: true, firstLink: false, nicknameSync: false });
    expect(await userRow()).toEqual({
      primary_character_id: "77980006",
      nickname_enabled: false,
      nickname_restore: true,
    });
    // A second link while the main is set leaves it alone.
    expect(
      await service.assign(manager, self.userId, character("77980005", "Second"), "Alt"),
    ).toMatchObject({ status: "assigned", primary: false, firstLink: false });
  });

  test("claim limits carry retry timing and which limit refused", async () => {
    const guildId = "888888888888888802";
    await displayGuild(guildId, "9230000000000098002");
    const claimant: Actor = { guildId, userId: "98003", officer: false, manageRoles: false };
    for (const index of [1, 2, 3, 4, 5])
      await service.claim(claimant, character(`7798001${index}`, `Claim ${index}`));
    let own: unknown;
    try {
      await service.claim(claimant, character("77980016", "Claim 6"));
    } catch (error) {
      own = error;
    }
    expect(own).toMatchObject({
      code: "cooldown",
      detail: { kind: "limit", limit: "claims_own", until: expect.any(Date) },
    });
    // The oldest token frees the next slot within the verification window.
    const retry = own instanceof Failure ? own.retryAfter : 0;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(config.VERIFICATION_SECONDS);
    // The global cap: 1,000 unexpired tokens across the deployment refuse everyone else.
    const users = "SELECT (9801000+g)::text AS id FROM generate_series(1,200) g";
    await db.query(`INSERT INTO users(id) ${users} ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO guild_users(guild_id,user_id) SELECT $1,id FROM (${users}) u`, [
      guildId,
    ]);
    try {
      await db.query(
        `INSERT INTO challenges(guild_id,user_id,character_id,token_hash,expires_at) SELECT $1,u.id,c.id,repeat('a',64),now()+interval '1 hour' FROM (${users}) u CROSS JOIN (SELECT id FROM characters WHERE id IN ('77980011','77980012','77980013','77980014','77980015')) c`,
        [guildId],
      );
      await expect(
        service.claim({ ...claimant, userId: "98004" }, character("77980017", "Claim 7")),
      ).rejects.toMatchObject({
        code: "cooldown",
        detail: { kind: "limit", limit: "claims_all", until: expect.any(Date) },
      });
    } finally {
      // Later scenarios claim too, so the synthetic tokens must not outlive this test.
      await db.query(
        `DELETE FROM challenges WHERE guild_id=$1 AND user_id IN (${users.replace(" AS id", "")})`,
        [guildId],
      );
      await db.query(
        `DELETE FROM guild_users WHERE guild_id=$1 AND user_id IN (${users.replace(" AS id", "")})`,
        [guildId],
      );
    }
  });

  test("ledger receipts and views carry the FC, channel, corrections and exact paging", async () => {
    const guildId = "888888888888888803";
    const fcId = "9230000000000098003";
    const officer = await displayGuild(guildId, fcId);
    const company = { id: fcId, name: "Display Company", tag: "DISP", world: "Diabolos" };
    expect(
      await service.ledger(officer, "initialize", "0", "Opening balance", randomUUID()),
    ).toMatchObject({
      status: "recorded",
      effectsMode: "live",
      fc: company,
      channelId: "98201",
      correction: null,
      entry: { sequence: 1n, balance: 0n },
    });
    // Entries #2–#42 are deposits of 1 gil each; #43 corrects #5.
    const keys: string[] = [];
    for (let index = 2; index <= 42; index++) {
      const key = randomUUID();
      keys.push(key);
      await service.ledger(officer, "deposit", 1, `Deposit ${index}`, key);
    }
    const history = (before: string | null) => service.ledgerRead(officer, null, before, true);
    const fifth = (await history("6")).entries[0];
    if (fifth?.sequence !== 5n) throw new Error("Missing entry #5");
    const corrected = await service.ledger(
      officer,
      "adjust",
      "40",
      "Recount after chest audit",
      randomUUID(),
      { id: fifth.id },
    );
    expect(corrected).toMatchObject({
      status: "recorded",
      correction: { id: fifth.id, sequence: 5n },
      entry: { sequence: 43n, balance: 40n },
    });
    // A replayed interaction reports the entry and its channel post's delivery state.
    expect(await service.ledger(officer, "deposit", 1, "Deposit 2", keys[0] ?? "")).toMatchObject({
      status: "already_recorded",
      entry: { sequence: 2n },
      fc: company,
      channelId: "98201",
      correction: null,
      // A post not sent yet has no recorded channel.
      post: { status: "queued", message_id: null, last_error: null, channel_id: null },
    });
    expect(
      await service.ledger(officer, "adjust", "40", "Same balance", randomUUID()),
    ).toMatchObject({ status: "unchanged", balance: 40n, fc: company, channelId: "98201" });
    await expect(
      service.ledger(officer, "adjust", "41", "Bad target", randomUUID(), { id: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found", detail: { kind: "resource", resource: "entry" } });
    await expect(
      service.ledger(officer, "withdraw", 50, "Too much", randomUUID()),
    ).rejects.toMatchObject({
      code: "insufficient_funds",
      detail: { kind: "funds", balance: 40n, amount: 50n },
    });

    const balance = await service.ledgerRead(officer, null, null, false);
    expect(balance).toMatchObject({
      view: "balance",
      balanceState: "known",
      fc: company,
      current: true,
      channelId: "98201",
      effectsMode: "live",
      latest: { sequence: 43n, operation: "adjust", event_at: expect.any(Date) },
    });
    expect(balance.delivery.map((row) => row.sequence)).toEqual([
      43n,
      42n,
      41n,
      40n,
      39n,
      38n,
      37n,
      36n,
      35n,
      34n,
    ]);
    for (const row of balance.delivery)
      expect(row).toMatchObject({ attempts: 0, due_at: expect.any(Date) });

    /** The page as entry numbers plus its cursors and counts. */
    const page = async (before: string | null) => {
      const view = await history(before);
      return {
        entries: view.entries.map((entry) => Number(entry.sequence)),
        older: view.older,
        newer: view.newer,
        total: view.total,
        above: view.above,
      };
    };
    // The newest page: exactly ten entries and an exact older cursor.
    expect(await page(null)).toEqual({
      entries: [43, 42, 41, 40, 39, 38, 37, 36, 35, 34],
      older: 34n,
      newer: null,
      total: 43,
      above: 0,
    });
    // Page two: its posts are exactly its own entries, and the newer page is the newest one.
    const second = await history("34");
    expect(second.delivery.map((row) => row.entry_id).sort()).toEqual(
      second.entries.map((entry) => entry.id).sort(),
    );
    expect(second).toMatchObject({ before: 34n, older: 24n, newer: "latest", above: 10 });
    // A typed cursor that is not a multiple of ten (the approved example): nine newer entries.
    expect(await page("35")).toEqual({
      entries: [34, 33, 32, 31, 30, 29, 28, 27, 26, 25],
      older: 25n,
      newer: "latest",
      total: 43,
      above: 9,
    });
    // Deep enough that the newer page is itself a cursor: the ten entries just above #13.
    expect(await page("14")).toMatchObject({
      entries: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
      newer: 24n,
      above: 30,
    });
    expect((await page("24")).entries).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
    // Exactly ten left: no older cursor, so the last page is never empty.
    expect(await page("11")).toMatchObject({
      entries: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      older: null,
    });
    // A cursor past the newest entry shows the newest page.
    expect(await page("100")).toMatchObject({
      entries: [43, 42, 41, 40, 39, 38, 37, 36, 35, 34],
      newer: null,
      above: 0,
    });
    // The page holding the correction maps its target's entry number.
    expect((await history(null)).corrections).toEqual({ [fifth.id]: 5n });
    // A malformed cursor is its own input failure, not a balance error.
    let cursorFailure: unknown;
    try {
      await history("page 2");
    } catch (error) {
      cursorFailure = error;
    }
    expect(cursorFailure).toMatchObject({
      code: "input",
      detail: { kind: "option", option: "before" },
    });
    expect(cursorFailure instanceof Failure && cursorFailure.message).not.toContain("Balance");
    // Unknown accounts, out-of-date pager controls and members reading a past FC.
    await expect(
      service.ledgerRead(officer, "9230000000000098999", null, true),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "account", id: "9230000000000098999" },
    });
    await expect(
      service.ledgerRead(officer, "9230000000000098999", null, true, "current"),
    ).rejects.toMatchObject({ code: "stale", detail: { kind: "stale", what: "control" } });
    await expect(
      service.ledgerRead(
        { ...officer, userId: "98011", officer: false, serverManager: false },
        "9230000000000098999",
        null,
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden", detail: { kind: "scope", scope: "officer" } });
    // The entry number history shows names the same entry in the current account (owner
    // decision, 2026-09-24); it runs last because it appends entry #44.
    expect(
      await service.ledger(officer, "adjust", "39", "By number", randomUUID(), { sequence: 5n }),
    ).toMatchObject({
      status: "recorded",
      correction: { id: fifth.id, sequence: 5n },
      entry: { sequence: 44n, balance: 39n, correction_id: fifth.id },
    });
    await expect(
      service.ledger(officer, "adjust", "38", "No such number", randomUUID(), { sequence: 999n }),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "entry", id: "#999" },
    });
  });

  test("the guest-application switch and review channel change together (2026-09-24)", async () => {
    const guildId = "888888888888888811";
    const officer = await displayGuild(guildId, "9230000000000098021");
    const revisionOf = async () =>
      (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId)))[0]?.revision;
    const configAudits = async () =>
      (
        await db.orm
          .select({ target: t.auditEvents.target, details: t.auditEvents.details })
          .from(t.auditEvents)
          .where(and(eq(t.auditEvents.guild_id, guildId), eq(t.auditEvents.action, "config")))
          .orderBy(asc(t.auditEvents.id))
      ).map((row) => [row.target, row.details]);
    // Starting open with channel 98202: a repeat changes nothing, bumps no revision, audits nothing.
    const start = await revisionOf();
    expect(await service.configureGuestApplications(officer, { enabled: true })).toMatchObject({
      status: "unchanged",
      enabled: true,
      channel: "98202",
    });
    expect(await revisionOf()).toBe(start);
    // Switching off keeps the channel; the gate closes, and the audit names the switch.
    expect(await service.configureGuestApplications(officer, { enabled: false })).toMatchObject({
      status: "saved",
      enabled: { previous: true, value: false },
      channel: { previous: "98202", value: "98202" },
    });
    expect(await service.guestApplicationsOpen(guildId)).toBe(false);
    // Unsetting the channel and switching back on in one call is one revision.
    const before = await revisionOf();
    expect(
      await service.configureGuestApplications(officer, { enabled: true, channel: null }),
    ).toMatchObject({
      status: "saved",
      enabled: { previous: false, value: true },
      channel: { previous: "98202", value: null },
    });
    expect(await revisionOf()).toBe((before ?? 0n) + 1n);
    // On without a channel stays closed until one is set.
    expect(await service.guestApplicationsOpen(guildId)).toBe(false);
    await service.configureGuestApplications(officer, { channel: "98203" });
    expect(await service.guestApplicationsOpen(guildId)).toBe(true);
    expect(await configAudits()).toEqual([
      ["guest_applications_enabled", { value: false }],
      ["guest_application_channel_id", { value: null }],
      ["guest_applications_enabled", { value: true }],
      ["guest_application_channel_id", { value: "98203" }],
    ]);
    // Switching on validates the stored channel too: an imported legacy channel may be gone.
    // Switching off never validates, so a deleted channel can't block closing applications.
    await service.configureGuestApplications(officer, { enabled: false, channel: "98299" });
    const validateChannel = discord.validateChannel;
    const checked: string[] = [];
    discord.validateChannel = async (_guild, channel) => {
      checked.push(channel);
      if (channel === "98299")
        throw new Failure("blocked", "<#98299> is unavailable.", 0, {
          kind: "resource",
          resource: "channel",
          id: channel,
        });
    };
    try {
      await expect(
        service.configureGuestApplications(officer, { enabled: true }),
      ).rejects.toMatchObject({ code: "blocked" });
      expect(await service.guestApplicationsOpen(guildId)).toBe(false);
      expect(await service.configureGuestApplications(officer, { enabled: false })).toMatchObject({
        status: "unchanged",
      });
      expect(await service.configureGuestApplications(officer, { channel: null })).toMatchObject({
        status: "saved",
        channel: { previous: "98299", value: null },
      });
    } finally {
      discord.validateChannel = validateChannel;
    }
    expect(checked).toEqual(["98299"]);
    // A change to the stored channel between validation and the save is a conflict, and nothing
    // is saved: applications never open on a channel nobody validated.
    await service.configureGuestApplications(officer, { enabled: false, channel: "98203" });
    discord.validateChannel = async () => {
      await db.orm
        .update(t.guilds)
        .set({ guest_application_channel_id: "98204" })
        .where(eq(t.guilds.id, guildId));
    };
    try {
      await expect(
        service.configureGuestApplications(officer, { enabled: true }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      discord.validateChannel = validateChannel;
    }
    expect(await service.guestApplicationsOpen(guildId)).toBe(false);
    // Only officers configure it, and configure() no longer takes the review channel.
    await expect(
      service.configureGuestApplications({ ...officer, officer: false }, { enabled: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.configure(officer, "guest_application_channel_id", "98202"),
    ).rejects.toMatchObject({ code: "input" });
  });

  test("configuration results carry what changed, the FC identity and the role order", async () => {
    const guildId = "888888888888888804";
    const fcId = "9230000000000098004";
    const manager = await displayGuild(guildId, fcId);
    const report = await service.validate(manager);
    expect(report).toMatchObject({
      effectsMode: "live",
      guestApplicationsOpen: true,
      fc: [
        {
          id: fcId,
          name: "Display Company",
          tag: "DISP",
          world: "Diabolos",
          fresh: true,
          attemptFailed: false,
        },
      ],
    });
    // A held job is queued again by the change, and the result counts it.
    const held = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${guildId}:98020`,
      {},
      guildId,
      "98020",
    );
    await db.query(
      "UPDATE jobs SET status='blocked', last_error='blocked: Missing Permissions' WHERE id=$1",
      [held],
    );
    // Rows parked while paused can share a key with each other (a repeated refresh) or with the
    // repair pass the change queues; the change requeues one row per key instead of violating
    // the active-job index, and closes the rest as superseded.
    const [repair, older, newer] = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, dedupe_key, payload, guild_id, status, last_error, created_at) VALUES
         ('reconcile.guild', $1, '{}'::jsonb, $2, 'disabled', $4, now() - interval '3 minutes'),
         ('reconcile.user', $3, '{}'::jsonb, $2, 'disabled', $4, now() - interval '2 minutes'),
         ('reconcile.user', $3, '{}'::jsonb, $2, 'disabled', $4, now() - interval '1 minute')
       RETURNING id::text`,
      [
        `guild:${guildId}`,
        guildId,
        `user:${guildId}:98021`,
        "disabled: Discord changes are off for this deployment (ENABLE_EFFECTS=false).",
      ],
    );
    // Two /refresh runs made while paused: the earlier one started from the parked repair pass and
    // tracks it and the older user row; the later one tracks the newer user row.
    const [earlier, later] = await db.query<{ id: string }>(
      `INSERT INTO sync_runs (guild_id, requester_id, job_id, created_at) VALUES
         ($1, '98022', $2, now() - interval '3 minutes'),
         ($1, '98022', $3, now() - interval '1 minute')
       RETURNING id::text`,
      [guildId, repair?.id, newer?.id],
    );
    await db.query(
      `INSERT INTO sync_run_jobs (run_id, job_id) VALUES ($1, $2), ($1, $3), ($4, $5)`,
      [earlier?.id, repair?.id, older?.id, later?.id, newer?.id],
    );
    expect(await service.configure(manager, "ledger_channel_id", "98205")).toMatchObject({
      status: "saved",
      field: "ledger_channel_id",
      value: "98205",
      previous: "98201",
      rebound: false,
      // The blocked row and the newest parked row of the shared key.
      requeued: 2,
      company: null,
      guild: { id: guildId, ledger_channel_id: "98205" },
    });
    const states = new Map(
      (
        await db.query<{ id: string; status: string; last_error: string | null; result: unknown }>(
          "SELECT id::text, status, last_error, result FROM jobs WHERE id = ANY($1::uuid[])",
          [[held, repair?.id, older?.id, newer?.id]],
        )
      ).map((row) => [row.id, row]),
    );
    // Requeued work drops its stale diagnostic, so it reads `… QUEUED`, not a retry after an error.
    for (const requeued of [held, newer?.id ?? ""])
      expect(states.get(requeued)).toMatchObject({ status: "queued", last_error: null });
    for (const closed of [repair, older])
      expect(states.get(closed?.id ?? "")).toMatchObject({
        status: "succeeded",
        last_error: null,
        result: { skipped: "superseded" },
      });
    const [current] = await db.query<{ id: string }>(
      "SELECT id::text FROM jobs WHERE dedupe_key=$1 AND status='queued'",
      [`guild:${guildId}`],
    );
    expect(current).toBeDefined();
    // Each run now tracks the rows that carry its work (the change's own repair pass and the
    // surviving user row), never a superseded row, so the earlier run isn't reported Completed
    // before that work runs, and its work total is unchanged.
    const tracked = async (run: string | undefined) =>
      (
        await db.query<{ job_id: string }>(
          "SELECT job_id::text FROM sync_run_jobs WHERE run_id=$1 ORDER BY job_id",
          [run],
        )
      ).map((row) => row.job_id);
    expect(await tracked(earlier?.id)).toEqual([current?.id ?? "", newer?.id ?? ""].sort());
    expect(await tracked(later?.id)).toEqual([newer?.id ?? ""]);
    const runOf = async (run: string | undefined) =>
      (await service.syncStatus(manager, run ?? null)).runs[0];
    expect(await runOf(earlier?.id)).toMatchObject({
      status: "queued",
      work_total: 2,
      work_completed: 0,
    });
    // Parked again (Discord changes paused once more), the run reads as held, not completed.
    await db.query("UPDATE jobs SET status='disabled' WHERE id=$1", [newer?.id]);
    expect((await runOf(earlier?.id))?.status).toBe("blocked");
    expect((await runOf(later?.id))?.status).toBe("blocked");
    await db.query("UPDATE jobs SET status='queued' WHERE id=$1", [newer?.id]);
    expect(await service.configure(manager, "ledger_channel_id", "98205")).toMatchObject({
      rebound: true,
      requeued: 0,
    });
    // Linking a second FC needs an explicit unlink; the detail names the linked FC.
    await expect(service.configure(manager, "fc_id", "9230000000000098005")).rejects.toMatchObject({
      code: "fc_linked",
      detail: { kind: "resource", resource: "freecompany", id: fcId },
    });
    expect(await service.configure(manager, "fc_id", fcId)).toEqual({
      status: "unchanged",
      field: "fc_id",
      value: fcId,
    });
    await expect(service.unlinkCompany(manager, "9230000000000098005")).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "fc_link", id: "9230000000000098005" },
    });
    expect(await service.unlinkCompany(manager, fcId)).toMatchObject({
      status: "unlinked",
      effectsMode: "live",
      company: { id: fcId, name: "Display Company", tag: "DISP", world: "Diabolos" },
    });
    // A new link reports the Lodestone identity it stored.
    expect(await service.configure(manager, "fc_id", "9230000000000098005")).toMatchObject({
      status: "saved",
      previous: null,
      company: { id: "9230000000000098005", name: "Setup FC", tag: "TEST", world: "Diabolos" },
    });
    expect(await service.configureOfficerRank(manager, "  Council  ")).toMatchObject({
      status: "saved",
      officerRank: "Council",
      previous: null,
      fcLinked: true,
      officerRoleId: "98103",
      effectsMode: "live",
    });
    // The saved rank again changes nothing: no revision bump, audit or repair pass (2026-09-24).
    const rankRevision = (await service.guild(manager)).revision;
    const savedRank = (await service.guild(manager)).officer_rank_name;
    expect(await service.configureOfficerRank(manager, savedRank)).toMatchObject({
      status: "unchanged",
      effects: "unchanged",
      officerRank: savedRank,
    });
    expect((await service.guild(manager)).revision).toBe(rankRevision);
    await expect(service.configureOfficerRank(manager, " ")).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "rank" },
    });
    // Enabling the layout reports the order a pass applies: FC Leader, Officer, Member, Guest.
    expect(await service.configureRoleLayout(manager, false)).toMatchObject({ status: "saved" });
    expect(await service.configureRoleLayout(manager, true)).toMatchObject({
      status: "saved",
      order: ["98104", "98103", "98101", "98102"],
      layoutJob: expect.any(String),
    });
    // Applications need both the review channel and the Guest role, at the gate and at submission.
    expect(await service.guestApplicationsOpen(guildId)).toBe(true);
    await db.orm.update(t.guilds).set({ guest_role_id: null }).where(eq(t.guilds.id, guildId));
    expect(await service.guestApplicationsOpen(guildId)).toBe(false);
    const visitor: Actor = { guildId, userId: "98021", officer: false, manageRoles: false };
    await expect(service.apply(visitor, await applicationInput(visitor))).rejects.toMatchObject({
      code: "setup",
      message: GUEST_APPLICATIONS_CLOSED,
      detail: { kind: "setup", missing: "guest_role" },
    });
  });

  test("guest results carry outcomes, decisions and the facts behind the status view", async () => {
    const guildId = "888888888888888805";
    const manager = await displayGuild(guildId, "9230000000000098006");
    const applicant: Actor = { guildId, userId: "98030", officer: false, manageRoles: false };
    const first = await service.apply(applicant, await applicationInput(applicant));
    expect(first).toMatchObject({ outcome: "created", effectsMode: "live", state: "pending" });
    expect(await service.apply(applicant, await applicationInput(applicant))).toMatchObject({
      id: first.id,
      outcome: "existing",
    });
    // A rejoin replaces the pending application from the earlier join.
    const rejoined = members.get(applicant.userId);
    if (!rejoined) throw new Error("Missing applicant");
    rejoined.joinedAt = new Date("2026-02-01T00:00:00Z");
    const replaced = await service.apply(applicant, await applicationInput(applicant));
    expect(replaced).toMatchObject({ outcome: "replaced" });
    expect(replaced.id).not.toBe(first.id);
    // Officers see the pending application in autocomplete rows, and nothing more.
    const choices = await service.applicationChoices(manager);
    expect(choices.map((row) => Object.keys(row).sort())).toEqual([
      ["created_at", "id", "user_id"],
    ]);
    expect(choices[0]).toMatchObject({ id: replaced.id, user_id: applicant.userId });
    // The optional denial reason is validated like every officer reason.
    await expect(service.decide(manager, replaced.id, false, "   ")).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "reason" },
    });
    const denied = await service.decide(manager, replaced.id, false, "  Not a fit right now  ");
    expect(denied).toMatchObject({
      id: replaced.id,
      status: "denied",
      effects: "queued",
      effectsMode: "live",
      userId: applicant.userId,
      reason: "Not a fit right now",
      reviewerId: manager.userId,
      decidedAt: expect.any(Date),
      cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
    });
    expect(await service.decide(manager, replaced.id, true)).toMatchObject({
      status: "denied",
      effects: "unchanged",
      reason: "Not a fit right now",
      reviewerId: manager.userId,
    });
    // Reapplying waits for the cooldown and says until when.
    let cooldown: unknown;
    try {
      await service.apply(applicant, await applicationInput(applicant));
    } catch (error) {
      cooldown = error;
    }
    expect(cooldown).toMatchObject({
      code: "cooldown",
      detail: { kind: "limit", limit: "apply", until: expect.any(Date) },
    });
    expect(cooldown instanceof Failure && cooldown.retryAfter).toBeGreaterThan(
      config.GUEST_COOLDOWN_SECONDS - 60,
    );
    const status = await service.guestStatus(manager, applicant.userId);
    expect(status).toMatchObject({
      membership: "ineligible",
      rosterFresh: true,
      registered: false,
      verifiedGuestEligible: false,
      cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
      effectsMode: "live",
    });
    for (const row of status.delivery)
      expect(row).toMatchObject({
        attempts: expect.any(Number),
        due_at: expect.any(Date),
        created_at: expect.any(Date),
      });
    // A grant reports the member, the trimmed reason and whether a revocation was lifted.
    const guest = "98031";
    const pending = await service.apply(
      { ...applicant, userId: guest },
      await applicationInput({ ...applicant, userId: guest }),
    );
    expect(
      await service.guestAction(manager, guest, false, "  Vouched for  ", randomUUID()),
    ).toMatchObject({
      status: "granted",
      user: guest,
      reason: "Vouched for",
      restored: false,
      cancelledApplications: 0,
      present: true,
      guestRoleConfigured: true,
    });
    expect(
      await service.guestAction(manager, guest, true, "Disruption", randomUUID()),
    ).toMatchObject({ status: "revoked", cancelledApplications: 1 });
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          pending.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
    expect(
      await service.guestAction(manager, guest, false, "Second chance", randomUUID()),
    ).toMatchObject({ status: "granted", restored: true });
    // Grants read newest first.
    const grants = (await service.guestStatus(manager, guest)).grants;
    expect(grants.map((grant) => grant.reason)).toEqual(["Second chance", "Vouched for"]);
    members.set("98032", {
      id: "98032",
      guildId,
      joinedAt: new Date("2026-01-01T00:00:00Z"),
      nickname: null,
      roles: [],
      bot: true,
    });
    await expect(
      service.guestAction(manager, "98032", false, "Bot", randomUUID()),
    ).rejects.toMatchObject({ code: "input", detail: { kind: "option", option: "member" } });
  });

  test("setup, officer overrides and refresh report what they did", async () => {
    const guildId = "888888888888888806";
    const manager: Actor = { ...actor, guildId, serverManager: true };
    // A row as the application creates it since 2.35.0: effects on, role layout off (CFG-07).
    await db.orm.insert(t.guilds).values({ id: guildId, ...NEW_GUILD_ROW });
    let serial = 98300;
    const provisioner: RoleProvisioner = {
      ...discord,
      async ensureRole(_guild, _name, _actor, configured) {
        return configured
          ? { id: configured, created: false }
          : { id: String(++serial), created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    const created = await administration.setup(manager, "", "9230000000000098007", "  Council  ");
    expect(created).toMatchObject({
      status: "configured",
      company: { id: "9230000000000098007", name: "Setup FC", tag: "TEST", world: "Diabolos" },
      officerRank: "Council",
      effectsMode: "live",
      // /setup onboarding keeps the saved switch, which is off, so it queues no layout pass.
      roleLayoutEnabled: false,
      layoutJob: null,
      adopted: 0,
      ledgerChannelId: null,
      officerNotifications: { defaulted: true },
      guestApplications: { defaulted: true },
    });
    expect(created.roles.every((role) => role.created)).toBe(true);
    // A rerun reuses everything and leaves the settings /setup filled in the first time.
    const again = await administration.setup(manager, "", null, null);
    expect(again.roles.every((role) => !role.created)).toBe(true);
    expect(again).toMatchObject({
      officerNotifications: { id: created.officerNotifications.id, defaulted: false },
      guestApplications: { defaulted: false },
    });
    await expect(
      administration.setup(manager, "", "9230000000000098008", null),
    ).rejects.toMatchObject({
      code: "fc_linked",
      detail: { kind: "resource", resource: "freecompany", id: "9230000000000098007" },
    });
    // Officer overrides report the member, the reason and the state they replaced.
    expect(await administration.officer(manager, "98040", true, "  Trusted  ")).toMatchObject({
      status: "granted",
      user: "98040",
      reason: "Trusted",
      present: true,
      previous: null,
      effectsMode: "live",
    });
    expect(await administration.officer(manager, "98040", false, "Stepped down")).toMatchObject({
      status: "revoked",
      previous: "granted",
    });
    absent.add("98041");
    await expect(administration.officer(manager, "98041", true, "Departed")).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "member", id: "98041" },
    });
    // A departed user's grant can still be revoked; it applies if they rejoin.
    expect(await administration.officer(manager, "98041", false, "Departed")).toMatchObject({
      present: false,
    });
    // Refresh: force is officer-only, a missing FC is a setup gap, and a run is always recorded.
    const member: Actor = { guildId, userId: "98042", officer: false, manageRoles: false };
    await expect(sync.refresh(member, true)).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "officer" },
    });
    expect(await sync.refresh(manager, true)).toMatchObject({
      runId: expect.any(String),
      status: "queued",
      forced: true,
      cached: false,
      intervalSeconds: config.ROSTER_INTERVAL_SECONDS,
      effectsMode: "live",
    });
    await db.orm.update(t.guilds).set({ fc_id: null }).where(eq(t.guilds.id, guildId));
    await expect(sync.refresh(member, false)).rejects.toMatchObject({
      code: "setup",
      detail: { kind: "setup", missing: "fc" },
    });
  });

  test("effects mode says whether queued Discord work is held, and why", async () => {
    // A guild not yet activated holds its work until activation.
    const held = await displayGuild("888888888888888807", "9230000000000098009", false);
    expect((await service.validate(held)).effectsMode).toBe("awaiting_activation");
    expect(
      await service.configure(held, "officer_notifications_channel_id", "98206"),
    ).toMatchObject({ effectsMode: "awaiting_activation" });
    // ENABLE_EFFECTS=false holds every guild's work, whatever its own activation state.
    const disabled = new Service(db, discord, lodestone, { ...config, ENABLE_EFFECTS: false });
    const live = await displayGuild("888888888888888808", "9230000000000098010");
    expect((await disabled.validate(live)).effectsMode).toBe("deployment_disabled");
    expect(
      await disabled.ledger(live, "initialize", "5", "Opening balance", randomUUID()),
    ).toMatchObject({ status: "recorded", effectsMode: "deployment_disabled" });
    expect(
      await disabled.apply(
        { guildId: live.guildId, userId: "98050", officer: false, manageRoles: false },
        await applicationInput({ ...live, userId: "98050" }),
      ),
    ).toMatchObject({ outcome: "created", effectsMode: "deployment_disabled" });
  });

  test("a requeue retries when an enqueue commits an active row for the same key mid-pass", async () => {
    // A `disabled` row sits outside the active-job index, so nothing stops another session from
    // enqueueing the same key while requeueParked runs (a gateway member update during startup).
    const guildId = "888888888888888809";
    await displayGuild(guildId, "9230000000000098011");
    const key = `user:${guildId}:98060`;
    const [parked] = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, dedupe_key, payload, guild_id, user_id, status, last_error)
       VALUES ('reconcile.user', $1, '{}'::jsonb, $2, '98060', 'disabled',
         'disabled: Discord effects are disabled pending activation.')
       RETURNING id::text`,
      [key, guildId],
    );
    // The other session's enqueue is in place but not committed: the requeue's supersede pass
    // can't see it, so its requeue waits on that row in the unique index.
    const other = await db.pool.connect();
    let active = "";
    try {
      await other.query("BEGIN");
      active = await reconcileUser(other, guildId, "98060");
      let pid = 0;
      const caller = db.transaction(async (client) => {
        pid =
          (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
        return requeueParked(client, [guildId], ["disabled"]);
      });
      // Commit the enqueue only once the caller is blocked on it, so the retry path is what runs.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = pid
          ? await db.query<{ waiting: boolean }>(
              "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
              [pid],
            )
          : [];
        if (row?.waiting) break;
        if (Date.now() > deadline) throw new Error("The requeue never waited on the enqueue");
        await Bun.sleep(10);
      }
      await other.query("COMMIT");
      // The unique violation rolled back to the savepoint; the retried pass saw the committed row
      // and closed the parked one, so the caller's transaction commits with nothing requeued.
      expect(await caller).toEqual([]);
    } finally {
      other.release();
    }
    const rows = await db.query<{ id: string; status: string; result: unknown }>(
      "SELECT id::text, status, result FROM jobs WHERE dedupe_key=$1 ORDER BY created_at",
      [key],
    );
    expect(rows).toEqual([
      { id: parked?.id ?? "", status: "succeeded", result: { skipped: "superseded" } },
      { id: active, status: "queued", result: null },
    ]);
  });

  test("retry.js requeues a parked job unless a newer row already carries its work", async () => {
    const guildId = "888888888888888810";
    await displayGuild(guildId, "9230000000000098012");
    const key = `user:${guildId}:98061`;
    // A reconcile.user parked while paused, then a newer row for the same member queued by a
    // later event: the older row is outside the active-job index, the newer one holds the key.
    const [older, newer] = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, dedupe_key, payload, guild_id, user_id, status, attempts,
         last_error, created_at) VALUES
         ('reconcile.user', $1, '{}'::jsonb, $2, '98061', 'disabled', 2,
           'disabled: Discord effects are disabled pending activation.', now() - interval '2 minutes'),
         ('reconcile.user', $1, '{}'::jsonb, $2, '98061', 'queued', 0, NULL, now())
       RETURNING id::text`,
      [key, guildId],
    );
    const retry = (guild: string, job: string | undefined) =>
      db.transaction((client) => retryJob(client, guild, job ?? ""));
    const state = async (job: string | undefined) =>
      (
        await db.query<{ status: string; attempts: number; last_error: string | null }>(
          "SELECT status, attempts, last_error FROM jobs WHERE id=$1",
          [job],
        )
      )[0];
    // Requeueing it would violate the index, so the tool refuses and names the row doing the work.
    await expect(retry(guildId, older?.id)).rejects.toThrow(
      `A newer job for this work is already queued: ${newer?.id}.`,
    );
    expect(await state(older?.id)).toMatchObject({ status: "disabled", attempts: 2 });
    // Once the newer row has finished, the parked one retries with a fresh budget and no diagnostic.
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [newer?.id]);
    await retry(guildId, older?.id);
    expect(await state(older?.id)).toEqual({ status: "queued", attempts: 0, last_error: null });
    // A blocked row holds its own key, so it retries in place.
    await db.query("UPDATE jobs SET status='blocked', attempts=3 WHERE id=$1", [older?.id]);
    await retry(guildId, older?.id);
    expect(await state(older?.id)).toMatchObject({ status: "queued", attempts: 0 });
    // Another guild's job, or completed work, is never retried.
    await expect(retry("888888888888888804", older?.id)).rejects.toThrow("No retryable job");
    await expect(retry(guildId, newer?.id)).rejects.toThrow("No retryable job");
  });

  test("scheduled work never pulls a backing-off job forward (2.17.0)", async () => {
    const fcId = "9229009999999999990";
    const key = `roster:${fcId}`;
    // A job backing off after a failure is due in ten minutes.
    const backing = await enqueue(db.pool, "roster", key, { fcId }, null, null, 600);
    const ahead = async (id: string) =>
      (
        await db.query<{ ahead: boolean }>(
          "SELECT due_at > now()+interval '9 minutes' AS ahead FROM jobs WHERE id=$1",
          [id],
        )
      )[0]?.ahead;
    // Before 2.17.0 the scheduler's enqueue pulled it to now on every 30-second tick.
    expect(await scheduleJob(db.pool, "roster", key, { fcId })).toBeUndefined();
    expect(await ahead(backing)).toBe(true);
    // Once the key has no active job, the scheduler queues a fresh one.
    await db.query("UPDATE jobs SET status='failed' WHERE id=$1", [backing]);
    const fresh = await scheduleJob(db.pool, "roster", key, { fcId });
    expect(fresh).toBeString();
    expect(fresh).not.toBe(backing);
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [fresh]);
  });

  test("no profile refresh is scheduled, and one an older version queued reads nothing (#86)", async () => {
    const owner = "90021";
    const characterId = "77777791";
    const key = `profile:${characterId}`;
    await service.assign(
      actor,
      owner,
      { id: characterId, name: "Linked Character", world: "Diabolos", dc: "Crystal", fcId: null },
      "Profile refresh fixture",
    );
    // A present owner and a profile never read: before #86 the next tick queued a refresh.
    await db.query("UPDATE guild_users SET present=true WHERE guild_id=$1 AND user_id=$2", [
      guild,
      owner,
    ]);
    await db.query("UPDATE characters SET profile_at=NULL, profile_retry_at=NULL WHERE id=$1", [
      characterId,
    ]);
    await sync.schedule();
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM jobs WHERE dedupe_key=$1",
          [key],
        )
      )[0]?.count,
    ).toBe(0);
    // A refresh an older image queued before the upgrade completes without a Lodestone read.
    const reads = lodestone.profileReads.length;
    const id = await enqueue(db.pool, "profile", key, { characterId });
    expect(await dispatcher(service, sync, access)(await leased(id), async () => {})).toEqual({
      skipped: "profile refreshes retired",
    });
    expect(lodestone.profileReads.length).toBe(reads);
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [id]);
  });

  test("/claim names a character the latest stored roster lists, by ID or name, and rewrites nothing (#86)", async () => {
    const guildId = "888888888888888886";
    const fcId = "9230000000000098086";
    await displayGuild(guildId, fcId);
    const self: Actor = { guildId, userId: "98086", officer: false, manageRoles: false };
    await db.orm.insert(t.characters).values([
      { id: "77980861", name: "Listed Character", world: "Diabolos", dc: "Crystal" },
      { id: "77980862", name: "Departed Character", world: "Diabolos", dc: "Crystal" },
    ]);
    const snapshot = async (hoursAgo: number, members: string[]) => {
      const observed = new Date(Date.now() - hoursAgo * 3_600_000);
      const [row] = await db.orm
        .insert(t.rosterSnapshots)
        .values({
          fc_id: fcId,
          started_at: observed,
          observed_at: observed,
          member_count: members.length,
          evidence: {},
        })
        .returning({ id: t.rosterSnapshots.id });
      if (!row) throw new Error("Missing snapshot");
      await db.orm
        .insert(t.rosterMembers)
        .values(members.map((character_id) => ({ snapshot_id: row.id, character_id })));
    };
    // An older roster listed both characters; only the latest one counts.
    await snapshot(2, ["77980861", "77980862"]);
    await snapshot(1, ["77980861"]);
    const listed = {
      id: "77980861",
      name: "Listed Character",
      world: "Diabolos",
      dc: "Crystal",
      fcId,
    };
    expect(await service.rosterCharacter(guildId, { id: "77980861" })).toEqual(listed);
    // A name matches as the Lodestone search does, ignoring case.
    expect(
      await service.rosterCharacter(guildId, { name: "listed character", world: "DIABOLOS" }),
    ).toEqual(listed);
    expect(await service.rosterCharacter(guildId, { id: "77980862" })).toBeNull();
    expect(
      await service.rosterCharacter(guildId, { name: "Departed Character", world: "Diabolos" }),
    ).toBeNull();
    // Another server's FC roster names nothing here.
    expect(await service.rosterCharacter(guild, { id: "77980861" })).toBeNull();
    // A roster-named claim issues its token without rewriting the roster's stored character.
    expect(await service.claim(self, { ...listed, name: "Stale Name" }, false)).toMatchObject({
      status: "pending",
      character: "77980861",
    });
    expect(
      (
        await db.query<{ name: string; profile_at: Date | null }>(
          "SELECT name, profile_at FROM characters WHERE id=$1",
          ["77980861"],
        )
      )[0],
    ).toEqual({ name: "Listed Character", profile_at: null });
  });

  /** A GitHub fake for issue reports (2.18.0): records calls; issues can be closed by tests. */
  class FakeIssues extends GitHubIssues {
    calls: { op: string; number?: number; title?: string; body: string; labels?: string[] }[] = [];
    closed = new Set<number>();
    next = 1;
    constructor() {
      super("unused", "owner/reports");
    }
    override async create(
      title: string,
      body: string,
      labels: readonly string[],
    ): Promise<IssueRef> {
      const number = this.next++;
      this.calls.push({ op: "create", number, title, body, labels: [...labels] });
      return { number, state: "open" };
    }
    override async comment(number: number, body: string): Promise<void> {
      this.calls.push({ op: "comment", number, body });
    }
    override async get(number: number): Promise<IssueRef> {
      return { number, state: this.closed.has(number) ? "closed" : "open" };
    }
  }
  const reportRow = async (fingerprint: string) =>
    (
      await db.query<{
        occurrences: number;
        posted_occurrences: number;
        issue_number: number | null;
        source: string;
      }>(
        "SELECT occurrences, posted_occurrences, issue_number, source FROM issue_reports WHERE fingerprint=$1",
        [fingerprint],
      )
    )[0];
  const deliveryJob = async (fingerprint: string) =>
    (
      await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE dedupe_key=$1 AND status IN ('queued','running','blocked')",
        [`issue:${fingerprint}`],
      )
    )[0]?.id;

  test("/issue saves the member's report with context, enforces its limits, and delivers it (2.18.0)", async () => {
    const github = new FakeIssues();
    const logs = new RecentLogs();
    logs.write(JSON.stringify({ level: 30, msg: "TaruBot ready" }));
    const reports = new IssueReports(config, db, lodestone, logs, github);
    reports.useStatus(() => ({ ready: true, writerLease: true }));
    const reporter: Actor = { ...actor, userId: "90031", officer: false };
    const submitted = await reports.user(
      reporter,
      "reporter",
      "1300000000000000001",
      "My Member role vanished after /main. @someone please look.",
    );
    expect(submitted).toEqual({ delivery: "queued", ref: "1300000000000000001" });
    const key = "user:1300000000000000001";
    expect(await reportRow(key)).toMatchObject({
      source: "user",
      occurrences: 1,
      issue_number: null,
    });
    const job = await deliveryJob(key);
    expect(job).toBeString();
    // Too short, and a second report within 10 minutes, are refused with when to try again.
    await expect(
      reports.user(reporter, "reporter", "1300000000000000002", "short"),
    ).rejects.toMatchObject({
      code: "input",
    });
    await expect(
      reports.user(reporter, "reporter", "1300000000000000003", "Another problem report here."),
    ).rejects.toMatchObject({
      code: "cooldown",
      detail: { kind: "limit", limit: "issue" },
      retryAfter: expect.any(Number),
    });
    // The member's limit spans servers (2.18.0 review). Another server's report for the same
    // member holds the member lock with its row not yet committed: this one must wait for it and
    // then refuse, rather than read past the uncommitted row as a server-only lock would.
    const racer = "90035";
    const held = await db.pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `issue:user:${racer}`,
      ]);
      await held.query(
        "INSERT INTO issue_reports (fingerprint, source, title, body, guild_id, user_id) VALUES ('user:held', 'user', 't', 'b', '666666666666666698', $1)",
        [racer],
      );
      const waiting = reports.user(
        { ...reporter, userId: racer },
        "racer",
        "1300000000000000012",
        "Sent while another server's report is still committing.",
      );
      await Bun.sleep(300);
      await held.query("COMMIT");
      await expect(waiting).rejects.toMatchObject({ code: "cooldown" });
    } finally {
      held.release();
      await db.query("DELETE FROM issue_reports WHERE user_id=$1", [racer]);
    }
    // Twenty reports in a day fill the server's allowance for everyone.
    for (let index = 0; index < 19; index++)
      await db.query(
        "INSERT INTO issue_reports (fingerprint, source, title, body, guild_id, user_id) VALUES ($1,'user','t','b',$2,$3)",
        [`user:fill-${index}`, guild, `9004${index}`],
      );
    await expect(
      reports.user(
        { ...reporter, userId: "90032" },
        "other",
        "1300000000000000004",
        "A different member's report.",
      ),
    ).rejects.toMatchObject({ code: "cooldown", message: expect.stringContaining("20 reports") });
    await db.query("DELETE FROM issue_reports WHERE fingerprint LIKE 'user:fill-%'");

    // Delivery opens one issue carrying the description in a fence (no @mention), the member's
    // state, the bot's state and the logs, with this deployment's secrets removed.
    expect(await reports.deliver(key, async () => {})).toMatchObject({
      status: "created",
      issue: 1,
    });
    const [created] = github.calls;
    expect(created?.title).toBe(
      "[production] /issue: My Member role vanished after /main. ＠someone please look.",
    );
    expect(created?.labels).toEqual(["tarubot-report", "source:user", "env:production"]);
    expect(created?.body).toContain(
      "```text\nMy Member role vanished after /main. @someone please look.\n```",
    );
    for (const section of [
      "### What happened",
      "### Readiness",
      "### Queue",
      "### Server",
      "### Member",
      "Recent log records",
    ])
      expect(created?.body).toContain(section);
    expect(created?.body).not.toContain(config.DISCORD_TOKEN);
    // Every code fence starts its line: a fence after text breaks GitHub's rendering of everything
    // below it (the 2.18.0 "Sidecar health: ```json" line did). Times read as UTC, not raw ISO.
    const lines = (created?.body ?? "").split("\n");
    expect(lines.filter((line) => line.includes("```") && !line.startsWith("```"))).toEqual([]);
    expect(created?.body).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/u);
    expect(created?.body).toStartWith("| Field | Value |");
    // A member's report carries no occurrence footer; automatic reports do.
    expect(created?.body).not.toContain("occurrence");
    expect(await reportRow(key)).toMatchObject({ issue_number: 1, posted_occurrences: 1 });
    // Nothing new: a second delivery posts nothing.
    expect(await reports.deliver(key, async () => {})).toEqual({ skipped: "nothing new" });
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [job]);

    // Without a token, reports are saved and wait: nothing is queued.
    const offline = new IssueReports(config, db, lodestone, logs, null);
    expect(
      await offline.user(
        { ...reporter, userId: "90033" },
        "later",
        "1300000000000000005",
        "Saved until reporting is set up.",
      ),
    ).toEqual({ delivery: "saved", ref: "1300000000000000005" });
    expect(await deliveryJob("user:1300000000000000005")).toBeUndefined();
    await db.query("DELETE FROM issue_reports WHERE fingerprint='user:1300000000000000005'");
  });

  test("automatic reports group by fingerprint, comment hourly, reopen after close, and cap per day (2.18.0)", async () => {
    const github = new FakeIssues();
    const reports = new IssueReports(config, db, lodestone, new RecentLogs(), github);
    const failed = {
      id: randomUUID(),
      kind: "reconcile.user",
      attempts: 8,
      guild_id: guild,
      user_id: "90034",
    };
    const outcome = {
      code: "blocked",
      diagnostic: `blocked: token ${config.DISCORD_TOKEN} refused`,
      source: "Failure",
    };
    await reports.jobFailed(failed, outcome);
    const [row] = await db.query<{ fingerprint: string; body: string }>(
      "SELECT fingerprint, body FROM issue_reports WHERE source='job' AND title LIKE '%reconcile.user jobs failing (blocked)%'",
    );
    if (!row) throw new Error("Missing job report");
    // The diagnostic's copy of this deployment's token is removed before it is stored.
    expect(row.body).not.toContain(config.DISCORD_TOKEN);
    expect(row.body).toContain("[secret redacted]");
    expect(await deliveryJob(row.fingerprint)).toBeString();
    expect(await reports.deliver(row.fingerprint, async () => {})).toMatchObject({
      status: "created",
    });
    const first = (await reportRow(row.fingerprint))?.issue_number;
    await db.query("UPDATE jobs SET status='succeeded' WHERE dedupe_key=$1", [
      `issue:${row.fingerprint}`,
    ]);

    // A repeat within the hour is counted, not posted.
    await reports.jobFailed({ ...failed, id: randomUUID() }, outcome);
    expect(await reportRow(row.fingerprint)).toMatchObject({
      occurrences: 2,
      posted_occurrences: 1,
    });
    expect(await deliveryJob(row.fingerprint)).toBeUndefined();
    expect(await reports.deliver(row.fingerprint, async () => {})).toEqual({
      skipped: "within the hourly comment window",
    });
    // An hour later the sweep queues it, and delivery comments with the count.
    await db.query(
      "UPDATE issue_reports SET posted_at=now()-interval '61 minutes' WHERE fingerprint=$1",
      [row.fingerprint],
    );
    await reports.sweep();
    expect(await deliveryJob(row.fingerprint)).toBeString();
    expect(await reports.deliver(row.fingerprint, async () => {})).toMatchObject({
      status: "commented",
      issue: first,
    });
    expect(github.calls.at(-1)).toMatchObject({ op: "comment", number: first });
    expect(github.calls.at(-1)?.body).toContain("**1 more occurrence**");
    await db.query("UPDATE jobs SET status='succeeded' WHERE dedupe_key=$1", [
      `issue:${row.fingerprint}`,
    ]);

    // After the issue is closed, a repeat opens a new issue that refers back to it.
    github.closed.add(first ?? 0);
    await reports.jobFailed({ ...failed, id: randomUUID() }, outcome);
    await db.query(
      "UPDATE issue_reports SET posted_at=now()-interval '61 minutes' WHERE fingerprint=$1",
      [row.fingerprint],
    );
    expect(await reports.deliver(row.fingerprint, async () => {})).toMatchObject({
      status: "reopened",
    });
    expect(github.calls.at(-1)?.body).toContain(`came back after #${first} was closed`);
    await db.query("DELETE FROM jobs WHERE dedupe_key=$1", [`issue:${row.fingerprint}`]);

    // The same unexpected error twice is one report with two occurrences.
    const boom = new TypeError("boom");
    await reports.error(boom, "1300000000000000009", "/ledger deposit");
    await reports.error(boom, "1300000000000000010", "/ledger deposit");
    const [error] = await db.query<{ occurrences: number; title: string }>(
      "SELECT occurrences, title FROM issue_reports WHERE source='error' AND title LIKE '%TypeError%'",
    );
    expect(error).toMatchObject({
      occurrences: 2,
      title: "[production] TypeError (unexpected) in /ledger",
    });

    // Ten automatic issues in a day: the next automatic one waits for tomorrow's allowance.
    for (let index = 0; index < 10; index++)
      await db.query(
        "INSERT INTO jobs (kind, dedupe_key, payload, status, completed_at, result) VALUES ('issue.report', $1, '{}', 'succeeded', now(), $2)",
        [`cap-${index}`, JSON.stringify({ status: "created", source: "job" })],
      );
    const [capped] = await db.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM issue_reports WHERE source='error' AND title LIKE '%TypeError%'",
    );
    expect(await reports.deliver(capped?.fingerprint ?? "", async () => {})).toEqual({
      skipped: "daily cap",
      source: "error",
    });
    // A repeat of a closed issue opens a new issue, so the same new-issue allowance holds it back,
    // even though no comments were posted today.
    github.closed.add((await reportRow(row.fingerprint))?.issue_number ?? 0);
    await reports.jobFailed({ ...failed, id: randomUUID() }, outcome);
    await db.query(
      "UPDATE issue_reports SET posted_at=now()-interval '61 minutes' WHERE fingerprint=$1",
      [row.fingerprint],
    );
    const calls = github.calls.length;
    expect(await reports.deliver(row.fingerprint, async () => {})).toEqual({
      skipped: "daily cap",
      source: "job",
    });
    expect(github.calls).toHaveLength(calls);
    await db.query("DELETE FROM jobs WHERE kind='issue.report'");
    await db.query("DELETE FROM issue_reports WHERE source <> 'user'");
  });

  test("trouble checks report stale rosters after 12 hours and a Lodestone that keeps failing (2.18.0)", async () => {
    const reports = new IssueReports(config, db, lodestone, new RecentLogs(), new FakeIssues());
    const before = await db.query<{ last_successful_roster_at: Date | null }>(
      "SELECT last_successful_roster_at FROM free_companies WHERE id=$1",
      [fc],
    );
    await db.query(
      "UPDATE free_companies SET last_successful_roster_at=now()-interval '13 hours' WHERE id=$1",
      [fc],
    );
    // A freshly linked FC that has no accepted roster yet.
    const fresh = "9230000000000009999";
    const freshGuild = "666666666666666699";
    await db.query(
      "INSERT INTO free_companies (id, name, world) VALUES ($1, 'Fresh FC', 'Diabolos')",
      [fresh],
    );
    await db.query("INSERT INTO guilds (id, fc_id) VALUES ($1, $2)", [freshGuild, fresh]);
    // No Lodestone answer for two hours, and the client is still trying.
    Object.assign(lodestone, {
      failingSince: new Date(Date.now() - 2 * 3600_000),
      lastFailure: "unavailable",
      lastAttemptAt: new Date(),
    });
    const occurrences = async (pattern: string) =>
      (
        await db.query<{ occurrences: number }>(
          "SELECT occurrences FROM issue_reports WHERE source='trouble' AND (title LIKE $1 OR body LIKE $1)",
          [pattern],
        )
      )[0]?.occurrences;
    try {
      const now = Date.now();
      await reports.tick(now);
      expect(await occurrences("%Lodestone unreachable for over an hour%")).toBe(1);
      expect(await occurrences(`%(\`${fc}\`)%`)).toBe(1);
      // A freshly linked FC isn't stale yet: its 12 hours start when the check first sees it.
      expect(await occurrences(`%(\`${fresh}\`)%`)).toBeUndefined();
      // Within five minutes the checks don't run again.
      await reports.tick(now + 60_000);
      expect(await occurrences(`%(\`${fc}\`)%`)).toBe(1);
      // Twelve hours on, still never accepted, it is reported. The Lodestone's last attempt is now
      // twelve hours old: a failure followed by quiet is no outage, so it is not reported again.
      await reports.tick(now + 12 * 3600_000 + 60_000);
      expect(await occurrences(`%(\`${fresh}\`)%`)).toBe(1);
      expect(await occurrences("%Lodestone unreachable for over an hour%")).toBe(1);
    } finally {
      Object.assign(lodestone, { failingSince: null, lastFailure: null, lastAttemptAt: null });
      await db.query("UPDATE free_companies SET last_successful_roster_at=$2 WHERE id=$1", [
        fc,
        before[0]?.last_successful_roster_at ?? null,
      ]);
      await db.query("DELETE FROM guilds WHERE id=$1", [freshGuild]);
      await db.query("DELETE FROM free_companies WHERE id=$1", [fresh]);
      await db.query("DELETE FROM jobs WHERE kind='issue.report'");
      await db.query("DELETE FROM issue_reports WHERE source='trouble'");
    }
  });

  /** The officer Lodestone notices' texts (#29): the degraded one unchanged, the owner's recovery. */
  const DEGRADED_TEXT =
    "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status.";
  const RECOVERED_TEXT = "Lodestone synchronization recovered: the FC roster was accepted again.";
  /**
   * A guild and FC of their own for one officer-notice scenario (#29): effects on, the given
   * officer notifications channel, and the shared production configuration (no roster line).
   */
  async function noticeGuild(guildId: string, fcId: string, channel: string | null) {
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: fcId, name: `Notice FC ${fcId}`, world: "Diabolos", dc: "Crystal" });
    await db.orm.insert(t.guilds).values({
      id: guildId,
      fc_id: fcId,
      effects_enabled: true,
      officer_notifications_channel_id: channel,
    });
  }
  /**
   * Pin the outage boundary (the FC's last accepted roster) to database time after an accepted
   * roster, so these scenarios don't depend on the test process's clock matching the database's:
   * job times come from the database, observations from the acquiring process.
   */
  async function pinBoundary(fcId: string) {
    await db.query("UPDATE free_companies SET last_successful_roster_at=now() WHERE id=$1", [fcId]);
  }
  /** One failed roster attempt with a non-waiting failure, as a roster that changed mid-read. */
  async function failRoster(fcId: string) {
    lodestone.rosterFailure = true;
    try {
      await expect(publishRoster(fcId, [])).rejects.toThrow("incomplete");
    } finally {
      lodestone.rosterFailure = false;
    }
  }
  /** A notice key's rows, oldest first; `held` means not due for at least another 290 seconds. */
  const notices = (key: string) =>
    db.query<{
      id: string;
      status: string;
      generation: number;
      due_at: Date;
      created_at: Date;
      completed_at: Date | null;
      message_id: string | null;
      payload: unknown;
      result: unknown;
      held: boolean;
    }>(
      "SELECT id,status,generation,due_at,created_at,completed_at,message_id,payload,result,due_at>now()+interval '290 seconds' AS held FROM jobs WHERE dedupe_key=$1 ORDER BY created_at,id",
      [key],
    );
  /** Run one notice through the dispatcher as a queue worker would, whatever its due time. */
  async function deliver(id: string) {
    await new Queue(db, dispatcher(service, sync, access), () => {}).perform(await leased(id));
  }

  test("routine roster acceptance posts only on DevBot (#29)", async () => {
    const guildId = "666666666666666712";
    const fcId = "9232097761132950030";
    const user = "90291";
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: fcId, name: "Roster Line FC", world: "Diabolos", dc: "Crystal" });
    await db.orm.insert(t.guilds).values({ id: guildId, fc_id: fcId });
    await ensureUser(db.pool, guildId, user, new Date("2026-01-01T00:00:00Z"));
    await linkCharacter(guildId, user, "88290001");
    const line = () =>
      db.query<{ status: string; payload: { message: string } }>(
        "SELECT status,payload FROM jobs WHERE dedupe_key=$1",
        [`officer:${guildId}`],
      );
    // Production (TEST_GUILD_ID ""): an accepted roster queues no officer line. The linked
    // character is recorded present.
    await publishRoster(fcId, [rosterMember("88290001", fcId)]);
    expect(await line()).toEqual([]);
    // DevBot's test guild keeps the line, departures count included: the character is missing,
    // then absent a minute later, and the second line replaces the first on the shared key.
    const devbot = new Synchronization(
      new Service(db, discord, lodestone, { ...config, TEST_GUILD_ID: guildId }),
    );
    const start = Date.now() + 1000;
    await publishRoster(fcId, [], new Date(start), devbot);
    await publishRoster(fcId, [], new Date(start + 61_000), devbot);
    const rows = await line();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.payload.message).toMatch(
      /^FC roster accepted: 0 members; 1 confirmed character departures\. Snapshot [0-9a-f-]{36}\.$/,
    );
  });

  test("Lodestone outage notices are held, rate-limited and followed by one recovery line (#29)", async () => {
    const guildId = "666666666666666713";
    const fcId = "9232097761132950040";
    const degraded = `officer:${guildId}:degraded:${fcId}`;
    const recovered = `officer:${guildId}:recovered:${fcId}`;
    await noticeGuild(guildId, fcId, "82105");
    // An accepted roster ten minutes ago: the outage below starts from it.
    await publishRoster(fcId, [], new Date(Date.now() - 600_000));
    await pinBoundary(fcId);
    // The first failure queues one degraded notice, held for five minutes.
    await failRoster(fcId);
    const [held] = await notices(degraded);
    if (!held) throw new Error("Missing degraded notice");
    expect(held).toMatchObject({
      status: "queued",
      held: true,
      payload: { message: DEGRADED_TEXT },
    });
    // More failures while it waits change nothing: no second row, generation or due time.
    await failRoster(fcId);
    const waiting = await notices(degraded);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      id: held.id,
      status: "queued",
      generation: held.generation,
    });
    expect(waiting[0]?.due_at.getTime()).toBe(held.due_at.getTime());
    // A roster accepted within the hold closes it unposted, and officers who never heard of the
    // outage aren't told it ended. This boundary isn't pinned: it stays the roster's observedAt
    // from the test process's clock, as production's comes from the bot's, so the next outage
    // (and its recovery) compare it with the database's job times.
    await publishRoster(fcId, []);
    expect(await notices(degraded)).toMatchObject([
      {
        id: held.id,
        status: "succeeded",
        message_id: null,
        result: { skipped: "recovered before posting" },
      },
    ]);
    expect(await notices(recovered)).toEqual([]);
    // A new outage: the closed row belonged to the last one, so a new notice is queued...
    await failRoster(fcId);
    const [, second] = await notices(degraded);
    if (!second) throw new Error("Missing second degraded notice");
    expect(second).toMatchObject({ status: "queued", held: true });
    // ...and, still failing after the hold, it posts.
    const before = sent.length;
    await deliver(second.id);
    expect(sent.slice(before)).toEqual([
      {
        guild: guildId,
        channel: "82105",
        message: { kind: "text", text: DEGRADED_TEXT },
        key: `${second.id}:${second.generation}`,
      },
    ]);
    const [, posted] = await notices(degraded);
    expect(posted).toMatchObject({ status: "succeeded", message_id: "123456789" });
    expect(posted?.completed_at).toBeInstanceOf(Date);
    // Within a day of that post, failures queue nothing.
    await failRoster(fcId);
    expect(await notices(degraded)).toHaveLength(2);
    // A day passes while the FC keeps failing. The boundary moves back with the notices, so the
    // posted one stays in this outage and the closed one in the last.
    await db.query(
      "UPDATE jobs SET created_at=created_at-interval '25 hours',completed_at=completed_at-interval '25 hours' WHERE dedupe_key=$1",
      [degraded],
    );
    await db.query(
      "UPDATE free_companies SET last_successful_roster_at=last_successful_roster_at-interval '25 hours' WHERE id=$1",
      [fcId],
    );
    // The daily repeat.
    await failRoster(fcId);
    const [, , repeat] = await notices(degraded);
    if (!repeat) throw new Error("Missing repeated degraded notice");
    expect(repeat).toMatchObject({ status: "queued", held: true });
    // Recovery closes the pending repeat and, because a notice posted in this outage, queues
    // exactly one recovery line, which posts.
    await publishRoster(fcId, []);
    await pinBoundary(fcId);
    expect((await notices(degraded))[2]).toMatchObject({
      id: repeat.id,
      status: "succeeded",
      message_id: null,
      result: { skipped: "recovered before posting" },
    });
    const [line] = await notices(recovered);
    expect(await notices(recovered)).toHaveLength(1);
    if (!line) throw new Error("Missing recovery line");
    expect(line).toMatchObject({ status: "queued", payload: { message: RECOVERED_TEXT } });
    await deliver(line.id);
    expect(sent.at(-1)).toMatchObject({
      guild: guildId,
      channel: "82105",
      message: { kind: "text", text: RECOVERED_TEXT },
    });
    // Throttling is a wait: it is recorded for /config validate but queues no notice...
    lodestone.rosterError = new Failure("rate_limited", "Lodestone rate limited.", 30);
    try {
      await expect(publishRoster(fcId, [])).rejects.toMatchObject({ code: "rate_limited" });
    } finally {
      lodestone.rosterError = null;
    }
    expect(await notices(degraded)).toHaveLength(3);
    expect(
      (
        await db.query<{ last_error: string | null }>(
          "SELECT last_error FROM free_companies WHERE id=$1",
          [fcId],
        )
      )[0]?.last_error,
    ).toBe("rate_limited");
    // ...and its end announces nothing, since nothing was posted in that outage.
    await publishRoster(fcId, []);
    expect(await notices(recovered)).toHaveLength(1);
  });

  test("no channel, paused effects and a late release: the rate limit follows what was posted (#29)", async () => {
    const guildId = "666666666666666714";
    const fcId = "9232097761132950041";
    const degraded = `officer:${guildId}:degraded:${fcId}`;
    const recovered = `officer:${guildId}:recovered:${fcId}`;
    await noticeGuild(guildId, fcId, null);
    await publishRoster(fcId, [], new Date(Date.now() - 600_000));
    await pinBoundary(fcId);
    // Without an officer channel the notice completes skipped, and nothing is sent.
    await failRoster(fcId);
    const [unconfigured] = await notices(degraded);
    if (!unconfigured) throw new Error("Missing degraded notice");
    const before = sent.length;
    await deliver(unconfigured.id);
    expect(sent.length).toBe(before);
    expect((await notices(degraded))[0]).toMatchObject({
      status: "succeeded",
      message_id: null,
      result: { skipped: "officer notifications unconfigured" },
    });
    // It still counts for the day, from when it completed.
    await failRoster(fcId);
    expect(await notices(degraded)).toHaveLength(1);
    // Nothing was posted, so the recovery posts nothing either.
    await publishRoster(fcId, []);
    await pinBoundary(fcId);
    expect(await notices(recovered)).toEqual([]);
    // With a channel but Discord changes paused, a new outage's notice parks `disabled`...
    await db.orm
      .update(t.guilds)
      .set({ officer_notifications_channel_id: "82106", effects_enabled: false })
      .where(eq(t.guilds.id, guildId));
    await failRoster(fcId);
    const [, parked] = await notices(degraded);
    if (!parked) throw new Error("Missing parked notice");
    await deliver(parked.id);
    const [, disabled] = await notices(degraded);
    expect(disabled).toMatchObject({ id: parked.id, status: "disabled", completed_at: null });
    // ...where it still counts as pending: failures neither add a row nor bump its generation.
    await failRoster(fcId);
    const still = await notices(degraded);
    expect(still).toHaveLength(2);
    expect(still[1]).toMatchObject({ status: "disabled", generation: disabled?.generation });
    // Recovery closes the parked notice unposted, with no recovery line.
    await publishRoster(fcId, []);
    await pinBoundary(fcId);
    expect((await notices(degraded))[1]).toMatchObject({
      status: "succeeded",
      message_id: null,
      result: { skipped: "recovered before posting" },
    });
    expect(await notices(recovered)).toEqual([]);
    // The next outage's notice parks too, and stays parked for more than a day. Every row on the
    // key moves back with the FC's boundary (the parked row's null completed_at stays null), so
    // each row stays in its own outage and the order holds. The earlier rows then finished over a
    // day ago, and only the late notice's own completion can keep the next failure quiet.
    await failRoster(fcId);
    const [, , late] = await notices(degraded);
    if (!late) throw new Error("Missing late notice");
    await deliver(late.id);
    await db.query(
      "UPDATE jobs SET created_at=created_at-interval '25 hours',completed_at=completed_at-interval '25 hours' WHERE dedupe_key=$1",
      [degraded],
    );
    await db.query(
      "UPDATE free_companies SET last_successful_roster_at=last_successful_roster_at-interval '25 hours' WHERE id=$1",
      [fcId],
    );
    // Effects come back and a /config change releases it the real way; it posts now.
    await db.orm.update(t.guilds).set({ effects_enabled: true }).where(eq(t.guilds.id, guildId));
    expect(
      await db.transaction((client) => requeueParked(client, [guildId], ["disabled"])),
    ).toEqual([late.id]);
    const sending = sent.length;
    await deliver(late.id);
    expect(sent.slice(sending)).toMatchObject([
      { guild: guildId, channel: "82106", message: { kind: "text", text: DEGRADED_TEXT } },
    ]);
    const released = (await notices(degraded)).find((row) => row.id === late.id);
    expect(released).toMatchObject({ status: "succeeded", message_id: "123456789" });
    // It completed just now, in database time, though it was queued over a day ago.
    expect(
      (
        await db.query<{ late: boolean }>(
          "SELECT completed_at>now()-interval '1 minute' AND created_at<now()-interval '24 hours' AS late FROM jobs WHERE id=$1",
          [late.id],
        )
      )[0]?.late,
    ).toBe(true);
    // The day counts from that post, not from the 25-hour-old creation: no repeat minutes later.
    // Counting from created_at alone would queue a fourth row here.
    await failRoster(fcId);
    expect(await notices(degraded)).toHaveLength(3);
    // The late post was this outage's, so the recovery queues exactly one line.
    await publishRoster(fcId, []);
    const lines = await notices(recovered);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "queued", payload: { message: RECOVERED_TEXT } });
  });

  test("a blocked notice, a notice posting at recovery, then an FC unlink (#29)", async () => {
    const guildId = "666666666666666715";
    const fcId = "9232097761132950042";
    const degraded = `officer:${guildId}:degraded:${fcId}`;
    const recovered = `officer:${guildId}:recovered:${fcId}`;
    await noticeGuild(guildId, fcId, "82107");
    await publishRoster(fcId, [], new Date(Date.now() - 600_000));
    await pinBoundary(fcId);
    // Discord refuses the send, as with a missing channel permission: the notice is blocked...
    await failRoster(fcId);
    const [refused] = await notices(degraded);
    if (!refused) throw new Error("Missing degraded notice");
    sendBlocked = true;
    try {
      await deliver(refused.id);
    } finally {
      sendBlocked = false;
    }
    const [blocked] = await notices(degraded);
    expect(blocked).toMatchObject({ id: refused.id, status: "blocked", message_id: null });
    // ...and still counts as pending: a failure neither adds a row nor flips it back to queued
    // with a new generation, as enqueue() would.
    await failRoster(fcId);
    const unchanged = await notices(degraded);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]).toMatchObject({
      id: refused.id,
      status: "blocked",
      generation: blocked?.generation,
    });
    // Recovery closes it unposted; nothing posted, so no recovery line.
    await publishRoster(fcId, []);
    await pinBoundary(fcId);
    expect(await notices(degraded)).toMatchObject([
      {
        id: refused.id,
        status: "succeeded",
        message_id: null,
        result: { skipped: "recovered before posting" },
      },
    ]);
    expect(await notices(recovered)).toEqual([]);
    // The next outage: a worker is sending its degraded notice when the roster is accepted.
    await failRoster(fcId);
    const [, sending] = await notices(degraded);
    if (!sending) throw new Error("Missing second degraded notice");
    await leased(sending.id);
    await publishRoster(fcId, []);
    await pinBoundary(fcId);
    // The running row is left to finish and counts as posted, so one recovery line is queued.
    // (If this send then fails and is retried, the degraded line can post after the recovery
    // line: an accepted edge case, site/src/content/docs/deploy/monitoring.md "Officer notices".)
    expect((await notices(degraded))[1]).toMatchObject({
      id: sending.id,
      status: "running",
      generation: sending.generation,
    });
    const lines = await notices(recovered);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "queued", payload: { message: RECOVERED_TEXT } });
    // Its send fails and it waits to retry, as the queue writes a failed attempt.
    await db.query("UPDATE jobs SET status='queued',lease_until=NULL WHERE id=$1", [sending.id]);
    // A pending notice of any age counts: a new failure neither adds a row nor merges into it.
    await failRoster(fcId);
    const pending = await notices(degraded);
    expect(pending).toHaveLength(2);
    expect(pending[1]).toMatchObject({
      id: sending.id,
      status: "queued",
      generation: sending.generation,
    });
    expect(pending[1]?.due_at.getTime()).toBe(sending.due_at.getTime());
    // Unlinking the FC closes it, so nothing posts later about an FC the guild no longer uses.
    expect(await service.unlinkCompany({ ...actor, guildId }, fcId)).toMatchObject({
      status: "unlinked",
    });
    expect((await notices(degraded))[1]).toMatchObject({
      id: sending.id,
      status: "succeeded",
      message_id: null,
      result: { skipped: "FC unlinked" },
    });
  });

  test("recovery closes a waiting notice in a guild the bot was removed from (#29)", async () => {
    // Two guilds on one FC: the one that stays active keeps the FC's rosters running.
    const guildId = "666666666666666716";
    const leftId = "666666666666666717";
    const fcId = "9232097761132950043";
    await noticeGuild(guildId, fcId, "82108");
    await db.orm.insert(t.guilds).values({
      id: leftId,
      fc_id: fcId,
      effects_enabled: true,
      officer_notifications_channel_id: "82109",
    });
    await publishRoster(fcId, [], new Date(Date.now() - 600_000));
    await pinBoundary(fcId);
    // An outage queues a notice in each guild; then the bot is removed from one of them, whose
    // rows the queue no longer claims.
    await failRoster(fcId);
    const [stays] = await notices(`officer:${guildId}:degraded:${fcId}`);
    const [left] = await notices(`officer:${leftId}:degraded:${fcId}`);
    if (!stays || !left) throw new Error("Missing degraded notices");
    const events = new GuildEvents(db);
    await events.guildLeft(leftId);
    // The active guild's notice posts, so its officers get a recovery line.
    await deliver(stays.id);
    await publishRoster(fcId, []);
    expect(await notices(`officer:${guildId}:recovered:${fcId}`)).toHaveLength(1);
    // Recovery closes the removed guild's waiting notice too, with no recovery line there...
    expect(await notices(`officer:${leftId}:degraded:${fcId}`)).toMatchObject([
      {
        id: left.id,
        status: "succeeded",
        message_id: null,
        result: { skipped: "recovered before posting" },
      },
    ]);
    expect(await notices(`officer:${leftId}:recovered:${fcId}`)).toEqual([]);
    // ...so adding the bot back leaves no officer notice about the ended outage waiting to post.
    await events.guildJoined(leftId);
    expect(
      await db.query(
        "SELECT id FROM jobs WHERE dedupe_key LIKE $1 AND status IN ('queued','running','blocked','disabled')",
        [`officer:${leftId}:%`],
      ),
    ).toEqual([]);
  });

  // Public suggestions (2.28.0, issue #32) -----------------------------------------------------

  /** Three guilds for /suggest: the allowlisted FC server, one outside the allowlist, and an
   * allowlisted server with no configuration. Role IDs are the canary server's bound roles. The
   * IDs sit above the officer-notice (…712–717) and changelog (…720–729) scenarios' guilds. */
  const canaryGuild = "666666666666666731";
  const foreignGuild = "666666666666666732";
  const bareGuild = "666666666666666733";
  const canaryFc = "9230000000000009901";
  const CANARY_MEMBER_ROLE = "76001";
  const CANARY_GUEST_ROLE = "76002";
  const CANARY_OFFICER_ROLE = "76003";

  /**
   * A scripted suggestion target: records every create and every client() call, returns issue
   * numbers 1, 2, …, and throws whatever a test queues for the next client() or create().
   */
  class FakeTarget implements SuggestionTarget {
    creates: { title: string; body: string; labels: string[] }[] = [];
    clients = 0;
    next = 1;
    clientFailures: unknown[] = [];
    createFailures: unknown[] = [];
    constructor(readonly repository = project.repository) {}
    async client() {
      this.clients++;
      const failure = this.clientFailures.shift();
      if (failure !== undefined) throw failure;
      return {
        create: async (title: string, body: string, labels: readonly string[]) => {
          const thrown = this.createFailures.shift();
          if (thrown !== undefined) throw thrown;
          this.creates.push({ title, body, labels: [...labels] });
          return { number: this.next++, state: "open" as const };
        },
      };
    }
  }

  /** Suggestions against the real database, allowlisting the canary and the bare server. */
  function suggestionHarness(target: FakeTarget | null = new FakeTarget()) {
    const reports: string[] = [];
    const suggestions = new Suggestions(
      service,
      target,
      (_error, operation) => {
        reports.push(operation);
      },
      [canaryGuild, bareGuild],
    );
    return { suggestions, target, reports };
  }

  /** A person in `guildId` holding `roleIds`, with no officer or manager flags unless given. */
  const suggester = (userId: string, roleIds: string[], extra: Partial<Actor> = {}): Actor => ({
    guildId: canaryGuild,
    userId,
    officer: false,
    manageRoles: false,
    roleIds,
    ...extra,
  });

  /** The suggestion audit rows, oldest first. */
  const suggestionRows = () =>
    db.query<{
      guild_id: string;
      actor_id: string;
      action: string;
      target: string | null;
      details: unknown;
    }>(
      "SELECT guild_id, actor_id, action, target, details FROM audit WHERE action LIKE 'suggestion.%' ORDER BY id",
    );
  const clearSuggestions = () => db.query("DELETE FROM audit WHERE action LIKE 'suggestion.%'");

  /** Insert a suggestion audit row `ago` in the past, for the daily limits. */
  const backdated = (userId: string, ago: string, action = "suggestion.posted") =>
    db.query(
      "INSERT INTO audit (guild_id, actor_id, action, target, details, event_at) VALUES ($1, $2, $3, '#0', '{}', now()-$4::interval)",
      [canaryGuild, userId, action, ago],
    );

  /** A long enough idea, distinct per call so failures point at the right submission. */
  const idea = (label: string) => `Suggestion ${label} for the TaruBot maintainers`;

  test("/suggest setup: the allowlisted FC server, a foreign one, and an unconfigured one (2.28.0)", async () => {
    await db.query(
      "INSERT INTO free_companies (id, name, world) VALUES ($1, 'Canary FC', 'Diabolos')",
      [canaryFc],
    );
    await db.query(
      "INSERT INTO guilds (id, fc_id, member_role_id, guest_role_id, officer_role_id) VALUES ($1, $2, $3, $4, $5), ($6, NULL, '76101', '76102', '76103')",
      [
        canaryGuild,
        canaryFc,
        CANARY_MEMBER_ROLE,
        CANARY_GUEST_ROLE,
        CANARY_OFFICER_ROLE,
        foreignGuild,
      ],
    );
    await clearSuggestions();
  });

  test("/suggest posts only the cleaned idea and records who sent it (2.28.0 canary)", async () => {
    const { suggestions, target } = suggestionHarness();
    const member = suggester("300000000000000001", [CANARY_MEMBER_ROLE]);
    const posted = await suggestions.submit(
      member,
      "<@333333333333333333> @claude #12 a@b.com https://discord.com/channels/1/2/3 na.finalfantasyxiv.com/lodestone/character/12345678/ 1234567890\u{AD}12345678",
    );
    expect(posted).toEqual({
      number: 1,
      url: "https://github.com/deconfined/tarubot/issues/1",
      repository: "deconfined/tarubot",
    });
    expect(target?.creates).toHaveLength(1);
    const [created] = target?.creates ?? [];
    expect(created?.labels).toEqual(["enhancement", "from-discord"]);
    for (const part of [created?.title ?? "", created?.body ?? ""]) {
      expect(part).not.toContain("@");
      expect(part).not.toMatch(/\d{17,}/u);
      for (const secret of [
        "333333333333333333",
        member.userId,
        canaryGuild,
        canaryFc,
        "Canary FC",
        "a@b.com",
        "discord.com",
        "finalfantasyxiv",
        "12345678/",
      ])
        expect(part).not.toContain(secret);
    }
    expect(created?.title).toBe(
      "[member] ＠claude ＃12 [email removed] [link removed] [link removed] [ID removed]",
    );
    // Nothing outside the fence but the fixed header and the version.
    expect(created?.body).toBe(
      [
        SUGGESTION_HEADER,
        "",
        "```text",
        "[member] ＠claude #12 [email removed] [link removed] [link removed] [ID removed]",
        "```",
        "",
        `Sent by TaruBot ${project.version}.`,
      ].join("\n"),
    );
    // The private record of who sent it.
    expect(await suggestionRows()).toEqual([
      {
        guild_id: canaryGuild,
        actor_id: member.userId,
        action: "suggestion.posted",
        target: "#1",
        details: { repository: "deconfined/tarubot", issue: 1 },
      },
    ]);
    await clearSuggestions();
  });

  test("/suggest refuses before any GitHub call: foreign server, off switch, setup, no role (2.28.0)", async () => {
    const { suggestions, target, reports } = suggestionHarness();
    // Outside the allowlist, even a configured server's manager is refused, with no scope.
    const manager = suggester("300000000000000002", ["76101"], {
      guildId: foreignGuild,
      officer: true,
      manageRoles: true,
      serverManager: true,
    });
    const foreign = await suggestions.submit(manager, idea("foreign")).catch((error) => error);
    expect(foreign).toMatchObject({ code: "forbidden", detail: undefined });
    // The off switch: forbidden too. The router logs each refusal at its classified level, and
    // main.ts opens a private report only at error level, so both must classify at info.
    const off = suggestionHarness(null);
    const switchedOff = await off.suggestions
      .submit(suggester("300000000000000003", [CANARY_MEMBER_ROLE]), idea("off"))
      .catch((error) => error);
    expect(switchedOff).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("switched off"),
    });
    for (const refusal of [foreign, switchedOff])
      expect(classifyFailure(refusal)).toMatchObject({ category: "forbidden", level: "info" });
    expect(off.reports).toEqual([]);
    // An allowlisted server with no configuration gets the setup card.
    await expect(
      suggestions.submit(suggester("300000000000000004", [], { guildId: bareGuild }), idea("bare")),
    ).rejects.toMatchObject({ code: "setup" });
    // A lobby visitor, and an officer or server manager holding neither role, are refused.
    for (const actor of [
      suggester("300000000000000005", []),
      suggester("300000000000000006", [CANARY_OFFICER_ROLE], { officer: true }),
      suggester("300000000000000007", [], {
        officer: true,
        manageRoles: true,
        serverManager: true,
      }),
    ])
      await expect(suggestions.submit(actor, idea("refused"))).rejects.toMatchObject({
        code: "forbidden",
        message: "Only members and guests of this server can suggest features.",
        detail: { kind: "scope", scope: "membership" },
      });
    expect(target?.clients).toBe(0);
    expect(await suggestionRows()).toEqual([]);
    // A member, a guest (owner decision, 2026-09-25) and an officer through their Member role pass.
    for (const actor of [
      suggester("300000000000000008", [CANARY_MEMBER_ROLE]),
      suggester("300000000000000009", [CANARY_GUEST_ROLE]),
      suggester("300000000000000010", [CANARY_MEMBER_ROLE, CANARY_OFFICER_ROLE], { officer: true }),
    ])
      expect((await suggestions.submit(actor, idea("allowed"))).repository).toBe(
        "deconfined/tarubot",
      );
    expect(target?.creates).toHaveLength(3);
    expect(reports).toEqual([]);
    await clearSuggestions();
  });

  test("/suggest limits: one an hour, three a day per member, ten a day in total (2.28.0)", async () => {
    const { suggestions, target } = suggestionHarness();
    const member = suggester("300000000000000011", [CANARY_MEMBER_ROLE]);
    await suggestions.submit(member, idea("first"));
    const hourly = await suggestions.submit(member, idea("again")).catch((error) => error);
    expect(hourly).toMatchObject({
      code: "cooldown",
      message: "You sent a suggestion in the last hour. You can send one an hour, and three a day.",
      detail: { kind: "limit", limit: "suggest", until: expect.any(Date) },
    });
    expect(hourly.retryAfter).toBeGreaterThan(3500);
    await clearSuggestions();
    // Three in the last day (none in the last hour) refuse until the oldest is a day old.
    const daily = "300000000000000012";
    for (const ago of ["2 hours", "5 hours", "20 hours"]) await backdated(daily, ago);
    const perMember = await suggestions
      .submit(suggester(daily, [CANARY_MEMBER_ROLE]), idea("fourth"))
      .catch((error) => error);
    expect(perMember).toMatchObject({
      code: "cooldown",
      message: "You've sent three suggestions in the last day.",
      detail: { kind: "limit", limit: "suggest" },
    });
    // The oldest of the three is 20 hours old, so the refusal lifts in about 4 hours.
    expect(perMember.retryAfter).toBeGreaterThan(4 * 3600 - 120);
    expect(perMember.retryAfter).toBeLessThan(4 * 3600 + 120);
    await clearSuggestions();
    // Ten from ten members (unconfirmed attempts included) fill the deployment's day.
    for (let index = 0; index < 10; index++)
      await backdated(
        `30000000000000010${index}`,
        `${index + 2} hours`,
        index % 2 ? "suggestion.unconfirmed" : "suggestion.posted",
      );
    await expect(
      suggestions.submit(suggester("300000000000000013", [CANARY_GUEST_ROLE]), idea("eleventh")),
    ).rejects.toMatchObject({
      code: "cooldown",
      message: "TaruBot has posted 10 suggestions in the last day, its daily limit.",
      detail: { kind: "limit", limit: "suggest" },
    });
    await clearSuggestions();
    // Two at once from one member: exactly one post, and the other waits its turn and is refused.
    const creates = target?.creates.length ?? 0;
    const racer = suggester("300000000000000014", [CANARY_MEMBER_ROLE]);
    const results = await Promise.allSettled([
      suggestions.submit(racer, idea("race one")),
      suggestions.submit(racer, idea("race two")),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "cooldown" },
    });
    expect((target?.creates.length ?? 0) - creates).toBe(1);
    await clearSuggestions();
  });

  test("/suggest counts every attempt GitHub didn't confirm, and nothing it refused (2.28.0)", async () => {
    const actions = async () => (await suggestionRows()).map((row) => row.action);
    let userSequence = 20;
    const next = () => suggester(`3000000000000000${userSequence++}`, [CANARY_MEMBER_ROLE]);

    // GitHub's rate limit, on the create or on the app's sign-in: nothing was created, so no
    // row, and the member waits.
    for (const where of ["create", "client"] as const) {
      const { suggestions, target } = suggestionHarness();
      const limited = new Failure("rate_limited", "GitHub is rate limiting.", 42);
      if (where === "create") target?.createFailures.push(limited);
      else target?.clientFailures.push(limited);
      await expect(suggestions.submit(next(), idea("rate limited"))).rejects.toMatchObject({
        code: "rate_limited",
        retryAfter: 42,
        detail: { kind: "limit", limit: "suggest", until: expect.any(Date) },
      });
      expect(await actions()).toEqual([]);
    }
    // A refused credential passes through, and a rejected request becomes configuration: neither
    // records a row, and the router reports both privately as unexpected.
    for (const [thrown, code] of [
      [new Failure("configuration", "GitHub refused the issue report (401)."), "configuration"],
      [new Failure("invalid_data", "GitHub rejected the issue report (422)."), "configuration"],
    ] as const) {
      const { suggestions, target } = suggestionHarness();
      target?.createFailures.push(thrown);
      await expect(suggestions.submit(next(), idea("refused"))).rejects.toMatchObject({ code });
      expect(await actions()).toEqual([]);
    }
    // An outage while creating, or while minting the client: unconfirmed, and a retry waits. The
    // sign-in case posted nothing, but shares the one path and card by design.
    for (const where of ["create", "client"] as const) {
      const { suggestions, target } = suggestionHarness();
      const member = next();
      const outage = new Failure("unavailable", "GitHub answered 502.", 60);
      if (where === "create") target?.createFailures.push(outage);
      else target?.clientFailures.push(outage);
      await expect(suggestions.submit(member, idea(`outage ${where}`))).rejects.toMatchObject({
        code: "unavailable",
        detail: { kind: "github" },
      });
      expect(await actions()).toEqual(["suggestion.unconfirmed"]);
      await expect(suggestions.submit(member, idea("retry"))).rejects.toMatchObject({
        code: "cooldown",
      });
      expect(target?.creates).toEqual([]);
      await clearSuggestions();
    }
    // A plain error from create (a timeout reading a created issue's answer arrives as one):
    // unconfirmed, reported privately once, and an immediate retry creates nothing.
    for (const thrown of [
      new Error("unexpected"),
      new DOMException("The operation timed out.", "TimeoutError"),
    ]) {
      const { suggestions, target, reports } = suggestionHarness();
      const member = next();
      target?.createFailures.push(thrown);
      await expect(suggestions.submit(member, idea("plain error"))).rejects.toMatchObject({
        code: "unavailable",
        detail: { kind: "github" },
      });
      expect(reports).toEqual(["/suggest publish"]);
      expect(await suggestionRows()).toEqual([
        {
          guild_id: canaryGuild,
          actor_id: member.userId,
          action: "suggestion.unconfirmed",
          target: null,
          details: { repository: "deconfined/tarubot" },
        },
      ]);
      await expect(suggestions.submit(member, idea("retry"))).rejects.toMatchObject({
        code: "cooldown",
      });
      expect(target?.creates).toEqual([]);
      await clearSuggestions();
    }
  });

  test("/suggest on DevBot previews into the private reports repository (2.28.0)", async () => {
    const { suggestions } = suggestionHarness(new FakeTarget("deconfined/tarubot-reports"));
    const posted = await suggestions.submit(
      suggester("300000000000000040", [CANARY_GUEST_ROLE]),
      idea("preview"),
    );
    expect(posted).toEqual({
      number: 1,
      url: "https://github.com/deconfined/tarubot-reports/issues/1",
      repository: "deconfined/tarubot-reports",
    });
    const embed = suggestionReply(posted).options.embeds[0];
    expect(embed?.url).toBe(posted.url);
    expect(embed?.description).toContain("deconfined/tarubot-reports#1");
    expect((await suggestionRows())[0]).toMatchObject({
      target: "#1",
      details: { repository: "deconfined/tarubot-reports", issue: 1 },
    });
    await clearSuggestions();
  });

  test("a disconnected checked-out session releases locks and the pool reconnects", async () => {
    // Killing an idle checked-out session reproduces a database restart during remote I/O.
    const client = await db.pool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!pid) throw new Error("Missing backend PID");
    await client.query("SELECT pg_advisory_lock(714882493)");
    const disconnected = new Promise<void>((resolve) => client.once("error", () => resolve()));
    await db.query("SELECT pg_terminate_backend($1)", [pid]);
    await disconnected;
    try {
      await expect(client.query("SELECT 1")).rejects.toThrow();
    } finally {
      client.release();
    }
    expect(
      (
        await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(714882493) AS locked")
      )[0]?.locked,
    ).toBe(true);
    expect(db.healthy).toBe(true);
  });

  /**
   * Update posts (2.25.0, issue #30), with the guilds reserved for them: 666666666666666720-729.
   * Each test builds its own guild, filters `sent` by guild and nonce key, and passes its own note
   * map to the dispatcher, so neither the compiled notes nor other tests' posts affect it.
   */
  describe("changelog posts", () => {
    const reserved = (n: number) => `66666666666666672${n}`;
    /** An officer of a reserved guild, for /config changes there. */
    const officerOf = (guildId: string): Actor => ({ ...actor, guildId });
    /** Notes for releases before, at and after the running version. */
    const NOTES = {
      "2.0.0": "Already announced.",
      "2.1.0": "Between the baseline and now.",
      [project.version]: "The running release.",
      "99.0.0": "Not released yet.",
    };
    /** Run one job through the real dispatcher with `notes` as the member-note map. */
    const perform = async (jobId: string, notes: Readonly<Record<string, string>> = NOTES) =>
      new Queue(db, dispatcher(service, sync, access, undefined, notes), () => {}).perform(
        await leased(jobId),
      );
    /** The update posts handed to Discord for a guild. */
    const postsFor = (guildId: string) =>
      sent.filter((post) => post.guild === guildId && post.key.startsWith(`changelog:${guildId}:`));
    /** A guild's stored update-post settings. */
    const stored = async (guildId: string) =>
      (
        await db.orm
          .select({
            channel: t.guilds.changelog_channel_id,
            version: t.guilds.changelog_version,
          })
          .from(t.guilds)
          .where(eq(t.guilds.id, guildId))
      )[0];
    /** A guild with posts on, told about `version` last, and effects as given. */
    async function changelogGuild(guildId: string, version = "2.0.0", effects = true) {
      await db.orm.insert(t.guilds).values({
        id: guildId,
        effects_enabled: effects,
        changelog_channel_id: "82001",
        changelog_version: version,
      });
    }
    /** One job row's status and result. */
    const jobRow = async (jobId: string) =>
      (
        await db.query<{ status: string; result: unknown }>(
          "SELECT status, result FROM jobs WHERE id=$1",
          [jobId],
        )
      )[0];

    test("setting a channel sets the baseline; moving and unsetting keep it; a higher one stays", async () => {
      const guildId = reserved(0);
      const officer = officerOf(guildId);
      // First set (onboarding off): the running version, audited, with no audience lookup.
      const first = await service.configure(officer, "changelog_channel_id", "82001");
      expect(first).toMatchObject({ status: "saved", field: "changelog_channel_id" });
      expect(first.status === "saved" && first.audience).toBeUndefined();
      expect(await stored(guildId)).toEqual({ channel: "82001", version: project.version });
      const audits = await db.query<{ details: unknown }>(
        "SELECT details FROM audit WHERE guild_id=$1 AND action='config' AND target='changelog_channel_id' ORDER BY id",
        [guildId],
      );
      expect(audits[0]?.details).toEqual({ value: "82001", baseline: project.version });
      // Moving the channel keeps the stored version; unsetting keeps it too.
      await db.query("UPDATE guilds SET changelog_version='2.1.0' WHERE id=$1", [guildId]);
      await service.configure(officer, "changelog_channel_id", "82002");
      expect(await stored(guildId)).toEqual({ channel: "82002", version: "2.1.0" });
      await service.configure(officer, "changelog_channel_id", null);
      expect(await stored(guildId)).toEqual({ channel: null, version: "2.1.0" });
      // Setting it again raises the baseline: releases while it was unset are never posted.
      await service.configure(officer, "changelog_channel_id", "82001");
      expect(await stored(guildId)).toEqual({ channel: "82001", version: project.version });
      // A higher stored version (an operator's, or a newer release's) is never lowered.
      await service.configure(officer, "changelog_channel_id", null);
      await db.query("UPDATE guilds SET changelog_version='99.0.0' WHERE id=$1", [guildId]);
      await service.configure(officer, "changelog_channel_id", "82001");
      expect(await stored(guildId)).toEqual({ channel: "82001", version: "99.0.0" });
    });

    test("in an onboarding guild the receipt says who can read the channel", async () => {
      const fixture = await accessFixture(reserved(1));
      const guildId = fixture.guild.id;
      // A staff-only channel onboarding keeps hidden, and a members channel, beside the fixture's.
      await db.orm.insert(t.channelAccessPolicies).values([
        { guild_id: guildId, channel_id: "81010", staff_only: true, original_state: {} },
        { guild_id: guildId, channel_id: "81011", staff_only: false, original_state: {} },
      ]);
      const audience = async (channel: string) => {
        const change = await service.configure(fixture.manager, "changelog_channel_id", channel);
        return change.status === "saved" ? change.audience : undefined;
      };
      expect(await audience("81010")).toBe("hidden");
      // The lobby and the officer room deny Member and Guest view.
      expect(await audience("81001")).toBe("hidden");
      expect(await audience("81002")).toBe("hidden");
      expect(await audience("81011")).toBe("members");
      // No policy row: a channel onboarding doesn't manage (yet).
      expect(await audience("81099")).toBe("unmanaged");
      await service.configure(fixture.manager, "changelog_channel_id", "81010");
      expect((await service.validate(fixture.manager)).changelogAudience).toBe("hidden");
      // With no channel, validate reports no audience.
      await service.configure(fixture.manager, "changelog_channel_id", null);
      expect((await service.validate(fixture.manager)).changelogAudience).toBeUndefined();
    });

    test("the Community Updates channel stays unmanaged, so its warning stays", async () => {
      const fixture = await accessFixture(reserved(2));
      const community: AccessChannel[] = [
        {
          id: "81400",
          name: "Admin",
          type: ChannelType.GuildCategory,
          parentId: null,
          overwrites: [],
          everyoneVisible: true,
          memberVisible: true,
          guestVisible: true,
        },
        {
          id: "81401",
          name: "community-updates",
          type: ChannelType.GuildText,
          parentId: "81400",
          overwrites: [],
          everyoneVisible: true,
          memberVisible: true,
          guestVisible: true,
        },
      ];
      fixture.remote.channels.push(...structuredClone(community));
      fixture.remote.excludedChannelIds = community.map((channel) => channel.id);
      fixture.remote.preserveEveryoneView = true;
      await fixture.policy.reconcile(fixture.guild.id, async () => {});
      const change = await service.configure(fixture.manager, "changelog_channel_id", "81401");
      expect(change.status === "saved" && change.audience).toBe("unmanaged");
      expect((await service.validate(fixture.manager)).changelogAudience).toBe("unmanaged");
      // Onboarding never records it, so a later repair pass doesn't change the answer.
      await fixture.policy.reconcile(fixture.guild.id, async () => {});
      expect(
        await db.orm
          .select()
          .from(t.channelAccessPolicies)
          .where(
            and(
              eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
              eq(t.channelAccessPolicies.channel_id, "81401"),
            ),
          ),
      ).toEqual([]);
      expect((await service.validate(fixture.manager)).changelogAudience).toBe("unmanaged");
    });

    test("a post lists the notes since the baseline once, then moves the baseline", async () => {
      const guildId = reserved(3);
      await changelogGuild(guildId);
      const jobId = await announceChangelog(db.pool, guildId);
      await perform(jobId);
      const posts = postsFor(guildId);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toEqual({
        guild: guildId,
        channel: "82001",
        key: `changelog:${guildId}:${project.version}`,
        message: {
          kind: "changelog",
          view: {
            version: project.version,
            previous: "2.0.0",
            notes: notesSince("2.0.0", project.version, NOTES),
            url: `${project.url}/blob/main/CHANGELOG.md`,
          },
        },
      });
      // Newest first, the running release's note included and the unreleased one left out.
      expect(posts[0]?.message.kind === "changelog" && posts[0].message.view.notes).toEqual([
        { version: project.version, note: "The running release." },
        { version: "2.1.0", note: "Between the baseline and now." },
      ]);
      expect((await stored(guildId))?.version).toBe(project.version);
      expect(await jobRow(jobId)).toEqual({
        status: "succeeded",
        result: {
          status: "delivered",
          messageId: "123456789",
          channelId: "82001",
          version: project.version,
        },
      });
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM delivery_attempts WHERE job_id=$1 ORDER BY id",
            [jobId],
          )
        ).map((row) => row.status),
      ).toEqual(["started", "delivered"]);
      expect(
        await db.query<{ target: string; details: unknown; actor_id: string | null }>(
          "SELECT target, details, actor_id FROM audit WHERE guild_id=$1 AND action='changelog.advanced'",
          [guildId],
        ),
      ).toEqual([
        {
          target: project.version,
          details: { from: "2.0.0", messageId: "123456789" },
          actor_id: null,
        },
      ]);
      // The compare-and-set from a stale baseline changes nothing, audits nothing and never throws.
      expect(await service.advanceChangelog(guildId, "2.0.0", project.version, null)).toBe(false);
      expect(
        await db.query("SELECT id FROM audit WHERE guild_id=$1 AND action='changelog.advanced'", [
          guildId,
        ]),
      ).toHaveLength(1);
      // A repeat is already announced: the first job succeeded, so this is a new row, and the
      // baseline is now the running version.
      const again = await announceChangelog(db.pool, guildId);
      await perform(again);
      expect(await jobRow(again)).toEqual({
        status: "succeeded",
        result: { skipped: "already announced" },
      });
      // A payload naming another version is ignored: the job reads the guild's row.
      const forged = await enqueue(
        db.pool,
        "changelog.post",
        `changelog:${guildId}`,
        { version: "9.9.9" },
        guildId,
      );
      await perform(forged);
      expect((await jobRow(forged))?.result).toEqual({ skipped: "already announced" });
      expect(postsFor(guildId)).toHaveLength(1);
    });

    test("nothing for members moves the baseline without a post or a delivery attempt", async () => {
      const guildId = reserved(5);
      await changelogGuild(guildId);
      const jobId = await announceChangelog(db.pool, guildId);
      await perform(jobId, {});
      expect(await jobRow(jobId)).toEqual({
        status: "succeeded",
        result: { skipped: "nothing for members", version: project.version },
      });
      expect(postsFor(guildId)).toEqual([]);
      expect((await stored(guildId))?.version).toBe(project.version);
      expect(await db.query("SELECT id FROM delivery_attempts WHERE job_id=$1", [jobId])).toEqual(
        [],
      );
      expect(
        (
          await db.query<{ details: unknown }>(
            "SELECT details FROM audit WHERE guild_id=$1 AND action='changelog.advanced'",
            [guildId],
          )
        ).map((row) => row.details),
      ).toEqual([{ from: "2.0.0", messageId: null }]);
    });

    test("missing permissions block without moving the baseline; a /config save releases it once", async () => {
      const guildId = reserved(6);
      await changelogGuild(guildId);
      const jobId = await announceChangelog(db.pool, guildId);
      sendBlocked = true;
      try {
        await perform(jobId);
      } finally {
        sendBlocked = false;
      }
      expect((await jobRow(jobId))?.status).toBe("blocked");
      expect((await stored(guildId))?.version).toBe("2.0.0");
      // Saving the same channel again (after fixing its permissions) requeues the blocked post,
      // and keeps the baseline, since a channel was already set.
      const change = await service.configure(officerOf(guildId), "changelog_channel_id", "82001");
      expect(change).toMatchObject({ status: "saved", rebound: true });
      expect(change.status === "saved" && change.requeued).toBeGreaterThanOrEqual(1);
      expect((await jobRow(jobId))?.status).toBe("queued");
      expect((await stored(guildId))?.version).toBe("2.0.0");
      await perform(jobId);
      expect((await jobRow(jobId))?.status).toBe("succeeded");
      expect(postsFor(guildId)).toHaveLength(1);
      expect((await stored(guildId))?.version).toBe(project.version);
    });

    test("posts turned off while a job waits skip it, even with Discord changes paused", async () => {
      const guildId = reserved(7);
      await changelogGuild(guildId, "2.0.0", false);
      const jobId = await announceChangelog(db.pool, guildId);
      await db.query("UPDATE guilds SET changelog_channel_id=NULL WHERE id=$1", [guildId]);
      await perform(jobId);
      // Completed as skipped before the effects gate, never parked as disabled.
      expect(await jobRow(jobId)).toEqual({
        status: "succeeded",
        result: { skipped: "changelog unconfigured" },
      });
      expect(postsFor(guildId)).toEqual([]);
      expect((await stored(guildId))?.version).toBe("2.0.0");
    });

    test("with Discord changes paused, only a post with something to say parks as disabled", async () => {
      const guildId = reserved(8);
      await changelogGuild(guildId, "2.0.0", false);
      const jobId = await announceChangelog(db.pool, guildId);
      await perform(jobId);
      expect((await jobRow(jobId))?.status).toBe("disabled");
      expect(postsFor(guildId)).toEqual([]);
      expect((await stored(guildId))?.version).toBe("2.0.0");
      // Still paused, the other no-post outcomes complete before the effects gate too, so a
      // paused server never parks a job with nothing to send. A parked row isn't merged, so each
      // announce is a new row, as a paused restart's is.
      const empty = await announceChangelog(db.pool, guildId);
      expect(empty).not.toBe(jobId);
      await perform(empty, {});
      expect(await jobRow(empty)).toEqual({
        status: "succeeded",
        result: { skipped: "nothing for members", version: project.version },
      });
      expect((await stored(guildId))?.version).toBe(project.version);
      const announced = await announceChangelog(db.pool, guildId);
      await perform(announced);
      expect(await jobRow(announced)).toEqual({
        status: "succeeded",
        result: { skipped: "already announced" },
      });
      // Neither sent anything, and the first row stays parked.
      expect(postsFor(guildId)).toEqual([]);
      expect((await jobRow(jobId))?.status).toBe("disabled");
    });

    test("two guilds each get their own post, once", async () => {
      const [left, right] = [reserved(4), reserved(9)];
      await changelogGuild(left);
      // The right guild was told about 2.1.0 already, so its post lists only what's newer.
      await changelogGuild(right, "2.1.0");
      const jobs = [
        await announceChangelog(db.pool, left),
        await announceChangelog(db.pool, right),
      ];
      for (const jobId of jobs) await perform(jobId);
      for (const guildId of [left, right]) {
        expect(postsFor(guildId).map((post) => post.key)).toEqual([
          `changelog:${guildId}:${project.version}`,
        ]);
        expect((await stored(guildId))?.version).toBe(project.version);
      }
      const [only] = postsFor(right);
      expect(only?.message.kind === "changelog" && only.message.view).toMatchObject({
        previous: "2.1.0",
        notes: [{ version: project.version, note: "The running release." }],
      });
    });
  });

  /**
   * Officer status notices (2.29.0, issue #31). Used by these tests: guilds
   * 666666666666666740-769, FCs 9232097761132950100-116, users 9310xxxx-9337xxxx (and the 18-digit
   * 9318…), characters 883xxxxx-887xxxxx and role and channel IDs 824xx. Each test builds its own
   * guild with the four roles bound, the officer notifications channel set and effects on, reads
   * `sent` by guild, and stands in for the two-minute window by moving `status_since` back.
   */
  describe("officer status notices", () => {
    const reserved = (n: number) => String(666666666666666740n + BigInt(n));
    const reservedFc = (n: number) => String(9232097761132950100n + BigInt(n));
    const CHANNEL = "82401";
    const ROLE = { member: "82411", guest: "82412", officer: "82413", leader: "82414" } as const;
    const JOINED = new Date("2026-01-01T00:00:00Z");
    const STALE =
      "UPDATE free_companies SET last_successful_roster_at=now()-interval '7 hours' WHERE id=$1";
    /** An officer, and a server manager, of a reserved guild. */
    const officerOf = (guildId: string): Actor => ({ ...actor, guildId });
    const managerOf = (guildId: string): Actor => ({ ...actor, guildId, serverManager: true });
    /** A guild with its own FC (or none), the four roles bound, the channel given and effects on. */
    async function statusGuild(
      guildId: string,
      fcId: string | null,
      channel: string | null = CHANNEL,
    ) {
      if (fcId)
        await db.orm
          .insert(t.freeCompanies)
          .values({ id: fcId, name: `Status FC ${fcId}`, world: "Diabolos", dc: "Crystal" })
          .onConflictDoNothing();
      await db.orm.insert(t.guilds).values({
        id: guildId,
        fc_id: fcId,
        effects_enabled: true,
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: ROLE.officer,
        leader_role_id: ROLE.leader,
        officer_notifications_channel_id: channel,
      });
    }
    /** A roster member with a plain rank and a known FC Leader flag, so leader decisions count. */
    const fcMember = (id: string, fcId: string, name = `Status ${id}`) => ({
      id,
      name,
      world: "Diabolos",
      dc: "Crystal",
      fcId,
      fcRankName: "Member",
      isFcLeader: false,
    });
    /** A current Discord member with a guild_users row (as enumeration makes) and active links. */
    async function statusMember(
      guildId: string,
      user: string,
      characters: readonly string[] = [],
      roles: string[] = [],
    ) {
      members.set(user, memberView(guildId, user, roles, JOINED));
      await ensureUser(db.pool, guildId, user, JOINED);
      for (const character of characters) await linkCharacter(guildId, user, character);
    }
    /** A member's stored status columns, and the row version (xmin) to tell whether it was written. */
    const statusOf = async (guildId: string, user: string) =>
      (
        await db.query<{
          state: StatusState | null;
          since: Date | null;
          posting: { batch: string } | null;
          xmin: string;
        }>(
          "SELECT status_state AS state, status_since AS since, status_posting AS posting, xmin::text AS xmin FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guildId, user],
        )
      )[0];
    /** The members of a guild with something waiting to be announced. */
    const waiting = async (guildId: string) =>
      (
        await db.query<{ user_id: string }>(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND status_since IS NOT NULL ORDER BY user_id",
          [guildId],
        )
      ).map((row) => row.user_id);
    /** The guild's status job rows, oldest first; `ahead` is a due time still about a window away. */
    const statusJobs = (guildId: string) =>
      db.query<{ id: string; status: string; ahead: boolean }>(
        "SELECT id,status,due_at>now()+interval '100 seconds' AS ahead FROM jobs WHERE dedupe_key=$1 ORDER BY created_at,id",
        [statusNoticeKey(guildId)],
      );
    /** Two minutes pass for every waiting change of the guild. */
    const elapse = (guildId: string) =>
      db.query(
        "UPDATE guild_users SET status_since=status_since-interval '121 seconds' WHERE guild_id=$1 AND status_since IS NOT NULL",
        [guildId],
      );
    /** The status posts handed to Discord for a guild. */
    const statusPosts = (guildId: string) =>
      sent.filter((item) => item.guild === guildId && item.message.kind === "status");
    /** A sent post's frozen entries. */
    const entriesOf = (item: (typeof sent)[number] | undefined) =>
      item?.message.kind === "status" ? item.message.view.entries : [];
    /** A sent status post as officers read it: its fields' names and values. */
    const shown = (item: (typeof sent)[number] | undefined) =>
      item?.message.kind === "status"
        ? (statusPost(item.message.view).options.embeds[0]?.fields ?? []).map(
            ({ name, value }) => ({
              name,
              value,
            }),
          )
        : [];
    const mention = (user: string) => `<@${user}>`;
    /** Grant Guest as an officer would, then run the member's pass. */
    async function grant(guildId: string, user: string) {
      await service.guestAction(officerOf(guildId), user, false, "Status fixture", randomUUID());
      await reconcileIn(guildId, user);
    }
    /**
     * Run the guild's active status job through the queue and the real dispatcher, whatever its due
     * time, and return the row it left.
     */
    async function runStatus(guildId: string, app: Service = service) {
      const [active] = await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE dedupe_key=$1 AND status IN ('queued','running','blocked') ORDER BY created_at DESC, id LIMIT 1",
        [statusNoticeKey(guildId)],
      );
      if (!active) throw new Error("Missing status job");
      await new Queue(db, dispatcher(app, sync, access), () => {}).perform(await leased(active.id));
      return (
        await db.query<{
          id: string;
          status: string;
          result: unknown;
          last_error: string | null;
          attempts: number;
        }>("SELECT id,status,result,last_error,attempts FROM jobs WHERE id=$1", [active.id])
      )[0];
    }
    /** Wait until some session waits on a lock: the operation under test reached it. */
    async function blockedOnLock() {
      for (let tries = 0; tries < 200; tries++) {
        const [row] = await db.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting",
        );
        if (row?.waiting) return;
        await Bun.sleep(25);
      }
      throw new Error("Nothing waited on a lock");
    }

    test("the first pass records a silent baseline; an unchanged pass writes nothing", async () => {
      const [guildId, fcId, user, character] = [reserved(0), reservedFc(0), "93100001", "88310001"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, user, [character]);
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual([ROLE.member]);
      const first = await statusOf(guildId, user);
      const flags = { member: true, guest: false, officer: false, leader: false };
      expect(first?.state).toEqual({
        joined: JOINED.toISOString(),
        announced: flags,
        current: flags,
        reasons: {},
        departed: [],
      });
      expect(first?.since).toBeNull();
      // Nothing moved against a baseline, so nothing is queued or sent.
      expect(await statusJobs(guildId)).toEqual([]);
      await reconcileIn(guildId, user);
      expect((await statusOf(guildId, user))?.xmin).toBe(first?.xmin ?? "");
      expect(statusPosts(guildId)).toEqual([]);
    });

    test("/guest grant posts once after the window; a grant revoked inside it cancels out", async () => {
      const [guildId, fcId, visitor, fleeting] = [
        reserved(1),
        reservedFc(1),
        "93110001",
        "93110002",
      ];
      await statusGuild(guildId, fcId);
      for (const user of [visitor, fleeting]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      expect((await statusOf(guildId, visitor))?.state?.announced).toEqual({
        member: false,
        guest: false,
        officer: false,
        leader: false,
      });
      await grant(guildId, visitor);
      expect(members.get(visitor)?.roles).toEqual([ROLE.guest]);
      expect(await waiting(guildId)).toEqual([visitor]);
      const [queued] = await statusJobs(guildId);
      // Due one window after the change.
      expect(queued).toMatchObject({ status: "queued", ahead: true });
      await elapse(guildId);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 1, members: 1, messageIds: ["123456789"] },
      });
      const [posted] = statusPosts(guildId);
      expect(posted?.channel).toBe(CHANNEL);
      expect(posted?.key).toMatch(/^status:[0-9a-f-]{36}$/);
      expect(shown(posted)).toEqual([
        { name: "No access → Guest · guest grant", value: mention(visitor) },
      ]);
      // The post moved the announced state, and nothing waits any more.
      const after = await statusOf(guildId, visitor);
      expect(after?.state?.announced.guest).toBe(true);
      expect(after).toMatchObject({ since: null, posting: null });
      // Its delivery is recorded like every outbound kind's.
      expect(
        (
          await db.query<{ status: string; message_id: string | null }>(
            "SELECT status, message_id FROM delivery_attempts WHERE job_id=$1 ORDER BY id",
            [queued?.id],
          )
        ).map((attempt) => [attempt.status, attempt.message_id]),
      ).toEqual([
        ["started", null],
        ["delivered", "123456789"],
      ]);
      // A grant revoked inside the window: the job finds nothing to post.
      await grant(guildId, fleeting);
      await service.guestAction(officerOf(guildId), fleeting, true, "Changed mind", randomUUID());
      await reconcileIn(guildId, fleeting);
      expect(await waiting(guildId)).toEqual([]);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { skipped: "nothing to post" },
      });
      expect(statusPosts(guildId)).toHaveLength(1);
    });

    test("stale-roster hand edits and Member rebinds record nothing; fresh passes post nothing", async () => {
      const [guildId, fcId, user, character] = [reserved(2), reservedFc(2), "93120001", "88320001"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, user, [character]);
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      await db.query(STALE, [fcId]);
      // An officer strips Member by hand; with stale evidence the bot can't add it back.
      const view = members.get(user);
      if (view) view.roles = [];
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual([]);
      expect(await waiting(guildId)).toEqual([]);
      // The next accepted roster restores it: the decisive value never left the announced one.
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual([ROLE.member]);
      expect(await waiting(guildId)).toEqual([]);
      // A Member rebind while the roster is stale strips the old role and can't add the new one:
      // not decisive, so not recorded.
      await db.query(STALE, [fcId]);
      await service.configure(officerOf(guildId), "member_role_id", "82421");
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual([]);
      expect((await statusOf(guildId, user))?.state?.announced.member).toBe(true);
      expect(await waiting(guildId)).toEqual([]);
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual(["82421"]);
      // With fresh evidence a rebind keeps the value.
      await service.configure(officerOf(guildId), "member_role_id", "82431");
      await reconcileIn(guildId, user);
      expect(members.get(user)?.roles).toEqual(["82431"]);
      expect(await waiting(guildId)).toEqual([]);
      expect(await statusJobs(guildId)).toEqual([]);
    });

    test("a new Officer role replacing a bound one announces only adopted non-officers", async () => {
      const guildId = reserved(3);
      const [officer, holder, bystander] = ["93130001", "93130002", "93130003"];
      await statusGuild(guildId, reservedFc(3));
      await statusMember(guildId, officer, [], [ROLE.officer]);
      await statusMember(guildId, holder, [], ["82419"]);
      await statusMember(guildId, bystander);
      // The officer holds an override, as /officer grant or an earlier adoption leaves it.
      await db.orm.insert(t.officerOverrides).values({
        guild_id: guildId,
        user_id: officer,
        state: "granted",
        actor_id: actor.userId,
        reason: "Status fixture",
      });
      for (const user of [officer, holder, bystander]) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual([]);
      expect(await service.configure(managerOf(guildId), "officer_role_id", "82419")).toMatchObject(
        { officerHolders: { adopt: true, adopted: 1, sample: [holder] } },
      );
      for (const user of [officer, holder, bystander]) await reconcileIn(guildId, user);
      // The officer moves to the new role and stays an officer: nothing to announce.
      expect(members.get(officer)?.roles).toEqual(["82419"]);
      expect(await waiting(guildId)).toEqual([holder]);
      expect((await statusOf(guildId, holder))?.state).toMatchObject({
        announced: { officer: false },
        current: { officer: true },
        reasons: { officer: "officer_override" },
      });
      await elapse(guildId);
      await runStatus(guildId);
      expect(statusPosts(guildId).map(shown)).toEqual([
        [{ name: "Officer added · officer override", value: mention(holder) }],
      ]);
    });

    test("/setup naming a new FC for linked users is silent: unevaluated links, then a baseline", async () => {
      const [guildId, fcId] = [reserved(4), reservedFc(4)];
      const users = ["93140001", "93140002"];
      const characters = ["88340001", "88340002"];
      await db.orm
        .insert(t.guilds)
        .values({ id: guildId, effects_enabled: true, officer_notifications_channel_id: CHANNEL });
      for (const [index, user] of users.entries())
        await statusMember(guildId, user, [characters[index] ?? ""]);
      // The precondition: no role is bound yet, so every flag stays null.
      expect(
        await db.orm
          .select({
            member: t.guilds.member_role_id,
            guest: t.guilds.guest_role_id,
            officer: t.guilds.officer_role_id,
            leader: t.guilds.leader_role_id,
          })
          .from(t.guilds)
          .where(eq(t.guilds.id, guildId)),
      ).toEqual([{ member: null, guest: null, officer: null, leader: null }]);
      for (const user of users) await reconcileIn(guildId, user);
      for (const user of users)
        expect((await statusOf(guildId, user))?.state?.announced).toEqual({
          member: null,
          guest: null,
          officer: null,
          leader: null,
        });
      let serial = 82440;
      const provisioner: RoleProvisioner = {
        ...discord,
        async members() {
          return [];
        },
        async ensureRole() {
          return { id: String(++serial), created: true };
        },
      };
      await new RoleAdministration(service, provisioner, access).setup(
        managerOf(guildId),
        "Status",
        fcId,
        null,
      );
      const configured = await service.guild(officerOf(guildId));
      expect(configured).toMatchObject({ fc_id: fcId, officer_notifications_channel_id: CHANNEL });
      // Reconciled before the first roster: every link is unevaluated, so only Officer is decided.
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual([]);
      await publishRoster(
        fcId,
        characters.map((character) => fcMember(character, fcId)),
      );
      for (const user of users) await reconcileIn(guildId, user);
      for (const user of users) {
        expect(members.get(user)?.roles).toContain(configured.member_role_id ?? "");
        expect((await statusOf(guildId, user))?.state?.announced).toEqual({
          member: true,
          guest: false,
          officer: false,
          leader: false,
        });
      }
      expect(await waiting(guildId)).toEqual([]);
      expect(await statusJobs(guildId)).toEqual([]);
    });

    test("unlinking the FC posts Member → Guest; relinking posts Guest → Member after its first roster", async () => {
      const [guildId, fcId] = [reserved(5), reservedFc(5)];
      const users = ["93150001", "93150002"];
      const characters = ["88350001", "88350002"];
      const roster = characters.map((character) => fcMember(character, fcId));
      await statusGuild(guildId, fcId);
      for (const [index, user] of users.entries())
        await statusMember(guildId, user, [characters[index] ?? ""]);
      await publishRoster(fcId, roster);
      for (const user of users) await reconcileIn(guildId, user);
      await service.unlinkCompany(officerOf(guildId), fcId);
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual(users);
      await elapse(guildId);
      await runStatus(guildId);
      expect(statusPosts(guildId).map(shown)).toEqual([
        [
          {
            name: "Member → Guest · the server has no linked FC",
            value: users.map(mention).join(", "),
          },
        ],
      ]);
      // The relink comes after the FC's last roster went out of date (with a fresh one, the same
      // post would come at once): until a new roster, nothing is decisive.
      await db.query(STALE, [fcId]);
      expect(await service.configure(officerOf(guildId), "fc_id", fcId)).toMatchObject({
        status: "saved",
      });
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual([]);
      await publishRoster(fcId, roster);
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual(users);
      await elapse(guildId);
      await runStatus(guildId);
      expect(shown(statusPosts(guildId).at(-1))).toEqual([
        {
          name: "Guest → Member · a linked character is in the FC",
          value: users.map(mention).join(", "),
        },
      ]);
      expect(statusPosts(guildId)).toHaveLength(2);
    });

    test("a grant while the only link is unchecked posts once the roster decides it", async () => {
      const [guildId, fcId] = [reserved(6), reservedFc(6)];
      const [user, newcomer] = ["93160001", "93160002"];
      await statusGuild(guildId, fcId);
      // A baseline first: no link yet, so No access is decisive.
      await statusMember(guildId, user);
      await reconcileIn(guildId, user);
      await linkCharacter(guildId, user, "88360001");
      await grant(guildId, user);
      // Guest is added at once (the link is unevaluated and the grant counts), but not recorded.
      expect(members.get(user)?.roles).toEqual([ROLE.guest]);
      expect(await waiting(guildId)).toEqual([]);
      // The same sequence for a member with no baseline yet.
      await statusMember(guildId, newcomer, ["88360002"]);
      await grant(guildId, newcomer);
      expect(members.get(newcomer)?.roles).toEqual([ROLE.guest]);
      expect(await waiting(guildId)).toEqual([]);
      // A roster without either character decides both: one change, one silent baseline.
      await publishRoster(fcId, [fcMember("88360099", fcId)]);
      for (const id of [user, newcomer]) await reconcileIn(guildId, id);
      expect(await waiting(guildId)).toEqual([user]);
      expect((await statusOf(guildId, newcomer))?.state?.announced).toMatchObject({
        member: false,
        guest: true,
      });
      await elapse(guildId);
      await runStatus(guildId);
      expect(statusPosts(guildId).map(shown)).toEqual([
        [{ name: "No access → Guest · guest grant", value: mention(user) }],
      ]);
    });

    test("an unbound role records nothing and a rebind is a silent baseline", async () => {
      const [guildId, fcId, user, character] = [reserved(7), reservedFc(7), "93170001", "88370001"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, user, [character]);
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      await service.configure(officerOf(guildId), "member_role_id", null);
      await service.configure(officerOf(guildId), "guest_role_id", null);
      await reconcileIn(guildId, user);
      expect((await statusOf(guildId, user))?.state?.announced).toEqual({
        member: null,
        guest: null,
        officer: false,
        leader: false,
      });
      // The member's only character is unlinked while Member and Guest are unbound.
      await service.unclaim(officerOf(guildId), user, character, "Moved to another FC");
      await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual([]);
      await service.configure(officerOf(guildId), "member_role_id", "82471");
      await service.configure(officerOf(guildId), "guest_role_id", "82472");
      await reconcileIn(guildId, user);
      // FC history keeps Guest; both values are the new baseline, taken silently.
      const rebound = await statusOf(guildId, user);
      expect(rebound?.state).toMatchObject({
        announced: { member: false, guest: true },
        current: { member: false, guest: true },
      });
      expect(rebound?.since).toBeNull();
      await reconcileIn(guildId, user);
      expect((await statusOf(guildId, user))?.xmin).toBe(rebound?.xmin ?? "");
      expect(await statusJobs(guildId)).toEqual([]);
    });

    test("a rejoin is a silent baseline, with no lost access posted during a stale window", async () => {
      const [guildId, fcId, user, character] = [reserved(8), reservedFc(8), "93180001", "88380001"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, user, [character]);
      await publishRoster(fcId, [fcMember(character, fcId)]);
      await reconcileIn(guildId, user);
      await db.query(STALE, [fcId]);
      // The member leaves and rejoins: Discord drops their roles, and the join time moves.
      const rejoined = new Date("2026-06-01T00:00:00Z");
      members.set(user, memberView(guildId, user, [], rejoined));
      await ensureUser(db.pool, guildId, user, rejoined);
      await reconcileIn(guildId, user);
      const flags = { member: null, guest: null, officer: false, leader: false };
      expect((await statusOf(guildId, user))?.state).toEqual({
        joined: rejoined.toISOString(),
        announced: flags,
        current: flags,
        reasons: {},
        departed: [],
      });
      expect(await waiting(guildId)).toEqual([]);
      expect(await statusJobs(guildId)).toEqual([]);
    });

    test("no guild_users row records nothing; a blocked role write records nothing until fixed", async () => {
      const guildId = reserved(9);
      const [unknown, blocked] = ["93190001", "93190002"];
      await statusGuild(guildId, null);
      members.set(unknown, memberView(guildId, unknown));
      expect(await reconcileIn(guildId, unknown)).toMatchObject({ status: "applied" });
      expect(await statusOf(guildId, unknown)).toBeUndefined();
      expect(await statusJobs(guildId)).toEqual([]);
      await statusMember(guildId, blocked);
      await reconcileIn(guildId, blocked);
      await service.guestAction(officerOf(guildId), blocked, false, "Blocked", randomUUID());
      const roles = discord.roles;
      discord.roles = async () => {
        throw new Failure("blocked", "Test role hierarchy blocked.");
      };
      try {
        await expect(reconcileIn(guildId, blocked)).rejects.toThrow("Test role hierarchy blocked.");
      } finally {
        discord.roles = roles;
      }
      expect(await waiting(guildId)).toEqual([]);
      expect((await statusOf(guildId, blocked))?.state?.current.guest).toBe(false);
      // After the fix the change is compared with the stored state, and waits to be posted.
      await reconcileIn(guildId, blocked);
      expect(await waiting(guildId)).toEqual([blocked]);
      expect((await statusOf(guildId, blocked))?.state?.reasons).toEqual({ guest: "guest_grant" });
    });

    test("confirmed departures: one post with the lost Member and every Left the FC line", async () => {
      const [guildId, fcId] = [reserved(10), reservedFc(10)];
      // One member's only character leaves; an alt leaves while its owner stays in the FC; an owner
      // who already left Discord loses their character.
      const [single, alt, gone] = ["93200001", "93200002", "93200003"];
      const [lone, kept, second, orphan] = ["88400001", "88400002", "88400003", "88400004"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, single, [lone]);
      await statusMember(guildId, alt, [kept, second]);
      await statusMember(guildId, gone, [orphan]);
      await publishRoster(
        fcId,
        [lone, kept, second, orphan].map((character) => fcMember(character, fcId)),
      );
      for (const user of [single, alt, gone]) await reconcileIn(guildId, user);
      absent.add(gone);
      try {
        const start = Date.now() + 1000;
        await publishRoster(fcId, [fcMember(kept, fcId)], new Date(start));
        // The first absence changes nothing: a missing character still counts as confirmed.
        expect(await waiting(guildId)).toEqual([]);
        await publishRoster(fcId, [fcMember(kept, fcId)], new Date(start + 61_000));
        expect(await waiting(guildId)).toEqual([single, alt, gone]);
        expect((await statusOf(guildId, gone))?.state?.departed).toEqual([
          {
            character: orphan,
            name: `Status ${orphan}`,
            world: "Diabolos",
            snapshot: expect.any(String),
          },
        ]);
        for (const user of [single, alt, gone]) await reconcileIn(guildId, user);
        await elapse(guildId);
        expect(await runStatus(guildId)).toMatchObject({
          status: "succeeded",
          result: { status: "delivered", posts: 1, members: 3 },
        });
        expect(statusPosts(guildId).map(shown)).toEqual([
          [
            {
              name: "Member → Guest · no linked character is in the FC",
              value: mention(single),
            },
            {
              name: "Left the FC",
              value: [
                `Status ${lone} @ Diabolos (${mention(single)})`,
                `Status ${second} @ Diabolos (${mention(alt)})`,
                `Status ${orphan} @ Diabolos (${mention(gone)})`,
              ].join("\n"),
            },
          ],
        ]);
        for (const user of [single, alt, gone])
          expect(await statusOf(guildId, user)).toMatchObject({ since: null, posting: null });
      } finally {
        absent.delete(gone);
      }
    });

    test("an FC unlink over 105 members and two former-member guests posts 100, then the rest", async () => {
      const [guildId, fcId] = [reserved(11), reservedFc(11)];
      const linked = Array.from({ length: 105 }, (_, index) => String(93300001 + index));
      const characters = linked.map((_, index) => String(88500001 + index));
      const former = ["93309001", "93309002"];
      const formerCharacters = ["88509001", "88509002"];
      await statusGuild(guildId, fcId);
      for (const [index, user] of linked.entries())
        await statusMember(guildId, user, [characters[index] ?? ""]);
      for (const [index, user] of former.entries())
        await statusMember(guildId, user, [formerCharacters[index] ?? ""]);
      await publishRoster(
        fcId,
        [...characters, ...formerCharacters].map((character) => fcMember(character, fcId)),
      );
      // The former members' links end (as /unclaim would), leaving FC history: Guest.
      await db.orm
        .update(t.links)
        .set({ active: false, ended_at: sql`now()` })
        .where(and(eq(t.links.guild_id, guildId), inArray(t.links.user_id, former)));
      for (const user of [...linked, ...former]) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual([]);
      expect((await statusOf(guildId, former[0] ?? ""))?.state?.announced).toMatchObject({
        member: false,
        guest: true,
      });
      await service.unlinkCompany(officerOf(guildId), fcId);
      for (const user of [...linked, ...former]) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toHaveLength(107);
      await elapse(guildId);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 2, members: 107 },
      });
      const posts = statusPosts(guildId);
      expect(posts.map((item) => entriesOf(item).length)).toEqual([100, 7]);
      // Two batches never share a nonce key.
      expect(new Set(posts.map((item) => item.key)).size).toBe(2);
      const named = posts.flatMap((item) =>
        shown(item).flatMap((field) => field.value.split(", ")),
      );
      expect(named.sort()).toEqual([...linked, ...former].map(mention).sort());
      for (const item of posts) {
        if (item.message.kind !== "status") throw new Error("Expected a status post");
        expect(statusPost(item.message.view).truncated).toBe(false);
        expect(shown(item).map((field) => field.name)).not.toContain("Not listed");
      }
      expect(shown(posts[1])).toContainEqual({
        name: "Guest → No access · no grant, registration or FC history",
        value: former.map(mention).join(", "),
      });
      expect(await waiting(guildId)).toEqual([]);
    }, 60_000);

    test("a batch heavy with departures is sized by the post's budget; the rest follow at once", async () => {
      const [guildId, fcId] = [reserved(12), reservedFc(12)];
      // Discord-length user IDs, so the lines are as long as real ones.
      const users = Array.from({ length: 80 }, (_, index) =>
        String(931800000000000001n + BigInt(index)),
      );
      const characters = users.map((_, index) => String(88600001 + index));
      await statusGuild(guildId, fcId);
      for (const [index, user] of users.entries())
        await statusMember(guildId, user, [characters[index] ?? ""]);
      await publishRoster(
        fcId,
        characters.map((character, index) =>
          fcMember(character, fcId, `Departed Character ${index}`),
        ),
      );
      for (const user of users) await reconcileIn(guildId, user);
      const start = Date.now() + 1000;
      await publishRoster(fcId, [], new Date(start));
      await publishRoster(fcId, [], new Date(start + 61_000));
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toHaveLength(80);
      await elapse(guildId);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 2, members: 80 },
      });
      const posts = statusPosts(guildId);
      const [first, rest] = posts.map((item) => entriesOf(item));
      expect(first?.length).toBeLessThan(80);
      expect((first?.length ?? 0) + (rest?.length ?? 0)).toBe(80);
      // The freeze stopped where one more member would not have fit.
      expect(
        statusFits({
          frozenAt: new Date().toISOString(),
          entries: [...(first ?? []), ...(rest ?? []).slice(0, 1)],
        }),
      ).toBe(false);
      for (const item of posts) {
        if (item.message.kind !== "status") throw new Error("Expected a status post");
        expect(statusFits(item.message.view)).toBe(true);
        const fields = shown(item);
        expect(fields.map((field) => field.name)).not.toContain("Not listed");
        // Everyone in a post is named: in the access group and on their departure line.
        for (const entry of item.message.view.entries) {
          expect(
            fields.some(
              (field) =>
                field.name.startsWith("Member → Guest") &&
                field.value.split(", ").includes(mention(entry.user)),
            ),
          ).toBe(true);
          expect(
            fields.some(
              (field) =>
                field.name.startsWith("Left the FC") &&
                field.value.includes(`(${mention(entry.user)})`),
            ),
          ).toBe(true);
        }
      }
    }, 60_000);

    test("the roster locks a departing owner's row before any characters row", async () => {
      const [guildId, fcId, owner] = [reserved(13), reservedFc(13), "93210001"];
      const [leaving, staying] = ["88700001", "88700002"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, owner, [leaving]);
      await publishRoster(fcId, [fcMember(leaving, fcId), fcMember(staying, fcId)]);
      const start = Date.now() + 1000;
      await publishRoster(fcId, [fcMember(staying, fcId)], new Date(start));
      const holder = await db.pool.connect();
      const probe = await db.pool.connect();
      let confirming: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
          [guildId, owner],
        );
        confirming = publishRoster(fcId, [fcMember(staying, fcId)], new Date(start + 61_000));
        await blockedOnLock();
        // A roster member's characters row is still free: the roster waits before storing any.
        await probe.query("BEGIN");
        await probe.query("SELECT id FROM characters WHERE id=$1 FOR UPDATE NOWAIT", [staying]);
        await probe.query("ROLLBACK");
        await holder.query("COMMIT");
        await confirming;
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await probe.query("ROLLBACK").catch(() => {});
        await confirming?.catch(() => {});
        holder.release();
        probe.release();
      }
      expect((await statusOf(guildId, owner))?.state?.departed).toEqual([
        {
          character: leaving,
          name: `Status ${leaving}`,
          world: "Diabolos",
          snapshot: expect.any(String),
        },
      ]);
      expect(await statusJobs(guildId)).toHaveLength(1);
    });

    test("sync.guild locks the guild's rows up front, in user order", async () => {
      const guildId = reserved(14);
      // The member who left has the lowest user ID, so the ordered lock reaches it first.
      const [left, present] = ["93220001", "93220002"];
      await statusGuild(guildId, null);
      await ensureUser(db.pool, guildId, left, JOINED);
      await statusMember(guildId, present);
      const enumerate = discord.members;
      discord.members = async () => [memberView(guildId, present, [], JOINED)];
      const holder = await db.pool.connect();
      const probe = await db.pool.connect();
      let enumerating: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
          [guildId, left],
        );
        const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        enumerating = sync.guild(guildId, parent);
        await blockedOnLock();
        // The present member's row is still free: the pass waits at its first statement.
        await probe.query("BEGIN");
        await probe.query(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE NOWAIT",
          [guildId, present],
        );
        await probe.query("ROLLBACK");
        await holder.query("COMMIT");
        expect(await enumerating).toMatchObject({ enumerationComplete: true, humans: 1 });
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await probe.query("ROLLBACK").catch(() => {});
        await enumerating?.catch(() => {});
        holder.release();
        probe.release();
        discord.members = enumerate;
      }
      expect(
        await db.query<{ user_id: string; present: boolean }>(
          "SELECT user_id, present FROM guild_users WHERE guild_id=$1 ORDER BY user_id",
          [guildId],
        ),
      ).toEqual([
        { user_id: left, present: false },
        { user_id: present, present: true },
      ]);
    });

    test("a blocked send keeps its batch frozen; the next run resends it first, then waits", async () => {
      const guildId = reserved(15);
      const [first, later] = ["93230001", "93230002"];
      await statusGuild(guildId, null);
      for (const user of [first, later]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      await grant(guildId, first);
      await elapse(guildId);
      sendBlocked = true;
      try {
        expect(await runStatus(guildId)).toMatchObject({ status: "blocked" });
      } finally {
        sendBlocked = false;
      }
      const frozen = await statusOf(guildId, first);
      const batch = frozen?.posting?.batch ?? "";
      expect(batch).toMatch(/^[0-9a-f-]{36}$/);
      expect(frozen?.since).not.toBeNull();
      const [job] = await statusJobs(guildId);
      expect(
        (
          await db.query<{ status: string; diagnostic: string | null }>(
            "SELECT status, diagnostic FROM delivery_attempts WHERE job_id=$1 ORDER BY id",
            [job?.id],
          )
        ).map((attempt) => [attempt.status, attempt.diagnostic]),
      ).toEqual([
        ["started", null],
        ["failed", "blocked"],
      ]);
      // A newer change arrives, then the permission is fixed: the frozen batch goes first, as it
      // was frozen, and the newer change waits for its own window. A reconcile pass due in the
      // same server doesn't hold the resend back either (the plan's precondition): nothing waits
      // before it.
      await grant(guildId, later);
      const pass = `user:${guildId}:${later}`;
      await db.query(
        "UPDATE jobs SET status='queued', lease_until=NULL, due_at=now() WHERE dedupe_key=$1 AND status='running'",
        [pass],
      );
      const waited = await runStatus(guildId);
      expect(waited).toMatchObject({ status: "queued" });
      expect(waited?.last_error).toStartWith("ordered:");
      const posts = statusPosts(guildId);
      expect(posts.map((item) => item.key)).toEqual([`status:${batch}`]);
      expect(entriesOf(posts[0]).map((entry) => entry.user)).toEqual([first]);
      expect(await statusOf(guildId, first)).toMatchObject({ since: null, posting: null });
      expect(await waiting(guildId)).toEqual([later]);
      // The pass is still due, untouched; close it so no later claim picks it up.
      const [due] = await db.query<{ status: string }>(
        "SELECT status FROM jobs WHERE dedupe_key=$1 AND status='queued' AND due_at<=now()",
        [pass],
      );
      expect(due?.status).toBe("queued");
      await db.query(
        "UPDATE jobs SET status='succeeded', completed_at=now() WHERE dedupe_key=$1 AND status='queued'",
        [pass],
      );
    });

    test("a lost lease after the send still marks the batch, so the next run sends nothing", async () => {
      const [guildId, user] = [reserved(16), "93240001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      await reconcileIn(guildId, user);
      await grant(guildId, user);
      await elapse(guildId);
      const [queued] = await statusJobs(guildId);
      const job = await leased(queued?.id ?? "");
      const lost = async () => {
        throw new Failure("lease_lost", "Test lease lost after the send.");
      };
      await expect(dispatcher(service, sync, access)(job, lost)).rejects.toMatchObject({
        code: "lease_lost",
      });
      expect(statusPosts(guildId)).toHaveLength(1);
      const marked = await statusOf(guildId, user);
      expect(marked).toMatchObject({ since: null, posting: null });
      expect(marked?.state?.announced.guest).toBe(true);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { skipped: "nothing to post" },
      });
      expect(statusPosts(guildId)).toHaveLength(1);
    });

    test("a worker whose lease lapsed freezes nothing", async () => {
      const [guildId, user] = [reserved(17), "93250001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      await reconcileIn(guildId, user);
      await grant(guildId, user);
      await elapse(guildId);
      const [queued] = await statusJobs(guildId);
      const job = await leased(queued?.id ?? "");
      await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
      await expect(dispatcher(service, sync, access)(job, async () => {})).rejects.toMatchObject({
        code: "lease_lost",
      });
      const kept = await statusOf(guildId, user);
      expect(kept?.posting).toBeNull();
      expect(kept?.since).not.toBeNull();
      expect(statusPosts(guildId)).toEqual([]);
    });

    test("with no channel, waiting and frozen changes are dropped, even with Discord changes off", async () => {
      const guildId = reserved(18);
      const [frozenUser, waitingUser] = ["93260001", "93260002"];
      await statusGuild(guildId, null);
      for (const user of [frozenUser, waitingUser]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      await grant(guildId, frozenUser);
      await elapse(guildId);
      sendBlocked = true;
      try {
        expect(await runStatus(guildId)).toMatchObject({ status: "blocked" });
      } finally {
        sendBlocked = false;
      }
      expect((await statusOf(guildId, frozenUser))?.posting).not.toBeNull();
      await grant(guildId, waitingUser);
      expect(await waiting(guildId)).toEqual([frozenUser, waitingUser]);
      // /config's unset drops what waits itself (the owner-who-left scenario below). Clearing the
      // column directly leaves it waiting, so the job's own no-channel drop is what clears it here.
      await db.query("UPDATE guilds SET officer_notifications_channel_id=NULL WHERE id=$1", [
        guildId,
      ]);
      const paused = new Service(db, discord, lodestone, { ...config, ENABLE_EFFECTS: false });
      expect(await runStatus(guildId, paused)).toMatchObject({
        status: "succeeded",
        result: { skipped: "officer notifications unconfigured" },
      });
      for (const user of [frozenUser, waitingUser]) {
        const dropped = await statusOf(guildId, user);
        expect(dropped).toMatchObject({ since: null, posting: null });
        // What waited is now the announced state: nothing is saved for later.
        expect(dropped?.state).toMatchObject({
          announced: { guest: true },
          current: { guest: true },
          reasons: {},
          departed: [],
        });
      }
      expect(statusPosts(guildId)).toEqual([]);
    });

    test("a change during a run gets its own run after the window, with a fresh attempt budget", async () => {
      const guildId = reserved(19);
      const [first, second] = ["93280001", "93280002"];
      await statusGuild(guildId, null);
      for (const user of [first, second]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      await grant(guildId, first);
      await elapse(guildId);
      const send = discord.send;
      // A second change lands while the first post is being sent.
      discord.send = async (...args) => {
        discord.send = send;
        await grant(guildId, second);
        return send(...args);
      };
      let requeued: Awaited<ReturnType<typeof runStatus>>;
      try {
        requeued = await runStatus(guildId);
      } finally {
        discord.send = send;
      }
      // Requeued for the newer generation with a full budget, not one attempt spent.
      expect(requeued).toMatchObject({ status: "queued", attempts: 0 });
      expect(await waiting(guildId)).toEqual([second]);
      // That run waits out the new change's window, which refunds its attempt.
      expect(await runStatus(guildId)).toMatchObject({ status: "queued", attempts: 0 });
      await elapse(guildId);
      expect(await runStatus(guildId)).toMatchObject({ status: "succeeded", attempts: 1 });
      expect(
        statusPosts(guildId).map((item) => entriesOf(item).map((entry) => entry.user)),
      ).toEqual([[first], [second]]);
    });

    test("with Discord changes paused the post parks, no timer adds rows, and resuming posts it", async () => {
      const [guildId, user] = [reserved(20), "93270001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      await reconcileIn(guildId, user);
      await grant(guildId, user);
      await elapse(guildId);
      await db.query("UPDATE guilds SET effects_enabled=false WHERE id=$1", [guildId]);
      expect(await runStatus(guildId)).toMatchObject({ status: "disabled" });
      const rows = (await statusJobs(guildId)).length;
      // The scheduler has no status sweep: its ticks add no rows while the post is parked.
      for (let tick = 0; tick < 3; tick++) await sync.schedule();
      expect(await statusJobs(guildId)).toHaveLength(rows);
      await db.query("UPDATE guilds SET effects_enabled=true WHERE id=$1", [guildId]);
      await db.transaction((client) => requeueParked(client, [guildId], ["disabled"]));
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 1 },
      });
      expect(statusPosts(guildId).map(shown)).toEqual([
        [{ name: "No access → Guest · guest grant", value: mention(user) }],
      ]);
    }, 30_000);

    test("relinking the same FC while its last roster is fresh posts Guest → Member at once", async () => {
      const [guildId, fcId] = [reserved(21), reservedFc(14)];
      const users = ["93290001", "93290002"];
      const characters = ["88710001", "88710002"];
      await statusGuild(guildId, fcId);
      for (const [index, user] of users.entries())
        await statusMember(guildId, user, [characters[index] ?? ""]);
      await publishRoster(
        fcId,
        characters.map((character) => fcMember(character, fcId)),
      );
      for (const user of users) await reconcileIn(guildId, user);
      await service.unlinkCompany(officerOf(guildId), fcId);
      for (const user of users) await reconcileIn(guildId, user);
      await elapse(guildId);
      await runStatus(guildId);
      // `/config fc unlink` keeps the membership rows, and the FC's last roster is still fresh, so
      // the relink's repair pass decides Member again with no new roster: the post comes one
      // window after the relink, not after the next roster.
      expect(await service.configure(officerOf(guildId), "fc_id", fcId)).toMatchObject({
        status: "saved",
      });
      for (const user of users) await reconcileIn(guildId, user);
      expect(await waiting(guildId)).toEqual(users);
      await elapse(guildId);
      await runStatus(guildId);
      expect(statusPosts(guildId).map(shown)).toEqual([
        [
          {
            name: "Member → Guest · the server has no linked FC",
            value: users.map(mention).join(", "),
          },
        ],
        [
          {
            name: "Guest → Member · a linked character is in the FC",
            value: users.map(mention).join(", "),
          },
        ],
      ]);
    });

    test("with no channel, a change and a departure are taken as announced and queue nothing", async () => {
      const [guildId, fcId] = [reserved(22), reservedFc(15)];
      const [visitor, owner] = ["93300001", "93300002"];
      const [leaving, staying] = ["88720001", "88720002"];
      await statusGuild(guildId, fcId, null);
      await statusMember(guildId, visitor);
      await statusMember(guildId, owner, [leaving]);
      await publishRoster(fcId, [fcMember(leaving, fcId), fcMember(staying, fcId)]);
      for (const user of [visitor, owner]) await reconcileIn(guildId, user);
      // Owner decision 5: changes made while the channel is unset aren't saved for later. The
      // grant is taken as announced at once rather than waiting for the job to drop it.
      await grant(guildId, visitor);
      expect(await statusOf(guildId, visitor)).toMatchObject({
        since: null,
        state: { announced: { guest: true }, current: { guest: true }, reasons: {} },
      });
      // A confirmed departure isn't recorded, and the owner's row isn't even locked for it.
      const start = Date.now() + 1000;
      await publishRoster(fcId, [fcMember(staying, fcId)], new Date(start));
      await publishRoster(fcId, [fcMember(staying, fcId)], new Date(start + 61_000));
      expect((await statusOf(guildId, owner))?.state?.departed).toEqual([]);
      expect(await waiting(guildId)).toEqual([]);
      expect(await statusJobs(guildId)).toEqual([]);
      // Setting the channel within what would have been the window posts none of it.
      await service.configure(officerOf(guildId), "officer_notifications_channel_id", CHANNEL);
      expect(await statusJobs(guildId)).toEqual([]);
      expect(statusPosts(guildId)).toEqual([]);
    });

    test("a failed mark after the send isn't a failed delivery: the retry only marks it", async () => {
      const [guildId, user] = [reserved(23), "93310001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      await reconcileIn(guildId, user);
      await grant(guildId, user);
      await elapse(guildId);
      // The database fails the first transaction after Discord takes the post: the mark.
      let failNext = false;
      const flaky = new Proxy(db, {
        get(target, property) {
          if (property === "transaction" && failNext) {
            failNext = false;
            return async () => {
              throw new Error("Test database unavailable during the mark.");
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const send = discord.send;
      discord.send = async (...args) => {
        const id = await send(...args);
        failNext = true;
        return id;
      };
      let failed: Awaited<ReturnType<typeof runStatus>>;
      try {
        failed = await runStatus(guildId, new Service(flaky, discord, lodestone, config));
      } finally {
        discord.send = send;
      }
      // An ordinary retry, with the batch still frozen and the post recorded as delivered.
      expect(failed).toMatchObject({ status: "queued", last_error: "transient" });
      const batch = (await statusOf(guildId, user))?.posting?.batch ?? "";
      expect(batch).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        (
          await db.query<{ status: string; message_id: string | null; diagnostic: string | null }>(
            "SELECT status, message_id, diagnostic FROM delivery_attempts WHERE job_id=$1 ORDER BY id",
            [failed?.id],
          )
        ).map((attempt) => [attempt.status, attempt.message_id, attempt.diagnostic]),
      ).toEqual([
        ["started", null, null],
        ["delivered", "123456789", `status:${batch}`],
      ]);
      // The retry finds that attempt and only marks the batch, however late it runs: one post.
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 1, messageIds: ["123456789"] },
      });
      expect(statusPosts(guildId)).toHaveLength(1);
      const marked = await statusOf(guildId, user);
      expect(marked).toMatchObject({ since: null, posting: null });
      expect(marked?.state?.announced.guest).toBe(true);
    });

    test("a channel moved during a run stops the drain; the rerun posts the rest there", async () => {
      const guildId = reserved(24);
      const [first, second] = ["93320001", "93320002"];
      const moved = "82402";
      await statusGuild(guildId, null);
      for (const user of [first, second]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      // A blocked send leaves the first change frozen; the second then waits on its own.
      await grant(guildId, first);
      await elapse(guildId);
      sendBlocked = true;
      try {
        expect(await runStatus(guildId)).toMatchObject({ status: "blocked" });
      } finally {
        sendBlocked = false;
      }
      await grant(guildId, second);
      await elapse(guildId);
      // An officer moves the channel while the frozen batch is being resent.
      const send = discord.send;
      discord.send = async (...args) => {
        discord.send = send;
        await db.query("UPDATE guilds SET officer_notifications_channel_id=$2 WHERE id=$1", [
          guildId,
          moved,
        ]);
        return send(...args);
      };
      let stopped: Awaited<ReturnType<typeof runStatus>>;
      try {
        stopped = await runStatus(guildId);
      } finally {
        discord.send = send;
      }
      // The resent batch went where the run started; the next freeze saw the move and stopped.
      expect(stopped).toMatchObject({ status: "queued" });
      expect(stopped?.last_error).toStartWith("superseded:");
      expect(await waiting(guildId)).toEqual([second]);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 1 },
      });
      expect(
        statusPosts(guildId).map((item) => [
          item.channel,
          entriesOf(item).map((entry) => entry.user),
        ]),
      ).toEqual([
        [CHANNEL, [first]],
        [moved, [second]],
      ]);
    });

    test("sync.guild takes the guild row before any member row", async () => {
      const [guildId, user] = [reserved(25), "93330001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      const enumerate = discord.members;
      discord.members = async () => [memberView(guildId, user, [], JOINED)];
      const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
      const holder = await db.pool.connect();
      let enumerating: Promise<unknown> | undefined;
      try {
        // /config holds the guild row, as before adopting an Officer role's holders.
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM guilds WHERE id=$1 FOR UPDATE", [guildId]);
        enumerating = sync.guild(guildId, parent);
        await blockedOnLock();
        // The pass waits there holding no member row, so the adoption's ensureUser goes ahead.
        await holder.query(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE NOWAIT",
          [guildId, user],
        );
        await holder.query("COMMIT");
        expect(await enumerating).toMatchObject({ enumerationComplete: true, humans: 1 });
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await enumerating?.catch(() => {});
        holder.release();
        discord.members = enumerate;
      }
    });

    test("recording a pass takes the guild row before the member row", async () => {
      const [guildId, user] = [reserved(26), "93340001"];
      await statusGuild(guildId, null);
      await statusMember(guildId, user);
      /** A decisive pass with Guest from a grant, or none. */
      const pass = (guest: boolean) =>
        statusObservation({
          bound: { member: true, guest: true, officer: true, leader: true },
          values: { member: false, guest, officer: false, leader: false },
          decisive: { member: true, guest: true, officer: true, leader: true },
          facts: {
            fcLinked: false,
            officerRankSet: false,
            grant: guest,
            former: false,
            guestRevoked: false,
            manualOfficer: false,
            officerRevoked: false,
          },
        });
      expect(await recordStatus(service, guildId, user, JOINED, pass(false))).toBe(false);
      const holder = await db.pool.connect();
      let recording: Promise<boolean> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM guilds WHERE id=$1 FOR UPDATE", [guildId]);
        recording = recordStatus(service, guildId, user, JOINED, pass(true));
        await blockedOnLock();
        // It holds no member row while it waits, so /config adopting this member goes ahead;
        // its status job insert (FOR KEY SHARE on the guild row) then follows the commit.
        await holder.query(
          "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE NOWAIT",
          [guildId, user],
        );
        await holder.query("COMMIT");
        expect(await recording).toBe(true);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await recording?.catch(() => {});
        holder.release();
      }
      expect(await statusJobs(guildId)).toHaveLength(1);
      expect(await waiting(guildId)).toEqual([user]);
    });

    test("member-row locks leave foreign-key checks free", async () => {
      const guildId = reserved(27);
      // Each operation locks the lower user's row, then waits on the higher one held elsewhere.
      const [lower, higher] = ["93350001", "93350002"];
      await statusGuild(guildId, null);
      for (const user of [lower, higher]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
        await grant(guildId, user);
      }
      await elapse(guildId);
      const enumerate = discord.members;
      discord.members = async () =>
        [lower, higher].map((user) => memberView(guildId, user, [], JOINED));
      const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
      const holder = await db.pool.connect();
      const probe = await db.pool.connect();
      const row = "FROM guild_users WHERE guild_id=$1 AND user_id=$2";
      /** While `operation` holds the lower row: a writer is refused, a foreign-key check isn't. */
      async function heldForWritersOnly(operation: () => Promise<unknown>) {
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 ${row} FOR UPDATE`, [guildId, higher]);
        const running = operation();
        try {
          await blockedOnLock();
          await expect(
            probe.query(`SELECT 1 ${row} FOR UPDATE NOWAIT`, [guildId, lower]),
          ).rejects.toMatchObject({ code: "55P03" });
          // What an insert referencing the member takes (membership_history, links, grants).
          await probe.query(`SELECT 1 ${row} FOR KEY SHARE NOWAIT`, [guildId, lower]);
        } finally {
          await holder.query("COMMIT");
        }
        return running;
      }
      try {
        expect(await heldForWritersOnly(() => sync.guild(guildId, parent))).toMatchObject({
          enumerationComplete: true,
          humans: 2,
        });
        // The status job's freeze locks the waiting rows the same way.
        expect(await heldForWritersOnly(() => runStatus(guildId))).toMatchObject({
          status: "succeeded",
          result: { status: "delivered", posts: 1, members: 2 },
        });
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        probe.release();
        discord.members = enumerate;
      }
    });

    test("with no channel, an unchanged pass clears what a failed job left; a later channel posts only new changes", async () => {
      const guildId = reserved(28);
      const [frozenUser, waitingUser, later] = ["93360001", "93360002", "93360003"];
      await statusGuild(guildId, null);
      for (const user of [frozenUser, waitingUser, later]) {
        await statusMember(guildId, user);
        await reconcileIn(guildId, user);
      }
      await grant(guildId, frozenUser);
      await elapse(guildId);
      // The job's last attempt freezes the first change, then meets an outage (a plain error, so
      // an ordinary retry) with its budget spent: it ends failed with the batch still frozen. A
      // second change lands during that send and merges into the same job, which nothing revives
      // (requeueParked never takes failed jobs).
      const [job] = await statusJobs(guildId);
      await db.query("UPDATE jobs SET attempts=7 WHERE id=$1", [job?.id]);
      const send = discord.send;
      discord.send = async () => {
        discord.send = send;
        await grant(guildId, waitingUser);
        throw new Error("Test Discord outage.");
      };
      try {
        expect(await runStatus(guildId)).toMatchObject({
          status: "failed",
          last_error: "transient",
        });
      } finally {
        discord.send = send;
      }
      expect((await statusJobs(guildId)).map((row) => row.status)).toEqual(["failed"]);
      const frozen = await statusOf(guildId, frozenUser);
      expect(frozen?.posting?.batch).toMatch(/^[0-9a-f-]{36}$/);
      expect(frozen?.since).not.toBeNull();
      expect(frozen?.state).toMatchObject({
        announced: { guest: false },
        current: { guest: true },
      });
      expect(await waiting(guildId)).toEqual([frozenUser, waitingUser]);
      // /config's unset drops all of this itself (the next scenario). Clearing the column directly
      // leaves it, so this reaches the passes' backstop: with no channel, each member's next pass
      // changes nothing, yet clears what waits and the frozen entry, exactly as the job's own drop
      // would have: nothing is saved for later.
      await db.query("UPDATE guilds SET officer_notifications_channel_id=NULL WHERE id=$1", [
        guildId,
      ]);
      for (const user of [frozenUser, waitingUser]) {
        await reconcileIn(guildId, user);
        const dropped = await statusOf(guildId, user);
        expect(dropped).toMatchObject({ since: null, posting: null });
        expect(dropped?.state).toMatchObject({
          announced: { guest: true },
          current: { guest: true },
          reasons: {},
          departed: [],
        });
        // With nothing left to clear, the next pass writes nothing again.
        await reconcileIn(guildId, user);
        expect((await statusOf(guildId, user))?.xmin).toBe(dropped?.xmin ?? "");
      }
      expect(await waiting(guildId)).toEqual([]);
      // Setting the channel again posts only a change made after it, with no stale lines and no
      // resent batch.
      await service.configure(officerOf(guildId), "officer_notifications_channel_id", CHANNEL);
      await grant(guildId, later);
      expect(await waiting(guildId)).toEqual([later]);
      await elapse(guildId);
      expect(await runStatus(guildId)).toMatchObject({
        status: "succeeded",
        result: { status: "delivered", posts: 1, members: 1 },
      });
      expect(statusPosts(guildId).map(shown)).toEqual([
        [{ name: "No access → Guest · guest grant", value: mention(later) }],
      ]);
      expect((await statusJobs(guildId)).map((row) => row.status)).toEqual(["failed", "succeeded"]);
    });

    test("unsetting the channel drops what a failed job froze, for an owner who left too; a later channel posts only new changes", async () => {
      const [guildId, fcId] = [reserved(29), reservedFc(16)];
      // A member whose only character leaves the FC, an owner who already left the Discord server
      // losing theirs (no pass ever reaches them), and a visitor granted Guest once the channel is
      // back. An unlinked character stays, so the roster isn't empty.
      const [single, gone, later] = ["93370001", "93370002", "93370003"];
      const [lone, orphan, staying] = ["88730001", "88730002", "88730003"];
      await statusGuild(guildId, fcId);
      await statusMember(guildId, single, [lone]);
      await statusMember(guildId, gone, [orphan]);
      await statusMember(guildId, later);
      await publishRoster(
        fcId,
        [lone, orphan, staying].map((character) => fcMember(character, fcId)),
      );
      for (const user of [single, gone, later]) await reconcileIn(guildId, user);
      absent.add(gone);
      const enumerate = discord.members;
      const send = discord.send;
      try {
        const start = Date.now() + 1000;
        await publishRoster(fcId, [fcMember(staying, fcId)], new Date(start));
        await publishRoster(fcId, [fcMember(staying, fcId)], new Date(start + 61_000));
        expect(await waiting(guildId)).toEqual([single, gone]);
        await reconcileIn(guildId, single);
        expect(await reconcileIn(guildId, gone)).toMatchObject({ skipped: "user absent or bot" });
        await elapse(guildId);
        // The job's last attempt freezes both members' lines, then meets an outage (a plain error,
        // so an ordinary retry) with its budget spent: it ends failed with the batch still frozen,
        // and nothing revives it (requeueParked never takes failed jobs).
        const [job] = await statusJobs(guildId);
        await db.query("UPDATE jobs SET attempts=7 WHERE id=$1", [job?.id]);
        discord.send = async () => {
          throw new Error("Test Discord outage.");
        };
        expect(await runStatus(guildId)).toMatchObject({
          status: "failed",
          last_error: "transient",
        });
        discord.send = send;
        const batch = (await statusOf(guildId, gone))?.posting?.batch;
        expect(batch).toMatch(/^[0-9a-f-]{36}$/);
        expect((await statusOf(guildId, single))?.posting?.batch).toBe(batch ?? "");
        expect((await statusOf(guildId, gone))?.state?.departed).toHaveLength(1);
        // Unsetting the channel drops all of it in its own transaction, before any pass runs: the
        // owner who left, whom no pass reaches, included. Setting the channel again before the
        // repair pass runs therefore finds nothing to post either.
        await service.configure(officerOf(guildId), "officer_notifications_channel_id", null);
        expect(await waiting(guildId)).toEqual([]);
        for (const user of [single, gone]) {
          const dropped = await statusOf(guildId, user);
          expect(dropped).toMatchObject({ since: null, posting: null });
          expect(dropped?.state).toMatchObject({ reasons: {}, departed: [] });
          expect(dropped?.state?.announced).toEqual(dropped?.state?.current);
        }
        // The repair pass the unset queued enumerates the present members and runs their passes,
        // which find nothing left to clear: the status columns stay as the unset left them (the
        // enumeration itself rewrites the row, so its xmin moves).
        const cleared = await statusOf(guildId, single);
        discord.members = async () =>
          [single, later].flatMap((user) => {
            const member = members.get(user);
            return member ? [member] : [];
          });
        const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        expect(await sync.guild(guildId, parent)).toMatchObject({ enumerationComplete: true });
        for (const user of [single, later]) await reconcileIn(guildId, user);
        const repaired = await statusOf(guildId, single);
        expect(repaired).toMatchObject({ since: null, posting: null });
        expect(repaired?.state).toEqual(cleared?.state ?? null);
        expect(await waiting(guildId)).toEqual([]);
        // With the channel set again, only a change made after it posts, from a new job: no stale
        // "Left the FC" line and no resent batch.
        await service.configure(officerOf(guildId), "officer_notifications_channel_id", CHANNEL);
        await grant(guildId, later);
        expect(await waiting(guildId)).toEqual([later]);
        await elapse(guildId);
        expect(await runStatus(guildId)).toMatchObject({
          status: "succeeded",
          result: { status: "delivered", posts: 1, members: 1 },
        });
        expect(statusPosts(guildId).map(shown)).toEqual([
          [{ name: "No access → Guest · guest grant", value: mention(later) }],
        ]);
        expect((await statusJobs(guildId)).map((row) => row.status)).toEqual([
          "failed",
          "succeeded",
        ]);
        expect(await statusOf(guildId, gone)).toMatchObject({ since: null, posting: null });
      } finally {
        absent.delete(gone);
        discord.members = enumerate;
        discord.send = send;
      }
    });
  });
});
