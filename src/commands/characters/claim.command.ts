/** Self-service ownership proof; reply visibility follows the active guild's presentation policy. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { claimReply } from "../../discord/presenters/characters.js";
import { resolveClaimCharacter } from "../../discord/selectors.js";

export default defineCommand({
  data: command("claim", "Claim a character by proving control of its Lodestone biography")
    .addStringOption(string("character", "Character ID or canonical Lodestone URL"))
    .addStringOption(string("forename", "Exact forename"))
    .addStringOption(string("surname", "Exact surname"))
    .addStringOption(string("world", "Exact world")),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    const app = services.get(applicationKey);
    // Refuse an unconfigured server before searching the Lodestone.
    await app.guild(actor);
    // A character the server's FC roster lists needs no Lodestone request here (#86).
    const { identity, read } = await resolveClaimCharacter(app, interaction, actor.guildId);
    // The plaintext token exists only in this reply's copyable content and temporary verification
    // memory; PostgreSQL stores its hash, and the embed never repeats it.
    return claimReply(await app.claim(actor, identity, read), viewer);
  },
});
