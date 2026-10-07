/** File/plain secret precedence, private failure diagnostics and maintenance-tool scope. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { IssueReports } from "../../src/application/issue-reports.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { deployments } from "../../src/config/deployment.js";
import { type Configuration, configuration } from "../../src/config/env.js";
import {
  type Environment,
  FILE_SETTINGS,
  resolveSettings,
  secretSetting,
} from "../../src/config/secrets.js";
import { redact } from "../../src/domain/reports.js";
import { Failure } from "../../src/domain/values.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { Database } from "../../src/infrastructure/postgres/database.js";
import { run } from "../../scripts/commands.js";
const root = (path: string) => new URL(`../../${path}`, import.meta.url).pathname;

/** Sentinels stand in for secret values and paths; no failure message may contain them. */
const TOKEN = "file-token-sentinel-4b1d";
const PASSWORD = "file-password-sentinel-77c2";
const URL_VALUE = `postgresql://tarubot:${PASSWORD}@db.example:5432/tarubot`;
const CA = "-----BEGIN CERTIFICATE-----\nfile-ca-sentinel\n-----END CERTIFICATE-----";
const SECRET_DIR = "/run/secrets-sentinel";

/** A reader double: files by path, anything else unreadable with an error that leaks both. */
const files =
  (contents: Record<string, string>) =>
  (path: string): string => {
    const text = contents[path];
    if (text === undefined) throw new Error(`ENOENT: ${path} (${TOKEN})`);
    return text;
  };

/** Expect a configuration Failure whose message has `fragment` and no value or path. */
function failure(action: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Failure);
  if (!(caught instanceof Failure)) return;
  expect(caught.code).toBe("configuration");
  expect(caught.message).toContain(fragment);
  for (const leak of [TOKEN, PASSWORD, SECRET_DIR, tmpdir()])
    expect(caught.message).not.toContain(leak);
}

/**
 * Write files to a fresh directory, run the check with their paths, and clean up once it is done,
 * after its promise settles when it returns one.
 */
function withFiles<T>(
  contents: Record<string, string>,
  check: (paths: Record<string, string>) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), "tarubot-secrets-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  let result: T;
  try {
    const paths = Object.fromEntries(
      Object.entries(contents).map(([name, text]) => {
        const path = join(directory, name);
        writeFileSync(path, text);
        return [name, path];
      }),
    );
    result = check(paths);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}

