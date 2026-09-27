/**
 * TaruBot's rootless Quadlet unit (#50, ops/quadlet/; ops/quadlet/README.md has the design). The
 * release owns the unit, the setting lists and check-env.sh; each Podman host links units/ and one
 * target directory into the tarubot user's Quadlet search path. These pin:
 * - the files: the exact set, the rule that only units/ holds Quadlet units, and the house rules
 *   that keep the readers in tests/fixtures/quadlet.ts exact;
 * - the unit: its keys, the fixed image repository with a digest pin, no pull at start, journald,
 *   the health check, restarts and stopping, all mapped from docker-compose.production.yml;
 * - the settings: the lists plus the file-delivered secrets give exactly Compose's bot environment,
 *   with Compose's fixed values, and unset names fall back to the bot's defaults, which equal
 *   Compose's; staging differs from production only in its own keys;
 * - check-env.sh: both modes, run for real, printing names and never values;
 * - with QUADLET_DRYRUN set, Podman's own generator output (README "What Podman generates").
 * The hardening itself is pinned beside Compose's in container-hardening.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { deployments } from "../../src/config/deployment.js";
import { configuration } from "../../src/config/env.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import {
  baseList,
  directoriesUnder,
  dropIn,
  filesUnder,
  keysOf,
  merged,
  namesOf,
  QUADLET,
  read,
  root,
  sectionsOf,
  TARGETS,
  targetList,
  unit,
  single,
  valuesOf,
} from "../fixtures/quadlet.js";

/**
 * The settings that reach the bot as Podman secrets mounted as files from 2.33.0 (@deconfined's
 * decision of 2026-09-26, #50; README "Secrets"), never as environment variables. The lists never
 * name them, and with them the lists cover exactly Compose's bot environment.
 */
const FILE_SECRETS = [
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_PING_URL",
];

/** The names staging's list may set differently from production's. */
const TARGET_KEYS = [
  "DISCORD_APPLICATION_ID",
  "GITHUB_APP_CLIENT_ID",
  "PUBLIC_TEST_RESPONSES",
  "TARUBOT_ENVIRONMENT",
  "TEST_GUILD_ID",
  "TEST_PLAN_CHANNEL_ID",
];

/** The bot's service in docker-compose.production.yml, the parity reference until the rebuild. */
const composeBot = async () =>
  z
    .object({
      services: z.object({
        tarubot: z
          .object({
            environment: z.record(z.string(), z.string()),
            healthcheck: z.object({
              test: z.array(z.string()),
              interval: z.string(),
              timeout: z.string(),
              retries: z.number(),
              start_period: z.string(),
            }),
            restart: z.string(),
            stop_grace_period: z.string(),
          })
          .passthrough(),
      }),
    })
    .passthrough()
    .parse(YAML.parse(await read("docker-compose.production.yml"))).services.tarubot;

/** One Compose setting: required (${X:?}), defaulted (${X:-d}) or a fixed value. */
type ComposeSetting =
  | { kind: "required" }
  | { kind: "default"; value: string }
  | { kind: "fixed"; value: string };

/** Classify Compose's bot environment, checking that each interpolation names its own key. */
async function composeSettings(): Promise<Map<string, ComposeSetting>> {
  const settings = new Map<string, ComposeSetting>();
  for (const [key, value] of Object.entries((await composeBot()).environment)) {
    const required = /^\$\{([A-Z0-9_]+):\?[^}]*\}$/u.exec(value);
    const defaulted = /^\$\{([A-Z0-9_]+):-([^}$]*)\}$/u.exec(value);
    const named = required?.[1] ?? defaulted?.[1];
    if (named !== undefined) expect(named, key).toBe(key);
    if (required) settings.set(key, { kind: "required" });
    else if (defaulted) settings.set(key, { kind: "default", value: defaulted[2] ?? "" });
    else if (value.includes("$")) throw new Error(`${key}: an interpolation this test can't read`);
    else settings.set(key, { kind: "fixed", value });
  }
  return settings;
}

/** check-env.sh's lists, read from the script itself (its one copy). */
async function checkEnvList(name: "REQUIRED" | "NOT_EMPTY"): Promise<string[]> {
  const match = new RegExp(`^readonly ${name}='([A-Z0-9_ ]+)'$`, "mu").exec(
    await read(`${QUADLET}/check-env.sh`),
  );
  if (!match?.[1]) throw new Error(`check-env.sh has no readonly ${name} list`);
  return match[1].split(" ");
}

