/**
 * validateChannel's refusals: a channel TaruBot can't use (including one Discord hides from it,
 * 50001 Missing Access, or a 10003 for a text channel the gateway still holds as hidden) gets the
 * permissions refusal with its How to fix step, while a deleted, non-text or other-server channel
 * is "unavailable" with no permissions remedy. Since 2.35.0 (#46) a channel whose own TaruBot
 * member entry denies a posting permission it lacks gets the member-entry refusal: a member deny
 * beats any role allow, so the role fix couldn't work. The SDK's guild and channel managers are
 * stubbed, so no Discord credentials are needed.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ChannelFlags,
  ChannelFlagsBitField,
  ChannelType,
  Collection,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import { receiptReply } from "../../src/discord/presenters/ledger.js";
import { Failure } from "../../src/domain/values.js";
import { onlyEmbed } from "../fixtures/replies.js";
import { LEDGER_RESULTS } from "../fixtures/replies/ledger.js";
import { REF, VIEWERS } from "../fixtures/results.js";

/** The configured channel the checks below validate. */
const CHANNEL = "323456789012345601";

/** Discord's answer to GET /channels/{id} with the given JSON error code and HTTP status. */
const discordError = (code: number, status: number) =>
  new DiscordAPIError(
    { code, message: "Raw Discord text that must never be shown" },
    code,
    status,
    "GET",
    `/channels/${CHANNEL}`,
    { body: undefined, files: undefined },
  );

/** Gateways created by a test, destroyed afterwards so no client outlives it. */
const created: DiscordGateway[] = [];
afterEach(async () => {
  for (const gateway of created.splice(0)) await gateway.client.destroy();
});

/** The bot member fetchMe returns; a cached entry's permissionsFor must be asked about it. */
const BOT = { id: "900" };

/**
 * A cached (gateway) text channel entry: `obfuscated` sets CHANNEL_OBFUSCATED, and `botView` is
 * whether its cached overwrites leave TaruBot View Channel. An entry a slash-command option
 * un-flagged is `{ obfuscated: false, botView: false }`: real flags over the synthetic deny.
 */
const cachedText = (obfuscated: boolean, botView: boolean) => ({
  type: ChannelType.GuildText,
  flags: new ChannelFlagsBitField(obfuscated ? ChannelFlags.ChannelObfuscated : 0),
  permissionsFor: (member: unknown) => {
    if (member !== BOT) throw new Error("permissionsFor must be asked about TaruBot's member");
    return new PermissionsBitField(botView ? P.ViewChannel : 0n);
  },
});

/**
 * A gateway whose guild 100 lists `listed` channels in its cache (Discord sends hidden channels
 * there too), each a bare channel type or a fuller entry such as cachedText's, and whose channel
 * fetch answers with `fetched` or rejects with it.
 */
function gatewayWith(
  listed: Record<string, ChannelType | ReturnType<typeof cachedText>>,
  fetched: unknown,
): DiscordGateway {
  const gateway = new DiscordGateway();
  created.push(gateway);
  const guild = {
    id: "100",
    roles: { fetch: async () => new Collection() },
    members: { fetchMe: async () => BOT },
    channels: {
      cache: new Collection(
        Object.entries(listed).map(([id, entry]) => [
          id,
          typeof entry === "object" ? { id, ...entry } : { id, type: entry },
        ]),
      ),
    },
  };
  spyOn(gateway.client.guilds, "fetch").mockImplementation(async () => guild as never);
  spyOn(gateway.client.channels, "fetch").mockImplementation(async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched as never;
  });
  return gateway;
}

/** The refusal validateChannel throws for the stubbed channel. */
async function refusal(gateway: DiscordGateway): Promise<unknown> {
  return gateway.validateChannel("100", CHANNEL).then(
    () => new Error("Expected validateChannel to refuse"),
    (caught: unknown) => caught,
  );
}

/** The officer card for a refusal, as /config validate would show it. */
const officerCard = (error: unknown) =>
  onlyEmbed(failureReply(error, { ref: REF, viewer: VIEWERS.officer, scope: "/config validate" }));
/** The officer card's field names for a refusal. */
const officerFields = (error: unknown) => officerCard(error).fields?.map((field) => field.name);