/** Run with process.env holding exactly these values for the six and their NAME_FILE forms. */
function withProcessEnv<T>(values: Record<string, string>, action: () => T): T {
  const names = [
    ...FILE_SETTINGS,
    ...FILE_SETTINGS.map((name) => `${name}_FILE`),
    "TARUBOT_ENVIRONMENT",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    return action();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

describe("the resolver", () => {
  test("names the six secrets, sorted", () => {
    expect([...FILE_SETTINGS]).toEqual([
      "DATABASE_CA_CERT",
      "DATABASE_URL",
      "DISCORD_TOKEN",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_REPORTS_TOKEN",
      "HEALTHCHECKS_PING_URL",
    ]);
  });

  test("reads NAME_FILE and removes exactly one trailing newline", () => {
    const path = `${SECRET_DIR}/discord_token`;
    const read = (text: string) =>
      secretSetting({ DISCORD_TOKEN_FILE: path }, "DISCORD_TOKEN", files({ [path]: text }));
    // File injection may add one final newline; strip only that transport delimiter.
    expect(read(`${TOKEN}\n`)).toBe(TOKEN);
    // A value's own final newline survives, and a file without one is taken as it is.
    expect(read(`${CA}\n\n`)).toBe(`${CA}\n`);
    expect(read(TOKEN)).toBe(TOKEN);
    // An empty optional value is a lone newline (Podman refuses an empty secret).
    expect(read("\n")).toBe("");
    expect(read("")).toBe("");
    // Only the newline: blanks and a carriage return are part of the value.
    expect(read(` ${TOKEN} \r\n`)).toBe(` ${TOKEN} \r`);
  });

  test("with no NAME_FILE (unset or empty), NAME is used as it is", () => {
    const never = () => {
      throw new Error("read");
    };
    expect(secretSetting({ DISCORD_TOKEN: TOKEN }, "DISCORD_TOKEN", never)).toBe(TOKEN);
    expect(
      secretSetting({ DISCORD_TOKEN: TOKEN, DISCORD_TOKEN_FILE: "" }, "DISCORD_TOKEN", never),
    ).toBe(TOKEN);
    expect(secretSetting({ DISCORD_TOKEN: "" }, "DISCORD_TOKEN", never)).toBe("");
    expect(secretSetting({}, "DISCORD_TOKEN", never)).toBeUndefined();
    // An empty NAME beside NAME_FILE counts as unset too, so the file wins.
    const path = `${SECRET_DIR}/database_url`;
    expect(
      secretSetting(
        { DATABASE_URL: "", DATABASE_URL_FILE: path },
        "DATABASE_URL",
        files({ [path]: `${URL_VALUE}\n` }),
      ),
    ).toBe(URL_VALUE);
  });

  test("both forms set is a failure naming both, never the value or the path", () => {
    const path = `${SECRET_DIR}/database_url`;
    failure(
      () =>
        secretSetting(
          { DATABASE_URL: URL_VALUE, DATABASE_URL_FILE: path },
          "DATABASE_URL",
          files({ [path]: URL_VALUE }),
        ),
      "Set DATABASE_URL or DATABASE_URL_FILE, not both.",
    );
  });

  test("an unreadable file is a failure naming NAME_FILE only", () => {
    // The reader's own error carries the path and a value; neither may reach the message.
    failure(
      () =>
        secretSetting({ DISCORD_TOKEN_FILE: `${SECRET_DIR}/missing` }, "DISCORD_TOKEN", files({})),
      "DISCORD_TOKEN_FILE names a file that can't be read.",
    );
    // The real reader, on a path that doesn't exist and on a directory.
    failure(
      () =>
        secretSetting(
          { DATABASE_CA_CERT_FILE: join(tmpdir(), "tarubot-no-such-secret") },
          "DATABASE_CA_CERT",
        ),
      "DATABASE_CA_CERT_FILE names a file that can't be read.",
    );
    failure(
      () => secretSetting({ DATABASE_CA_CERT_FILE: tmpdir() }, "DATABASE_CA_CERT"),
      "DATABASE_CA_CERT_FILE",
    );
  });

  test("the default reader reads the file as UTF-8", () => {
    withFiles({ ca: `${CA}\n`, token: "töken\n" }, (paths) => {
      expect(secretSetting({ DATABASE_CA_CERT_FILE: paths.ca }, "DATABASE_CA_CERT")).toBe(CA);
      expect(secretSetting({ DISCORD_TOKEN_FILE: paths.token }, "DISCORD_TOKEN")).toBe("töken");
    });
  });

  test("resolveSettings returns a new object with plain names, and leaves its input alone", () => {
    const paths = {
      DATABASE_URL_FILE: `${SECRET_DIR}/database_url`,
      DISCORD_TOKEN_FILE: `${SECRET_DIR}/discord_token`,
      GITHUB_APP_PRIVATE_KEY_FILE: "",
    };
    const read = files({
      [paths.DATABASE_URL_FILE]: `${URL_VALUE}\n`,
      [paths.DISCORD_TOKEN_FILE]: `${TOKEN}\n`,
    });
    const input: Environment = Object.freeze({
      ...paths,
      DATABASE_CA_CERT: CA,
      // Another *_FILE setting is not a secret's and stays as it is.
      TEST_PLAN_FILE: "test-plans/current.json",
      LOG_LEVEL: "debug",
    });
    const snapshot = { ...input };
    const resolved = resolveSettings(input, read);
    expect(resolved).toEqual({
      DATABASE_URL: URL_VALUE,
      DATABASE_CA_CERT: CA,
      DISCORD_TOKEN: TOKEN,
      TEST_PLAN_FILE: "test-plans/current.json",
      LOG_LEVEL: "debug",
    });
    expect(resolved).not.toBe(input);
    expect({ ...input }).toEqual(snapshot);
    // The NAME_FILE keys are gone, so resolving again (the guard does) changes nothing.
    expect(resolveSettings(resolved, files({}))).toEqual(resolved);
  });

  test("never touches process.env", () => {
    // Its code never names process.env at all (its comments may); callers pass it in.
    const code = readFileSync(root("src/config/secrets.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    expect(code).toContain("export function resolveSettings");
    expect(code).not.toContain("process.env");
  });
});

/** The minimum environment the bot starts with, in plain variables. */
const PLAIN = {
  DATABASE_URL: URL_VALUE,
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
};
/** What configuration() made of PLAIN before 2.33.0: the values and every default. */
const PLAIN_CONFIGURATION: Configuration = {
  DATABASE_URL: URL_VALUE,
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
  LOG_LEVEL: "info",
  ENABLE_EFFECTS: false,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: false,
  ROSTER_INTERVAL_SECONDS: 21600,
  VERIFICATION_SECONDS: 1800,
  GUEST_COOLDOWN_SECONDS: 86400,
  HEALTH_PORT: 3000,
  GITHUB_REPORTS_TOKEN: "",
  GITHUB_REPORTS_REPO: "deconfined/tarubot-reports",
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_PRIVATE_KEY: "",
  HEALTHCHECKS_PING_URL: "",
};

describe("configuration()", () => {
  test("plain variables give the same Configuration as before", () => {
    expect(configuration(PLAIN)).toEqual(PLAIN_CONFIGURATION);
    expect(configuration({ ...PLAIN, GITHUB_APP_PRIVATE_KEY: CA })).toEqual({
      ...PLAIN_CONFIGURATION,
      GITHUB_APP_PRIVATE_KEY: CA,
    });
  });

  test("web settings are carried as strings and never stop the bot (#43)", () => {
    // Values src/web/settings.ts refuses: configuration() passes them on untouched, so a typo
    // turns only the web off (with a report), never the bot's start.
    const web = {
      WEB_PUBLIC_ORIGIN: "not an origin",
      WEB_PORT: "port",
      DISCORD_CLIENT_SECRET: " spaced secret ",
    };
    expect(configuration({ ...PLAIN, ...web })).toEqual({ ...PLAIN_CONFIGURATION, ...web });
    // Unset stays absent: no default stands in for a setting the web treats as "off".
    const keys = Object.keys(configuration(PLAIN));
    for (const key of Object.keys(web)) expect(keys).not.toContain(key);
  });

  test("the file forms give the same Configuration, and process.env stays as it was", () => {
    withFiles(
      {
        database_url: `${URL_VALUE}\n`,
        discord_token: `${TOKEN}\n`,
        github_app_private_key: `${CA}\n`,
        github_reports_token: "\n",
        healthchecks_ping_url: "https://hc-ping.example/sentinel\n",
      },
      (paths) => {
        const values = {
          DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
          DATABASE_URL_FILE: paths.database_url ?? "",
          DISCORD_TOKEN_FILE: paths.discord_token ?? "",
          GITHUB_APP_PRIVATE_KEY_FILE: paths.github_app_private_key ?? "",
          GITHUB_REPORTS_TOKEN_FILE: paths.github_reports_token ?? "",
          HEALTHCHECKS_PING_URL_FILE: paths.healthchecks_ping_url ?? "",
        };
        withProcessEnv(values, () => {
          const before = { ...process.env };
          // With no argument it reads process.env, as the bot and the tools call it.
          expect(configuration()).toEqual({
            ...PLAIN_CONFIGURATION,
            GITHUB_APP_PRIVATE_KEY: CA,
            HEALTHCHECKS_PING_URL: "https://hc-ping.example/sentinel",
          });
          expect({ ...process.env }).toEqual(before);
          expect(process.env.DISCORD_TOKEN).toBeUndefined();
          expect(process.env.DATABASE_URL).toBeUndefined();
        });
      },
    );
  });

  test("both forms, or an unreadable file, stop the start naming settings only", () => {
    for (const [env, fragment] of [
      [
        { ...PLAIN, DISCORD_TOKEN_FILE: `${SECRET_DIR}/discord_token` },
        "Set DISCORD_TOKEN or DISCORD_TOKEN_FILE, not both.",
      ],
      [
        { ...PLAIN, DISCORD_TOKEN: undefined, DISCORD_TOKEN_FILE: `${SECRET_DIR}/discord_token` },
        "DISCORD_TOKEN_FILE names a file that can't be read.",
      ],
    ] as const) {
      let message = "";
      try {
        configuration(env);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(`Invalid configuration: ${fragment}`);
      for (const leak of [TOKEN, PASSWORD, SECRET_DIR]) expect(message).not.toContain(leak);
    }
  });

  test("production and staging refuse a start without the cluster's CA, in either form", () => {
    for (const marker of ["production", "staging"]) {
      const env = { ...PLAIN, TARUBOT_ENVIRONMENT: marker };
      for (const without of [env, { ...env, DATABASE_CA_CERT: "" }])
        expect(() => configuration(without)).toThrow(
          `DATABASE_CA_CERT: required, directly or through DATABASE_CA_CERT_FILE, when TARUBOT_ENVIRONMENT is ${marker}`,
        );
      expect(configuration({ ...env, DATABASE_CA_CERT: CA })).toEqual(PLAIN_CONFIGURATION);
      withFiles({ ca: `${CA}\n`, empty: "\n" }, (paths) => {
        expect(configuration({ ...env, DATABASE_CA_CERT_FILE: paths.ca })).toEqual(
          PLAIN_CONFIGURATION,
        );
        // An empty value, a lone newline, is no CA at all.
        expect(() => configuration({ ...env, DATABASE_CA_CERT_FILE: paths.empty })).toThrow(
          "DATABASE_CA_CERT: required",
        );
      });
    }
    // DevBot, a rehearsal and unmanaged runs keep connecting to local databases without one.
    for (const marker of ["devbot", "rehearsal", ""])
      expect(configuration({ ...PLAIN, TARUBOT_ENVIRONMENT: marker })).toEqual(PLAIN_CONFIGURATION);
  });
});

describe("the readers", () => {
  test("Database's default CA comes from DATABASE_CA_CERT_FILE, so the pool verifies the cluster", async () => {
    const managed = "postgresql://tarubot:fixture@managed-db.example:27520/tarubot?sslmode=require";
    await withFiles({ ca: `${CA}\n` }, async (paths) => {
      // Constructing a pool never opens a connection.
      const database = withProcessEnv(
        { DATABASE_CA_CERT_FILE: paths.ca ?? "" },
        () => new Database(managed),
      );
      try {
        expect<unknown>(database.pool.options.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
      } finally {
        await database.close();
      }
    });
    // An explicit CA (check-restore's PITR fork) still wins, and "" still means none.
    const explicit = withProcessEnv(
      { DATABASE_CA_CERT_FILE: `${SECRET_DIR}/missing` },
      () => new Database(managed, "fork-ca"),
    );
    try {
      expect<unknown>(explicit.pool.options.ssl).toEqual({
        ca: "fork-ca",
        rejectUnauthorized: true,
      });
    } finally {
      await explicit.close();
    }
  });

  test("issue reports redact a file-sourced token and the file-sourced URL's password", () => {
    withFiles({ database_url: `${URL_VALUE}\n`, discord_token: `${TOKEN}\n` }, (paths) => {
      const config = configuration({
        DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
        DATABASE_URL_FILE: paths.database_url ?? "",
        DISCORD_TOKEN_FILE: paths.discord_token ?? "",
      });
      // The reporter takes its secret values from Configuration; its constructor touches nothing
      // else, so the database and adapters are never used here.
      const reports = new IssueReports(
        config,
        null as unknown as Database,
        null as unknown as Lodestone,
        new RecentLogs(),
        null,
      );
      const secrets = (reports as unknown as { secrets: string[] }).secrets;
      expect(secrets).toContain(TOKEN);
      expect(secrets).toContain(PASSWORD);
      // Neither sentinel has a shape the patterns know, so only the values remove them.
      const text = `first ${TOKEN}, then ${PASSWORD}`;
      expect(redact(text)).toBe(text);
      expect(redact(text, secrets)).toBe("first [secret redacted], then [secret redacted]");
    });
  });

  test("commands.js reads DISCORD_TOKEN_FILE, and refuses both forms before any client exists", async () => {
    const devbot = {
      DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
      TEST_GUILD_ID: deployments.devbot.guilds[0],
    };
    const container = { execArgv: [], envFiles: [] };
    await withFiles({ token: `${TOKEN}\n` }, async (paths) => {
      const opened: string[] = [];
      // The factory records the token it gets and stops the run there.
      const connect = (token: string) => {
        opened.push(token);
        throw new Error("stop after connect");
      };
      await expect(
        run(["list"], { ...devbot, DISCORD_TOKEN_FILE: paths.token }, connect, container),
      ).rejects.toThrow("stop after connect");
      expect(opened).toEqual([TOKEN]);
      await expect(
        run(
          ["list"],
          { ...devbot, DISCORD_TOKEN: TOKEN, DISCORD_TOKEN_FILE: paths.token },
          connect,
          container,
        ),
      ).rejects.toThrow("Set DISCORD_TOKEN or DISCORD_TOKEN_FILE, not both.");
      expect(opened).toEqual([TOKEN]);
    });
  });

  test("nothing under src/ or scripts/ reads one of the six from process.env itself", () => {
    // Every reader goes through src/config/secrets.ts (configuration(), the guard, Database's
    // default CA, secretSetting in the scripts), or a file-delivered value would be missed.
    const names = FILE_SETTINGS.join("|");
    const direct = new RegExp(`process\\.env\\s*(?:\\.\\s*|\\[\\s*["'\`])(${names})\\b`, "u");
    const destructured = new RegExp(`\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*=\\s*process\\.env`, "u");
    // The patterns find the forms they are meant to find.
    for (const sample of [
      "const url = process.env.DATABASE_URL;",
      'process.env["DISCORD_TOKEN"]',
      "const { DATABASE_CA_CERT } = process.env;",
    ])
      expect(direct.test(sample) || destructured.test(sample)).toBe(true);
    expect(direct.test("process.env.DATABASE_URL_FILE")).toBe(false);
    const walk = (path: string): string[] =>
      statSync(path).isDirectory()
        ? readdirSync(path).flatMap((name) => walk(join(path, name)))
        : /\.ts$/u.test(path)
          ? [path]
          : [];
    const sources = [...walk(root("src")), ...walk(root("scripts"))].filter(
      (path) => relative(root(""), path) !== "src/config/secrets.ts",
    );
    expect(sources.length).toBeGreaterThan(50);
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      const file = relative(root(""), path);
      expect({ file, direct: direct.exec(text)?.[0] ?? null }).toEqual({ file, direct: null });
      expect({ file, destructured: destructured.exec(text)?.[0] ?? null }).toEqual({
        file,
        destructured: null,
      });
    }
  });
});