/** The owner and name of the repository package.json names, lowercased as GHCR paths are. */
function repository(): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(manifest.repository.url);
  if (!match?.[1] || !match[2]) throw new Error("package.json repository.url is not a GitHub URL");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** Seconds in a Compose duration (15s, 1m) or a systemd time (60 means seconds). */
function seconds(duration: string): number {
  const match = /^(\d+)(s|m)?$/u.exec(duration);
  if (!match?.[1]) throw new Error(`unreadable duration ${duration}`);
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

describe("the files", () => {
  test("ops/quadlet holds exactly the release's Quadlet files, and check-env.sh is executable", () => {
    expect(filesUnder(QUADLET)).toEqual([
      "README.md",
      "check-env.sh",
      "production/target.env",
      "production/tarubot.container.d/50-target.conf",
      "staging/target.env",
      "staging/tarubot.container.d/50-target.conf",
      "units/tarubot.container",
      "units/tarubot.env",
    ]);
    // The unit runs it as ExecStartPre, and a deploy runs it through systemd-run.
    expect(statSync(root(`${QUADLET}/check-env.sh`)).mode & 0o111).toBe(0o111);
  });

  test("only units/ holds Quadlet units, and no drop-in directory sits under it", () => {
    // Quadlet reads every linked directory recursively and applies a unit's [Install] at the next
    // boot (podman-systemd.unit(5)). A unit anywhere else, or a drop-in under units/ (which every
    // host links), would reach hosts it wasn't meant for.
    const extensions = /\.(container|volume|network|kube|image|build|pod|artifact)$/u;
    for (const file of filesUnder(QUADLET))
      if (extensions.test(file))
        expect(file, "a Quadlet unit outside units/").toStartWith("units/");
    const directories = directoriesUnder(QUADLET);
    expect(directories.filter((path) => path.startsWith("units/"))).toEqual([]);
    // Each target has exactly one drop-in directory, for the one unit.
    expect(directories.filter((path) => path.endsWith(".d"))).toEqual(
      TARGETS.map((target) => `${target}/tarubot.container.d`),
    );
  });

  test("git tracks the setting lists despite the *.env rule for operator files", () => {
    // .gitignore and .dockerignore drop *.env (operator settings files). The lists hold names and
    // fixed public values only, so both carry exceptions; the image build's unit tests read them.
    // The image build has no git and no repository; the check runs wherever both exist.
    const git = Bun.which("git");
    if (git === null) return;
    const repo = (...args: string[]) => Bun.spawnSync([git, "-C", root(""), ...args]).exitCode;
    if (repo("rev-parse", "--is-inside-work-tree") !== 0) return;
    // check-ignore exits 0 only for an ignored path.
    for (const file of filesUnder(QUADLET))
      expect({ file, ignored: repo("check-ignore", "-q", `${QUADLET}/${file}`) === 0 }).toEqual({
        file,
        ignored: false,
      });
  });

  test("the image build keeps the setting lists in its context", async () => {
    const ignore = await read(".dockerignore");
    for (const file of filesUnder(QUADLET).filter((path) => path.endsWith(".env")))
      expect(ignore).toContain(`!${QUADLET}/${file}\n`);
  });

  test("ops/quadlet names no host beyond GitHub and the two container registries", async () => {
    // As in deploy-workflow.test.ts: every host name ending in a common top-level domain, and no
    // address literal. The public repository never names a TaruBot host.
    const allowed = new Set(["github.com", "ghcr.io", "quay.io"]);
    for (const file of filesUnder(QUADLET)) {
      const source = await read(`${QUADLET}/${file}`);
      const hosts = [
        ...source.matchAll(
          /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9]))/gimu,
        ),
      ]
        .map((m) => (m[1] ?? "").toLowerCase())
        .filter((host) => !allowed.has(host));
      expect({ file, hosts }).toEqual({ file, hosts: [] });
      expect({ file, ip: /\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(source) }).toEqual({
        file,
        ip: false,
      });
    }
  });
});

