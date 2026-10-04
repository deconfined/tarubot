/** Real CLI boundaries use executable stand-ins only: no registry, GitHub, host or credentials. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ARM64 emulation slows the nested Bun processes these CLI fixtures start; child limits stay fixed.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "release-subprocess-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const hostile = "invented-private-diagnostic.example.org\n::error::injected-diagnostic";
const imageIndex = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: ["amd64", "arm64"].map((architecture, i) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${String(i + 2).repeat(64)}`,
    size: 1000,
    platform: { os: "linux", architecture },
  })),
};
const indexBytes = JSON.stringify(imageIndex);
const indexDigest = `sha256:${createHash("sha256").update(indexBytes).digest("hex")}`;
type Reply = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: boolean;
  flood?: boolean;
};
type Call = {
  tool: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  homeMode: number;
  files: { name: string; mode: number }[];
  dockerFiles: string[];
  plugin?: string;
  pluginMode?: number;
};

/** Complete pinned JSON reports bind each successful stand-in scan to its immutable child. */
function scannedReplies(): Reply[] {
  return imageIndex.manifests.map((manifest) => {
    const reference = `ghcr.io/deconfined/tarubot@${manifest.digest}`;
    return {
      stdout: JSON.stringify({
        SchemaVersion: 2,
        Trivy: { Version: "0.74.0" },
        ArtifactName: reference,
        ArtifactType: "container_image",
        Metadata: {
          Reference: reference,
          RepoDigests: [reference],
          ImageConfig: {
            os: "linux",
            architecture: manifest.platform.architecture,
            config: { Env: [hostile] },
          },
        },
        Results: [],
      }),
    };
  });
}

/** Embed fixture paths in direct Bun executables so Bash startup hooks can never reach real tools. */
function fixture(replies: Record<string, Reply[]>) {
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  const runner = join(directory, "runner");
  const repo = join(directory, "repository");
  const callerHome = join(directory, "caller-home");
  for (const path of [bin, runner, repo, callerHome]) mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(repo, "migrations"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "2.36.6" }));
  writeFileSync(join(repo, "migrations", "010_example.sql"), "-- Invented schema fixture.\n");
  const output = join(directory, "github-output");
  writeFileSync(output, "");
  const callsFile = join(directory, "calls.jsonl");
  const startup = join(directory, "hostile-startup");
  writeFileSync(startup, 'printf "invented-startup-hook-ran\\n"\n', { mode: 0o600 });
  for (const [tool, results] of Object.entries(replies)) {
    const path = join(bin, tool);
    writeFileSync(
      path,
      `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const callsFile = ${JSON.stringify(callsFile)};
const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\\n").map(JSON.parse) : [];
const tool = ${JSON.stringify(tool)};
const reply = ${JSON.stringify(results)}[calls.filter((call) => call.tool === tool).length];
if (!reply) throw new Error("unexpected-fixture-command");
const home = process.env.HOME;
const dockerConfig = process.env.DOCKER_CONFIG;
const pluginPath = dockerConfig && join(dockerConfig, "cli-plugins", "docker-buildx");
appendFileSync(callsFile, JSON.stringify({
  tool, args: process.argv.slice(2), cwd: process.cwd(), env: process.env,
  homeMode: statSync(home).mode & 0o777,
  files: readdirSync(home).filter((name) => /\\.(stdout|stderr)$/.test(name)).map((name) => ({ name, mode: statSync(join(home, name)).mode & 0o777 })),
  dockerFiles: dockerConfig && existsSync(dockerConfig) ? readdirSync(dockerConfig) : [],
  plugin: pluginPath && existsSync(pluginPath) ? readFileSync(pluginPath, "utf8") : undefined,
  pluginMode: pluginPath && existsSync(pluginPath) ? statSync(pluginPath).mode & 0o777 : undefined,
}) + "\\n");
if (reply.signal) { process.kill(process.pid, "SIGTERM"); await Bun.sleep(1000); }
if (reply.flood) { process.stdout.write("x".repeat(20 * 1024 * 1024)); await Bun.sleep(1000); }
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.exitCode ?? 0);
`,
      { mode: 0o700 },
    );
  }
  const parentEnv = {
    PATH: bin,
    HOME: callerHome,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: output,
    GH_TOKEN: "invented-public-github-token",
    GH_HOST: "invented-alternate.example.org",
    GH_CONFIG_DIR: callerHome,
    GH_DEBUG: "api",
    AWS_SECRET_ACCESS_KEY: "invented-provider-secret",
    DEPLOY_SSH_KEY: "invented-host-secret",
    SSH_AUTH_SOCK: "/tmp/invented-agent.sock",
    DOCKER_CONFIG: join(callerHome, ".docker"),
    TRIVY_USERNAME: "invented-registry-user",
    TRIVY_PASSWORD: "invented-registry-password",
    TRIVY_SEVERITY: "LOW",
    HTTP_PROXY: "http://invented-proxy.example.org",
    NODE_OPTIONS: "--require=/tmp/invented-hook.js",
    BASH_ENV: startup,
  };
  return {
    runner,
    callerHome,
    output,
    bin,
    calls: (): Call[] =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    run: (edits: Record<string, string> = {}) =>
      Bun.spawnSync(
        [
          process.execPath,
          fileURLToPath(new URL("../../scripts/release-scan.ts", import.meta.url)),
        ],
        {
          cwd: repo,
          env: { ...parentEnv, DIGEST: indexDigest, ...edits },
          stdin: "ignore",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        },
      ),
  };
}

