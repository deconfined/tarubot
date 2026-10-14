/**
 * The candidate check (scripts/candidate-check.ts) that a delivery runs in the new image before it
 * stops anything: each of its four parts, the order failures are named in, that the problem text
 * never carries a setting's value, and one run of the script itself the way the image runs it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationCommandOptionType } from "discord.js";
import {
  type CandidateInputs,
  candidateArguments,
  candidateCheck,
} from "../../scripts/candidate-check.js";
import { project } from "../../src/config/project.js";
import { type Environment, deployments, STAGING_DATABASE } from "../../src/config/deployment.js";
import type { RegistrableCommand } from "../../src/discord/registration-rules.js";
import { SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";

// A spawned Bun loads every module, slowly under QEMU in the arm64 image build.
setDefaultTimeout(120_000);

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts/candidate-check.ts");
const PASSWORD = "invented-password-for-tests";
const TOKEN = "invented-token-for-tests";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";

/** A filled-in production environment, as the host's central settings give the service. */
const productionEnv = (overrides: Environment = {}): Environment => ({
  TARUBOT_ENVIRONMENT: "production",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: deployments.production.applicationId,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: "false",
  TEST_PLAN_CHANNEL_ID: "",
  DATABASE_URL: `postgresql://tarubot:${PASSWORD}@primary.managed-db.example:27520/tarubot?sslmode=require`,
  DATABASE_CA_CERT: CA,
  ...overrides,
});

/** A filled-in staging environment: DevBot's application, its guild and its own database. */
const stagingEnv = (): Environment => ({
  TARUBOT_ENVIRONMENT: "staging",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
  TEST_GUILD_ID: deployments.devbot.guilds[0],
  PUBLIC_TEST_RESPONSES: "true",
  TEST_PLAN_CHANNEL_ID: "",
  DATABASE_URL: `postgresql://${STAGING_DATABASE}:${PASSWORD}@primary.managed-db.example:27520/${STAGING_DATABASE}?sslmode=require`,
  DATABASE_CA_CERT: CA,
});

const text = ApplicationCommandOptionType.String;
const subcommand = ApplicationCommandOptionType.Subcommand;
const option = (name: string, required: boolean) => ({
  name,
  description: name,
  type: text,
  required,
});
const moderate = (options: ReturnType<typeof option>[]): RegistrableCommand => ({
  name: "moderate",
  description: "Moderation tools",
  options: [{ name: "block", description: "Pause a feature", type: subcommand, options }],
});

/** A candidate that passes every part, with each piece replaceable. */
function inputs(overrides: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    version: project.version,
    schema: SCHEMA_VERSION,
    scopeArguments: ["--global"],
    env: productionEnv(),
    launch: { execArgv: [], envFiles: [] },
    built: { version: project.version, schema: SCHEMA_VERSION },
    migrations: async () => readdirSync(join(root, "migrations")),
    commands: async () => [moderate([option("member", true), option("reason", true)])],
    modules: async () => undefined,
    ...overrides,
  };
}

describe("candidate check arguments", () => {
  test("take the version, the schema file and the register.js scope arguments", () => {
    expect(candidateArguments(["2.46.0", "016_x.sql", "--global"])).toEqual({
      version: "2.46.0",
      schema: "016_x.sql",
      scopeArguments: ["--global"],
    });
    expect(
      candidateArguments(["2.46.0", "016_x.sql", "--guild", deployments.devbot.guilds[0]]),
    ).toEqual({
      version: "2.46.0",
      schema: "016_x.sql",
      scopeArguments: ["--guild", deployments.devbot.guilds[0]],
    });
  });

  test("refuse anything else before any work", () => {
    for (const argv of [
      [],
      ["2.46", "016_x.sql", "--global"],
      ["2.46.0", "x.sql", "--global"],
      ["2.46.0", "016_x.sql"],
      ["2.46.0", "016_x.sql", "--global", "--clear"],
      ["2.46.0", "016_x.sql", "--global", "--guild", deployments.devbot.guilds[0]],
    ])
      expect(() => candidateArguments(argv)).toThrow();
  });
});

