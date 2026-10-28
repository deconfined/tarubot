/**
 * Execute deploy.yml's real Bash/jq step against invented GitHub API, registry and attestation
 * answers only. A deployment moves exactly the target's two channel tags (`<target>` and
 * `web-<target>`) in ghcr.io/deconfined/tarubot-release to one release's verified digests, and
 * writes nothing to ghcr.io/deconfined/tarubot, where publish.yml put the release. It does so only
 * with the selected environment's RELEASE_REGISTRY_TOKEN (the only credential that can write the
 * release package; every workflow's GITHUB_TOKEN can write the other), when its target is
 * switched on, its version is published as both images, the bot image's source commit is on main
 * and carries that version, both digests carry that commit's signed provenance, the owner
 * approved this attempt, and, for a publication (publish.yml's call, a push), the channel doesn't
 * already name a newer release. Anything else moves nothing.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const RELEASE = "ghcr.io/deconfined/tarubot-release";
const VERSION = "2.46.0";
const COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "e".repeat(40);
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
const BOT = digest("bot 2.46.0");
const WEB = digest("web 2.46.0");
const PREVIOUS_BOT = digest("bot 2.45.2");
const PREVIOUS_WEB = digest("web 2.45.2");
/** The environment's release package token; it must never reach a log or an argument list. */
const RELEASE_TOKEN = "ghp_inventedReleaseToken0123456789abcdef";

type Target = "production" | "staging";
type Labels = { revision?: string; version?: string; arm64Revision?: string };
type State = {
  /** ghcr.io/deconfined/tarubot, where publish.yml put the release: tag -> index digest. */
  tags: Record<string, string>;
  /** ghcr.io/deconfined/tarubot-release's channel tags; null while the package doesn't exist. */
  release: Record<string, string> | null;
  /** Tags whose reads fail with a server error, in either repository. */
  failing: string[];
  /** The GitHub API's answer about the release package; 0 answers 200 or 404 by `release`. */
  packageStatus: number;
  /** The X-OAuth-Scopes header GitHub sends with that answer (a classic token's); null, none. */
  packageScopes: string | null;
  /** docker login with the release token fails. */
  loginFails: boolean;
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
    latest: BOT,
    "web-latest": WEB,
  },
  release: { [target]: PREVIOUS_BOT, [`web-${target}`]: PREVIOUS_WEB },
  failing: [],
  packageStatus: 0,
  packageScopes: "read:packages, write:packages",
  loginFails: false,
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

/** Adds a published, signed release X.Y.Z of its own commit to the registry; its two digests. */
function publish(state: State, version: string) {
  const commit = createHash("sha1").update(version).digest("hex");
  const [bot, web] = [digest(`bot ${version}`), digest(`web ${version}`)];
  state.tags[version] = bot;
  state.tags[`web-${version}`] = web;
  for (const image of [bot, web]) {
    state.labels[image] = { revision: commit, version };
    state.signed[image] = commit;
  }
  return { bot, web };
}

