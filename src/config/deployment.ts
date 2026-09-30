/**
 * Deployment-identity guard for maintenance tools. Before any Discord or database I/O, each tool
 * declares what it will touch; this pure module works out which deployment profile the environment
 * belongs to (production, prod, production rehearsal, staging, DevBot, or unmanaged) and refuses
 * mixed identities: a DevBot env aimed at the production guild, production credentials without an
 * explicit marker, a production, prod or staging run silently merged with a checkout's .env, or a
 * database belonging to another deployment. Errors are Failure("configuration") and name settings,
 * hosts and database names only, never a URL, password or token (OPS-05). The guard leaves env.ts
 * and the bot's startup configuration alone. It reads the file-delivered secrets (NAME_FILE,
 * 2.33.0) as the tools themselves do, through src/config/secrets.ts: in a Quadlet host's container
 * DATABASE_URL and DATABASE_CA_CERT exist only as files.
 *
 * The prod profile (2.37.0) is the production application on the new pipeline's host (the Deploy
 * workflow's prod job; ops/ansible/vars/targets/prod.yml), selected only by
 * TARUBOT_ENVIRONMENT=prod. It takes production's rules, the PITR-fork restore included, under the
 * prod names: its database is tarubot_prod (or the same-cluster restore tarubot_prod_restore) and
 * its role tarubot_prod. The owner renames production's database and role to those names inside
 * the cutover window. Until then the Compose host's production profile, with tarubot and
 * tarubot_restore, is unchanged; the cleanup release (2.38.0) removes it. Each refuses the other's
 * names.
 *
 * The rehearsal allowance (2.35.0, #46 answer 8): DEVBOT_THROWAWAY_GUILD_ID exists for @deconfined's
 * rehearsal of /setup overrides on a throwaway server, while DevBot's TEST_GUILD_ID points there.
 * It is environment-only, passed per tool run and never kept in env.ts, a Compose file or an env
 * template, so no new Discord ID enters the repository. Only the devbot profile takes it, and only
 * when TEST_GUILD_ID names the same server: production, prod, rehearsal, staging and unmanaged
 * refuse it, and so does a managed deployment's guild. Under it the throwaway replaces DevBot's
 * test guild as the profile's only guild and registration scope: that run can't use the real test
 * guild's data, and can't register or clear commands in any managed guild (commands.js list still
 * reads every scope back). The bot process never reads it; the running bot follows TEST_GUILD_ID
 * alone.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Failure } from "../domain/values.js";
import { resolveSettings, secretSetting } from "./secrets.js";

/**
 * Public Discord snowflakes (not credentials) owned by each managed deployment, and where each
 * registers its commands. A rotated application or a new guild is deliberately a code change.
 * Since 2.28.0 production's guild list also gates /suggest at runtime: a server outside it can't
 * post public suggestions, even if it invites the bot (src/application/suggestions.ts).
 * `production` is the production application's identity under both of its profiles, the Compose
 * host's production and the new pipeline's prod (2.37.0). The key keeps its name until the cleanup
 * release (2.38.0) renames it with the Compose path's removal.
 */
export const deployments = {
  production: {
    applicationId: "965294750741692416",
    guilds: ["1036062273631952955"],
    registrationScope: "global",
  },
  devbot: {
    applicationId: "943291473477128243",
    guilds: ["1040379370159743139"],
    registrationScope: "1040379370159743139",
  },
} as const;

/**
 * `production` is the production application on the Compose host, against `tarubot`, until 2.38.0;
 * `prod` (2.37.0) is the same application on the new pipeline's host, against `tarubot_prod`.
 * `rehearsal` is the production application against a disposable database, read-only on Discord.
 * `staging` (#50) is DevBot's application on the staging host, against its own database on the
 * managed cluster; `devbot` is the same application on the workstation's local database, until the
 * DevBot move retires it.
 */
export type DeploymentName =
  | "production"
  | "prod"
  | "rehearsal"
  | "staging"
  | "devbot"
  | "unmanaged";