describe("candidate check parts", () => {
  test("a candidate that is what was asked for passes every part", async () => {
    const { report, problems } = await candidateCheck(inputs());
    expect(problems).toEqual([]);
    expect(report).toEqual({
      check: "ok",
      identity: true,
      config: true,
      modules: true,
      registration: true,
    });
  });

  test("the real command set, modules and migrations of this checkout pass", async () => {
    const { loadCommands, loadComponents, loadEvents } = await import("../../src/bot/discovery.js");
    const { report, problems } = await candidateCheck(
      inputs({
        commands: async () =>
          [...(await loadCommands()).values()].map(
            (command) => command.toJSON() as RegistrableCommand,
          ),
        modules: async () => {
          await loadComponents();
          await loadEvents();
          await loadCommands();
        },
      }),
    );
    expect(problems).toEqual([]);
    expect(report.check).toBe("ok");
  });

  test("the 2.45.0 /moderate block shape fails the registration part, and only it", async () => {
    const broken = moderate([
      option("member", true),
      option("duration", false),
      option("reason", true),
    ]);
    const { report, problems } = await candidateCheck(inputs({ commands: async () => [broken] }));
    expect(report).toEqual({
      check: "registration",
      identity: true,
      config: true,
      modules: true,
      registration: false,
    });
    expect(problems).toEqual([
      "registration: moderate/block/reason: required option after an optional one",
    ]);
  });

  test("the image must hold the requested version and schema, and end its migrations there", async () => {
    for (const [overrides, fragment] of [
      [{ version: "9.9.9" }, `the image holds version ${project.version}, not the requested one`],
      [
        { schema: "999_other.sql" },
        `the image holds schema ${SCHEMA_VERSION}, not the requested one`,
      ],
      [
        { migrations: async () => ["001_a.sql", "002_b.sql", "notes.txt"] },
        "the migrations folder ends at 002_b.sql, not the schema",
      ],
      [{ migrations: async () => [] }, "the migrations folder ends at nothing, not the schema"],
    ] as const) {
      const { report, problems } = await candidateCheck(inputs(overrides));
      expect(report.check).toBe("identity");
      expect(report.identity).toBe(false);
      expect(problems.join("\n")).toContain(fragment);
    }
  });

  test("the host's settings must pass the bot's own startup validation", async () => {
    const { report, problems } = await candidateCheck(
      inputs({ env: productionEnv({ DISCORD_TOKEN: "", HEALTH_PORT: "not-a-port" }) }),
    );
    expect(report.check).toBe("config");
    expect(report).toMatchObject({ identity: true, config: false, modules: true });
    expect(problems.join("\n")).toContain("DISCORD_TOKEN");
    expect(problems.join("\n")).toContain("HEALTH_PORT");
  });

  test("a module that fails to import fails the modules part", async () => {
    const { report, problems } = await candidateCheck(
      inputs({
        modules: async () => {
          throw new Error("Cannot find package 'a-dev-dependency'");
        },
      }),
    );
    expect(report).toMatchObject({ check: "modules", modules: false, registration: true });
    expect(problems).toEqual(["modules: Cannot find package 'a-dev-dependency'"]);
  });

  test("register.js's own deployment guard is part of the registration part", async () => {
    const { report, problems } = await candidateCheck(
      inputs({ scopeArguments: ["--guild", deployments.production.guilds[0]] }),
    );
    expect(report).toMatchObject({ check: "registration", registration: false });
    expect(problems.join("\n")).toContain("only in the global scope (--global)");
  });

  test("--global beside TEST_GUILD_ID is a failed registration part, as register.js refuses it", async () => {
    const { report, problems } = await candidateCheck(
      inputs({ env: productionEnv({ TEST_GUILD_ID: deployments.devbot.guilds[0] }) }),
    );
    expect(report).toMatchObject({ check: "registration", registration: false });
    expect(problems.join("\n")).toContain("TEST_GUILD_ID");
  });

  test("a staging check takes the guild scope under the staging environment", async () => {
    const guild = deployments.devbot.guilds[0];
    const { report, problems } = await candidateCheck(
      inputs({
        scopeArguments: ["--guild", guild],
        env: stagingEnv(),
      }),
    );
    expect(problems).toEqual([]);
    expect(report.check).toBe("ok");
    // Staging may not replace the global set.
    const global = await candidateCheck(inputs({ env: stagingEnv() }));
    expect(global.report).toMatchObject({ check: "registration", registration: false });
  });

  test("a loader that throws fails its own part and the others still run", async () => {
    const { report, problems } = await candidateCheck(
      inputs({
        migrations: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
        commands: async () => {
          throw new Error("Cannot find module");
        },
      }),
    );
    expect(report).toEqual({
      check: "identity",
      identity: false,
      config: true,
      modules: true,
      registration: false,
    });
    expect(problems).toEqual([
      "identity: ENOENT: no such file or directory",
      "registration: Cannot find module",
    ]);
  });

  test("a stray .sql file is read as migrate would: it is a migration, and a misnamed one fails", async () => {
    const real = readdirSync(join(root, "migrations"));
    const stray = await candidateCheck(
      inputs({ migrations: async () => [...real, "zz_extra.sql"] }),
    );
    expect(stray.report).toMatchObject({ check: "identity", identity: false });
    expect(stray.problems.join("\n")).toContain("1 file(s) in the migrations folder are not");
    expect(stray.problems.join("\n")).toContain("ends at zz_extra.sql, not the schema");
    // Other files in the folder are not migrations, as migrate sees them.
    const notes = await candidateCheck(inputs({ migrations: async () => [...real, "README.md"] }));
    expect(notes.report.identity).toBe(true);
  });

  test("every part is measured, and the first failure in order names the check", async () => {
    const { report } = await candidateCheck(
      inputs({
        version: "9.9.9",
        env: productionEnv({ DISCORD_TOKEN: "" }),
        modules: async () => {
          throw new Error("broken");
        },
        commands: async () => [moderate([option("a", false), option("b", true)])],
      }),
    );
    expect(report).toEqual({
      check: "identity",
      identity: false,
      config: false,
      modules: false,
      registration: false,
    });
  });

  test("a failure names settings and commands, never a setting's value", async () => {
    const { problems } = await candidateCheck(
      inputs({
        env: productionEnv({
          // Invalid values that carry secrets, each in a different kind of setting.
          DATABASE_URL: `not a url with ${PASSWORD}`,
          LOG_LEVEL: TOKEN,
          HEALTHCHECKS_PING_URL: `http://health.example.org/${TOKEN}`,
          ROSTER_INTERVAL_SECONDS: "soon",
          DISCORD_APPLICATION_ID: `${TOKEN}-id`,
        }),
        commands: async () => [moderate([option("a", false), option("b", true)])],
      }),
    );
    const everything = problems.join("\n");
    expect(everything).toContain("DATABASE_URL");
    expect(everything).toContain("LOG_LEVEL");
    expect(everything).toContain("HEALTHCHECKS_PING_URL");
    for (const secret of [PASSWORD, TOKEN, CA, "soon"]) expect(everything).not.toContain(secret);
    expect(everything).toContain("moderate/block/b: required option after an optional one");
  });
});

