/** Real CLI boundaries use executable stand-ins only: no registry, GitHub, host or credentials. */
import { afterAll, describe, expect, test } from "bun:test";
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

const scratch = mkdtempSync(join(tmpdir(), "release-subprocess-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const hostile = "invented-private-diagnostic.example.org\n::error::injected-diagnostic";
const commit = "1".repeat(40);
const imageDigest = `sha256:${"a".repeat(64)}`;
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
const environment = {
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [],
};
const branchPolicies = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
const provenance = [
  {
    verificationResult: {
      statement: {
        subject: [{ name: "ghcr.io/deconfined/tarubot", digest: { sha256: imageDigest.slice(7) } }],
        predicate: {
          runDetails: {
            metadata: {
              invocationId: "https://github.com/deconfined/tarubot/actions/runs/1234/attempts/1",
            },
          },
        },
      },
    },
  },
];
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
    ANSIBLE_SSH_KEY: "invented-host-secret",
    SSH_AUTH_SOCK: "/tmp/invented-agent.sock",
    DOCKER_CONFIG: join(callerHome, ".docker"),
    TRIVY_USERNAME: "invented-registry-user",
    TRIVY_PASSWORD: "invented-registry-password",
    TRIVY_SEVERITY: "LOW",
    HTTP_PROXY: "http://invented-proxy.example.org",
    NODE_OPTIONS: "--require=/tmp/invented-hook.js",
    BASH_ENV: startup,
    VERSION: "2.36.6",
    COMMIT: commit,
    DIGEST: imageDigest,
    PUBLICATION_RUN: "1234",
    GITHUB_REPOSITORY: "deconfined/tarubot",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: commit,
    GITHUB_RUN_ID: "1234",
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
    run: (script: "scan" | "admission", edits: Record<string, string> = {}) =>
      Bun.spawnSync(
        [
          process.execPath,
          fileURLToPath(new URL(`../../scripts/release-${script}.ts`, import.meta.url)),
        ],
        {
          cwd: repo,
          env: { ...parentEnv, ...(script === "scan" ? { DIGEST: indexDigest } : {}), ...edits },
          stdin: "ignore",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        },
      ),
  };
}

function admittedReplies(): Reply[] {
  return [
    { stdout: JSON.stringify({ object: { sha: commit } }) },
    ...["infra-plan", "infra-auto", "staging"].flatMap(() => [
      { stdout: JSON.stringify(environment) },
      { stdout: JSON.stringify(branchPolicies) },
    ]),
    { stdout: JSON.stringify(provenance) },
  ];
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
    "ANSIBLE_SSH_KEY",
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
    const result = f.run("scan");
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
    expect(f.run("scan").exitCode).toBe(0);
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
      const result = f.run("scan");
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
      const result = f.run("scan");
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
      const result = f.run("scan", { DIGEST: digest });
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
      const result = f.run("scan");
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
    const result = f.run("scan");
    expect(result.exitCode).toBe(1);
    redacted(result);
    expect(f.calls()).toHaveLength(3);
  });
});

