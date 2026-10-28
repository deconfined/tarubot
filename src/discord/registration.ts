/**
 * Command registration: one bulk PUT that replaces a scope's commands with the declared set. The
 * bot runs it at every start once it is ready (2.46.0, src/application/startup.ts), and register.js
 * remains the manual tool; both declare the same tool scope to the deployment guard first.
 */
import { Routes } from "discord.js";
import { z } from "zod";
import type { ToolScope } from "../config/deployment.js";
import { Failure, idSchema } from "../domain/values.js";
import { type CommandOption, commandPaths } from "./inspection.js";

/** The REST subset registration and commands.js use; discord.js REST satisfies it, tests fake it. */
export interface CommandRest {
  get(route: `/${string}`): Promise<unknown>;
  put(route: `/${string}`, options: { body: unknown[] }): Promise<unknown>;
}

/** A declared command as discovery's toJSON produces it. */
export interface DeclaredCommand {
  name: string;
  options?: readonly CommandOption[] | undefined;
  default_member_permissions?: string | null | undefined;
}

export type RegistrationScope = { kind: "guild"; guild: string } | { kind: "global" };

/**
 * The deployment guard's view of one registration. Managed profiles register only in their
 * declared scope, so production may replace only the global set: a production --guild registration
 * would shadow it with duplicate commands.
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
