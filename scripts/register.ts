/**
 * Explicit command deployment using the same filesystem-discovered definitions as runtime.
 *
 *   bun dist/scripts/register.js --guild GUILD_ID   (DevBot / development: one guild scope)
 *   bun dist/scripts/register.js --global           (production cutover: the global scope)
 *
 * The deployment guard runs before any request, and the token's application must equal
 * DISCORD_APPLICATION_ID before the bulk PUT replaces the chosen scope. Read the result back with
 * commands.js list; a global PUT leaves guild-scoped leftovers in place.
 */
import { REST, Routes } from "discord.js";
import { z } from "zod";
import { loadCommands } from "../src/bot/discovery.js";
import { assertToolScope, type ToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import { commandPaths } from "../src/discord/inspection.js";
import { Failure, id, idSchema, json } from "../src/domain/values.js";
import type { CommandRest, DeclaredCommand } from "./commands.js";

export type RegistrationScope = { kind: "guild"; guild: string } | { kind: "global" };

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

/**
 * The deployment guard's view of one registration. Managed profiles register only in their
 * declared scope, so production may replace only the global set: a production --guild registration
 * would shadow it with duplicate commands. Exported so tests check exactly what register.js declares.
 */
export function registerToolScope(scope: RegistrationScope): ToolScope {
  return {
    tool: "register",
    guilds: scope.kind === "guild" ? [scope.guild] : [],
    discord: "write",
    databases: [],
    globalCommands: scope.kind === "global",
    registerScope: scope.kind === "global" ? "global" : scope.guild,
  };
}

/**
 * Replace one scope with the declared commands, after confirming the token's application. Returns
 * what was registered: the application, the scope, and the root and path counts.
 */
export async function registerCommands(
  rest: CommandRest,
  applicationId: string,
  scope: RegistrationScope,
  commands: readonly DeclaredCommand[],
): Promise<{ application: string; scope: string; roots: number; paths: number }> {
  const application = z.object({ id: idSchema }).parse(await rest.get(Routes.currentApplication()));
  if (application.id !== applicationId)
    throw new Failure(
      "configuration",
      `The token belongs to application ${application.id}, not DISCORD_APPLICATION_ID ${applicationId}.`,
    );
  await rest.put(
    scope.kind === "guild"
      ? Routes.applicationGuildCommands(applicationId, scope.guild)
      : Routes.applicationCommands(applicationId),
    { body: [...commands] },
  );
  return {
    application: applicationId,
    scope: scope.kind === "guild" ? `guild:${scope.guild}` : "global",
    roots: commands.length,
    paths: commands.flatMap((command) => commandPaths(command.name, command.options)).length,
  };
}

if (import.meta.main) {
  const scope = registrationScope(process.argv.slice(2), process.env);
  assertToolScope(process.env, registerToolScope(scope));
  // DISCORD_TOKEN, or the file DISCORD_TOKEN_FILE names inside a Quadlet host's container.
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
