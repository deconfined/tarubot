/** Status (#43, ADR D9): this server's background work and the bot's health, for officers. */
import { applicationKey, gatewayKey, lifecycleKey } from "../../application/keys.js";
import { definePage } from "../page.js";
import { guildNames } from "../mentions.js";
import { processStatus, renderStatus } from "../views/status.js";

export default definePage({
  path: "/g/:guild/status",
  title: "Status",
  access: ["officer"],
  requires: [applicationKey, lifecycleKey, gatewayKey],
  nav: "Background work",
  async get({ actor, guildId, services }) {
    // syncStatus authorizes the actor again at the application boundary, as REQUIREMENTS.md asks
    // of commands and buttons ("reauthorize the current actor").
    const sync = await services.get(applicationKey).syncStatus(actor, null);
    return renderStatus({
      process: processStatus(services.get(lifecycleKey).status()),
      sync,
      names: guildNames(services.get(gatewayKey), guildId),
    });
  },
});
