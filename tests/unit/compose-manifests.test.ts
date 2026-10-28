/**
 * The Compose manifests' delivery contract (2.46.0). The managed manifests run the channel tag
 * that deploy.yml moves in ghcr.io/deconfined/tarubot-release, the package only an approved
 * Deploy can write (every workflow's token can write ghcr.io/deconfined/tarubot, so no runtime may
 * follow a tag there), never a digest or a delivery-controlled restart policy. Watchtower follows
 * exactly the two named containers, the bot and its web proxy, and only while they carry its
 * scope's label: one pinned image and the same flags in every manifest, so a Dependabot update
 * moves them together. The names keep one-off tool runs out (`docker compose run` copies the
 * service's labels, the scope included, but not its name), and the scope keeps it apart from any
 * other Watchtower on the Docker host, which would otherwise remove it or be removed by it. A
 * misspelled name or a missing label would leave a deployment silently unfollowed, which nothing
 * at runtime would report. Every manifest passes the bot its backup and restore settings, none of
 * them required, so a bad backup setting never stops Compose: the bot reports it (ci.yml checks
 * each manifest's syntax). It also passes every Compose-level setting through to the bot, so each
 * backup's settings copy, the bot's own environment, starts the project again as it was.
 */
import { describe, expect, test } from "bun:test";

type Service = {
  image?: string;
  profiles?: string[];
  container_name?: string;
  labels?: Record<string, string>;
  depends_on?: unknown;
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
/** The container names the updater follows: the bot and the web profile's proxy. */
const FOLLOWED = ["tarubot", "tarubot-web"];
/** The channel tags' package: only an approved Deploy, with its environment's token, writes it. */
const RELEASE_REPOSITORY = "ghcr.io/deconfined/tarubot-release";
/** The updater's scope, as a flag and as the label every container it may touch carries. */
const SCOPE = { "com.centurylinklabs.watchtower.scope": "tarubot" };
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
      // Both parts required, with no default: a managed runtime never falls back to the package
      // every workflow can write.
      expect(bot.image).toBe(
        `\${TARUBOT_IMAGE_REPOSITORY:?Set TARUBOT_IMAGE_REPOSITORY to ${RELEASE_REPOSITORY}}:\${TARUBOT_IMAGE_TAG:?Set TARUBOT_IMAGE_TAG to ${target}}`,
      );
      expect(bot.container_name).toBe(FOLLOWED[0]);
      expect(bot.labels).toEqual(SCOPE);
      expect(bot.environment?.TARUBOT_ENVIRONMENT).toBe(target);
      // Managed profiles register commands in their own scope and never read this.
      expect(bot.environment?.COMMAND_REGISTRATION).toBeUndefined();
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

  test("the web proxy follows the same repository and tag as the bot, for the same updater", async () => {
    const { services } = await manifest("docker-compose.web.yml");
    // The managed manifests require TARUBOT_IMAGE_REPOSITORY, so their proxy follows the release
    // package too; stock installs default to the public release images.
    expect(services.caddy?.image).toBe(
      `\${TARUBOT_IMAGE_REPOSITORY:-ghcr.io/deconfined/tarubot}:web-\${TARUBOT_IMAGE_TAG:-latest}`,
    );
    expect(services.caddy?.container_name).toBe(FOLLOWED[1]);
    // Without the label the scoped updater would silently stop following the proxy.
    expect(services.caddy?.labels).toEqual(SCOPE);
    // Swapping the bot must not take the proxy down with it: Watchtower also stops a container's
    // Compose dependents, and the offline page is for exactly the time the bot is away.
    expect(services.caddy?.depends_on).toBeUndefined();
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
        "--scope",
        SCOPE["com.centurylinklabs.watchtower.scope"],
        "--interval",
        "300",
        "--stop-timeout",
        "40s",
        "--include-restarting",
        "--cleanup",
        "--no-startup-message",
        ...FOLLOWED,
      ]);
      expect(updater.volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
      // Its own scope label is what another, unscoped Watchtower reads before removing "excess"
      // instances. It isn't one of the names it follows, so it never replaces itself.
      expect(updater.labels).toEqual(SCOPE);
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

  test("the stock bot carries the name and scope the opt-in updater follows", async () => {
    const { services } = await manifest("docker-compose.yml");
    expect(services.tarubot?.image).toBe(
      `\${TARUBOT_IMAGE:-\${TARUBOT_IMAGE_REPOSITORY:-ghcr.io/deconfined/tarubot}:\${TARUBOT_IMAGE_TAG:-latest}}`,
    );
    expect(services.tarubot?.container_name).toBe(FOLLOWED[0]);
    expect(services.tarubot?.labels).toEqual(SCOPE);
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

  test("every Compose-level setting reaches the bot, so a settings copy rebuilds the project", async () => {
    // A backup's env/ copy is the bot's own environment. Anything Compose reads but the bot never
    // receives (the image's repository and tag, the profiles, the local database's password)
    // would be missing from it: a rebuild would stop at the image or silently drop the web proxy.
    const web = await read("docker-compose.web.yml");
    for (const path of UPDATED) {
      const text = `${await read(path)}\n${web}`;
      // Interpolations only: `$$` is Compose's escape for a literal dollar inside a container.
      const names = new Set([
        "COMPOSE_PROFILES",
        ...[...text.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1] ?? ""),
      ]);
      const environment = (await manifest(path)).services.tarubot?.environment ?? {};
      for (const name of names)
        expect({
          path,
          name,
          passed: new RegExp(`^\\$\\{${name}(?::?[-?][^}]*)?\\}$`, "u").test(
            environment[name] ?? "",
          ),
        }).toEqual({ path, name, passed: true });
    }
  });

  test("a self-hosted install's command registration setting reaches the bot; new installs register", async () => {
    const stock = (await manifest("docker-compose.yml")).services.tarubot?.environment ?? {};
    // Empty or unset is off, as before 2.46.0, when such an install registered by hand.
    expect(stock.COMMAND_REGISTRATION).toBe(`\${COMMAND_REGISTRATION:-}`);
    expect(settings(await read(".env.example")).COMMAND_REGISTRATION).toBe("global");
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
      expect(example.TARUBOT_IMAGE_REPOSITORY).toBe(RELEASE_REPOSITORY);
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

  test("CI installs that server's PostgreSQL client first on PATH, before the tests run", async () => {
    // pg_dump refuses a newer server, and the runner's own client is older: without its own
    // major's client, tests/integration/backups.test.ts would skip the real backup and restore.
    const ci = Bun.YAML.parse(await read(".github/workflows/ci.yml")) as {
      jobs: {
        checks: {
          services: { postgres: { image: string } };
          steps: { name?: string; run?: string }[];
        };
      };
    };
    const { services, steps } = ci.jobs.checks;
    const major = /^postgres:(\d+)\./u.exec(services.postgres.image)?.[1] ?? "";
    expect(major).toMatch(/^\d+$/u);
    const install = steps.findIndex(
      (step) => step.name === `Install the PostgreSQL ${major} client`,
    );
    const tests = steps.findIndex((step) => step.run === "bun run test");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(tests);
    const run = steps[install]?.run ?? "";
    for (const command of [
      'Acquire::Retries "5";',
      "sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y",
      `postgresql-client-${major}`,
      `echo /usr/lib/postgresql/${major}/bin >> "$GITHUB_PATH"`,
    ])
      expect(run).toContain(command);
  });
});