describe("the unit", () => {
  test("uses only the keys the design names, in the sections systemd and Quadlet expect", async () => {
    // A new key is a deliberate change here. [Container] keys become podman run flags; the rest
    // pass to systemd unchanged.
    const bot = await unit();
    expect(sectionsOf(bot)).toEqual(["Unit", "Container", "Service", "Install"]);
    expect(keysOf(bot, "Unit")).toEqual(["Description", "StartLimitIntervalSec"]);
    expect(keysOf(bot, "Container")).toEqual(
      [
        "ContainerName",
        "DropCapability",
        "EnvironmentFile",
        "EnvironmentHost",
        "HealthCmd",
        "HealthInterval",
        "HealthOnFailure",
        "HealthRetries",
        "HealthStartPeriod",
        "HealthTimeout",
        "HttpProxy",
        "Image",
        "LogDriver",
        "NoNewPrivileges",
        "Pull",
        "ReadOnly",
        "ReadOnlyTmpfs",
        "StopTimeout",
      ].sort(),
    );
    expect(keysOf(bot, "Service")).toEqual(
      [
        "EnvironmentFile",
        "ExecStartPre",
        "Restart",
        "RestartMaxDelaySec",
        "RestartSec",
        "RestartSteps",
        "TimeoutStopSec",
        "UnsetEnvironment",
      ].sort(),
    );
    expect(keysOf(bot, "Install")).toEqual(["WantedBy"]);
    expect(single(bot, "Container", "ContainerName")).toBe("tarubot");
  });

  test("no unit or drop-in uses a key that mounts, publishes, maps users or bypasses the lists", async () => {
    // Each of these would change what the container can reach or how its settings arrive, which
    // the lists and #51's hardening decide. Secret= comes with the file-delivered secrets (2.33.0);
    // AutoUpdate= would let podman auto-update replace the pinned image.
    const forbidden =
      /^(PodmanArgs|GlobalArgs|Volume|Mount|Tmpfs|VolatileTmp|PublishPort|ExposeHostPort|AddCapability|AddDevice|SecurityLabel\w*|SeccompProfile|AppArmor|Unmask|User|Group|GroupAdd|UserNS|UIDMap|GIDMap|SubUIDMap|SubGIDMap|Network|Pod|Rootfs|Secret|AutoUpdate|ContainersConfModule|Sysctl|Environment|Exec|Entrypoint)$/u;
    for (const [file, lines] of [
      ["units/tarubot.container", await unit()],
      ...(await Promise.all(
        TARGETS.map(async (target) => [target, await dropIn(target)] as const),
      )),
    ] as const)
      for (const line of lines.filter((l) => l.section === "Container"))
        expect({ file, key: line.key, forbidden: forbidden.test(line.key) }).toEqual({
          file,
          key: line.key,
          forbidden: false,
        });
  });

  test("runs the one repository's image by the digest in .env, and never pulls at start", async () => {
    // The repository is fixed, so production can't run another package (a PR image) whatever .env
    // says. Quadlet never escapes $, and systemd expands ${TARUBOT_IMAGE_DIGEST} from .env.
    const bot = await unit();
    expect(single(bot, "Container", "Image")).toBe(
      `ghcr.io/${repository()}@\${TARUBOT_IMAGE_DIGEST}`,
    );
    // A start or reboot never contacts GHCR; deploy.sh pulls by digest before it pins.
    expect(single(bot, "Container", "Pull")).toBe("never");
    // Without AutoUpdate= the container has no io.containers.autoupdate label.
    expect(valuesOf(bot, "Container", "AutoUpdate")).toEqual([]);
    expect(single(bot, "Container", "LogDriver")).toBe("journald");
  });

  test("reads .env through systemd and hands the container only the release's lists", async () => {
    const bot = await unit();
    expect(single(bot, "Service", "EnvironmentFile")).toBe("%h/tarubot/.env");
    // The base list here; each target's drop-in adds its own after it.
    expect(valuesOf(bot, "Container", "EnvironmentFile")).toEqual([
      `%h/tarubot/${QUADLET}/units/tarubot.env`,
    ]);
    expect(single(bot, "Container", "EnvironmentHost")).toBe("false");
    expect(single(bot, "Container", "HttpProxy")).toBe("false");
    // Both of check-env.sh's modes run before every start: the file, then what systemd read.
    expect(valuesOf(bot, "Service", "ExecStartPre")).toEqual([
      `%h/tarubot/${QUADLET}/check-env.sh --syntax %h/tarubot/.env`,
      `%h/tarubot/${QUADLET}/check-env.sh`,
    ]);
  });

  test("keeps ops/backup.sh's settings away from Podman, conmon and the bot", async () => {
    // Compose never passed them to the bot; here systemd reads the whole .env, so it unsets them.
    const backup = await read("ops/backup.sh");
    const settings = [...backup.matchAll(/\$\(setting ([A-Z0-9_]+)\)/gu)].map((m) => m[1] ?? "");
    expect(settings.length).toBeGreaterThan(0);
    expect(
      single(await unit(), "Service", "UnsetEnvironment")
        .split(" ")
        .sort(),
    ).toEqual([...new Set(settings)].sort());
  });

  test("checks health as Compose does, and an unhealthy bot keeps running", async () => {
    const bot = await unit();
    const { healthcheck } = await composeBot();
    // Compose's exec array without Docker's CMD word: Podman runs a JSON array as an exec form.
    expect(healthcheck.test[0]).toBe("CMD");
    expect(JSON.parse(single(bot, "Container", "HealthCmd"))).toEqual(healthcheck.test.slice(1));
    expect(single(bot, "Container", "HealthInterval")).toBe(healthcheck.interval);
    expect(single(bot, "Container", "HealthTimeout")).toBe(healthcheck.timeout);
    expect(single(bot, "Container", "HealthRetries")).toBe(String(healthcheck.retries));
    expect(single(bot, "Container", "HealthStartPeriod")).toBe(healthcheck.start_period);
    // Docker doesn't act on an unhealthy container either; only an exit restarts the bot.
    expect(single(bot, "Container", "HealthOnFailure")).toBe("none");
  });

  test("restarts like Compose's unless-stopped and stops within Compose's grace period", async () => {
    const bot = await unit();
    const compose = await composeBot();
    expect(compose.restart).toBe("unless-stopped");
    expect(single(bot, "Service", "Restart")).toBe("always");
    expect(single(bot, "Unit", "StartLimitIntervalSec")).toBe("0");
    expect(single(bot, "Install", "WantedBy")).toBe("default.target");
    // podman's stop timeout is Compose's grace period, below systemd's own stop timeout so systemd
    // never kills `podman rm` while it waits.
    const stop = Number(single(bot, "Container", "StopTimeout"));
    expect(stop).toBe(seconds(compose.stop_grace_period));
    expect(stop).toBeLessThan(seconds(single(bot, "Service", "TimeoutStopSec")));
  });
});

