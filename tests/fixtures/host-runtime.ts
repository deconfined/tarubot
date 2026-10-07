import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployments,
  MANAGED_DIRECT_PORTS,
  PRODUCTION_DATABASES,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const realGit = Bun.which("git");
export const hostToolsAvailable = ["bash", "jq", "git", "flock", "timeout", "sync"].every(
  (name) => Bun.which(name) !== null,
);
export interface HostRelease {
  version: string;
  commit: string;
  digest: string;
  id: string;
}
export type HostTarget = "production" | "staging";
export interface HostSandbox {
  directory: string;
  root: string;
  state: string;
  sim: string;
  environment: Record<string, string>;
  live: HostRelease;
  target: HostRelease;
  deploymentTarget: HostTarget;
}
function hostEnvironment(target: HostTarget): Record<string, string> {
  const staging = target === "staging";
  const database = staging ? STAGING_DATABASE : PRODUCTION_DATABASES[0];
  const user = staging ? STAGING_DATABASE : "tarubot";
  return {
    TARUBOT_ENVIRONMENT: target,
    DATABASE_URL: `postgresql://${user}:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/${database}`,
    DATABASE_CA_CERT: "private-ca",
    DISCORD_TOKEN: "private-discord-token",
    DISCORD_APPLICATION_ID: staging
      ? deployments.devbot.applicationId
      : deployments.production.applicationId,
    TEST_GUILD_ID: staging ? deployments.devbot.guilds[0] : "",
    PUBLIC_TEST_RESPONSES: "false",
    TEST_PLAN_CHANNEL_ID: "",
    TARUBOT_IMAGE_TAG: "legacy-mutable-tag",
    TARUBOT_IMAGE: "legacy-image-override",
    BACKUP_STORAGE_ENDPOINT: staging ? "staging-backups.example.org" : "backups.example.org",
    BACKUP_STORAGE_ACCESS_KEY: staging ? "staging-backup-access" : "backup-access",
    BACKUP_STORAGE_SECRET_KEY: staging ? "staging-backup-secret" : "backup-secret",
    BACKUP_STORAGE_REGION: "example-region",
    HEALTHCHECKS_BACKUP_URL: "https://health.example.org/private-check",
  };
}
export const envContents = `${Object.entries(hostEnvironment("production"))
  .map(([key, value]) => `${key}=${value}`)
  .join("\n")}\n`;

export function subprocess(command: string[], environment: Record<string, string>, cwd?: string) {
  const process = Bun.spawnSync(command, {
    env: environment,
    cwd: cwd ?? repository,
    stdin: "ignore",
  });
  return {
    code: process.exitCode,
    stdout: process.stdout.toString(),
    stderr: process.stderr.toString(),
  };
}

