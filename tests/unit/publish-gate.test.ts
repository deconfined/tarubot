/**
 * Execute publish.yml's real release-gate proof against real Git histories and invented GitHub API
 * replies. Publication skips the full CI suite only when the pushed merge commit carries exactly a
 * pull-request head tree whose pull-request CI run passed every check and both platform tests;
 * every other answer falls back to running CI, and the step itself never fails for it.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nested Git and CLI fixtures need a bounded allowance under slow or emulated runners.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "publish-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Job = { if?: string; needs?: string | string[]; steps?: { id?: string; run?: string }[] };
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const proof = workflow.jobs.gate?.steps?.find((step) => step.id === "proof")?.run ?? "";
if (!proof) throw new Error("missing-release-gate-proof");

// A home with no user configuration: the owner's global signing settings never apply here.
const home = join(scratch, "home");
mkdirSync(home);
const gitEnvironment = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Example Author",
  GIT_AUTHOR_EMAIL: "author@example.org",
  GIT_COMMITTER_NAME: "Example Author",
  GIT_COMMITTER_EMAIL: "author@example.org",
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd: directory,
    env: gitEnvironment,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commit(directory: string, file: string, message: string): string {
  writeFileSync(join(directory, file), `${message}\n`);
  git(directory, "add", file);
  git(directory, "commit", "--quiet", "--message", message);
  return git(directory, "rev-parse", "HEAD");
}

/**
 * main: base; the pull request's branch: base + feature. An up-to-date merge has the head's tree; a
 * stale merge also brings a main commit the branch never tested, so its tree differs.
 */
function history(stale: boolean) {
  const directory = mkdtempSync(join(scratch, "repository-"));
  git(directory, "init", "--quiet", "--initial-branch", "main");
  commit(directory, "base.txt", "base");
  git(directory, "switch", "--quiet", "--create", "feature");
  const head = commit(directory, "feature.txt", "feature");
  git(directory, "switch", "--quiet", "main");
  if (stale) commit(directory, "untested.txt", "untested main change");
  git(directory, "merge", "--quiet", "--no-ff", "--message", "Merge pull request #12", "feature");
  return { directory, head, merge: git(directory, "rev-parse", "HEAD") };
}

const PASSING_JOBS = ["Checks", "Container build (amd64)", "Container build (arm64)", "CI result"];

type Replies = {
  pulls: unknown;
  runs: unknown;
  jobs: unknown;
  apiExit: number;
};

