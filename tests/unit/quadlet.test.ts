/**
 * TaruBot's rootless Quadlet unit (#50, ops/quadlet/; ops/quadlet/README.md has the design). The
 * release owns the unit, the setting lists, check-env.sh, secrets.sh and run-tool.sh; each Podman
 * host links units/ and one target directory into the tarubot user's Quadlet search path. These
 * pin:
 * - the files: the exact set, the rule that only units/ holds Quadlet units, and the house rules
 *   that keep the readers in tests/fixtures/quadlet.ts exact;
 * - the unit: its keys, the fixed image repository with a digest pin, no pull at start, journald,
 *   the health check, restarts and stopping, all mapped from docker-compose.production.yml;
 * - the secrets (2.33.0): the Secret= mounts and NAME_FILE lines, the 14 names the unit unsets,
 *   and the lists of them that src/config/secrets.ts, secrets.sh, run-tool.sh and ops/deploy.sh
 *   keep, all equal;
 * - the settings: the lists plus the file-delivered secrets give exactly Compose's bot environment,
 *   with Compose's fixed values, and unset names fall back to the bot's defaults, which equal
 *   Compose's; staging differs from production only in its own keys; every name in the settings
 *   templates is either listed for the container or unset;
 * - check-env.sh, secrets.sh and run-tool.sh, run for real (the last two with stand-ins for podman
 *   and systemd-run), printing names and never values;
 * - with QUADLET_DRYRUN set, Podman's own generator output (README "What Podman generates").
 * The hardening itself is pinned beside Compose's in container-hardening.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { deployments } from "../../src/config/deployment.js";
import { configuration } from "../../src/config/env.js";
import { FILE_SETTINGS } from "../../src/config/secrets.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import {
  baseList,
  directoriesUnder,
  dropIn,
  type EnvEntry,
  filesUnder,
  keysOf,
  merged,
  namesOf,
  QUADLET,
  read,
  root,
  sectionsOf,
  type Target,
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

/**
 * Each secret's Podman secret and its file in the bot, in the unit's order (interfaces §8): the
 * secret is tarubot- and the name in lower case with dashes, the file /run/secrets/ and the name in
 * lower case. The GitHub App key is mounted only on production, through its drop-in.
 */
const SECRET_MOUNTS = [
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "DISCORD_TOKEN",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_PING_URL",
  "GITHUB_APP_PRIVATE_KEY",
].map((name) => ({
  name,
  secret: `tarubot-${name.toLowerCase().replaceAll("_", "-")}`,
  target: `/run/secrets/${name.toLowerCase()}`,
  production: name === "GITHUB_APP_PRIVATE_KEY",
}));
/** A Secret= value as the unit writes it: a mounted file only the bot's bun user may read. */
const secretLine = (mount: { secret: string; target: string }) =>
  `${mount.secret},type=mount,target=${mount.target},uid=1000,gid=1000,mode=0400`;

/**
 * The unit's UnsetEnvironment=, in its order (interfaces §8): ops/backup.sh's settings, the six
 * secrets, and three names a .env may hold that the bot never needs. ops/deploy.sh and
 * ops/quadlet/run-tool.sh hold the same line.
 */
const UNSET = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "BACKUP_STORAGE_REGION",
  "HEALTHCHECKS_BACKUP_URL",
  ...FILE_SECRETS,
  "POSTGRES_PASSWORD",
  "RESTORE_DATABASE_CA_CERT",
  "RESTORE_DATABASE_URL",
];

/** The names staging's list may set differently from production's. */
const TARGET_KEYS = [
  "DISCORD_APPLICATION_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_PRIVATE_KEY_FILE",
  "PUBLIC_TEST_RESPONSES",
  "TARUBOT_ENVIRONMENT",
  "TEST_GUILD_ID",
  "TEST_PLAN_CHANNEL_ID",
];

/** A list's NAME_FILE entries, by the setting they deliver. */
const fileEntries = (entries: EnvEntry[]) =>
  entries.filter((entry) => entry.name.endsWith("_FILE"));
/** A list's names other than NAME_FILE ones. */
const plainNames = (entries: EnvEntry[]) =>
  namesOf(entries).filter((name) => !name.endsWith("_FILE"));

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

