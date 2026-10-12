/** Submit or retrieve a caller's durable application for their current join context. */
import { PermissionFlagsBits } from "discord.js";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { guestApplicationModal } from "../../discord/guest-application.js";
import { pausedFormReply } from "../../discord/presenters/failure.js";
import { applicationsClosedReply } from "../../discord/presenters/guests.js";

export default defineCommand({
  data: command("apply", "Apply for officer-reviewed Guest access without a verified character"),
  requires: [applicationKey],
  // Imported servers start with applications closed (owner decision 2026-09-23). One indexed read
  // refuses before the form opens, so a visitor never writes answers that cannot be submitted.
  // A person whose use of /apply is paused (2.45.0) is refused there too, after the closed check
  // and with one more indexed read: guests.apply is a baseline permission, so any active pause on
  // it applies, and a server manager (who can't be paused) skips the read. The submission path
  // (Service.apply) still refuses on its own, and is what decides.
  async beforeModal({ guildId, interaction, services }) {
    const app = services.get(applicationKey);
    // Discord permissions come with the interaction payload, so the hint costs no request. It
    // shows to server managers, who can run both commands it names; officers through the Officer
    // role can't be told from the payload, and the hint grants nothing either way.
    const manager =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
      ) ?? false;
    if (!(await app.guestApplicationsOpen(guildId)))
      return applicationsClosedReply({ officerHint: manager });
    if (manager) return null;
    const pause = await app.pauseOf(guildId, interaction.user.id, "guests.apply");
    return pause ? pausedFormReply("guests.apply", pause) : null;
  },
  modal: guestApplicationModal,
});
