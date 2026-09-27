/** Cutover CLI: capture complete human role/join/nickname state for every guild in the source dump. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Events } from "discord.js";
import { assertAuthenticatedApplication, assertToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { readDump } from "../src/import/dump.js";
import { snapshotSchema } from "../src/import/importer.js";
import { json } from "../src/domain/values.js";

const args = process.argv.slice(2);
/** Resolve explicit input/output paths; production secrets arrive through the environment. */
const option = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const file = option("--dump");
const output = option("--output");
// DISCORD_TOKEN, or the file DISCORD_TOKEN_FILE names.
const token = secretSetting(process.env, "DISCORD_TOKEN");
if (!file || !output || !token)
  throw new Error("DISCORD_TOKEN, --dump DUMP.sql, and --output SNAPSHOT.json are required.");
const data = readDump(await Bun.file(file).text());
// The dump's guilds must belong to this env's deployment profile before any login.
const deployment = assertToolScope(process.env, {
  tool: "snapshot",
  guilds: data.guilds.map((guild) => guild.guild_id),
  discord: "read",
  databases: [],
});
const gateway = new DiscordGateway();
try {
  await gateway.client.login(token);
  // Operational capture waits for login without loading application event handlers or workers.
  if (!gateway.client.isReady())
    await new Promise<void>((resolve) => gateway.client.once(Events.ClientReady, () => resolve()));
  // The token must belong to the profile's application before any member is enumerated.
  assertAuthenticatedApplication(deployment, gateway.client.application?.id);
  const guilds = [];
  for (const guild of data.guilds) {
    const members = await gateway.members(guild.guild_id);
    // Enumeration counts include bots for completeness; only humans enter bootstrap policy.
    guilds.push({
      id: guild.guild_id,
      complete: true,
      expectedCount: members.length,
      enumeratedCount: members.length,
      members: members
        .filter((member) => !member.bot)
        .map((member) => ({
          id: member.id,
          roles: member.roles,
          nickname: member.nickname,
          joinedAt: member.joinedAt.toISOString(),
        })),
    });
  }
  const snapshot = snapshotSchema.parse({ capturedAt: new Date().toISOString(), guilds });
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, json(snapshot));
  console.log(`Complete Discord snapshot saved to ${output}.`);
} finally {
  gateway.client.destroy();
}