/** Answers like gh: the approval lookups, the commit checks and attestation verification. */
const GH = `
const diagnostic = "invented-private-api-diagnostic.example.org\\n::error::injected-diagnostic";
// gh only ever holds this run's own token.
if (process.env.GH_TOKEN !== "invented-github-token") process.exit(70);
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
 * Answers like GHCR, GitHub's API and curl do, so a script that drops a flag fails here too:
 * credentials come only from --config - on stdin; manifests need the right repository's bearer
 * token and the index media type; --fail turns >= 400 into exit 22; output goes only to
 * --write-out and to --dump-header (standard output or a file). GHCR issues no token for, and
 * won't read, a package that doesn't exist yet (it answers as for a private one); GitHub's
 * packages API says 404, and lists a classic token's scopes in X-OAuth-Scopes.
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
  const head = "HTTP/2 " + code + "\\r\\n" + headers + "\\r\\n";
  if (after("--dump-header") === "-") process.stdout.write(head);
  else if (after("--dump-header")) writeFileSync(after("--dump-header"), head);
  if (flag("--write-out")) process.stdout.write(String(code));
  process.exit(0);
};
if (after("--config") !== "-") process.exit(70);
const repositories = {
  "deconfined/tarubot": { user: 'user = "invented-user:invented-github-token"', token: "invented-registry-token", tags: state.tags },
  "deconfined/tarubot-release": { user: 'user = "deconfined:${RELEASE_TOKEN}"', token: "invented-release-registry-token", tags: state.release },
};
if (url === "https://api.github.com/users/deconfined/packages/container/tarubot-release") {
  if (after("--write-out") !== "%{http_code}" || after("--output") !== "/dev/null") process.exit(70);
  if (!config.includes('header = "Authorization: Bearer ${RELEASE_TOKEN}"')) answer(401);
  const scopes = state.packageScopes === null ? "" : "x-oauth-scopes: " + state.packageScopes + "\\r\\n";
  answer(state.packageStatus || (state.release ? 200 : 404), "server: GitHub.com\\r\\n" + scopes);
}
const token = url?.match(/^https:\\/\\/ghcr\\.io\\/token\\?service=ghcr\\.io&scope=repository:(deconfined\\/[a-z-]+):pull$/);
if (token) {
  const repository = repositories[token[1]];
  if (!repository || !config.includes(repository.user)) answer(401);
  if (!repository.tags) answer(403);
  process.stdout.write(JSON.stringify({ token: repository.token }));
  process.exit(0);
}
const match = url?.match(/^https:\\/\\/ghcr\\.io\\/v2\\/(deconfined\\/[a-z-]+)\\/manifests\\/([A-Za-z0-9._-]+)$/);
const repository = repositories[match?.[1]];
if (!match || !repository || !flag("--head")) process.exit(70);
if (!config.includes('header = "Authorization: Bearer ' + repository.token + '"')) answer(401);
if (!repository.tags) answer(403);
if (!(after("--header") ?? "").includes("application/vnd.oci.image.index.v1+json")) answer(404);
if (state.failing.includes(match[2])) answer(500);
if (!repository.tags[match[2]]) answer(404);
answer(200, "docker-content-digest: " + repository.tags[match[2]] + "\\r\\n");
`;

/**
 * docker login stores the release token in DOCKER_CONFIG (only a private one under RUNNER_TEMP);
 * imagetools inspect prints a multi-platform index's image configs; create copies one index of
 * the release images to a tag. The release package is read and written only with that login.
 */
const DOCKER = `
const config = process.env.DOCKER_CONFIG;
const privateConfig = !!config && config.startsWith(process.env.RUNNER_TEMP + "/");
const loggedIn = () => {
  if (!privateConfig) return false;
  try { return JSON.parse(readFileSync(config + "/config.json", "utf8")).auths["ghcr.io"].secret === "${RELEASE_TOKEN}"; }
  catch { return false; }
};
if (args[0] === "login") {
  if (args.join(" ") !== "login ghcr.io --username deconfined --password-stdin" || !privateConfig) process.exit(70);
  const secret = (await new Response(Bun.stdin.stream()).text()).trim();
  if (state.loginFails) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
  mkdirSync(config, { recursive: true });
  writeFileSync(config + "/config.json", JSON.stringify({ auths: { "ghcr.io": { secret } } }));
  process.exit(0);
}
if (args[0] !== "buildx" || args[1] !== "imagetools") process.exit(70);
const reference = (text, separator) =>
  text?.match(new RegExp("^ghcr\\\\.io\\\\/(deconfined\\\\/tarubot(?:-release)?)" + separator + "([A-Za-z0-9._:-]+)$"));
if (args[2] === "inspect") {
  const subject = reference(args[3], "@");
  if (!subject || args[4] !== "--format" || args[5] !== "{{json .Image}}" || args.length !== 6) process.exit(70);
  const inRelease = subject[1] === "deconfined/tarubot-release";
  const labels = state.labels[subject[2]];
  const present = inRelease ? loggedIn() && Object.values(state.release ?? {}).includes(subject[2]) : true;
  if (!labels || !present) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
  const image = (revision) => ({ config: { Labels: {
    ...(revision === undefined ? {} : { "org.opencontainers.image.revision": revision }),
    ...(labels.version === undefined ? {} : { "org.opencontainers.image.version": labels.version }),
  } } });
  console.log(JSON.stringify({
    "linux/amd64": image(labels.revision),
    "linux/arm64": image(labels.arm64Revision ?? labels.revision),
  }));
  process.exit(0);
}
if (args[2] !== "create" || args[3] !== "--tag" || args.length !== 6) process.exit(70);
const target = reference(args[4], ":");
const from = reference(args[5], "@");
// Copies come only from the release images publish.yml pushed.
if (!target || !from || from[1] !== "deconfined/tarubot") process.exit(70);
const [, repository, tag] = target;
if (repository === "deconfined/tarubot-release" && !loggedIn()) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
if (state.createFails.includes(tag)) { console.error("invented-private-registry-diagnostic"); process.exit(1); }
const moved = state.createFails.includes("drift:" + tag) ? "sha256:" + "f".repeat(64) : from[2];
if (repository === "deconfined/tarubot-release") state.release = { ...(state.release ?? {}), [tag]: moved };
else state.tags[tag] = moved;
writeFileSync(STATE, JSON.stringify(state));
`;

