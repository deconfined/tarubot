/**
 * Explicit officer overrides are restricted to actual server managers with Manage Roles. The
 * receipt names the member, what happens to their Officer role, and the audited reason. reset
 * removes an override so the in-game rank decides again (owner decision, 2026-09-24).
 */
import { PermissionFlagsBits } from "discord.js";
import { roleAdministrationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { officerOverrideReply, officerResetReply } from "../../discord/presenters/configuration.js";
import { userId } from "../../discord/selectors.js";

const data = command(
  "officer",
  "Manage explicit bot-officer grants, revocations and resets",
).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles);
for (const name of ["grant", "revoke", "reset"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(
        name === "reset"
          ? "Remove the grant or revoke; the in-game rank decides again"
          : `${name} bot-only officer authority`,
      )
      .addStringOption(string("member", "Member: pick a suggestion or paste a user ID", true, true))
      .addStringOption(string("reason", "Audited reason", true)),
  );
export default defineCommand({
  data,
  permissions: ["admin.grants"],
  requires: [roleAdministrationKey],
  async execute({ actor, viewer, interaction, services }) {
    const administration = services.get(roleAdministrationKey);
    const sub = interaction.options.getSubcommand(true);
    const user = userId(interaction.options.getString("member", true));
    const reason = interaction.options.getString("reason", true);
    if (sub === "reset")
      return officerResetReply(await administration.officerReset(actor, user, reason), viewer);
    return officerOverrideReply(
      await administration.officer(actor, user, sub === "grant", reason),
      viewer,
    );
  },
  // The router admits server managers only (admin.grants), for suggestions too.
  autocomplete: (context) => completeMember(context),
});
