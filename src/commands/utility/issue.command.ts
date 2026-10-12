/**
 * /issue (2.18.0, owner decision of 2026-09-24): any member reports a problem to TaruBot's
 * maintainers. The report opens an issue in the private reports repository with the member's
 * description and a snapshot of their account and the bot. One per member per 10 minutes, twenty
 * per server per day.
 */
import { issueReportsKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { issueReply } from "../../discord/presenters/utility.js";

export default defineCommand({
  data: command("issue", "Report a problem with TaruBot to its maintainers").addStringOption(
    (option) =>
      option
        .setName("description")
        .setDescription("What went wrong, and what you expected instead (10–1000 characters)")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(1000),
  ),
  requires: [issueReportsKey],
  async execute({ interaction, actor, services }) {
    return issueReply(
      await services
        .get(issueReportsKey)
        .user(
          actor,
          interaction.user.username,
          interaction.id,
          interaction.options.getString("description", true),
        ),
    );
  },
});
