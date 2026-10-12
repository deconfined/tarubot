/** Officer assignment uses the same identity resolution as claims and records its reason. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { assignReply } from "../../discord/presenters/characters.js";
import { resolveCharacter, userId } from "../../discord/selectors.js";
import { requirePermission } from "../../domain/policy.js";

export default defineCommand({
  data: command("assign", "Assign a trusted character link to a member")
    .addStringOption(string("member", "Member: pick a suggestion or paste a user ID", true, true))
    .addStringOption(string("reason", "Assignment reason", true))
    .addStringOption(string("character", "Character ID or canonical Lodestone URL"))
    .addStringOption(string("forename", "Exact forename"))
    .addStringOption(string("surname", "Exact surname"))
    .addStringOption(string("world", "Exact world")),
  permissions: ["characters.assign"],
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    requirePermission(actor, actor.guildId, "characters.assign");
    const app = services.get(applicationKey);
    await app.guild(actor);
    // A character linked to someone else fails as ownership_conflict; the failure presenter shows
    // officers the current owner beside the /unassign step (owner decision O3).
    return assignReply(
      await app.assign(
        actor,
        userId(interaction.options.getString("member", true)),
        await resolveCharacter(app, interaction),
        interaction.options.getString("reason", true),
      ),
      viewer,
    );
  },
  autocomplete(context) {
    requirePermission(context.actor, context.actor.guildId, "characters.assign");
    return completeMember(context);
  },
});
