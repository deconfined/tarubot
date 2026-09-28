/**
 * The cache reader behind TaruBot's visibility analysis (2.35.0, #46), over the Discord access
 * fixture: real discord.js caches filled from raw payloads, no gateway login, no writes. It must
 * read channels from the gateway cache only (never GET /guilds/{id}/channels, which from
 * 2026-11-16 leaves out exactly the channels it reports), keep obfuscated and option-patched
 * entries recognisable, and answer null whenever the gateway can't say.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ChannelType,
  HTTPError,
  OverwriteType,
  PermissionFlagsBits as P,
  RateLimitError,
} from "discord.js";
import { readVisibility, transportError } from "../../src/discord/visibility.js";
import {
  analyseVisibility,
  NO_RECORDS,
  unreadable,
  visibilitySettings,
} from "../../src/domain/visibility.js";
import { discordAccessFixture, discordError } from "../fixtures/discord-access.js";

type Fixture = ReturnType<typeof discordAccessFixture>;
const open: Fixture[] = [];
/** A fixture closed after the test, whatever it asserted. */
function fixtureOf(): Fixture {
  const fixture = discordAccessFixture();
  open.push(fixture);
  return fixture;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((fixture) => fixture.close()));
});

/** @everyone may not view the channel: private to whoever the other entries allow. */
const PRIVATE = { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) };
/** Member role 201 may view it, so it isn't the bare synthetic shape. */
const MEMBERS = { id: "201", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" };

/** The routes read so far that list a guild's channels. */
const channelLists = (fixture: Fixture) =>
  fixture.reads.filter((route) => /^\/guilds\/\d+\/channels$/u.test(route));

/** A settings object for the fixture guild with nothing configured. */
const BARE = visibilitySettings(
  {
    access_policy_enabled: false,
    ledger_channel_id: null,
    officer_notifications_channel_id: null,
    changelog_channel_id: null,
    guest_application_channel_id: null,
    guest_applications_enabled: false,
    lobby_channel_id: null,
    officer_channel_id: null,
    member_role_id: "201",
    guest_role_id: "202",
    officer_role_id: "203",
    leader_role_id: "204",
  },
  NO_RECORDS,
);

test("the cached view copies channels, roles and TaruBot, and never lists channels over REST", async () => {
  const fixture = fixtureOf();
  const category = fixture.add("private", ChannelType.GuildCategory, [PRIVATE, MEMBERS]);
  const general = fixture.add("general");
  const hidden = fixture.add("secret", ChannelType.GuildText, [PRIVATE, MEMBERS], category.id);
  const voice = fixture.add("voice", ChannelType.GuildVoice);
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  await guild.members.fetchMe({ force: true });
  await guild.members.fetch({ user: "403", force: true });
  // A thread is never part of the view.
  fixture.add("thread", ChannelType.PublicThread, [], general.id);
  await fixture.client.guilds.fetch({ guild: "100", force: true });

  const view = await readVisibility(fixture.client, "100", false);
  expect(channelLists(fixture)).toEqual([]);
  expect(view).not.toBeNull();
  if (!view) return;
  expect(view.guildId).toBe("100");
  // No Community Updates channel in this guild.
  expect(view.communityUpdatesId).toBeNull();
  expect(view.bot).toEqual({ id: "900", roles: ["600"], botRoleId: null });
  expect(view.roles.map((role) => role.id).sort()).toEqual(
    ["100", "201", "202", "203", "204", "500", "600", "700", "701"].sort(),
  );
  // Member 403 holds 201 and 203; TaruBot's own roles and @everyone aren't counted.
  expect([...view.heldRoles].sort()).toEqual(["201", "203"]);
  const byId = new Map(view.channels.map((channel) => [channel.id, channel]));
  expect([...byId.keys()].sort()).toEqual([category.id, general.id, hidden.id, voice.id].sort());
  expect(byId.get(voice.id)).toMatchObject({ type: ChannelType.GuildVoice, obfuscated: false });
  // Enforced obfuscation: the gateway sends hidden channels as ___hidden___ with the synthetic
  // overwrite, keeping only id, type and parent.
  expect(byId.get(hidden.id)).toMatchObject({ parentId: category.id, obfuscated: true });
  expect(byId.get(category.id)).toMatchObject({ obfuscated: true });
  const report = analyseVisibility(view, BARE);
  expect(report.missing).toMatchObject({
    categories: [category.id],
    inside: [hidden.id],
    unreadable: [category.id, hidden.id],
  });
});

test("an option-patched entry keeps the synthetic overwrite and stays unreadable", async () => {
  const fixture = fixtureOf();
  // Only @everyone's deny: once obfuscated, the entry looks exactly like the synthetic shape.
  const hidden = fixture.add("secret", ChannelType.GuildText, [PRIVATE]);
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  await guild.members.fetchMe({ force: true });
  fixture.chooseInOption(hidden.id);
  expect(guild.channels.cache.get(hidden.id)?.name).toBe("secret");
  const view = await readVisibility(fixture.client, "100", false);
  const entry = view?.channels.find((channel) => channel.id === hidden.id);
  // The flag and name are real again, but the overwrites are still the synthetic one.
  expect(entry).toMatchObject({ obfuscated: false });
  expect(entry?.overwrites).toEqual([
    { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
  ]);
  if (!view || !entry) throw new Error("Expected a view");
  expect(unreadable(view, entry)).toBe(true);
});

test("a real channel or category named ___hidden___ is judged by its flag, never its name", async () => {
  const fixture = fixtureOf();
  // Discord: "Do not rely on inspecting `name`"; the name is valid for a real channel. Both are
  // private to members, but the ledger inside the category makes the category matter.
  const category = fixture.add("___hidden___", ChannelType.GuildCategory, [
    PRIVATE,
    MEMBERS,
    { id: "900", type: OverwriteType.Member, allow: String(P.ViewChannel), deny: "0" },
  ]);
  const text = fixture.add("___hidden___", ChannelType.GuildText, [
    PRIVATE,
    MEMBERS,
    { id: "900", type: OverwriteType.Member, allow: String(P.ViewChannel), deny: "0" },
  ]);
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  await guild.members.fetchMe({ force: true });
  expect(guild.channels.cache.get(text.id)?.name).toBe("___hidden___");
  const view = await readVisibility(fixture.client, "100", false);
  if (!view) throw new Error("Expected a view");
  for (const id of [category.id, text.id]) {
    const entry = view.channels.find((channel) => channel.id === id);
    expect(entry).toMatchObject({ obfuscated: false });
    if (!entry) throw new Error("Expected the entry");
    expect(unreadable(view, entry)).toBe(false);
  }
  const report = analyseVisibility(view, BARE);
  expect(report.missingCount).toBe(0);
});

test("null while the gateway can't say: not ready, not delivered, not cached, no member", async () => {
  const fixture = fixtureOf();
  // Nothing fetched yet: the guild isn't in the cache.
  expect(await readVisibility(fixture.client, "100", false)).toBeNull();
  expect(await readVisibility(fixture.client, "100", true)).toBeNull();
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  // Delivered, but TaruBot's member isn't cached and the cache path doesn't fetch it.
  expect(await readVisibility(fixture.client, "100", false)).toBeNull();
  await guild.members.fetchMe({ force: true });
  expect(await readVisibility(fixture.client, "100", false)).not.toBeNull();
  fixture.ready.mockReturnValue(false);
  expect(await readVisibility(fixture.client, "100", false)).toBeNull();
  expect(await readVisibility(fixture.client, "100", true)).toBeNull();
  fixture.ready.mockReturnValue(true);
  expect(channelLists(fixture)).toEqual([]);
});

test("a guild the gateway hasn't delivered is null", async () => {
  const fixture = fixtureOf();
  fixture.discord.delivered = false;
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  expect(guild.available).toBe(false);
  await guild.members.fetchMe({ force: true });
  expect(await readVisibility(fixture.client, "100", false)).toBeNull();
  expect(await readVisibility(fixture.client, "100", true)).toBeNull();
});

test("the fresh path refetches roles and TaruBot's member, then copies the cache", async () => {
  const fixture = fixtureOf();
  // TaruBot's managed bot role, opted in before the guild is first fetched.
  const botRole = fixture.roles.find((role) => role.id === "600");
  if (!botRole) throw new Error("Missing fixture bot role");
  Object.assign(botRole, { managed: true, tags: { bot_id: "900" } });
  await fixture.client.guilds.fetch({ guild: "100", force: true });
  // A role change since the guild arrived: the fresh path sees it, and TaruBot's member too.
  botRole.permissions = String(BigInt(botRole.permissions) | P.Administrator);
  fixture.people.set("900", ["600", "500"]);
  const before = fixture.reads.length;
  const view = await readVisibility(fixture.client, "100", true);
  expect(fixture.reads.slice(before)).toEqual(["/guilds/100/roles", "/guilds/100/members/900"]);
  expect(view?.bot).toEqual({ id: "900", roles: ["600", "500"], botRoleId: "600" });
  // Administrator sits on TaruBot's own bot role, so nothing is shared.
  expect(analyseVisibility(view ?? fail(), BARE).administrator).toEqual({
    held: true,
    roles: ["600"],
    shared: [],
  });
  // The cache path makes no request at all.
  const cached = fixture.reads.length;
  await readVisibility(fixture.client, "100", false);
  expect(fixture.reads.length).toBe(cached);
});

test("the Community Updates channel comes from the guild, for onboarding's exclusions", async () => {
  const fixture = fixtureOf();
  const updates = fixture.add("community-updates");
  fixture.community.updatesChannelId = updates.id;
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  await guild.members.fetchMe({ force: true });
  const view = await readVisibility(fixture.client, "100", false);
  expect(view?.communityUpdatesId).toBe(updates.id);
});

/** A socket-level failure as Bun's fetch or undici raise it: an Error carrying `code`. */
const socketError = (code: string, message = "socket failure") =>
  Object.assign(new Error(message), { code });

test("a transport error from the fresh fetches is null; anything else propagates", async () => {
  const failures: [string, unknown][] = [
    ["Discord's JSON error", discordError(0, 500, "GET", "/guilds/100/roles")],
    ["a reset connection", socketError("ECONNRESET")],
    [
      "a refused connection one level down",
      new Error("Unable to connect", { cause: socketError("ConnectionRefused") }),
    ],
    ["fetch's own failure", new TypeError("fetch failed")],
  ];
  for (const [label, failure] of failures) {
    const fixture = fixtureOf();
    const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
    await guild.members.fetchMe({ force: true });
    spyOn(guild.roles, "fetch").mockImplementation(async () => {
      throw failure;
    });
    expect({ label, view: await readVisibility(fixture.client, "100", true) }).toEqual({
      label,
      view: null,
    });
    // The cache path never fetches, so it still answers.
    expect(await readVisibility(fixture.client, "100", false)).not.toBeNull();
    expect(channelLists(fixture)).toEqual([]);
  }
  // A plain TypeError is a bug, not Discord being unreachable: the caller reports it.
  const fixture = fixtureOf();
  const guild = await fixture.client.guilds.fetch({ guild: "100", force: true });
  await guild.members.fetchMe({ force: true });
  const bug = new TypeError("Cannot read properties of undefined (reading 'cache')");
  spyOn(guild.members, "fetchMe").mockImplementation(async () => {
    throw bug;
  });
  await expect(readVisibility(fixture.client, "100", true)).rejects.toBe(bug);
});

test("transportError names Discord's errors, aborts, timeouts and socket failures only", () => {
  for (const code of [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ConnectionRefused",
    "ConnectionClosed",
    "FailedToOpenSocket",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    expect({ code, transport: transportError(socketError(code)) }).toEqual({
      code,
      transport: true,
    });
    const wrapped = new Error("request failed", { cause: socketError(code) });
    expect({ code, cause: transportError(wrapped) }).toEqual({ code, cause: true });
  }
  expect(transportError(discordError(50001, 403, "GET", "/guilds/100/roles"))).toBe(true);
  expect(
    transportError(
      new HTTPError(502, "Bad Gateway", "GET", "/guilds/100/roles", {
        body: undefined,
        files: undefined,
      }),
    ),
  ).toBe(true);
  expect(
    transportError(
      new RateLimitError({
        timeToReset: 1000,
        limit: 1,
        method: "GET",
        hash: "hash",
        url: "/guilds/100/roles",
        route: "/guilds/:id/roles",
        majorParameter: "100",
        global: false,
        retryAfter: 1000,
        sublimitTimeout: 0,
        scope: "user",
      }),
    ),
  ).toBe(true);
  expect(transportError(new DOMException("The operation was aborted", "AbortError"))).toBe(true);
  expect(transportError(new DOMException("The operation timed out", "TimeoutError"))).toBe(true);
  expect(transportError(new TypeError("fetch failed"))).toBe(true);
  // Anything else is a bug to report: a plain TypeError, another message, an unknown code, or a
  // code two levels down.
  expect(transportError(new TypeError("x is not a function"))).toBe(false);
  expect(transportError(new TypeError("Fetch failed"))).toBe(false);
  expect(transportError(socketError("EACCES"))).toBe(false);
  expect(
    transportError(new Error("a", { cause: new Error("b", { cause: socketError("ECONNRESET") }) })),
  ).toBe(false);
  expect(transportError(Object.assign(new Error("numeric"), { code: 104 }))).toBe(false);
  expect(transportError("ECONNRESET")).toBe(false);
  expect(transportError(null)).toBe(false);
});

/** Fail the test with a message where a value was required. */
function fail(): never {
  throw new Error("Expected a view");
}
