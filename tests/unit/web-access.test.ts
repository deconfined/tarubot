/**
 * Who may open a web page (#43, D2–D4, D17): the admits() matrix over the actors slash commands
 * resolve, members and guests included with the A2 gate (2.40.0), the 60-second GET memo and the
 * fresh resolution every POST and sign-in uses, each use's resolution mode (light for GETs and
 * sign-in, full for POSTs), gone actors as "not admitted", the server list and the server
 * navigation. definePage's validation, access included, is in web-pages.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import { type Actor, type ActorResolution, selfServiceAccess } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import {
  ACTOR_MEMO_MS,
  AccessResolver,
  admits,
  listServers,
  type PageAccess,
  SERVER_LIST_LIMIT,
  type WebGuild,
} from "../../src/web/access.js";
import { html } from "../../src/web/html.js";
import { navLinks } from "../../src/web/layout.js";
import { definePage, type Page } from "../../src/web/page.js";

const GUILD = "100000000000000001";
const USER = "200000000000000002";

/** An actor as main.ts's resolver returns it: gateway.actor, then Service.enrichActor. */
const actor = (overrides: Partial<Actor> = {}): Actor => ({
  guildId: GUILD,
  userId: USER,
  officer: false,
  manageRoles: false,
  serverManager: false,
  roleIds: [],
  ...overrides,
});

/** The actors the matrix covers, named by how they got (or lost) their authority. */
const ACTORS = {
  // Manage Server and Manage Roles: a server manager.
  manager: actor({ officer: true, serverManager: true, manageRoles: true }),
  // Manage Server alone: an officer, but not allowed to change officer authority.
  serverManagerOnly: actor({ officer: true, serverManager: true }),
  // The Officer role with rank access (enrichActor set officer); no Discord permissions.
  roleOfficer: actor({ officer: true, roleIds: ["300"] }),
  // The Officer role with Manage Roles but not Manage Server: still not a manager.
  roleOfficerManageRoles: actor({ officer: true, manageRoles: true, roleIds: ["300"] }),
  // The Officer role whose rank access was revoked (enrichActor left officer false).
  revokedOfficer: actor({ roleIds: ["300"] }),
  // In the server with neither access role (a lobby newcomer, an ex-member, a revoked guest).
  lobby: actor({ botAdministrator: false }),
  // The bound Member role, or the bound Guest role, with TaruBot holding no Administrator (A2).
  member: actor({ member: true, botAdministrator: false, roleIds: ["400"] }),
  guest: actor({ guest: true, botAdministrator: false, roleIds: ["500"] }),
  // A member in a Discord time-out may still open their pages; their saves are refused.
  timedOutMember: actor({ member: true, botAdministrator: false, timedOut: true }),
  // A2: while TaruBot holds Administrator, or that is unknown, members and guests are refused.
  memberWhileAdministrator: actor({ member: true, botAdministrator: true }),
  guestAdministratorUnknown: actor({ guest: true }),
  // An officer who holds Member too, while TaruBot holds Administrator: officers are unaffected.
  officerMemberWhileAdministrator: actor({ officer: true, member: true, botAdministrator: true }),
  // An actor from before serverManager existed: officer stands in for it.
  legacyManager: { guildId: GUILD, userId: USER, officer: true, manageRoles: true },
} satisfies Record<string, Actor>;

