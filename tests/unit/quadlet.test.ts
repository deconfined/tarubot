/**
 * TaruBot's rootless Quadlet unit and its settings file (#50; since #62 rendered by the release's
 * ops/ansible/bot.yml from ops/ansible/templates/bot/). These read staging's rendering, made by
 * tests/fixtures/bot-render.ts with the identity src/config/deployment.ts gives staging, as a host
 * would get it. They pin:
 * - the unit: its keys and sections, the one repository at the plan's digest with no pull at start,
 *   journald, one settings file, the secrets as read-only files, migrate.js before every start in
 *   the unit's own image, and the health check, restarts and stopping of the bot's service in
 *   docker-compose.production.yml;
 * - the settings file: the fixed settings, the target's, the identity and one NAME_FILE line per
 *   mounted secret; with the secrets, Compose's bot environment, and every setting it leaves out
 *   defaulting to Compose's value in the bot itself;
 * - with QUADLET_DRYRUN set, Podman's own generator output over the renderer's CLI copy (CI).
 * The hardening itself is pinned beside Compose's in container-hardening.test.ts, and the play
 * that renders both in bot-play.test.ts.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { deployments, resolveDeployment } from "../../src/config/deployment.js";
import { configuration } from "../../src/config/env.js";
import { FILE_SETTINGS } from "../../src/config/secrets.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { renderStaging, SAMPLE_DIGEST } from "../fixtures/bot-render.js";
import {
  keysOf,
  namesOf,
  parseEnvFile,
  parseUnit,
  read,
  sectionsOf,
  single,
  valuesOf,
} from "../fixtures/quadlet.js";

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

/** Staging's secrets, as vars/targets/staging.yml declares them: every one but the App key. */
const STAGING_SECRETS = FILE_SETTINGS.filter((name) => name !== "GITHUB_APP_PRIVATE_KEY");
/** A secret's mount: Podman secret tarubot-<name, lower, dashes>, file /run/secrets/<name, lower>. */
const mountOf = (name: string) =>
  `tarubot-${name.toLowerCase().replaceAll("_", "-")},type=mount,target=/run/secrets/${name.toLowerCase()},uid=1000,gid=1000,mode=0400`;
/** The settings that differ by target, which Compose fixes for production. */
const TARGET_KEYS = [
  "DISCORD_APPLICATION_ID",
  "GITHUB_APP_CLIENT_ID",
  "PUBLIC_TEST_RESPONSES",
  "TARUBOT_ENVIRONMENT",
  "TEST_GUILD_ID",
  "TEST_PLAN_CHANNEL_ID",
];

/** Staging's rendering with the identity the release image reports for it. */
async function staging(digest = `sha256:${"5a".repeat(32)}`) {
  const identity = resolveDeployment({ TARUBOT_ENVIRONMENT: "staging" });
  const rendered = await renderStaging(digest, {
    applicationId: identity.applicationId ?? "",
    registrationScope: identity.registrationScope,
  });
  return {
    digest,
    unit: parseUnit(rendered.container, "tarubot.container"),
    env: parseEnvFile(rendered.env, "tarubot.env"),
  };
}

/** The bot's service in docker-compose.production.yml, the parity reference until 2.37.0. */
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