function fixture(stale = false) {
  const repository = history(stale);
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const responses = join(directory, "responses.json");
  const calls = join(directory, "calls");
  const output = join(directory, "github-output");
  writeFileSync(output, "");
  writeFileSync(calls, "");
  const replies: Replies = {
    pulls: [
      {
        number: 12,
        merged_at: "2026-10-08T03:22:00Z",
        merge_commit_sha: repository.merge,
        base: { ref: "main" },
        head: { sha: repository.head },
      },
    ],
    runs: {
      workflow_runs: [
        {
          id: 3700,
          run_number: 41,
          head_sha: repository.head,
          event: "pull_request",
          conclusion: "success",
        },
      ],
    },
    jobs: { jobs: PASSING_JOBS.map((name) => ({ name, conclusion: "success" })) },
    apiExit: 0,
  };
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const replies = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
if (args[0] !== "api" || args.length !== 2) process.exit(70);
if (replies.apiExit) { console.error("invented-api-diagnostic"); process.exit(replies.apiExit); }
const endpoint = args[1];
if (/^repos\\/deconfined\\/tarubot\\/commits\\/[0-9a-f]{40}\\/pulls$/.test(endpoint)) console.log(JSON.stringify(replies.pulls));
else if (endpoint.startsWith("repos/deconfined/tarubot/actions/workflows/ci.yml/runs?")) console.log(JSON.stringify(replies.runs));
else if (/^repos\\/deconfined\\/tarubot\\/actions\\/runs\\/[0-9]+\\/jobs\\?per_page=50$/.test(endpoint)) console.log(JSON.stringify(replies.jobs));
else process.exit(70);
`,
    { mode: 0o700 },
  );
  return {
    repository,
    replies,
    calls: () =>
      readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    run: (changes: Record<string, string> = {}) => {
      writeFileSync(responses, JSON.stringify(replies));
      writeFileSync(output, "");
      const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", proof], {
        cwd: repository.directory,
        env: {
          ...gitEnvironment,
          PATH: `${bin}:/usr/bin:/bin`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "deconfined/tarubot",
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: repository.merge,
          GH_TOKEN: "invented-github-token",
          ...changes,
        },
        stdin: "ignore",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      });
      const recorded = readFileSync(output, "utf8").split("\n").filter(Boolean);
      return { result, recorded, stdout: result.stdout.toString() };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/** The step succeeds either way, records exactly one decision, and never prints the token. */
function decided(f: Fixture, changes: Record<string, string> = {}) {
  const run = f.run(changes);
  expect(run.result.exitCode).toBe(0);
  expect(run.recorded.filter((line) => line.startsWith("tested="))).toHaveLength(1);
  expect(run.stdout + run.result.stderr.toString()).not.toContain("invented-github-token");
  return run;
}

function skipsCi(f: Fixture, changes: Record<string, string> = {}) {
  const run = decided(f, changes);
  expect(run.recorded).toEqual(["tested=true"]);
  expect(run.stdout).toContain("publication does not run CI again");
  return run;
}

function runsCi(f: Fixture, changes: Record<string, string> = {}) {
  const run = decided(f, changes);
  expect(run.recorded).toEqual(["tested=false"]);
  expect(run.stdout).toMatch(/^::notice::.+; running the full CI suite instead\.$/mu);
  return run;
}

describe("publication reuses pull-request CI only for the exact tested tree", () => {
  test("an up-to-date merge whose head passed every check and both platforms skips CI", () => {
    const f = fixture();
    const run = skipsCi(f);
    expect(run.stdout).toContain("PR #12's head, which CI run 3700 tested");
    const runsCall = f.calls().find((args) => args[1]?.includes("/actions/workflows/ci.yml/runs?"));
    expect(runsCall?.[1]).toContain(`head_sha=${f.repository.head}`);
    expect(runsCall?.[1]).toContain("event=pull_request");
  });

  test("a merge that also brings an untested main change runs CI", () => {
    runsCi(fixture(true));
  });

  test("dispatches and other refs run CI before any API call", () => {
    for (const changes of [
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_REF: "refs/heads/feature" },
    ]) {
      const f = fixture();
      runsCi(f, changes);
      expect(f.calls()).toEqual([]);
    }
  });

  test("a direct push, or a commit no single pull request merged as, runs CI", () => {
    const f = fixture();
    const pull = (f.replies.pulls as Record<string, unknown>[])[0];
    for (const pulls of [
      [],
      [{ ...pull, merged_at: null }],
      [{ ...pull, base: { ref: "release" } }],
      [{ ...pull, merge_commit_sha: "f".repeat(40) }],
      [pull, { ...pull, number: 13 }],
    ]) {
      f.replies.pulls = pulls;
      runsCi(f);
    }
  });

  test("a head that isn't this merge's second parent runs CI", () => {
    const f = fixture();
    const pull = (f.replies.pulls as Record<string, unknown>[])[0];
    f.replies.pulls = [{ ...pull, head: { sha: f.repository.merge } }];
    runsCi(f);
  });

  test("malformed pull request numbers and heads run CI", () => {
    const f = fixture();
    const pull = (f.replies.pulls as Record<string, unknown>[])[0];
    for (const changed of [
      { number: "12; touch injected" },
      { number: 0 },
      { head: { sha: "HEAD" } },
      { head: { sha: `${f.repository.head}\nextra` } },
    ]) {
      f.replies.pulls = [{ ...pull, ...changed }];
      runsCi(f);
    }
  });

  test("no successful pull-request run for the head runs CI", () => {
    const f = fixture();
    const [ok] = (f.replies.runs as { workflow_runs: Record<string, unknown>[] }).workflow_runs;
    for (const workflowRuns of [
      [],
      [{ ...ok, conclusion: "failure" }],
      [{ ...ok, event: "push" }],
      [{ ...ok, head_sha: "e".repeat(40) }],
      [{ ...ok, id: "3700/../../x" }],
    ]) {
      f.replies.runs = { workflow_runs: workflowRuns };
      runsCi(f);
    }
  });

  test("the newest successful run is the one whose jobs are checked", () => {
    const f = fixture();
    const [ok] = (f.replies.runs as { workflow_runs: Record<string, unknown>[] }).workflow_runs;
    f.replies.runs = { workflow_runs: [ok, { ...ok, id: 3800, run_number: 42 }] };
    const run = skipsCi(f);
    expect(run.stdout).toContain("CI run 3800 tested");
    expect(f.calls().some((args) => args[1]?.includes("/actions/runs/3800/jobs"))).toBe(true);
  });

  test("a run missing a passing check, either platform test or the result runs CI", () => {
    for (const missing of PASSING_JOBS) {
      const f = fixture();
      f.replies.jobs = {
        jobs: PASSING_JOBS.map((name) => ({
          name,
          conclusion: name === missing ? "skipped" : "success",
        })),
      };
      runsCi(f);
    }
  });

  test("an unreadable GitHub API runs CI without failing the step", () => {
    const f = fixture();
    f.replies.apiExit = 1;
    runsCi(f);
  });
});

describe("publication jobs never depend on a deliberately skipped fallback", () => {
  test("every job after the gate names the results it needs and survives cancellation checks", () => {
    for (const name of [
      "prepare",
      "amd64",
      "arm64",
      "publish",
      "scan",
      "attest",
      "latest",
      "deploy",
    ]) {
      const condition = workflow.jobs[name]?.if ?? "";
      expect(condition.startsWith("!cancelled()")).toBe(true);
      const needs = [workflow.jobs[name]?.needs ?? []].flat();
      for (const need of needs) {
        if (name === "prepare" && need === "verify") continue;
        expect(condition).toContain(`needs.${need}.result == 'success'`);
      }
    }
    expect(workflow.jobs.prepare?.if).toContain(
      "(needs.gate.outputs.tested == 'true' || needs.verify.result == 'success')",
    );
    expect(workflow.jobs.verify?.if).toBe("needs.gate.outputs.tested != 'true'");
  });

  test("re-runs retry for real: no publication or delivery job is limited to the first attempt", () => {
    for (const file of ["publish.yml", "publish-platform.yml", "deploy.yml"])
      expect(
        readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
      ).not.toContain("github.run_attempt");
  });

  test("the full-CI fallback also runs the in-image suite on both platforms", () => {
    const verify = workflow.jobs.verify as Job & { with?: Record<string, unknown> };
    expect(verify.with).toEqual({ "platform-tests": true });
    const ci = Bun.YAML.parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    ) as {
      jobs: Record<string, { if?: string; steps?: { env?: Record<string, string> }[] }>;
    };
    expect(ci.jobs.images?.if).toContain("inputs.platform-tests == true");
    const required = ci.jobs.result?.steps?.find((candidate) => candidate.env?.IMAGES_REQUIRED);
    expect(required?.env?.IMAGES_REQUIRED).toContain("inputs.platform-tests == true");
  });
});
