/**
 * /suggest (2.28.0, issue #32, owner decisions of 2026-09-25): a member or guest of the Free
 * Company's server suggests a TaruBot feature. It is posted at once as a public issue in TaruBot's
 * GitHub repository, with only the cleaned idea and TaruBot's version; the reply links to it. The
 * command passes no username or interaction ID: nothing about the member goes public.
 */
import { suggestionsKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { suggestionReply } from "../../discord/presenters/utility.js";
import { SUGGESTION_MAX, SUGGESTION_MIN } from "../../domain/suggestions.js";

export default defineCommand({
  data: command(
    "suggest",
    "Suggest a TaruBot feature or improvement; it's posted publicly on GitHub",
  ).addStringOption((option) =>
    option
      .setName("idea")
      .setDescription(
        "Posted publicly on GitHub: no names, personal details or security problems (10–1000 characters)",
      )
      .setRequired(true)
      .setMinLength(SUGGESTION_MIN)
      .setMaxLength(SUGGESTION_MAX),
  ),
  requires: [suggestionsKey],
  async execute({ interaction, actor, services }) {
    return suggestionReply(
      await services.get(suggestionsKey).submit(actor, interaction.options.getString("idea", true)),
    );
  },
});
