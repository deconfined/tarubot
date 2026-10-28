/**
 * The bot's own upgrade steps (2.46.0, src/application/startup.ts): migrating behind the deployment
 * guard and the pre-migration backup, pausing before the exit after a failed migration, and
 * registering commands once ready in the profile's own scope (an unmanaged installation's
 * COMMAND_REGISTRATION), where a refusal or a Discord error is reported and never stops the bot.
 * Discord and the database are doubles; tests/integration/migrations.test.ts runs the real
 * migration hook, and the last test spawns main.ts itself.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Routes } from "discord.js";
import {
  FAILED_MIGRATION_PAUSE_MS,
  FAILED_MIGRATION_PAUSED,
  migrateAtStartup,
  pauseAfterFailedMigration,
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
import { Failure } from "../../src/domain/values.js";
import type {
  MigrateOptions,
  MigrationReport,
} from "../../src/infrastructure/postgres/database.js";

const PRODUCTION_APP = deployments.production.applicationId;
const PRODUCTION_GUILD = deployments.production.guilds[0];
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

const devbotEnv = (overrides: Environment = {}): Environment => ({
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: DEVBOT_APP,
  TEST_GUILD_ID: DEV_GUILD,
  DATABASE_URL: "postgresql://tarubot:sentinel@localhost:5432/tarubot_dev",
  ...overrides,
});
const rehearsalEnv = (overrides: Environment = {}): Environment =>
  productionEnv({
    TARUBOT_ENVIRONMENT: "rehearsal",
    DATABASE_URL: "postgresql://tarubot:sentinel@localhost:5432/tarubot_rehearsal",
    DATABASE_CA_CERT: "",
    ...overrides,
  });

/** Every COMMAND_REGISTRATION an operator might leave: unset, empty, each value, and nonsense. */
const REGISTRATION_VALUES = [
  undefined,
  "",
  "off",
  " off ",
  "global",
  OTHER_GUILD,
  "Global",
  "everywhere",
  "0123",
  `guild:${OTHER_GUILD}`,
] as const;
const withRegistration = (env: Environment, value: string | undefined): Environment =>
  value === undefined ? env : { ...env, COMMAND_REGISTRATION: value };

