/**
 * Every pausable feature, enforced (2.45.0): for each permission in BLOCKABLE, the real operation
 * that permission guards runs over real PostgreSQL for a member whose pause was written through
 * Moderation.block and read back through Service.enrichActor, as a command would resolve them. The
 * paused call must refuse as a pause (forbidden, scope blocked, naming the permission, the end and
 * the reason) before any external request, with nothing written; after the pause is lifted the
 * same person's same call goes through. A second check pauses every other feature and shows the
 * operation does not care. A last table assertion fails the file when a permission becomes
 * pausable without a row here, so a new feature can't be paused in the dashboard and ignored by
 * the code. Confined to its own schema, pause_enforcement_it, with invented IDs; Discord,
 * Lodestone and GitHub are fakes that count every call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { eq } from "drizzle-orm";
import { IssueReports } from "../../src/application/issue-reports.js";
import { ModMail } from "../../src/application/modmail.js";
import { Moderation } from "../../src/application/moderation.js";
import type { DiscordPort, MemberView } from "../../src/application/records.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { SelfRoles } from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { Suggestions, type SuggestionTarget } from "../../src/application/suggestions.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type { Configuration } from "../../src/config/env.js";
import type { ApiOverwrite, ApiRole } from "../../src/domain/permissions.js";
import { can, holds, NO_ACCESS, pauseOn, type Actor } from "../../src/domain/policy.js";
import { BLOCKABLE, type PermissionId } from "../../src/domain/rbac.js";
import type { SelfRoleMenu } from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import type { VisibilityGuild } from "../../src/domain/visibility.js";
import { Lodestone, type CharacterIdentity } from "../../src/infrastructure/lodestone/client.js";
import { readModMailKey } from "../../src/infrastructure/modmail/cipher.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { actorOf } from "../fixtures/actors.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "pause_enforcement_it";
const GUILD = "666666666666666921";
const FC = "9000000000000001";
const ROLE = {
  member: "523456789012345921",
  guest: "523456789012345922",
  officer: "523456789012345923",
  bot: "523456789012345924",
  kick: "523456789012345925",
  pronoun: "523456789012345926",
  pronoun2: "523456789012345927",
} as const;
const CHANNEL = {
  general: "623456789012345921",
  ledger: "623456789012345922",
  officers: "623456789012345923",
  applications: "623456789012345924",
} as const;
const USER = {
  manager: "723456789012345941",
  officer: "723456789012345942",
  member: "723456789012345943",
  lobby: "723456789012345944",
} as const;
const JOINED = new Date("2026-01-01T00:00:00Z");
const ORIGIN = "https://tarubot.example.org";
const MEMBER_CHARACTER = "9000000000000011";
/** A character nobody has linked, for /claim and /verify to work on. */
const CLAIMED: CharacterIdentity = {
  id: "9000000000000012",
  name: "Claim Target",
  world: "Diabolos",
  dc: "Crystal",
  fcId: null,
};
const CASE_ID_ONE = "00000000-0000-4000-8000-000000000001";
const DEPOSIT_KEY = "00000000-0000-4000-8000-000000000002";
/** A Free Company that is not the one linked, for reads of a previous Free Company's ledger. */
const PREVIOUS_FC = "9000000000000099";

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
const EVERYONE = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect;
/** The server as TaruBot sees it: two cosmetic menu roles below the lowest moderation role. */
function snapshot(): VisibilityGuild {
  const overwrites: ApiOverwrite[] = [];
  return {
    guildId: GUILD,
    bot: { id: "100000000000000099", roles: [ROLE.bot], botRoleId: ROLE.bot },
    roles: [
      role(GUILD, 0, EVERYONE),
      role(ROLE.member, 1),
      role(ROLE.guest, 2),
      role(ROLE.pronoun, 3),
      role(ROLE.pronoun2, 4),
      role(ROLE.kick, 7, P.KickMembers),
      role(ROLE.officer, 8),
      role(ROLE.bot, 20, P.ManageRoles, true),
    ],
    channels: [
      {
        id: CHANNEL.general,
        type: ChannelType.GuildText,
        parentId: null,
        position: 0,
        overwrites,
        obfuscated: false,
      },
    ],
    heldRoles: [],
    communityUpdatesId: null,
  };
}
const MENU: SelfRoleMenu = {
  v: 1,
  categories: [
    {
      id: "00000000-0000-4000-8000-0000000000c1",
      name: "Pronouns",
      description: "",
      max: 1,
      state: "published",
      options: [
        { roleId: ROLE.pronoun, description: "", removalOnly: false },
        { roleId: ROLE.pronoun2, description: "", removalOnly: false },
      ],
    },
  ],
};
const PRONOUNS = MENU.categories[0]?.id ?? "";

