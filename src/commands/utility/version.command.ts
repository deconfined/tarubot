/** Public release information and bounded GitHub history for every human guild member. */
import { versionInformationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { versionReply } from "../../discord/presenters/version.js";
import { DEFAULT_COMMIT_COUNT, MAX_COMMIT_COUNT } from "../../infrastructure/github/client.js";

export default defineCommand({
  data: command("version", "Show the running version and recent GitHub commits").addIntegerOption(
    (option) =>
      option
        .setName("commits")
        .setDescription(
          `Number of recent commits (1–${MAX_COMMIT_COUNT}; default ${DEFAULT_COMMIT_COUNT})`,
        )
        .setMinValue(1)
        .setMaxValue(MAX_COMMIT_COUNT),
  ),
  requires: [versionInformationKey],
  async execute({ interaction, services }) {
    return versionReply(
      await services
        .get(versionInformationKey)
        .get(interaction.options.getInteger("commits") ?? DEFAULT_COMMIT_COUNT),
    );
  },
});
