/**
 * /setup overrides (2.35.0, #46) end to end: RoleAdministration over real PostgreSQL, with
 * DiscordOverrides over the access fixture (tests/fixtures/discord-access.ts), which spies on REST
 * and never logs in. The dry run writes nothing; the real run PUTs only TaruBot's own member
 * entry, keeps synced children synced (also when resuming a stopped run), leaves private
 * categories and deliberate denies alone, records Discord's per-channel refusals and carries on,
 * stops with the named reason when anything it depends on changes, and always writes one
 * 'setup.overrides' audit row (with the parked jobs requeued) when it wrote or learned anything.
 *
 * The fixture's gateway cache doesn't follow REST writes, so `cache()` re-reads the guild the way
 * gateway events would refresh it. The test is confined to its own schema, overrides_it, and uses
 * the fixture's invented IDs (server 100, TaruBot 900, its role 600, Administrator role 701).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { GuildAccess } from "../../src/application/guild-access.js";
import {
  OVERRIDES_TIME_BUDGET_MS,
  type OverridesResult,
  type OverridesWrite,
} from "../../src/application/overrides.js";
import type { RoleProvisioner } from "../../src/application/role-administration.js";
import { RoleAdministration } from "../../src/application/role-administration.js";
import { Service } from "../../src/application/service.js";
import type { Configuration } from "../../src/config/env.js";
import { DiscordOverrides } from "../../src/discord/overrides.js";
import { overridesKind, overridesReply } from "../../src/discord/presenters/setup.js";
import {
  DENY_MASK,
  LABELLED_PERMISSIONS,
  permissionKeys,
  VOICE_DENY_MASK,
} from "../../src/domain/permissions.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { sameOverwriteSet } from "../../src/domain/visibility.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database, orm, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import {
  type ChannelFixture,
  discordAccessFixture,
  discordError,
} from "../fixtures/discord-access.js";
import { onlyEmbed } from "../fixtures/replies.js";
import { VIEWERS } from "../fixtures/results.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "overrides_it";
/** The fixture's server, its owner, and a manager without Administrator. */
const GUILD = "100";
const OWNER = "300";
const MANAGER = "301";

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
/** /setup overrides never reaches the Lodestone. */
const NO_LODESTONE: Lodestone = Object.create(null);

/** The provisioner /setup onboarding would use; /setup overrides must never call it. */
function provisioner(): RoleProvisioner {
  const unused = async (): Promise<never> => {
    throw new Error("/setup overrides used the onboarding provisioner");
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
    ensureRole: unused,
  };
}

/** A server manager; the owner (300) or someone without Administrator (301). */
const actor = (userId = OWNER): Actor => ({
  guildId: GUILD,
  userId,
  officer: true,
  manageRoles: true,
  serverManager: true,
});