describe("the unit", () => {
  test("uses only the keys the design names, in the sections systemd and Quadlet expect", async () => {
    // A new key is a deliberate change here. [Container] keys become podman run flags; the rest
    // pass to systemd unchanged.
    const { unit } = await staging();
    expect(sectionsOf(unit)).toEqual(["Unit", "Container", "Service", "Install"]);
    expect(keysOf(unit, "Unit")).toEqual(["Description", "StartLimitIntervalSec"]);
    expect(keysOf(unit, "Container")).toEqual(
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
        "Secret",
        "StopTimeout",
      ].sort(),
    );
    expect(keysOf(unit, "Service")).toEqual(
      [
        "ExecStartPre",
        "Restart",
        "RestartMaxDelaySec",
        "RestartSec",
        "RestartSteps",
        "TimeoutStartSec",
        "TimeoutStopSec",
      ].sort(),
    );
    expect(keysOf(unit, "Install")).toEqual(["WantedBy"]);
    expect(single(unit, "Container", "ContainerName")).toBe("tarubot");
  });

  test("uses no key that mounts, publishes, maps users or bypasses the settings file", async () => {
    // Each would change what the container can reach or how its settings arrive. Secret= is
    // allowed only as the secrets test below pins it; AutoUpdate= would replace the pinned image.
    const forbidden =
      /^(PodmanArgs|GlobalArgs|Volume|Mount|Tmpfs|VolatileTmp|PublishPort|ExposeHostPort|AddCapability|AddDevice|SecurityLabel\w*|SeccompProfile|AppArmor|Unmask|User|Group|GroupAdd|UserNS|UIDMap|GIDMap|SubUIDMap|SubGIDMap|Network|Pod|Rootfs|AutoUpdate|ContainersConfModule|Sysctl|Environment|Exec|Entrypoint)$/u;
    for (const line of (await staging()).unit.filter((l) => l.section === "Container"))
      expect({ key: line.key, forbidden: forbidden.test(line.key) }).toEqual({
        key: line.key,
        forbidden: false,
      });
  });

  test("runs the one repository at the plan's digest, and never pulls at start", async () => {
    const { unit, digest } = await staging();
    expect(single(unit, "Container", "Image")).toBe(`ghcr.io/${repository()}@${digest}`);
    // A start or reboot never contacts GHCR; bot.yml pulled and checked the digest first.
    expect(single(unit, "Container", "Pull")).toBe("never");
    expect(valuesOf(unit, "Container", "AutoUpdate")).toEqual([]);
    expect(single(unit, "Container", "LogDriver")).toBe("journald");
  });

  test("hands the container one settings file and nothing from Podman's environment", async () => {
    const { unit } = await staging();
    expect(valuesOf(unit, "Container", "EnvironmentFile")).toEqual([
      "%h/.config/tarubot/tarubot.env",
    ]);
    expect(single(unit, "Container", "EnvironmentHost")).toBe("false");
    expect(single(unit, "Container", "HttpProxy")).toBe("false");
    // No .env any more: systemd reads no settings file and unsets nothing.
    expect(valuesOf(unit, "Service", "EnvironmentFile")).toEqual([]);
    expect(valuesOf(unit, "Service", "UnsetEnvironment")).toEqual([]);
    expect(unit.some((line) => /(^|\/)\.env\b/u.test(line.value))).toBe(false);
  });

  test("runs migrate.js before every start, in the unit's own image, within 15 minutes", async () => {
    const { unit } = await staging();
    // Only this: the old unit's check-env.sh and secrets.sh runs are gone.
    expect(valuesOf(unit, "Service", "ExecStartPre")).toEqual([
      `%h/.local/bin/tarubot-tool --image ${single(unit, "Container", "Image")} migrate.js`,
    ]);
    expect(single(unit, "Service", "TimeoutStartSec")).toBe("15min");
  });

  test("mounts staging's five secrets as files only the bot's bun user reads", async () => {
    const { unit } = await staging();
    expect(valuesOf(unit, "Container", "Secret")).toEqual(STAGING_SECRETS.map(mountOf));
    // Bun's official Alpine base keeps uid/gid 1000; runtime inherits it after package upgrades.
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toMatch(/^FROM oven\/bun:[0-9.]+-alpine AS base$/mu);
    expect(dockerfile).toMatch(/^FROM base AS runtime$/mu);
    expect(dockerfile).toMatch(/^USER bun$/mu);
    // Podman mounts its per-container copy read-only only because the container is.
    expect(single(unit, "Container", "ReadOnly")).toBe("true");
  });

  test("checks health as Compose does, and an unhealthy bot keeps running", async () => {
    const { unit } = await staging();
    const { healthcheck } = await composeBot();
    // Compose's exec array without Docker's CMD word: Podman runs a JSON array as an exec form.
    expect(healthcheck.test[0]).toBe("CMD");
    expect(JSON.parse(single(unit, "Container", "HealthCmd"))).toEqual(healthcheck.test.slice(1));
    expect(single(unit, "Container", "HealthInterval")).toBe(healthcheck.interval);
    expect(single(unit, "Container", "HealthTimeout")).toBe(healthcheck.timeout);
    expect(single(unit, "Container", "HealthRetries")).toBe(String(healthcheck.retries));
    expect(single(unit, "Container", "HealthStartPeriod")).toBe(healthcheck.start_period);
    // Docker doesn't act on an unhealthy container either; only an exit restarts the bot.
    expect(single(unit, "Container", "HealthOnFailure")).toBe("none");
  });

  test("restarts like Compose's unless-stopped and stops within Compose's grace period", async () => {
    const { unit } = await staging();
    const compose = await composeBot();
    expect(compose.restart).toBe("unless-stopped");
    expect(single(unit, "Service", "Restart")).toBe("always");
    expect(single(unit, "Service", "RestartSec")).toBe("1s");
    expect(single(unit, "Service", "RestartSteps")).toBe("6");
    expect(single(unit, "Service", "RestartMaxDelaySec")).toBe("60s");
    expect(single(unit, "Unit", "StartLimitIntervalSec")).toBe("0");
    expect(single(unit, "Install", "WantedBy")).toBe("default.target");
    // podman's stop timeout is Compose's grace period, below systemd's own stop timeout so systemd
    // never kills `podman rm` while it waits.
    const stop = Number(single(unit, "Container", "StopTimeout"));
    expect(stop).toBe(seconds(compose.stop_grace_period));
    expect(stop).toBeLessThan(seconds(single(unit, "Service", "TimeoutStopSec")));
  });
});