/**
 * A fetched text channel in guild 100 where TaruBot's permissions come to `granted` (as
 * permissionsFor resolves them, Administrator included), with these overwrites in its cache.
 */
const fetchedText = (
  granted: bigint,
  overwrites: readonly { id: string; type: OverwriteType; deny: bigint }[] = [],
) => ({
  id: CHANNEL,
  type: ChannelType.GuildText,
  guildId: "100",
  permissionsFor: (member: unknown) => {
    if (member !== BOT) throw new Error("permissionsFor must be asked about TaruBot's member");
    return new PermissionsBitField(granted);
  },
  permissionOverwrites: {
    cache: new Collection(
      overwrites.map((entry) => [
        entry.id,
        {
          id: entry.id,
          type: entry.type,
          allow: new PermissionsBitField(0n),
          deny: new PermissionsBitField(entry.deny),
        },
      ]),
    ),
  },
});

/** Every posting permission but `lacking`. */
const allBut = (lacking: bigint) =>
  (P.ViewChannel | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory) & ~lacking;

/** The permissions refusal's approved wording and typed detail. */
const PERMISSIONS = {
  code: "blocked",
  message: `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${CHANNEL}>, and it must be a text channel in this server.`,
  detail: { kind: "resource", resource: "channel", id: CHANNEL, fix: "channel_permissions" },
};

/** The unavailable refusal's wording and detail: no permissions remedy. */
const UNAVAILABLE = {
  code: "blocked",
  message: `<#${CHANNEL}> is unavailable: it no longer exists or isn't a text channel in this server. Choose another with /config.`,
  detail: { kind: "resource", resource: "channel", id: CHANNEL },
};

test("a text channel TaruBot can't view (50001 Missing Access) is a permissions problem with a fix", async () => {
  // A private channel whose overwrites hide it from TaruBot's role: the most common misconfiguration.
  const error = await refusal(
    gatewayWith({ [CHANNEL]: ChannelType.GuildText }, discordError(50001, 403)),
  );
  expect(error).toBeInstanceOf(Failure);
  expect(error).toMatchObject(PERMISSIONS);
  expect(officerFields(error)).toEqual(["Affected", "How to fix", "Then"]);
});

test("a deleted channel (10003) the gateway no longer holds is unavailable, with no permissions remedy", async () => {
  const error = await refusal(gatewayWith({}, discordError(10003, 404)));
  expect(error).toMatchObject(UNAVAILABLE);
  expect(Reflect.get(Reflect.get(error as object, "detail") as object, "fix")).toBeUndefined();
  expect(officerFields(error)).toEqual(["Affected", "Then"]);
});

test("a 10003 for a text channel the gateway still holds as hidden is a permissions problem (#47)", async () => {
  // Discord doesn't document its single-channel answer for a hidden channel from 2026-11-16. An
  // obfuscated entry, or one a channel option un-flagged over the synthetic deny, is hidden.
  for (const [obfuscated, botView] of [
    [true, false],
    [true, true],
    [false, false],
  ] as const) {
    const error = await refusal(
      gatewayWith({ [CHANNEL]: cachedText(obfuscated, botView) }, discordError(10003, 404)),
    );
    expect({ obfuscated, botView, error }).toMatchObject({
      obfuscated,
      botView,
      error: PERMISSIONS,
    });
    expect(officerFields(error)).toEqual(["Affected", "How to fix", "Then"]);
  }
});

test("a 10003 for a stale entry TaruBot could view is a deleted channel, so unavailable", async () => {
  // Deleted after the gateway sent it, with its CHANNEL_DELETE not yet applied.
  const error = await refusal(
    gatewayWith({ [CHANNEL]: cachedText(false, true) }, discordError(10003, 404)),
  );
  expect(error).toMatchObject(UNAVAILABLE);
  expect(officerFields(error)).toEqual(["Affected", "Then"]);
});

test("50001 for a channel this server doesn't list (another server's) is unavailable", async () => {
  const error = await refusal(gatewayWith({}, discordError(50001, 403)));
  expect(error).toMatchObject(UNAVAILABLE);
  expect(officerFields(error)).toEqual(["Affected", "Then"]);
});

test("a visible text channel missing a permission keeps the permissions refusal", async () => {
  const channel = fetchedText(allBut(P.EmbedLinks));
  const error = await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, channel));
  expect(error).toMatchObject(PERMISSIONS);
  expect(officerFields(error)).toEqual(["Affected", "How to fix", "Then"]);
});

