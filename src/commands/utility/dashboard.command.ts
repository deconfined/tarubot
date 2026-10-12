/** A link to TaruBot's dashboard (2.42.0) for every human guild member, or why there is none. */
import { dashboardKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dashboardReply } from "../../discord/presenters/utility.js";

export default defineCommand({
  data: command("dashboard", "Get a link to TaruBot's dashboard"),
  requires: [dashboardKey],
  execute({ services }) {
    return dashboardReply(services.get(dashboardKey).origin);
  },
});