type Fixture = {
  state: State;
  calls: () => string[][];
  /** The registry after the run. */
  registry: () => State;
  summary: () => string;
  /** What the step left in RUNNER_TEMP. */
  leftovers: () => string[];
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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    leftovers: () => readdirSync(runner),
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
          // publish.yml's call: a called workflow sees its caller's push.
          GITHUB_EVENT_NAME: "push",
          GH_TOKEN: "invented-github-token",
          GHCR_USER: "invented-user",
          GHCR_TOKEN: "invented-github-token",
          RELEASE_USER: "deconfined",
          RELEASE_REGISTRY_TOKEN: RELEASE_TOKEN,
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

/** Diagnostics, both tokens and private paths never reach the public log or an argument list. */
function redacted(f: Fixture, result: Bun.SyncSubprocess<"pipe", "pipe">) {
  const logs = result.stdout.toString() + result.stderr.toString();
  for (const privateText of [
    "invented-private-api-diagnostic",
    "injected-diagnostic",
    "invented-private-registry-diagnostic",
    "invented-github-token",
    RELEASE_TOKEN,
    scratch,
  ])
    expect(logs).not.toContain(privateText);
  // The registry tokens appear only where the runner masks them.
  for (const line of logs.split("\n"))
    for (const token of ["invented-registry-token", "invented-release-registry-token"])
      if (line.includes(token)) expect(line).toBe(`::add-mask::${token}`);
  // The release token travels only on standard input (login, curl's configuration).
  for (const call of f.calls()) expect(call.join(" ")).not.toContain(RELEASE_TOKEN);
  // Its private Docker configuration goes with the step's private directory.
  expect(f.leftovers()).toEqual([]);
}

const creates = (f: Fixture) =>
  f.calls().filter((args) => args[0] === "docker" && args[3] === "create");

/** Refused with this reason on the public log, and no tag moved in either repository. */
function refused(f: Fixture, reason: string, changes: Record<string, string> = {}) {
  const before = structuredClone({ tags: f.state.tags, release: f.state.release });
  const result = f.run(changes);
  expect(result.exitCode).not.toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout).toContain(`::error::${reason}`);
  expect(stdout).toContain("No tag was moved.");
  redacted(f, result);
  expect(creates(f)).toEqual([]);
  const after = f.registry();
  expect({ tags: after.tags, release: after.release }).toEqual(before);
  return stdout;
}

