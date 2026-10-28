/**
 * The Compose manifests' delivery contract (2.46.0). The managed manifests run the channel tag
 * that deploy.yml moves, never a digest or a delivery-controlled restart policy, and Watchtower
 * follows only TaruBot's labelled containers: one scope, one pinned image and the same flags in
 * every manifest, so a Dependabot update moves them together. A misspelled label or scope would
 * leave a deployment silently unfollowed, which nothing at runtime would report. Every manifest
 * passes the bot its backup and restore settings, none of them required, so a bad backup setting
 * never stops Compose: the bot reports it (ci.yml checks each manifest's syntax).
 */
import { describe, expect, test } from "bun:test";

type Service = {
  image?: string;
  profiles?: string[];
  labels?: Record<string, string>;
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  tmpfs?: string[];
  restart?: string;
  stop_grace_period?: string;
  healthcheck?: { start_period?: string };
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
};
type Manifest = { name?: string; include?: string[]; services: Record<string, Service> };

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();
const manifest = async (path: string) => Bun.YAML.parse(await read(path)) as Manifest;

const MANAGED = {
  production: "docker-compose.production.yml",
  staging: "docker-compose.staging.yml",
} as const;
const UPDATED = [...Object.values(MANAGED), "docker-compose.yml"];
const FOLLOWED = {
  "com.centurylinklabs.watchtower.enable": "true",
  "com.centurylinklabs.watchtower.scope": "tarubot",
};
const BACKUP_SETTINGS = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "BACKUP_STORAGE_REGION",
  "BACKUP_AGE_RECIPIENTS",
  "BACKUP_TIME_UTC",
  "HEALTHCHECKS_BACKUP_URL",
];
const HARDENED = { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] };
const hardening = ({ read_only, cap_drop, security_opt }: Service) => ({
  read_only,
  cap_drop,
  security_opt,
});

/** A dotenv file's keys and values, single-line values only. */
const settings = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)].map((match) => [match[1], match[2]]),
  );

describe("the managed manifests", () => {
  for (const [target, path] of Object.entries(MANAGED)) {
    test(`${target} runs the ${target} tag the Deploy workflow moves, and nothing else`, async () => {
      const text = await read(path);
      const { name, include, services } = await manifest(path);
      expect(name).toBe("tarubot");
      expect(include).toEqual(["./docker-compose.web.yml"]);
      // The bot and its updater; backups run inside the bot, not as a separate service.
      expect(Object.keys(services).sort()).toEqual(["tarubot", "watchtower"]);
      const bot = services.tarubot ?? {};
      expect(bot.image).toBe(
        `ghcr.io/deconfined/tarubot:\${TARUBOT_IMAGE_TAG:?Set TARUBOT_IMAGE_TAG to ${target}}`,
      );
      expect(bot.labels).toEqual(FOLLOWED);
      expect(bot.environment?.TARUBOT_ENVIRONMENT).toBe(target);
      expect(bot.restart).toBe("unless-stopped");
      expect(bot.stop_grace_period).toBe("30s");
      // Long enough for a pre-migration backup and the migration before the bot is ready.
      expect(bot.healthcheck?.start_period).toBe("300s");
      expect(bot.tmpfs).toEqual(["/tmp:size=1m,mode=1777"]);
      expect(hardening(bot)).toEqual(HARDENED);
      for (const retired of ["TARUBOT_IMAGE_DIGEST", "TARUBOT_RESTART_POLICY", "ops/"])
        expect(text).not.toContain(retired);
    });
  }

  test("the web proxy follows the same tag as the bot, labelled for the same updater", async () => {
    const { services } = await manifest("docker-compose.web.yml");
    expect(services.caddy?.image).toBe(
      `ghcr.io/deconfined/tarubot:web-\${TARUBOT_IMAGE_TAG:-latest}`,
    );
    expect(services.caddy?.labels).toEqual(FOLLOWED);
    expect(services.caddy?.restart).toBe("unless-stopped");
  });
});

