/**
 * DiscordOverrides (2.35.0, #46), the Discord side of /setup overrides, over the access fixture:
 * the one PUT it makes (TaruBot's own member entry, and nothing else), how it reads a channel
 * fresh (ok with real overwrites, hidden, deleted), how it classifies Discord's answers to a PUT
 * (deleted, forbidden, refused for one channel, thrown for everything else), and its facts, read
 * from role bits rather than discord.js's Administrator shortcut.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { DiscordOverrides } from "../../src/discord/overrides.js";
import { DENY_MASK } from "../../src/domain/permissions.js";
import { unreadable } from "../../src/domain/visibility.js";
import { discordAccessFixture, discordError } from "../fixtures/discord-access.js";

/** The fixture of the running test, closed after it. */
let open: ReturnType<typeof discordAccessFixture> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A fixture with its guild and TaruBot's member cached, as the gateway would have them. */
async function setup() {
  const fixture = discordAccessFixture();
  open = fixture;
  const guild = await fixture.client.guilds.fetch("100");
  await guild.members.fetchMe({ force: true });
  return { fixture, guild, port: new DiscordOverrides(fixture.client) };
}

/** A signal nobody aborts. */
const signal = () => new AbortController().signal;
/** TaruBot's masked entry for a text channel. */
const MASKED = { allow: P.ViewChannel, deny: DENY_MASK };

describe("write", () => {
  test("PUTs only TaruBot's member entry, with exactly the planned bits and a reason", async () => {
    const { fixture, port } = await setup();
    const other = [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      { id: "203", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      // TaruBot's old entry is replaced as a whole.
      {
        id: "900",
        type: OverwriteType.Member,
        allow: String(P.ViewChannel | P.AttachFiles),
        deny: "0",
      },
    ];
    const channel = fixture.add("officers", ChannelType.GuildText, structuredClone(other));
    fixture.botAdministrator(true);
    const after = { allow: P.ViewChannel | P.AttachFiles, deny: DENY_MASK };
    expect(
      await port.write("100", channel.id, after, "TaruBot /setup overrides by 400", signal()),
    ).toEqual({ state: "written" });
    expect(fixture.puts).toEqual([
      {
        route: `/channels/${channel.id}/permissions/900`,
        body: { type: 1, allow: String(after.allow), deny: String(after.deny) },
        reason: "TaruBot /setup overrides by 400",
      },
    ]);
    // No PATCH of the channel and no full overwrite set: every other entry is exactly as it was.
    expect(fixture.writes).toEqual([`/channels/${channel.id}/permissions/900`]);
    expect(channel.permission_overwrites.filter((entry) => entry.id !== "900")).toEqual(
      other.slice(0, 2),
    );
    expect(channel.permission_overwrites.find((entry) => entry.id === "900")).toEqual({
      id: "900",
      type: OverwriteType.Member,
      allow: String(after.allow),
      deny: String(after.deny),
    });
  });

  test("Discord's answers: deleted, forbidden, refused for one channel, and thrown otherwise", async () => {
    const { fixture, port } = await setup();
    const channel = fixture.add("general");
    const put = () => port.write("100", channel.id, MASKED, "reason", signal());
    // 10003: gone.
    expect(await port.write("100", "999999999999999999", MASKED, "reason", signal())).toEqual({
      state: "deleted",
    });
    const answer = (error: Error) => {
      fixture.discord.putError = () => error;
      return put();
    };
    const route = `/channels/${channel.id}/permissions/900`;
    // 50001 and 50013: TaruBot can't do this here, which stops the run.
    expect(await answer(discordError(50013, 403, "PUT", route))).toEqual({ state: "forbidden" });
    expect(await answer(discordError(50001, 403, "PUT", route))).toEqual({ state: "forbidden" });
    // A 400 (a channel type that takes no overwrites, an invalid body) or a 404 other than 10003
    // is about this one channel: refused, with its code.
    expect(await answer(discordError(50024, 400, "PUT", route))).toEqual({
      state: "refused",
      code: 50024,
    });
    expect(await answer(discordError(50035, 400, "PUT", route))).toEqual({
      state: "refused",
      code: 50035,
    });
    expect(await answer(discordError(10004, 404, "PUT", route))).toEqual({
      state: "refused",
      code: 10004,
    });
    // Anything about the run rather than the channel is thrown: a bad token, another 403, 429,
    // a server error, an abort.
    for (const error of [
      discordError(0, 401, "PUT", route),
      discordError(50007, 403, "PUT", route),
      discordError(0, 429, "PUT", route),
      discordError(0, 500, "PUT", route),
      new DOMException("This operation was aborted", "AbortError"),
    ])
      await expect(answer(error)).rejects.toBe(error);
    expect(fixture.writes).toEqual([]);
  });

  test("a hidden channel answers 50001, which is forbidden", async () => {
    const { fixture, port } = await setup();
    const hidden = fixture.add("secret", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ]);
    expect(await port.write("100", hidden.id, MASKED, "reason", signal())).toEqual({
      state: "forbidden",
    });
  });
});

