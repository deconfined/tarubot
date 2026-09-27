/**
 * Command-scope maintenance over Discord REST only (no database, no gateway login).
 *
 *   bun dist/scripts/commands.js list [--guild GUILD_ID ...] [--declared-scope global|GUILD_ID]
 *   bun dist/scripts/commands.js clear-guild GUILD_ID --application APP_ID [--confirm FINGERPRINT]
 *
 * `list` reads back the global scope and every guild scope (the bot's joined guilds, or the named
 * ones) and compares them with the discovered declarations: the declared scope must match exactly
 * and every other scope must be empty. It exits 2 unless the inventory is clean, so a runbook can
 * gate on it. `clear-guild` removes leftover commands from one guild scope, only after a dry run and
 * a confirmation bound to the reviewed commands' fingerprint. Nothing here ever writes the global
 * scope; register.js --global remains the only way to replace it.
 */
import { createHash } from "node:crypto";
import { REST, Routes } from "discord.js";
import { z } from "zod";
import { loadCommands } from "../src/bot/discovery.js";
import { assertToolScope, type Deployment, type Launch } from "../src/config/deployment.js";
import { resolveSettings } from "../src/config/secrets.js";
import { commandPaths, type CommandOption, inventoryDiff } from "../src/discord/inspection.js";
import { Failure, id, idSchema, json } from "../src/domain/values.js";

/** The REST subset these tools use; discord.js REST satisfies it and tests supply a fake. */
export interface CommandRest {
  get(route: `/${string}`): Promise<unknown>;
  put(route: `/${string}`, options: { body: unknown[] }): Promise<unknown>;
}

/** A parsed invocation. `declaredScope` null means the deployment profile's registration scope. */
export type Mode =
  | { kind: "list"; guilds: string[] | "joined"; declaredScope: string | null }
  | { kind: "clear-guild"; guild: string; application: string; confirm: string | null };

const usage =
  "Use: list [--guild GUILD_ID ...] [--declared-scope global|GUILD_ID], or clear-guild GUILD_ID --application APP_ID [--confirm FINGERPRINT].";

/** Parse the command line strictly: unknown flags, missing values and a second mode are errors. */
export function parseArguments(argv: readonly string[]): Mode {
  const [kind, ...rest] = argv;
  const fail = (reason: string) => new Failure("input", `${reason} ${usage}`);
  /** Snowflake arguments are checked up front, before any request is made. */
  const snowflake = (value: string | undefined, flag: string): string => {
    if (value === undefined || value.startsWith("--")) throw fail(`${flag} needs a value.`);
    try {
      return id(value);
    } catch {
      throw fail(`${flag} must be a Discord ID.`);
    }
  };
  if (kind === "list") {
    const guilds: string[] = [];
    let declaredScope: string | null = null;
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index];
      const value = rest[index + 1];
      if (flag === "--guild") guilds.push(snowflake(value, "--guild"));
      else if (flag === "--declared-scope" && declaredScope === null)
        declaredScope = value === "global" ? "global" : snowflake(value, "--declared-scope");
      else throw fail(`Unexpected argument ${flag}.`);
    }
    return { kind, guilds: guilds.length ? [...new Set(guilds)] : "joined", declaredScope };
  }
  if (kind === "clear-guild") {
    const [target, ...flags] = rest;
    const guild = snowflake(target, "clear-guild");
    let application: string | null = null;
    let confirm: string | null = null;
    for (let index = 0; index < flags.length; index += 2) {
      const flag = flags[index];
      const value = flags[index + 1];
      if (flag === "--application" && application === null)
        application = snowflake(value, "--application");
      else if (flag === "--confirm" && confirm === null) {
        if (!value || !/^[0-9a-f]{16}$/.test(value))
          throw fail("--confirm takes the 16-character fingerprint printed by the dry run.");
        confirm = value;
      } else throw fail(`Unexpected argument ${flag}.`);
    }
    if (application === null) throw fail("clear-guild requires --application APP_ID.");
    return { kind, guild, application, confirm };
  }
  throw fail("Choose list or clear-guild.");
}

