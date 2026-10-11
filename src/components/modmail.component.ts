/**
 * /modmail's form submission (2.43.0). The actor is resolved fresh, as for any command, so the
 * Member or Guest role and Administrator are read from Discord now; ModMail.open, the same path the
 * Mod mail page's form takes, authorizes again and checks the switch and limits in its
 * transaction. Refusals are expected states and get the same plain reply as the form's own check.
 * The text goes straight to the application and is never echoed: the receipt names the case
 * number only.
 */
import { modmailKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { MODMAIL_PREFIX, modmailSubmission } from "../discord/modmail.js";
import {
  modmailInvalidReply,
  modmailOpenedReply,
  modmailRefusedReply,
} from "../discord/presenters/modmail.js";
import { Failure } from "../domain/values.js";

export default defineComponent({
  prefix: MODMAIL_PREFIX,
  requires: [modmailKey],
  // Private even under DevBot's public-response override: a public reply would show who opened a
  // case (or tried to).
  alwaysPrivate: true,
  async execute({ actor, interaction, services }) {
    // Only the /modmail form submits under this prefix; anything else is an obsolete control.
    if (!interaction.isModalSubmit())
      throw new Failure(
        "stale",
        "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
        0,
        { kind: "stale", what: "control" },
      );
    const outcome = await services
      .get(modmailKey)
      .open(actor, modmailSubmission(interaction, actor));
    switch (outcome.status) {
      case "opened":
        return modmailOpenedReply(outcome.number, outcome.url);
      case "refused":
        return modmailRefusedReply(outcome.reason);
      case "invalid":
        return modmailInvalidReply(outcome.field, outcome.error);
      case "conflict":
      case "already_opened":
        // Only the web form names a case ID; this submission never does.
        throw new Error("A /modmail form can't name a case");
    }
  },
});