describe("admits", () => {
  test("every flag over the actor matrix", () => {
    const matrix = Object.fromEntries(
      Object.entries(ACTORS).map(([name, value]) => [
        name,
        {
          officer: admits(value, ["officer"]),
          manager: admits(value, ["manager"]),
          member: admits(value, ["member"]),
          guest: admits(value, ["guest"]),
          selfService: selfServiceAccess(value),
        },
      ]),
    );
    const none = { officer: false, manager: false, member: false, guest: false };
    expect(matrix).toEqual({
      manager: { ...none, officer: true, manager: true, selfService: true },
      serverManagerOnly: { ...none, officer: true, selfService: true },
      roleOfficer: { ...none, officer: true, selfService: true },
      roleOfficerManageRoles: { ...none, officer: true, selfService: true },
      revokedOfficer: { ...none, selfService: false },
      lobby: { ...none, selfService: false },
      member: { ...none, member: true, selfService: true },
      guest: { ...none, guest: true, selfService: true },
      timedOutMember: { ...none, member: true, selfService: true },
      memberWhileAdministrator: { ...none, selfService: false },
      guestAdministratorUnknown: { ...none, selfService: false },
      officerMemberWhileAdministrator: { ...none, officer: true, selfService: true },
      legacyManager: { ...none, officer: true, manager: true, selfService: true },
    });
  });

  test("member and guest need an explicit false for botAdministrator, and their own role", () => {
    // Held roles alone are not the flags: enrichActor sets them from the bound roles.
    expect(admits(actor({ roleIds: ["400"], botAdministrator: false }), ["member", "guest"])).toBe(
      false,
    );
    // Holding Guest doesn't open a Member-only page, nor Member a Guest-only one.
    expect(admits(ACTORS.guest, ["member"])).toBe(false);
    expect(admits(ACTORS.member, ["guest"])).toBe(false);
    expect(admits(ACTORS.guest, ["member", "guest"])).toBe(true);
  });

  test("flags are any-of; no flags, or a flag this release doesn't know, admits no one", () => {
    expect(admits(ACTORS.roleOfficer, ["manager", "officer"])).toBe(true);
    expect(admits(ACTORS.member, ["manager", "officer"])).toBe(false);
    expect(admits(ACTORS.member, ["officer", "member"])).toBe(true);
    expect(admits(ACTORS.manager, [])).toBe(false);
    for (const flag of ["operator", "toString", "__proto__"])
      expect(admits(ACTORS.manager, [flag as PageAccess])).toBe(false);
  });
});

/** A resolver that answers from a script and records every call, with the mode it was asked for. */
function resolver(answer: (guildId: string, userId: string) => Actor | Error) {
  const calls: string[] = [];
  const modes: ActorResolution[] = [];
  let inFlight = 0;
  let peak = 0;
  const resolve = async (
    guildId: string,
    userId: string,
    mode: ActorResolution,
  ): Promise<Actor> => {
    calls.push(`${guildId}:${userId}`);
    modes.push(mode);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(1);
    inFlight--;
    const result = answer(guildId, userId);
    if (result instanceof Error) throw result;
    return result;
  };
  return { resolve, calls, modes, peak: () => peak };
}

/** The SDK's own REST error, as a member fetch would reject, without any Discord request. */
const discordError = (code: number, status: number): DiscordAPIError =>
  new DiscordAPIError(
    { code, message: "raw SDK text" },
    code,
    status,
    "GET",
    "/guilds/1/members/2",
    {
      body: undefined,
      files: undefined,
    },
  );

