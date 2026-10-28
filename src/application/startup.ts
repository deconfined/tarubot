/**
 * Starting the image is the whole upgrade (2.46.0). Before it takes the writer lease the bot
 * applies its own pending migrations, taking an encrypted backup immediately before them; once it
 * is ready it registers its own commands (an unmanaged installation only where its
 * COMMAND_REGISTRATION setting says). Both used to be steps of a host-side delivery script, and
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
import { classifyFailure } from "../domain/failures.js";
import { Failure, idSchema } from "../domain/values.js";
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
 * How long the process waits after a failed startup migration before it exits. Docker restarts an
 * exited bot at once or within a minute (its back-off resets after any run of 10 s or more), and
 * every start that reaches pending files first stores a full pre-migration backup, so without a
 * pause a migration that fails on production's rows would upload a full dump (and ping
 * healthchecks.io) every minute or faster until someone rolls back. Ten minutes caps that at six an
 * hour and still retries on its own once a passing fault (a storage outage, a database restart)
 * clears.
 */
export const FAILED_MIGRATION_PAUSE_MS = 10 * 60_000;

/** The error line logged when the pause begins. */
export const FAILED_MIGRATION_PAUSED =
  "Startup migration failed; waiting before exiting, so a restart doesn't repeat it (and its pre-migration backup) at once";

/** Starts a one-shot timer; tests pass one they fire by hand. */
export type PauseTimer = (delayMs: number, done: () => void) => void;

/**
 * Deliberately ref'd, unlike the backup schedule's timers: once the lifecycle has stopped, nothing
 * else may hold the event loop open, and the process must stay up for the whole pause, never end
 * early with exit 0 and the failure unthrown.
 */
const refTimer: PauseTimer = (delayMs, done) => {
  setTimeout(done, delayMs);
};

/**
 * The failure path of migrateAtStartup in main.ts, whatever rejected (the deployment guard, the
 * pre-migration backup or a migration): called after main.ts has unbound the events and stopped
 * the lifecycle, so the pause holds no writer lease, transaction or connection (the migration's
 * one transaction has rolled back and the pool is closed). Logs one error line with the failure's
 * catalog code and class (and an approved Failure message, as the reporter logs it; never a
 * value), then resolves after `delayMs`, and main.ts rethrows so the process exits non-zero.
 * SIGTERM and SIGINT still end the pause at once: main.ts's handlers, installed before the
 * migration, call lifecycle.stop() again (it returns the same finished promise) and exit 0, so a
 * rolled-back tag's container swap or a `docker compose stop` is never held up.
 */
export async function pauseAfterFailedMigration(
  error: unknown,
  input: {
    log: (fields: Record<string, unknown>, message: string) => void;
    timer?: PauseTimer;
    delayMs?: number;
  },
): Promise<void> {
  const delayMs = input.delayMs ?? FAILED_MIGRATION_PAUSE_MS;
  const { code, source, failure } = classifyFailure(error);
  input.log(
    { code, source, diagnostic: failure?.message, pauseMinutes: delayMs / 60_000 },
    FAILED_MIGRATION_PAUSED,
  );
  await new Promise<void>((resolve) => (input.timer ?? refTimer)(delayMs, resolve));
}

/** The one info line an unmanaged installation logs while startup registration is off. */
export const REGISTRATION_OFF =
  "Startup command registration is off: set COMMAND_REGISTRATION to global or a server ID, or register with register.js";

/**
 * Where the bot registers, or null for nowhere. A managed profile always registers in its own
 * scope (production: global; staging and DevBot: the test guild) and ignores
 * COMMAND_REGISTRATION. An unmanaged installation registers only where COMMAND_REGISTRATION says:
 * `global`, a server (guild) ID, or `off`; empty or unset is off too. Before 2.46.0 self-hosters
 * registered by hand with register.js, some in one server with --guild, and registering globally
 * on their first 2.46.0 start would have shown every command there twice, so nothing is chosen for
 * them. As with register.js --global, `global` is refused while TEST_GUILD_ID is set. An invalid
 * value throws Failure("configuration") naming the setting, never its value.
 */
export function startupRegistrationScope(
  deployment: Deployment,
  env: Environment,
): RegistrationScope | null {
  if (deployment.name !== "unmanaged")
    return deployment.registrationScope === "global"
      ? { kind: "global" }
      : { kind: "guild", guild: deployment.registrationScope };
  const value = (env.COMMAND_REGISTRATION ?? "").trim();
  if (value === "" || value === "off") return null;
  if (value === "global") {
    if ((env.TEST_GUILD_ID ?? "").trim() !== "")
      throw new Failure(
        "configuration",
        "COMMAND_REGISTRATION=global is refused while TEST_GUILD_ID is set; development registers one guild scope.",
      );
    return { kind: "global" };
  }
  if (idSchema.safeParse(value).success) return { kind: "guild", guild: value };
  throw new Failure(
    "configuration",
    "COMMAND_REGISTRATION must be global, a server ID or off; startup command registration was skipped.",
  );
}

/**
 * Register the declared commands in this profile's scope with one bulk PUT, every start: the same
 * set overwritten again is a no-op, so there is nothing to compare first. The guard runs first,
 * exactly as for register.js (for a guild that refuses a managed deployment's own). Never rejects:
 * an invalid COMMAND_REGISTRATION, a refusal or a Discord error (2.45.0's delivery was stopped by
 * one) is reported, and the bot keeps running with whatever set Discord already holds. Discord's
 * registration rules (src/discord/registration-rules.ts) are never imported here; CI's
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
    if (scope === null) {
      input.log("info", {}, REGISTRATION_OFF);
      return;
    }
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