/** Recursive option shape as Discord returns it (only the fields that decide paths). */
interface RegisteredOption {
  type: number;
  name: string;
  options?: RegisteredOption[] | undefined;
}
const optionSchema: z.ZodType<RegisteredOption> = z.lazy(() =>
  z.object({
    type: z.number().int(),
    name: z.string(),
    options: z.array(optionSchema).optional(),
  }),
);
/** A registered command from GET .../commands. `version` changes on every edit. */
export const registeredSchema = z.array(
  z.object({
    id: idSchema,
    application_id: idSchema,
    guild_id: idSchema.optional(),
    name: z.string(),
    type: z.number().int().default(1),
    version: idSchema,
    default_member_permissions: z.string().nullable().optional(),
    options: z.array(optionSchema).optional(),
  }),
);
export type Registered = z.infer<typeof registeredSchema>[number];

/** A declared command as discovery's toJSON produces it. */
export interface DeclaredCommand {
  name: string;
  options?: readonly CommandOption[] | undefined;
  default_member_permissions?: string | null | undefined;
}

/**
 * Bind a confirmation to exactly the commands reviewed: sha256 over the sorted `id:name:version`
 * lines, first 16 hex characters. Any edit, addition or removal changes it.
 */
export function scopeFingerprint(
  commands: readonly { id: string; name: string; version: string }[],
): string {
  const lines = commands.map((command) => `${command.id}:${command.name}:${command.version}`);
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex").slice(0, 16);
}

/** One scope's comparison with what should be registered there. */
export interface ScopeReport {
  scope: "global" | `guild:${string}`;
  expected: "declared" | "empty";
  status: "read" | "unavailable";
  count: number;
  fingerprint: string;
  missing: string[];
  unexpected: string[];
  permissionMismatches: string[];
  shadowsGlobal: string[];
  commands: { id: string; name: string; type: number; version: string }[];
}

export interface InventoryReport {
  application: { id: string; name: string };
  membersIntent: boolean;
  guilds: { id: string; name: string }[];
  declaredScope: string;
  scopes: ScopeReport[];
  clean: boolean;
}

const applicationSchema = z.object({
  id: idSchema,
  name: z.string(),
  flags: z.number().optional(),
});
const guildsSchema = z.array(z.object({ id: idSchema, name: z.string() }));
/** Discord pages /users/@me/guilds at 200; a full page means some guilds were not listed. */
const GUILD_PAGE = 200;

/** The authenticated application must be the configured one before any command is read. */
async function authenticate(rest: CommandRest, applicationId: string) {
  const application = applicationSchema.parse(await rest.get(Routes.currentApplication()));
  if (application.id !== applicationId)
    throw new Failure(
      "configuration",
      `The token belongs to application ${application.id}, not DISCORD_APPLICATION_ID ${applicationId}.`,
    );
  return application;
}

/** The guilds the bot user belongs to, refusing a truncated page. */
async function joinedGuilds(rest: CommandRest) {
  const guilds = guildsSchema.parse(await rest.get(Routes.userGuilds()));
  if (guilds.length >= GUILD_PAGE)
    throw new Failure(
      "input",
      "The bot is in 200 or more guilds, so the list may be incomplete; pass --guild explicitly.",
    );
  return guilds;
}

/** A 403 (the application is not authorized in that guild) is reported rather than fatal. */
const forbidden = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "status" in error && error.status === 403;

/** Declared paths plus the default permissions Discord should report for each root. */
function declaredShape(declared: readonly DeclaredCommand[]) {
  return {
    paths: declared.flatMap((command) => commandPaths(command.name, command.options)),
    permissions: new Map(
      declared.map((command) => [command.name, command.default_member_permissions ?? null]),
    ),
  };
}

/**
 * Read back every command scope and compare it with the declarations. Order matters: the
 * application identity is checked before any command route is read.
 */