describe("the targets", () => {
  for (const target of TARGETS)
    test(`${target}'s drop-in only adds its list after the base one`, async () => {
      expect(await dropIn(target)).toEqual([
        {
          section: "Container",
          key: "EnvironmentFile",
          value: `%h/tarubot/${QUADLET}/${target}/target.env`,
          line: expect.any(Number),
        },
      ]);
    });
});

describe("the settings", () => {
  test("the lists are disjoint and never name a secret", async () => {
    const base = namesOf(await baseList());
    for (const target of TARGETS) {
      const own = namesOf(await targetList(target));
      expect({ target, overlap: own.filter((name) => base.includes(name)) }).toEqual({
        target,
        overlap: [],
      });
      expect({ target, secrets: own.filter((name) => FILE_SECRETS.includes(name)) }).toEqual({
        target,
        secrets: [],
      });
    }
    expect(base.filter((name) => FILE_SECRETS.includes(name))).toEqual([]);
  });

  test("with the secrets, production's lists give exactly Compose's bot environment", async () => {
    // Nothing more: the backup settings and TARUBOT_IMAGE_* stay out, as under Compose.
    const compose = await composeSettings();
    const listed = [
      ...namesOf(await baseList()),
      ...namesOf(await targetList("production")),
      ...FILE_SECRETS,
    ];
    expect(listed.sort()).toEqual([...compose.keys()].sort());
  });

  test("fixed values match Compose's, and every defaulted setting passes from .env", async () => {
    const compose = await composeSettings();
    const production = merged(await baseList(), await targetList("production"));
    for (const [name, setting] of compose) {
      if (FILE_SECRETS.includes(name)) continue;
      // A fixed value is fixed here too; a ${X:-d} name is bare, so .env may set it.
      const expected = setting.kind === "fixed" ? setting.value : null;
      expect({ name, value: production.get(name) }).toEqual({ name, value: expected });
    }
  });

  test("Compose's required settings are all file-delivered secrets and check-env.sh requires them", async () => {
    const compose = await composeSettings();
    const required = [...compose].filter(([, s]) => s.kind === "required").map(([name]) => name);
    expect(required.filter((name) => !FILE_SECRETS.includes(name))).toEqual([]);
    expect((await checkEnvList("REQUIRED")).sort()).toEqual(required.sort());
  });

  test("check-env.sh refuses an empty value exactly where Compose's default isn't empty", async () => {
    // Compose used the default for an empty value; the bot reads "" as it is.
    const compose = await composeSettings();
    const notEmpty = [...compose]
      .filter(([, s]) => s.kind === "default" && s.value !== "")
      .map(([name]) => name);
    expect((await checkEnvList("NOT_EMPTY")).sort()).toEqual(notEmpty.sort());
  });

  test("an unset setting gets the bot's own default, which equals Compose's", async () => {
    // Compose filled ${X:-d} in; here a bare name passes nothing when .env doesn't set it, so the
    // bot's zod default applies. Parse the bot's schemas with only the required settings set; the
    // environment is swapped and restored synchronously, so no other code sees it.
    const compose = await composeSettings();
    const saved = new Map([...compose.keys()].map((name) => [name, process.env[name]]));
    let defaults: Record<string, unknown>;
    try {
      for (const name of compose.keys()) delete process.env[name];
      Object.assign(process.env, {
        DATABASE_URL: "postgresql://tarubot:placeholder@localhost:5432/tarubot",
        DISCORD_TOKEN: "placeholder",
        DISCORD_APPLICATION_ID: deployments.production.applicationId,
      });
      // The adapter validates the Lodestone limits in its constructor; a scripted runner keeps it
      // from starting workers, and the limits are read back from the instance.
      const lodestone = new Lodestone({ run: () => Promise.reject(new Error("unused")) });
      defaults = {
        ...configuration(),
        ...(lodestone as unknown as { limits: Record<string, unknown> }).limits,
      };
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    for (const [name, setting] of compose)
      if (setting.kind === "default")
        expect({ name, value: String(defaults[name]) }).toEqual({ name, value: setting.value });
  });

  test("production's list carries production's identity and scoping", async () => {
    const production = merged(await targetList("production"));
    expect(Object.fromEntries(production)).toEqual({
      DISCORD_APPLICATION_ID: deployments.production.applicationId,
      TARUBOT_ENVIRONMENT: "production",
      TEST_GUILD_ID: "",
      PUBLIC_TEST_RESPONSES: "false",
      TEST_PLAN_CHANNEL_ID: "",
      GITHUB_APP_CLIENT_ID: null,
    });
  });

  test("staging lists production's names and differs only in its own keys", async () => {
    const [base, production, staging] = [
      await baseList(),
      await targetList("production"),
      await targetList("staging"),
    ];
    expect(namesOf(staging).sort()).toEqual(namesOf(production).sort());
    expect(namesOf(staging).sort()).toEqual(TARGET_KEYS);
    // Everything else, the base list and Compose's defaults, is shared.
    const [ours, theirs] = [merged(base, production), merged(base, staging)];
    const differ = [...ours.keys()].filter((name) => ours.get(name) !== theirs.get(name));
    expect(differ.every((name) => TARGET_KEYS.includes(name))).toBe(true);
    // DevBot's identity in its test guild, and /suggest off whatever .env holds: it posts
    // publicly, and staging runs PR code.
    expect(Object.fromEntries(merged(staging))).toEqual({
      DISCORD_APPLICATION_ID: deployments.devbot.applicationId,
      TARUBOT_ENVIRONMENT: "staging",
      TEST_GUILD_ID: deployments.devbot.guilds[0],
      PUBLIC_TEST_RESPONSES: "true",
      TEST_PLAN_CHANNEL_ID: null,
      GITHUB_APP_CLIENT_ID: "",
    });
  });
});

/**
 * Shells check-env.sh must work under: /bin/sh is bash on the AlmaLinux hosts and dash on Debian,
 * CI and the image build. Each distinct one available runs every case.
 */
const SHELLS = [
  ...new Map(
    ["sh", "bash", "dash"].flatMap((name) => {
      const path = Bun.which(name);
      return path === null ? [] : [[realpathSync(path), name] as const];
    }),
  ).values(),
];
const SCRIPT = root(`${QUADLET}/check-env.sh`);

/** Run check-env.sh under a shell with exactly the given environment (plus PATH). */
function checkEnv(shell: string, args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync([shell, SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/** Every value used below carries this mark, so no output may contain it. */
const MARK = "VALUE-MARK";
/** A complete environment, as systemd would read a good .env. */
const COMPLETE = {
  DATABASE_URL: `postgresql://tarubot:${MARK}@localhost:5432/tarubot`,
  DATABASE_CA_CERT: `-----BEGIN CERTIFICATE-----\n${MARK}\n-----END CERTIFICATE-----`,
  DISCORD_TOKEN: MARK,
  TARUBOT_IMAGE_DIGEST: `sha256:${"0123456789abcdef".repeat(4)}`,
};

describe("check-env.sh, the settings systemd read", () => {
  test("is POSIX sh", () => {
    expect(Bun.spawnSync(["sh", "-n", SCRIPT]).exitCode).toBe(0);
  });

  for (const shell of SHELLS) {
    test(`${shell}: a complete environment passes quietly`, () => {
      expect(checkEnv(shell, [], COMPLETE)).toEqual({ code: 0, out: "", err: "" });
      expect(
        checkEnv(shell, [], { ...COMPLETE, LOG_LEVEL: "debug", GUEST_COOLDOWN_SECONDS: "0" }),
      ).toEqual({ code: 0, out: "", err: "" });
    });

    test(`${shell}: each refusal names the setting and never shows a value`, () => {
      const cases: [Record<string, string | undefined>, string][] = [
        [{ DATABASE_URL: undefined }, "DATABASE_URL is missing or empty"],
        [{ DATABASE_CA_CERT: "" }, "DATABASE_CA_CERT is missing or empty"],
        [{ DISCORD_TOKEN: "" }, "DISCORD_TOKEN is missing or empty"],
        [{ TARUBOT_IMAGE_DIGEST: undefined }, "TARUBOT_IMAGE_DIGEST must be sha256:"],
        [{ TARUBOT_IMAGE_DIGEST: "sha256:" }, "TARUBOT_IMAGE_DIGEST must be sha256:"],
        [{ TARUBOT_IMAGE_DIGEST: `sha256:${"a".repeat(63)}` }, "TARUBOT_IMAGE_DIGEST"],
        [{ TARUBOT_IMAGE_DIGEST: `sha256:${"A".repeat(64)}` }, "TARUBOT_IMAGE_DIGEST"],
        [{ TARUBOT_IMAGE_DIGEST: `sha512:${"a".repeat(64)}` }, "TARUBOT_IMAGE_DIGEST"],
        [{ TARUBOT_IMAGE_DIGEST: `${"a".repeat(64)}` }, "TARUBOT_IMAGE_DIGEST"],
        [{ TARUBOT_IMAGE_DIGEST: `sha256:${"a".repeat(64)} ` }, "TARUBOT_IMAGE_DIGEST"],
        [{ LOG_LEVEL: "warn" }, "LOG_LEVEL must be trace, debug or info"],
        [{ LOG_LEVEL: "INFO" }, "LOG_LEVEL must be trace, debug or info"],
        [{ LOG_LEVEL: "" }, "LOG_LEVEL is set but empty"],
        [{ GUEST_COOLDOWN_SECONDS: "" }, "GUEST_COOLDOWN_SECONDS is set but empty"],
        [
          { LODESTONE_SELECTOR_CHECK_SECONDS: "" },
          "LODESTONE_SELECTOR_CHECK_SECONDS is set but empty",
        ],
      ];
      for (const [change, message] of cases) {
        const env = Object.fromEntries(
          Object.entries({ ...COMPLETE, ...change }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const result = checkEnv(shell, [], env);
        expect({ change, code: result.code }).toEqual({ change, code: 1 });
        expect(result.err).toContain(message);
        expect(result.out + result.err).not.toContain(MARK);
      }
    });

    test(`${shell}: every problem is named in one run`, () => {
      const result = checkEnv(shell, [], { LOG_LEVEL: "warn", ROSTER_INTERVAL_SECONDS: "" });
      expect(result.code).toBe(1);
      expect(result.err.trim().split("\n")).toHaveLength(6);
    });

    test(`${shell}: a settings list may be set empty only where the default is empty`, async () => {
      // An empty optional setting with an empty default (such as the reports token) is fine.
      expect(checkEnv(shell, [], { ...COMPLETE, GITHUB_REPORTS_TOKEN: "" }).code).toBe(0);
      for (const name of await checkEnvList("NOT_EMPTY"))
        expect({ name, code: checkEnv(shell, [], { ...COMPLETE, [name]: "" }).code }).toEqual({
          name,
          code: 1,
        });
    });

    test(`${shell}: anything but no arguments or --syntax FILE is a usage error`, () => {
      for (const args of [["--syntax"], ["--bogus", "x"], ["a", "b", "c"]])
        expect({ args, code: checkEnv(shell, args, COMPLETE).code }).toEqual({ args, code: 64 });
    });
  }
});

describe("check-env.sh --syntax, the file's lines", () => {
  /** Write a settings file to a fresh directory, run the check on it, and clean up. */
  function syntax(shell: string, text: string) {
    const directory = mkdtempSync(join(tmpdir(), "tarubot-check-env-"));
    try {
      const file = join(directory, ".env");
      writeFileSync(file, text);
      return checkEnv(shell, ["--syntax", file], {});
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /** A file both parsers read the same way, using every form the check allows. */
  const GOOD = [
    "# Staging's settings",
    "TARUBOT_IMAGE_TAG=2.32.0",
    "",
    `DATABASE_URL=postgresql://tarubot:${MARK}@localhost:5432/tarubot`,
    "  # an indented comment",
    `DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----`,
    MARK,
    `-----END CERTIFICATE-----"`,
    `DISCORD_TOKEN='${MARK}$not#expanded"'  `,
    "GITHUB_REPORTS_TOKEN=",
    `SPACED= interior ${MARK} spaces`,
    `HASH=a#${MARK}`,
    `QUOTE=a"${MARK}`,
    "",
  ].join("\n");

  for (const shell of SHELLS) {
    test(`${shell}: a file both parsers read alike passes quietly`, () => {
      expect(syntax(shell, GOOD)).toEqual({ code: 0, out: "", err: "" });
    });

    test(`${shell}: each difference is refused by line and name, never showing a value`, () => {
      const cases: [string, string][] = [
        [`A=${MARK} # comment`, "line 1 (A): an inline comment"],
        [`A=${MARK}\t# comment`, "line 1 (A): an inline comment"],
        [`A="${MARK}" # comment`, "line 1 (A): text after the closing quote"],
        [`A='${MARK}'x`, "line 1 (A): text after the closing quote"],
        [`A=${MARK}\\n`, "line 1 (A): a backslash"],
        [`A="${MARK}\\"`, "line 1 (A): a backslash"],
        [`A='${MARK}\\'`, "line 1 (A): a backslash"],
        [`A=${MARK}$HOME`, "line 1 (A): a $ outside single quotes"],
        [`A="${MARK}\${HOME}"`, "line 1 (A): a $ outside single quotes"],
        [`export A=${MARK}`, "line 1: an export prefix"],
        [`  A=${MARK}`, "line 1: not NAME=value at the start of the line"],
        [`A = ${MARK}`, "line 1: not NAME=value at the start of the line"],
        [`${MARK}`, "line 1: not NAME=value at the start of the line"],
        [`; ${MARK}`, "line 1: not NAME=value at the start of the line"],
        [`A=1\nB=2\nA=${MARK}`, "line 3 (A): assigned again (first on line 1)"],
        [`A=${MARK}\r\nB=2`, "line 1: a carriage return"],
        [`A="${MARK}\nB=${MARK}\n"`, "line 2 (A): a line inside a quoted value"],
        [`A=1\nB="${MARK}\n${MARK}`, "line 2 (B): a quoted value that never closes"],
      ];
      for (const [text, message] of cases) {
        const result = syntax(shell, `${text}\n`);
        expect({ text, code: result.code }).toEqual({ text, code: 1 });
        expect(result.err).toContain(`check-env: ${message}`);
        expect({ text, leaked: (result.out + result.err).includes(MARK) }).toEqual({
          text,
          leaked: false,
        });
      }
    });

    test(`${shell}: a missing file is refused without naming it`, () => {
      const result = checkEnv(shell, ["--syntax", join(tmpdir(), "tarubot-no-such-file")], {});
      expect(result).toEqual({
        code: 1,
        out: "",
        err: "check-env: cannot read the settings file\n",
      });
    });
  }

  test("the repository's settings templates pass, so a host's .env copied from one does too", () => {
    // Every *.env.example at the root, including a staging template once it exists.
    const templates = readdirSync(root("")).filter((name) => /(^|\.)env\.example$/u.test(name));
    expect(templates).toContain(".env.example");
    for (const template of templates)
      expect({ template, ...checkEnv("sh", ["--syntax", root(template)], {}) }).toEqual({
        template,
        code: 0,
        out: "",
        err: "",
      });
  });
});

/**
 * Podman's generator output, when QUADLET_DRYRUN names a directory holding production.txt and
 * staging.txt from `podman-system-generator --user --dryrun` on each layout (README "What Podman
 * generates"). The unit tests above read the source; this reads what systemd will run.
 */
const DRYRUN = process.env.QUADLET_DRYRUN;
describe.skipIf(!DRYRUN)("Podman's generated unit", () => {
  /** Split a generated command line as systemd does for Quadlet's quoting. */
  function words(line: string): string[] {
    const result: string[] = [];
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"' };
    let i = 0;
    while (i < line.length) {
      if (line[i] === " ") {
        i++;
        continue;
      }
      let word = "";
      if (line[i] === '"') {
        for (i++; i < line.length && line[i] !== '"'; i++) {
          if (line[i] !== "\\") word += line[i];
          else if (line[i + 1] === "x") {
            word += String.fromCharCode(Number.parseInt(line.slice(i + 2, i + 4), 16));
            i += 3;
          } else word += escapes[line[++i] ?? ""] ?? "";
        }
        if (line[i] !== '"') throw new Error("an unterminated quoted word");
        i++;
      } else for (; i < line.length && line[i] !== " "; i++) word += line[i];
      result.push(word);
    }
    return result;
  }

  /** The one generated unit's lines, failing unless the output holds exactly tarubot.service. */
  async function generated(target: string): Promise<string[]> {
    const text = await Bun.file(join(DRYRUN ?? "", `${target}.txt`)).text();
    expect(text.match(/^---.*---$/gmu)).toEqual(["---tarubot.service---"]);
    return text.split("\n");
  }

  /** Flags podman run takes with a separate value, as Quadlet writes them. */
  const WITH_VALUE = new Set([
    "--name",
    "--log-driver",
    "--stop-timeout",
    "--pull",
    "--cap-drop",
    "--env-file",
    "--health-cmd",
    "--health-interval",
    "--health-on-failure",
    "--health-retries",
    "--health-start-period",
    "--health-timeout",
  ]);

  for (const target of TARGETS)
    test(`${target}: podman run gets exactly the unit's and Compose's settings`, async () => {
      const lines = await generated(target);
      const execStart = lines.filter((line) => line.startsWith("ExecStart="));
      expect(execStart).toHaveLength(1);
      const argv = words((execStart[0] ?? "").slice("ExecStart=".length));
      expect(argv[0]).toEndWith("/podman");
      expect(argv[1]).toBe("run");
      // The image is last, with ${...} left for systemd: if Podman ever escaped $, this fails
      // here rather than at a restart.
      expect(argv.at(-1)).toBe(`ghcr.io/${repository()}@\${TARUBOT_IMAGE_DIGEST}`);
      // Flag/value pairs, compared as a set: Quadlet writes some flags in map order. Env files
      // keep their order (base first, then the target's), so they are compared as a list.
      const pairs: string[] = [];
      const envFiles: string[] = [];
      const flags = argv.slice(2, -1);
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i] ?? "";
        if (!WITH_VALUE.has(flag)) pairs.push(flag);
        else if (flag === "--env-file") envFiles.push(flags[++i] ?? "");
        else pairs.push(`${flag} ${flags[++i] ?? ""}`);
      }
      const { healthcheck } = await composeBot();
      expect(envFiles).toEqual([
        `%h/tarubot/${QUADLET}/units/tarubot.env`,
        `%h/tarubot/${QUADLET}/${target}/target.env`,
      ]);
      expect(pairs.sort()).toEqual(
        [
          "--name tarubot",
          "--replace",
          "--rm",
          "--log-driver journald",
          "--cgroups=split",
          `--stop-timeout ${seconds((await composeBot()).stop_grace_period)}`,
          "--pull never",
          "--env-host=false",
          "--http-proxy=false",
          "--read-only",
          "--read-only-tmpfs=false",
          "--cap-drop all",
          "--security-opt=no-new-privileges",
          "--sdnotify=conmon",
          "-d",
          `--health-cmd ${JSON.stringify(healthcheck.test.slice(1))}`,
          `--health-interval ${healthcheck.interval}`,
          `--health-timeout ${healthcheck.timeout}`,
          `--health-retries ${healthcheck.retries}`,
          `--health-start-period ${healthcheck.start_period}`,
          "--health-on-failure none",
        ].sort(),
      );
      // The unit waits for the network, IPv6 included, before it starts.
      expect(lines).toContain("Wants=podman-user-wait-network-online.service");
      expect(lines).toContain("After=podman-user-wait-network-online.service");
      // The checks and .env pass through to systemd unchanged.
      expect(lines).toContain("EnvironmentFile=%h/tarubot/.env");
      expect(lines.filter((line) => line.startsWith("ExecStartPre="))).toEqual(
        valuesOf(await unit(), "Service", "ExecStartPre").map((value) => `ExecStartPre=${value}`),
      );
    });
});
