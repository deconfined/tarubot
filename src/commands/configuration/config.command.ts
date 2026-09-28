/**
 * Configuration command group: its schema and dispatch remain together as one feature. Every
 * subcommand answers with its configuration presenter; failures reach the router's failure
 * presenter unchanged.
 */
import { ChannelType } from "discord.js";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import {
  changeReply,
  fcUnlinkReply,
  guestApplicationsReply,
  healthReply,
  officerRankReply,
  roleLayoutReply,
  showReply,
} from "../../discord/presenters/configuration.js";
import { authorize } from "../../domain/policy.js";
import { Failure, lodestoneId } from "../../domain/values.js";

const data = command("config", "Configure this guild's FC, roles, and notification channels");

// FC unlink carries the expected ID so stale confirmations cannot unlink a replacement FC.
data.addSubcommandGroup((group) =>
  group
    .setName("fc")
    .setDescription("FC association")
    .addSubcommand((sub) =>
      sub
        .setName("link")
        .setDescription("Link an FC and queue synchronization")
        .addStringOption(string("fc_id", "FC ID or canonical Lodestone URL", true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlink")
        .setDescription("Unlink the matching FC locally")
        .addStringOption(string("fc_id", "Currently linked FC ID", true)),
    ),
);
data.addSubcommandGroup((group) => {
  group.setName("roles").setDescription("Bot-managed access roles");
  for (const name of ["member", "guest", "officer", "leader"])
    group.addSubcommand((sub) => {
      sub
        .setName(name)
        .setDescription(`Set or unset the ${name} role`)
        .addRoleOption((option) => option.setName("role").setDescription("Access role"))
        // "unset", not "clear": the role itself and its history stay (owner decision, 2026-09-24).
        .addBooleanOption((option) =>
          option
            .setName("unset_role")
            .setDescription("Stop managing this role; it stays in Discord and is cleaned up"),
        );
      // Binding an existing staff role normally grants its current holders officer access; a
      // rank-based launch binds it with adopt_holders:false instead (owner decision O1).
      if (name === "officer")
        sub.addBooleanOption((option) =>
          option
            .setName("adopt_holders")
            .setDescription(
              "Grant the role's current human holders officer access (default: true)",
            ),
        );
      return sub;
    });
  return group;
});
// Role-based officers cannot be represented by Discord's static default permission bitfield.
// Runtime authorization remains mandatory; authority-changing settings require server managers.
data.addSubcommand((sub) =>
  sub
    .setName("officer_rank")
    .setDescription("Set or unset the in-game rank granting bot officer access")
    .addStringOption(string("rank", "Exact in-game FC rank name"))
    .addBooleanOption((option) =>
      option.setName("unset_rank").setDescription("Use manual officer grants only"),
    ),
);
// Managed-role display/ordering is a per-guild opt-in; server managers with Manage Roles change it.
data.addSubcommand((sub) =>
  sub
    .setName("role_layout")
    .setDescription("Turn automatic display and ordering of the managed roles on or off")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Show managed roles separately in one ordered block")
        .setRequired(true),
    ),
);
// changelog (2.25.0) is where update posts go after the bot starts on a newer version.
for (const name of ["ledger", "officer_notifications", "changelog"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(`Set or unset the ${name.replaceAll("_", " ")} channel`)
      // Discord offers only text channels, as /setup's rooms do; the gateway still refuses others,
      // Announcement channels included.
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription(
            name === "changelog"
              ? "Text channel members and guests can read"
              : "Guild text channel",
          )
          .addChannelTypes(ChannelType.GuildText),
      )
      // "unset", not "clear": the channel and its messages stay (owner decision, 2026-09-24).
      .addBooleanOption((option) =>
        option.setName("unset_channel").setDescription("Stop using a channel for this"),
      ),
  );
// The applications switch is separate from the review channel (owner decision, 2026-09-24).
data.addSubcommand((sub) =>
  sub
    .setName("guest_applications")
    .setDescription("Turn guest applications on or off, and set their review channel")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Whether /apply takes applications"),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Staff-only text channel where applications are reviewed")
        .addChannelTypes(ChannelType.GuildText),
    )
    .addBooleanOption((option) =>
      option.setName("unset_channel").setDescription("Stop using a review channel"),
    ),
);
for (const name of ["show", "validate"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(
        name === "show"
          ? "Show configuration and capabilities"
          : "Validate resources without applying effects",
      ),
  );

export default defineCommand({
  data,
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services, report }) {
    authorize(actor, actor.guildId, "officer");
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    const group = options.getSubcommandGroup(false);
    if (group === "fc") {
      const fc = lodestoneId(options.getString("fc_id", true), "freecompany");
      if (sub === "link") return changeReply(await app.configure(actor, "fc_id", fc), viewer);
      // The typed ID names the FC when the result can't (its record was never read).
      return fcUnlinkReply(await app.unlinkCompany(actor, fc), viewer, { fcId: fc });
    }
    // Both read the same report; show summarizes it, validate lists every check. An unexpected
    // error in TaruBot's channel view is reported and shown as unknown (2.35.0, #46).
    const visibilityError = (error: unknown) => report(error, "config visibility");
    if (sub === "show") return showReply(await app.validate(actor, visibilityError), viewer);
    if (sub === "validate") return healthReply(await app.validate(actor, visibilityError), viewer);
    if (sub === "officer_rank") {
      const rank = options.getString("rank");
      const unset = options.getBoolean("unset_rank") === true;
      if ((rank !== null) === unset)
        throw new Failure("input", "Give a rank name or set unset_rank:true, not both.", 0, {
          kind: "option",
          option: "rank",
        });
      return officerRankReply(await app.configureOfficerRank(actor, rank), viewer);
    }
    if (sub === "guest_applications") {
      const channel = options.getChannel("channel")?.id ?? null;
      const unset = options.getBoolean("unset_channel") === true;
      const enabled = options.getBoolean("enabled");
      if (channel !== null && unset)
        throw new Failure("input", "Choose a channel or set unset_channel:true, not both.", 0, {
          kind: "option",
          option: "channel",
        });
      if (channel === null && !unset && enabled === null)
        throw new Failure("input", "Choose enabled, a channel, or unset_channel:true.", 0, {
          kind: "option",
          option: "enabled",
        });
      return guestApplicationsReply(
        await app.configureGuestApplications(actor, {
          ...(enabled === null ? {} : { enabled }),
          ...(channel !== null ? { channel } : unset ? { channel: null } : {}),
        }),
        viewer,
      );
    }
    if (sub === "role_layout")
      return roleLayoutReply(
        await app.configureRoleLayout(actor, options.getBoolean("enabled", true)),
        viewer,
      );
    const roles = group === "roles";
    const value = roles ? options.getRole("role")?.id : options.getChannel("channel")?.id;
    const unset = options.getBoolean(roles ? "unset_role" : "unset_channel") === true;
    // Exactly one of the resource and its unset option; the wording names the resource kind.
    if (!!value === unset)
      throw new Failure(
        "input",
        roles
          ? "Choose a role or set unset_role:true, not both."
          : "Choose a channel or set unset_channel:true, not both.",
        0,
        { kind: "option", option: roles ? "role" : "channel" },
      );
    const field = roles ? `${sub}_role_id` : `${sub}_channel_id`;
    // Only /config roles officer declares adopt_holders; omitted means the service default (true).
    const adoptHolders = group === "roles" ? options.getBoolean("adopt_holders") : null;
    // The service independently validates the field allowlist, ManageRoles, hierarchy, and that
    // adopt_holders accompanies an Officer role binding.
    return changeReply(
      await app.configure(
        actor,
        field,
        value ?? null,
        adoptHolders === null ? {} : { adoptHolders },
      ),
      viewer,
    );
  },
});
