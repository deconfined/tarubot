/** Mixed-permission guest operations; each private operation reauthorizes its actor. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember, focusedOption } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import {
  applicationChoice,
  decisionReply,
  guestActionReply,
  guestResetReply,
  guestStatusReply,
} from "../../discord/presenters/guests.js";
import { userId, uuid } from "../../discord/selectors.js";
import { authorizeOwner, can, requirePermission } from "../../domain/policy.js";

const data = command("guest", "Guest applications, grants, and revocations");
for (const name of ["approve", "deny"])
  data.addSubcommand((sub) => {
    sub
      .setName(name)
      .setDescription(`${name} a guest application`)
      .addStringOption(string("application", "Application ID", true, true));
    if (name === "deny") sub.addStringOption(string("reason", "Decision reason"));
    return sub;
  });
for (const name of ["grant", "revoke", "reset"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(
        name === "reset"
          ? "Remove the revoke and every grant; membership and characters decide again"
          : `${name} durable guest access`,
      )
      .addStringOption(string("member", "Member: pick a suggestion or paste a user ID", true, true))
      .addStringOption(string("reason", "Audited reason", true)),
  );
data.addSubcommand((sub) =>
  sub
    .setName("status")
    .setDescription("Inspect durable guest access and delivery status")
    .addStringOption(
      string(
        "member",
        "Officers: the member to inspect; pick a suggestion or paste a user ID",
        false,
        true,
      ),
    ),
);

export default defineCommand({
  data,
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    if (sub === "approve" || sub === "deny")
      // The service validates the optional denial reason with note(), since the applicant sees it.
      return decisionReply(
        await app.decide(
          actor,
          uuid(options.getString("application", true), "application"),
          sub === "approve",
          options.getString("reason"),
        ),
        viewer,
        { via: "command" },
      );
    const memberOption = options.getString("member");
    const owner = userId(memberOption ?? actor.userId, "member");
    // reset removes every override (owner decision, 2026-09-24).
    if (sub === "reset")
      return guestResetReply(
        await app.guestReset(actor, owner, options.getString("reason", true)),
        viewer,
      );
    if (sub === "grant" || sub === "revoke")
      return guestActionReply(
        await app.guestAction(
          actor,
          owner,
          sub === "revoke",
          options.getString("reason", true),
          interaction.id,
        ),
        viewer,
      );
    // A member naming someone else is refused here ('Only your own records'), before any read.
    authorizeOwner(actor, actor.guildId, owner);
    return guestStatusReply(await app.guestStatus(actor, owner), viewer, {
      owner,
      memberOption: memberOption !== null,
    });
  },
  async autocomplete(context) {
    const { actor, interaction, services } = context;
    if (focusedOption(context) === "member") {
      // Grant and revoke are officer-only; a member's /guest status covers only themselves.
      const status = interaction.options.getSubcommand(true) === "status";
      if (!status) requirePermission(actor, actor.guildId, "guests.manage");
      return completeMember(context, status && !can(actor, "members.view"));
    }
    // Mixed permission groups cannot rely on root command defaults to protect completion.
    requirePermission(actor, actor.guildId, "guests.decide");
    const rows = await services.get(applicationKey).applicationChoices(actor);
    // Filter in-process on what the label shows (C12): the applicant's cached display name (no
    // network call inside Discord's autocomplete window), their user ID, and the application ID,
    // whose first eight characters are the label's short ID.
    const query = String(interaction.options.getFocused()).trim().toLocaleLowerCase("en-US");
    const members = interaction.guild?.members.cache;
    return rows
      .map((row) => ({ row, name: members?.get(row.user_id)?.displayName ?? null }))
      .filter(
        ({ row, name }) =>
          !query ||
          (name?.toLocaleLowerCase("en-US").includes(query) ?? false) ||
          row.user_id.includes(query) ||
          row.id.includes(query),
      )
      .map(({ row, name }) => applicationChoice(row, name));
  },
});
