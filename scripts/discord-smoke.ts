/** Credentialed DevBot probe: verify deployed routes, member coverage, and bot-owned delivery. */
import { ChannelType, Events, PermissionFlagsBits } from "discord.js";
import { loadCommands } from "../src/bot/discovery.js";
import { assertAuthenticatedApplication, assertToolScope } from "../src/config/deployment.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { commandPaths } from "../src/discord/inspection.js";
import { id, json } from "../src/domain/values.js";

const config = configuration();
if (!config.TEST_GUILD_ID) throw new Error("TEST_GUILD_ID is required for this development probe.");
// DevBot's application only: the probe sends (and deletes) a message in the test guild, so it runs
// under the devbot profile, or under staging (#50), which is DevBot on the staging host.
const deployment = assertToolScope(process.env, {
  tool: "discord-smoke",
  guilds: [config.TEST_GUILD_ID],
  discord: "write",
  databases: [],
});
if (deployment.name !== "devbot" && deployment.name !== "staging")
  throw new Error("discord-smoke runs only under the devbot or staging profile.");
const args = process.argv.slice(2);
/** All optional mutation targets are explicit; the only write is a temporary message by DevBot. */
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const gateway = new DiscordGateway();
try {
  await gateway.client.login(config.DISCORD_TOKEN);
  if (!gateway.client.isReady())
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("DevBot gateway readiness timed out.")),
        20000,
      );
      gateway.client.once(Events.ClientReady, () => {
        clearTimeout(deadline);
        resolve();
      });
    });
  const application = gateway.client.application;
  assertAuthenticatedApplication(deployment, application?.id);
  if (
    !application ||
    application.id !== config.DISCORD_APPLICATION_ID ||
    gateway.client.user?.username.toLowerCase() !== "devbot"
  ) {
    throw new Error("Refusing live checks for an application other than the configured DevBot.");
  }
  const guildId = config.TEST_GUILD_ID;
  const guild = await gateway.client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe({ force: true });
  const registered = await application.commands.fetch({ guildId });
  const definitions = await loadCommands();
  const expected = [...definitions.values()]
    .flatMap((command) => {
      const data = command.toJSON();
      return commandPaths(data.name, data.options);
    })
    .sort();
  const actual = [...registered.values()]
    .flatMap((command) => commandPaths(command.name, command.options))
    .sort();
  if (json(expected) !== json(actual))
    throw new Error("Deployed DevBot command inventory differs from discovered modules.");
  for (const command of registered.values()) {
    if (command.applicationId !== application.id || command.guildId !== guildId)
      throw new Error("Unexpected command ownership or scope.");
    const definition = definitions.get(command.name)?.toJSON();
    if (
      (command.defaultMemberPermissions?.bitfield.toString() ?? null) !==
      (definition?.default_member_permissions ?? null)
    ) {
      throw new Error(`Default command permissions differ for ${command.name}.`);
    }
  }

  const members = await gateway.members(guildId);
  const validatedRoles: string[] = [];
  for (const role of [option("--member-role"), option("--guest-role")]) {
    if (role) {
      await gateway.validateRole(guildId, id(role));
      validatedRoles.push(role);
    }
  }
  let delivery = "not_requested";
  const destination = option("--channel");
  if (destination) {
    const channelId = id(destination);
    // A plain-text post, the same path officer notices use; embeds are covered by unit tests.
    const messageId = await gateway.send(
      guildId,
      channelId,
      { kind: "text", text: "DevBot live smoke check: validating message delivery." },
      `devbot-smoke:${crypto.randomUUID()}`,
    );
    const channel = await gateway.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId)
      throw new Error("Smoke channel scope changed.");
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== application.id)
      throw new Error("Message ownership did not match DevBot.");
    try {
      await message.edit({
        content: "DevBot live smoke check: delivery and editing verified.",
        allowedMentions: { parse: [] },
      });
    } finally {
      await message.delete();
    }
    delivery = "sent_edited_deleted";
  }
  console.log(
    json(
      {
        applicationId: application.id,
        bot: gateway.client.user?.username,
        guildId,
        commands: registered.size,
        commandPaths: actual.length,
        memberEnumerationComplete: true,
        humans: members.filter((member) => !member.bot).length,
        onlyHumanIsGuildOwner: members
          .filter((member) => !member.bot)
          .every((member) => member.id === guild.ownerId),
        bots: [...guild.members.cache.values()]
          .filter((member) => member.user.bot)
          .map((member) => ({ id: member.id, name: member.user.username })),
        validatedRoles,
        delivery,
        administrator: me.permissions.has(PermissionFlagsBits.Administrator, false),
        gatewayLatencyMs: gateway.client.ws.ping >= 0 ? gateway.client.ws.ping : null,
      },
      2,
    ),
  );
} finally {
  await gateway.client.destroy();
}
