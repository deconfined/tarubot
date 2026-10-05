/** Status (#43, ADR D9): this server's background work and the bot's health, for officers. */
import { applicationKey, lifecycleKey } from "../../application/keys.js";
import { definePage } from "../page.js";
import { processStatus, renderStatus } from "../views/status.js";

export default definePage({
  path: "/g/:guild/status",
  title: "Status",
  access: ["officer"],
  requires: [applicationKey, lifecycleKey],
  nav: "Status",
  async get({ actor, services }) {
    // syncStatus authorizes the actor again at the application boundary, as REQUIREMENTS.md asks
    // of commands and buttons ("reauthorize the current actor").
    const sync = await services.get(applicationKey).syncStatus(actor, null);
    return renderStatus({ process: processStatus(services.get(lifecycleKey).status()), sync });
  },
});
