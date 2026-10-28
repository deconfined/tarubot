/**
 * The bot's own upgrade steps (2.46.0, src/application/startup.ts): migrating behind the deployment
 * guard and the pre-migration backup, and registering commands once ready in the profile's own
 * scope, where a refusal or a Discord error is reported and never stops the bot. Discord and the
 * database are doubles; tests/integration/migrations.test.ts runs the real migration hook.
 */
import { describe, expect, test } from "bun:test";
import { Routes } from "discord.js";
import {
  migrateAtStartup,
  registerAtStartup,
  startupRegistrationScope,
} from "../../src/application/startup.js";
import type { StoredBackup } from "../../src/application/backups.js";
import {
  deployments,
  type Environment,
  type Launch,
  resolveDeployment,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import type { CommandRest, DeclaredCommand } from "../../src/discord/registration.js";
import type {
  MigrateOptions,
  MigrationReport,
} from "../../src/infrastructure/postgres/database.js";

const PRODUCTION_APP = deployments.production.applicationId;
const DEVBOT_APP = deployments.devbot.applicationId;
const DEV_GUILD = deployments.devbot.guilds[0];
const OTHER_GUILD = "1111111111111111111";
const TOKEN = "sentinel-token-for-startup";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const container: Launch = { execArgv: [], envFiles: [] };

const productionEnv = (overrides: Environment = {}): Environment => ({
  TARUBOT_ENVIRONMENT: "production",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: PRODUCTION_APP,
  TEST_GUILD_ID: "",
  DATABASE_URL: "postgresql://tarubot:sentinel@primary.managed-db.example:27520/tarubot",
  DATABASE_CA_CERT: CA,
  ...overrides,
});
const stagingEnv = (): Environment => ({
  TARUBOT_ENVIRONMENT: "staging",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: DEVBOT_APP,
  TEST_GUILD_ID: DEV_GUILD,
  DATABASE_URL: `postgresql://${STAGING_DATABASE}:sentinel@primary.managed-db.example:27520/${STAGING_DATABASE}`,
  DATABASE_CA_CERT: CA,
});
const unmanagedEnv = (overrides: Environment = {}): Environment => ({
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: "222222222222222222",
  DATABASE_URL: "postgresql://tarubot:sentinel@postgres:5432/tarubot",
  ...overrides,
});

describe("startup registration scope", () => {
  test("a managed profile registers in its own scope; unmanaged follows TEST_GUILD_ID", () => {
    const scopeOf = (env: Environment) => startupRegistrationScope(resolveDeployment(env), env);
    expect(scopeOf(productionEnv())).toEqual({ kind: "global" });
    expect(scopeOf(stagingEnv())).toEqual({ kind: "guild", guild: DEV_GUILD });
    expect(scopeOf({ DISCORD_APPLICATION_ID: DEVBOT_APP, TEST_GUILD_ID: DEV_GUILD })).toEqual({
      kind: "guild",
      guild: DEV_GUILD,
    });
    expect(scopeOf(unmanagedEnv())).toEqual({ kind: "global" });
    expect(scopeOf(unmanagedEnv({ TEST_GUILD_ID: OTHER_GUILD }))).toEqual({
      kind: "guild",
      guild: OTHER_GUILD,
    });
  });
});

/** A recording Discord REST double; `failPut` makes the bulk PUT reject as Discord would. */
function rest(application: string, failPut = false) {
  const calls: string[] = [];
  const double: CommandRest = {
    get: async (route) => {
      calls.push(`GET ${route}`);
      return { id: application };
    },
    put: async (route, options) => {
      calls.push(`PUT ${route} ${options.body.length}`);
      if (failPut) throw new Error("Invalid Form Body");
      return [];
    },
  };
  return { rest: double, calls };
}
const declared: DeclaredCommand[] = [{ name: "ping" }, { name: "status" }];

function output() {
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  const reports: { error: unknown; operation: string }[] = [];
  return {
    logs,
    reports,
    log: (_level: "info" | "warn", fields: Record<string, unknown>, message: string) =>
      void logs.push({ message, fields }),
    report: (error: unknown, operation: string) => void reports.push({ error, operation }),
  };
}

describe("startup registration", () => {
  test("one bulk PUT of the declared set into the profile's scope, logged", async () => {
    const discord = rest(PRODUCTION_APP);
    const seen = output();
    await registerAtStartup({
      env: productionEnv(),
      rest: discord.rest,
      applicationId: PRODUCTION_APP,
      commands: declared,
      launch: container,
      ...seen,
    });
    expect(discord.calls).toEqual([
      `GET ${Routes.currentApplication()}`,
      `PUT ${Routes.applicationCommands(PRODUCTION_APP)} 2`,
    ]);
    expect(seen.reports).toEqual([]);
    expect(seen.logs).toEqual([
      { message: "Commands registered", fields: { scope: "global", roots: 2, paths: 2 } },
    ]);
    const staging = rest(DEVBOT_APP);
    await registerAtStartup({
      env: stagingEnv(),
      rest: staging.rest,
      applicationId: DEVBOT_APP,
      commands: declared,
      launch: container,
      ...output(),
    });
    expect(staging.calls.at(-1)).toBe(
      `PUT ${Routes.applicationGuildCommands(DEVBOT_APP, DEV_GUILD)} 2`,
    );
  });

  test("a Discord refusal is reported, never thrown, and the bot carries on", async () => {
    const discord = rest(PRODUCTION_APP, true);
    const seen = output();
    await registerAtStartup({
      env: productionEnv(),
      rest: discord.rest,
      applicationId: PRODUCTION_APP,
      commands: declared,
      launch: container,
      ...seen,
    });
    expect(seen.reports).toHaveLength(1);
    expect(seen.reports[0]?.operation).toBe("command registration");
    expect(seen.logs).toEqual([]);
  });

  test("the deployment guard runs first: a refusal is reported and Discord is never called", async () => {
    for (const env of [
      // Production never carries a test guild.
      productionEnv({ TEST_GUILD_ID: DEV_GUILD }),
      // Production credentials without the marker.
      unmanagedEnv({ DISCORD_APPLICATION_ID: PRODUCTION_APP }),
      // An unmanaged installation may not register into a managed deployment's guild.
      unmanagedEnv({ TEST_GUILD_ID: DEV_GUILD }),
    ]) {
      const discord = rest(PRODUCTION_APP);
      const seen = output();
      await registerAtStartup({
        env,
        rest: discord.rest,
        applicationId: PRODUCTION_APP,
        commands: declared,
        launch: container,
        ...seen,
      });
      expect(discord.calls).toEqual([]);
      expect(seen.reports.map((report) => report.operation)).toEqual(["command registration"]);
      expect(String(seen.reports[0]?.error)).not.toContain(TOKEN);
    }
  });
});

/** A Database double whose migrate() reports `pending` and runs the hook as the real one does. */
function database(pending: string[]) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      migrate: async (
        directory?: string,
        options: MigrateOptions = {},
      ): Promise<MigrationReport> => {
        calls.push(`migrate ${directory}`);
        if (!pending.length) return { applied: [], leaseAcquiredAt: null, committingAt: null };
        await options.beforeApply?.(pending);
        calls.push("applied");
        return {
          applied: pending,
          leaseAcquiredAt: "2026-10-28 03:00:00+00",
          committingAt: "2026-10-28 03:00:05+00",
        };
      },
    },
  };
}
const stored: StoredBackup = {
  stamp: "20261028T030000Z",
  daily: { key: "daily/tarubot-20261028T030000Z.dump.age", bytes: 9000 },
  monthly: null,
  env: { key: "env/tarubot-env-20261028T030000Z.age", bytes: 900 },
};

