/** Audited officer removal supports stored owners who have left Discord. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter, completeMember, focusedOption } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { unlinkReply } from "../../discord/presenters/characters.js";
import { userId } from "../../discord/selectors.js";
import { requirePermission } from "../../domain/policy.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("unassign", "Remove a user's local character link")
    .addStringOption(
      string(
        "member",
        "Owner: pick a suggestion, or paste a stored ID (also for users who left)",
        true,
        true,
      ),
    )
    .addStringOption(string("character", "Stored character ID", true, true))
    .addStringOption(string("reason", "Audited reason", true)),
  permissions: ["characters.unassign"],
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    requirePermission(actor, actor.guildId, "characters.unassign");
    return unlinkReply(
      await services
        .get(applicationKey)
        .unclaim(
          actor,
          userId(interaction.options.getString("member", true)),
          id(interaction.options.getString("character", true), "character"),
          interaction.options.getString("reason", true),
        ),
      viewer,
      { command: "unassign" },
    );
  },
  autocomplete(context) {
    requirePermission(context.actor, context.actor.guildId, "characters.unassign");
    if (focusedOption(context) === "member") return completeMember(context);
    // The selected owner, not the invoking officer, scopes the character query.
    return completeCharacter(
      context,
      "character",
      userId(context.interaction.options.getString("member", true)),
    );
  },
});
