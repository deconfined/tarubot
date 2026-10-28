/**
 * Execute deploy.yml's real Bash/jq step against invented GitHub API, registry and attestation
 * answers only. A deployment moves exactly the target's two channel tags (`<target>` and
 * `web-<target>`) to one release's verified digests, and only when its target is switched on, its
 * version is published as both images, the bot image's source commit is on main and carries that
 * version, both digests carry that commit's signed provenance, and the owner approved this attempt.
 * Anything else moves nothing.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nested CLI fixtures need a bounded allowance under slow or emulated runners.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "deploy-admission-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const source = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
type Step = { uses?: string; run?: string; env?: Record<string, string> };
type Job = {
  name?: string;
  if?: string;
  environment?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  steps: Step[];
};
const workflow = Bun.YAML.parse(source) as {
  on: Record<string, { inputs?: Record<string, unknown>; secrets?: unknown }>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = workflow.jobs.deploy;
const scripts = job?.steps.filter((step) => step.run) ?? [];
const deploy = scripts[0]?.run ?? "";
if (!job || scripts.length !== 1 || !deploy) throw new Error("missing-executable-deployment");

const IMAGE = "ghcr.io/deconfined/tarubot";
const VERSION = "2.46.0";
const COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "e".repeat(40);
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
const BOT = digest("bot 2.46.0");
const WEB = digest("web 2.46.0");
const PREVIOUS_BOT = digest("bot 2.45.2");
const PREVIOUS_WEB = digest("web 2.45.2");

type Target = "production" | "staging";
type Labels = { revision?: string; version?: string; arm64Revision?: string };
type State = {
  /** Registry tag -> index digest. */
  tags: Record<string, string>;
  /** Tags whose reads fail with a server error. */
  failing: string[];
  /** Image labels by index digest; an unknown digest can't be inspected. */
  labels: Record<string, Labels>;
  /** The commit whose signed provenance each digest carries. */
  signed: Record<string, string>;
  /** imagetools create of these tags fails; "drift:<tag>" tags another digest instead. */
  createFails: string[];
  compare: string;
  version: string;
  /** Fail every non-approval gh api call with this exit status. */
  apiExit: number;
  /** Jobs of this run attempt; null answers with this attempt's own deployment job (777). */
  jobs: unknown;
  /** Deployments for the environment and run commit; null answers with deployment 55. */
  deployments: unknown;
  /** Statuses by deployment ID, newest first; absent answers with 55 held for approval. */
  statuses: Record<string, unknown>;
  /** Fail only the approval lookups (jobs, deployments, statuses) with this exit status. */
  approvalApiExit: number;
};

const release = (target: Target): State => ({
  tags: {
    [VERSION]: BOT,
    [`web-${VERSION}`]: WEB,
    "2.45.2": PREVIOUS_BOT,
    "web-2.45.2": PREVIOUS_WEB,
    [target]: PREVIOUS_BOT,
    [`web-${target}`]: PREVIOUS_WEB,
  },
  failing: [],
  labels: {
    [BOT]: { revision: COMMIT, version: VERSION },
    [WEB]: { revision: COMMIT, version: VERSION },
    [PREVIOUS_BOT]: { revision: PREVIOUS_COMMIT, version: "2.45.2" },
    [PREVIOUS_WEB]: { revision: PREVIOUS_COMMIT, version: "2.45.2" },
  },
  signed: {
    [BOT]: COMMIT,
    [WEB]: COMMIT,
    [PREVIOUS_BOT]: PREVIOUS_COMMIT,
    [PREVIOUS_WEB]: PREVIOUS_COMMIT,
  },
  createFails: [],
  compare: "ahead",
  version: VERSION,
  apiExit: 0,
  jobs: null,
  deployments: null,
  statuses: {},
  approvalApiExit: 0,
});