/** A `readonly NAME='A B C'` list of names in a shell script, read from the script itself. */
async function shellList(path: string, name: string): Promise<string[]> {
  const match = new RegExp(`^readonly ${name}='([A-Z0-9_ ]+)'$`, "mu").exec(await read(path));
  if (!match?.[1]) throw new Error(`${path} has no readonly ${name} list`);
  return match[1].split(" ");
}
/** check-env.sh's list, read from the script itself (its one copy). */
const checkEnvList = (name: "NOT_EMPTY") => shellList(`${QUADLET}/check-env.sh`, name);

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
  test("ops/quadlet holds exactly the release's Quadlet files, and its scripts are executable", () => {
    expect(filesUnder(QUADLET)).toEqual([
      "README.md",
      "check-env.sh",
      "production/target.env",
      "production/tarubot.container.d/50-target.conf",
      "run-tool.sh",
      "secrets.sh",
      "staging/target.env",
      "staging/tarubot.container.d/50-target.conf",
      "units/tarubot.container",
      "units/tarubot.env",
    ]);
    // The unit runs check-env.sh and secrets.sh as ExecStartPre; a deploy runs all three.
    for (const script of ["check-env.sh", "secrets.sh", "run-tool.sh"])
      expect({ script, mode: statSync(root(`${QUADLET}/${script}`)).mode & 0o111 }).toEqual({
        script,
        mode: 0o111,
      });
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
        "Secret",
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
    // the lists and #51's hardening decide. Secret= is allowed only as "the secrets" below pin it;
    // AutoUpdate= would let podman auto-update replace the pinned image.
    const forbidden =
      /^(PodmanArgs|GlobalArgs|Volume|Mount|Tmpfs|VolatileTmp|PublishPort|ExposeHostPort|AddCapability|AddDevice|SecurityLabel\w*|SeccompProfile|AppArmor|Unmask|User|Group|GroupAdd|UserNS|UIDMap|GIDMap|SubUIDMap|SubGIDMap|Network|Pod|Rootfs|AutoUpdate|ContainersConfModule|Sysctl|Environment|Exec|Entrypoint)$/u;
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
    // Before every start, in this order: the file's lines, then what systemd read, then the
    // secrets copied from the file into Podman secrets (interfaces §8).
    expect(valuesOf(bot, "Service", "ExecStartPre")).toEqual([
      `%h/tarubot/${QUADLET}/check-env.sh --syntax %h/tarubot/.env`,
      `%h/tarubot/${QUADLET}/check-env.sh`,
      `%h/tarubot/${QUADLET}/secrets.sh sync %h/tarubot/.env`,
    ]);
  });

  test("unsets exactly the 14 names: the backup's settings, the secrets and three the bot never needs", async () => {
    // systemd reads the whole .env, and Podman, conmon and pasta keep the service's environment
    // for the container's lifetime, so nothing secret may stay in it.
    expect(single(await unit(), "Service", "UnsetEnvironment")).toBe(UNSET.join(" "));
    // Compose never passed ops/backup.sh's settings to the bot; every one it reads is unset.
    const backup = await read("ops/backup.sh");
    const settings = [...backup.matchAll(/\$\(setting ([A-Z0-9_]+)\)/gu)].map((m) => m[1] ?? "");
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.filter((name) => !UNSET.includes(name))).toEqual([]);
  });

  test("ops/deploy.sh and run-tool.sh unset the same 14 names, in the same order", async () => {
    // deploy.sh's settings check (systemd-run) and every one-off tool run under the unit's rules.
    expect(await shellList("ops/deploy.sh", "UNSET_SETTINGS")).toEqual(UNSET);
    expect(await shellList(`${QUADLET}/run-tool.sh`, "UNSET_SETTINGS")).toEqual(UNSET);
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
    test(`${target}'s drop-in only adds its list after the base one, and production's the app key`, async () => {
      // /suggest posts only in production, so only production's drop-in mounts the app's key.
      const secrets = SECRET_MOUNTS.filter((mount) => mount.production && target === "production");
      expect(await dropIn(target)).toEqual([
        {
          section: "Container",
          key: "EnvironmentFile",
          value: `%h/tarubot/${QUADLET}/${target}/target.env`,
          line: expect.any(Number),
        },
        ...secrets.map((mount) => ({
          section: "Container",
          key: "Secret",
          value: secretLine(mount),
          line: expect.any(Number),
        })),
      ]);
    });
});