describe("the workflow's shape", () => {
  test("one approved job per target, its switch, main only, and no host tooling", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
    expect(Object.keys(workflow.on.workflow_call?.inputs ?? {})).toEqual(["target", "version"]);
    expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {})).toEqual(["target", "version"]);
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
    expect(job.steps.map((step) => step.uses?.split("@")[0] ?? "run")).toEqual([
      "docker/setup-buildx-action",
      "docker/login-action",
      "run",
    ]);
    expect(source.toLowerCase()).not.toContain("ssh");
  });

  test("this run's token only reads packages; the environment's token is the only writer", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      attestations: "read",
      deployments: "read",
      packages: "read",
    });
    // Declared for publish.yml's call, never required of it: the caller has no environment, so
    // only the approved environment job resolves a value.
    expect(workflow.on.workflow_call?.secrets).toEqual({
      RELEASE_REGISTRY_TOKEN: {
        description: expect.any(String),
        required: false,
      },
    });
    const secrets = new Set(
      [...source.matchAll(/secrets\.([A-Za-z_]+)/gu)].map((match) => match[1]),
    );
    expect(secrets).toEqual(new Set(["GITHUB_TOKEN", "RELEASE_REGISTRY_TOKEN"]));
    // Only the deployment step receives it; the registry login action holds the run's token.
    const holders = job.steps.filter((step) => JSON.stringify(step).includes("RELEASE_REGISTRY"));
    expect(holders).toEqual(scripts);
    expect(scripts[0]?.env?.RELEASE_REGISTRY_TOKEN).toBe(`\${{ secrets.RELEASE_REGISTRY_TOKEN }}`);
    expect(scripts[0]?.env?.RELEASE_USER).toBe(`\${{ github.repository_owner }}`);
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
  });
});

