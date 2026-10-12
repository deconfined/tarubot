/**
 * Officer 'Full details (JSON)': re-runs the read behind an officer view with the presser's fresh
 * authorization and replies with the complete result as an attached file (dataReply). The router
 * refuses members before this runs, and dataReply refuses a member viewer again. Each view is a
 * case below; groups add theirs as their read views gain the button.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { dataReply } from "../discord/presenters/reply.js";
import { Failure } from "../domain/values.js";

/** A details control this release renders no button for came from another release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "details",
  permissions: ["members.view", "ledger.audit", "sync.view_all"],
  requires: [applicationKey],
  // The file always arrives as a new reply, so the officer view it came from stays visible.
  acknowledge: "reply",
  async execute({ actor, viewer, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    const control = parseControlFor("details", interaction.customId);
    const app = services.get(applicationKey);
    switch (control.action) {
      case "characters":
        // Another member's /characters (approved style guide list): every link row, active or
        // ended, with its provenance and preferences; the service authorizes the officer again.
        return dataReply(
          viewer,
          "characters",
          await app.characters(actor, control.userId),
          new Date(),
        );
      case "balance":
        // /ledger balance (approved ledger#17): the account, balance state, latest entry and the
        // newest ten posts with their diagnostics. Scope c refuses a view whose FC was replaced.
        return dataReply(
          viewer,
          "ledger-balance",
          await app.ledgerRead(
            actor,
            control.fcId,
            null,
            false,
            control.scope === "c" ? "current" : "any",
          ),
          new Date(),
        );
      case "history":
        // The officer /ledger history page it sat on: the same FC, scope and cursor, with every
        // entry's full note and the page's posts, which the embed quotes and summarizes.
        return dataReply(
          viewer,
          "ledger-history",
          await app.ledgerRead(
            actor,
            control.fcId,
            control.before === null ? null : String(control.before),
            true,
            control.scope === "c" ? "current" : "any",
          ),
          new Date(),
        );
      case "sync":
        // The officer /sync status overview (approved guests#44) or one run's detail: every run,
        // outstanding job and full diagnostic the embed summarizes or cuts at ten lines.
        return dataReply(viewer, "sync", await app.syncStatus(actor, control.run), new Date());
      case "guest":
        // Another member's /guest status record: every grant, application and the ten newest
        // deliveries, where the embed shows five, five and three. Answers are never included.
        return dataReply(viewer, "guest", await app.guestStatus(actor, control.userId), new Date());
      default:
        throw obsolete();
    }
  },
});
