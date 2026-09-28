/**
 * /config show's 'Run health check' and /config validate's 'Re-check' (config:validate). Both run
 * the same read-only validation as /config validate for whoever clicks and re-render the view they
 * sit on as the checklist, so the health check replaces the configuration summary in place, as
 * approved. The router refuses members before this runs, and Service.validate authorizes the
 * presser's fresh actor again; the custom ID carries no selectors at all.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { healthReply } from "../discord/presenters/configuration.js";
import { Failure } from "../domain/values.js";

/** A config control on anything but a button can only come from an older release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "config",
  access: "officer",
  requires: [applicationKey],
  // A pure read re-rendered in place; the router still replies instead unless the view is private
  // or belongs to the presser, so a click never rewrites someone else's public test-guild view.
  acknowledge: "update",
  async execute({ actor, viewer, interaction, services, report }) {
    if (!interaction.isButton()) throw obsolete();
    // Strict parse: config:validate is the only action, with no selectors.
    parseControlFor("config", interaction.customId);
    // An unexpected error in TaruBot's channel view is reported and shown as unknown (2.35.0).
    return healthReply(
      await services
        .get(applicationKey)
        .validate(actor, (error) => report(error, "config visibility")),
      viewer,
    );
  },
});
