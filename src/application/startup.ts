/**
 * Starting the image is the whole upgrade (2.46.0). Before it takes the writer lease the bot
 * applies its own pending migrations, taking an encrypted backup immediately before them; once it
 * is ready it registers its own commands. Both used to be steps of a host-side delivery script, and
 * an updater that only replaces the running container (Watchtower, a platform's redeploy) never
 * runs such steps, so they belong to the bot itself. migrate.js and register.js remain the manual
 * tools, and declare the same tool scopes to the deployment guard.
 */
import {
  assertToolScope,
  type Deployment,
  type Environment,
  type Launch,
  resolveDeployment,
  type ToolScope,
} from "../config/deployment.js";
import {
  type CommandRest,
  type DeclaredCommand,
  type RegistrationScope,
  registerCommands,
  registerToolScope,
} from "../discord/registration.js";
import type { Database, MigrationReport } from "../infrastructure/postgres/database.js";
import type { Backups, StoredBackup } from "./backups.js";
import type { Reporter } from "./reporting.js";

/** Structured log output, as the composition root's logger provides it. */
export type StartupLog = (
  level: "info" | "warn",
  fields: Record<string, unknown>,
  message: string,
) => void;

/**
 * The deployment guard's view of a migration: DATABASE_URL only, and a *_restore_test copy only
 * with migrate.js --restore-rehearsal. The bot's own migration declares it without the rehearsal.
 */
export function migrateToolScope(args: { restoreRehearsal: boolean }): ToolScope {
  return {
    tool: "migrate",
    guilds: [],
    discord: "none",
    databases: ["DATABASE_URL"],
    restoreRehearsal: args.restoreRehearsal,
  };
}

/**
 * Apply pending migrations as migrate.js does, after the same deployment guard: the database must
 * belong to this environment's profile before anything connects. Pending files take the writer
 * lease for their one transaction (a previous bot still stopping is waited for, up to 90 s), and
 * the pre-migration backup runs inside it (Backups.beforeMigration: production and staging refuse
 * to migrate without one). With nothing pending this is a checksum check and the lease is never
 * touched. A failure anywhere leaves the schema as it was and stops the start.
 */
export async function migrateAtStartup(input: {
  db: Pick<Database, "migrate">;
  backups: Pick<Backups, "beforeMigration">;
  env: Environment;
  log: StartupLog;
  launch?: Launch;
  directory?: string;
}): Promise<MigrationReport> {
  const deployment = assertToolScope(
    input.env,
    migrateToolScope({ restoreRehearsal: false }),
    input.launch,
  );
  const taken: { backup: StoredBackup | null } = { backup: null };
  const report = await input.db.migrate(input.directory ?? "migrations", {
    beforeApply: async (pending) => {
      taken.backup = await input.backups.beforeMigration(deployment.name, pending);
    },
  });
  // The lease time is the point-in-time restore point (no bot wrote after it), and the backup
  // taken under it is the other way back.
  if (report.applied.length)
    input.log(
      "info",
      {
        applied: report.applied,
        restorePoint: report.leaseAcquiredAt,
        committingAt: report.committingAt,
        backup: taken.backup?.daily.key ?? null,
      },
      "Migrations applied",
    );
  return report;
}

/**
 * Where the bot registers: a managed profile's own registration scope (production: global; staging
 * and DevBot: the test guild), and for unmanaged installations TEST_GUILD_ID's guild when set,
 * otherwise the global scope.
 */
export function startupRegistrationScope(
  deployment: Deployment,
  env: Environment,
): RegistrationScope {
  if (deployment.name !== "unmanaged")
    return deployment.registrationScope === "global"
      ? { kind: "global" }
      : { kind: "guild", guild: deployment.registrationScope };
  const guild = (env.TEST_GUILD_ID ?? "").trim();
  return guild ? { kind: "guild", guild } : { kind: "global" };
}

/**
 * Register the declared commands in this profile's scope with one bulk PUT, every start: the same
 * set overwritten again is a no-op, so there is nothing to compare first. The guard runs first,
 * exactly as for register.js. Never rejects: a refusal or a Discord error (2.45.0's delivery was
 * stopped by one) is reported, and the bot keeps running with whatever set Discord already holds.
 * Discord's registration rules (src/discord/registration-rules.ts) are never imported here; CI's
 * command-registration test is the check before merge.
 */
export async function registerAtStartup(input: {
  env: Environment;
  rest: CommandRest;
  applicationId: string;
  commands: readonly DeclaredCommand[];
  log: StartupLog;
  report: Reporter;
  launch?: Launch;
}): Promise<void> {
  try {
    const scope = startupRegistrationScope(resolveDeployment(input.env), input.env);
    assertToolScope(input.env, registerToolScope(scope), input.launch);
    const result = await registerCommands(input.rest, input.applicationId, scope, input.commands);
    input.log(
      "info",
      { scope: result.scope, roots: result.roots, paths: result.paths },
      "Commands registered",
    );
  } catch (error) {
    input.report(error, "command registration");
  }
}