describe("the settings file", () => {
  test("the fixed settings, staging's, the identity, then one NAME_FILE line per mounted secret", async () => {
    const { env, unit } = await staging();
    expect(env).toEqual([
      { name: "HEALTH_PORT", value: "3000" },
      { name: "ENABLE_EFFECTS", value: "true" },
      { name: "TARUBOT_ENVIRONMENT", value: "staging" },
      { name: "PUBLIC_TEST_RESPONSES", value: "true" },
      { name: "GITHUB_APP_CLIENT_ID", value: "" },
      { name: "DISCORD_APPLICATION_ID", value: deployments.devbot.applicationId },
      { name: "TEST_GUILD_ID", value: deployments.devbot.guilds[0] },
      ...STAGING_SECRETS.map((name) => ({
        name: `${name}_FILE`,
        value: `/run/secrets/${name.toLowerCase()}`,
      })),
    ]);
    // Each NAME_FILE line names exactly a file the unit mounts, and nothing else is mounted.
    const mounted = valuesOf(unit, "Container", "Secret").map(
      (value) => /,target=([^,]+),/u.exec(value)?.[1] ?? value,
    );
    expect(env.filter((entry) => entry.name.endsWith("_FILE")).map((entry) => entry.value)).toEqual(
      mounted,
    );
    // No secret is ever a plain entry.
    const secrets: readonly string[] = FILE_SETTINGS;
    expect(namesOf(env).filter((name) => secrets.includes(name))).toEqual([]);
  });

  test("with the secrets, it covers Compose's bot environment; what it leaves out defaults to Compose's value", async () => {
    // Every Compose setting is a file-delivered secret, a target key, a fixed value the file sets
    // to Compose's, or a defaulted one the file leaves to the bot's own default (checked below).
    const compose = await composeSettings();
    const env = new Map((await staging()).env.map((entry) => [entry.name, entry.value]));
    const secrets: readonly string[] = FILE_SETTINGS;
    for (const [name, setting] of compose) {
      if (secrets.includes(name) || TARGET_KEYS.includes(name)) continue;
      if (setting.kind === "fixed")
        expect({ name, value: env.get(name) }).toEqual({ name, value: setting.value });
      else
        expect({ name, kind: setting.kind, set: env.has(name) }).toEqual({
          name,
          kind: "default",
          set: false,
        });
    }
    // Staging's secrets are required; the App key it never holds defaults to "" in the bot.
    expect([...compose].filter(([, s]) => s.kind === "required").map(([name]) => name)).toEqual([
      "DATABASE_URL",
      "DATABASE_CA_CERT",
      "DISCORD_TOKEN",
    ]);
    // And nothing beyond Compose's names, apart from the NAME_FILE lines.
    for (const name of env.keys())
      if (!name.endsWith("_FILE"))
        expect({ name, compose: compose.has(name) }).toEqual({ name, compose: true });
  });

  test("an unset setting gets the bot's own default, which equals Compose's", async () => {
    // Compose filled ${X:-d} in; the settings file leaves such a name out, so the bot's zod default
    // applies. Parse the bot's schemas with only the required settings set.
    const compose = await composeSettings();
    const env = {
      DATABASE_URL: "postgresql://tarubot:placeholder@localhost:5432/tarubot",
      DISCORD_TOKEN: "placeholder",
      DISCORD_APPLICATION_ID: deployments.production.applicationId,
    };
    // The adapter validates the Lodestone limits in its constructor, reading process.env; a
    // scripted runner keeps it from starting workers, and the environment is swapped and restored
    // synchronously, so no other code sees it.
    const saved = new Map([...compose.keys()].map((name) => [name, process.env[name]]));
    let limits: Record<string, unknown>;
    try {
      for (const name of compose.keys()) delete process.env[name];
      const lodestone = new Lodestone({ run: () => Promise.reject(new Error("unused")) });
      limits = (lodestone as unknown as { limits: Record<string, unknown> }).limits;
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    const defaults: Record<string, unknown> = { ...configuration(env), ...limits };
    for (const [name, setting] of compose)
      if (setting.kind === "default")
        expect({ name, value: String(defaults[name]) }).toEqual({ name, value: setting.value });
  });
});

/**
 * Podman's generator output, when QUADLET_DRYRUN names a directory holding staging.txt: CI runs
 * `podman-system-generator --user --dryrun` in the pinned Podman image over the renderer's CLI
 * copy (bun tests/fixtures/bot-render.ts .cache/bot). The tests above read the source; this reads
 * what systemd will run.
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
    "--secret",
  ]);

  test("the output holds exactly tarubot.service, and podman run gets exactly the unit's settings", async () => {
    const text = await Bun.file(join(DRYRUN ?? "", "staging.txt")).text();
    expect(text.match(/^---.*---$/gmu)).toEqual(["---tarubot.service---"]);
    const lines = text.split("\n");
    const execStart = lines.filter((line) => line.startsWith("ExecStart="));
    expect(execStart).toHaveLength(1);
    const argv = words((execStart[0] ?? "").slice("ExecStart=".length));
    expect(argv[0]).toEndWith("/podman");
    expect(argv[1]).toBe("run");
    // The image is last: the one repository at the renderer's sample digest.
    const image = `ghcr.io/${repository()}@${SAMPLE_DIGEST}`;
    expect(argv.at(-1)).toBe(image);
    // Flag/value pairs, compared as a set: Quadlet writes some flags in map order.
    const pairs: string[] = [];
    const flags = argv.slice(2, -1);
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i] ?? "";
      pairs.push(WITH_VALUE.has(flag) ? `${flag} ${flags[++i] ?? ""}` : flag);
    }
    const compose = await composeBot();
    const { healthcheck } = compose;
    expect(pairs.sort()).toEqual(
      [
        "--name tarubot",
        "--replace",
        "--rm",
        "--log-driver journald",
        "--cgroups=split",
        `--stop-timeout ${seconds(compose.stop_grace_period)}`,
        "--pull never",
        "--env-host=false",
        "--http-proxy=false",
        "--read-only",
        "--read-only-tmpfs=false",
        "--cap-drop all",
        "--security-opt=no-new-privileges",
        "--sdnotify=conmon",
        "-d",
        "--env-file %h/.config/tarubot/tarubot.env",
        `--health-cmd ${JSON.stringify(healthcheck.test.slice(1))}`,
        `--health-interval ${healthcheck.interval}`,
        `--health-timeout ${healthcheck.timeout}`,
        `--health-retries ${healthcheck.retries}`,
        `--health-start-period ${healthcheck.start_period}`,
        "--health-on-failure none",
        ...STAGING_SECRETS.map((name) => `--secret ${mountOf(name)}`),
      ].sort(),
    );
    // The unit waits for the network, IPv6 included, before it starts, and migrate.js passes
    // through to systemd with the same image.
    expect(lines).toContain("Wants=podman-user-wait-network-online.service");
    expect(lines).toContain("After=podman-user-wait-network-online.service");
    expect(lines.filter((line) => line.startsWith("ExecStartPre="))).toEqual([
      `ExecStartPre=%h/.local/bin/tarubot-tool --image ${image} migrate.js`,
    ]);
    expect(lines.some((line) => line.startsWith("UnsetEnvironment="))).toBe(false);
  });
});