export type DatabaseSetting = "DATABASE_URL" | "RESTORE_DATABASE_URL";

/** What one tool invocation will touch; the guard checks it before any I/O. */
export interface ToolScope {
  /** Tool name for messages, for example "import" or "commands clear-guild". */
  tool: string;
  /** Guilds whose data the tool reads or writes; each profile may touch only its own. */
  guilds: readonly string[];
  discord: "none" | "read" | "write";
  /** Database URLs the tool connects to. */
  databases: readonly DatabaseSetting[];
  /** True when the tool replaces the application's global command set. */
  globalCommands?: boolean;
  /**
   * register.js only: the scope it replaces, "global" or a guild ID. A managed profile registers
   * only in its own declared registrationScope (production and prod: global; staging and DevBot:
   * the test guild, or the throwaway server under DevBot's rehearsal allowance), so a production
   * --guild registration cannot shadow the global set with duplicate commands.
   */
  registerScope?: string;
  /**
   * migrate.js --restore-rehearsal only: DATABASE_URL names a disposable restore copy (ending in
   * _restore_test) on which a new migration is rehearsed before the live database. DevBot's
   * profile then accepts that copy in place of tarubot_dev; production, prod, rehearsal and staging
   * refuse it.
   */
  restoreRehearsal?: boolean;
  /**
   * Guilds whose command scope (the application's own commands) the tool clears. Any guild the
   * application belongs to is allowed, which the tool confirms after authenticating, except the
   * profile's own registration scope; unmanaged profiles, and DevBot under its rehearsal
   * allowance, still may not touch a known guild.
   */
  commandGuilds?: readonly string[];
}

/** How the process was started: Bun's execArgv and the auto-loaded env files present in its cwd. */
export interface Launch {
  execArgv: readonly string[];
  envFiles: readonly string[];
}

/** The resolved profile a tool runs under. */
export interface Deployment {
  name: DeploymentName;
  /** The application the profile expects (the configured one for unmanaged, possibly none). */
  applicationId: string | null;
  /** Guilds this profile owns; empty for unmanaged. */
  guilds: readonly string[];
  /** Where this profile registers commands: "global" or a guild ID. */
  registrationScope: string;
  /**
   * The throwaway server of DevBot's rehearsal allowance (DEVBOT_THROWAWAY_GUILD_ID), set only on
   * the devbot profile under it; it is then also the profile's only guild and registration scope.
   */
  readonly throwawayGuild?: string;
}

/**
 * Env files Bun loads automatically from the working directory (depending on NODE_ENV) when no
 * --env-file is given. `bun run` children reload them even when the parent had --env-file.
 */
export const AUTOLOADED_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
] as const;

/** The current process's launch facts. */
export function currentLaunch(cwd = process.cwd()): Launch {
  return {
    execArgv: process.execArgv,
    envFiles: AUTOLOADED_ENV_FILES.filter((file) => existsSync(join(cwd, file))),
  };
}

/**
 * Snowflake syntax only. The guard compares IDs as strings; idSchema's BigInt range refinement also
 * runs on non-numeric input under zod 4 and throws instead of reporting the setting.
 */
const snowflake = z.union([z.string().regex(/^[1-9][0-9]{0,19}$/), z.literal("")]);
/** Only the settings the guard needs; everything else in the environment is ignored. */
const settingsSchema = z.object({
  TARUBOT_ENVIRONMENT: z
    .enum(["production", "prod", "rehearsal", "staging", "devbot", ""])
    .optional(),
  DISCORD_APPLICATION_ID: snowflake.optional(),
  TEST_GUILD_ID: snowflake.optional(),
  PUBLIC_TEST_RESPONSES: z.string().optional(),
  TEST_PLAN_CHANNEL_ID: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  RESTORE_DATABASE_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  RESTORE_DATABASE_CA_CERT: z.string().optional(),
  /** The rehearsal allowance's throwaway server (see the module comment); empty means not set. */
  DEVBOT_THROWAWAY_GUILD_ID: snowflake.optional(),
});
type Settings = z.infer<typeof settingsSchema>;
/** process.env or a test double. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Validate the guard's settings, reporting setting names only (never values). File-delivered
 * secrets are resolved first, so the rules below see one DATABASE_URL and one DATABASE_CA_CERT
 * whichever form the environment used; setting both forms of one is refused.
 */