for (const target of ["staging", "production"] as const) {
  const other = target === "staging" ? "production" : "staging";
  describe(`a ${target} deployment`, () => {
    test("moves exactly its two tags in the release package to exactly the verified digests, web first", () => {
      const f = fixture(target);
      f.state.release = {
        ...f.state.release,
        [other]: PREVIOUS_BOT,
        [`web-${other}`]: PREVIOUS_WEB,
      };
      const result = f.run();
      expect(result.exitCode).toBe(0);
      redacted(f, result);
      expect(creates(f)).toEqual([
        [
          "docker",
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${RELEASE}:web-${target}`,
          `${IMAGE}@${WEB}`,
        ],
        [
          "docker",
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${RELEASE}:${target}`,
          `${IMAGE}@${BOT}`,
        ],
      ]);
      const after = f.registry();
      expect(after.release).toEqual({
        ...f.state.release,
        [target]: BOT,
        [`web-${target}`]: WEB,
      });
      // Nothing is written where every workflow's token could write too.
      expect(after.tags).toEqual(f.state.tags);
      // Logged in once, privately, with the release token on standard input.
      expect(f.calls().filter((args) => args[0] === "docker" && args[1] === "login")).toEqual([
        ["docker", "login", "ghcr.io", "--username", "deconfined", "--password-stdin"],
      ]);
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
        `| \`${RELEASE}:${target}\` | \`${BOT}\` | \`${PREVIOUS_BOT}\` |`,
        `| \`${RELEASE}:web-${target}\` | \`${WEB}\` | \`${PREVIOUS_WEB}\` |`,
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
      expect(f.registry().release?.[target]).toBe(BOT);
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

    test("without its environment's release token nothing is checked, read or moved", () => {
      for (const token of ["", 'ghp_invented"\nurl = "https://example.org', "ghp_with space"]) {
        const f = fixture(target);
        refused(
          f,
          `Deploy needs the RELEASE_REGISTRY_TOKEN secret of the ${target} environment: a classic personal access token with write:packages, the only credential that moves the channel tags in ${RELEASE}.`,
          { RELEASE_REGISTRY_TOKEN: token },
        );
        expect(f.calls()).toEqual([]);
      }
    });
  });
}

test("an empty release token is reported first, naming no unchecked target", () => {
  const f = fixture();
  const stdout = refused(
    f,
    "Deploy needs the RELEASE_REGISTRY_TOKEN secret of the selected environment",
    {
      RELEASE_REGISTRY_TOKEN: "",
      TARGET: "staging\n::error::injected",
      VERSION: "latest",
    },
  );
  expect(stdout).not.toContain("injected");
  expect(f.calls()).toEqual([]);
});

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

test("a malformed version, repository or package owner fails before any GitHub or registry call", () => {
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
    { RELEASE_USER: "invented" },
    { RELEASE_USER: "" },
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

  test("a release only in the release package is not published", () => {
    // Verification reads where publish.yml put the release, never the channel package.
    const f = fixture();
    delete f.state.tags[VERSION];
    f.state.release = { ...f.state.release, [VERSION]: BOT };
    refused(f, `Release ${VERSION} is not published as both`);
  });

  test("an unreadable registry asks for a re-run", () => {
    for (const failing of [VERSION, `web-${VERSION}`]) {
      const f = fixture();
      f.state.failing = [failing];
      refused(f, "Could not read the published tags; re-run once GHCR answers.");
    }
    for (const failing of ["staging", "web-staging"]) {
      const f = fixture();
      f.state.failing = [failing];
      refused(f, `Could not read the channel tags in ${RELEASE}; re-run once GHCR answers.`);
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

describe("the release package's token", () => {
  test("refused by GitHub, or GitHub unreadable, moves nothing", () => {
    for (const packageStatus of [401, 403, 500]) {
      const f = fixture();
      f.state.packageStatus = packageStatus;
      refused(
        f,
        "GitHub refused the staging environment's RELEASE_REGISTRY_TOKEN, or didn't answer; check that secret, or re-run once GitHub answers.",
      );
    }
    // A token GitHub doesn't know as this account's.
    const wrong = fixture();
    refused(wrong, "GitHub refused the staging environment's RELEASE_REGISTRY_TOKEN", {
      RELEASE_REGISTRY_TOKEN: "ghp_another",
    });
  });

  test("a token with any scope but the package ones, or without write:packages, moves nothing", () => {
    for (const packageScopes of [
      // GitHub's default when write:packages is ticked on a new classic token.
      "repo, write:packages",
      "read:packages, repo, write:packages",
      "delete:packages, read:packages, write:packages",
      "read:packages",
      "",
      // No such header: not a classic token's answer.
      null,
    ]) {
      const f = fixture();
      f.state.packageScopes = packageScopes;
      refused(
        f,
        "The RELEASE_REGISTRY_TOKEN secret of the staging environment may hold write:packages and read:packages only: create the token again with repo and every other scope unticked, and replace the secret.",
      );
    }
    // However GitHub spaces or orders them, the package scopes alone pass.
    for (const packageScopes of ["write:packages", "write:packages,read:packages"]) {
      const f = fixture();
      f.state.packageScopes = packageScopes;
      const result = f.run();
      expect(result.exitCode).toBe(0);
      expect(f.registry().release).toEqual({ staging: BOT, "web-staging": WEB });
    }
  });

  test("refused by GHCR moves nothing", () => {
    const f = fixture();
    f.state.loginFails = true;
    refused(
      f,
      `GHCR refused the staging environment's RELEASE_REGISTRY_TOKEN for ${RELEASE}, or didn't answer; check that secret, or re-run once GHCR answers.`,
    );
  });
});

describe("first deployments", () => {
  test("the first deployment creates the release package, which GHCR wouldn't read before", () => {
    const f = fixture();
    f.state.release = null;
    const result = f.run();
    expect(result.exitCode).toBe(0);
    redacted(f, result);
    expect(f.registry().release).toEqual({ staging: BOT, "web-staging": WEB });
    expect(f.registry().tags).toEqual(f.state.tags);
    expect(f.summary()).toContain(`| \`${RELEASE}:staging\` | \`${BOT}\` | \`none\` |`);
    expect(f.summary()).toContain("the channel named none before.");
  });

  test("a target's first deployment beside the other target's channel", () => {
    const f = fixture();
    f.state.release = { production: PREVIOUS_BOT, "web-production": PREVIOUS_WEB };
    expect(f.run().exitCode).toBe(0);
    expect(f.registry().release).toEqual({
      production: PREVIOUS_BOT,
      "web-production": PREVIOUS_WEB,
      staging: BOT,
      "web-staging": WEB,
    });
    expect(f.summary()).toContain("the channel named none before.");
  });
});

describe("rollbacks and repeats", () => {
  const dispatched = { GITHUB_EVENT_NAME: "workflow_dispatch" };

  test("a dispatched earlier version is deployed like any other: that is the rollback", () => {
    const f = fixture("production");
    f.state.release = { production: BOT, "web-production": WEB };
    f.state.version = "2.45.2";
    const result = f.run({ ...dispatched, VERSION: "2.45.2" });
    expect(result.exitCode).toBe(0);
    expect(f.registry().release).toEqual({
      production: PREVIOUS_BOT,
      "web-production": PREVIOUS_WEB,
    });
    expect(f.summary()).toContain(`the channel named ${VERSION} before.`);
  });

  test("a publication never moves a channel back", () => {
    for (const event of ["push", "", "schedule"]) {
      const f = fixture("production");
      f.state.release = { production: BOT, "web-production": WEB };
      f.state.version = "2.45.2";
      refused(
        f,
        `A publication never moves production back from ${VERSION} to 2.45.2; dispatch Deploy with the earlier version to roll back.`,
        { GITHUB_EVENT_NAME: event, VERSION: "2.45.2" },
      );
    }
  });

  test("versions compare as numbers, component by component", () => {
    for (const [current, next, moves] of [
      ["2.9.0", "2.10.0", true],
      ["2.46.9", "2.46.10", true],
      ["1.99.99", "2.0.0", true],
      ["2.10.0", "2.9.0", false],
      ["2.46.10", "2.46.9", false],
      ["10.0.0", "9.99.99", false],
    ] as const) {
      const f = fixture();
      const live = publish(f.state, current);
      const wanted = publish(f.state, next);
      f.state.release = { staging: live.bot, "web-staging": live.web };
      f.state.version = next;
      if (moves) {
        expect({ current, next, status: f.run({ VERSION: next }).exitCode }).toEqual({
          current,
          next,
          status: 0,
        });
        expect(f.registry().release).toEqual({ staging: wanted.bot, "web-staging": wanted.web });
      } else
        refused(f, `A publication never moves staging back from ${current} to ${next};`, {
          VERSION: next,
        });
    }
  });

  test("an unreadable current version stops a publication, but not a dispatch", () => {
    const labels = (f: Fixture) => {
      f.state.labels[PREVIOUS_BOT] = { revision: PREVIOUS_COMMIT, version: "| injected |" };
    };
    const published = fixture();
    labels(published);
    const stdout = refused(
      published,
      `A publication can't tell which release staging runs now (${RELEASE}:staging has no readable version), so it moves nothing; re-run once GHCR answers, or dispatch Deploy to choose the release.`,
    );
    expect(stdout).not.toContain("injected");
    // The same when the channel's image can't be inspected at all.
    const uninspectable = fixture();
    delete uninspectable.state.labels[PREVIOUS_BOT];
    refused(uninspectable, "A publication can't tell which release staging runs now");
    const chosen = fixture();
    labels(chosen);
    expect(chosen.run(dispatched).exitCode).toBe(0);
    expect(chosen.registry().release?.staging).toBe(BOT);
    expect(chosen.summary()).toContain("the channel named unknown before.");
    expect(chosen.summary()).not.toContain("injected");
  });

  test("deploying the live release again changes nothing and says so", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const f = fixture();
      f.state.release = { staging: BOT, "web-staging": WEB };
      const result = f.run({ GITHUB_EVENT_NAME: event });
      expect(result.exitCode).toBe(0);
      expect(f.registry().release).toEqual(f.state.release);
      expect(result.stdout.toString()).toContain(
        `::notice::${VERSION} was already the staging release; both tags are unchanged.`,
      );
    }
  });
});

describe("moving the tags", () => {
  test("a failed web move leaves both tags; a failed bot move leaves the bot", () => {
    const web = fixture();
    web.state.createFails = ["web-staging"];
    const first = web.run();
    expect(first.exitCode).not.toBe(0);
    expect(first.stdout.toString()).toContain("::error::Moving the channel tags failed");
    redacted(web, first);
    expect(web.registry().release).toEqual(web.state.release);
    const bot = fixture();
    bot.state.createFails = ["staging"];
    expect(bot.run().exitCode).not.toBe(0);
    expect(bot.registry().release?.staging).toBe(PREVIOUS_BOT);
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
      redacted(f, result);
    }
  });
});