/** How a person stands in the server: what the resolver gives for them. */
const ROLES: Record<string, readonly string[]> = {
  [USER.member]: [GUILD, ROLE.member, ROLE.pronoun],
  [USER.lobby]: [GUILD],
  // The Officer role; beforeEach grants this person the officer standing it needs to count.
  [USER.officer]: [GUILD, ROLE.officer],
};

describe.skipIf(!url)("pauses enforced by every feature that can be paused", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());

  /** Every call that left TaruBot, by name: Discord, Lodestone and GitHub. */
  let calls: string[];
  let biography: string;
  const reached = (prefix: string) => calls.filter((call) => call.startsWith(prefix)).length;

  const members = (user: string): MemberView | null => {
    const roles = ROLES[user];
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
  };
  const discord: DiscordPort = {
    member: async (_guild, user) => {
      calls.push("discord.member");
      return members(user);
    },
    members: async () => {
      calls.push("discord.members");
      return [];
    },
    validateRole: async () => {
      calls.push("discord.validateRole");
    },
    validateChannel: async () => {
      calls.push("discord.validateChannel");
    },
    roles: async () => {
      calls.push("discord.roles");
    },
    layoutRoles: async () => {
      calls.push("discord.layoutRoles");
      return {};
    },
    nickname: async () => {
      calls.push("discord.nickname");
      return true;
    },
    send: async () => {
      calls.push("discord.send");
      return "999999999999999901";
    },
    editReview: async () => {
      calls.push("discord.editReview");
      return "999999999999999902";
    },
    dm: async () => {
      calls.push("discord.dm");
    },
    visibility: async () => {
      calls.push("discord.visibility");
      return snapshot();
    },
    cachedRoles: (_guild, user) => {
      calls.push("discord.cachedRoles");
      return ROLES[user] ?? null;
    },
    selfRoles: async () => {
      calls.push("discord.selfRoles");
      return { added: 0, removed: 0, skipped: 0 };
    },
  };
  class CountingLodestone extends Lodestone {
    override async profile(characterId: string) {
      calls.push("lodestone.profile");
      return { ...CLAIMED, id: characterId, biography };
    }
    override async company(fcId: string) {
      calls.push("lodestone.company");
      return { id: fcId, name: "Test FC", tag: "TEST", world: "Diabolos", dc: "Crystal", count: 1 };
    }
    override async roster(): Promise<never> {
      calls.push("lodestone.roster");
      throw new Error("A pause must not read the roster");
    }
  }
  const lodestone = new CountingLodestone();
  const target: SuggestionTarget = {
    repository: "example/suggestions",
    client: async () => {
      calls.push("github.client");
      return {
        create: async () => {
          calls.push("github.create");
          return { number: 4321, state: "open" as const };
        },
      };
    },
  };
  const app = new Service(db, discord, lodestone, CONFIG);
  const report = () => {};
  const suggestions = new Suggestions(app, target, report, [GUILD]);
  const selfRoles = new SelfRoles(app, () => false);
  const modmail = new ModMail(
    app,
    readModMailKey(
      createHash("sha256").update("pause enforcement key").digest().toString("base64"),
    ),
    ORIGIN,
    () => false,
    report,
  );
  const issues = new IssueReports(CONFIG, db, lodestone, new RecentLogs(), null);
  const sync = new Synchronization(app);

  /** A person as the gateway resolves them, then through the real enrichActor. */
  const resolve = async (user: string): Promise<Actor> =>
    app.enrichActor({
      guildId: GUILD,
      userId: user,
      manageRoles: user === USER.manager,
      serverManager: user === USER.manager,
      roleIds: ROLES[user] ?? [],
      botAdministrator: false,
      access: NO_ACCESS,
    });
  // Moderation resolves its target as (guild, user); the target is the second argument.
  const moderation = new Moderation(
    app,
    (_guild, user) => resolve(user),
    () => false,
  );
  /** Server manager: may pause any feature, mod mail included. */
  const MANAGER = actorOf({
    guildId: GUILD,
    userId: USER.manager,
    manageRoles: true,
    serverManager: true,
  });
  const OFFICER = actorOf({
    guildId: GUILD,
    userId: USER.officer,
    manageRoles: false,
    officer: true,
    botAdministrator: false,
  });

  const count = async (table: string, where = "true") =>
    Number(
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]?.n,
    );

  /** One operation a pausable permission guards. */
  interface Row {
    readonly permission: PermissionId;
    readonly operation: string;
    /** Who runs it: a Member-role holder, or someone with no role (the lobby). */
    readonly who: string;
    /** Set up, as the unpaused person, before the pause (a claim before /verify). */
    readonly prepare?: (actor: Actor) => Promise<void>;
    readonly run: (actor: Actor) => Promise<unknown>;
    /** What the operation would otherwise reach first, by call name; null when it reaches nothing. */
    readonly reaches: string | null;
    /** Rows it writes, counted: zero new ones while paused, and some once it goes through. */
    readonly written: () => Promise<number>;
    /** The operation only reads, so it has nothing to count after it goes through. */
    readonly readOnly?: true;
  }
  const ROWS: readonly Row[] = [
    {
      permission: "characters.claim",
      operation: "/claim",
      who: USER.member,
      run: (actor) => app.claim(actor, CLAIMED),
      reaches: "discord.member",
      written: () => count("challenges"),
    },
    {
      permission: "characters.claim",
      operation: "/verify",
      who: USER.member,
      // The claim comes first, as it does for people: its token goes into the profile.
      prepare: async (actor) => {
        const claim = await app.claim(actor, CLAIMED);
        if (claim.status !== "pending") throw new Error("Expected a pending claim");
        biography = claim.token;
        calls = [];
      },
      run: (actor) => app.verify(actor, CLAIMED.id),
      reaches: "lodestone.profile",
      written: () => count("challenges", "consumed_at IS NOT NULL"),
    },
    {
      permission: "roster.refresh",
      operation: "/refresh",
      who: USER.member,
      run: (actor) => sync.refresh(actor, false),
      reaches: null,
      written: async () => (await count("jobs")) + (await count("sync_runs")),
    },
    {
      permission: "guests.apply",
      operation: "/apply",
      who: USER.lobby,
      run: (actor) =>
        app.apply(actor, {
          joinedAt: JOINED,
          introduction: "I enjoy playing games with friends.",
          interest: "A friend invited me to meet your community.",
        }),
      reaches: "discord.validateRole",
      written: async () => (await count("guest_applications")) + (await count("jobs")),
    },
    {
      permission: "ledger.view",
      operation: "/ledger balance",
      who: USER.member,
      run: (actor) => app.ledgerRead(actor, null, null, false),
      reaches: null,
      readOnly: true,
      written: () => count("audit"),
    },
    {
      permission: "ledger.deposit",
      operation: "/ledger deposit",
      who: USER.member,
      run: (actor) => app.ledger(actor, "deposit", 5, "Pause table", DEPOSIT_KEY),
      // Asked before the setup, Discord and membership checks, so a paused deposit reaches nothing.
      reaches: "discord.validateChannel",
      written: async () => (await count("ledger_entries")) + (await count("jobs")),
    },
    {
      permission: "modmail.open",
      operation: "opening a mod mail case",
      who: USER.member,
      prepare: async () => {
        expect(await modmail.toggle(OFFICER, { enabled: true, revision: 1n })).toEqual({
          status: "saved",
        });
      },
      run: (actor) =>
        modmail.open(actor, { topic: "A topic", body: "A message", caseId: CASE_ID_ONE }),
      reaches: null,
      written: async () => (await count("modmail_cases")) + (await count("jobs")),
    },
    {
      permission: "selfroles.use",
      operation: "saving My roles",
      who: USER.member,
      run: (actor) =>
        selfRoles.choose(actor, {
          categories: [{ categoryId: PRONOUNS, seen: [ROLE.pronoun], picked: [ROLE.pronoun2] }],
        }),
      reaches: "discord.visibility",
      written: () => count("jobs", "kind = 'roles.self'"),
    },
    {
      permission: "suggest.use",
      operation: "/suggest",
      who: USER.member,
      run: (actor) => suggestions.submit(actor, "Please add a dark mode to the dashboard."),
      reaches: "github.client",
      written: () => count("audit", "action LIKE 'suggestion.%'"),
    },
    {
      permission: "issue.use",
      operation: "/issue",
      who: USER.member,
      run: (actor) => issues.user(actor, "A member", "REF-ONE", "The bot answered something odd."),
      reaches: null,
      written: () => count("issue_reports"),
    },
  ];

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
      `TRUNCATE guilds, users, free_companies, characters, roster_snapshots, jobs, audit, challenges,
         links, membership, ledger_accounts, ledger_entries, guest_applications, sync_runs,
         issue_reports, self_role_menus, modmail_settings, modmail_cases, officer_overrides CASCADE`,
    );
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: FC, name: "Test FC", tag: "TEST", world: "Diabolos" });
    await db.orm.insert(t.guilds).values({
      id: GUILD,
      fc_id: FC,
      member_role_id: ROLE.member,
      guest_role_id: ROLE.guest,
      officer_role_id: ROLE.officer,
      ledger_channel_id: CHANNEL.ledger,
      officer_notifications_channel_id: CHANNEL.officers,
      guest_application_channel_id: CHANNEL.applications,
      guest_applications_enabled: true,
      effects_enabled: true,
      role_layout_enabled: false,
    });
    for (const user of [USER.manager, USER.officer, USER.member, USER.lobby]) {
      await db.orm.insert(t.users).values({ id: user });
      await db.orm
        .insert(t.guildUsers)
        .values({ guild_id: GUILD, user_id: user, present: true, joined_at: JOINED });
    }
    // The officer's role counts through a manager's grant (as /config officer records it), not
    // through a roster rank, and they are no FC member: the ledger opens for them through
    // ledger.audit alone.
    await db.orm.insert(t.officerOverrides).values({
      guild_id: GUILD,
      user_id: USER.officer,
      state: "granted",
      reason: "Invented grant",
      actor_id: USER.manager,
    });
    // The member is a confirmed member of the linked FC, so the ledger is theirs to read and use.
    await db.orm
      .insert(t.characters)
      .values({ id: MEMBER_CHARACTER, name: "Member Character", world: "Diabolos" });
    await db.orm.insert(t.links).values({
      guild_id: GUILD,
      user_id: USER.member,
      character_id: MEMBER_CHARACTER,
      provenance: "profile_token",
    });
    const [observed] = await db.orm
      .insert(t.rosterSnapshots)
      .values({
        fc_id: FC,
        started_at: JOINED,
        observed_at: JOINED,
        member_count: 1,
        evidence: {},
      })
      .returning({ id: t.rosterSnapshots.id });
    await db.orm.insert(t.membership).values({
      guild_id: GUILD,
      fc_id: FC,
      character_id: MEMBER_CHARACTER,
      state: "present",
      snapshot_id: observed?.id,
      confirmed_snapshot_id: observed?.id,
    });
    await db.orm
      .insert(t.ledgerAccounts)
      .values({ guild_id: GUILD, fc_id: FC, balance: 1000n, sequence: 1n });
    await db.orm.insert(t.selfRoleMenus).values({ guild_id: GUILD, menu: MENU, revision: 5n });
    calls = [];
    biography = "";
  });

  /** Pause `ids` for a person through the real service, as a server manager would. */
  const pause = (user: string, ...ids: PermissionId[]) =>
    moderation.block(MANAGER, user, ids, "1d", `Paused while we look into ${ids.join(" and ")}`);
  /** The refusal an operation answered with, or null when it went through. */
  const outcome = async (operation: Promise<unknown>): Promise<Failure | null> => {
    try {
      await operation;
      return null;
    } catch (error) {
      if (error instanceof Failure) return error;
      throw error;
    }
  };
  const isPause = (failure: Failure | null): boolean =>
    failure?.detail?.kind === "scope" && failure.detail.scope === "blocked";

  test("every pausable permission has a row here, and every row names a pausable one", () => {
    expect([...new Set(ROWS.map((row) => row.permission))].sort()).toEqual([...BLOCKABLE].sort());
    expect(BLOCKABLE.length).toBeGreaterThan(0);
  });

  for (const row of ROWS)
    describe(`${row.permission}: ${row.operation}`, () => {
      test("a pause refuses it as a pause, before any request and with nothing written; lifted, it goes through", async () => {
        const before = await resolve(row.who);
        // The person holds the permission, so only the pause can be what refuses them.
        expect(holds(before, row.permission)).toBe(true);
        expect(can(before, row.permission)).toBe(true);
        await row.prepare?.(before);

        await pause(row.who, row.permission);
        // Counted once the pause is in (its own audit row included), so the refusal adds nothing.
        const written = await row.written();
        const [stored] = await db.orm
          .select({ until: t.memberBlocks.expires_at, reason: t.memberBlocks.reason })
          .from(t.memberBlocks)
          .where(eq(t.memberBlocks.user_id, row.who));
        const paused = await resolve(row.who);
        expect(holds(paused, row.permission)).toBe(true);
        expect(can(paused, row.permission)).toBe(false);
        expect(pauseOn(paused, row.permission)?.reason).toBe(stored?.reason);

        calls = [];
        const refusal = await outcome(row.run(paused));
        expect(refusal).toBeInstanceOf(Failure);
        expect(refusal?.code).toBe("forbidden");
        expect(refusal?.detail as unknown).toEqual({
          kind: "scope",
          scope: "blocked",
          permission: row.permission,
          until: stored?.until,
          reason: stored?.reason,
        });
        // Nothing left TaruBot, not even a read, and nothing was written.
        expect(calls).toEqual([]);
        expect(await row.written()).toBe(written);

        // Lifted, the same person's same call is not refused for that reason: it goes through.
        await moderation.lift(MANAGER, row.who, [row.permission], "Resolved");
        const after = await resolve(row.who);
        expect(can(after, row.permission)).toBe(true);
        calls = [];
        const failure = await outcome(row.run(after));
        expect(failure === null ? null : `${failure.code}: ${failure.message}`).toBeNull();
        // The call reached what it would have reached while paused, so the zero above means something.
        if (row.reaches) expect(reached(row.reaches)).toBeGreaterThan(0);
        // ... and wrote what it writes, so counting zero new rows above counted the right rows.
        if (!row.readOnly) expect(await row.written()).toBeGreaterThan(written);
      });

      test("a pause on every other feature leaves it alone", async () => {
        const before = await resolve(row.who);
        await row.prepare?.(before);
        const others = BLOCKABLE.filter((id) => id !== row.permission && holds(before, id));
        expect(others.length).toBeGreaterThan(0);
        await pause(row.who, ...others);
        const paused = await resolve(row.who);
        expect(paused.access.blocked.size).toBe(others.length);
        expect(can(paused, row.permission)).toBe(true);
        calls = [];
        const failure = await outcome(row.run(paused));
        expect(failure === null ? null : `${failure.code}: ${failure.message}`).toBeNull();
      });
    });

  describe("mod mail: a pause stops new cases only", () => {
    test("a paused person still reads and answers the cases they have; the page says why they can't open one", async () => {
      expect(await modmail.toggle(OFFICER, { enabled: true, revision: 1n })).toEqual({
        status: "saved",
      });
      const opened = await modmail.open(await resolve(USER.member), {
        topic: "A topic",
        body: "A message",
        caseId: CASE_ID_ONE,
      });
      if (opened.status !== "opened") throw new Error(`Expected opened, got ${opened.status}`);
      expect((await modmail.mine(await resolve(USER.member))).openRefusal).toBeNull();

      await pause(USER.member, "modmail.open");
      const paused = await resolve(USER.member);
      expect(can(paused, "modmail.open")).toBe(false);
      expect(holds(paused, "modmail.open")).toBe(true);
      const mine = await modmail.mine(paused);
      expect(mine.openRefusal).toBe("paused");
      expect(mine.cases.map((summary) => summary.number)).toEqual([opened.number]);
      const view = await modmail.caseView(paused, opened.number);
      expect(view).not.toBeNull();
      const reply = await modmail.reply(paused, opened.number, {
        messageId: "00000000-0000-4000-8000-000000000003",
        body: "Still here",
        signing: null,
      });
      expect(reply?.status).toBe("saved");
      // A second case is refused as a pause, in the same words as anywhere else.
      const refusal = await outcome(
        modmail.open(paused, { topic: "Another", body: "Another message" }),
      );
      expect(isPause(refusal)).toBe(true);
      expect(await count("modmail_cases")).toBe(1);
    });
  });

  describe("My roles: a pause turns the form off, not the page", () => {
    test("the page opens with the pause shown and saving off; lifted, saving is on again", async () => {
      const open = await selfRoles.view(await resolve(USER.member));
      expect(open).toMatchObject({
        configured: true,
        available: true,
        paused: null,
        canSave: true,
      });

      await pause(USER.member, "selfroles.use");
      const paused = await resolve(USER.member);
      const page = await selfRoles.view(paused);
      expect(page.paused).toEqual(pauseOn(paused, "selfroles.use") ?? null);
      expect(page.paused?.reason).toContain("selfroles.use");
      expect(page.canSave).toBe(false);
      // The menu is still shown, with what the person holds ticked.
      expect(page.categories).toHaveLength(1);
      expect(page.categories[0]?.options.filter((option) => option.ticked)).toHaveLength(1);

      await moderation.lift(MANAGER, USER.member, ["selfroles.use"], "Resolved");
      const lifted = await selfRoles.view(await resolve(USER.member));
      expect(lifted).toMatchObject({ paused: null, canSave: true });
    });
  });

  describe("the ledger: a pause holds for officers who read it through ledger.audit", () => {
    /** The refusal a read answered with, which must be this person's pause on reading the ledger. */
    const expectPause = (
      failure: Failure | null,
      stored: { until: Date | null; reason: string },
    ) => {
      expect(failure).toBeInstanceOf(Failure);
      expect(failure?.code).toBe("forbidden");
      expect(failure?.detail as unknown).toEqual({
        kind: "scope",
        scope: "blocked",
        permission: "ledger.view",
        ...(stored.until && { until: stored.until }),
        reason: stored.reason,
      });
    };

    test("a manager's pause on ledger.view stops an officer from reading the ledger; lifted, they read again", async () => {
      const officer = await resolve(USER.officer);
      // Only the pause can be what refuses them: they hold ledger.view and ledger.audit, are no
      // server manager, and are no member of the Free Company, so without the pause the audit
      // permission is what opens the ledger to them.
      expect(officer.access).toMatchObject({ manager: false, roles: ["officer"] });
      expect(holds(officer, "ledger.view")).toBe(true);
      expect(can(officer, "ledger.audit")).toBe(true);
      expect(await count("links", `user_id = '${USER.officer}'`)).toBe(0);
      expect(await app.ledgerRead(officer, null, null, false)).toMatchObject({
        view: "balance",
        balanceState: "known",
      });

      await pause(USER.officer, "ledger.view");
      const [stored] = await db.orm
        .select({ until: t.memberBlocks.expires_at, reason: t.memberBlocks.reason })
        .from(t.memberBlocks)
        .where(eq(t.memberBlocks.user_id, USER.officer));
      if (!stored) throw new Error("Expected the pause to be stored");
      const paused = await resolve(USER.officer);
      expect(can(paused, "ledger.view")).toBe(false);
      expect(pauseOn(paused, "ledger.view")?.reason).toBe(stored.reason);
      // They still hold ledger.audit: the pause is what refuses them, not a missing permission.
      expect(can(paused, "ledger.audit")).toBe(true);

      // The balance, the history, a page of it and a previous Free Company's ledger all refuse as
      // the pause, before any request.
      calls = [];
      const audit = await count("audit");
      for (const read of [
        () => app.ledgerRead(paused, null, null, false),
        () => app.ledgerRead(paused, null, null, true),
        () => app.ledgerRead(paused, FC, "2", true, "current"),
        () => app.ledgerRead(paused, PREVIOUS_FC, null, true),
      ])
        expectPause(await outcome(read()), stored);
      expect(calls).toEqual([]);
      expect(await count("audit")).toBe(audit);
      // The pause is on reading only: the officer's other ledger permissions are untouched.
      expect(can(paused, "ledger.deposit")).toBe(true);

      await moderation.lift(MANAGER, USER.officer, ["ledger.view"], "Resolved");
      const lifted = await resolve(USER.officer);
      expect(can(lifted, "ledger.view")).toBe(true);
      expect(lifted.access.blocked.size).toBe(0);
      expect(await app.ledgerRead(lifted, null, null, false)).toMatchObject({
        view: "balance",
        balanceState: "known",
      });
      expect(await app.ledgerRead(lifted, null, null, true)).toMatchObject({ view: "history" });
    });

    test("the pause comes before the checks that would otherwise answer: a previous Free Company's ledger, a ledger channel not chosen", async () => {
      // A member who may not read a previous Free Company's ledger is told so; paused, they are
      // told about the pause, which is the thing they can do something about.
      const member = await resolve(USER.member);
      const previous = await outcome(app.ledgerRead(member, PREVIOUS_FC, null, false));
      expect(previous?.detail).toEqual({
        kind: "scope",
        scope: "officer",
        permission: "ledger.audit",
      });
      await pause(USER.member, "ledger.view", "ledger.deposit");
      const paused = await resolve(USER.member);
      expect(isPause(await outcome(app.ledgerRead(paused, PREVIOUS_FC, null, false)))).toBe(true);

      // A deposit with no ledger channel chosen is told to choose one; paused, it is the pause.
      await moderation.lift(MANAGER, USER.member, ["ledger.deposit"], "Resolved");
      await db.orm.update(t.guilds).set({ ledger_channel_id: null }).where(eq(t.guilds.id, GUILD));
      const unpaused = await resolve(USER.member);
      const setup = await outcome(app.ledger(unpaused, "deposit", 5, "Pause table", DEPOSIT_KEY));
      expect(setup?.detail).toEqual({ kind: "setup", missing: "ledger" });
      await pause(USER.member, "ledger.deposit");
      calls = [];
      const again = await outcome(
        app.ledger(await resolve(USER.member), "deposit", 5, "Pause table", DEPOSIT_KEY),
      );
      expect(isPause(again)).toBe(true);
      expect(again?.detail).toMatchObject({ permission: "ledger.deposit" });
      expect(calls).toEqual([]);
    });
  });

  describe("pausing something else", () => {
    test("a pause on one person touches no one else", async () => {
      await pause(USER.member, "suggest.use", "issue.use");
      const other = await resolve(USER.lobby);
      expect(other.access.blocked.size).toBe(0);
      expect(
        await outcome(
          issues.user(other, "A visitor", "REF-TWO", "The bot answered something odd."),
        ),
      ).toBeNull();
    });
  });
});
