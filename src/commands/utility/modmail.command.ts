/**
 * /modmail (2.43.0, issue #60): a member or guest opens a private case with the server's officers.
 * It opens a form (topic and message); the conversation then continues on TaruBot's dashboard,
 * never in Discord. The form's check below refuses plainly when a case can't be opened, before
 * anyone types, a person whose opening of cases is paused included (2.45.0); the submission (the
 * modmail component) checks everything again.
 */
import { PermissionFlagsBits } from "discord.js";
import { modmailKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { modmailModal } from "../../discord/modmail.js";
import { command } from "../../discord/options.js";
import { pausedFormReply } from "../../discord/presenters/failure.js";
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
  // Everything here comes with the interaction or from quick reads, never a Discord request: the
  // member's roles from the payload, whether TaruBot holds Administrator from its own permissions
  // in this channel (Administrator itself, so the has() check ignores implied bits), and whether
  // they are a server manager, who can't be paused (the gate has no resolved actor, so the
  // payload's permissions stand in; a wrong "not a manager" costs only one read).
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
        interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
        ) ?? false,
      );
    if (refusal === null) return null;
    // A pause is the same Paused for you card the submission gives, without its footer.
    return typeof refusal === "string"
      ? modmailRefusedReply(refusal)
      : pausedFormReply("modmail.open", refusal.paused);
  },
  modal: modmailModal,
});