/** Hostile child diagnostics stay private regardless of whether the tool succeeded or failed. */
function redacted(result: Bun.SyncSubprocess<"pipe", "pipe">) {
  const logs = result.stdout.toString() + result.stderr.toString();
  expect(logs).not.toContain("invented-private-diagnostic");
  expect(logs).not.toContain("injected-diagnostic");
  expect(logs).not.toContain("invented-public-github-token");
  expect(logs).not.toContain("invented-startup-hook-ran");
  expect(logs).not.toContain(scratch);
}

function isolated(call: Call, home: string) {
  expect(call.cwd).toBe(home);
  expect(call.env.HOME).toBe(home);
  expect(call.homeMode).toBe(0o700);
  for (const { mode } of call.files) expect(mode).toBe(0o600);
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "DEPLOY_SSH_KEY",
    "SSH_AUTH_SOCK",
    "TRIVY_USERNAME",
    "TRIVY_PASSWORD",
    "TRIVY_SEVERITY",
    "HTTP_PROXY",
    "NODE_OPTIONS",
    "BASH_ENV",
    "GH_DEBUG",
  ])
    expect(call.env[key]).toBeUndefined();
}

describe("scanner subprocess boundary", () => {
  test("scans both immutable platform digests with isolated configuration and removes private logs", () => {
    const f = fixture({
      docker: [{ stdout: indexBytes, stderr: hostile }],
      trivy: scannedReplies().map((reply) => ({ ...reply, stderr: hostile })),
    });
    const result = f.run();
    expect(result.exitCode).toBe(0);
    redacted(result);
    expect(f.calls().map((call) => call.tool)).toEqual(["docker", "trivy", "trivy"]);
    expect(f.calls()[0]?.args).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      "--raw",
      `ghcr.io/deconfined/tarubot@${indexDigest}`,
    ]);
    for (const call of f.calls()) {
      const home = join(f.runner, "release-scan");
      isolated(call, home);
      expect(call.env.GH_TOKEN).toBeUndefined();
      expect(call.env.GH_CONFIG_DIR).toBeUndefined();
      expect(call.env.DOCKER_CONFIG).toBe(join(home, ".docker"));
    }
    for (const [i, call] of f.calls().slice(1).entries()) {
      expect(call.args.at(-1)).toBe(
        `ghcr.io/deconfined/tarubot@${imageIndex.manifests[i]?.digest}`,
      );
      expect(
        call.args.slice(call.args.indexOf("--config"), call.args.indexOf("--config") + 2),
      ).toEqual(["--config", "/dev/null"]);
      expect(
        call.args.slice(call.args.indexOf("--ignorefile"), call.args.indexOf("--ignorefile") + 2),
      ).toEqual(["--ignorefile", "/dev/null"]);
    }
    expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
  });

  test("copies only the action-installed Buildx executable into private Docker configuration", () => {
    const f = fixture({ docker: [{ stdout: indexBytes }], trivy: scannedReplies() });
    const config = join(f.callerHome, ".docker");
    mkdirSync(join(config, "cli-plugins"), { recursive: true });
    const plugin = `#!${process.execPath}\nconsole.log("invented-buildx-plugin");\n`;
    writeFileSync(join(config, "cli-plugins", "docker-buildx"), plugin, { mode: 0o755 });
    writeFileSync(join(config, "config.json"), '{"auths":{"example.org":{"auth":"invented"}}}');
    mkdirSync(join(config, "contexts"));
    writeFileSync(join(config, "client-key.pem"), "invented-private-key-trap");
    expect(f.run().exitCode).toBe(0);
    const docker = f.calls()[0];
    expect(docker?.dockerFiles).toEqual(["cli-plugins"]);
    expect(docker?.plugin).toBe(plugin);
    expect(docker?.pluginMode).toBe(0o700);
    expect(readFileSync(join(config, "client-key.pem"), "utf8")).toBe("invented-private-key-trap");
  });

  test("refuses symlink and nonregular user Buildx plugins before running any tool", () => {
    for (const kind of ["symlink", "directory"]) {
      const f = fixture({ docker: [{ stdout: indexBytes }], trivy: [{}, {}] });
      const plugins = join(f.callerHome, ".docker", "cli-plugins");
      mkdirSync(plugins, { recursive: true });
      const plugin = join(plugins, "docker-buildx");
      if (kind === "symlink") symlinkSync("/tmp/invented-missing-plugin", plugin);
      else mkdirSync(plugin);
      const result = f.run();
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toEqual([]);
      expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
    }
  });

  test("registry errors and different raw bytes stop before scanning", () => {
    for (const reply of [
      { stdout: hostile, stderr: hostile, exitCode: 1 },
      { stdout: `${indexBytes}\n`, stderr: hostile },
    ]) {
      const f = fixture({ docker: [reply], trivy: [{}, {}] });
      const result = f.run();
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls().map((call) => call.tool)).toEqual(["docker"]);
      expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
    }
  });

  test("digest-matching malformed or unsupported indexes cannot reach the scanner", () => {
    for (const bytes of [
      hostile,
      JSON.stringify({ ...imageIndex, manifests: imageIndex.manifests.slice(0, 1) }),
      JSON.stringify({
        ...imageIndex,
        manifests: [
          imageIndex.manifests[0],
          { ...imageIndex.manifests[1], platform: { os: "linux", architecture: hostile } },
        ],
      }),
    ]) {
      const f = fixture({ docker: [{ stdout: bytes }], trivy: [{}, {}] });
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const result = f.run({ DIGEST: digest });
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls().map((call) => call.tool)).toEqual(["docker"]);
      expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
    }
  });

  test("failed, signalled or excessive-output scanners cannot authorize success", () => {
    for (const reply of [
      { stdout: hostile, stderr: hostile, exitCode: 1 },
      { signal: true },
      { flood: true },
    ]) {
      const f = fixture({ docker: [{ stdout: indexBytes }], trivy: [reply, {}] });
      const result = f.run();
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls().map((call) => call.tool)).toEqual(["docker", "trivy"]);
      expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
    }
  });

  test("the second architecture must pass too", () => {
    const f = fixture({
      docker: [{ stdout: indexBytes }],
      trivy: [scannedReplies()[0] ?? {}, { stderr: hostile, exitCode: 1 }],
    });
    const result = f.run();
    expect(result.exitCode).toBe(1);
    redacted(result);
    expect(f.calls()).toHaveLength(3);
  });
});