describe("the secrets (2.33.0)", () => {
  test("every host mounts five secrets as files only the bot's bun user reads; production adds the app key", async () => {
    // The table of interfaces §8, in its order: the unit carries every host's five.
    expect(valuesOf(await unit(), "Container", "Secret")).toEqual(
      SECRET_MOUNTS.filter((mount) => !mount.production).map(secretLine),
    );
    // Only the unit and production's drop-in carry Secret= (the drop-ins are pinned above).
    expect(SECRET_MOUNTS.filter((mount) => mount.production).map((m) => m.name)).toEqual([
      "GITHUB_APP_PRIVATE_KEY",
    ]);
  });

  test("uid and gid 1000 are the image's bun user, which the bot runs as", async () => {
    // The runtime stage (and so the bot's image) runs as the base image's bun user, uid and gid
    // 1000 in oven/bun (README "What Podman generates").
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toMatch(/^FROM oven\/bun:[0-9.]+ AS runtime$/mu);
    expect(dockerfile).toMatch(/^USER bun$/mu);
  });

  test("a container that mounts a secret is read-only, which is what makes the mount read-only", async () => {
    // Podman bind-mounts its per-container copy of each secret, and adds ro to that mount only
    // for a read-only container (README "What Podman generates").
    expect(single(await unit(), "Container", "ReadOnly")).toBe("true");
    const runTool = await read(`${QUADLET}/run-tool.sh`);
    expect(runTool).toMatch(/ --read-only --read-only-tmpfs=false /u);
  });

  test("the lists tell the bot where each mounted file is, and name no secret itself", async () => {
    // Every host's five in the base list, the app key's in each target's: production's names the
    // file its drop-in mounts, staging's is empty, which the bot reads as unset.
    expect(fileEntries(await baseList())).toEqual(
      SECRET_MOUNTS.filter((mount) => !mount.production).map((mount) => ({
        name: `${mount.name}_FILE`,
        value: mount.target,
      })),
    );
    const appKey = SECRET_MOUNTS.find((mount) => mount.production);
    expect(fileEntries(await targetList("production"))).toEqual([
      { name: "GITHUB_APP_PRIVATE_KEY_FILE", value: appKey?.target ?? "" },
    ]);
    expect(fileEntries(await targetList("staging"))).toEqual([
      { name: "GITHUB_APP_PRIVATE_KEY_FILE", value: "" },
    ]);
    // For each target, the files the lists name are exactly the files its container mounts.
    for (const target of TARGETS) {
      const lists = [...(await baseList()), ...(await targetList(target))];
      const named = fileEntries(lists)
        .map((entry) => entry.value ?? "")
        .filter((value) => value !== "");
      const mounted = [
        ...valuesOf(await unit(), "Container", "Secret"),
        ...valuesOf(await dropIn(target), "Container", "Secret"),
      ].map((value) => /,target=([^,]+),/u.exec(value)?.[1] ?? value);
      expect({ target, named: named.sort() }).toEqual({ target, named: mounted.sort() });
    }
  });

  test("src/config/secrets.ts, secrets.sh and ops/deploy.sh name the same six secrets", async () => {
    expect<string[]>([...FILE_SETTINGS]).toEqual(FILE_SECRETS);
    expect(await shellList(`${QUADLET}/secrets.sh`, "SETTINGS")).toEqual(FILE_SECRETS);
    expect(await shellList("ops/deploy.sh", "SECRET_SETTINGS")).toEqual(FILE_SECRETS);
  });

  test("run-tool.sh mounts the unit's secrets, and production's drop-in's only for production", async () => {
    // Its flags are constants; these pin them to the unit files they copy.
    const text = await read(`${QUADLET}/run-tool.sh`);
    const array = (name: string) => {
      const match = new RegExp(`^readonly ${name}=\\(\n((?:  '[^'\n]+'\n)+)\\)$`, "mu").exec(text);
      if (!match?.[1]) throw new Error(`run-tool.sh has no readonly ${name} array`);
      return match[1]
        .trim()
        .split("\n")
        .map((line) => line.trim().slice(1, -1));
    };
    expect(array("SECRETS")).toEqual(valuesOf(await unit(), "Container", "Secret"));
    expect(array("PRODUCTION_SECRETS")).toEqual(
      valuesOf(await dropIn("production"), "Container", "Secret"),
    );
    expect(valuesOf(await dropIn("staging"), "Container", "Secret")).toEqual([]);
  });
});

