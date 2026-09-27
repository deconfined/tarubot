/**
 * Deployment-identity guard for maintenance tools. Before any Discord or database I/O, each tool
 * declares what it will touch; this pure module works out which deployment profile the environment
 * belongs to (production, production rehearsal, staging, DevBot, or unmanaged) and refuses mixed
 * identities: a DevBot env aimed at the production guild, production credentials without an
 * explicit marker, a production or staging run silently merged with a checkout's .env, or a
 * database belonging to another deployment. Errors are Failure("configuration") and name settings,
 * hosts and database names only, never a URL, password or token (OPS-05). The guard leaves env.ts
 * and the bot's startup configuration alone. It reads the file-delivered secrets (NAME_FILE,
 * 2.33.0) as the tools themselves do, through src/config/secrets.ts: in a Quadlet host's container
 * DATABASE_URL and DATABASE_CA_CERT exist only as files.
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
 * `rehearsal` is the production application against a disposable database, read-only on Discord.
 * `staging` (#50) is DevBot's application on the staging host, against its own database on the
 * managed cluster; `devbot` is the same application on the workstation's local database, until the
 * DevBot move retires it.
 */
export type DeploymentName = "production" | "rehearsal" | "staging" | "devbot" | "unmanaged";
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
   * only in its own declared registrationScope (production: global; staging and DevBot: the test
   * guild), so a production --guild registration cannot shadow the global set with duplicate
   * commands.
   */
  registerScope?: string;
  /**
   * migrate.js --restore-rehearsal only: DATABASE_URL names a disposable restore copy (ending in
   * _restore_test) on which a new migration is rehearsed before the live database. DevBot's
   * profile then accepts that copy in place of tarubot_dev; production, rehearsal and staging
   * refuse it.
   */
  restoreRehearsal?: boolean;
  /**
   * Guilds whose command scope (the application's own commands) the tool clears. Any guild the
   * application belongs to is allowed, which the tool confirms after authenticating, except the
   * profile's own registration scope; unmanaged profiles still may not touch a known guild.
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
  TARUBOT_ENVIRONMENT: z.enum(["production", "rehearsal", "staging", "devbot", ""]).optional(),
  DISCORD_APPLICATION_ID: snowflake.optional(),
  TEST_GUILD_ID: snowflake.optional(),
  PUBLIC_TEST_RESPONSES: z.string().optional(),
  TEST_PLAN_CHANNEL_ID: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  RESTORE_DATABASE_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  RESTORE_DATABASE_CA_CERT: z.string().optional(),
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
 * Pick the profile from the explicit marker, else infer it from the application ID. Staging shares
 * DevBot's application, so only its marker selects it, and the marker is checked before the
 * inference: DevBot's application ID alone always means the local devbot profile.
 */
function profile(values: Settings): Deployment {
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
  if (marker === "production" || marker === "rehearsal") return { name: marker, ...production };
  if (marker === "staging") return { name: "staging", ...devbotIdentity };
  if (marker === "devbot" || application === deployments.devbot.applicationId)
    return { name: "devbot", ...devbotIdentity };
  // Production credentials must say so explicitly: they come only from the production env file.
  if (application === deployments.production.applicationId)
    throw new Failure(
      "configuration",
      "Production credentials require TARUBOT_ENVIRONMENT=production or rehearsal from the production env file.",
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
  const productionApp = name === "production" || name === "rehearsal";
  /** Profiles that run DevBot's application: staging on its host, devbot on the workstation. */
  const devbotApp = name === "staging" || name === "devbot";
  const application = values.DISCORD_APPLICATION_ID || null;

  // Launch: `bun run` children and plain `bun` reload the checkout's env files, which would fill
  // any gap in the production or staging settings with development values. Containers have none
  // of these; staging's tools run in the bot's container on its host.
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

  // Test scope: production never carries development scoping; DevBot's application always does,
  // on staging too. Staging may show replies publicly and name its test-plan channel, like DevBot.
  if (productionApp) {
    if (present(values.TEST_GUILD_ID)) throw refuse("TEST_GUILD_ID must be empty.");
    if (values.PUBLIC_TEST_RESPONSES?.trim() === "true")
      throw refuse("PUBLIC_TEST_RESPONSES must not be true.");
    if (present(values.TEST_PLAN_CHANNEL_ID)) throw refuse("TEST_PLAN_CHANNEL_ID must be empty.");
  }
  if (devbotApp && values.TEST_GUILD_ID !== deployments.devbot.guilds[0])
    throw refuse(`TEST_GUILD_ID must be DevBot's test guild ${deployments.devbot.guilds[0]}.`);

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
  }

  // Commands and Discord writes. Staging writes to Discord like DevBot, in the test guild only.
  if (scope.globalCommands && (devbotApp || name === "rehearsal"))
    throw refuse("global command registration belongs to the production profile.");
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
  // production application rehearses migrations in its *_rehearsal database (docs/MIGRATION.md E2).
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

  // The production application never touches staging's database or role, whichever its profile:
  // they share a cluster, so the name is what tells them apart.
  if (
    (deployment.name === "production" || deployment.name === "rehearsal") &&
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
      // CI and other developers: no deployment-specific database. (The production and staging
      // hosts' containers set TARUBOT_ENVIRONMENT, so their tools get their own profile's rules.)
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
