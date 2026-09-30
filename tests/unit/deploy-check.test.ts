/**
 * The in-image settings check (2.37.0, ported from Codex's ce3ded7): scripts/deploy-check.ts,
 * which ops/ansible/bot.yml's Settings phase runs in the release image before anything is written
 * or stopped. These run it under Bun against the source, in process and as the CLI bot.yml runs,
 * with the settings bot.yml would give it (the test renderer's tarubot.env plus the secrets by
 * their plain names), every secret carrying a sentinel. They pin:
 * - what passes: staging's and prod's deploy, bot and preflight settings, prod with and without
 *   /suggest;
 * - which check refuses what: configuration() (a missing Discord token, a missing CA, a ping URL
 *   off HTTPS), the migrate guard (the pool's port, another target's database), the register guard
 *   (a profile that may not register), and a malformed input as configuration;
 * - the output: exactly one line, {"ok":true} with status 0 or the check's name with status 1,
 *   nothing on stderr, and never a value, whatever the process environment holds;
 * - what it imports: migrate.js's and register.js's scope builders, whose modules do nothing at
 *   the top level (their work is behind import.meta.main).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { CHECK_ACTIONS, type CheckResult, checkSettings } from "../../scripts/deploy-check.js";
import {
  PROD_DATABASES,
  PROD_ROLE,
  resolveDeployment,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import { renderTarget, type Target } from "../fixtures/bot-render.js";
import { parseEnvFile, read, root } from "../fixtures/quadlet.js";

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

/** In every secret, so a leak of any of them shows. */
const SENTINEL = "Sentinel7f3a";
const SECRETS: Record<string, string> = {
  DATABASE_CA_CERT: `-----BEGIN CERTIFICATE-----\n${SENTINEL}\n-----END CERTIFICATE-----`,
  DISCORD_TOKEN: `${SENTINEL}.token.value`,
  GITHUB_REPORTS_TOKEN: `github_pat_${SENTINEL}`,
  HEALTHCHECKS_PING_URL: `https://hc-ping.example.org/${SENTINEL}`,
  GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${SENTINEL}\n-----END PRIVATE KEY-----`,
};
/** A managed-cluster URL with the sentinel as its password. */
const url = (user: string, database: string, port = 27520) =>
  `postgresql://${user}:${SENTINEL}@db.example.org:${port}/${database}`;
const STAGING_URL = url(STAGING_DATABASE, STAGING_DATABASE);
const PROD_URL = url(PROD_ROLE, PROD_DATABASES[0] ?? "");

type Env = Record<string, string>;
type Action = (typeof CHECK_ACTIONS)[number];

/**
 * What bot.yml gives the check for one target and action: tarubot.env's plain lines (the test
 * renderer's, which CI diffs against Ansible's own template module) and each secret the container
 * mounts, by its plain name. A preflight mounts the database's two only.
 */
async function settings(
  target: Target,
  action: Action,
  database: string,
  clientId = "",
): Promise<Env> {
  const profile = resolveDeployment({ TARUBOT_ENVIRONMENT: target });
  const rendered = await renderTarget(
    target,
    `sha256:${"0".repeat(64)}`,
    { applicationId: profile.applicationId ?? "", registrationScope: profile.registrationScope },
    action === "preflight" ? "" : clientId,
  );
  const env: Env = {};
  for (const entry of parseEnvFile(rendered.env, "tarubot.env")) {
    const secret = /^([A-Z_]+)_FILE$/u.exec(entry.name)?.[1];
    if (secret === undefined) env[entry.name] = entry.value ?? "";
    else if (action !== "preflight" || ["DATABASE_CA_CERT", "DATABASE_URL"].includes(secret))
      env[secret] = secret === "DATABASE_URL" ? database : (SECRETS[secret] ?? "");
  }
  return env;
}

/** The check's answer, in process. */
const check = (action: Action, env: Env): CheckResult => checkSettings({ action, env });

describe("what passes", () => {
  for (const action of ["deploy", "bot"] as const) {
    test(`staging's ${action}`, async () => {
      expect(check(action, await settings("staging", action, STAGING_URL))).toEqual({ ok: true });
    });
    test(`prod's ${action}, with /suggest's client ID and key`, async () => {
      const env = await settings("prod", action, PROD_URL, "Iv23liInvented");
      expect({ id: env.GITHUB_APP_CLIENT_ID, key: "GITHUB_APP_PRIVATE_KEY" in env }).toEqual({
        id: "Iv23liInvented",
        key: true,
      });
      expect(check(action, env)).toEqual({ ok: true });
    });
    test(`prod's ${action}, without /suggest`, async () => {
      const env = await settings("prod", action, PROD_URL);
      expect({ id: env.GITHUB_APP_CLIENT_ID, key: "GITHUB_APP_PRIVATE_KEY" in env }).toEqual({
        id: "",
        key: false,
      });
      expect(check(action, env)).toEqual({ ok: true });
    });
  }

  test("a preflight on either target, which has no Discord token yet", async () => {
    for (const [target, database] of [
      ["staging", STAGING_URL],
      ["prod", PROD_URL],
    ] as const) {
      const env = await settings(target, "preflight", database);
      expect({ target, token: "DISCORD_TOKEN" in env }).toEqual({ target, token: false });
      expect({ target, result: check("preflight", env) }).toEqual({
        target,
        result: { ok: true },
      });
    }
  });

  test("prod's same-cluster restore database", async () => {
    const env = await settings("prod", "deploy", url(PROD_ROLE, PROD_DATABASES[1] ?? ""));
    expect(check("deploy", env)).toEqual({ ok: true });
  });
});

describe("which check refuses what", () => {
  test("the migrate guard: the pool's port 27521", async () => {
    expect(
      check("deploy", await settings("prod", "deploy", url(PROD_ROLE, "tarubot_prod", 27521))),
    ).toEqual({ ok: false, check: "migrate" });
    expect(
      check(
        "preflight",
        await settings("staging", "preflight", url(STAGING_DATABASE, STAGING_DATABASE, 27521)),
      ),
    ).toEqual({ ok: false, check: "migrate" });
  });

  test("the migrate guard: the Compose host's tarubot under prod", async () => {
    for (const database of [url("tarubot", "tarubot"), url(PROD_ROLE, "tarubot")])
      expect(check("deploy", await settings("prod", "deploy", database))).toEqual({
        ok: false,
        check: "migrate",
      });
  });

  test("the migrate guard: prod's database under staging, and staging's under prod", async () => {
    expect(check("deploy", await settings("staging", "deploy", PROD_URL))).toEqual({
      ok: false,
      check: "migrate",
    });
    expect(check("bot", await settings("prod", "bot", STAGING_URL))).toEqual({
      ok: false,
      check: "migrate",
    });
  });

  test("configuration(): a deploy without DISCORD_TOKEN, which a preflight doesn't need", async () => {
    const env = await settings("staging", "deploy", STAGING_URL);
    delete env.DISCORD_TOKEN;
    expect(check("deploy", env)).toEqual({ ok: false, check: "configuration" });
    expect(check("bot", env)).toEqual({ ok: false, check: "configuration" });
    // The same settings pass a preflight: it runs the migrate guard only.
    expect(check("preflight", env)).toEqual({ ok: true });
  });

  test("configuration(): a missing CA, a ping URL off HTTPS, a URL that isn't one", async () => {
    const base = await settings("prod", "deploy", PROD_URL);
    const cases: [string, Env][] = [
      ["no CA", { ...base, DATABASE_CA_CERT: "" }],
      ["http ping", { ...base, HEALTHCHECKS_PING_URL: `http://hc-ping.example.org/${SENTINEL}` }],
      ["not a URL", { ...base, DATABASE_URL: `not a url ${SENTINEL}` }],
    ];
    for (const [label, env] of cases)
      expect({ label, result: check("deploy", env) }).toEqual({
        label,
        result: { ok: false, check: "configuration" },
      });
  });

  test("the register guard: a profile that may not register (a rehearsal marker)", async () => {
    // A rehearsal passes configuration() and the migrate guard on its own database, but is
    // read-only on Discord, so registration is refused.
    const env = {
      ...(await settings("prod", "deploy", url("tarubot", "tarubot_rehearsal"))),
      TARUBOT_ENVIRONMENT: "rehearsal",
    };
    expect(check("deploy", env)).toEqual({ ok: false, check: "register" });
    // A preflight never reaches it.
    expect(check("preflight", env)).toEqual({ ok: true });
  });

  test("a malformed input is refused as configuration, before any check", async () => {
    const env = await settings("staging", "deploy", STAGING_URL);
    for (const input of [
      null,
      "deploy",
      [],
      { action: "deploy" },
      { action: "configure", env },
      { action: "deploy", env, extra: true },
      { action: "deploy", env: { ...env, DATABASE_URL: 1 } },
      { action: "deploy", env: { ...env, "lower-case": "x" } },
      { action: "deploy", env: [] },
    ])
      expect({ input: JSON.stringify(input)?.slice(0, 40), result: checkSettings(input) }).toEqual({
        input: JSON.stringify(input)?.slice(0, 40),
        result: { ok: false, check: "configuration" },
      });
  });
});

/** The CLI as bot.yml runs it: stdin in, one line out, in a directory with no env file. */
describe("the CLI", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "deploy-check-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function run(stdin: string, extra: Env = {}) {
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", root("scripts/deploy-check.ts")],
      {
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra },
        stdin: Buffer.from(stdin),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }

  test('prints exactly {"ok":true} and exits 0, or the check\'s name and exits 1, with nothing on stderr', async () => {
    const good = JSON.stringify({
      action: "deploy",
      env: await settings("prod", "deploy", PROD_URL),
    });
    expect(run(`${good}\n`)).toEqual({ code: 0, out: '{"ok":true}\n', err: "" });
    const bad = JSON.stringify({
      action: "deploy",
      env: await settings("prod", "deploy", url(PROD_ROLE, "tarubot_prod", 27521)),
    });
    expect(run(bad)).toEqual({ code: 1, out: '{"ok":false,"check":"migrate"}\n', err: "" });
    expect(run(`not json ${SENTINEL}`)).toEqual({
      code: 1,
      out: '{"ok":false,"check":"configuration"}\n',
      err: "",
    });
  });

  test("the process environment changes nothing: the input is the only environment", async () => {
    const input = JSON.stringify({
      action: "deploy",
      env: await settings("staging", "deploy", STAGING_URL),
    });
    // A production marker and URL in the process's own environment are ignored.
    const noisy = {
      TARUBOT_ENVIRONMENT: "production",
      DATABASE_URL: url("tarubot", "tarubot", 5432),
      DISCORD_TOKEN: "",
    };
    expect(run(input, noisy)).toEqual({ code: 0, out: '{"ok":true}\n', err: "" });
  });

  test("no value ever reaches its output, whichever check refuses", async () => {
    const inputs: unknown[] = [];
    for (const [target, database] of [
      ["staging", STAGING_URL],
      ["prod", PROD_URL],
      ["prod", url("tarubot", "tarubot")],
      ["staging", url(STAGING_DATABASE, STAGING_DATABASE, 27521)],
    ] as const)
      for (const action of CHECK_ACTIONS)
        inputs.push({ action, env: await settings(target, action, database, "Iv23liInvented") });
    inputs.push({
      action: "deploy",
      env: {
        ...(await settings("prod", "deploy", url("tarubot", "tarubot_rehearsal"))),
        TARUBOT_ENVIRONMENT: "rehearsal",
      },
    });
    for (const input of inputs) {
      const { out, err } = run(JSON.stringify(input));
      expect(out).toMatch(/^\{"ok":(true|false,"check":"(configuration|migrate|register)")\}\n$/u);
      expect(`${out}${err}`).not.toContain(SENTINEL);
      expect(err).toBe("");
    }
  });
});

