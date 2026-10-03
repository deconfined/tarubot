import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
export interface HostSandbox {
  directory: string;
  root: string;
  state: string;
  sim: string;
  environment: Record<string, string>;
  live: HostRelease;
  target: HostRelease;
}
export const envContents = [
  "DATABASE_URL=postgresql://fixture:private-database-password@database.example.org:27520/tarubot",
  "DATABASE_CA_CERT=private-ca",
  "DISCORD_TOKEN=private-discord-token",
  "DISCORD_APPLICATION_ID=123456789012345678",
  "TARUBOT_IMAGE_TAG=legacy-mutable-tag",
  "TARUBOT_IMAGE=legacy-image-override",
  "BACKUP_STORAGE_ENDPOINT=backups.example.org",
  "BACKUP_STORAGE_ACCESS_KEY=backup-access",
  "BACKUP_STORAGE_SECRET_KEY=backup-secret",
  "BACKUP_STORAGE_REGION=us-iad-2",
  "HEALTHCHECKS_BACKUP_URL=https://health.example.org/private-check",
  "",
].join("\n");

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

export function hostSandbox(releases = false): HostSandbox {
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
  const environment = {
    HOME: home,
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    SIM: sim,
    TMPDIR: join(directory, "tmp"),
    GIT_REAL: realGit ?? "/missing-git",
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
    cpSync(
      join(repository, "docker-compose.production.yml"),
      join(path, "docker-compose.production.yml"),
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
  writeFileSync(join(root, ".env"), envContents, { mode: 0o600 });
  writeFileSync(join(sim, "config.json"), JSON.stringify({ live, target }));
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
  return { directory, root, state, sim, environment, live, target };
}
export function deploy(box: HostSandbox, request?: string, args: string[] = []) {
  return subprocess(["bash", join(repository, "ops/deploy.sh"), ...args], {
    ...box.environment,
    SSH_ORIGINAL_COMMAND:
      request ?? `deploy ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
  });
}
export function backup(box: HostSandbox, extra: Record<string, string> = {}, args: string[] = []) {
  return subprocess(["bash", join(repository, "ops/backup.sh"), ...args], {
    ...box.environment,
    TARUBOT_IMAGE_DIGEST: box.target.digest,
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
