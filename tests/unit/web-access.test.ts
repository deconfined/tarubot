/**
 * Who may open a web page (#43, D2–D4, D17): the admits() matrix over the actors slash commands
 * resolve, the 60-second GET memo and the fresh resolution every POST and sign-in uses, gone actors
 * as "not admitted", the server list and the server navigation. definePage's validation, access
 * included, is in web-pages.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import type { Actor } from "../../src/domain/policy.js";
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
  member: actor(),
  // An actor from before serverManager existed: officer stands in for it.
  legacyManager: { guildId: GUILD, userId: USER, officer: true, manageRoles: true },
} satisfies Record<string, Actor>;

describe("admits", () => {
  test("officer and manager flags over the actor matrix", () => {
    const matrix = Object.fromEntries(
      Object.entries(ACTORS).map(([name, value]) => [
        name,
        { officer: admits(value, ["officer"]), manager: admits(value, ["manager"]) },
      ]),
    );
    expect(matrix).toEqual({
      manager: { officer: true, manager: true },
      serverManagerOnly: { officer: true, manager: false },
      roleOfficer: { officer: true, manager: false },
      roleOfficerManageRoles: { officer: true, manager: false },
      revokedOfficer: { officer: false, manager: false },
      member: { officer: false, manager: false },
      legacyManager: { officer: true, manager: true },
    });
  });

  test("flags are any-of; no flags, or a flag this release doesn't know, admits no one", () => {
    expect(admits(ACTORS.roleOfficer, ["manager", "officer"])).toBe(true);
    expect(admits(ACTORS.member, ["manager", "officer"])).toBe(false);
    expect(admits(ACTORS.manager, [])).toBe(false);
    for (const flag of ["member", "guest", "operator", "toString", "__proto__"])
      expect(admits(ACTORS.manager, [flag as PageAccess])).toBe(false);
  });
});

/** A resolver that answers from a script and records every call. */
function resolver(answer: (guildId: string, userId: string) => Actor | Error) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const resolve = async (guildId: string, userId: string): Promise<Actor> => {
    calls.push(`${guildId}:${userId}`);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(1);
    inFlight--;
    const result = answer(guildId, userId);
    if (result instanceof Error) throw result;
    return result;
  };
  return { resolve, calls, peak: () => peak };
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
    expect(await access.actor(GUILD, USER, false)).toMatchObject({ officer: true });
    now += ACTOR_MEMO_MS - 1;
    await access.actor(GUILD, USER, false);
    expect(fake.calls).toHaveLength(1);
    // The window has ended: Discord is asked again.
    now += 1;
    await access.actor(GUILD, USER, false);
    expect(fake.calls).toHaveLength(2);
  });

  test("concurrent GETs for one user and server share one resolution", async () => {
    const fake = resolver((guildId, userId) => actor({ guildId, userId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => access.actor(GUILD, USER, false)),
    );
    expect(answers.every((answer) => answer?.officer === true)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    // An outage is shared the same way, and then forgotten, so the next GET asks again.
    const outage = resolver(() => new Error("network down"));
    const down = new AccessResolver(outage.resolve, { now: () => 0 });
    const failed = await Promise.allSettled(
      Array.from({ length: 10 }, () => down.actor(GUILD, USER, false)),
    );
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(outage.calls).toHaveLength(1);
    expect(down.size).toBe(0);
  });

  test("the memo is keyed by user and server together", async () => {
    const fake = resolver((guildId, userId) => actor({ guildId, userId }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    await access.actor(GUILD, USER, false);
    await access.actor("100000000000000009", USER, false);
    await access.actor(GUILD, "200000000000000009", false);
    await access.actor(GUILD, USER, false);
    expect(fake.calls).toEqual([
      `${GUILD}:${USER}`,
      `100000000000000009:${USER}`,
      `${GUILD}:200000000000000009`,
    ]);
  });

  test("a fresh resolution (POST, sign-in) always asks Discord and replaces the memo", async () => {
    let officer = true;
    const fake = resolver(() => actor({ officer }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    expect(await access.actor(GUILD, USER, false)).toMatchObject({ officer: true });
    // Demoted in Discord: the next POST sees it at once, and so does every GET after it.
    officer = false;
    expect(await access.actor(GUILD, USER, true)).toMatchObject({ officer: false });
    expect(await access.actor(GUILD, USER, false)).toMatchObject({ officer: false });
    expect(fake.calls).toHaveLength(2);
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
      expect(await access.actor(GUILD, USER, false)).toBeNull();
      expect(await access.actor(GUILD, USER, false)).toBeNull();
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
      await expect(access.actor(GUILD, USER, false)).rejects.toBe(error);
      await expect(access.actor(GUILD, USER, false)).rejects.toBe(error);
      expect(fake.calls).toHaveLength(2);
      expect(access.size).toBe(0);
    }
  });

  test("expired answers are pruned whenever the memo is consulted", async () => {
    let now = 0;
    const fake = resolver((guildId, userId) => actor({ guildId, userId }));
    const access = new AccessResolver(fake.resolve, { now: () => now });
    await access.actor(GUILD, USER, false);
    await access.actor("100000000000000009", USER, false);
    await access.actor(GUILD, "200000000000000009", false);
    expect(access.size).toBe(3);
    // Another user's lookup after the window clears everyone's expired answers.
    now = ACTOR_MEMO_MS;
    await access.actor("100000000000000008", "200000000000000008", false);
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
      true,
    );
    expect(servers.map((entry) => [entry.guild.name, entry.actor.guildId])).toEqual([
      ["Server 0", officerAt.id],
      ["Server 1", managerAt.id],
    ]);
    // Only a manager page: the officer's server drops out, the manager's stays.
    const managers = await listServers([officerAt, managerAt], USER, access, [ROLES], false);
    expect(managers.map((entry) => entry.guild.name)).toEqual(["Server 1"]);
  });

  test("checks at most 25 servers, one at a time, in order", async () => {
    const fake = resolver((guildId) => actor({ guildId, officer: true }));
    const candidates = guilds(SERVER_LIST_LIMIT + 5);
    const servers = await listServers(
      candidates,
      USER,
      new AccessResolver(fake.resolve),
      [STATUS],
      true,
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
      await listServers([one], USER, new AccessResolver(member.resolve), [STATUS], true),
    ).toEqual([]);
    expect(await listServers([], USER, new AccessResolver(member.resolve), [STATUS], true)).toEqual(
      [],
    );
    const outage = resolver(() => new Error("network down"));
    await expect(
      listServers([one], USER, new AccessResolver(outage.resolve), [STATUS], true),
    ).rejects.toThrow("network down");
  });

  test("GET / reuses the memo; sign-in admission resolves afresh", async () => {
    const [one] = guilds(1);
    if (!one) throw new Error("fixture");
    const fake = resolver((guildId) => actor({ guildId, officer: true }));
    const access = new AccessResolver(fake.resolve, { now: () => 0 });
    await listServers([one], USER, access, [STATUS], false);
    await listServers([one], USER, access, [STATUS], false);
    expect(fake.calls).toHaveLength(1);
    await listServers([one], USER, access, [STATUS], true);
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
});