describe("startup registration scope", () => {
  const scopeOf = (env: Environment) => startupRegistrationScope(resolveDeployment(env), env);

  test("a managed profile always registers in its own scope and ignores COMMAND_REGISTRATION", () => {
    for (const value of REGISTRATION_VALUES) {
      expect(scopeOf(withRegistration(productionEnv(), value))).toEqual({ kind: "global" });
      // The rehearsal profile resolves production's scope; the guard then refuses the write.
      expect(scopeOf(withRegistration(rehearsalEnv(), value))).toEqual({ kind: "global" });
      expect(scopeOf(withRegistration(stagingEnv(), value))).toEqual({
        kind: "guild",
        guild: DEV_GUILD,
      });
      expect(scopeOf(withRegistration(devbotEnv(), value))).toEqual({
        kind: "guild",
        guild: DEV_GUILD,
      });
    }
  });

  test("unmanaged registers only where COMMAND_REGISTRATION says; empty or unset is off", () => {
    for (const testGuild of [undefined, "", OTHER_GUILD]) {
      const env = (value: string | undefined) =>
        withRegistration(
          unmanagedEnv(testGuild === undefined ? {} : { TEST_GUILD_ID: testGuild }),
          value,
        );
      // Self-hosters who registered by hand, maybe in one server with --guild, aren't given a
      // second, global set on upgrading; TEST_GUILD_ID alone chooses nothing either.
      for (const value of [undefined, "", "off", " off "]) expect(scopeOf(env(value))).toBeNull();
      expect(scopeOf(env(OTHER_GUILD))).toEqual({ kind: "guild", guild: OTHER_GUILD });
      expect(scopeOf(env(` ${OTHER_GUILD} `))).toEqual({ kind: "guild", guild: OTHER_GUILD });
      for (const value of ["Global", "everywhere", "0123", `guild:${OTHER_GUILD}`])
        expect(() => scopeOf(env(value))).toThrow(
          new Failure(
            "configuration",
            "COMMAND_REGISTRATION must be global, a server ID or off; startup command registration was skipped.",
          ),
        );
      // global, as register.js --global, is refused while TEST_GUILD_ID is set.
      if (testGuild === OTHER_GUILD)
        expect(() => scopeOf(env("global"))).toThrow(
          "COMMAND_REGISTRATION=global is refused while TEST_GUILD_ID is set",
        );
      else expect(scopeOf(env("global"))).toEqual({ kind: "global" });
    }
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

  test("unmanaged: COMMAND_REGISTRATION's scope, one info line while off, and a bad value reported", async () => {
    const UNMANAGED_APP = "222222222222222222";
    const run = async (env: Environment) => {
      const discord = rest(UNMANAGED_APP);
      const seen = output();
      await registerAtStartup({
        env,
        rest: discord.rest,
        applicationId: UNMANAGED_APP,
        commands: declared,
        launch: container,
        ...seen,
      });
      return { calls: discord.calls, ...seen };
    };
    // Off, empty or unset: nothing is sent, and one info line says how to turn it on.
    for (const env of [
      unmanagedEnv(),
      unmanagedEnv({ COMMAND_REGISTRATION: "" }),
      unmanagedEnv({ COMMAND_REGISTRATION: "off" }),
      unmanagedEnv({ TEST_GUILD_ID: OTHER_GUILD }),
    ]) {
      const { calls, logs, reports } = await run(env);
      expect(calls).toEqual([]);
      expect(reports).toEqual([]);
      expect(logs).toEqual([
        {
          message:
            "Startup command registration is off: set COMMAND_REGISTRATION to global or a server ID, or register with register.js",
          fields: {},
        },
      ]);
    }
    // global and a server ID: one bulk PUT there, through the guard.
    const global = await run(unmanagedEnv({ COMMAND_REGISTRATION: "global" }));
    expect(global.calls.at(-1)).toBe(`PUT ${Routes.applicationCommands(UNMANAGED_APP)} 2`);
    expect(global.logs).toEqual([
      { message: "Commands registered", fields: { scope: "global", roots: 2, paths: 2 } },
    ]);
    const guild = await run(
      unmanagedEnv({ COMMAND_REGISTRATION: OTHER_GUILD, TEST_GUILD_ID: OTHER_GUILD }),
    );
    expect(guild.calls.at(-1)).toBe(
      `PUT ${Routes.applicationGuildCommands(UNMANAGED_APP, OTHER_GUILD)} 2`,
    );
    expect(guild.reports).toEqual([]);
    // A bad value, or global beside TEST_GUILD_ID, is reported by name; Discord isn't called.
    for (const env of [
      unmanagedEnv({ COMMAND_REGISTRATION: "everywhere-sentinel" }),
      unmanagedEnv({ COMMAND_REGISTRATION: "global", TEST_GUILD_ID: OTHER_GUILD }),
    ]) {
      const { calls, logs, reports } = await run(env);
      expect(calls).toEqual([]);
      expect(logs).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.operation).toBe("command registration");
      const error = reports[0]?.error;
      expect(error).toBeInstanceOf(Failure);
      expect(error).toMatchObject({ code: "configuration" });
      const message = error instanceof Failure ? error.message : "";
      expect(message).toContain("COMMAND_REGISTRATION");
      expect(message).not.toContain("sentinel");
    }
  });

  test("managed profiles register in their own scope whatever COMMAND_REGISTRATION says", async () => {
    for (const value of ["off", "", OTHER_GUILD, "everywhere"]) {
      const discord = rest(PRODUCTION_APP);
      const seen = output();
      await registerAtStartup({
        env: productionEnv({ COMMAND_REGISTRATION: value }),
        rest: discord.rest,
        applicationId: PRODUCTION_APP,
        commands: declared,
        launch: container,
        ...seen,
      });
      expect(discord.calls.at(-1)).toBe(`PUT ${Routes.applicationCommands(PRODUCTION_APP)} 2`);
      expect(seen.reports).toEqual([]);
      const staging = rest(DEVBOT_APP);
      await registerAtStartup({
        env: { ...stagingEnv(), COMMAND_REGISTRATION: value },
        rest: staging.rest,
        applicationId: DEVBOT_APP,
        commands: declared,
        launch: container,
        ...output(),
      });
      expect(staging.calls.at(-1)).toBe(
        `PUT ${Routes.applicationGuildCommands(DEVBOT_APP, DEV_GUILD)} 2`,
      );
    }
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
      unmanagedEnv({ COMMAND_REGISTRATION: DEV_GUILD }),
      unmanagedEnv({ COMMAND_REGISTRATION: PRODUCTION_GUILD }),
      // A rehearsal is read-only on Discord.
      rehearsalEnv(),
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

  test("a failure is logged once at error, by code and never by value, then waits ten minutes", async () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const timers: { delayMs: number; done: () => void }[] = [];
    let settled = false;
    const paused = pauseAfterFailedMigration(new Error(`column "x" holds ${TOKEN}`), {
      log: (fields, message) => void lines.push({ fields, message }),
      timer: (delayMs, done) => void timers.push({ delayMs, done }),
    }).then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(FAILED_MIGRATION_PAUSE_MS).toBe(10 * 60_000);
    expect(timers.map((timer) => timer.delayMs)).toEqual([FAILED_MIGRATION_PAUSE_MS]);
    expect(settled).toBe(false);
    // Any error that is no Failure contributes its class name alone.
    expect(lines).toEqual([
      {
        fields: { code: "unexpected", source: "Error", diagnostic: undefined, pauseMinutes: 10 },
        message: FAILED_MIGRATION_PAUSED,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    timers[0]?.done();
    await paused;
    expect(settled).toBe(true);

    // A Failure (a guard refusal, a backup that failed at a stage) keeps its code and approved text.
    const failed: Record<string, unknown>[] = [];
    await pauseAfterFailedMigration(new Failure("backup", "Backup failed at: dump. Shutdown."), {
      log: (fields) => void failed.push(fields),
      timer: (_delay, done) => done(),
    });
    expect(failed).toEqual([
      {
        code: "backup",
        source: "Failure",
        diagnostic: "Backup failed at: dump. Shutdown.",
        pauseMinutes: 10,
      },
    ]);
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

/** A TCP port nothing listens on right now, for the spawned bot's health server. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
}

describe("main.ts after a failed startup migration", () => {
  // The real composition root, spawned: production settings whose database is local, so the
  // deployment guard refuses the migration before anything connects. No Discord, no database.
  test("pauses holding nothing, and SIGTERM or SIGINT still ends it at once with exit 0", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const port = freePort();
      // No .env in the working directory, so Bun loads none and the guard sees no env file.
      const cwd = mkdtempSync(join(tmpdir(), "tarubot-pause-"));
      const child = Bun.spawn(
        [process.execPath, fileURLToPath(new URL("../../src/main.ts", import.meta.url))],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: cwd,
            ...productionEnv({
              DATABASE_URL: "postgresql://tarubot:sentinel@localhost:5432/tarubot",
            }),
            HEALTH_PORT: String(port),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        // Read the log until the pause begins (or the process ends without one).
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const pauseLine = async () => {
          for (;;) {
            const line = text
              .split("\n")
              .filter((entry) => entry.startsWith("{"))
              .map((entry) => JSON.parse(entry) as Record<string, unknown>)
              .find((record) => record.msg === FAILED_MIGRATION_PAUSED);
            if (line) return line;
            const { done, value } = await reader.read();
            if (done) return null;
            text += decoder.decode(value, { stream: true });
          }
        };
        const line = await Promise.race([pauseLine(), Bun.sleep(60_000).then(() => null)]);
        expect(line).toMatchObject({ level: 50, code: "configuration", pauseMinutes: 10 });
        expect(JSON.stringify(line)).not.toContain("sentinel");
        // Still running a moment later, with the lifecycle stopped: its health server is closed.
        await Bun.sleep(500);
        expect(child.exitCode).toBeNull();
        expect(
          await fetch(`http://127.0.0.1:${port}/health/live`).then(
            () => "listening",
            () => "closed",
          ),
        ).toBe("closed");
        const sent = performance.now();
        child.kill(signal);
        expect(await child.exited).toBe(0);
        expect(performance.now() - sent).toBeLessThan(5_000);
        reader.releaseLock();
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