describe("scanner runner input boundary", () => {
  test("missing tools produce only fixed public errors and clean up", () => {
    const f = fixture({});
    const result = f.run();
    expect(result.exitCode).toBe(1);
    redacted(result);
    expect(f.calls()).toEqual([]);
    expect(existsSync(join(f.runner, "release-scan"))).toBe(false);
  });

  test("invalid input stops without loading a tool", () => {
    for (const edits of [
      { DIGEST: "invalid\n::error::injected-diagnostic" },
      { RUNNER_TEMP: "" },
    ]) {
      const f = fixture({ docker: [{ stdout: indexBytes }], trivy: [{}, {}] });
      const result = f.run(edits);
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toEqual([]);
      expect(readFileSync(f.output, "utf8")).toBe("");
    }
  });

  test("stale or symlink work directories are refused and never removed", () => {
    for (const symlink of [false, true]) {
      const f = fixture({ docker: [{ stdout: indexBytes }], trivy: [{}, {}] });
      const path = join(f.runner, "release-scan");
      const preserved = join(f.callerHome, "preserved");
      mkdirSync(preserved);
      writeFileSync(join(preserved, "sentinel"), "invented-owner-data");
      if (symlink) symlinkSync(preserved, path);
      else mkdirSync(path);
      const result = f.run();
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(preserved, "sentinel"), "utf8")).toBe("invented-owner-data");
    }
  });
});