/** Answers like gh: the approval lookups, the commit checks and attestation verification. */
const GH = `
const diagnostic = "invented-private-api-diagnostic.example.org\\n::error::injected-diagnostic";
if (args[0] === "attestation" && args[1] === "verify") {
  const subject = args[2]?.match(/^oci:\\/\\/ghcr\\.io\\/deconfined\\/tarubot@(sha256:[0-9a-f]{64})$/)?.[1];
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const exact = value("--repo") === "deconfined/tarubot" &&
    value("--cert-identity") === "https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" &&
    value("--source-ref") === "refs/heads/main" &&
    value("--predicate-type") === "https://slsa.dev/provenance/v1" &&
    args.includes("--deny-self-hosted-runners") && value("--format") === "json";
  if (!subject || !exact) process.exit(70);
  if (state.signed[subject] !== value("--source-digest")) { console.error(diagnostic); process.exit(1); }
  console.log(JSON.stringify([{ verificationResult: {} }]));
  process.exit(0);
}
if (args[0] !== "api") process.exit(70);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
const run = process.env.GITHUB_RUN_ID;
const held = (job) => ["in_progress", "queued", "waiting"].map((value) => ({
  state: value, target_url: \`https://github.com/deconfined/tarubot/actions/runs/\${run}/job/\${job}\`,
}));
const jobs = endpoint?.match(/^repos\\/deconfined\\/tarubot\\/actions\\/runs\\/([0-9]+)\\/attempts\\/([0-9]+)\\/jobs\\?per_page=100$/);
const deployments = endpoint?.match(/^repos\\/deconfined\\/tarubot\\/deployments\\?environment=(production|staging)&sha=([0-9a-f]{40})&per_page=30$/);
const statuses = endpoint?.match(/^repos\\/deconfined\\/tarubot\\/deployments\\/([0-9]+)\\/statuses\\?per_page=100$/);
if (jobs || deployments || statuses) {
  if (state.approvalApiExit) { console.error(diagnostic); process.exit(state.approvalApiExit); }
  if (jobs) {
    if (jobs[1] !== run || jobs[2] !== process.env.GITHUB_RUN_ATTEMPT) process.exit(70);
    console.log(JSON.stringify(state.jobs ?? { jobs: [
      { id: 776, name: "Release gate", status: "completed" },
      { id: 777, name: "Deploy " + process.env.TARGET, status: "in_progress" },
    ] }));
  } else if (deployments) {
    if (deployments[1] !== process.env.TARGET || deployments[2] !== process.env.GITHUB_SHA) process.exit(70);
    console.log(JSON.stringify(state.deployments ?? [{ id: 55 }]));
  } else console.log(JSON.stringify(state.statuses[statuses[1]] ?? (statuses[1] === "55" ? held(777) : [])));
  process.exit(0);
}
if (state.apiExit) { console.error(diagnostic); process.exit(state.apiExit); }
const compare = endpoint?.match(/^repos\\/deconfined\\/tarubot\\/compare\\/([0-9a-f]{40})\\.\\.\\.main$/);
const contents = endpoint?.match(/^repos\\/deconfined\\/tarubot\\/contents\\/package\\.json\\?ref=([0-9a-f]{40})$/);
if (compare && args.includes("--jq") && args[args.indexOf("--jq") + 1] === ".status") console.log(state.compare);
else if (contents && args.includes("Accept: application/vnd.github.raw+json")) console.log(JSON.stringify({ version: state.version }));
else process.exit(70);
`;

/**
 * Answers like GHCR and curl do, so a script that drops a flag fails here too: credentials come
 * only from --config - on stdin; manifests need the bearer token and the index media type; --fail
 * turns >= 400 into exit 22; output goes only to --write-out and to --dump-header -.
 */