export function hostSandbox(
  releases = false,
  deploymentTarget: HostTarget = "production",
): HostSandbox {
  const directory = mkdtempSync(join(tmpdir(), "tarubot-host-"));
  const home = join(directory, "home");
  const root = join(home, "tarubot");
  const state = join(home, ".local/state/tarubot-deploy");
  const sim = join(directory, "simulation");
  const bin = join(directory, "bin");
  for (const path of [home, sim, bin, join(directory, "tmp")]) mkdirSync(path, { recursive: true });
  for (const tool of ["docker", "age", "curl", "git", "sleep", "date"]) {
    cpSync(join(repository, "tests/fixtures/host-runtime", tool), join(bin, tool));
    chmodSync(join(bin, tool), 0o755);
  }
  const runtime = join(sim, "runtime");
  mkdirSync(join(runtime, "dist/src/config"), { recursive: true });
  // Host scripts import their compiled guard paths; execute the real source guard
  // through a runtime adapter rather than faking identity-check success.
  for (const module of ["deployment", "secrets"])
    writeFileSync(
      join(runtime, `dist/src/config/${module}.js`),
      `export * from ${JSON.stringify(join(repository, `src/config/${module}.ts`))};\n`,
    );
  const environment = {
    HOME: home,
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    SIM: sim,
    TMPDIR: join(directory, "tmp"),
    GIT_REAL: realGit ?? "/missing-git",
    BUN_REAL: process.execPath,
    COMPOSE_FIXTURE: join(repository, "tests/fixtures/host-runtime/compose-config.ts"),
    SCOPE_FIXTURE: join(repository, "tests/fixtures/host-runtime/scope-run.ts"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Host test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Host test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const live = {
    version: "2.39.0",
    commit: "a".repeat(40),
    digest: `sha256:${"a".repeat(64)}`,
    id: `sha256:${"1".repeat(64)}`,
  };
  const target = {
    version: "2.40.0",
    commit: "b".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    id: `sha256:${"2".repeat(64)}`,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = subprocess([environment.GIT_REAL, ...args], environment, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const files = (path: string) => {
    mkdirSync(join(path, "ops"), { recursive: true });
    cpSync(join(repository, "ops/backup.sh"), join(path, "ops/backup.sh"));
    for (const target of ["production", "staging"])
      cpSync(
        join(repository, `docker-compose.${target}.yml`),
        join(path, `docker-compose.${target}.yml`),
      );
    writeFileSync(join(path, "ops/age-recipients.txt"), "age1testrecipient\n");
  };
  if (releases) {
    const source = join(directory, "origin");
    mkdirSync(source);
    git(source, "init", "--initial-branch=main");
    files(source);
    mkdirSync(join(source, "migrations"));
    writeFileSync(join(source, "migrations/001_initial.sql"), "SELECT 1;\n");
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: live.version }));
    git(source, "add", ".");
    git(source, "commit", "-m", "Initial release");
    live.commit = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: target.version }));
    git(source, "add", ".");
    git(source, "commit", "-m", "Target release");
    target.commit = git(source, "rev-parse", "HEAD");
    git(home, "clone", source, root);
    git(root, "checkout", "--detach", live.commit);
  } else files(root);
  const settings = hostEnvironment(deploymentTarget);
  writeFileSync(
    join(root, ".env"),
    `${Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(sim, "live-env.json"), JSON.stringify(settings));
  writeFileSync(join(sim, "config.json"), JSON.stringify({ live, target, deploymentTarget }));
  writeFileSync(
    join(sim, "container.json"),
    JSON.stringify([
      {
        Id: "c0ffee000001",
        Image: live.id,
        RestartCount: 0,
        State: { Running: true, Health: { Status: "healthy" } },
        Config: {
          Image: `ghcr.io/deconfined/tarubot@${live.digest}`,
          Labels: {
            "org.opencontainers.image.version": live.version,
            "org.opencontainers.image.revision": live.commit,
            "com.docker.compose.project": "tarubot",
            "com.docker.compose.oneoff": "False",
          },
        },
      },
    ]),
  );
  writeFileSync(join(sim, "events"), "");
  writeFileSync(join(sim, "argv"), "");
  return { directory, root, state, sim, environment, live, target, deploymentTarget };
}
export function deploy(
  box: HostSandbox,
  request?: string,
  args: string[] = [box.deploymentTarget],
) {
  return subprocess(["bash", join(repository, "ops/deploy.sh"), ...args], {
    ...box.environment,
    SSH_ORIGINAL_COMMAND:
      request ??
      `deploy ${box.deploymentTarget} ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
  });
}
export function backup(
  box: HostSandbox,
  extra: Record<string, string> = {},
  args: string[] = [box.deploymentTarget],
) {
  return subprocess(["bash", join(repository, "ops/backup.sh"), ...args], {
    ...box.environment,
    TARUBOT_IMAGE_DIGEST: box.target.digest,
    TARUBOT_COMPOSE_FILE: join(box.root, `docker-compose.${box.deploymentTarget}.yml`),
    ...extra,
  });
}
export function events(box: HostSandbox): string[] {
  return readFileSync(join(box.sim, "events"), "utf8").trim().split("\n");
}
export function knob(box: HostSandbox, name: string) {
  writeFileSync(join(box.sim, `fail-${name}`), "");
}
export const deployScript = join(repository, "ops/deploy.sh");