describe("the bot never imports the registration rules", () => {
  test("only the candidate check and tests do", () => {
    const importers = new Bun.Glob("**/*.ts");
    for (const file of importers.scanSync({ cwd: join(root, "src") })) {
      if (file === "discord/registration-rules.ts") continue;
      const code = readFileSync(join(root, "src", file), "utf8");
      expect({ file, imports: code.includes("registration-rules") }).toEqual({
        file,
        imports: false,
      });
    }
  });
});

describe("candidate check script", () => {
  /** Run the script as the image does: a working directory with migrations and no env file. */
  function run(argv: string[], env: Record<string, string>) {
    const directory = mkdtempSync(join(tmpdir(), "candidate-check-"));
    try {
      symlinkSync(join(root, "migrations"), join(directory, "migrations"));
      const result = Bun.spawnSync([process.execPath, script, ...argv], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, ...env },
        stdin: "ignore",
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const settings = (overrides: Environment = {}) =>
    Object.fromEntries(
      Object.entries(productionEnv(overrides)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

  test("prints one line of booleans and exits 0 for this checkout", () => {
    const result = run([project.version, SCHEMA_VERSION, "--global"], settings());
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({ check: "ok", identity: true, config: true, modules: true, registration: true })}\n`,
    );
    expect(result.code).toBe(0);
  });

  test("exits 1 with the failing part on stdout and the detail on stderr", () => {
    const result = run(
      [project.version, SCHEMA_VERSION, "--global"],
      settings({ DISCORD_TOKEN: "" }),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      check: "config",
      identity: true,
      config: false,
      modules: true,
      registration: true,
    });
    expect(result.stderr).toContain("config: Invalid configuration: DISCORD_TOKEN");
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
  });

  test("exits 2 for arguments it can't read, before any check", () => {
    const result = run(["not-a-version", SCHEMA_VERSION, "--global"], settings());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("release version");
  });
});