const CURL = `
const config = await new Response(Bun.stdin.stream()).text();
const url = args.find((arg) => arg.startsWith("https://"));
const flag = (name) => args.includes(name);
const after = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const answer = (code, headers = "") => {
  if (flag("--fail") && code >= 400) {
    if (flag("--write-out")) process.stdout.write(String(code));
    process.exit(22);
  }
  if (after("--dump-header") === "-") process.stdout.write("HTTP/2 " + code + "\\r\\n" + headers + "\\r\\n");
  if (flag("--write-out")) process.stdout.write(String(code));
  process.exit(0);
};
if (after("--config") !== "-") process.exit(70);
if (url === "https://ghcr.io/token?service=ghcr.io&scope=repository:deconfined/tarubot:pull") {
  if (!config.includes('user = "invented-user:invented-github-token"')) answer(401);
  process.stdout.write(JSON.stringify({ token: "invented-registry-token" }));
  process.exit(0);
}
const match = url?.match(/^https:\\/\\/ghcr\\.io\\/v2\\/deconfined\\/tarubot\\/manifests\\/([A-Za-z0-9._-]+)$/);
if (!match || !flag("--head")) process.exit(70);
if (!config.includes('header = "Authorization: Bearer invented-registry-token"')) answer(401);
if (!(after("--header") ?? "").includes("application/vnd.oci.image.index.v1+json")) answer(404);
if (state.failing.includes(match[1])) answer(500);
if (!state.tags[match[1]]) answer(404);
answer(200, "docker-content-digest: " + state.tags[match[1]] + "\\r\\n");
`;

/** imagetools inspect prints a multi-platform index's image configs; create re-tags one index. */
const DOCKER = `
if (args[0] !== "buildx" || args[1] !== "imagetools") process.exit(70);
if (args[2] === "inspect") {
  const subject = args[3]?.match(/^ghcr\\.io\\/deconfined\\/tarubot@(sha256:[0-9a-f]{64})$/)?.[1];
  if (!subject || args[4] !== "--format" || args[5] !== "{{json .Image}}" || args.length !== 6) process.exit(70);
  const labels = state.labels[subject];
  if (!labels) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
  const config = (revision) => ({ config: { Labels: {
    ...(revision === undefined ? {} : { "org.opencontainers.image.revision": revision }),
    ...(labels.version === undefined ? {} : { "org.opencontainers.image.version": labels.version }),
  } } });
  console.log(JSON.stringify({
    "linux/amd64": config(labels.revision),
    "linux/arm64": config(labels.arm64Revision ?? labels.revision),
  }));
  process.exit(0);
}
if (args[2] !== "create" || args[3] !== "--tag" || args.length !== 6) process.exit(70);
const tag = args[4].match(/^ghcr\\.io\\/deconfined\\/tarubot:([A-Za-z0-9._-]+)$/)?.[1];
const from = args[5].match(/^ghcr\\.io\\/deconfined\\/tarubot@(sha256:[0-9a-f]{64})$/)?.[1];
if (!tag || !from) process.exit(70);
if (state.createFails.includes(tag)) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
state.tags[tag] = state.createFails.includes("drift:" + tag) ? "sha256:" + "f".repeat(64) : from;
writeFileSync(STATE, JSON.stringify(state));
`;

type Fixture = {
  state: State;
  calls: () => string[][];
  /** The registry after the run. */
  registry: () => State;
  summary: () => string;
  run: (changes?: Record<string, string>) => Bun.SyncSubprocess<"pipe", "pipe">;
};