describe("Watchtower", () => {
  test("one pinned image and the same flags in every manifest that runs it", async () => {
    const updaters = await Promise.all(
      UPDATED.map(async (path) => (await manifest(path)).services.watchtower ?? {}),
    );
    const [first = {}] = updaters;
    expect(first.image).toMatch(
      /^ghcr\.io\/nicholas-fedor\/watchtower:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/u,
    );
    for (const updater of updaters) {
      expect(updater.image).toBe(first.image ?? "");
      expect(updater.command).toEqual([
        "--label-enable",
        "--scope",
        "tarubot",
        "--interval",
        "300",
        "--stop-timeout",
        "40s",
        "--include-restarting",
        "--cleanup",
        "--no-startup-message",
      ]);
      expect(updater.volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
      // Its own scope label, but never the enable label: it does not replace itself.
      expect(updater.labels).toEqual({ "com.centurylinklabs.watchtower.scope": "tarubot" });
      expect(updater.restart).toBe("unless-stopped");
      expect(hardening(updater)).toEqual(HARDENED);
    }
    // Self-hosters opt in; the managed manifests always run it.
    expect(updaters.map((updater) => updater.profiles)).toEqual([
      undefined,
      undefined,
      ["updates"],
    ]);
  });

  test("the stock bot is labelled for the opt-in updater, and a local build never is", async () => {
    expect((await manifest("docker-compose.yml")).services.tarubot?.labels).toEqual(FOLLOWED);
    const { services } = await manifest("docker-compose.build.yml");
    for (const name of ["tarubot", "caddy"])
      expect(services[name]?.labels).toEqual({ "com.centurylinklabs.watchtower.enable": "false" });
  });
});

describe("settings", () => {
  test("every manifest passes the bot its backup and restore settings, none required", async () => {
    for (const path of UPDATED) {
      const environment = (await manifest(path)).services.tarubot?.environment ?? {};
      for (const name of [...BACKUP_SETTINGS, "RESTORE_DATABASE_URL", "RESTORE_DATABASE_CA_CERT"])
        expect({ path, name, value: environment[name] }).toEqual({
          path,
          name,
          value: name === "BACKUP_TIME_UTC" ? `\${BACKUP_TIME_UTC:-03:00}` : `\${${name}:-}`,
        });
    }
  });

  test("the examples name each target's tag and backup settings, production's key included", async () => {
    const recipients = (await read("ops/age-recipients.txt"))
      .split("\n")
      .filter((line) => line.startsWith("age1"));
    expect(recipients).toHaveLength(1);
    for (const [target, path] of [
      ["production", "production.env.example"],
      ["staging", "staging.env.example"],
    ] as const) {
      const example = settings(await read(path));
      expect(example.TARUBOT_ENVIRONMENT).toBe(target);
      expect(example.TARUBOT_IMAGE_TAG).toBe(target);
      for (const name of BACKUP_SETTINGS) expect(Object.keys(example)).toContain(name);
      expect(Object.keys(example)).not.toContain("TARUBOT_IMAGE_DIGEST");
      expect(Object.keys(example)).not.toContain("TARUBOT_RESTART_POLICY");
      if (target === "production") expect(example.BACKUP_AGE_RECIPIENTS).toBe(recipients[0]);
      else expect(example.BACKUP_AGE_RECIPIENTS).not.toBe(recipients[0]);
    }
    const stock = settings(await read(".env.example"));
    for (const name of BACKUP_SETTINGS) expect(Object.keys(stock)).toContain(name);
  });

  test("CI's PostgreSQL service is the stock file's local database image", async () => {
    // Dependabot updates docker-compose.yml but never a workflow's service image.
    const ci = Bun.YAML.parse(await read(".github/workflows/ci.yml")) as {
      jobs: { checks: { services: { postgres: { image: string } } } };
    };
    expect(ci.jobs.checks.services.postgres.image).toBe(
      (await manifest("docker-compose.yml")).services.postgres?.image ?? "",
    );
  });
});