function settings(env: Environment): Settings {
  const result = settingsSchema.safeParse(resolveSettings(env));
  if (!result.success)
    throw new Failure(
      "configuration",
      `Invalid deployment settings: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}.`,
    );
  return result.data;
}

/** Unset, empty and whitespace-only values all mean "not configured". */
const present = (value: string | undefined): value is string => (value ?? "").trim() !== "";

/**
 * The profile, with DevBot's rehearsal allowance applied. The allowance is decided here rather than
 * per tool, so resolveDeployment refuses it exactly as assertToolScope does, and no profile other
 * than devbot is ever built from it.
 */
function profile(values: Settings): Deployment {
  const base = inferredProfile(values);
  const throwaway = present(values.DEVBOT_THROWAWAY_GUILD_ID)
    ? values.DEVBOT_THROWAWAY_GUILD_ID
    : null;
  if (throwaway === null) return base;
  // Only the local devbot profile takes the allowance. Production, prod, rehearsal, staging and
  // unmanaged refuse it outright instead of ignoring it, so it can never widen them: their guilds,
  // registration scope and database rules stay exactly the inferred ones, and an operator who
  // passed it to the wrong environment learns so before any I/O.
  if (base.name !== "devbot")
    throw new Failure(
      "configuration",
      `DEVBOT_THROWAWAY_GUILD_ID is DevBot's throwaway-server rehearsal allowance; leave it empty under the ${base.name} profile.`,
    );
  // A managed deployment's guild is never a throwaway. Production's guild would hand DevBot's tools
  // a production guild; the test guild already has its own profile without the allowance.
  if (knownGuilds.has(throwaway))
    throw new Failure(
      "configuration",
      "DEVBOT_THROWAWAY_GUILD_ID must be a throwaway server, not a managed deployment's guild.",
    );
  // The throwaway replaces the test guild rather than joining it: under the allowance the
  // application and database rules stay DevBot's, and every guild whose data a tool may use, or
  // whose command scope it may register or clear, is one no managed deployment owns.
  return {
    name: "devbot",
    applicationId: deployments.devbot.applicationId,
    guilds: [throwaway],
    registrationScope: throwaway,
    throwawayGuild: throwaway,
  };
}

/**
 * Pick the profile from the explicit marker, else infer it from the application ID. Staging shares
 * DevBot's application, so only its marker selects it, and the marker is checked before the
 * inference: DevBot's application ID alone always means the local devbot profile. Production and
 * prod share the production application, so each needs its own marker too: the application ID
 * alone selects neither.
 */
function inferredProfile(values: Settings): Deployment {
  const marker = values.TARUBOT_ENVIRONMENT || null;
  const application = values.DISCORD_APPLICATION_ID || null;
  const production = {
    applicationId: deployments.production.applicationId,
    guilds: deployments.production.guilds,
    registrationScope: deployments.production.registrationScope,
  };
  // DevBot's identity, which the staging profile uses as well: its application, its test guild,
  // and command registration in that guild only.
  const devbotIdentity = {
    applicationId: deployments.devbot.applicationId,
    guilds: deployments.devbot.guilds,
    registrationScope: deployments.devbot.registrationScope,
  };
  if (marker === "production" || marker === "prod" || marker === "rehearsal")
    return { name: marker, ...production };
  if (marker === "staging") return { name: "staging", ...devbotIdentity };
  if (marker === "devbot" || application === deployments.devbot.applicationId)
    return { name: "devbot", ...devbotIdentity };
  // Production credentials must say so explicitly: they come only from the production env file,
  // or from the prod host's settings (vars/targets/prod.yml), each of which sets the marker.
  if (application === deployments.production.applicationId)
    throw new Failure(
      "configuration",
      "Production credentials require TARUBOT_ENVIRONMENT=production, prod or rehearsal, from the production env file or the prod host's settings.",
    );
  return { name: "unmanaged", applicationId: application, guilds: [], registrationScope: "global" };
}