export async function inspectInventory(
  rest: CommandRest,
  applicationId: string,
  declared: readonly DeclaredCommand[],
  mode: { guilds: string[] | "joined"; declaredScope: string },
): Promise<InventoryReport> {
  const application = await authenticate(rest, applicationId);
  const joined = mode.guilds === "joined" ? await joinedGuilds(rest) : [];
  const guildIds = mode.guilds === "joined" ? joined.map((guild) => guild.id) : [...mode.guilds];
  // A guild declared scope is always read, even when the bot user is not listed in it.
  if (mode.declaredScope !== "global" && !guildIds.includes(mode.declaredScope))
    guildIds.push(mode.declaredScope);
  const want = declaredShape(declared);

  const read = async (scope: ScopeReport["scope"], route: `/${string}`) => {
    try {
      return { scope, commands: registeredSchema.parse(await rest.get(route)) };
    } catch (error) {
      if (forbidden(error)) return { scope, commands: null };
      throw error;
    }
  };
  const scopes = [await read("global", Routes.applicationCommands(applicationId))];
  for (const guild of guildIds)
    scopes.push(
      await read(`guild:${guild}`, Routes.applicationGuildCommands(applicationId, guild)),
    );
  const globalNames = new Set(scopes[0]?.commands?.map((command) => command.name) ?? []);

  const reports = scopes.map(({ scope, commands }): ScopeReport => {
    const isDeclared =
      scope === (mode.declaredScope === "global" ? "global" : `guild:${mode.declaredScope}`);
    const registered = commands ?? [];
    const paths = registered.flatMap((command) => commandPaths(command.name, command.options));
    const diff = inventoryDiff(isDeclared ? want.paths : [], paths);
    return {
      scope,
      expected: isDeclared ? "declared" : "empty",
      status: commands === null ? "unavailable" : "read",
      count: registered.length,
      fingerprint: scopeFingerprint(registered),
      missing: diff.missing,
      unexpected: diff.unexpected,
      // Compared like discord-smoke: Discord reports an unset default as null.
      permissionMismatches: isDeclared
        ? registered
            .filter(
              (command) =>
                want.permissions.has(command.name) &&
                (command.default_member_permissions ?? null) !== want.permissions.get(command.name),
            )
            .map((command) => command.name)
            .sort()
        : [],
      shadowsGlobal:
        scope === "global"
          ? []
          : registered
              .filter((command) => globalNames.has(command.name))
              .map((command) => command.name)
              .sort(),
      commands: registered.map(({ id, name, type, version }) => ({ id, name, type, version })),
    };
  });
  return {
    application: { id: application.id, name: application.name },
    membersIntent: ((application.flags ?? 0) & ((1 << 14) | (1 << 15))) !== 0,
    guilds: joined,
    declaredScope: mode.declaredScope,
    scopes: reports,
    clean: reports.every(
      (report) =>
        report.status === "read" &&
        !report.missing.length &&
        !report.unexpected.length &&
        !report.permissionMismatches.length,
    ),
  };
}

export type ClearResult =
  | {
      status: "dry_run";
      guild: string;
      fingerprint: string;
      commands: { id: string; name: string; version: string }[];
      confirm: string;
    }
  | { status: "already_empty"; guild: string }
  | { status: "cleared"; guild: string; removed: number; fingerprint: string };

/**
 * Clear one guild's command scope for this application. The checks run in this order, each before
 * any later read or write: the --application argument equals DISCORD_APPLICATION_ID; the token's
 * application equals both; the bot user belongs to the guild. An empty scope needs no write. Without
 * --confirm this is a dry run; a stale fingerprint is refused. Otherwise one bulk PUT of [] replaces
 * that guild scope, and a re-read must find it empty. The global scope is never touched.
 */
