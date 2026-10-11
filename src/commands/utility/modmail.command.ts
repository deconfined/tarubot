/**
 * /modmail (2.43.0, issue #60): a member or guest opens a private case with the server's officers.
 * It opens a form (topic and message); the conversation then continues on TaruBot's dashboard,
 * never in Discord. The form's check below refuses plainly when a case can't be opened, before
 * anyone types; the submission (the modmail component) checks everything again.
 */
import { PermissionFlagsBits } from "discord.js";
import { modmailKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { modmailModal } from "../../discord/modmail.js";
import { command } from "../../discord/options.js";
import { modmailRefusedReply } from "../../discord/presenters/modmail.js";

export default defineCommand({
  data: command(
    "modmail",
    "Privately message this server's officers; you continue on the dashboard",
  ),
  requires: [modmailKey],
  // Private even under DevBot's public-response override: a public reply would show who opened a
  // case (or tried to).
  alwaysPrivate: true,
  // Everything here comes with the interaction or from two quick reads, never a Discord request:
  // the member's roles from the payload, and whether TaruBot holds Administrator from its own
  // permissions in this channel (Administrator itself, so the has() check ignores implied bits).
  async beforeModal({ guildId, interaction, services }) {
    const roleIds = interaction.inCachedGuild()
      ? [...interaction.member.roles.cache.keys()]
      : interaction.inRawGuild()
        ? interaction.member.roles
        : [];
    const refusal = await services
      .get(modmailKey)
      .openGate(
        guildId,
        interaction.user.id,
        roleIds,
        interaction.appPermissions?.has(PermissionFlagsBits.Administrator, false) ?? true,
      );
    return refusal === null ? null : modmailRefusedReply(refusal);
  },
  modal: modmailModal,
});