function fixture(target: Target = "staging"): Fixture {
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  const runner = join(directory, "runner");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(runner, { mode: 0o700 });
  const statePath = join(directory, "state.json");
  const calls = join(directory, "calls");
  const summary = join(directory, "summary");
  writeFileSync(calls, "");
  writeFileSync(summary, "");
  for (const [name, body] of [
    ["gh", GH],
    ["curl", CURL],
    ["docker", DOCKER],
  ] as const)
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const STATE = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
const state = JSON.parse(readFileSync(STATE, "utf8"));
${body}`,
      { mode: 0o700 },
    );
  const state = release(target);
  return {
    state,
    calls: () =>
      readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    registry: () => JSON.parse(readFileSync(statePath, "utf8")) as State,
    summary: () => readFileSync(summary, "utf8"),
    run: (changes: Record<string, string> = {}) => {
      writeFileSync(statePath, JSON.stringify(state));
      return Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", deploy], {
        cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: directory,
          RUNNER_TEMP: runner,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_REPOSITORY: "deconfined/tarubot",
          GH_TOKEN: "invented-github-token",
          GHCR_USER: "invented-user",
          GHCR_TOKEN: "invented-github-token",
          TARGET: target,
          PRODUCTION_ENABLED: target === "production" ? "true" : "false",
          STAGING_ENABLED: target === "staging" ? "true" : "false",
          VERSION,
          GITHUB_RUN_ID: "37000000001",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "d".repeat(40),
          ...changes,
        },
        stdin: "ignore",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      });
    },
  };
}

/** Diagnostics, the GitHub token and private paths never reach the public log. */
function redacted(result: Bun.SyncSubprocess<"pipe", "pipe">) {
  const logs = result.stdout.toString() + result.stderr.toString();
  for (const privateText of [
    "invented-private-api-diagnostic",
    "injected-diagnostic",
    "invented-private-registry-diagnostic",
    "invented-github-token",
    scratch,
  ])
    expect(logs).not.toContain(privateText);
  // The registry token appears only where the runner masks it.
  for (const line of logs.split("\n"))
    if (line.includes("invented-registry-token"))
      expect(line).toBe("::add-mask::invented-registry-token");
}

const creates = (f: Fixture) =>
  f.calls().filter((args) => args[0] === "docker" && args[3] === "create");

/** Refused with this reason on the public log, and no tag moved. */
function refused(f: Fixture, reason: string, changes: Record<string, string> = {}) {
  const before = { ...f.state.tags };
  const result = f.run(changes);
  expect(result.exitCode).not.toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout).toContain(`::error::${reason}`);
  expect(stdout).toContain("No tag was moved.");
  redacted(result);
  expect(creates(f)).toEqual([]);
  expect(f.registry().tags).toEqual(before);
  return stdout;
}

describe("the workflow's shape", () => {
  test("one approved job per target, its switch, main only, and no secret or host tooling", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
    expect(Object.keys(workflow.on.workflow_call?.inputs ?? {})).toEqual(["target", "version"]);
    expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {})).toEqual(["target", "version"]);
    expect(workflow.on.workflow_call?.secrets).toBeUndefined();
    expect(job.name).toBe(`Deploy \${{ inputs.target }}`);
    expect(job.environment).toBe(`\${{ inputs.target }}`);
    expect(job.concurrency).toEqual({
      group: `deploy-\${{ inputs.target }}`,
      "cancel-in-progress": false,
    });
    for (const condition of [
      "github.ref == 'refs/heads/main'",
      "inputs.target == 'production' && vars.DEPLOY_ENABLED == 'true'",
      "inputs.target == 'staging' && vars.STAGING_DEPLOY_ENABLED == 'true'",
    ])
      expect(job.if).toContain(condition);
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      attestations: "read",
      deployments: "read",
      packages: "write",
    });
    // Only the run's own token; no checkout, SSH or deploy key.
    const secrets = new Set(
      [...source.matchAll(/secrets\.([A-Za-z_]+)/gu)].map((match) => match[1]),
    );
    expect(secrets).toEqual(new Set(["GITHUB_TOKEN"]));
    expect(job.steps.map((step) => step.uses?.split("@")[0] ?? "run")).toEqual([
      "docker/setup-buildx-action",
      "docker/login-action",
      "run",
    ]);
    expect(source.toLowerCase()).not.toContain("ssh");
  });
});

for (const target of ["staging", "production"] as const) {
  const other = target === "staging" ? "production" : "staging";
  describe(`a ${target} deployment`, () => {
    test("moves exactly its two tags to exactly the verified digests, web first", () => {
      const f = fixture(target);
      f.state.tags[other] = PREVIOUS_BOT;
      f.state.tags[`web-${other}`] = PREVIOUS_WEB;
      const result = f.run();
      expect(result.exitCode).toBe(0);
      redacted(result);
      expect(creates(f)).toEqual([
        [
          "docker",
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${IMAGE}:web-${target}`,
          `${IMAGE}@${WEB}`,
        ],
        [
          "docker",
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${IMAGE}:${target}`,
          `${IMAGE}@${BOT}`,
        ],
      ]);
      expect(f.registry().tags).toEqual({
        ...f.state.tags,
        [target]: BOT,
        [`web-${target}`]: WEB,
      });
      // Both digests were verified against the release's own commit before anything moved.
      const verified = f
        .calls()
        .filter((args) => args[0] === "gh" && args[1] === "attestation")
        .map((args) => [args[3], args[args.indexOf("--source-digest") + 1]]);
      expect(verified).toEqual([
        [`oci://${IMAGE}@${BOT}`, COMMIT],
        [`oci://${IMAGE}@${WEB}`, COMMIT],
      ]);
      const summary = f.summary();
      for (const text of [
        `### TaruBot ${VERSION} on ${target}`,
        `| \`${IMAGE}:${target}\` | \`${BOT}\` | \`${PREVIOUS_BOT}\` |`,
        `| \`${IMAGE}:web-${target}\` | \`${WEB}\` | \`${PREVIOUS_WEB}\` |`,
        `Source commit \`${COMMIT}\`; the channel named 2.45.2 before.`,
        `To roll back, run Deploy for ${target} with the earlier version.`,
      ])
        expect(summary).toContain(text);
      expect(result.stdout.toString()).toContain(
        `::notice::${target} now names ${VERSION} (${BOT}, web ${WEB}); it named 2.45.2 before.`,
      );
    });

    test("finds its own job when publish.yml calls it", () => {
      const f = fixture(target);
      f.state.jobs = {
        jobs: [{ id: 777, name: `Production release / Deploy ${target}`, status: "in_progress" }],
      };
      expect(f.run().exitCode).toBe(0);
      expect(f.registry().tags[target]).toBe(BOT);
    });

    test("the other target's switch can't enable this one", () => {
      for (const disabled of ["", "false", "TRUE", "1"]) {
        const f = fixture(target);
        refused(f, "Deploy needs an enabled target", {
          PRODUCTION_ENABLED: target === "production" ? disabled : "true",
          STAGING_ENABLED: target === "staging" ? disabled : "true",
          // Same-named environment values are not the switch the workflow binds.
          DEPLOY_ENABLED: "true",
          STAGING_DEPLOY_ENABLED: "true",
        });
        expect(f.calls()).toEqual([]);
      }
    });
  });
}