describe("AccessResolver", () => {
  test("a GET reuses an answer for the same user and server for 60 seconds", async () => {
    let now = 1_000;
    const fake = resolver((guildId, userId) => actor({ guildId, userId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => now });
    expect(await access.actor(GUILD, USER, "get")).toMatchObject({ officer: true });
    now += ACTOR_MEMO_MS - 1;
    await access.actor(GUILD, USER, "get");
    expect(fake.calls).toHaveLength(1);
    // The window has ended: Discord is asked again.
    now += 1;
    await access.actor(GUILD, USER, "get");
    expect(fake.calls).toHaveLength(2);
  });

  test("concurrent GETs for one user and server share one resolution", async () => {
    const fake = resolver((guildId, userId) => actor({ guildId, userId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => access.actor(GUILD, USER, "get")),
    );
    expect(answers.every((answer) => answer?.officer === true)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    // An outage is shared the same way, and then forgotten, so the next GET asks again.
    const outage = resolver(() => new Error("network down"));
    const down = new AccessResolver(outage.resolve, { now: () => 0 });
    const failed = await Promise.allSettled(
      Array.from({ length: 10 }, () => down.actor(GUILD, USER, "get")),
    );
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(outage.calls).toHaveLength(1);
    expect(down.size).toBe(0);
  });

  test("the memo is keyed by user and server together", async () => {
    const fake = resolver((guildId, userId) => actor({ guildId, userId }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    await access.actor(GUILD, USER, "get");
    await access.actor("100000000000000009", USER, "get");
    await access.actor(GUILD, "200000000000000009", "get");
    await access.actor(GUILD, USER, "get");
    expect(fake.calls).toEqual([
      `${GUILD}:${USER}`,
      `100000000000000009:${USER}`,
      `${GUILD}:200000000000000009`,
    ]);
  });

  test("a fresh resolution (POST, sign-in) always asks Discord and replaces the memo", async () => {
    for (const fresh of ["post", "sign-in"] as const) {
      let officer = true;
      const fake = resolver(() => actor({ officer }));
      const access = new AccessResolver(fake.resolve, { now: () => 0 });
      expect(await access.actor(GUILD, USER, "get")).toMatchObject({ officer: true });
      // Demoted in Discord: the next POST or sign-in sees it at once, and so does every GET after.
      officer = false;
      expect(await access.actor(GUILD, USER, fresh)).toMatchObject({ officer: false });
      expect(await access.actor(GUILD, USER, "get")).toMatchObject({ officer: false });
      expect({ fresh, calls: fake.calls.length }).toEqual({ fresh, calls: 2 });
    }
  });

  test("GETs and sign-ins resolve light; only a POST pays for the full resolution", async () => {
    let now = 0;
    const fake = resolver((guildId, userId) => actor({ guildId, userId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => now });
    await access.actor(GUILD, USER, "get");
    await access.actor(GUILD, USER, "get");
    await access.actor(GUILD, USER, "sign-in");
    await access.actor(GUILD, USER, "post");
    // The POST's full answer is what the next GET reuses.
    await access.actor(GUILD, USER, "get");
    now = ACTOR_MEMO_MS;
    await access.actor(GUILD, USER, "get");
    expect(fake.modes).toEqual(["light", "light", "full", "light"]);
  });

  test("Unknown Member, Unknown User and a bot account mean not admitted, memoized", async () => {
    const gone: Error[] = [
      discordError(10007, 404),
      discordError(10013, 404),
      new Failure(
        "forbidden",
        "TaruBot commands work only inside the server, for human members.",
        0,
        {
          kind: "scope",
          scope: "human",
        },
      ),
      new Failure("forbidden", "You need to be a current member of this server to do that.", 0, {
        kind: "scope",
        scope: "current_member",
      }),
    ];
    for (const error of gone) {
      const fake = resolver(() => error);
      const access = new AccessResolver(fake.resolve, { now: () => 0 });
      expect(await access.actor(GUILD, USER, "get")).toBeNull();
      expect(await access.actor(GUILD, USER, "get")).toBeNull();
      expect({ error: error.name, calls: fake.calls.length }).toEqual({
        error: error.name,
        calls: 1,
      });
    }
  });

  test("any other error propagates and is not memoized", async () => {
    const others: Error[] = [
      new Error("network down"),
      discordError(50013, 403),
      discordError(0, 500),
      new Failure("unavailable", "Discord is having trouble."),
      // A forbidden refusal for another rule is not "gone".
      new Failure("forbidden", "Only FC officers can do that.", 0, {
        kind: "scope",
        scope: "officer",
      }),
    ];
    for (const error of others) {
      const fake = resolver(() => error);
      const access = new AccessResolver(fake.resolve, { now: () => 0 });
      await expect(access.actor(GUILD, USER, "get")).rejects.toBe(error);
      await expect(access.actor(GUILD, USER, "get")).rejects.toBe(error);
      expect(fake.calls).toHaveLength(2);
      expect(access.size).toBe(0);
    }
  });

  test("peek answers from the memo alone: never asks Discord, and misses once it holds nothing", async () => {
    let now = 0;
    let gone = false;
    const fake = resolver((guildId, userId) =>
      gone
        ? new Failure(
            "forbidden",
            "You need to be a current member of this server to do that.",
            0,
            {
              kind: "scope",
              scope: "current_member",
            },
          )
        : actor({ guildId, userId }),
    );
    const access = new AccessResolver(fake.resolve, { now: () => now });
    expect(await access.peek(GUILD, USER)).toBeUndefined();
    await access.actor(GUILD, USER, "get");
    expect(await access.peek(GUILD, USER)).toMatchObject({ userId: USER });
    // Keyed like the memo: another server holds nothing.
    expect(await access.peek("100000000000000009", USER)).toBeUndefined();
    // A POST's fresh answer replaces it, a refusal included.
    gone = true;
    expect(await access.actor(GUILD, USER, "post")).toBeNull();
    expect(await access.peek(GUILD, USER)).toBeNull();
    expect(fake.calls).toHaveLength(2);
    // Expired: nothing held.
    now = ACTOR_MEMO_MS;
    expect(await access.peek(GUILD, USER)).toBeUndefined();
    // A resolution that failed is a miss, never an answer; actor() reports its error.
    const outage = resolver(() => new Error("network down"));
    const down = new AccessResolver(outage.resolve, { now: () => 0 });
    const failing = down.actor(GUILD, USER, "get");
    expect(await down.peek(GUILD, USER)).toBeUndefined();
    await expect(failing).rejects.toThrow("network down");
    expect(outage.calls).toHaveLength(1);
  });

  test("expired answers are pruned whenever the memo is consulted", async () => {
    let now = 0;
    const fake = resolver((guildId, userId) => actor({ guildId, userId }));
    const access = new AccessResolver(fake.resolve, { now: () => now });
    await access.actor(GUILD, USER, "get");
    await access.actor("100000000000000009", USER, "get");
    await access.actor(GUILD, "200000000000000009", "get");
    expect(access.size).toBe(3);
    // Another user's lookup after the window clears everyone's expired answers.
    now = ACTOR_MEMO_MS;
    await access.actor("100000000000000008", "200000000000000008", "get");
    expect(access.size).toBe(1);
  });
});

/** A page with the given access, for server-list and navigation tests. */
const testPage = (path: string, access: readonly PageAccess[], nav?: string): Page =>
  definePage({
    path,
    title: path,
    access,
    requires: [],
    get: () => html`<p>${path}</p>`,
    ...(nav === undefined ? {} : { nav }),
  });

describe("listServers", () => {
  const STATUS = testPage("/g/:guild/status", ["officer"], "Status");
  const ROLES = testPage("/g/:guild/roles", ["manager"], "Roles");
  const AUDIT = testPage("/g/:guild/audit", ["manager", "officer"]);
  const PICKS = testPage("/g/:guild/picks", ["member", "guest", "officer"], "Picks");
  const guilds = (count: number): WebGuild[] =>
    Array.from({ length: count }, (_, index) => ({
      id: String(100000000000000000n + BigInt(index)),
      name: `Server ${index}`,
    }));

  test("keeps servers where the user resolves and a page admits them, with that actor", async () => {
    const [officerAt, managerAt, memberAt, goneAt] = guilds(4);
    if (!officerAt || !managerAt || !memberAt || !goneAt) throw new Error("fixture");
    const fake = resolver((guildId) => {
      if (guildId === officerAt.id) return actor({ guildId, officer: true, roleIds: ["300"] });
      if (guildId === managerAt.id)
        return actor({ guildId, officer: true, serverManager: true, manageRoles: true });
      if (guildId === memberAt.id) return actor({ guildId });
      return discordError(10007, 404);
    });
    const access = new AccessResolver(fake.resolve);
    const servers = await listServers(
      [officerAt, managerAt, memberAt, goneAt],
      USER,
      access,
      [STATUS, ROLES, AUDIT],
      "sign-in",
    );
    expect(servers.map((entry) => [entry.guild.name, entry.actor.guildId])).toEqual([
      ["Server 0", officerAt.id],
      ["Server 1", managerAt.id],
    ]);
    // Only a manager page: the officer's server drops out, the manager's stays.
    const managers = await listServers([officerAt, managerAt], USER, access, [ROLES], "get");
    expect(managers.map((entry) => entry.guild.name)).toEqual(["Server 1"]);
  });

  test("members and guests are listed where a page admits them, unless TaruBot is Administrator", async () => {
    const [memberAt, guestAt, administratorAt, lobbyAt] = guilds(4);
    if (!memberAt || !guestAt || !administratorAt || !lobbyAt) throw new Error("fixture");
    const fake = resolver((guildId) => {
      if (guildId === memberAt.id) return actor({ guildId, member: true, botAdministrator: false });
      if (guildId === guestAt.id) return actor({ guildId, guest: true, botAdministrator: false });
      if (guildId === administratorAt.id)
        return actor({ guildId, member: true, botAdministrator: true });
      return actor({ guildId, botAdministrator: false });
    });
    const access = new AccessResolver(fake.resolve);
    const candidates = [memberAt, guestAt, administratorAt, lobbyAt];
    const servers = await listServers(candidates, USER, access, [STATUS, PICKS], "sign-in");
    expect(servers.map((entry) => entry.guild.name)).toEqual(["Server 0", "Server 1"]);
    // Every admission resolution is a light one: one member fetch per server.
    expect(fake.modes).toEqual(["light", "light", "light", "light"]);
    // Officer pages alone admit no member or guest anywhere: no session would be made.
    expect(await listServers(candidates, USER, access, [STATUS], "sign-in")).toEqual([]);
  });

  test("checks at most 25 servers, one at a time, in order", async () => {
    const fake = resolver((guildId) => actor({ guildId, officer: true }));
    const candidates = guilds(SERVER_LIST_LIMIT + 5);
    const servers = await listServers(
      candidates,
      USER,
      new AccessResolver(fake.resolve),
      [STATUS],
      "sign-in",
    );
    expect(servers).toHaveLength(SERVER_LIST_LIMIT);
    expect(fake.calls).toEqual(
      candidates.slice(0, SERVER_LIST_LIMIT).map((guild) => `${guild.id}:${USER}`),
    );
    expect(fake.peak()).toBe(1);
  });

  test("an empty list means no access; an outage is an error, not an empty list", async () => {
    const [one] = guilds(1);
    if (!one) throw new Error("fixture");
    const member = resolver((guildId) => actor({ guildId }));
    expect(
      await listServers([one], USER, new AccessResolver(member.resolve), [STATUS], "sign-in"),
    ).toEqual([]);
    expect(
      await listServers([], USER, new AccessResolver(member.resolve), [STATUS], "sign-in"),
    ).toEqual([]);
    const outage = resolver(() => new Error("network down"));
    await expect(
      listServers([one], USER, new AccessResolver(outage.resolve), [STATUS], "sign-in"),
    ).rejects.toThrow("network down");
  });

  test("GET / reuses the memo; sign-in admission resolves afresh", async () => {
    const [one] = guilds(1);
    if (!one) throw new Error("fixture");
    const fake = resolver((guildId) => actor({ guildId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    await listServers([one], USER, access, [STATUS], "get");
    await listServers([one], USER, access, [STATUS], "get");
    expect(fake.calls).toHaveLength(1);
    await listServers([one], USER, access, [STATUS], "sign-in");
    expect(fake.calls).toHaveLength(2);
  });
});

describe("navLinks", () => {
  test("lists the admitted pages that have a label, in path order, marking the current one", () => {
    const pages = [
      testPage("/g/:guild/status", ["officer"], "Status"),
      testPage("/g/:guild/roles", ["manager"], "Roles"),
      testPage("/g/:guild/audit", ["officer"], "Audit"),
      testPage("/g/:guild/hidden", ["officer"]),
    ];
    expect(navLinks(pages, ACTORS.roleOfficer, "/g/:guild/status")).toEqual([
      { href: `/g/${GUILD}/audit`, label: "Audit", current: false },
      { href: `/g/${GUILD}/status`, label: "Status", current: true },
    ]);
    expect(navLinks(pages, ACTORS.member)).toEqual([]);
  });

  test("members and guests see only the pages their flag opens; officers see those too", () => {
    const pages = [
      testPage("/g/:guild/status", ["officer"], "Status"),
      testPage("/g/:guild/picks", ["member", "guest", "officer"], "Picks"),
    ];
    const picks = { href: `/g/${GUILD}/picks`, label: "Picks", current: false };
    for (const viewer of [ACTORS.member, ACTORS.guest, ACTORS.timedOutMember])
      expect(navLinks(pages, viewer)).toEqual([picks]);
    for (const refused of [ACTORS.lobby, ACTORS.memberWhileAdministrator])
      expect(navLinks(pages, refused)).toEqual([]);
    expect(navLinks(pages, ACTORS.roleOfficer).map((link) => link.label)).toEqual([
      "Picks",
      "Status",
    ]);
  });
});