/** @everyone may not view: a private area. */
const PRIVATE = () => [
  { id: GUILD, type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
];
/** TaruBot's own member entry in a channel, if any. */
const own = (channel: ChannelFixture) =>
  channel.permission_overwrites.find((entry) => entry.id === "900");
/** Reply keys for a mask. */
const keys = (bits: bigint) => permissionKeys(bits, LABELLED_PERMISSIONS);

describe.skipIf(!url)("/setup overrides against PostgreSQL and the access fixture", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const admin = new Database(url);
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const db = new Database(confined.toString());
  let fixture: ReturnType<typeof discordAccessFixture>;
  let administration: RoleAdministration;

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE guilds, users, jobs, audit CASCADE");
    fixture = discordAccessFixture();
    // TaruBot's role holds the whole core seven, so nothing is left to grant before Administrator
    // comes off unless a test takes something away.
    const role = fixture.roles.find((entry) => entry.id === "600");
    if (role) role.permissions = String(BigInt(role.permissions) | P.ManageNicknames);
    const service = new Service(db, provisioner(), NO_LODESTONE, CONFIG);
    administration = new RoleAdministration(
      service,
      provisioner(),
      new GuildAccess(service, fixture.port),
      new DiscordOverrides(fixture.client),
    );
  });
  afterEach(async () => {
    await fixture.close();
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  /** The server row: no onboarding, with the settings a test names. */
  async function guildRow(values: Partial<typeof t.guilds.$inferInsert> = {}) {
    await db.orm.insert(t.guilds).values({ id: GUILD, effects_enabled: true, ...values });
  }
  /** Re-read the guild and TaruBot's member into the cache, as gateway events would. */
  async function cache() {
    const guild = await fixture.client.guilds.fetch({ guild: GUILD, force: true });
    await guild.members.fetchMe({ force: true });
    return guild;
  }
  /** The server most tests use: the ledger, the kept review channel, a public channel and a private
   * category with a text and a voice child synced to it. */
  function layout() {
    const ledger = fixture.add("ledger", ChannelType.GuildText, PRIVATE());
    const lounge = fixture.add("lounge");
    const reviews = fixture.add("reviews", ChannelType.GuildText, PRIVATE());
    const category = fixture.add("staff", ChannelType.GuildCategory, PRIVATE());
    const text = fixture.add("staff-chat", ChannelType.GuildText, PRIVATE(), category.id);
    const voice = fixture.add("staff-voice", ChannelType.GuildVoice, PRIVATE(), category.id);
    return { ledger, lounge, reviews, category, text, voice };
  }
  /** layout(), its settings saved, TaruBot holding Administrator, and the cache read. */
  async function ready() {
    const server = layout();
    await guildRow({
      ledger_channel_id: server.ledger.id,
      guest_application_channel_id: server.reviews.id,
      guest_applications_enabled: false,
    });
    fixture.botAdministrator(true);
    await cache();
    return server;
  }
  /** Every 'setup.overrides' audit row, oldest first. */
  const audits = () =>
    db.orm
      .select({
        actor: t.auditEvents.actor_id,
        target: t.auditEvents.target,
        details: t.auditEvents.details,
      })
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.guild_id, GUILD), eq(t.auditEvents.action, "setup.overrides")))
      .orderBy(t.auditEvents.id);
  /** The routes of every write, and whether each is TaruBot's own entry. */
  const writes = () => [...fixture.writes];
  const put = (id: string) => `/channels/${id}/permissions/900`;
  /** A real run by the owner. */
  const apply = () => administration.overrides(actor(), true);
  /** An officer notice parked on a channel TaruBot couldn't use, as the queue leaves one. */
  const parkedJob = (key = `officer:${GUILD}`) =>
    db.orm.insert(t.jobs).values({
      kind: "officer.notify",
      guild_id: GUILD,
      payload: { message: "Parked" },
      dedupe_key: key,
      status: "blocked",
      last_error: "blocked: TaruBot needs View Channel.",
    });
  /** The jobs' statuses, in key order. */
  const jobStatuses = async () =>
    (await db.orm.select({ status: t.jobs.status }).from(t.jobs).orderBy(t.jobs.dedupe_key)).map(
      (row) => row.status,
    );
  /** The fields of an applied or stopped result. */
  function real(result: OverridesResult) {
    if (result.status !== "applied" && result.status !== "stopped")
      throw new Error(`Expected a real run's result, got ${result.status}`);
    return result;
  }

  describe("dry runs", () => {
    test("without Administrator: the one blocker, and the entries it can't read listed", async () => {
      const server = layout();
      await guildRow({ ledger_channel_id: server.ledger.id });
      await cache();
      const result = await administration.overrides(actor(), false);
      expect(result).toMatchObject({ status: "plan", blockers: ["administrator"], writes: [] });
      if (result.status !== "plan") throw new Error("unreachable");
      // Obfuscated in the cache: listed, never planned, never read without Administrator.
      expect(result.unreadable).toEqual([
        server.ledger.id,
        server.reviews.id,
        server.category.id,
        server.text.id,
        server.voice.id,
      ]);
      expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toEqual([]);
      // A manager without Administrator couldn't confirm it either.
      expect(await administration.overrides(actor(MANAGER), false)).toMatchObject({
        blockers: ["caller", "administrator"],
      });
    });

    test("with Administrator, obfuscated entries are read fresh and planned, categories first", async () => {
      const server = layout();
      await guildRow({
        ledger_channel_id: server.ledger.id,
        guest_application_channel_id: server.reviews.id,
      });
      // The cache still holds the channels obfuscated when Administrator is turned on.
      await cache();
      fixture.botAdministrator(true);
      const result = await administration.overrides(actor(), false);
      if (result.status !== "plan") throw new Error(`Expected a plan, got ${result.status}`);
      expect(result.blockers).toEqual([]);
      expect(result.unreadable).toEqual([]);
      for (const channel of [
        server.ledger,
        server.reviews,
        server.category,
        server.text,
        server.voice,
      ])
        expect(fixture.reads).toContain(`/channels/${channel.id}`);
      const planned: OverridesWrite[] = [
        // The category: View Channel and the voice mask, the template its children copy.
        {
          id: server.category.id,
          kind: "category",
          posting: false,
          allow: ["ViewChannel"],
          deny: keys(VOICE_DENY_MASK),
          cleared: [],
          inherited: false,
          unsyncs: false,
        },
        // The ledger needs only View Channel here (its role grants the rest), and no mask.
        {
          id: server.ledger.id,
          kind: "channel",
          posting: true,
          allow: ["ViewChannel"],
          deny: [],
          cleared: [],
          inherited: false,
          unsyncs: false,
        },
        // The kept review channel (applications closed) is configured: View, no mask.
        {
          id: server.reviews.id,
          kind: "channel",
          posting: false,
          allow: ["ViewChannel"],
          deny: [],
          cleared: [],
          inherited: false,
          unsyncs: false,
        },
        ...[server.text, server.voice].map(
          (child): OverridesWrite => ({
            id: child.id,
            kind: "channel",
            posting: false,
            allow: ["ViewChannel"],
            deny: keys(VOICE_DENY_MASK),
            cleared: [],
            inherited: true,
            unsyncs: false,
          }),
        ),
      ];
      expect(result.writes).toEqual(planned);
      // Nothing was written: no PUT and no audit row.
      expect(fixture.puts).toEqual([]);
      expect(await audits()).toEqual([]);
      expect(overridesKind(result)).toBe("overrides.plan");
    });

    test("a private category holding the ledger is reported, and nothing in it is planned", async () => {
      const category = fixture.add("officers", ChannelType.GuildCategory, PRIVATE());
      const ledger = fixture.add("ledger", ChannelType.GuildText, PRIVATE(), category.id);
      const sibling = fixture.add("officer-chat", ChannelType.GuildText, PRIVATE(), category.id);
      // A category TaruBot sees through its role, holding another configured channel.
      const seen = [
        ...PRIVATE(),
        { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      ];
      const open = fixture.add("updates", ChannelType.GuildCategory, structuredClone(seen));
      const notices = fixture.add("notices", ChannelType.GuildText, structuredClone(seen), open.id);
      const elsewhere = fixture.add("general", ChannelType.GuildText, PRIVATE());
      await guildRow({
        ledger_channel_id: ledger.id,
        officer_notifications_channel_id: notices.id,
      });
      fixture.botAdministrator(true);
      await cache();
      const result = await administration.overrides(actor(), false);
      if (result.status !== "plan") throw new Error(`Expected a plan, got ${result.status}`);
      expect(result.privateCategories).toEqual([
        { id: category.id, configured: [ledger.id], inside: [ledger.id, sibling.id] },
      ]);
      expect(result.writes.map((write) => write.id)).toEqual([elsewhere.id]);
      expect(overridesKind(result)).toBe("overrides.plan_attention");
    });
  });

  describe("real runs", () => {
    test("only TaruBot's entry is PUT; synced children end equal to their category", async () => {
      const server = await ready();
      // A category write Discord doesn't copy to its synced children: each child is written.
      fixture.discord.propagate = false;
      const before = structuredClone(fixture.channels);
      const result = real(await apply());
      expect(result).toMatchObject({ status: "applied", stopped: null, remaining: 0 });
      expect(writes()).toEqual(
        [server.category, server.ledger, server.reviews, server.text, server.voice].map((channel) =>
          put(channel.id),
        ),
      );
      // Every other entry is exactly as it was.
      for (const channel of fixture.channels) {
        const old = before.find((entry) => entry.id === channel.id);
        expect(channel.permission_overwrites.filter((entry) => entry.id !== "900")).toEqual(
          old?.permission_overwrites.filter((entry) => entry.id !== "900") ?? [],
        );
      }
      for (const child of [server.text, server.voice])
        expect(
          sameOverwriteSet(
            child.permission_overwrites,
            server.category.permission_overwrites,
            GUILD,
          ),
        ).toBe(true);
      expect(own(server.category)).toEqual({
        id: "900",
        type: OverwriteType.Member,
        allow: String(P.ViewChannel),
        deny: String(VOICE_DENY_MASK),
      });
      expect(result.written.filter((write) => write.unsyncs)).toEqual([]);
      // The next run finds nothing to add.
      await cache();
      expect((await apply()).status).toBe("nothing");
    });

    test("with Discord propagating the category write, its synced children count as written", async () => {
      // Discord's documented behaviour, and the fixture's default.
      const server = await ready();
      expect(fixture.discord.propagate).toBe(true);
      const plan = await administration.overrides(actor(), false);
      if (plan.status !== "plan") throw new Error(`Expected a plan, got ${plan.status}`);
      const result = real(await apply());
      expect(result).toMatchObject({ status: "applied", stopped: null, remaining: 0 });
      // Only the category and the unsynced channels are PUT; Discord copied the rest.
      expect(writes()).toEqual(
        [server.category, server.ledger, server.reviews].map((channel) => put(channel.id)),
      );
      // The real run reports exactly what its dry run said it would add, synced children included.
      expect(result.written).toEqual(plan.writes);
      expect(result.skipped).toEqual([]);
      expect(result.written.filter((write) => write.inherited).map((write) => write.id)).toEqual([
        server.text.id,
        server.voice.id,
      ]);
      const [row] = await audits();
      const details = z
        .object({
          written: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              before: z.unknown(),
              after: z.object({ allow: z.string(), deny: z.string() }),
              propagated: z.boolean().optional(),
            }),
          ),
          skipped: z.array(z.string()),
        })
        .parse(row?.details);
      expect(details.skipped).toEqual([]);
      const byId = new Map(details.written.map((write) => [write.id, write]));
      for (const child of [server.text, server.voice])
        expect(byId.get(child.id)).toEqual({
          id: child.id,
          kind: "channel",
          before: null,
          after: { allow: String(P.ViewChannel), deny: String(VOICE_DENY_MASK) },
          propagated: true,
        });
      expect(byId.get(server.category.id)?.propagated).toBeUndefined();
      // The reply's count matches the dry run's.
      const lead = (presented: OverridesResult) =>
        onlyEmbed(overridesReply(presented, VIEWERS.manager)).description ?? "";
      expect(lead(result)).toContain("added its own entry in 5 channels");
      expect(lead(plan)).toContain("would add its own entry in 5 channels");
      await cache();
      expect((await apply()).status).toBe("nothing");
    });

    for (const propagate of [true, false])
      test(`a child differing from its category only by an empty @everyone entry stays synced (${propagate ? "Discord copies the write" : "no copy"})`, async () => {
        // Private without an @everyone deny: role 500, which TaruBot holds, denies View Channel.
        // The category also carries an @everyone entry with no bits, which the child lacks:
        // synced all the same, as discord.js's permissionsLocked (and the fixture) read it.
        fixture.people.set("900", ["600", "500"]);
        const staff = {
          id: "500",
          type: OverwriteType.Role,
          allow: "0",
          deny: String(P.ViewChannel),
        };
        const empty = { id: GUILD, type: OverwriteType.Role, allow: "0", deny: "0" };
        const category = fixture.add("gated", ChannelType.GuildCategory, [empty, { ...staff }]);
        const child = fixture.add("gated-chat", ChannelType.GuildText, [{ ...staff }], category.id);
        await guildRow();
        fixture.botAdministrator(true);
        await cache();
        const plan = await administration.overrides(actor(), false);
        if (plan.status !== "plan") throw new Error(`Expected a plan, got ${plan.status}`);
        // The child copies the category's voice mask instead of getting its own text mask.
        expect(plan.writes).toMatchObject([
          { id: category.id, kind: "category", deny: keys(VOICE_DENY_MASK) },
          { id: child.id, inherited: true, unsyncs: false, deny: keys(VOICE_DENY_MASK) },
        ]);
        fixture.discord.propagate = propagate;
        const result = real(await apply());
        // The real run reports exactly its dry run, whether Discord copied the write or not.
        expect(result).toMatchObject({ status: "applied", skipped: [], remaining: 0 });
        expect(result.written).toEqual(plan.writes);
        expect(writes()).toEqual(
          propagate ? [put(category.id)] : [put(category.id), put(child.id)],
        );
        expect(
          sameOverwriteSet(child.permission_overwrites, category.permission_overwrites, GUILD),
        ).toBe(true);
        const [row] = await audits();
        const written = z
          .object({
            written: z.array(z.object({ id: z.string(), propagated: z.boolean().optional() })),
          })
          .parse(row?.details).written;
        expect(written.find((entry) => entry.id === child.id)?.propagated).toBe(
          propagate ? true : undefined,
        );
      });

    test("a configured channel synced to a visible category gets its own entry and is listed", async () => {
      // TaruBot sees the category but can't embed there: a ledger inside needs its own entry.
      const noEmbeds = [
        { id: GUILD, type: OverwriteType.Role, allow: "0", deny: String(P.EmbedLinks) },
      ];
      const category = fixture.add("fc", ChannelType.GuildCategory, structuredClone(noEmbeds));
      const ledger = fixture.add(
        "ledger",
        ChannelType.GuildText,
        structuredClone(noEmbeds),
        category.id,
      );
      const chat = fixture.add(
        "chat",
        ChannelType.GuildText,
        structuredClone(noEmbeds),
        category.id,
      );
      await guildRow({ ledger_channel_id: ledger.id });
      fixture.botAdministrator(true);
      await cache();
      const result = real(await apply());
      expect(result.written).toEqual([
        {
          id: ledger.id,
          kind: "channel",
          posting: true,
          allow: ["EmbedLinks"],
          deny: [],
          cleared: [],
          inherited: false,
          unsyncs: true,
        },
      ]);
      expect(own(chat)).toBeUndefined();
    });

    test("a private category and everything in it get no PUT, even with Administrator", async () => {
      const category = fixture.add("officers", ChannelType.GuildCategory, PRIVATE());
      const ledger = fixture.add("ledger", ChannelType.GuildText, PRIVATE(), category.id);
      fixture.add("officer-chat", ChannelType.GuildText, PRIVATE(), category.id);
      const general = fixture.add("general", ChannelType.GuildText, PRIVATE());
      await guildRow({ ledger_channel_id: ledger.id });
      fixture.botAdministrator(true);
      await cache();
      const result = real(await apply());
      expect(writes()).toEqual([put(general.id)]);
      expect(result.privateCategories.map((entry) => entry.id)).toEqual([category.id]);
      // Still to fix in Discord, so a rerun is nothing_attention, never an all-clear.
      await cache();
      const again = await apply();
      expect(again.status).toBe("nothing");
      expect(overridesKind(again)).toBe("overrides.nothing_attention");
    });

    test("a configured channel moved into a planned category mid-run stops before its write", async () => {
      const first = fixture.add("archive", ChannelType.GuildCategory, PRIVATE());
      const second = fixture.add("staff", ChannelType.GuildCategory, PRIVATE());
      const ledger = fixture.add("ledger", ChannelType.GuildText, PRIVATE());
      await guildRow({ ledger_channel_id: ledger.id });
      fixture.botAdministrator(true);
      await cache();
      fixture.discord.afterPut = async (id) => {
        if (id !== first.id) return;
        ledger.parent_id = second.id;
        await cache();
      };
      const result = real(await apply());
      expect(result).toMatchObject({ status: "stopped", stopped: "changed" });
      expect(writes()).toEqual([put(first.id)]);
    });

    test("a masked kept review channel gets only its history deny lifted", async () => {
      const reviews = fixture.add("reviews", ChannelType.GuildText, [
        ...PRIVATE(),
        {
          id: "900",
          type: OverwriteType.Member,
          allow: String(P.ViewChannel),
          deny: String(DENY_MASK),
        },
      ]);
      // Kept while applications are closed: configured, but TaruBot doesn't post there.
      await guildRow({
        guest_application_channel_id: reviews.id,
        guest_applications_enabled: false,
      });
      fixture.botAdministrator(true);
      await cache();
      const result = real(await apply());
      expect(result.written).toEqual([
        {
          id: reviews.id,
          kind: "channel",
          posting: false,
          allow: [],
          deny: [],
          cleared: ["ReadMessageHistory"],
          inherited: false,
          unsyncs: false,
        },
      ]);
      expect(fixture.puts[0]?.body).toEqual({
        type: 1,
        allow: String(P.ViewChannel),
        deny: String(DENY_MASK & ~P.ReadMessageHistory),
      });
    });

    test("a rerun after a stop resumes the category's children with its entry", async () => {
      const server = await ready();
      // The resume rule repairs a category write that didn't reach its synced children.
      fixture.discord.propagate = false;
      // The first run stops right after the category's write: a /config save bumps the revision.
      fixture.discord.afterPut = async (id) => {
        if (id === server.category.id)
          await db.query("UPDATE guilds SET revision = revision + 1 WHERE id = $1", [GUILD]);
      };
      expect(real(await apply())).toMatchObject({ status: "stopped", stopped: "precondition" });
      expect(writes()).toEqual([put(server.category.id)]);
      fixture.discord.afterPut = undefined;
      await cache();
      const rerun = real(await apply());
      expect(rerun.status).toBe("applied");
      // The category isn't written again; each synced child copies its entry exactly.
      expect(writes().slice(1)).toEqual(
        [server.ledger, server.reviews, server.text, server.voice].map((channel) =>
          put(channel.id),
        ),
      );
      for (const child of [server.text, server.voice]) {
        expect(own(child)).toEqual(own(server.category));
        expect(
          sameOverwriteSet(
            child.permission_overwrites,
            server.category.permission_overwrites,
            GUILD,
          ),
        ).toBe(true);
      }
      expect(rerun.written.filter((write) => write.unsyncs)).toEqual([]);
      expect(rerun.written.filter((write) => write.inherited).map((write) => write.id)).toEqual([
        server.text.id,
        server.voice.id,
      ]);
      await cache();
      expect((await apply()).status).toBe("nothing");
    });

    test("a resumed category that changed meanwhile stops the rerun before its first child", async () => {
      const server = await ready();
      fixture.discord.propagate = false;
      fixture.discord.afterPut = async (id) => {
        if (id === server.category.id)
          await db.query("UPDATE guilds SET revision = revision + 1 WHERE id = $1", [GUILD]);
      };
      await apply();
      await cache();
      // During the rerun, after the ledger's write, someone takes Connect out of the category's
      // TaruBot entry: it no longer has the shape only this step writes.
      fixture.discord.afterPut = async (id) => {
        if (id !== server.ledger.id) return;
        const entry = own(server.category);
        if (entry) entry.deny = String(BigInt(entry.deny) & ~P.Connect);
      };
      const rerun = real(await apply());
      expect(rerun).toMatchObject({ status: "stopped", stopped: "changed" });
      expect(writes()).not.toContain(put(server.text.id));
      expect(writes()).not.toContain(put(server.voice.id));
    });

    test("Discord refusing one channel is recorded, and the run carries on", async () => {
      const first = fixture.add("first", ChannelType.GuildText, PRIVATE());
      const refused = fixture.add("refused", ChannelType.GuildText, PRIVATE());
      const last = fixture.add("last", ChannelType.GuildText, PRIVATE());
      await guildRow();
      fixture.botAdministrator(true);
      await cache();
      fixture.discord.putError = (id) =>
        id === refused.id ? discordError(50024, 400, "PUT", put(id)) : undefined;
      const result = real(await apply());
      expect(result).toMatchObject({
        status: "applied",
        skipped: [refused.id],
        refused: [refused.id],
      });
      expect(result.written.map((write) => write.id)).toEqual([first.id, last.id]);
      expect(overridesKind(result)).toBe("overrides.applied_attention");
      const [row] = await audits();
      expect(row?.details).toMatchObject({ refused: [{ id: refused.id, code: 50024 }] });
    });

    test("an empty plan returns nothing, auditing only a change to the hidden set", async () => {
      fixture.add("lounge");
      await guildRow();
      fixture.botAdministrator(true);
      await cache();
      expect((await apply()).status).toBe("nothing");
      expect(await audits()).toEqual([]);
      // A channel hidden from TaruBot on purpose is new: one row records it, once.
      const hidden = fixture.add("secret", ChannelType.GuildText, [
        { id: "900", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
      ]);
      await cache();
      const result = await apply();
      expect(result).toMatchObject({ status: "nothing", hiddenOnPurpose: [hidden.id] });
      expect(await audits()).toHaveLength(1);
      expect((await audits())[0]?.details).toMatchObject({
        hiddenOnPurpose: [hidden.id],
        written: [],
      });
      await apply();
      expect(await audits()).toHaveLength(1);
    });

    test("deliberate denies are left alone and recorded; the audit holds IDs and bits only", async () => {
      const denied = fixture.add("ledger", ChannelType.GuildText, [
        { id: "900", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
      ]);
      const hidden = fixture.add("secret", ChannelType.GuildText, [
        { id: "900", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
      ]);
      const general = fixture.add("general", ChannelType.GuildText, PRIVATE());
      await guildRow({ ledger_channel_id: denied.id });
      fixture.botAdministrator(true);
      await cache();
      const result = real(await apply());
      expect(result).toMatchObject({ denied: [denied.id], hiddenOnPurpose: [hidden.id] });
      expect(writes()).toEqual([put(general.id)]);
      const rows = await audits();
      expect(rows).toEqual([
        {
          actor: OWNER,
          target: GUILD,
          details: {
            written: [
              {
                id: general.id,
                kind: "channel",
                before: null,
                after: { allow: String(P.ViewChannel), deny: String(DENY_MASK) },
              },
            ],
            skipped: [],
            refused: [],
            unconfirmed: [],
            normalized: [],
            hiddenOnPurpose: [denied.id, hidden.id].sort(),
            stopped: null,
            // A complete run: it didn't throw, and it reached every planned channel.
            failed: false,
            remaining: 0,
          },
        },
      ]);
    });

    test("a deliberate deny found on the fresh read is left alone, reported and recorded", async () => {
      const server = await ready();
      // Planned from the cache, then denied to TaruBot on purpose before its turn.
      fixture.discord.afterPut = async (id) => {
        if (id !== server.category.id) return;
        server.reviews.permission_overwrites.push({
          id: "900",
          type: OverwriteType.Member,
          allow: "0",
          deny: String(P.ViewChannel),
        });
      };
      const result = real(await apply());
      expect(result).toMatchObject({ status: "applied", denied: [server.reviews.id] });
      expect(result.skipped).toContain(server.reviews.id);
      expect(writes()).not.toContain(put(server.reviews.id));
      const [row] = await audits();
      expect(row?.details).toMatchObject({ hiddenOnPurpose: [server.reviews.id] });
    });

    test("parked jobs are requeued, with no revision bump", async () => {
      await ready();
      await db.orm.insert(t.jobs).values({
        kind: "officer.notify",
        guild_id: GUILD,
        payload: { message: "Parked" },
        dedupe_key: `officer:${GUILD}`,
        status: "blocked",
        last_error: "blocked: TaruBot needs View Channel.",
      });
      const revision = () => db.orm.select({ revision: t.guilds.revision }).from(t.guilds);
      const before = await revision();
      expect(real(await apply()).requeued).toBe(1);
      expect(await db.orm.select({ status: t.jobs.status }).from(t.jobs)).toEqual([
        { status: "queued" },
      ]);
      expect(await revision()).toEqual(before);
    });

    test("a channel deleted mid-run is skipped", async () => {
      const server = await ready();
      fixture.discord.afterPut = async (id) => {
        if (id !== server.ledger.id) return;
        fixture.channels.splice(fixture.channels.indexOf(server.reviews), 1);
      };
      const result = real(await apply());
      expect(result).toMatchObject({ status: "applied", skipped: [server.reviews.id] });
    });

    test("a dropped deny bit is only normalized, and the run carries on", async () => {
      const server = await ready();
      fixture.discord.afterPut = async (id) => {
        if (id !== server.category.id) return;
        const entry = own(server.category);
        if (entry) entry.deny = String(BigInt(entry.deny) & ~P.CreateInstantInvite);
      };
      const result = real(await apply());
      expect(result).toMatchObject({ status: "applied", normalized: [server.category.id] });
    });
  });

  describe("stops", () => {
    test("Discord refusing permissions, and a channel hidden at the fresh read", async () => {
      const server = await ready();
      fixture.discord.putError = (id) =>
        id === server.ledger.id ? discordError(50013, 403, "PUT", put(id)) : undefined;
      expect(real(await apply())).toMatchObject({ status: "stopped", stopped: "permissions" });
      fixture.discord.putError = undefined;
      // A private channel whose cached overwrites are real (not the synthetic shape), so it is
      // planned from the cache and only the loop's fresh read finds it hidden.
      const secret = fixture.add("secret", ChannelType.GuildText, [
        ...PRIVATE(),
        { id: "500", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      ]);
      await cache();
      fixture.discord.channelError = (id) =>
        id === secret.id ? discordError(50001, 403, "GET", `/channels/${id}`) : undefined;
      const hidden = real(await apply());
      expect(hidden).toMatchObject({ status: "stopped", stopped: "permissions" });
      expect(writes()).not.toContain(put(secret.id));
    });

    test("a read-back missing a planned allow bit", async () => {
      const server = await ready();
      fixture.discord.afterPut = async (id) => {
        const entry = own(server.ledger);
        if (id === server.ledger.id && entry) entry.allow = "0";
      };
      const result = real(await apply());
      expect(result).toMatchObject({ status: "stopped", stopped: "changed" });
      // The PUT went out, so it is recorded as written.
      expect(result.written.map((write) => write.id)).toContain(server.ledger.id);
    });

    test("Administrator removed, or the revision bumped, mid-run", async () => {
      const server = await ready();
      fixture.discord.afterPut = async (id) => {
        if (id !== server.category.id) return;
        fixture.botAdministrator(false);
        await cache();
      };
      expect(real(await apply())).toMatchObject({ status: "stopped", stopped: "precondition" });
      fixture.botAdministrator(true);
      await cache();
      fixture.discord.afterPut = async () => {
        await db.query("UPDATE guilds SET revision = revision + 1 WHERE id = $1", [GUILD]);
      };
      expect(real(await apply())).toMatchObject({ status: "stopped", stopped: "precondition" });
    });

    test("the time budget", async () => {
      await ready();
      const clock = performance.now.bind(performance);
      let offset = 0;
      const now = spyOn(performance, "now").mockImplementation(() => clock() + offset);
      try {
        fixture.discord.afterPut = async () => {
          offset = OVERRIDES_TIME_BUDGET_MS + 1;
        };
        const result = real(await apply());
        expect(result).toMatchObject({ status: "stopped", stopped: "time", remaining: 4 });
        expect(result.written).toHaveLength(1);
      } finally {
        now.mockRestore();
      }
    });

    test("drain() mid-PUT stops the run, audits before it resolves, and never rejects", async () => {
      const server = await ready();
      let drained: Promise<void> | undefined;
      fixture.discord.putError = (id, signal) => {
        if (id !== server.ledger.id) return undefined;
        // Shutdown begins while this PUT is in flight.
        drained = administration.drain();
        const abort = new DOMException("This operation was aborted", "AbortError");
        return new Promise((resolve) => {
          if (signal?.aborted) resolve(abort);
          else signal?.addEventListener("abort", () => resolve(abort));
        });
      };
      const running = apply();
      const result = real(await running);
      expect(result).toMatchObject({
        status: "stopped",
        stopped: "stopping",
        unconfirmed: [server.ledger.id],
      });
      await expect(drained).resolves.toBeUndefined();
      const [row] = await audits();
      expect(row?.details).toMatchObject({ unconfirmed: [server.ledger.id], stopped: "stopping" });
      // After a drain, real runs are refused; dry runs still answer.
      await expect(apply()).rejects.toMatchObject({ code: "stopping" });
      expect((await administration.overrides(actor(), false)).status).not.toBe("applied");
    });

    test("drain() during a category's pre-write check audits the category already written", async () => {
      // Two private categories and nothing configured inside: the plan writes both, and each
      // category's write follows the check for a configured channel moved into it.
      const lounge = fixture.add("lounge");
      const first = fixture.add("cat-a", ChannelType.GuildCategory, PRIVATE());
      const second = fixture.add("cat-b", ChannelType.GuildCategory, PRIVATE());
      await guildRow({ ledger_channel_id: lounge.id });
      fixture.botAdministrator(true);
      await cache();
      let drained: Promise<void> | undefined;
      let snapshots = 0;
      // A REST read that never answers: what a slow roles or member fetch looks like to a drain.
      const stalled = Promise.withResolvers<null>();
      const service = new Service(db, provisioner(), NO_LODESTONE, CONFIG);
      class Watched extends DiscordOverrides {
        override async snapshot(id: string, fresh: boolean) {
          // Call 1 is the plan's view; calls 2 and 3 are the two categories' checks.
          if (++snapshots === 3) {
            drained = administration.drain();
            if (fresh) return stalled.promise;
          }
          return super.snapshot(id, fresh);
        }
        // An aborted request fails at once, as @discordjs/rest's does (the fixture ignores it).
        override async read(guild: string, channel: string, signal: AbortSignal) {
          if (signal.aborted) throw new DOMException("This operation was aborted", "AbortError");
          return super.read(guild, channel, signal);
        }
      }
      administration = new RoleAdministration(
        service,
        provisioner(),
        new GuildAccess(service, fixture.port),
        new Watched(fixture.client),
      );
      try {
        const running = apply();
        // Wait for the drain to start, then time it: it must end with the run, well inside 5 s.
        while (!drained) await Bun.sleep(5);
        const started = performance.now();
        await drained;
        expect(performance.now() - started).toBeLessThan(4_000);
        // The audit row is written before drain() resolves, with the first category's write.
        const [row] = await audits();
        expect(row?.details).toMatchObject({ written: [{ id: first.id }], stopped: "stopping" });
        expect(real(await running)).toMatchObject({ status: "stopped", stopped: "stopping" });
        expect(writes()).toEqual([put(first.id)]);
        expect(writes()).not.toContain(put(second.id));
      } finally {
        stalled.resolve(null);
      }
    }, 15_000);

    test("an unexpected error still audits, marked failed with what it never reached, then is thrown", async () => {
      const server = await ready();
      const outage = discordError(0, 500, "PUT", put(server.reviews.id));
      fixture.discord.putError = (id) => (id === server.reviews.id ? outage : undefined);
      await expect(apply()).rejects.toBe(outage);
      const [row] = await audits();
      expect(row?.details).toMatchObject({
        written: [{ id: server.category.id }, { id: server.ledger.id }],
        // Its outcome is unknown to TaruBot, so it is listed as such.
        unconfirmed: [server.reviews.id],
        stopped: null,
        // Never read as a complete run: the text and voice children were never reached.
        failed: true,
        remaining: 2,
      });
    });

    test("a fresh read that throws partway is audited as failed too", async () => {
      const server = await ready();
      // The ledger's fresh read in the loop fails after the category was written. Its cached
      // entry has the synthetic shape, so the run reads it once before planning, too.
      const outage = discordError(0, 500, "GET", `/channels/${server.ledger.id}`);
      let reads = 0;
      fixture.discord.channelError = (id) =>
        id === server.ledger.id && ++reads === 2 ? outage : undefined;
      await expect(apply()).rejects.toBe(outage);
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({
        written: [{ id: server.category.id }],
        unconfirmed: [],
        stopped: null,
        failed: true,
        // The ledger, the review channel and both children.
        remaining: 4,
      });
    });

    test("a PUT Discord applied and then answered 503 is audited as unconfirmed", async () => {
      // Discord stored the entry, then the answer failed after discord.js's retries.
      const other = fixture.add("other", ChannelType.GuildText, PRIVATE());
      const outage = discordError(0, 503, "PUT", put(other.id));
      fixture.discord.afterPut = (id) => {
        if (id === other.id) throw outage;
      };
      await guildRow();
      await parkedJob();
      fixture.botAdministrator(true);
      await cache();
      // The run's first and only PUT: without the fix no row would be written at all.
      await expect(apply()).rejects.toBe(outage);
      expect(own(other)).toMatchObject({ id: "900", allow: String(P.ViewChannel) });
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ written: [], unconfirmed: [other.id] });
      // Discord may have applied it, so parked work runs again (it re-checks the channel itself).
      expect(await jobStatuses()).toEqual(["queued"]);
      // The rerun finds the entry in place: nothing to add, and parked work is requeued again.
      await parkedJob("officer:100:again");
      fixture.discord.afterPut = undefined;
      await cache();
      const rerun = await apply();
      expect(rerun).toMatchObject({ status: "nothing", requeued: 1 });
      expect(await jobStatuses()).toEqual(["queued", "queued"]);
      // Its reply shows the held work, as a /config save's does.
      const fields = onlyEmbed(overridesReply(rerun, VIEWERS.manager)).fields ?? [];
      expect(fields.find((field) => field.name === "Held work")?.value).toContain(
        "1 held job queued again",
      );
      // Nothing changed in the hidden set, so no second audit row.
      expect(await audits()).toHaveLength(1);
    });

    test("a real run with nothing to add requeues parked work; a dry run never does", async () => {
      // TaruBot's entry is already in the only private channel (put there by hand, say).
      fixture.add("secret", ChannelType.GuildText, [
        ...PRIVATE(),
        { id: "900", type: OverwriteType.Member, allow: String(P.ViewChannel), deny: "0" },
      ]);
      await guildRow();
      fixture.botAdministrator(true);
      await cache();
      await parkedJob();
      expect(await administration.overrides(actor(), false)).toMatchObject({
        status: "nothing",
        requeued: 0,
      });
      expect(await jobStatuses()).toEqual(["blocked"]);
      expect(await apply()).toMatchObject({ status: "nothing", requeued: 1 });
      expect(await jobStatuses()).toEqual(["queued"]);
      expect(await audits()).toEqual([]);
    });

    test("the setup lock refuses a concurrent run", async () => {
      await ready();
      const holder = await db.pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`setup:${GUILD}`]);
        await expect(apply()).rejects.toMatchObject({
          code: "busy",
          message:
            "Another /setup or channel pass for this server is in progress. Try again in a minute.",
        });
      } finally {
        await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${GUILD}`]);
        holder.release();
      }
      expect(fixture.puts).toEqual([]);
    });

    test("the real run's preconditions refuse in order", async () => {
      layout();
      await guildRow();
      await cache();
      // A manager without Administrator, then the owner while TaruBot lacks it.
      await expect(administration.overrides(actor(MANAGER), true)).rejects.toMatchObject({
        code: "forbidden",
        detail: { kind: "scope", scope: "administrator" },
      });
      await expect(apply()).rejects.toMatchObject({
        code: "blocked",
        message:
          "TaruBot needs Administrator while /setup overrides confirm:true runs. Turn it on for TaruBot's role, run it again, then remove it once /config validate says it is no longer needed.",
      });
      // TaruBot's own role without the posting permissions it must keep.
      const role = fixture.roles.find((entry) => entry.id === "600");
      const everyone = fixture.roles.find((entry) => entry.id === GUILD);
      if (!role || !everyone) throw new Error("Missing fixture roles");
      role.permissions = String(BigInt(role.permissions) & ~P.EmbedLinks);
      fixture.botAdministrator(true);
      await cache();
      await expect(apply()).rejects.toMatchObject({
        code: "blocked",
        message:
          "Give TaruBot's role View Channel, Send Messages, Embed Links and Read Message History first, so it keeps them once Administrator is off; /config validate lists what's missing.",
      });
      // Paused Discord changes come before Administrator.
      await db.query("UPDATE guilds SET effects_enabled = false WHERE id = $1", [GUILD]);
      await expect(apply()).rejects.toMatchObject({ code: "disabled" });
      expect(fixture.puts).toEqual([]);
      expect(await audits()).toEqual([]);
    });

    test("onboarding on answers onboarding for both kinds of run", async () => {
      const lobby = fixture.add("lobby");
      const officers = fixture.add("officer-chat");
      await guildRow({
        access_policy_enabled: true,
        lobby_channel_id: lobby.id,
        officer_channel_id: officers.id,
        member_role_id: fixture.bindings.member,
        guest_role_id: fixture.bindings.guest,
        officer_role_id: fixture.bindings.officer,
        leader_role_id: fixture.bindings.leader,
      });
      fixture.botAdministrator(true);
      await cache();
      for (const confirm of [false, true])
        expect(await administration.overrides(actor(), confirm)).toEqual({
          status: "onboarding",
          effectsMode: "live",
        });
      expect(fixture.puts).toEqual([]);
    });
  });

  test("a Failure is what a refusal throws, never a raw error", async () => {
    await guildRow();
    await cache();
    const error = await administration
      .overrides(actor(MANAGER), true)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Failure);
    // The dry run and every write used only the one database client each.
    expect(await orm(db.pool).select().from(t.auditEvents)).toEqual([]);
  });
});
