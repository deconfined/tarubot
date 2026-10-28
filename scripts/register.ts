/**
 * Explicit command deployment using the same filesystem-discovered definitions as runtime.
 *
 *   bun dist/scripts/register.js --guild GUILD_ID   (DevBot / development: one guild scope)
 *   bun dist/scripts/register.js --global           (production cutover: the global scope)
 *
 * The deployment guard runs before any request, and the token's application must equal
 * DISCORD_APPLICATION_ID before the bulk PUT replaces the chosen scope. Read the result back with
 * commands.js list; a global PUT leaves guild-scoped leftovers in place. Since 2.46.0 the bot
 * itself registers its profile's scope at every start (src/application/startup.ts; an unmanaged
 * installation only where COMMAND_REGISTRATION says); this is the manual tool for any other time.
 */
import { REST } from "discord.js";
import { loadCommands } from "../src/bot/discovery.js";
import { assertToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import {
  type RegistrationScope,
  registerCommands,
  registerToolScope,
} from "../src/discord/registration.js";
import { Failure, id, json } from "../src/domain/values.js";

// The bot registers at startup with the same functions (2.46.0), so they live in src/; existing
// importers keep reading them here.
export { type RegistrationScope, registerCommands, registerToolScope };

/**
 * Exactly one of --guild GUILD_ID or --global. --global is refused while TEST_GUILD_ID is set, so a
 * development env can never replace an application's global set.
 */
export function registrationScope(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): RegistrationScope {
  let guild: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--global" && !global) global = true;
    else if (argument === "--guild" && guild === null) {
      index += 1;
      try {
        guild = id(argv[index]);
      } catch {
        throw new Failure("input", "--guild needs a Discord guild ID.");
      }
    } else throw new Failure("input", `Unexpected argument ${argument}.`);
  }
  if ((guild !== null) === global)
    throw new Failure("input", "Choose exactly one of --guild GUILD_ID or --global.");
  if (global && (env.TEST_GUILD_ID ?? "").trim() !== "")
    throw new Failure(
      "configuration",
      "--global is refused while TEST_GUILD_ID is set; development registers one guild scope.",
    );
  return guild === null ? { kind: "global" } : { kind: "guild", guild };
}

if (import.meta.main) {
  const scope = registrationScope(process.argv.slice(2), process.env);
  assertToolScope(process.env, registerToolScope(scope));
  // Resolve the direct setting or its private NAME_FILE counterpart.
  const token = secretSetting(process.env, "DISCORD_TOKEN");
  if (!token) throw new Error("DISCORD_TOKEN is required");
  const application = id(process.env.DISCORD_APPLICATION_ID);
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = [...(await loadCommands()).values()].map((command) => command.toJSON());
  const result = await registerCommands(rest, application, scope, commands);
  console.log(
    json({ ...result, next: "Read back every scope with dist/scripts/commands.js list." }, 2),
  );
}