/** Text 19: TaruBot's own member entry denies what it lacks (2.35.0, #46). */
const MEMBER_ENTRY = {
  code: "blocked",
  message: `TaruBot's member entry in <#${CHANNEL}> denies Read Message History; remove that deny (on the member, not its role). TaruBot needs View Channel, Send Messages, Embed Links and Read Message History there. Or turn Administrator on for TaruBot, set the channel in /config, and run /setup overrides confirm:true, then remove Administrator once /config validate says it is no longer needed.`,
  detail: { kind: "resource", resource: "channel", id: CHANNEL, fix: "member_entry" },
};

test("TaruBot's own member entry denying history gets the member-entry refusal and fix", async () => {
  // The deny mask an earlier /setup overrides run wrote while no setting named this channel.
  const masked = fetchedText(allBut(P.ReadMessageHistory), [
    {
      id: BOT.id,
      type: OverwriteType.Member,
      deny: P.ReadMessageHistory | P.ManageRoles | P.ManageChannels | P.CreateInstantInvite,
    },
  ]);
  const error = await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, masked));
  expect(error).toBeInstanceOf(Failure);
  expect(error).toMatchObject(MEMBER_ENTRY);
  // Text 20: the member entry, not the role, then the usual re-check.
  const card = officerCard(error);
  expect(card.fields?.map((field) => [field.name, field.value])).toEqual([
    ["Affected", `<#${CHANNEL}> (\`${CHANNEL}\`)`],
    [
      "How to fix",
      "Channel settings → Permissions → TaruBot (the member entry, not the role): remove the denies named above.",
    ],
    ["Then", "Run `/config validate` to re-check every role and channel."],
  ]);
  // Several denied bits are listed in the channel's own words, in catalog order.
  const two = fetchedText(allBut(P.EmbedLinks | P.ReadMessageHistory), [
    { id: BOT.id, type: OverwriteType.Member, deny: P.ReadMessageHistory | P.EmbedLinks },
  ]);
  expect(await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, two))).toMatchObject({
    message: expect.stringContaining(
      `TaruBot's member entry in <#${CHANNEL}> denies Embed Links and Read Message History;`,
    ),
  });
});

test("a role-level deny, or a member deny on a bit TaruBot has, keeps the permissions refusal", async () => {
  const roleDeny = fetchedText(allBut(P.ReadMessageHistory), [
    { id: "600", type: OverwriteType.Role, deny: P.ReadMessageHistory },
  ]);
  expect(await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, roleDeny))).toMatchObject(
    PERMISSIONS,
  );
  // Its own entry denies Manage Permissions only; what it lacks (Embed Links) comes from elsewhere.
  const unrelated = fetchedText(allBut(P.EmbedLinks), [
    { id: BOT.id, type: OverwriteType.Member, deny: P.ManageRoles },
  ]);
  expect(await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, unrelated))).toMatchObject(
    PERMISSIONS,
  );
});

test("with Administrator the same channel passes: permissionsFor answers everything", async () => {
  const masked = fetchedText(PermissionsBitField.All, [
    { id: BOT.id, type: OverwriteType.Member, deny: P.ReadMessageHistory },
  ]);
  const gateway = gatewayWith({ [CHANNEL]: ChannelType.GuildText }, masked);
  expect(await gateway.validateChannel("100", CHANNEL)).toBeUndefined();
});

test("a ledger post blocked by the member-entry refusal reads 'missing channel permissions'", () => {
  const presented = receiptReply(
    {
      ...LEDGER_RESULTS.alreadyRecorded,
      post: {
        status: "blocked",
        message_id: null,
        last_error: `blocked: ${MEMBER_ENTRY.message}`,
        channel_id: null,
      },
    },
    VIEWERS.officer,
  );
  const post = onlyEmbed(presented).fields?.find((field) => field.name === "Channel post");
  expect(post?.value).toContain("(missing channel permissions)");
});

test("other Discord errors from the channel fetch are not turned into a refusal", async () => {
  const error = await refusal(gatewayWith({}, discordError(0, 500)));
  expect(error).toBeInstanceOf(DiscordAPIError);
});