/** Resolve the deployment profile without checking a tool scope. */
export function resolveDeployment(env: Environment): Deployment {
  return profile(settings(env));
}

/** A database endpoint's identity: host, port, database and user, never the password. */
export interface DatabaseIdentity {
  host: string;
  port: number;
  name: string;
  user: string;
}

/**
 * Parse a PostgreSQL URL into its identity. Query parameters that could redirect the connection
 * away from the URL's own host, port, user or database are refused, so the checked identity is the
 * one node-postgres will use.
 */
export function databaseIdentity(url: string, setting = "DATABASE_URL"): DatabaseIdentity {
  const invalid = () => new Failure("configuration", `${setting} must be a PostgreSQL URL.`);
  let endpoint: URL;
  let name: string;
  let user: string;
  try {
    endpoint = new URL(url);
    name = decodeURIComponent(endpoint.pathname.replace(/^\//, ""));
    user = decodeURIComponent(endpoint.username);
  } catch {
    // Parser diagnostics can echo the password; report the setting only.
    throw invalid();
  }
  if (!["postgres:", "postgresql:"].includes(endpoint.protocol)) throw invalid();
  for (const key of ["host", "hostaddr", "port", "user", "dbname", "database"])
    if (endpoint.searchParams.has(key))
      throw new Failure(
        "configuration",
        `${setting} must give its host, port, user and database in the URL itself, not a ${key} parameter.`,
      );
  const host = endpoint.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!host || !name || name.includes("/"))
    throw new Failure("configuration", `${setting} must name its host and database explicitly.`);
  return { host, port: endpoint.port ? Number(endpoint.port) : 5432, name, user };
}

/**
 * Hosts on this machine or inside the Compose network: loopback, the Compose `postgres` service and
 * Docker's host alias. Anything else is treated as a managed (remote) cluster.
 */
export function localDatabaseHost(host: string): boolean {
  return (
    ["localhost", "postgres", "host.docker.internal", "::1", "0.0.0.0", "::"].includes(host) ||
    host.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The CA check-restore uses for RESTORE_DATABASE_URL: its own when set (a PITR fork can have a new
 * CA), otherwise DATABASE_CA_CERT, read from DATABASE_CA_CERT_FILE when that is how it arrives. An
 * empty RESTORE_DATABASE_CA_CERT line (as in the env templates) falls back too, so it can never
 * silently drop certificate verification. The RESTORE_* settings have no file form: a restore
 * check is an operator's run from a settings file, never a Quadlet unit's.
 */
export function restoreCertificate(env: Environment): string | undefined {
  return present(env.RESTORE_DATABASE_CA_CERT)
    ? env.RESTORE_DATABASE_CA_CERT
    : secretSetting(env, "DATABASE_CA_CERT");
}

/**
 * Managed clusters' direct (session) ports. Production has used Linode managed PostgreSQL since
 * 2026-09-24, and its direct port is 27520. The cluster's connection pool (27521) runs in
 * transaction mode, which breaks session advisory locks and the writer lease, so it is refused like
 * any other port. 2.30.1 dropped the deleted DigitalOcean cluster's port.
 */
export const MANAGED_DIRECT_PORTS: readonly number[] = [27520];

/** The provider's administrator login (Linode); tools connect as the application user. */
export const MANAGED_ADMIN_USERS: readonly string[] = ["akmadmin"];

/**
 * The databases production's tools may use as DATABASE_URL: the live `tarubot`, or
 * `tarubot_restore` after docs/HOSTING.md "Restoring a dump" repoints the bot at a same-cluster
 * restore. (A PITR fork is a new cluster that holds `tarubot`.) Anything else, staging's database
 * included, is refused.
 */
export const PRODUCTION_DATABASES: readonly string[] = ["tarubot", "tarubot_restore"];

/**
 * The prod profile's databases (2.37.0), as production's above under the prod names: the live
 * `tarubot_prod`, or `tarubot_prod_restore` after a same-cluster restore the bot was repointed at
 * (a PITR fork is a new cluster that holds `tarubot_prod`). Production's `tarubot` and
 * `tarubot_restore` are refused, and so is staging's database.
 */
export const PROD_DATABASES: readonly string[] = ["tarubot_prod", "tarubot_prod_restore"];

/** The role the prod profile connects as (2.37.0); the owner renames `tarubot` to it at cutover. */
export const PROD_ROLE = "tarubot_prod";

/**
 * Staging's database and the role it connects as (#50), on the same managed cluster as production.
 * Both are exactly this name, and the role owns its database. The production application refuses
 * every database or user whose name starts with it, so a staging URL never passes as production's.
 */
export const STAGING_DATABASE = "tarubot_staging";

/** A --env-file (or --no-env-file) flag means Bun did not auto-load the working directory's files. */
const envFileFlag = (argument: string): boolean =>
  argument === "--env-file" || argument.startsWith("--env-file=") || argument === "--no-env-file";

/** Guilds owned by any managed deployment. */
const knownGuilds = new Set<string>([
  ...deployments.production.guilds,
  ...deployments.devbot.guilds,
]);

/**
 * Check a tool invocation against its deployment profile and return the profile. Call it once,
 * after argument parsing and before constructing a Database or logging in to Discord.
 */
export function assertToolScope(
  env: Environment,
  scope: ToolScope,
  launch: Launch = currentLaunch(),
): Deployment {
  const values = settings(env);
  const deployment = profile(values);
  const { name } = deployment;
  const refuse = (reason: string) =>
    new Failure("configuration", `Refusing ${scope.tool} under the ${name} profile: ${reason}`);
  /** Profiles that run the production application: production and prod, and a rehearsal. */
  const productionApp = name === "production" || name === "prod" || name === "rehearsal";
  /** Profiles that run DevBot's application: staging on its host, devbot on the workstation. */
  const devbotApp = name === "staging" || name === "devbot";
  const application = values.DISCORD_APPLICATION_ID || null;
  /**
   * The rehearsal allowance's throwaway server, or null. profile() sets it on the devbot profile
   * only; reading it only there as well keeps staging's checks on the test guild whatever the
   * Deployment object carries.
   */
  const throwaway = name === "devbot" ? (deployment.throwawayGuild ?? null) : null;

  // Launch: `bun run` children and plain `bun` reload the checkout's env files, which would fill
  // any gap in the production, prod or staging settings with development values. Containers have
  // none of these; staging's and prod's tools run in the bot's container on their hosts.
  if (
    (productionApp || name === "staging") &&
    launch.envFiles.length &&
    !launch.execArgv.some(envFileFlag)
  )
    throw refuse(
      `${launch.envFiles.join(", ")} in the working directory would be merged into this run. Start it as bun --env-file=PATH dist/scripts/<tool>.js, never with bun run.`,
    );

  // Identity: the configured application must be the profile's.
  if (
    productionApp &&
    (application !== null || scope.discord !== "none") &&
    application !== deployments.production.applicationId
  )
    throw refuse(
      `DISCORD_APPLICATION_ID must be the production application ${deployments.production.applicationId}.`,
    );
  if (devbotApp && application !== deployments.devbot.applicationId)
    throw refuse(
      `DISCORD_APPLICATION_ID must be DevBot's application ${deployments.devbot.applicationId}.`,
    );

  // Test scope: production and prod never carry development scoping; DevBot's application always
  // does, on staging too. Staging may show replies publicly and name its test-plan channel, like
  // DevBot.
  if (productionApp) {
    if (present(values.TEST_GUILD_ID)) throw refuse("TEST_GUILD_ID must be empty.");
    if (values.PUBLIC_TEST_RESPONSES?.trim() === "true")
      throw refuse("PUBLIC_TEST_RESPONSES must not be true.");
    if (present(values.TEST_PLAN_CHANNEL_ID)) throw refuse("TEST_PLAN_CHANNEL_ID must be empty.");
  }
  // Under the rehearsal allowance DevBot's TEST_GUILD_ID must name the same throwaway, so the tool
  // and the bot it maintains agree on the server; that swaps the test guild for the throwaway and
  // adds no guild. Staging (throwaway is always null there) and plain devbot keep the test guild.
  if (devbotApp && values.TEST_GUILD_ID !== (throwaway ?? deployments.devbot.guilds[0]))
    throw refuse(
      throwaway === null
        ? `TEST_GUILD_ID must be DevBot's test guild ${deployments.devbot.guilds[0]}.`
        : `TEST_GUILD_ID must equal DEVBOT_THROWAWAY_GUILD_ID (${throwaway}) for a throwaway-server rehearsal.`,
    );

  // Guilds: each managed profile touches only its own; unmanaged touches none of them.
  for (const guild of scope.guilds) {
    if (name === "unmanaged" ? knownGuilds.has(guild) : !deployment.guilds.includes(guild))
      throw refuse(
        name === "unmanaged"
          ? `guild ${guild} belongs to a managed deployment; use that deployment's profile.`
          : `guild ${guild} is not one of this profile's guilds (${deployment.guilds.join(", ")}).`,
      );
  }
  for (const guild of scope.commandGuilds ?? []) {
    if (guild === deployment.registrationScope)
      throw refuse(
        `guild ${guild} holds this profile's own command registration; replace it with register.js instead.`,
      );
    if (name === "unmanaged" && knownGuilds.has(guild))
      throw refuse(
        `guild ${guild} belongs to a managed deployment; use that deployment's profile.`,
      );
    // Under the rehearsal allowance the test guild is no longer this profile's own registration,
    // so the own-registration rule no longer protects it; this one keeps every managed guild's
    // command scope, the test guild's included, out of the rehearsal's reach.
    if (throwaway !== null && knownGuilds.has(guild))
      throw refuse(
        `guild ${guild} belongs to a managed deployment; the throwaway-server rehearsal never touches it.`,
      );
  }

  // Commands and Discord writes. Staging writes to Discord like DevBot, in the test guild only.
  if (scope.globalCommands && (devbotApp || name === "rehearsal"))
    throw refuse("global command registration belongs to the production and prod profiles.");
  if (name === "rehearsal" && scope.discord === "write")
    throw refuse("a rehearsal is read-only on Discord.");
  if (
    scope.registerScope !== undefined &&
    name !== "unmanaged" &&
    scope.registerScope !== deployment.registrationScope
  )
    throw refuse(
      `this profile registers commands only in ${deployment.registrationScope === "global" ? "the global scope (--global)" : `guild ${deployment.registrationScope}`}.`,
    );

  // A restore-copy migration rehearsal is DevBot's (and unmanaged installations') procedure; the
  // production application rehearses migrations in its *_rehearsal database (docs/MIGRATION.md E2),
  // under production, prod and rehearsal alike.
  if (scope.restoreRehearsal && productionApp)
    throw refuse(
      "--restore-rehearsal is DevBot's restore-copy rehearsal; the production application rehearses in a *_rehearsal database.",
    );
  // Staging has no restore target: it resets in place, and its role can't create databases. So
  // neither a restore-copy rehearsal nor check-restore's second database has a staging procedure.
  if (name === "staging" && scope.restoreRehearsal)
    throw refuse(
      `--restore-rehearsal has no staging procedure; staging migrates ${STAGING_DATABASE} itself.`,
    );
  if (name === "staging" && scope.databases.includes("RESTORE_DATABASE_URL"))
    throw refuse(
      `RESTORE_DATABASE_URL has no staging procedure; staging resets ${STAGING_DATABASE} in place.`,
    );

  for (const setting of scope.databases) checkDatabase(deployment, setting, values, refuse, scope);
  return deployment;
}

/** Apply the profile's database rules to one URL setting. */
function checkDatabase(
  deployment: Deployment,
  setting: DatabaseSetting,
  values: Settings,
  refuse: (reason: string) => Failure,
  scope: ToolScope,
): void {
  const url = values[setting];
  if (!present(url)) throw refuse(`${setting} is required.`);
  const target = databaseIdentity(url, setting);
  const primary = setting === "DATABASE_URL";
  const ca = primary ? values.DATABASE_CA_CERT : restoreCertificate(values);
  const caSetting = primary ? "DATABASE_CA_CERT" : "RESTORE_DATABASE_CA_CERT or DATABASE_CA_CERT";
  const where = `${setting} (${target.host}/${target.name})`;
  const local = localDatabaseHost(target.host);
  const restoreCopy = target.name.endsWith("_restore_test");
  // --restore-rehearsal declares a disposable copy, so it can never be aimed at a live database.
  const rehearsingOnCopy = primary && scope.restoreRehearsal === true;
  if (rehearsingOnCopy && !restoreCopy)
    throw refuse(`${where} must name a disposable *_restore_test copy with --restore-rehearsal.`);
  /** Managed clusters: verified TLS, the direct port and an application user. */
  const managed = () => {
    if (!present(ca)) throw refuse(`${caSetting} must hold the managed cluster's CA certificate.`);
    if (!MANAGED_DIRECT_PORTS.includes(target.port))
      throw refuse(
        `${where} must use the managed cluster's direct port ${MANAGED_DIRECT_PORTS.join(" or ")} (never its 27521 pool or any other port).`,
      );
    if (!target.user || MANAGED_ADMIN_USERS.includes(target.user))
      throw refuse(
        `${where} must connect as the application user, not an administrator (${MANAGED_ADMIN_USERS.join(", ")}).`,
      );
  };

  // A restore check compares two databases, so the restore target is never the primary itself.
  let source: DatabaseIdentity | null = null;
  if (!primary) {
    if (!present(values.DATABASE_URL)) throw refuse("DATABASE_URL is required.");
    source = databaseIdentity(values.DATABASE_URL, "DATABASE_URL");
    if (source.host === target.host && source.port === target.port && source.name === target.name)
      throw refuse("RESTORE_DATABASE_URL must be a different database from DATABASE_URL.");
  }

  // The production application never touches staging's database or role, whichever its profile
  // (production, prod or rehearsal): they share a cluster, so the name is what tells them apart.
  if (
    (deployment.name === "production" ||
      deployment.name === "prod" ||
      deployment.name === "rehearsal") &&
    (target.name.startsWith(STAGING_DATABASE) || target.user.startsWith(STAGING_DATABASE))
  )
    throw refuse(`${where} belongs to staging (${STAGING_DATABASE}), never to production.`);

  switch (deployment.name) {
    case "production": {
      if (local) throw refuse(`${where} is local; production uses the managed cluster.`);
      managed();
      if (target.user !== "tarubot") throw refuse(`${where} must connect as the tarubot user.`);
      if (source === null) {
        // The live database, or the same-cluster restore the bot was repointed at.
        if (!PRODUCTION_DATABASES.includes(target.name))
          throw refuse(
            `${where} is not a production database (${PRODUCTION_DATABASES.join(" or ")}).`,
          );
      } else {
        // A PITR fork is a new cluster holding `tarubot`; a same-cluster restore is `tarubot_restore`.
        const expected = source.host === target.host ? "tarubot_restore" : "tarubot";
        if (target.name !== expected)
          throw refuse(
            `${where} must be tarubot on a PITR fork (another host) or tarubot_restore on the primary's host.`,
          );
      }
      return;
    }
    case "prod": {
      // Production's rules under the prod names (2.37.0): the managed cluster over verified TLS,
      // the direct port, and exactly the prod role. Production's tarubot and tarubot_restore fail
      // the exact lists below, as staging's names fail them (and the refusal above).
      if (local) throw refuse(`${where} is local; prod uses the managed cluster.`);
      managed();
      if (target.user !== PROD_ROLE)
        throw refuse(`${where} must connect as the ${PROD_ROLE} user.`);
      if (source === null) {
        // The live database, or the same-cluster restore the bot was repointed at.
        if (!PROD_DATABASES.includes(target.name))
          throw refuse(`${where} is not a prod database (${PROD_DATABASES.join(" or ")}).`);
      } else {
        // A PITR fork is a new cluster holding tarubot_prod; a same-cluster restore is
        // tarubot_prod_restore.
        const expected = source.host === target.host ? "tarubot_prod_restore" : "tarubot_prod";
        if (target.name !== expected)
          throw refuse(
            `${where} must be tarubot_prod on a PITR fork (another host) or tarubot_prod_restore on the primary's host.`,
          );
      }
      return;
    }
    case "rehearsal": {
      const suffix = primary ? "_rehearsal" : "_restore_test";
      if (!target.name.endsWith(suffix))
        throw refuse(`${where} must name a disposable *${suffix} database.`);
      if (!local) managed();
      return;
    }
    case "staging": {
      // Only the primary reaches this point (assertToolScope refuses RESTORE_DATABASE_URL): the
      // managed cluster over verified TLS, and exactly staging's own database and role, so a
      // staging run can never reach production's tarubot or tarubot_restore.
      if (local) throw refuse(`${where} is local; staging uses the managed cluster.`);
      managed();
      if (target.name !== STAGING_DATABASE)
        throw refuse(`${where} must be staging's database ${STAGING_DATABASE}.`);
      if (target.user !== STAGING_DATABASE)
        throw refuse(`${where} must connect as the ${STAGING_DATABASE} user.`);
      return;
    }
    case "devbot": {
      if (!local) throw refuse(`${where} must be DevBot's local database (localhost or postgres).`);
      if (present(ca)) throw refuse(`${caSetting} must be empty for DevBot's local database.`);
      // The primary is exactly tarubot_dev, except that migrate.js --restore-rehearsal migrates the
      // restore copy first (site/src/content/docs/deploy/operations.md); the suffix was checked
      // above.
      if (primary ? target.name !== "tarubot_dev" && !rehearsingOnCopy : !restoreCopy)
        throw refuse(
          primary
            ? `${where} must be DevBot's database tarubot_dev (or, for migrate.js --restore-rehearsal, a *_restore_test copy).`
            : `${where} must name a disposable *_restore_test database.`,
        );
      return;
    }
    case "unmanaged":
      // CI and other developers: no deployment-specific database. (The production, prod and
      // staging hosts' containers set TARUBOT_ENVIRONMENT, so their tools get their own profile's
      // rules.)
      return;
  }
}

/**
 * After login, the token's application must be the profile's. Unmanaged runs may not use a
 * managed deployment's token under a missing or different application ID.
 */
export function assertAuthenticatedApplication(
  deployment: Deployment,
  authenticatedId: string | null | undefined,
): void {
  if (!authenticatedId)
    throw new Failure("configuration", "Discord did not report the authenticated application.");
  const known = [
    deployments.production.applicationId,
    deployments.devbot.applicationId,
  ] as string[];
  if (deployment.name === "unmanaged" && known.includes(authenticatedId))
    throw new Failure(
      "configuration",
      `The token belongs to managed application ${authenticatedId}; use that deployment's profile.`,
    );
  if (deployment.applicationId !== null && authenticatedId !== deployment.applicationId)
    throw new Failure(
      "configuration",
      `The token belongs to application ${authenticatedId}, not ${deployment.applicationId}.`,
    );
}
