/**
 * /setup, split in 2.35.0 (#46) into two subcommands, both dry runs unless confirm:true:
 * - /setup onboarding: access roles, a newcomer lobby and officer-only channels (the pre-2.35.0
 *   /setup, same options), with a default DevBot role prefix in the test guild. confirm:true
 *   answers with the setup summary (created or reused resources, next steps and Check sync
 *   status); without it, the dry run lists what it would do and every blocker. Production never
 *   runs it with confirm:true.
 * - /setup overrides: TaruBot's own channel overrides, added while it holds Administrator, so it
 *   can see (and post where it should) once Administrator is removed.
 * The pre-2.35.0 shape (/setup with options and no subcommand) gets the stale card from the router.
 */
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { applicationKey, roleAdministrationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { setupReply } from "../../discord/presenters/configuration.js";
import { overridesReply, setupPlanReply } from "../../discord/presenters/setup.js";
import { lodestoneId } from "../../domain/values.js";

/** Both subcommands' confirm option: without it, only a dry run. */
const CONFIRM = "Make the changes; without it, only show what would change";

export default defineCommand({
  data: command("setup", "Set up TaruBot: lobby onboarding, or TaruBot's own channel overrides")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild |
        PermissionFlagsBits.ManageRoles |
        PermissionFlagsBits.ManageChannels,
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("onboarding")
        .setDescription(
          "Access roles, a newcomer lobby and officer-only channels; a dry run unless confirm:true",
        )
        .addStringOption(string("fc_id", "Optional FC ID or canonical Lodestone URL"))
        .addStringOption((option) =>
          option
            .setName("prefix")
            .setDescription("Role-name prefix; defaults to DevBot in the test guild")
            .setMaxLength(50),
        )
        .addStringOption(
          string("officer_rank", "Optional in-game FC rank granting bot officer access"),
        )
        .addChannelOption((option) =>
          option
            .setName("lobby")
            .setDescription("Existing lobby to reuse")
            .addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((option) =>
          option
            .setName("officers")
            .setDescription("Existing officer-only room to reuse")
            .addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((option) => option.setName("confirm").setDescription(CONFIRM)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("overrides")
        .setDescription(
          "TaruBot's own channel overrides, added while it holds Administrator; a dry run unless confirm:true",
        )
        .addBooleanOption((option) => option.setName("confirm").setDescription(CONFIRM)),
    ),
  access: "officer",
  requires: [applicationKey, roleAdministrationKey],
  async execute({ actor, viewer, interaction, services }) {
    const administration = services.get(roleAdministrationKey);
    const options = interaction.options;
    const confirm = options.getBoolean("confirm") === true;
    if (options.getSubcommand() === "overrides")
      return overridesReply(await administration.overrides(actor, confirm), viewer);
    const app = services.get(applicationKey);
    const fc = options.getString("fc_id");
    const args = [
      actor,
      options.getString("prefix") ?? (app.config.TEST_GUILD_ID ? "DevBot" : ""),
      fc ? lodestoneId(fc, "freecompany") : null,
      options.getString("officer_rank"),
      {
        lobby: options.getChannel("lobby")?.id ?? null,
        officers: options.getChannel("officers")?.id ?? null,
      },
    ] as const;
    return confirm
      ? setupReply(await administration.setup(...args), viewer)
      : setupPlanReply(await administration.planSetup(...args), viewer);
  },
});