test("an unsupported or injected target never reaches GitHub or the registry", () => {
  for (const target of [
    "",
    "preview",
    "Production",
    "staging/production",
    "staging\nproduction",
    "$(touch injected)",
  ]) {
    const f = fixture();
    refused(f, "Deploy needs an enabled target", {
      TARGET: target,
      PRODUCTION_ENABLED: "true",
      STAGING_ENABLED: "true",
    });
    expect(f.calls()).toEqual([]);
  }
});

test("a malformed version or repository fails before any GitHub or registry call", () => {
  for (const changes of [
    { VERSION: "" },
    { VERSION: "02.46.0" },
    { VERSION: "2.46.0-rc.1" },
    { VERSION: "v2.46.0" },
    { VERSION: "2.46" },
    { VERSION: "10000.1.0" },
    { VERSION: "2.46.0\nlatest" },
    { VERSION: "latest" },
    { GITHUB_REPOSITORY: "invented/tarubot" },
  ]) {
    const f = fixture();
    refused(f, "Deploy needs an enabled target", changes);
    expect(f.calls()).toEqual([]);
  }
});

describe("only an approval given in this attempt moves a tag", () => {
  const url = (id: number) =>
    `https://github.com/deconfined/tarubot/actions/runs/37000000001/job/${id}`;
  const notHeld = (f: Fixture, target: Target) => {
    refused(f, `This deployment was not held for the ${target} approval in this attempt`);
    // Refused before the registry or the release is read.
    expect(f.calls().every((args) => args[0] === "gh" && args[1] === "api")).toBe(true);
  };

  for (const target of ["staging", "production"] as const) {
    describe(target, () => {
      test("a re-run let through on an earlier approval, or never held, is refused", () => {
        const f = fixture(target);
        f.state.statuses["55"] = [
          { state: "in_progress", target_url: url(777) },
          { state: "queued", target_url: url(777) },
        ];
        notHeld(f, target);
      });

      test("an earlier attempt's approval doesn't count for this attempt's job", () => {
        const f = fixture(target);
        f.state.deployments = [{ id: 56 }, { id: 55 }];
        f.state.statuses["56"] = [
          { state: "success", target_url: url(700) },
          { state: "waiting", target_url: url(700) },
        ];
        f.state.statuses["55"] = [{ state: "in_progress", target_url: url(777) }];
        notHeld(f, target);
      });

      test("a missing, ambiguous or finished own job is refused", () => {
        const other = target === "staging" ? "production" : "staging";
        for (const jobs of [
          [],
          [{ id: 777, name: `Deploy ${target}`, status: "completed" }],
          [{ id: 777, name: `Deploy ${other}`, status: "in_progress" }],
          [{ id: 777, name: `Not Deploy ${target}`, status: "in_progress" }],
          [
            { id: 777, name: `Deploy ${target}`, status: "in_progress" },
            { id: 778, name: `Deploy ${target}`, status: "in_progress" },
          ],
        ]) {
          const f = fixture(target);
          f.state.jobs = { jobs };
          notHeld(f, target);
        }
      });

      test("no deployment for this run is refused", () => {
        const f = fixture(target);
        f.state.deployments = [];
        notHeld(f, target);
      });
    });
  }

  test("an unreadable approval record asks for a re-run instead of blaming the approval", () => {
    const f = fixture();
    f.state.approvalApiExit = 1;
    const stdout = refused(f, "Could not read this attempt's approval record from GitHub");
    expect(stdout).not.toContain("not held for");
  });

  test("a malformed run, attempt or commit is refused before any call", () => {
    for (const changes of [
      { GITHUB_RUN_ATTEMPT: "" },
      { GITHUB_RUN_ATTEMPT: "0" },
      { GITHUB_RUN_ATTEMPT: "1;touch injected" },
      { GITHUB_RUN_ID: "" },
      { GITHUB_SHA: "main" },
    ]) {
      const f = fixture();
      refused(f, "This run's ID, attempt or commit is malformed.", changes);
      expect(f.calls()).toEqual([]);
    }
  });
});