describe("what it is built from", () => {
  test("bot.yml's actions, and the script bot.yml names", async () => {
    const vars = YAML.parse(await read("ops/ansible/vars/bot.yml")) as Record<string, unknown>;
    expect(vars.tb_actions).toEqual([...CHECK_ACTIONS]);
    expect(vars.tb_settings_check).toBe("dist/scripts/deploy-check.js");
  });

  test("it reads no process environment, and imports only the config and the two tools' scopes", async () => {
    const source = await read("scripts/deploy-check.ts");
    // Its code, without the comments that describe the rule.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\*\*|\*|\/\/)/u.test(line))
      .join("\n");
    expect(code).not.toContain("process.env");
    expect(source).toContain("if (import.meta.main) {");
    expect(
      [...source.matchAll(/^\} from "([^"]+)";$|^import .* from "([^"]+)";$/gmu)].map(
        (match) => match[1] ?? match[2],
      ),
    ).toEqual([
      "../src/config/deployment.js",
      "../src/config/env.js",
      "./migrate.js",
      "./register.js",
    ]);
  });

  test("migrate.js and register.js do nothing at the top level: their work is behind import.meta.main", async () => {
    for (const file of ["scripts/migrate.ts", "scripts/register.ts"]) {
      const source = await read(file);
      const parts = source.split("if (import.meta.main) {");
      expect({ file, guards: parts.length }).toEqual({ file, guards: 2 });
      // Before the guard, every top-level statement (a line at column 0) is an import, a
      // declaration or a comment: no call, no `new`, no await (functions may await inside).
      const statements = (parts[0] ?? "")
        .split("\n")
        .filter((line) => line !== "" && !/^\s/u.test(line));
      for (const line of statements)
        expect({
          file,
          line,
          declaration:
            /^(import |export (async )?function |export (type|interface) |(async )?function |type |interface |\/\*\*|\*\/|\/\/|\} from "|\}$|\};$|\)(: .+)? \{$)/u.test(
              line,
            ) && !/\bawait\b|\bnew\b/u.test(line),
        }).toEqual({ file, line, declaration: true });
      // Everything after the guard is its own block, to the end of the file.
      expect({ file, end: (parts[1] ?? "").trimEnd().endsWith("}") }).toEqual({ file, end: true });
    }
  });
});
