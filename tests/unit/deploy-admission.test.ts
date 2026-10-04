/** Execute the workflow's real Bash/jq admission with invented GitHub API responses only. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nested CLI fixtures need a bounded allowance under the ARM64 release-image emulation.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "deploy-admission-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, { steps: { run?: string }[] }> };
const admission = workflow.jobs.validate?.steps.find((step) => step.run)?.run;
const recheck = workflow.jobs.deliver?.steps.find((step) => step.run)?.run;
if (!admission || !recheck) throw new Error("missing-executable-deployment-admission");

const ownerPolicy = () => ({
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  can_admins_bypass: false,
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
    },
  ],
});
const mainOnly = () => ({ branch_policies: [{ name: "main", type: "branch" }] });
type Target = "production" | "staging";
type Replies = {
  status: string;
  version: string;
  environments: Record<Target, unknown>;
  branches: Record<Target, unknown>;
  attestation: unknown;
  attestationExit: number;
  apiExit: number;
};

type Fixture = {
  replies: Replies;
  output: () => string;
  contacted: () => boolean;
  run: (script: string, changes?: Record<string, string>) => Bun.SyncSubprocess<"pipe", "pipe">;
};

function fixture(): Fixture {
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  const runner = join(directory, "runner");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(runner, { mode: 0o700 });
  const responses = join(directory, "responses.json");
  const calls = join(directory, "calls");
  const output = join(directory, "github-output");
  writeFileSync(output, "");
  const replies: Replies = {
    status: "ahead",
    version: "2.36.6",
    environments: { production: ownerPolicy(), staging: ownerPolicy() },
    branches: { production: mainOnly(), staging: mainOnly() },
    attestation: [{ verificationResult: {} }],
    attestationExit: 0,
    apiExit: 0,
  };
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const replies = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
const diagnostic = "invented-private-api-diagnostic.example.org\\n::error::injected-diagnostic";
if (args[0] === "attestation" && args[1] === "verify") {
  if (replies.attestationExit) { console.error(diagnostic); process.exit(replies.attestationExit); }
  console.log(JSON.stringify(replies.attestation));
} else if (args[0] === "api") {
  if (replies.apiExit) { console.error(diagnostic); process.exit(replies.apiExit); }
  const endpoint = args.find((arg) => arg.startsWith("repos/"));
  if (endpoint?.includes("/compare/")) console.log(replies.status);
  else if (endpoint?.includes("/contents/package.json?ref=")) console.log(JSON.stringify({ version: replies.version }));
  else {
    const match = endpoint?.match(/\\/environments\\/(production|staging)(\\/deployment-branch-policies)?$/);
    if (!match) process.exit(70);
    console.log(JSON.stringify((match[2] ? replies.branches : replies.environments)[match[1]]));
  }
} else process.exit(70);
`,
    { mode: 0o700 },
  );
  return {
    replies,
    output: () => readFileSync(output, "utf8"),
    contacted: () => existsSync(calls),
    run: (script: string, changes: Record<string, string> = {}) => {
      writeFileSync(responses, JSON.stringify(replies));
      return Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], {
        cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: directory,
          RUNNER_TEMP: runner,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "deconfined/tarubot",
          GH_TOKEN: "invented-github-token",
          TARGET: "staging",
          REPO_PRODUCTION_DEPLOY_ENABLED: "false",
          REPO_STAGING_DEPLOY_ENABLED: "true",
          VERSION: "2.36.6",
          COMMIT: "a".repeat(40),
          DIGEST: `sha256:${"b".repeat(64)}`,
          ...changes,
        },
        stdin: "ignore",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      });
    },
  };
}

function redacted(result: Bun.SyncSubprocess<"pipe", "pipe">) {
  const logs = result.stdout.toString() + result.stderr.toString();
  for (const privateText of [
    "invented-private-api-diagnostic",
    "injected-diagnostic",
    "invented-github-token",
    scratch,
  ])
    expect(logs).not.toContain(privateText);
}

function refused(f: Fixture, script: string, changes: Record<string, string> = {}) {
  const result = f.run(script, changes);
  expect(result.exitCode).not.toBe(0);
  redacted(result);
}

for (const target of ["staging", "production"] as const) {
  const selected = {
    TARGET: target,
    REPO_PRODUCTION_DEPLOY_ENABLED: target === "production" ? "true" : "false",
    REPO_STAGING_DEPLOY_ENABLED: target === "staging" ? "true" : "false",
  };
  const other = target === "staging" ? "production" : "staging";
  describe(`${target} release admission`, () => {
    test("uses only its own owner policy and activation through approval revalidation", () => {
      const f = fixture();
      f.replies.environments[other] = { ...ownerPolicy(), can_admins_bypass: true };
      f.replies.branches[other] = { branch_policies: [{ name: "*", type: "branch" }] };
      const admitted = f.run(admission, selected);
      expect(admitted.exitCode).toBe(0);
      expect(f.output()).toBe(`target=${target}\n`);
      redacted(admitted);
      const approved = f.run(recheck, selected);
      expect(approved.exitCode).toBe(0);
      redacted(approved);
    });

    test("the other repository switch cannot authorize a disabled selected target", () => {
      for (const disabled of ["", "false", "TRUE", "1"]) {
        const f = fixture();
        const changes = {
          TARGET: target,
          REPO_PRODUCTION_DEPLOY_ENABLED: target === "production" ? disabled : "true",
          REPO_STAGING_DEPLOY_ENABLED: target === "staging" ? disabled : "true",
          // Environment-level values must not replace repository activation.
          DEPLOY_ENABLED: "true",
          STAGING_DEPLOY_ENABLED: "true",
        };
        refused(f, admission, changes);
        refused(f, recheck, changes);
        expect(f.contacted()).toBe(false);
        expect(f.output()).toBe("");
      }
    });

    test("rejects unsafe reviewer and branch protections before exposing an environment", () => {
      for (const badPolicy of [
        { ...ownerPolicy(), can_admins_bypass: true },
        {
          ...ownerPolicy(),
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        },
        { ...ownerPolicy(), protection_rules: [] },
        {
          ...ownerPolicy(),
          protection_rules: [
            {
              type: "required_reviewers",
              prevent_self_review: true,
              reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
            },
          ],
        },
        {
          ...ownerPolicy(),
          protection_rules: [
            {
              type: "required_reviewers",
              prevent_self_review: false,
              reviewers: [{ type: "Team", reviewer: { login: "deconfined" } }],
            },
          ],
        },
        {
          ...ownerPolicy(),
          protection_rules: [
            {
              type: "required_reviewers",
              prevent_self_review: false,
              reviewers: [{ type: "User", reviewer: { login: "invented-other-reviewer" } }],
            },
          ],
        },
        {
          ...ownerPolicy(),
          protection_rules: [
            {
              type: "required_reviewers",
              prevent_self_review: false,
              reviewers: [
                { type: "User", reviewer: { login: "deconfined" } },
                { type: "User", reviewer: { login: "invented-second-reviewer" } },
              ],
            },
          ],
        },
      ]) {
        const f = fixture();
        f.replies.environments[target] = badPolicy;
        refused(f, admission, selected);
        expect(f.output()).toBe("");
      }
      for (const branches of [
        [],
        [{ name: "*", type: "branch" }],
        [{ name: "main", type: "tag" }],
        [
          { name: "main", type: "branch" },
          { name: "release", type: "branch" },
        ],
      ]) {
        const f = fixture();
        f.replies.branches[target] = { branch_policies: branches };
        refused(f, admission, selected);
        expect(f.output()).toBe("");
      }
    });

    test("policy changes during approval wait are refused by the actual post-approval step", () => {
      const f = fixture();
      expect(f.run(admission, selected).exitCode).toBe(0);
      f.replies.environments[target] = { ...ownerPolicy(), can_admins_bypass: true };
      refused(f, recheck, selected);
    });
  });
}

test("unsupported or injected target never reaches policy lookup or exposes an environment", () => {
  for (const target of [
    "",
    "preview",
    "Production",
    "staging/production",
    "staging\ntarget=production",
    "$(touch injected)",
  ]) {
    const f = fixture();
    refused(f, admission, { TARGET: target });
    refused(f, recheck, { TARGET: target });
    expect(f.contacted()).toBe(false);
    expect(f.output()).toBe("");
  }
});

test("malformed exact release inputs fail before any GitHub operation", () => {
  const malformed: Record<string, string>[] = [
    { VERSION: "02.36.6" },
    { VERSION: "2.36.6-rc.1" },
    { VERSION: "10000.1.0" },
    { COMMIT: "main" },
    { COMMIT: "A".repeat(40) },
    { DIGEST: "latest" },
    { DIGEST: `sha256:${"b".repeat(63)}` },
    { GITHUB_REPOSITORY: "invented/tarubot" },
  ];
  for (const changes of malformed) {
    const f = fixture();
    refused(f, admission, changes);
    refused(f, recheck, changes);
    expect(f.contacted()).toBe(false);
    expect(f.output()).toBe("");
  }
});

test("non-main source, mismatched version, absent provenance and failed verification never grant admission", () => {
  for (const response of [
    { status: "behind" },
    { status: "diverged" },
    { status: "unknown" },
    { version: "2.36.5" },
    { attestation: [] },
    { attestation: {} },
    { attestationExit: 1 },
    { apiExit: 1 },
  ]) {
    const f = fixture();
    Object.assign(f.replies, response);
    refused(f, admission);
    refused(f, recheck);
    expect(f.output()).toBe("");
  }
});

test("an identical main commit remains eligible for owner-selected staging rehearsal", () => {
  const f = fixture();
  f.replies.status = "identical";
  expect(f.run(admission).exitCode).toBe(0);
  expect(f.output()).toBe("target=staging\n");
});