describe("the release must be published, on main and signed", () => {
  test("a version without both images is refused", () => {
    for (const absent of [VERSION, `web-${VERSION}`]) {
      const f = fixture();
      delete f.state.tags[absent];
      refused(
        f,
        `Release ${VERSION} is not published as both ${IMAGE}:${VERSION} and ${IMAGE}:web-${VERSION}.`,
      );
    }
  });

  test("an unreadable registry asks for a re-run", () => {
    for (const failing of [VERSION, `web-${VERSION}`, "staging", "web-staging"]) {
      const f = fixture();
      f.state.failing = [failing];
      refused(f, "Could not read the published tags; re-run once GHCR answers.");
    }
  });

  test("the bot image must name one source commit", () => {
    for (const labels of [
      { version: VERSION },
      { revision: "main", version: VERSION },
      { revision: COMMIT.toUpperCase(), version: VERSION },
      { revision: COMMIT, arm64Revision: "b".repeat(40), version: VERSION },
    ]) {
      const f = fixture();
      f.state.labels[BOT] = labels;
      refused(f, `${IMAGE}:${VERSION} names no single source commit.`);
    }
    const unreadable = fixture();
    delete unreadable.state.labels[BOT];
    refused(unreadable, `Could not read the labels of ${IMAGE}@${BOT}; re-run once GHCR answers.`);
  });

  test("a commit that isn't on main is refused, and an unreadable one asks for a re-run", () => {
    for (const compare of ["behind", "diverged", "unknown", ""]) {
      const f = fixture();
      f.state.compare = compare;
      refused(f, `Release ${VERSION}'s commit ${COMMIT} is not on main.`);
    }
    const f = fixture();
    f.state.apiExit = 1;
    refused(f, `Could not read commit ${COMMIT} from GitHub; re-run once its API answers.`);
  });

  test("a commit whose package.json names another version is refused", () => {
    const f = fixture();
    f.state.version = "2.45.9";
    refused(f, `package.json at ${COMMIT} is version 2.45.9, not ${VERSION}.`);
  });

  test("either image without this commit's signed provenance is refused", () => {
    for (const unsigned of [BOT, WEB]) {
      for (const signed of [undefined, PREVIOUS_COMMIT]) {
        const f = fixture();
        if (signed) f.state.signed[unsigned] = signed;
        else delete f.state.signed[unsigned];
        refused(
          f,
          `The signed build provenance of ${IMAGE}:${VERSION} or ${IMAGE}:web-${VERSION} did not verify.`,
        );
      }
    }
  });
});