describe("startup migration", () => {
  test("pending files get the profile's pre-migration backup, and the restore point is logged", async () => {
    const { db, calls } = database(["016_next.sql"]);
    const seen = output();
    const backups: { profile: string; pending: readonly string[] }[] = [];
    await migrateAtStartup({
      db,
      backups: {
        beforeMigration: async (profile, pending) => {
          backups.push({ profile, pending });
          return stored;
        },
      },
      env: productionEnv(),
      log: seen.log,
      launch: container,
    });
    expect(backups).toEqual([{ profile: "production", pending: ["016_next.sql"] }]);
    expect(calls).toEqual(["migrate migrations", "applied"]);
    expect(seen.logs).toEqual([
      {
        message: "Migrations applied",
        fields: {
          applied: ["016_next.sql"],
          restorePoint: "2026-10-28 03:00:00+00",
          committingAt: "2026-10-28 03:00:05+00",
          backup: stored.daily.key,
        },
      },
    ]);
  });

  test("nothing pending: no backup and nothing logged", async () => {
    const { db } = database([]);
    const seen = output();
    let asked = false;
    await migrateAtStartup({
      db,
      backups: {
        beforeMigration: async () => {
          asked = true;
          return null;
        },
      },
      env: unmanagedEnv(),
      log: seen.log,
      launch: container,
    });
    expect(asked).toBe(false);
    expect(seen.logs).toEqual([]);
  });

  test("the deployment guard refuses before any connection, and a failed backup applies nothing", async () => {
    const refused = database(["016_next.sql"]);
    await expect(
      migrateAtStartup({
        db: refused.db,
        backups: { beforeMigration: async () => stored },
        // A local database is never production's.
        env: productionEnv({ DATABASE_URL: "postgresql://tarubot:x@localhost:5432/tarubot" }),
        log: () => {},
        launch: container,
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(refused.calls).toEqual([]);

    const failing = database(["016_next.sql"]);
    await expect(
      migrateAtStartup({
        db: failing.db,
        backups: {
          beforeMigration: async () => {
            throw new Error("backup failed");
          },
        },
        env: productionEnv(),
        log: () => {},
        launch: container,
      }),
    ).rejects.toThrow("backup failed");
    expect(failing.calls).toEqual(["migrate migrations"]);
  });
});