export async function clearGuildCommands(
  rest: CommandRest,
  applicationId: string,
  mode: { guild: string; application: string; confirm: string | null },
): Promise<ClearResult> {
  if (mode.application !== applicationId)
    throw new Failure(
      "configuration",
      `--application ${mode.application} does not match DISCORD_APPLICATION_ID ${applicationId}.`,
    );
  await authenticate(rest, applicationId);
  const guilds = guildsSchema.parse(await rest.get(Routes.userGuilds()));
  if (!guilds.some((guild) => guild.id === mode.guild))
    throw new Failure(
      "configuration",
      guilds.length >= GUILD_PAGE
        ? "The bot is in 200 or more guilds, so membership of this guild cannot be confirmed."
        : `The application is not in guild ${mode.guild}; clear-guild only clears guilds it belongs to.`,
    );
  const route = Routes.applicationGuildCommands(applicationId, mode.guild);
  const current = registeredSchema.parse(await rest.get(route));
  if (!current.length) return { status: "already_empty", guild: mode.guild };
  const fingerprint = scopeFingerprint(current);
  if (mode.confirm === null)
    return {
      status: "dry_run",
      guild: mode.guild,
      fingerprint,
      commands: current.map(({ id, name, version }) => ({ id, name, version })),
      confirm: `clear-guild ${mode.guild} --application ${applicationId} --confirm ${fingerprint}`,
    };
  if (mode.confirm !== fingerprint)
    throw new Failure("conflict", "Guild commands changed since review; rerun the dry run.");
  // Discord's bulk overwrite of this one guild scope: an empty list removes every command in it.
  await rest.put(route, { body: [] });
  const after = registeredSchema.parse(await rest.get(route));
  if (after.length)
    throw new Failure(
      "incomplete",
      `Guild ${mode.guild} still has ${after.length} commands after clearing; list it again.`,
    );
  return { status: "cleared", guild: mode.guild, removed: current.length, fingerprint };
}

/** The deployment guard's view of each mode (C7): list reads; clear-guild writes one guild scope. */
export function commandToolScope(mode: Mode) {
  return mode.kind === "list"
    ? {
        tool: "commands list",
        guilds: [],
        discord: "read" as const,
        databases: [],
      }
    : {
        tool: "commands clear-guild",
        guilds: [],
        commandGuilds: [mode.guild],
        discord: "write" as const,
        databases: [],
      };
}

/** This tool needs only the token and the application it belongs to (no DATABASE_URL). */
const settingsSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: idSchema,
});

/**
 * The whole CLI behind an injectable REST factory, so tests can drive the guard and every mode.
 * The guard runs before the REST client exists; the token is never printed. The token may come
 * from DISCORD_TOKEN_FILE (a Quadlet host's container), resolved into a copy of env.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  connect: (token: string) => CommandRest,
  launch?: Launch,
): Promise<{ deployment: Deployment; result: InventoryReport | ClearResult; exitCode: number }> {
  const mode = parseArguments(argv);
  const deployment = assertToolScope(env, commandToolScope(mode), launch);
  const parsed = settingsSchema.safeParse(resolveSettings(env));
  if (!parsed.success)
    throw new Failure(
      "configuration",
      `Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`,
    );
  const rest = connect(parsed.data.DISCORD_TOKEN);
  const application = parsed.data.DISCORD_APPLICATION_ID;
  if (mode.kind === "clear-guild")
    return { deployment, result: await clearGuildCommands(rest, application, mode), exitCode: 0 };
  const declared = [...(await loadCommands()).values()].map((command) => command.toJSON());
  const result = await inspectInventory(rest, application, declared, {
    guilds: mode.guilds,
    declaredScope: mode.declaredScope ?? deployment.registrationScope,
  });
  return { deployment, result, exitCode: result.clean ? 0 : 2 };
}

if (import.meta.main) {
  const { result, exitCode } = await run(process.argv.slice(2), process.env, (token) =>
    new REST({ version: "10" }).setToken(token),
  );
  console.log(json(result, 2));
  process.exitCode = exitCode;
}