describe("rollbacks, first deployments and repeats", () => {
  test("an earlier version is deployed like any other: that is the rollback", () => {
    const f = fixture("production");
    f.state.tags.production = BOT;
    f.state.tags["web-production"] = WEB;
    f.state.labels[PREVIOUS_BOT] = { revision: PREVIOUS_COMMIT, version: "2.45.2" };
    f.state.version = "2.45.2";
    const result = f.run({ VERSION: "2.45.2" });
    expect(result.exitCode).toBe(0);
    expect(f.registry().tags.production).toBe(PREVIOUS_BOT);
    expect(f.registry().tags["web-production"]).toBe(PREVIOUS_WEB);
    expect(f.summary()).toContain(`the channel named ${VERSION} before.`);
  });

  test("a first deployment has no previous tags to name", () => {
    const f = fixture();
    delete f.state.tags.staging;
    delete f.state.tags["web-staging"];
    expect(f.run().exitCode).toBe(0);
    expect(f.registry().tags.staging).toBe(BOT);
    expect(f.summary()).toContain(`| \`${IMAGE}:staging\` | \`${BOT}\` | \`none\` |`);
    expect(f.summary()).toContain("the channel named none before.");
  });

  test("an unreadable previous version is only unknown in the summary", () => {
    const f = fixture();
    f.state.labels[PREVIOUS_BOT] = { revision: PREVIOUS_COMMIT, version: "| injected |" };
    expect(f.run().exitCode).toBe(0);
    expect(f.summary()).toContain("the channel named unknown before.");
    expect(f.summary()).not.toContain("injected");
  });

  test("deploying the live release again changes nothing and says so", () => {
    const f = fixture();
    f.state.tags.staging = BOT;
    f.state.tags["web-staging"] = WEB;
    const result = f.run();
    expect(result.exitCode).toBe(0);
    expect(f.registry().tags).toEqual(f.state.tags);
    expect(result.stdout.toString()).toContain(
      `::notice::${VERSION} was already the staging release; both tags are unchanged.`,
    );
  });
});

describe("moving the tags", () => {
  test("a failed web move leaves both tags; a failed bot move leaves the bot", () => {
    const web = fixture();
    web.state.createFails = ["web-staging"];
    const first = web.run();
    expect(first.exitCode).not.toBe(0);
    expect(first.stdout.toString()).toContain("::error::Moving the channel tags failed");
    redacted(first);
    expect(web.registry().tags.staging).toBe(PREVIOUS_BOT);
    expect(web.registry().tags["web-staging"]).toBe(PREVIOUS_WEB);
    const bot = fixture();
    bot.state.createFails = ["staging"];
    expect(bot.run().exitCode).not.toBe(0);
    expect(bot.registry().tags.staging).toBe(PREVIOUS_BOT);
  });

  test("a tag that names another digest afterwards fails the deployment", () => {
    for (const drift of ["staging", "web-staging"]) {
      const f = fixture();
      f.state.createFails = [`drift:${drift}`];
      const result = f.run();
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toContain(
        "::error::A channel tag does not name the verified digest after the move",
      );
      redacted(result);
    }
  });
});
