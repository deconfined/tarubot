/** Private link inventory; inspecting another user requires officer permission. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { charactersReply } from "../../discord/presenters/characters.js";
import { userId } from "../../discord/selectors.js";
import { authorizeOwner, can } from "../../domain/policy.js";

export default defineCommand({
  data: command("characters", "List local characters and verification provenance").addStringOption(
    string(
      "member",
      "Officers: the member to inspect; pick a suggestion or paste a user ID",
      false,
      true,
    ),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    const option = interaction.options.getString("member");
    const owner = userId(option ?? actor.userId);
    authorizeOwner(actor, actor.guildId, owner);
    // The officer layout needs the member option, so an officer's own /characters stays personal.
    return charactersReply(await services.get(applicationKey).characters(actor, owner), viewer, {
      owner,
      memberOption: option !== null,
    });
  },
  // Members may read only their own links, so they are offered only themselves.
  autocomplete: (context) => completeMember(context, !can(context.actor, "members.view")),
});
