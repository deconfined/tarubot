/**
 * The review message's Approve and Deny buttons. The custom ID carries only the action and the
 * application (guest:approve|deny:<uuid>, unchanged since 2.12.0); the router refuses non-officers
 * before this runs, and the service binds the decision to this guild, the presser's fresh officer
 * authority and the review message the button sits on, so an older review message is refused as
 * out of date. The reply is the same decision presenter /guest approve and deny use, in its short
 * button form, because the review message itself shows the outcome.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { decisionReply } from "../discord/presenters/guests.js";
import { Failure } from "../domain/values.js";

/** A guest control on anything but a button can only come from an older release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "guest",
  permissions: ["guests.decide"],
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    // The shared codec parses strictly (canonical lowercase UUID, exact segments); anything else
    // is an out-of-date control.
    const control = parseControlFor("guest", interaction.customId);
    return decisionReply(
      await services
        .get(applicationKey)
        .decide(
          actor,
          control.application,
          control.action === "approve",
          null,
          interaction.message.id,
        ),
      viewer,
      { via: "button" },
    );
  },
});
