/** Effective SDK permissions, not overwrite shape alone, define the onboarding access contract. */
import { describe, expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { isObfuscated, OBFUSCATED_CHANNEL_NAME } from "../../src/discord/obfuscation.js";
import { DENY_MASK, VOICE_DENY_MASK } from "../../src/domain/permissions.js";
import {
  accessRoles,
  channelAccessOverwrites,
  initiallyStaffOnly,
  sameOverwrites,
  type AccessChannel,
} from "../../src/domain/channel-access.js";
import {
  type ChannelFixture,
  discordAccessFixture,
  discordError,
} from "../fixtures/discord-access.js";

test("all non-thread channel types enforce the newcomer, member, guest, staff and bot visibility matrix", async () => {
  const fixture = discordAccessFixture();
  try {
    const guild = await fixture.client.guilds.fetch("100");
    const viewers = await Promise.all(
      [...fixture.people.keys()].map((user) => guild.members.fetch(user)),
    );
    for (const type of [
      ChannelType.GuildText,
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildStageVoice,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ]) {
      for (const audience of ["lobby", "members", "officers"] as const) {
        // Both an unrelated role and a direct user overwrite previously leaked View Channel.
        const current = [
          {
            id: "500",
            type: OverwriteType.Role,
            allow: String(P.ViewChannel | P.ManageMessages),
            deny: "0",
          },
          { id: "400", type: OverwriteType.Member, allow: String(P.ViewChannel), deny: "0" },
          { id: "403", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
        ];
        const planned = channelAccessOverwrites(current, "100", "900", fixture.bindings, audience);
        const raw = fixture.add(`${audience}-${type}`, type, planned);
        const channel = await guild.channels.fetch(raw.id);
        if (!channel || channel.isThread()) throw new Error("Missing channel fixture");
        for (const member of viewers) {
          const staff = ["403", "404", "900"].includes(member.id);
          // Manage Guild/Channels alone does not bypass overwrites; Administrator does.
          const expected =
            ["300", "406"].includes(member.id) ||
            staff ||
            (audience === "lobby"
              ? !["401", "402"].includes(member.id)
              : audience === "members" && ["401", "402"].includes(member.id));
          expect({
            type,
            audience,
            user: member.id,
            visible: channel.permissionsFor(member).has(P.ViewChannel),
          }).toEqual({ type, audience, user: member.id, visible: expected });
        }
        expect(planned.find((overwrite) => overwrite.id === "500")?.allow).toBe(
          String(P.ManageMessages),
        );
        expect(
          sameOverwrites(
            planned,
            channelAccessOverwrites(planned, "100", "900", fixture.bindings, audience),
          ),
        ).toBe(true);
      }
    }
  } finally {
    await fixture.close();
  }
});

test("lobby permits onboarding commands and chat, blocks newcomers creating threads, and hides parent threads with member access", async () => {
  const fixture = discordAccessFixture();
  try {
    const guild = await fixture.client.guilds.fetch("100");
    const raw = fixture.add(
      "lobby",
      ChannelType.GuildText,
      channelAccessOverwrites([], "100", "900", fixture.bindings, "lobby"),
    );
    const channel = await guild.channels.fetch(raw.id);
    const newcomer = await guild.members.fetch("400"),
      member = await guild.members.fetch("401");
    if (!channel) throw new Error("Missing lobby");
    expect(
      channel
        .permissionsFor(newcomer)
        .has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.UseApplicationCommands]),
    ).toBe(true);
    expect(
      channel.permissionsFor(newcomer).any([P.CreatePrivateThreads, P.CreatePublicThreads]),
    ).toBe(false);
    expect(channel.permissionsFor(member).has(P.ViewChannel)).toBe(false);
    // Discord.js resolves a thread through its parent's overwrites, including explicitly joined users.
    const thread = {
      id: "2000",
      guild_id: "100",
      parent_id: raw.id,
      name: "thread",
      type: ChannelType.PublicThread,
      permission_overwrites: [],
      thread_metadata: {
        archived: false,
        auto_archive_duration: 60,
        archive_timestamp: "2026-01-01T00:00:00Z",
        locked: false,
      },
    };
    fixture.channels.push(thread);
    const observed = await fixture.client.channels.fetch(thread.id);
    if (!observed?.isThread()) throw new Error("Missing thread");
    expect(observed.permissionsFor(member).has(P.ViewChannel)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("channel setup reuses private officer rooms and retains original lobby parent until durable enforcement", async () => {
  const fixture = discordAccessFixture();
  try {
    const category = fixture.add("public", ChannelType.GuildCategory);
    const lobby = fixture.add("lobby", ChannelType.GuildText, [], category.id);
    fixture.add("staff");
    const officers = fixture.add("officer-chat", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
    ]);
    await fixture.port.check("100", "301");
    const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
    expect(prepared.lobby).toEqual({ id: lobby.id, created: false });
    expect(prepared.officers).toEqual({ id: officers.id, created: false });
    expect(prepared.snapshot.channels.find((channel) => channel.id === lobby.id)?.parentId).toBe(
      category.id,
    );
    expect(fixture.writes).toHaveLength(0);
    expect(
      await fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {}),
    ).toBe(true);
    expect(lobby.parent_id).toBeNull();
    expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(true);
    const writes = fixture.writes.length;
    expect(
      await fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {}),
    ).toBe(false);
    expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(false);
    expect(fixture.writes).toHaveLength(writes);
    const guild = await fixture.client.guilds.fetch("100");
    const fresh = fixture.add("new-default");
    const channel = await guild.channels.fetch(fresh.id);
    const newcomer = await guild.members.fetch("400");
    expect(channel?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("missing rooms are created with their final privacy policy and repeated setup reuses bindings", async () => {
  const fixture = discordAccessFixture();
  try {
    const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
    expect(prepared.lobby.created).toBe(true);
    expect(prepared.officers.created).toBe(true);
    const again = await fixture.port.prepare(
      "100",
      "301",
      fixture.bindings,
      prepared.lobby.id,
      prepared.officers.id,
    );
    expect(again.lobby).toEqual({ id: prepared.lobby.id, created: false });
    expect(again.officers).toEqual({ id: prepared.officers.id, created: false });
    expect(fixture.channels).toHaveLength(2);
    const guild = await fixture.client.guilds.fetch("100");
    const member = await guild.members.fetch("401"),
      officer = await guild.members.fetch("403");
    const room = await guild.channels.fetch(prepared.officers.id);
    expect(room?.permissionsFor(member).has(P.ViewChannel)).toBe(false);
    expect(room?.permissionsFor(officer).has(P.ViewChannel)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("ambiguous rooms, insufficient authority, dangerous roles and superseded writes fail before effects", async () => {
  const fixture = discordAccessFixture();
  try {
    const lobby = fixture.add("lobby");
    const twin = fixture.add("lobby");
    // Same-named rooms are ambiguous, and the detail lists both so the reply can name them.
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, null),
    ).rejects.toMatchObject({
      code: "ambiguous",
      detail: { kind: "matches", resource: "channel", name: "lobby", ids: [lobby.id, twin.id] },
    });
    // The three-permission channel check has its own scope, so the reply can name Manage Channels.
    await expect(fixture.port.check("100", "400")).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "manage_channels" },
    });
    const role = fixture.roles.find((role) => role.id === "201");
    if (!role) throw new Error("Missing member role");
    role.permissions = String(P.ManageChannels);
    await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
      code: "blocked",
      detail: { kind: "resource", resource: "role", id: "201" },
    });
    role.permissions = "0";
    await expect(
      fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {
        throw new Error("superseded");
      }),
    ).rejects.toThrow("superseded");
    expect(fixture.writes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("explicit visibility denies keep new default-closed channels staff-only", async () => {
  const fixture = discordAccessFixture();
  try {
    await fixture.port.restrictEveryone("100", async () => {});
    const guild = await fixture.client.guilds.fetch("100");
    const member = await guild.members.fetch("401"),
      guest = await guild.members.fetch("402"),
      officer = await guild.members.fetch("403");
    for (const denied of [
      { id: fixture.bindings.member, type: OverwriteType.Role },
      { id: fixture.bindings.guest, type: OverwriteType.Role },
      { id: "500", type: OverwriteType.Role },
      { id: "400", type: OverwriteType.Member },
    ]) {
      // A real SDK snapshot distinguishes explicit privacy from the removed everyone default.
      const raw = fixture.add(`private-${denied.id}`, ChannelType.GuildText, [
        { ...denied, allow: "0", deny: String(P.ViewChannel) },
      ]);
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      const observed = snapshot.channels.find((channel) => channel.id === raw.id);
      if (!observed) throw new Error("Missing private channel observation");
      expect(observed).toMatchObject({
        everyoneVisible: false,
        memberVisible: false,
        guestVisible: false,
      });
      const audience = initiallyStaffOnly(observed, true, false) ? "officers" : "members";
      await fixture.port.channel("100", raw.id, fixture.bindings, audience, async () => {});
      const channel = await guild.channels.fetch(raw.id);
      if (!channel) throw new Error("Missing enforced private channel");
      expect({
        denied,
        member: channel.permissionsFor(member).has(P.ViewChannel),
        guest: channel.permissionsFor(guest).has(P.ViewChannel),
        officer: channel.permissionsFor(officer).has(P.ViewChannel),
      }).toEqual({ denied, member: false, guest: false, officer: true });
    }
  } finally {
    await fixture.close();
  }
});

test("community updates and its category stay outside provisioning even when the bot cannot view them", async () => {
  // Before obfuscation (and under the portal's gateway-only toggle) REST still returns the area's
  // real overwrites, whose explicit @everyone deny lets the default close. From 2026-11-16 REST
  // leaves the area out, so its overwrites are unknown and the default stays (ACCESS-05).
  for (const [obfuscation, preserved] of [
    ["off", false],
    ["gateway", false],
    ["enforced", true],
  ] as const) {
    const fixture = discordAccessFixture();
    fixture.discord.obfuscation = obfuscation;
    try {
      const closed = [
        { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      ];
      const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
      // An inviting name must never override the authoritative Discord community binding.
      const updates = fixture.add(
        "officer-chat",
        ChannelType.GuildText,
        structuredClone(closed),
        parent.id,
      );
      fixture.community.updatesChannelId = updates.id;
      expect([fixture.hidden(parent), fixture.hidden(updates)]).toEqual([true, true]);
      const original = structuredClone([parent, updates]);
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      expect({ obfuscation, excluded: snapshot.excludedChannelIds.sort() }).toEqual({
        obfuscation,
        excluded: [parent.id, updates.id].sort(),
      });
      expect(snapshot.channels).toEqual([]);
      expect({ obfuscation, preserved: snapshot.preserveEveryoneView }).toEqual({
        obfuscation,
        preserved,
      });
      const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
      expect(prepared.officers.created).toBe(true);
      expect(prepared.officers.id).not.toBe(updates.id);
      expect(fixture.channels.find((channel) => channel.id === prepared.officers.id)?.name).toBe(
        "officer-chat",
      );
      expect(
        prepared.snapshot.channels.some((channel) =>
          snapshot.excludedChannelIds.includes(channel.id),
        ),
      ).toBe(false);
      for (const id of snapshot.excludedChannelIds)
        await expect(
          fixture.port.channel("100", id, fixture.bindings, "officers", async () => {}),
        ).rejects.toThrow("reserved");
      expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(!preserved);
      expect([parent, updates]).toEqual(original);
      expect(
        fixture.writes.filter(
          (route) => route === `/channels/${parent.id}` || route === `/channels/${updates.id}`,
        ),
      ).toEqual([]);
      // Excluded channels are never read one by one, hidden or not.
      expect(
        fixture.reads.filter(
          (route) => route === `/channels/${parent.id}` || route === `/channels/${updates.id}`,
        ),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  }
});

test("reserved bindings and mid-write community reconfiguration cannot redirect onboarding into protected channels", async () => {
  const fixture = discordAccessFixture();
  try {
    const updates = fixture.add("updates");
    await expect(
      fixture.port.channel("100", updates.id, fixture.bindings, "officers", async () => {
        fixture.community.updatesChannelId = updates.id;
        // The Gateway applies this setting to the cached guild before dispatching GuildUpdate.
        const guild = fixture.client.guilds.cache.get("100");
        if (!guild) throw new Error("Missing cached guild");
        guild.publicUpdatesChannelId = updates.id;
      }),
    ).rejects.toMatchObject({ code: "superseded" });
    const parent = fixture.add("new-parent", ChannelType.GuildCategory);
    await expect(
      fixture.port.channel("100", parent.id, fixture.bindings, "members", async () => {
        updates.parent_id = parent.id;
        // Hidden channels still receive parent metadata through Guilds Gateway updates.
        const cached = fixture.client.guilds.cache.get("100")?.channels.cache.get(updates.id);
        if (!cached || cached.isThread()) throw new Error("Missing cached community channel");
        cached.parentId = parent.id;
      }),
    ).rejects.toMatchObject({ code: "superseded" });
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, updates.id),
    ).rejects.toThrow("reserved");
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, updates.id, null),
    ).rejects.toThrow("reserved");
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("protected areas that inherit visibility retain the guild default while ordinary channels are gated", async () => {
  for (const withParent of [false, true]) {
    const fixture = discordAccessFixture();
    try {
      const parent = withParent ? fixture.add("Admin", ChannelType.GuildCategory) : undefined;
      // With a parent, the updates channel is closed explicitly but readable by TaruBot's role, so
      // it is listed and can't decide the default itself: the inheriting parent must (ACCESS-05).
      const updates = fixture.add(
        "community-updates",
        ChannelType.GuildText,
        withParent
          ? [
              { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
              { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
            ]
          : [],
        parent?.id ?? null,
      );
      fixture.community.updatesChannelId = updates.id;
      // Both are readable, so neither keeps the default for being unreadable.
      expect([fixture.hidden(updates), parent ? fixture.hidden(parent) : false]).toEqual([
        false,
        false,
      ]);
      const before = structuredClone([updates, parent]);
      expect((await fixture.port.snapshot("100", fixture.bindings)).preserveEveryoneView).toBe(
        true,
      );
      expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(false);
      expect(
        BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") & P.ViewChannel,
      ).toBe(P.ViewChannel);
      const ordinary = fixture.add("ordinary");
      await fixture.port.channel("100", ordinary.id, fixture.bindings, "members", async () => {});
      const guild = await fixture.client.guilds.fetch("100");
      const newcomer = await guild.members.fetch("400"),
        member = await guild.members.fetch("401");
      const channel = await guild.channels.fetch(ordinary.id);
      expect(channel?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
      expect(channel?.permissionsFor(member).has(P.ViewChannel)).toBe(true);
      expect([updates, parent]).toEqual(before);
      expect(fixture.writes).toEqual([`/channels/${ordinary.id}`]);
    } finally {
      await fixture.close();
    }
  }
});

test("missing community metadata blocks changes instead of guessing a protected parent", async () => {
  const fixture = discordAccessFixture();
  try {
    fixture.community.updatesChannelId = "9999";
    // Blocked, naming the community channel Discord did not return.
    const missing = {
      code: "blocked",
      detail: { kind: "resource", resource: "channel", id: "9999" },
    };
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, null),
    ).rejects.toMatchObject(missing);
    await expect(fixture.port.restrictEveryone("100", async () => {})).rejects.toMatchObject(
      missing,
    );
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a scoped pass stops on a disconnected gateway or missing protected metadata", async () => {
  const fixture = discordAccessFixture();
  try {
    const closed = [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ];
    const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
    const updates = fixture.add(
      "updates",
      ChannelType.GuildText,
      structuredClone(closed),
      parent.id,
    );
    fixture.community.updatesChannelId = updates.id;
    const target = fixture.add("ordinary");
    const session = await fixture.port.begin("100", fixture.bindings);
    fixture.ready.mockReturnValue(false);
    await expect(session.channel(target.id, "members", async () => {})).rejects.toMatchObject({
      code: "transient",
    });
    fixture.ready.mockReturnValue(true);
    fixture.client.guilds.cache.get("100")?.channels.cache.delete(parent.id);
    await expect(session.restrictEveryone(async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/**
 * Discord's channel obfuscation (#47), modelled by the fixture's default "enforced" mode: from
 * 2026-11-16 REST leaves out channels TaruBot can't view and the gateway holds them obfuscated.
 */
describe("channel obfuscation (#47)", () => {
  /** An explicit @everyone View deny, which hides a channel from a bot without its own allow. */
  const closed = () => [
    { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
  ];
  /** Bot role 600 denied View Channel in an otherwise public channel. */
  const botDenied = () => [
    { id: "600", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
  ];

  test("a hidden Community Updates area is secured with the default kept, and the pass never loops on superseded", async () => {
    const fixture = discordAccessFixture();
    try {
      const parent = fixture.add("Admin", ChannelType.GuildCategory, closed());
      const updates = fixture.add("moderator-only", ChannelType.GuildText, closed(), parent.id);
      fixture.community.updatesChannelId = updates.id;
      const lobby = fixture.add("lobby");
      const officers = fixture.add(
        "officer-chat",
        ChannelType.GuildText,
        closed().concat([
          { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
        ]),
      );
      const ordinary = fixture.add("general");
      const session = await fixture.port.begin("100", fixture.bindings);
      // The gateway cache holds the area obfuscated, with its parent kept; REST didn't list it.
      const cached = fixture.client.guilds.cache.get("100")?.channels.cache;
      const entry = cached?.get(updates.id);
      expect({
        name: entry?.name,
        obfuscated: isObfuscated(entry),
        parentId: entry?.parentId,
        category: cached?.get(parent.id)?.name,
      }).toEqual({
        name: OBFUSCATED_CHANNEL_NAME,
        obfuscated: true,
        parentId: parent.id,
        category: OBFUSCATED_CHANNEL_NAME,
      });
      expect(session.snapshot.excludedChannelIds).toEqual([parent.id, updates.id].sort());
      expect(session.snapshot.preserveEveryoneView).toBe(true);
      expect(session.snapshot.channels.map((channel) => channel.id).sort()).toEqual(
        [lobby.id, officers.id, ordinary.id].sort(),
      );
      // The same order GuildAccess.reconcile uses: none of these may call the scope superseded.
      expect(await session.channel(lobby.id, "lobby", async () => {})).toBe(true);
      expect(await session.restrictEveryone(async () => {})).toBe(false);
      expect(await session.channel(officers.id, "officers", async () => {})).toBe(true);
      expect(await session.channel(ordinary.id, "members", async () => {})).toBe(true);
      const verified = await fixture.port.snapshot("100", fixture.bindings);
      expect(verified.preserveEveryoneView).toBe(true);
      expect(verified.excludedChannelIds).toEqual(session.snapshot.excludedChannelIds);
      // The server default keeps View; each managed channel gates through its own overwrites.
      expect(BigInt(verified.everyonePermissions) & P.ViewChannel).toBe(P.ViewChannel);
      const guild = await fixture.client.guilds.fetch("100");
      const newcomer = await guild.members.fetch("400"),
        member = await guild.members.fetch("401");
      const general = await guild.channels.fetch(ordinary.id);
      expect(general?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
      expect(general?.permissionsFor(member).has(P.ViewChannel)).toBe(true);
      // Nothing touched the hidden area, and nothing asked for it one by one.
      const protectedRoutes = [`/channels/${parent.id}`, `/channels/${updates.id}`];
      expect(fixture.writes.filter((route) => protectedRoutes.includes(route))).toEqual([]);
      expect(fixture.reads.filter((route) => protectedRoutes.includes(route))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a managed channel hidden from TaruBot blocks the pass, naming it with the permissions fix", async () => {
    // Before the date REST lists it and its permissions fail the check; after, only the probe
    // of the cache-only channel keeps the same refusal.
    for (const obfuscation of ["off", "gateway", "enforced"] as const) {
      const fixture = discordAccessFixture();
      fixture.discord.obfuscation = obfuscation;
      try {
        fixture.add("lobby");
        const secret = fixture.add("secret", ChannelType.GuildText, botDenied());
        expect(fixture.hidden(secret)).toBe(true);
        const refusal = {
          code: "blocked",
          message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${secret.id}>.`,
          detail: {
            kind: "resource",
            resource: "channel",
            id: secret.id,
            fix: "channel_permissions",
          },
        };
        await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject(refusal);
        await expect(
          fixture.port.prepare("100", "301", fixture.bindings, null, null),
        ).rejects.toMatchObject(refusal);
        // Lowering the default would change the hidden channel too. From the date the
        // default's own check refuses it as well; before it, begin() is what stops a pass first.
        if (obfuscation === "enforced")
          await expect(fixture.port.restrictEveryone("100", async () => {})).rejects.toMatchObject(
            refusal,
          );
        expect({ obfuscation, writes: fixture.writes }).toEqual({ obfuscation, writes: [] });
        expect(
          BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") &
            P.ViewChannel,
        ).toBe(P.ViewChannel);
        // Only the enforced mode needs the probe: REST lists the channel otherwise.
        expect({
          obfuscation,
          probes: fixture.reads.filter((route) => route === `/channels/${secret.id}`).length > 0,
        }).toEqual({ obfuscation, probes: obfuscation === "enforced" });
      } finally {
        await fixture.close();
      }
    }
  });

  test("a hidden saved officer room refuses /setup instead of creating a second one", async () => {
    // Today REST lists the room and its permissions fail the check; from the date only the
    // hidden-channel probe (and pick()'s own guard behind it) keeps /setup from replacing it.
    for (const obfuscation of ["off", "gateway", "enforced"] as const) {
      const fixture = discordAccessFixture();
      fixture.discord.obfuscation = obfuscation;
      try {
        const lobby = fixture.add("lobby");
        const officers = fixture.add("officer-chat", ChannelType.GuildText, closed());
        expect(fixture.hidden(officers)).toBe(true);
        await expect(
          fixture.port.prepare("100", "301", fixture.bindings, lobby.id, officers.id),
        ).rejects.toMatchObject({
          code: "blocked",
          detail: {
            kind: "resource",
            resource: "channel",
            id: officers.id,
            fix: "channel_permissions",
          },
        });
        expect({ obfuscation, rooms: fixture.channels.map((channel) => channel.name) }).toEqual({
          obfuscation,
          rooms: ["lobby", "officer-chat"],
        });
        expect(fixture.writes).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("a cached entry a channel option patched still counts as hidden", async () => {
    const fixture = discordAccessFixture();
    try {
      const parent = fixture.add("Admin", ChannelType.GuildCategory, closed());
      const updates = fixture.add("moderator-only", ChannelType.GuildText, closed(), parent.id);
      fixture.community.updatesChannelId = updates.id;
      const session = await fixture.port.begin("100", fixture.bindings);
      expect(session.snapshot.preserveEveryoneView).toBe(true);
      // Mid-pass, someone names the hidden channel and its category in channel options
      // (/setup officers:, /config changelog channel:), so neither entry is flagged any more.
      fixture.chooseInOption(updates.id);
      fixture.chooseInOption(parent.id);
      // The SDK cleared the flag and took the real name, but kept the synthetic @everyone deny,
      // which would otherwise read as an explicit override that lets the default close.
      const cached = fixture.client.guilds.cache.get("100")?.channels.cache;
      for (const [id, name] of [
        [updates.id, "moderator-only"],
        [parent.id, "Admin"],
      ] as const) {
        const entry = cached?.get(id);
        if (!entry || entry.isThread()) throw new Error("Missing cached community channel");
        expect({
          name: entry.name,
          obfuscated: isObfuscated(entry),
          overwrites: [...entry.permissionOverwrites.cache.values()].map((overwrite) => ({
            id: overwrite.id,
            deny: overwrite.deny.bitfield,
          })),
        }).toEqual({ name, obfuscated: false, overwrites: [{ id: "100", deny: P.ViewChannel }] });
      }
      // The pass's own record that the area was unreadable decides at once, from the cache: no
      // second catalogue read is needed to keep the default.
      const reads = fixture.reads.length;
      expect(await session.restrictEveryone(async () => {})).toBe(false);
      expect(fixture.reads.slice(reads)).toEqual([]);
      // A fresh pass over the mixed entry decides the same way.
      expect((await fixture.port.snapshot("100", fixture.bindings)).preserveEveryoneView).toBe(
        true,
      );
      expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(false);
      expect(
        BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") & P.ViewChannel,
      ).toBe(P.ViewChannel);
      expect(fixture.writes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a stale cache entry for a deleted channel and a channel created mid-pass don't block", async () => {
    const fixture = discordAccessFixture();
    try {
      const guild = await fixture.client.guilds.fetch("100");
      const gone = fixture.add("gone");
      let late: ChannelFixture | undefined;
      // Deleted after the gateway sent it (its delete event not yet applied): 10003 Unknown Channel.
      fixture.discord.beforeList = () => {
        fixture.discord.beforeList = undefined;
        fixture.channels.splice(fixture.channels.indexOf(gone), 1);
      };
      // Created after the list was read, then cached by its create event: GET answers 200.
      fixture.discord.afterList = async () => {
        fixture.discord.afterList = undefined;
        late = fixture.add("late");
        await guild.channels.fetch(late.id);
      };
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      if (!late) throw new Error("The list hook did not run");
      expect(snapshot.channels).toEqual([]);
      expect(fixture.reads.filter((route) => route.startsWith("/channels/")).sort()).toEqual(
        [`/channels/${gone.id}`, `/channels/${late.id}`, `/channels/${late.id}`].sort(),
      );
      // The next pass (its create event queues one) lists and manages the new channel.
      const next = await fixture.port.snapshot("100", fixture.bindings);
      expect(next.channels.map((channel) => channel.id)).toEqual([late.id]);
    } finally {
      await fixture.close();
    }
  });

  test("a server with nothing hidden makes no per-channel reads to look for hidden channels", async () => {
    const fixture = discordAccessFixture();
    try {
      fixture.add("lobby");
      fixture.add("general");
      const updates = fixture.add("community-updates", ChannelType.GuildText, [
        { id: "100", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      ]);
      fixture.community.updatesChannelId = updates.id;
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      expect(snapshot.channels).toHaveLength(2);
      expect(snapshot.preserveEveryoneView).toBe(false);
      expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a managed channel hidden mid-write is never written from its synthetic overwrites", async () => {
    const fixture = discordAccessFixture();
    try {
      // An unrelated role allow and a member exception that ACCESS-03 keeps.
      const kept = [
        { id: "500", type: OverwriteType.Role, allow: String(P.ManageMessages), deny: "0" },
        { id: "405", type: OverwriteType.Member, allow: String(P.SendMessages), deny: "0" },
      ];
      const target = fixture.add("general", ChannelType.GuildText, structuredClone(kept));
      const session = await fixture.port.begin("100", fixture.bindings);
      let guards = 0;
      await expect(
        session.channel(target.id, "members", async () => {
          // The second guard runs after the forced read: the channel is hidden from TaruBot and
          // the gateway applies its obfuscated CHANNEL_UPDATE to the cache.
          if (++guards !== 2) return;
          target.permission_overwrites.push(...botDenied());
          await fixture.client.guilds.fetch({ guild: "100", force: true });
        }),
      ).rejects.toMatchObject({ code: "superseded" });
      expect(guards).toBe(2);
      expect(fixture.writes).toEqual([]);
      expect(target.permission_overwrites).toEqual([...kept, ...botDenied()]);
    } finally {
      await fixture.close();
    }
  });

  test("a write is planned from the forced read, never from an entry an option un-flagged mid-write", async () => {
    const fixture = discordAccessFixture();
    try {
      const kept = [
        { id: "500", type: OverwriteType.Role, allow: String(P.ManageMessages), deny: "0" },
        { id: "405", type: OverwriteType.Member, allow: String(P.SendMessages), deny: "0" },
      ];
      const target = fixture.add("general", ChannelType.GuildText, structuredClone(kept));
      const session = await fixture.port.begin("100", fixture.bindings);
      let guards = 0;
      expect(
        await session.channel(target.id, "members", async () => {
          // After the forced read, TaruBot briefly loses View there: the gateway applies the
          // obfuscated update, a channel option then clears its flag, and View returns before
          // the gateway sends the channel again. The cache holds a real name over the synthetic
          // overwrite, which managedChannel's flag check can't see.
          if (++guards !== 2) return;
          target.permission_overwrites.push(...botDenied());
          await fixture.client.guilds.fetch({ guild: "100", force: true });
          fixture.chooseInOption(target.id);
          target.permission_overwrites = structuredClone(kept);
        }),
      ).toBe(true);
      expect(guards).toBe(2);
      expect(fixture.writes).toEqual([`/channels/${target.id}`]);
      // The exceptions ACCESS-03 keeps survive, so the plan came from what the read returned.
      const exceptions = target.permission_overwrites.filter((overwrite) =>
        ["500", "405"].includes(overwrite.id),
      );
      expect(exceptions).toHaveLength(kept.length);
      expect(exceptions).toEqual(expect.arrayContaining(kept));
    } finally {
      await fixture.close();
    }
  });

  test("an excluded area hidden after the list keeps the default through its obfuscated flag", async () => {
    const fixture = discordAccessFixture();
    try {
      // Closed explicitly but readable by TaruBot's role, so at first it lets the default close.
      const updates = fixture.add("moderator-only", ChannelType.GuildText, [
        ...closed(),
        { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
      ]);
      fixture.community.updatesChannelId = updates.id;
      const session = await fixture.port.begin("100", fixture.bindings);
      expect(session.snapshot.preserveEveryoneView).toBe(false);
      // Mid-pass TaruBot loses View there, and the gateway applies the obfuscated update.
      updates.permission_overwrites = closed();
      await fixture.client.guilds.fetch({ guild: "100", force: true });
      expect(
        isObfuscated(fixture.client.guilds.cache.get("100")?.channels.cache.get(updates.id)),
      ).toBe(true);
      // The flag decides at once, from the cache: the synthetic deny never reads as explicit.
      const reads = fixture.reads.length;
      expect(await session.restrictEveryone(async () => {})).toBe(false);
      expect(fixture.reads.slice(reads)).toEqual([]);
      expect(
        BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") & P.ViewChannel,
      ).toBe(P.ViewChannel);
      expect(fixture.writes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a hidden managed channel is refused whatever Discord answers to its single-channel read", async () => {
    // Discord answers 50001 today and doesn't document its answer from 2026-11-16. A 10003 while
    // the gateway still holds the entry obfuscated or denying TaruBot View Channel, or a 200 that
    // is obfuscated or denies it, is refused the same way rather than dropped from a "secured" pass.
    for (const hiddenAnswer of [
      "missing_access",
      "unknown_channel",
      "obfuscated",
      "full",
    ] as const) {
      const fixture = discordAccessFixture();
      fixture.discord.hiddenAnswer = hiddenAnswer;
      try {
        const lobby = fixture.add("lobby");
        const secret = fixture.add("secret", ChannelType.GuildText, botDenied());
        const outcome = await fixture.port.snapshot("100", fixture.bindings).then(
          () => "secured",
          (error: unknown) => error,
        );
        expect({ hiddenAnswer, outcome }).toMatchObject({
          hiddenAnswer,
          outcome: {
            code: "blocked",
            detail: {
              kind: "resource",
              resource: "channel",
              id: secret.id,
              fix: "channel_permissions",
            },
          },
        });
        expect({ hiddenAnswer, writes: fixture.writes }).toEqual({ hiddenAnswer, writes: [] });
        // Once it is really deleted, the gateway drops it (CHANNEL_DELETE) and the pass goes on.
        fixture.channels.splice(fixture.channels.indexOf(secret), 1);
        const next = await fixture.port.snapshot("100", fixture.bindings);
        expect(next.channels.map((channel) => channel.id)).toEqual([lobby.id]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("a 10003 for a hidden channel an option un-flagged is still refused, never read as deleted", async () => {
    // Discord might answer 10003 for a hidden channel from 2026-11-16. After a channel option
    // (/setup officers:, /config changelog channel:) the cached entry has a real name and no
    // obfuscated flag, but keeps the synthetic @everyone deny: TaruBot's cached View is what says
    // hidden. Without that, the managed channel would drop out of a "secured" pass, and /setup
    // would take the saved room for deleted and create a second one.
    const unflagged = async (
      fixture: ReturnType<typeof discordAccessFixture>,
      channel: ChannelFixture,
    ) => {
      // chooseInOption patches the cache, so the gateway must have delivered the guild first.
      await fixture.client.guilds.fetch("100");
      fixture.chooseInOption(channel.id);
      const entry = fixture.client.guilds.cache.get("100")?.channels.cache.get(channel.id);
      if (!entry || entry.isThread()) throw new Error("Missing cached channel");
      expect({ name: entry.name, obfuscated: isObfuscated(entry) }).toEqual({
        name: channel.name,
        obfuscated: false,
      });
    };
    /** unmanageable()'s refusal for `id`: the permissions fix, naming the channel. */
    const refusal = (id: string) => ({
      code: "blocked",
      message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${id}>.`,
      detail: { kind: "resource", resource: "channel", id, fix: "channel_permissions" },
    });
    {
      const fixture = discordAccessFixture();
      fixture.discord.hiddenAnswer = "unknown_channel";
      try {
        fixture.add("lobby");
        const secret = fixture.add("secret", ChannelType.GuildText, botDenied());
        await unflagged(fixture, secret);
        await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject(
          refusal(secret.id),
        );
        expect(fixture.reads).toContain(`/channels/${secret.id}`);
        expect(fixture.writes).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
    {
      const fixture = discordAccessFixture();
      fixture.discord.hiddenAnswer = "unknown_channel";
      try {
        const lobby = fixture.add("lobby");
        const officers = fixture.add("officer-chat", ChannelType.GuildText, closed());
        await unflagged(fixture, officers);
        await expect(
          fixture.port.prepare("100", "301", fixture.bindings, lobby.id, officers.id),
        ).rejects.toMatchObject(refusal(officers.id));
        expect(fixture.channels.map((channel) => channel.name)).toEqual(["lobby", "officer-chat"]);
        expect(fixture.writes).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("a single-channel read that fails with no answer is rethrown for the queue, not read as deleted", async () => {
    for (const error of [
      discordError(50013, 403, "GET", "/channels/1"),
      new Error("socket hang up"),
    ]) {
      const fixture = discordAccessFixture();
      try {
        fixture.add("lobby");
        const secret = fixture.add("secret", ChannelType.GuildText, botDenied());
        fixture.discord.channelError = (id) => (id === secret.id ? error : undefined);
        await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toBe(error);
        await expect(fixture.port.prepare("100", "301", fixture.bindings, null, null)).rejects.toBe(
          error,
        );
        expect(fixture.writes).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("a guild the gateway hasn't delivered is retried, never set up from the REST list alone", async () => {
    const fixture = discordAccessFixture();
    fixture.discord.delivered = false;
    try {
      const lobby = fixture.add("lobby");
      const officers = fixture.add("officer-chat", ChannelType.GuildText, closed());
      const updates = fixture.add("moderator-only", ChannelType.GuildText, closed());
      fixture.community.updatesChannelId = updates.id;
      const transient = {
        code: "transient",
        message: "Discord scope is unavailable; retry after the gateway reconnects.",
      };
      // The cache would hold only what REST listed, so the hidden saved room would look deleted
      // and a second one would be created; the updates channel would look misconfigured.
      await expect(
        fixture.port.prepare("100", "301", fixture.bindings, lobby.id, officers.id),
      ).rejects.toMatchObject(transient);
      await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject(transient);
      await expect(fixture.port.restrictEveryone("100", async () => {})).rejects.toMatchObject(
        transient,
      );
      const guild = fixture.client.guilds.cache.get("100");
      expect({ available: guild?.available, size: guild?.channels.cache.size }).toEqual({
        available: false,
        size: 0,
      });
      expect(fixture.writes).toEqual([]);
      // Once the gateway delivers the guild, the hidden saved room is refused as usual.
      fixture.discord.delivered = true;
      await expect(
        fixture.port.prepare("100", "301", fixture.bindings, lobby.id, officers.id),
      ).rejects.toMatchObject({
        code: "blocked",
        detail: { kind: "resource", resource: "channel", id: officers.id },
      });
      expect(fixture.channels.map((channel) => channel.name)).toEqual([
        "lobby",
        "officer-chat",
        "moderator-only",
      ]);
      expect(fixture.writes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a saved room deleted before the list is recreated, and one unhidden after it is refused", async () => {
    const readable = () => [
      ...closed(),
      { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
    ];
    {
      const fixture = discordAccessFixture();
      try {
        const lobby = fixture.add("lobby");
        const officers = fixture.add("officer-chat", ChannelType.GuildText, readable());
        // Deleted after the gateway sent it, with its CHANNEL_DELETE not yet applied: Discord
        // confirms it gone (10003), so /setup recreates it rather than blame permissions.
        fixture.discord.beforeList = () => {
          fixture.discord.beforeList = undefined;
          fixture.channels.splice(fixture.channels.indexOf(officers), 1);
        };
        const prepared = await fixture.port.prepare(
          "100",
          "301",
          fixture.bindings,
          lobby.id,
          officers.id,
        );
        expect(prepared.lobby).toEqual({ id: lobby.id, created: false });
        expect(prepared.officers.created).toBe(true);
        expect(prepared.officers.id).not.toBe(officers.id);
        expect(fixture.channels.map((channel) => channel.name)).toEqual(["lobby", "officer-chat"]);
        expect(fixture.reads).toContain(`/channels/${officers.id}`);
      } finally {
        await fixture.close();
      }
    }
    {
      const fixture = discordAccessFixture();
      try {
        const lobby = fixture.add("lobby");
        const officers = fixture.add("officer-chat", ChannelType.GuildText, closed());
        // Hidden when the list is read, viewable again when TaruBot asks: the 200 leaves it for
        // the next pass, so only pick()'s own guard stops /setup from creating a second room.
        fixture.discord.afterList = () => {
          fixture.discord.afterList = undefined;
          officers.permission_overwrites = readable();
        };
        await expect(
          fixture.port.prepare("100", "301", fixture.bindings, lobby.id, officers.id),
        ).rejects.toMatchObject({
          code: "blocked",
          message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${officers.id}>.`,
          detail: {
            kind: "resource",
            resource: "channel",
            id: officers.id,
            fix: "channel_permissions",
          },
        });
        expect(fixture.channels.map((channel) => channel.name)).toEqual(["lobby", "officer-chat"]);
        expect(fixture.writes).toEqual([]);
        // The next /setup lists the room and keeps it.
        const prepared = await fixture.port.prepare(
          "100",
          "301",
          fixture.bindings,
          lobby.id,
          officers.id,
        );
        expect(prepared.officers).toEqual({ id: officers.id, created: false });
      } finally {
        await fixture.close();
      }
    }
  });
});

test("privacy classification separates newly closed defaults from explicit private areas", () => {
  const channel: AccessChannel = {
    id: "200",
    name: "room",
    type: ChannelType.GuildText,
    parentId: null,
    overwrites: [],
    everyoneVisible: false,
    memberVisible: false,
    guestVisible: false,
  };
  expect(initiallyStaffOnly(channel, false, false)).toBe(true);
  expect(initiallyStaffOnly(channel, true, false)).toBe(false);
  expect(initiallyStaffOnly(channel, true, true)).toBe(true);
  expect(
    initiallyStaffOnly(
      {
        ...channel,
        overwrites: [
          { id: "203", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
        ],
      },
      true,
      false,
    ),
  ).toBe(true);
  expect(() =>
    accessRoles({
      member_role_id: "1",
      guest_role_id: "1",
      officer_role_id: "2",
      leader_role_id: "3",
    }),
  ).toThrow("distinct");
});

describe("after /setup overrides (2.35.0, #46)", () => {
  test("onboarding lifts only the bits its writes need from TaruBot's own entry, keeping the rest", () => {
    const bindings = { member: "201", guest: "202", officer: "203", leader: "204" };
    const current = [
      // TaruBot's entry as /setup overrides masks a voice channel, plus a bit an admin added.
      {
        id: "900",
        type: OverwriteType.Member,
        allow: String(P.ViewChannel | P.PrioritySpeaker),
        deny: String(VOICE_DENY_MASK | P.MentionEveryone),
      },
      // The same bits on anyone else's entry are theirs, and stay.
      { id: "500", type: OverwriteType.Role, allow: "0", deny: String(DENY_MASK) },
      { id: "403", type: OverwriteType.Member, allow: "0", deny: String(P.ManageChannels) },
      // An entry left with nothing once View Channel is normalized is dropped, as before.
      { id: "405", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
    ];
    const planned = channelAccessOverwrites(current, "100", "900", bindings, "members");
    const entry = (id: string) => planned.find((overwrite) => overwrite.id === id);
    expect(entry("900")).toEqual({
      id: "900",
      type: OverwriteType.Member,
      allow: String(
        P.ViewChannel |
          P.SendMessages |
          P.ReadMessageHistory |
          P.EmbedLinks |
          P.AttachFiles |
          P.PrioritySpeaker,
      ),
      // Manage Permissions, Manage Channels and Connect are lifted and History is allowed above;
      // the mask's Create Invite deny stays, like the admin's own bit.
      deny: String(P.CreateInstantInvite | P.MentionEveryone),
    });
    expect(entry("500")?.deny).toBe(String(DENY_MASK));
    expect(entry("403")?.deny).toBe(String(P.ManageChannels));
    expect(entry("405")).toBeUndefined();
    // An entry without mask bits (DevBot's, written by onboarding itself) plans exactly as before.
    expect(
      sameOverwrites(channelAccessOverwrites(planned, "100", "900", bindings, "members"), planned),
    ).toBe(true);
  });

  /** A text channel whose TaruBot member entry carries the mask /setup overrides writes. */
  const masked = (fixture: ReturnType<typeof discordAccessFixture>) =>
    fixture.add("masked", ChannelType.GuildText, [
      {
        id: "900",
        type: OverwriteType.Member,
        allow: String(P.ViewChannel),
        deny: String(DENY_MASK),
      },
    ]);

  test("without Administrator, a masked channel gets the member-entry refusal (text 22)", async () => {
    const fixture = discordAccessFixture();
    try {
      const channel = masked(fixture);
      await fixture.client.guilds.fetch("100");
      await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
        code: "blocked",
        message: `TaruBot's member entry in <#${channel.id}> denies Manage Channels and Manage Permissions; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels and Manage Permissions there.`,
        detail: { kind: "resource", resource: "channel", id: channel.id, fix: "member_entry" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("a masked voice channel names Connect too: its deny also denies Manage Channels there", async () => {
    const fixture = discordAccessFixture();
    try {
      // What /setup overrides writes in a voice channel, and the same entry with only the two
      // denies text 22 used to name removed: Connect's deny alone still makes the write fail.
      const voice = fixture.add("masked-voice", ChannelType.GuildVoice, [
        { id: "900", type: OverwriteType.Member, allow: "0", deny: String(VOICE_DENY_MASK) },
      ]);
      await fixture.client.guilds.fetch("100");
      await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
        code: "blocked",
        message: `TaruBot's member entry in <#${voice.id}> denies Manage Channels, Manage Permissions and Connect; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels, Manage Permissions and Connect there.`,
        detail: { kind: "resource", resource: "channel", id: voice.id, fix: "member_entry" },
      });
      voice.permission_overwrites = [
        {
          id: "900",
          type: OverwriteType.Member,
          allow: "0",
          deny: String(P.ReadMessageHistory | P.CreateInstantInvite | P.Connect),
        },
      ];
      await fixture.client.guilds.fetch({ guild: "100", force: true });
      await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
        message: expect.stringContaining(
          `TaruBot's member entry in <#${voice.id}> denies Connect; remove that deny`,
        ),
        detail: { fix: "member_entry" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("a Connect deny on TaruBot's entry in a text channel means nothing, and isn't asked for", async () => {
    const fixture = discordAccessFixture();
    try {
      const text = fixture.add("text-connect", ChannelType.GuildText, [
        { id: "900", type: OverwriteType.Member, allow: "0", deny: String(P.Connect) },
      ]);
      await fixture.client.guilds.fetch("100");
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      expect(snapshot.channels.map((channel) => channel.id)).toContain(text.id);
    } finally {
      await fixture.close();
    }
  });

  test("the same bits denied on TaruBot's role keep the role refusal", async () => {
    const fixture = discordAccessFixture();
    try {
      const channel = fixture.add("role-denied", ChannelType.GuildText, [
        {
          id: "600",
          type: OverwriteType.Role,
          allow: "0",
          deny: String(P.ManageChannels | P.ManageRoles),
        },
      ]);
      await fixture.client.guilds.fetch("100");
      await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
        code: "blocked",
        message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${channel.id}>.`,
        detail: {
          kind: "resource",
          resource: "channel",
          id: channel.id,
          fix: "channel_permissions",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  test("with Administrator the masked channel passes, and onboarding's write lifts the mask", async () => {
    const fixture = discordAccessFixture();
    try {
      const channel = masked(fixture);
      fixture.botAdministrator(true);
      await fixture.client.guilds.fetch("100");
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      expect(snapshot.channels.map((entry) => entry.id)).toContain(channel.id);
      const planned = channelAccessOverwrites(
        snapshot.channels.find((entry) => entry.id === channel.id)?.overwrites ?? [],
        "100",
        "900",
        fixture.bindings,
        "members",
      );
      // The lift leaves only the mask's Create Invite deny, which onboarding never needs.
      expect(BigInt(planned.find((entry) => entry.id === "900")?.deny ?? "0")).toBe(
        P.CreateInstantInvite,
      );
    } finally {
      await fixture.close();
    }
  });
});