describe("read", () => {
  test("ok carries the real overwrites and fetched, even for a private channel", async () => {
    const { fixture, port, guild } = await setup();
    // A real private channel whose only overwrite is the @everyone View deny: the cache can't
    // tell it from an obfuscated entry, but a fresh read with Administrator can.
    const only = [{ id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) }];
    const channel = fixture.add("private", ChannelType.GuildText, structuredClone(only));
    fixture.botAdministrator(true);
    const read = await port.read("100", channel.id, signal());
    expect(read).toEqual({
      state: "ok",
      channel: {
        id: channel.id,
        type: ChannelType.GuildText,
        parentId: null,
        position: 0,
        overwrites: only,
        obfuscated: false,
        fetched: true,
      },
    });
    if (read.state !== "ok") throw new Error("unreachable");
    const snapshot = await port.snapshot("100", true);
    if (!snapshot) throw new Error("No snapshot");
    expect(unreadable(snapshot, read.channel)).toBe(false);
    expect(guild.id).toBe("100");
  });

  test("a 200 whose real overwrites deny TaruBot View Channel is ok: judged deliberate later", async () => {
    const { fixture, port } = await setup();
    const denied = fixture.add("denied", ChannelType.GuildText, [
      { id: "900", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
    ]);
    fixture.discord.hiddenAnswer = "full";
    const read = await port.read("100", denied.id, signal());
    expect(read.state).toBe("ok");
  });

  test("hidden: 50001 or an obfuscated 200", async () => {
    const { fixture, port } = await setup();
    const hidden = fixture.add("secret", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ]);
    expect(await port.read("100", hidden.id, signal())).toEqual({ state: "hidden" });
    fixture.discord.hiddenAnswer = "obfuscated";
    expect(await port.read("100", hidden.id, signal())).toEqual({ state: "hidden" });
  });

  test("a real channel or category named ___hidden___ is ok: the name never means hidden", async () => {
    const { fixture, port } = await setup();
    // Discord: the HTTP API never obfuscates, and `___hidden___` is a valid name.
    const everyoneOff = {
      id: "100",
      type: OverwriteType.Role,
      allow: "0",
      deny: String(P.ViewChannel),
    };
    const membersOn = {
      id: "201",
      type: OverwriteType.Role,
      allow: String(P.ViewChannel),
      deny: "0",
    };
    const text = fixture.add("___hidden___", ChannelType.GuildText, [everyoneOff, membersOn]);
    const category = fixture.add("___hidden___", ChannelType.GuildCategory, [everyoneOff]);
    fixture.discord.hiddenAnswer = "full";
    const read = await port.read("100", text.id, signal());
    expect(read).toMatchObject({ state: "ok", channel: { id: text.id, obfuscated: false } });
    if (read.state !== "ok") throw new Error("Expected ok");
    expect(read.channel.overwrites).toEqual([everyoneOff, membersOn]);
    expect(await port.read("100", category.id, signal())).toMatchObject({ state: "ok" });
  });

  test("deleted: 10003, unless the gateway's entry still looks hidden", async () => {
    const { fixture, port, guild } = await setup();
    expect(await port.read("100", "999999999999999999", signal())).toEqual({ state: "deleted" });
    // A hidden channel Discord answers 10003 for, while the cache holds it obfuscated.
    const hidden = fixture.add("secret", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ]);
    await fixture.client.guilds.fetch({ guild: "100", force: true });
    fixture.discord.hiddenAnswer = "unknown_channel";
    expect(guild.channels.cache.get(hidden.id)?.name).toBe("___hidden___");
    expect(await port.read("100", hidden.id, signal())).toEqual({ state: "hidden" });
  });

  test("anything else, an abort included, is thrown", async () => {
    const { fixture, port } = await setup();
    const channel = fixture.add("general");
    const outage = discordError(0, 500, "GET", `/channels/${channel.id}`);
    fixture.discord.channelError = () => outage;
    await expect(port.read("100", channel.id, signal())).rejects.toBe(outage);
  });
});

describe("facts", () => {
  test("Administrator comes from role bits: TaruBot's, and the caller's or ownership", async () => {
    const { fixture, port } = await setup();
    expect(await port.facts("100", "300", true)).toEqual({
      botAdministrator: false,
      // 300 owns the fixture server.
      callerAllowed: true,
      basePostingHeld: true,
    });
    fixture.botAdministrator(true);
    expect(await port.facts("100", "406", true)).toMatchObject({
      botAdministrator: true,
      callerAllowed: true,
    });
    // Manage Server, Roles and Channels without Administrator isn't enough.
    expect((await port.facts("100", "301", true)).callerAllowed).toBe(false);
    expect((await port.facts("100", null, false)).callerAllowed).toBeNull();
  });

  test("basePostingHeld drops a shared Administrator role, whatever discord.js says", async () => {
    const { fixture, port, guild } = await setup();
    // TaruBot's own role lacks Embed Links; only a shared Administrator role (701) has it.
    const own = fixture.roles.find((role) => role.id === "600");
    const shared = fixture.roles.find((role) => role.id === "701");
    if (!own || !shared) throw new Error("Missing fixture roles");
    own.permissions = String(BigInt(own.permissions) & ~P.EmbedLinks);
    shared.permissions = String(P.Administrator | P.EmbedLinks);
    fixture.botAdministrator(true);
    const facts = await port.facts("100", null, true);
    // discord.js's own check would say yes: Administrator implies everything.
    expect(guild.members.me?.permissions.has(P.EmbedLinks)).toBe(true);
    expect(facts).toEqual({ botAdministrator: true, callerAllowed: null, basePostingHeld: false });
    // Once the permission is on TaruBot's own role, it stays when Administrator comes off.
    own.permissions = String(BigInt(own.permissions) | P.EmbedLinks);
    expect((await port.facts("100", null, true)).basePostingHeld).toBe(true);
  });

  test("without a delivered guild nothing is known, so nothing is allowed", async () => {
    const { fixture, port } = await setup();
    fixture.ready.mockReturnValue(false);
    expect(await port.facts("100", "300", true)).toEqual({
      botAdministrator: false,
      callerAllowed: null,
      basePostingHeld: false,
    });
    expect(await port.snapshot("100", true)).toBeNull();
  });
});