describe("the settings", () => {
  test("the lists are disjoint and never name a secret", async () => {
    // A secret's NAME_FILE line is fine: it holds a path, never the value.
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
    // Nothing more: the backup settings and TARUBOT_IMAGE_* stay out, as under Compose. The six
    // secrets arrive as files, through exactly one NAME_FILE line each.
    const compose = await composeSettings();
    const lists = [...(await baseList()), ...(await targetList("production"))];
    expect([...plainNames(lists), ...FILE_SECRETS].sort()).toEqual([...compose.keys()].sort());
    expect(
      fileEntries(lists)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(FILE_SECRETS.map((name) => `${name}_FILE`));
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

  test("Compose's required settings are all file-delivered secrets and secrets.sh requires them", async () => {
    // The unit unsets them before check-env.sh runs, so secrets.sh checks them in .env itself.
    const compose = await composeSettings();
    const required = [...compose].filter(([, s]) => s.kind === "required").map(([name]) => name);
    expect(required.filter((name) => !FILE_SECRETS.includes(name))).toEqual([]);
    expect((await shellList(`${QUADLET}/secrets.sh`, "REQUIRED")).sort()).toEqual(required.sort());
    expect(await read(`${QUADLET}/check-env.sh`)).not.toMatch(/^readonly REQUIRED=/mu);
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
      GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github_app_private_key",
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
      // Staging never mounts the app's key; empty reads as unset.
      GITHUB_APP_PRIVATE_KEY_FILE: "",
    });
  });

  test("every name a settings template holds is either listed for the container, unset, or the host's", async () => {
    // A name in none of these would pass from .env into Podman's and conmon's environment without
    // reaching the bot; a name in two would be both passed and unset. RESTORE_DATABASE_URL isn't
    // in a template (operators add it for check-restore), but a .env may hold it.
    const templates = readdirSync(root("")).filter((name) => /(^|\.)env\.example$/u.test(name));
    expect(templates.sort()).toEqual([
      ".env.example",
      "production.env.example",
      "staging.env.example",
    ]);
    const names = new Set(["RESTORE_DATABASE_URL"]);
    for (const template of templates)
      for (const match of (await read(template)).matchAll(/^([A-Z][A-Z0-9_]*)=/gmu))
        names.add(match[1] ?? "");
    const listed = new Set([
      ...namesOf(await baseList()),
      ...(await Promise.all(TARGETS.map(targetList))).flatMap(namesOf),
    ]);
    // The host's own: the image pin (systemd and deploy.sh read it; the unit fixes the repository),
    // and TEST_PLAN_FILE, which only docker-compose.yml passes; the bot defaults to the image's plan.
    const host = new Set([
      "TARUBOT_IMAGE",
      "TARUBOT_IMAGE_TAG",
      "TARUBOT_IMAGE_DIGEST",
      "TEST_PLAN_FILE",
    ]);
    for (const name of names) {
      const places = [listed.has(name), UNSET.includes(name), host.has(name)].filter(Boolean);
      expect({ name, places: places.length }).toEqual({ name, places: 1 });
    }
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
/**
 * A complete environment, as systemd reads a good .env after the unit's UnsetEnvironment=: no
 * secret is left in it (2.33.0), and two ordinary settings carry the mark.
 */
const COMPLETE = {
  TARUBOT_IMAGE_DIGEST: `sha256:${"0123456789abcdef".repeat(4)}`,
  GITHUB_REPORTS_REPO: `deconfined/${MARK}`,
  TEST_PLAN_CHANNEL_ID: MARK,
};
/** The three secrets Compose requires, which secrets.sh checks in .env instead. */
const REQUIRED_SECRETS = {
  DATABASE_URL: `postgresql://tarubot:${MARK}@localhost:5432/tarubot`,
  DATABASE_CA_CERT: `-----BEGIN CERTIFICATE-----\n${MARK}\n-----END CERTIFICATE-----`,
  DISCORD_TOKEN: MARK,
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

    test(`${shell}: the secrets aren't its to check, set, empty or missing`, () => {
      // The unit unsets them before this runs (secrets.sh checks them in .env); a stray value
      // here changes nothing and is never shown.
      expect(checkEnv(shell, [], { ...COMPLETE, ...REQUIRED_SECRETS })).toEqual({
        code: 0,
        out: "",
        err: "",
      });
      const empty = Object.fromEntries(Object.keys(REQUIRED_SECRETS).map((name) => [name, ""]));
      expect(checkEnv(shell, [], { ...COMPLETE, ...empty })).toEqual({ code: 0, out: "", err: "" });
    });

    test(`${shell}: each refusal names the setting and never shows a value`, () => {
      const cases: [Record<string, string | undefined>, string][] = [
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
      // The digest, the log level and the empty interval.
      const result = checkEnv(shell, [], { LOG_LEVEL: "warn", ROSTER_INTERVAL_SECONDS: "" });
      expect(result.code).toBe(1);
      expect(result.err.trim().split("\n")).toHaveLength(3);
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
    // PEM body lines that look like NAME=: base64 letters and digits, then padding.
    "MIIBkTCBAAIJAKHBfpegPjMCMA0GCSqGSIb3DQEBBQUAMBExDzANBgNVBAMMBnVu",
    "Zm9vYmFyYmF6cXV4==",
    "MIIC0w=",
    `-----END CERTIFICATE-----"`,
    `DISCORD_TOKEN='${MARK}$not#expanded"'  `,
    "GITHUB_REPORTS_TOKEN=",
    `SPACED= interior ${MARK} spaces`,
    `HASH=a#${MARK}`,
    // A quote after the first character is literal to both parsers.
    `QUOTE=a"${MARK}`,
    `PASSWORD=pa'sw${MARK}`,
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
        [`A="${MARK}\nB_C=${MARK}\n"`, "line 2 (A): a line inside a quoted value"],
        [`A="${MARK}\nTARUBOT_IMAGE_TAG=2.30.0\n"`, "line 2 (A): a line inside a quoted value"],
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

  test("every setting the host scripts read has a _ in its name, which base64 never has", () => {
    // check-env.sh refuses a NAME= line inside a quoted value only when NAME has a "_", so a
    // multi-line PEM (DATABASE_CA_CERT, GITHUB_APP_PRIVATE_KEY) whose padding line looks like
    // NAME= still passes. That is safe only while deploy.sh and backup.sh read no name without one.
    // A name with a lower-case letter is a systemd property deploy.sh reads from `systemctl show`
    // (ActiveState=), never a setting: every setting is upper case.
    const names = new Set<string>();
    for (const script of ["ops/deploy.sh", "ops/backup.sh"]) {
      const text = readFileSync(root(script), "utf8");
      for (const match of text.matchAll(/\^([A-Za-z_][A-Za-z0-9_]*)=/gu))
        if (!/[a-z]/u.test(match[1] ?? "")) names.add(match[1] ?? "");
      for (const match of text.matchAll(/\$\(setting ([A-Za-z_][A-Za-z0-9_]*)\)/gu))
        names.add(match[1] ?? "");
    }
    expect([...names]).toContain("TARUBOT_IMAGE_TAG");
    expect([...names]).toContain("BACKUP_STORAGE_SECRET_KEY");
    for (const name of names)
      expect({ name, underscore: name.includes("_") }).toEqual({ name, underscore: true });
  });

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
 * A sandbox shaped like a host's clone (~/tarubot): the release's ops/quadlet copied under
 * clone/, the given .env, and stand-ins for podman and systemd-run first on PATH. The podman
 * stand-in logs each call's arguments, keeps what `secret create` reads in secret.<name>, and makes
 * `run` print a line on each stream, read its stdin into run.stdin and exit STUB_EXIT. The
 * systemd-run stand-in logs its arguments and execs the command after `--`, as systemd would run it.
 */
function sandbox(env: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tarubot-secrets-")));
  const clone = join(base, "clone");
  const bin = join(base, "bin");
  const log = join(base, "log");
  for (const directory of [join(clone, "ops"), bin, log]) mkdirSync(directory, { recursive: true });
  cpSync(root(QUADLET), join(clone, QUADLET), { recursive: true });
  writeFileSync(join(clone, ".env"), env);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  // Each call: a --- line, then one argument per line.
  stub(
    "podman",
    `{ echo ---; printf '%s\\n' "$@"; } >>"$STUB_LOG/podman.log"
case "$1 $2" in
  "secret create")
    cat >"$STUB_LOG/secret.$4"
    [ -z "\${STUB_FAIL_CREATE-}" ] || exit 125
    echo 0123456789abcdef0123456789 ;;
  "run "*)
    cat >"$STUB_LOG/run.stdin"
    echo tool-stdout; echo tool-stderr >&2
    exit "\${STUB_EXIT:-0}" ;;
esac
`,
  );
  stub(
    "systemd-run",
    `{ echo ---; printf '%s\\n' "$@"; } >>"$STUB_LOG/systemd-run.log"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`,
  );
  /** Run a script from the sandbox's clone, with only the stand-ins' settings in its environment. */
  const run = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync([join(clone, QUADLET, script), ...args], {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, STUB_LOG: log, ...extra },
      stdin: new TextEncoder().encode(`stdin-${MARK}`),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  /** Each logged call's arguments. */
  const calls = (tool: "podman" | "systemd-run"): string[][] => {
    const file = join(log, `${tool}.log`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("---\n")
      .filter(Boolean)
      .map((call) => call.replace(/\n$/u, "").split("\n"));
  };
  /** What one `secret create` read, or null when it never ran. */
  const secret = (name: string) => {
    const file = join(log, `secret.${name}`);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return { clone, log, run, calls, secret, cleanup };
}

/** A settings file with every secret, in the forms check-env.sh --syntax allows. */
const SECRETS_ENV = [
  "# The host's settings",
  "TARUBOT_IMAGE_TAG=2.33.0",
  // Unquoted, with blanks around the value, which systemd drops.
  `DATABASE_URL= \tpostgresql://tarubot:${MARK}@db.example:27520/tarubot \t`,
  // Double-quoted across lines (a PEM, with a padding line that looks like NAME=).
  `DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----`,
  `  ${MARK}  `,
  "MIIC0w=",
  "",
  `-----END CERTIFICATE-----"  `,
  // Single-quoted, keeping blanks, "#" and a double quote.
  `DISCORD_TOKEN=' ${MARK}#x" '`,
  "  # an indented comment",
  // Empty; HEALTHCHECKS_PING_URL and GITHUB_APP_PRIVATE_KEY aren't assigned at all.
  "GITHUB_REPORTS_TOKEN=",
  `OTHER_SETTING=${MARK}`,
  "",
].join("\n");
/** What each secret must receive from SECRETS_ENV: systemd's value and one newline. */
const SECRETS_EXPECTED: Record<string, string> = {
  "tarubot-database-ca-cert": `-----BEGIN CERTIFICATE-----\n  ${MARK}  \nMIIC0w=\n\n-----END CERTIFICATE-----\n`,
  "tarubot-database-url": `postgresql://tarubot:${MARK}@db.example:27520/tarubot\n`,
  "tarubot-discord-token": ` ${MARK}#x" \n`,
  "tarubot-github-app-private-key": "\n",
  "tarubot-github-reports-token": "\n",
  "tarubot-healthchecks-ping-url": "\n",
};

describe("secrets.sh, the copy from .env into Podman secrets", () => {
  test("is bash in strict mode with a private umask, and prints nothing on stdout", async () => {
    const text = await read(`${QUADLET}/secrets.sh`);
    expect(text).toStartWith("#!/usr/bin/env bash\n");
    expect(text).toContain("\nset -Eeuo pipefail\numask 077\n");
    expect(Bun.spawnSync(["bash", "-n", root(`${QUADLET}/secrets.sh`)]).exitCode).toBe(0);
  });

  test("sync copies all six, in order, each as its exact value and one newline", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      const result = box.run("secrets.sh", ["sync", join(box.clone, ".env")]);
      expect(result).toEqual({ code: 0, out: "", err: "" });
      // In the six's sorted order.
      expect(box.calls("podman")).toEqual(
        SECRET_MOUNTS.map((mount) => mount.secret)
          .sort()
          .map((secret) => ["secret", "create", "--replace", secret, "-"]),
      );
      for (const [name, value] of Object.entries(SECRETS_EXPECTED))
        expect({ name, value: box.secret(name) }).toEqual({ name, value });
      // Values only ever travel through the pipe: never an argument, never an output line.
      expect(readFileSync(join(box.log, "podman.log"), "utf8")).not.toContain(MARK);
    } finally {
      box.cleanup();
    }
  });

  test("sync with names copies only those, so the backup never needs the Discord token", () => {
    const box = sandbox(SECRETS_ENV.replace(/^DISCORD_TOKEN=.*$/mu, "DISCORD_TOKEN="));
    try {
      // Named in any order, copied in the six's order.
      const result = box.run("secrets.sh", [
        "sync",
        join(box.clone, ".env"),
        "DATABASE_URL",
        "DATABASE_CA_CERT",
      ]);
      expect(result).toEqual({ code: 0, out: "", err: "" });
      expect(box.calls("podman").map((call) => call[3])).toEqual([
        "tarubot-database-ca-cert",
        "tarubot-database-url",
      ]);
      // Without the names, the empty token stops the whole sync before anything is copied.
      rmSync(join(box.log, "podman.log"));
      const all = box.run("secrets.sh", ["sync", join(box.clone, ".env")]);
      expect(all.code).toBe(1);
      expect(all.err).toContain("secrets: DISCORD_TOKEN is missing or empty");
      expect(box.calls("podman")).toEqual([]);
    } finally {
      box.cleanup();
    }
  });

  test("a missing required secret is named, and nothing is created", () => {
    for (const name of ["DATABASE_URL", "DATABASE_CA_CERT", "DISCORD_TOKEN"]) {
      // Removing the assignment line (the CA's spans several) leaves the name unassigned.
      const env =
        name === "DATABASE_CA_CERT"
          ? SECRETS_ENV.replace(/^DATABASE_CA_CERT="[^"]*" {2}$/mu, "")
          : SECRETS_ENV.replace(new RegExp(`^${name}=.*$`, "mu"), "");
      expect(env).not.toContain(`${name}=`);
      const box = sandbox(env);
      try {
        for (const command of ["check", "sync"]) {
          const result = box.run("secrets.sh", [command, join(box.clone, ".env")]);
          expect({ name, command, code: result.code, out: result.out }).toEqual({
            name,
            command,
            code: 1,
            out: "",
          });
          expect(result.err).toContain(`secrets: ${name} is missing or empty in the settings file`);
          expect(result.err).not.toContain(MARK);
        }
        expect(box.calls("podman")).toEqual([]);
      } finally {
        box.cleanup();
      }
    }
  });

  test("check changes nothing, and a file check-env.sh --syntax refuses is refused", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      expect(box.run("secrets.sh", ["check", join(box.clone, ".env")])).toEqual({
        code: 0,
        out: "",
        err: "",
      });
      writeFileSync(join(box.clone, ".env"), `${SECRETS_ENV}export EXTRA=${MARK}\n`);
      for (const command of ["check", "sync"]) {
        const result = box.run("secrets.sh", [command, join(box.clone, ".env")]);
        expect({ command, code: result.code }).toEqual({ command, code: 1 });
        expect(result.err).toContain("check-env: line");
        expect(result.err).toContain("failed check-env.sh --syntax");
        expect(result.out + result.err).not.toContain(MARK);
      }
      // A missing file, without naming its path.
      const missing = box.run("secrets.sh", ["check", join(box.clone, "no-such-file")]);
      expect(missing.code).toBe(1);
      expect(missing.err).not.toContain("no-such-file");
      expect(box.calls("podman")).toEqual([]);
    } finally {
      box.cleanup();
    }
  });

  test("a failed copy is named and exits 1", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      const result = box.run("secrets.sh", ["sync", join(box.clone, ".env")], {
        STUB_FAIL_CREATE: "1",
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("secrets: DATABASE_CA_CERT could not be copied");
      expect(box.calls("podman")).toHaveLength(1);
    } finally {
      box.cleanup();
    }
  });

  test("usage errors exit 64 before reading anything", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      const env = join(box.clone, ".env");
      for (const args of [
        [],
        ["check"],
        ["sync"],
        ["check", env, "DATABASE_URL"],
        ["copy", env],
        ["sync", env, "DATABASE_URL", "DATABASE_URL"],
        ["sync", env, "POSTGRES_PASSWORD"],
        ["sync", env, "database_url"],
        ["sync", env, "DATABASE"],
      ]) {
        const result = box.run("secrets.sh", args);
        expect({ args, code: result.code, out: result.out }).toEqual({ args, code: 64, out: "" });
        expect(result.err).toStartWith("secrets: usage:");
      }
      expect(box.calls("podman")).toEqual([]);
    } finally {
      box.cleanup();
    }
  });

  test("the staging template's placeholders pass the check", () => {
    // The first start runs `secrets.sh check` on the staging host's .env, written from it.
    const box = sandbox(readFileSync(root("staging.env.example"), "utf8"));
    try {
      expect(box.run("secrets.sh", ["check", join(box.clone, ".env")])).toEqual({
        code: 0,
        out: "",
        err: "",
      });
    } finally {
      box.cleanup();
    }
  });
});

describe("run-tool.sh, one-off tools in the target's configuration", () => {
  const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

  /** The systemd-run and podman arguments the unit files say a target's tool must get. */
  async function expected(clone: string, target: Target, name: string, command: string[]) {
    const bot = await unit();
    const home = (value: string) => value.replace("%h/tarubot", clone);
    return [
      "--user",
      "--pipe",
      "--wait",
      "--collect",
      "--quiet",
      "--expand-environment=no",
      `--unit=${name}`,
      "-p",
      `EnvironmentFile=${home(single(bot, "Service", "EnvironmentFile"))}`,
      "-p",
      `UnsetEnvironment=${single(bot, "Service", "UnsetEnvironment")}`,
      "--",
      "podman",
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      "io.tarubot.role=tool",
      `--pull=${single(bot, "Container", "Pull")}`,
      "--log-driver=none",
      `--env-host=${single(bot, "Container", "EnvironmentHost")}`,
      `--http-proxy=${single(bot, "Container", "HttpProxy")}`,
      ...(single(bot, "Container", "ReadOnly") === "true" ? ["--read-only"] : []),
      `--read-only-tmpfs=${single(bot, "Container", "ReadOnlyTmpfs")}`,
      `--cap-drop=${single(bot, "Container", "DropCapability")}`,
      ...(single(bot, "Container", "NoNewPrivileges") === "true"
        ? ["--security-opt=no-new-privileges"]
        : []),
      ...[
        ...valuesOf(bot, "Container", "EnvironmentFile"),
        ...valuesOf(await dropIn(target), "Container", "EnvironmentFile"),
      ].flatMap((file) => ["--env-file", home(file)]),
      ...[
        ...valuesOf(bot, "Container", "Secret"),
        ...valuesOf(await dropIn(target), "Container", "Secret"),
      ].flatMap((secret) => ["--secret", secret]),
      single(bot, "Container", "Image").replace(/\$\{TARUBOT_IMAGE_DIGEST\}$/u, DIGEST),
      ...command,
    ];
  }

  for (const target of TARGETS)
    test(`${target}: syncs the secrets, then runs the tool with the unit's settings`, async () => {
      const box = sandbox(SECRETS_ENV);
      try {
        const name = `tarubot-migrate-${target}`;
        const command = ["bun", "dist/scripts/migrate.js", "--x=$HOME"];
        const result = box.run("run-tool.sh", [target, DIGEST, name, ...command]);
        // The tool's output passes through.
        expect(result).toEqual({ code: 0, out: "tool-stdout\n", err: "tool-stderr\n" });
        // All six secrets synced first, then exactly one tool run.
        const podman = box.calls("podman");
        expect(podman.slice(0, 6).map((call) => call.slice(0, 2).join(" "))).toEqual(
          Array(6).fill("secret create"),
        );
        const tool = await expected(box.clone, target, name, command);
        expect(box.calls("systemd-run")).toEqual([tool]);
        expect(podman.slice(6)).toEqual([tool.slice(tool.indexOf("--") + 2)]);
        // Production mounts six secrets, staging five (never the GitHub App key).
        expect(tool.filter((word) => word === "--secret")).toHaveLength(
          target === "production" ? 6 : 5,
        );
        // Unset in systemd's copy of .env, the same 14 names as the unit.
        expect(tool).toContain(`UnsetEnvironment=${UNSET.join(" ")}`);
        // stdin is /dev/null, and no value is ever an argument.
        expect(readFileSync(join(box.log, "run.stdin"), "utf8")).toBe("");
        expect(readFileSync(join(box.log, "systemd-run.log"), "utf8")).not.toContain(MARK);
        expect(readFileSync(join(box.log, "podman.log"), "utf8")).not.toContain(MARK);
      } finally {
        box.cleanup();
      }
    });

  test("the tool's exit status is the script's", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      for (const status of ["0", "1", "3", "70"])
        expect(
          box.run("run-tool.sh", ["staging", DIGEST, "tarubot-x", "true"], { STUB_EXIT: status })
            .code,
        ).toBe(Number(status));
    } finally {
      box.cleanup();
    }
  });

  test("a failed sync stops before the tool runs", () => {
    const box = sandbox(SECRETS_ENV.replace(/^DISCORD_TOKEN=.*$/mu, "DISCORD_TOKEN="));
    try {
      const result = box.run("run-tool.sh", ["production", DIGEST, "tarubot-x", "true"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("secrets: DISCORD_TOKEN is missing or empty");
      expect(result.err).toContain("run-tool: the secrets could not be synced");
      expect(box.calls("systemd-run")).toEqual([]);
      expect(box.calls("podman")).toEqual([]);
    } finally {
      box.cleanup();
    }
  });

  test("the target, digest and name are checked before anything runs", () => {
    const box = sandbox(SECRETS_ENV);
    try {
      for (const args of [
        ["production", DIGEST, "tarubot-x"],
        ["devbot", DIGEST, "tarubot-x", "true"],
        ["production", DIGEST.toUpperCase(), "tarubot-x", "true"],
        ["production", `${DIGEST}0`, "tarubot-x", "true"],
        ["production", DIGEST.replace("sha256", "sha512"), "tarubot-x", "true"],
        ["production", "2.33.0", "tarubot-x", "true"],
        ["production", DIGEST, "tarubot", "true"],
        ["production", DIGEST, "tarubot-", "true"],
        ["production", DIGEST, "Tarubot-x", "true"],
        ["production", DIGEST, "tarubot-x.service", "true"],
        ["production", DIGEST, "tarubot-x y", "true"],
        ["production", DIGEST, `tarubot-${"a".repeat(41)}`, "true"],
      ]) {
        const result = box.run("run-tool.sh", args);
        expect({ args, code: result.code }).toEqual({ args, code: 64 });
      }
      expect(
        box.run("run-tool.sh", ["production", DIGEST, `tarubot-${"a".repeat(40)}`, "true"]).code,
      ).toBe(0);
      expect(box.calls("systemd-run")).toHaveLength(1);
    } finally {
      box.cleanup();
    }
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
    "--secret",
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
          // Every host's five secrets, and production's GitHub App key.
          ...SECRET_MOUNTS.filter((mount) => !mount.production || target === "production").map(
            (mount) => `--secret ${secretLine(mount)}`,
          ),
        ].sort(),
      );
      // The unit waits for the network, IPv6 included, before it starts.
      expect(lines).toContain("Wants=podman-user-wait-network-online.service");
      expect(lines).toContain("After=podman-user-wait-network-online.service");
      // The checks, .env and the unset list pass through to systemd unchanged.
      expect(lines).toContain("EnvironmentFile=%h/tarubot/.env");
      expect(lines).toContain(`UnsetEnvironment=${UNSET.join(" ")}`);
      expect(lines.filter((line) => line.startsWith("ExecStartPre="))).toEqual(
        valuesOf(await unit(), "Service", "ExecStartPre").map((value) => `ExecStartPre=${value}`),
      );
    });
});