describe("admission subprocess boundary", () => {
  test("emits only fully admitted identity and restricts gh to its public read token", () => {
    const f = fixture({ gh: admittedReplies().map((reply) => ({ ...reply, stderr: hostile })) });
    const result = f.run("admission");
    expect(result.exitCode).toBe(0);
    redacted(result);
    expect(f.calls()).toHaveLength(8);
    for (const call of f.calls()) {
      const home = join(f.runner, "release-admission");
      isolated(call, home);
      expect(call.env.GH_TOKEN).toBe("invented-public-github-token");
      expect(call.env.GH_HOST).toBe("github.com");
      expect(call.env.GH_CONFIG_DIR).toBe(join(home, "config"));
      expect(call.env.GH_PROMPT_DISABLED).toBe("1");
      expect(call.env.DOCKER_CONFIG).toBeUndefined();
    }
    expect(f.calls().at(-1)?.args).toContain("--deny-self-hosted-runners");
    expect(readFileSync(f.output, "utf8")).toBe(
      `version=2.36.6\ncommit=${commit}\ndigest=${imageDigest}\nconfig_commit=${commit}\npublication_run=1234\nschema_head=010_example.sql\n`,
    );
    expect(existsSync(join(f.runner, "release-admission"))).toBe(false);
  });

  test("API/provenance process failures never emit partial identity", () => {
    for (const phase of [0, 3, 7]) {
      const replies = admittedReplies();
      replies[phase] = { stdout: hostile, stderr: hostile, exitCode: 1 };
      const f = fixture({ gh: replies });
      const result = f.run("admission");
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toHaveLength(phase + 1);
      expect(readFileSync(f.output, "utf8")).toBe("");
      expect(existsSync(join(f.runner, "release-admission"))).toBe(false);
    }
  });

  test("malformed, signalled and excessive-output public evidence fail closed", () => {
    for (const reply of [{ stdout: hostile }, { signal: true }, { flood: true }]) {
      const replies = admittedReplies();
      replies[0] = reply;
      const f = fixture({ gh: replies });
      const result = f.run("admission");
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toHaveLength(1);
      expect(readFileSync(f.output, "utf8")).toBe("");
      expect(existsSync(join(f.runner, "release-admission"))).toBe(false);
    }
  });

  test("a superseded main or invalid environment stops before attestation", () => {
    for (const [phase, value] of [
      [0, { object: { sha: "9".repeat(40) } }],
      [3, { ...environment, protection_rules: [{ type: "required_reviewers" }] }],
      [4, { total_count: 2, branch_policies: branchPolicies.branch_policies }],
    ] as const) {
      const replies = admittedReplies();
      replies[phase] = { stdout: JSON.stringify(value) };
      const f = fixture({ gh: replies });
      const result = f.run("admission");
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toHaveLength(phase === 0 ? 1 : 5);
      expect(readFileSync(f.output, "utf8")).toBe("");
    }
  });

  test("successful verification of another publication cannot emit identity outputs", () => {
    const replies = admittedReplies();
    replies[7] = {
      stdout: JSON.stringify(provenance).replace("/runs/1234/", "/runs/9999/"),
      stderr: hostile,
    };
    const f = fixture({ gh: replies });
    const result = f.run("admission");
    expect(result.exitCode).toBe(1);
    redacted(result);
    expect(f.calls()).toHaveLength(8);
    expect(readFileSync(f.output, "utf8")).toBe("");
    expect(existsSync(join(f.runner, "release-admission"))).toBe(false);
  });
});

describe("runner input boundary", () => {
  test("missing tools produce only fixed public errors and clean up", () => {
    for (const script of ["scan", "admission"] as const) {
      const f = fixture({});
      const result = f.run(script);
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toEqual([]);
      expect(existsSync(join(f.runner, `release-${script}`))).toBe(false);
    }
  });

  test("invalid caller/runner input stops without loading a tool", () => {
    for (const [script, edits] of [
      ["scan", { DIGEST: "invalid\n::error::injected-diagnostic" }],
      ["scan", { RUNNER_TEMP: "" }],
      ["admission", { GH_TOKEN: "" }],
      ["admission", { GITHUB_EVENT_NAME: "workflow_dispatch" }],
      ["admission", { GITHUB_RUN_ATTEMPT: "2" }],
      ["admission", { GITHUB_OUTPUT: "" }],
    ] as const) {
      const f = fixture({
        gh: admittedReplies(),
        docker: [{ stdout: indexBytes }],
        trivy: [{}, {}],
      });
      const result = f.run(script, edits);
      expect(result.exitCode).toBe(1);
      redacted(result);
      expect(f.calls()).toEqual([]);
      expect(readFileSync(f.output, "utf8")).toBe("");
    }
  });

  test("stale or symlink work directories are refused and never removed", () => {
    for (const script of ["scan", "admission"] as const) {
      for (const symlink of [false, true]) {
        const f = fixture({
          gh: admittedReplies(),
          docker: [{ stdout: indexBytes }],
          trivy: [{}, {}],
        });
        const path = join(f.runner, `release-${script}`);
        const preserved = join(f.callerHome, "preserved");
        mkdirSync(preserved);
        writeFileSync(join(preserved, "sentinel"), "invented-owner-data");
        if (symlink) symlinkSync(preserved, path);
        else mkdirSync(path);
        const result = f.run(script);
        expect(result.exitCode).toBe(1);
        redacted(result);
        expect(f.calls()).toEqual([]);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(join(preserved, "sentinel"), "utf8")).toBe("invented-owner-data");
      }
    }
  });
});
