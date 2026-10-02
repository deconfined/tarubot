/** Fenced automatic adapter: native saved plans, full policy and ordinary encrypted records. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { infrastructureRecords, hostEnrollmentRecords } from "./infra-control-cli.js";
import type { HostEnrollmentRecords } from "./host-enrollment.js";
import {
  stateEvidence,
  verifyAppliedPlan,
  type InfrastructureRecords,
  type Snapshot,
} from "./infra-control.js";
import { classifyPlan, handoffBinding } from "./infra-policy.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";

function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error("invalid-automatic-infrastructure");
}
/** Explicit automatic caller binding: no dispatch overrides, re-runs, forks or stale config commit. */
export function requireAutomaticCaller(release: ReleaseIdentity, env: NodeJS.ProcessEnv): void {
  requireEvidence(
    env.GITHUB_REPOSITORY === "deconfined/tarubot" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "push" &&
      env.GITHUB_RUN_ATTEMPT === "1",
  );
  requireEvidence(
    env.GITHUB_SHA === release.commit &&
      env.GITHUB_RUN_ID === release.publication_run &&
      env.CONTROL_RECORDS_ENABLED === "true",
  );
  requireEvidence(
    env.GITHUB_WORKFLOW_REF === "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
  );
}
export function requireAutomaticPlan(
  plan: unknown,
  inputs: unknown,
  context: unknown,
): "safe" | "no-changes" {
  const control = context as { enabled?: unknown; snapshot?: Snapshot };
  requireEvidence(
    control?.enabled === true && control.snapshot?.generation && control.snapshot.inputs,
  );
  const result = classifyPlan(plan, inputs, control.snapshot.inputs);
  requireEvidence(result.decision === "safe" || result.decision === "no-changes");
  return result.decision;
}
interface Dependencies {
  execute?: (argv: string[], name: string) => Uint8Array;
  records?: Pick<InfrastructureRecords, "inspect" | "begin" | "finish">;
  enrollment?: Pick<HostEnrollmentRecords, "requireNoPending">;
}
/** The workflow's native infra concurrency group encloses Plan, Apply and completion. */
export async function automaticInfrastructure(
  command: "plan" | "apply",
  release: ReleaseIdentity,
  directory: string,
  env: NodeJS.ProcessEnv,
  deps: Dependencies = {},
): Promise<void> {
  requireEvidence(command === "plan" || command === "apply");
  requireAutomaticCaller(release, env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const persist = (name: string, bytes: string | Uint8Array) =>
    writeFileSync(join(directory, name), bytes, { mode: 0o600 });
  const write = (name: string, value: unknown) => persist(name, JSON.stringify(value));
  const json = (bytes: string): unknown => {
    requireEvidence(Buffer.byteLength(bytes) <= 2 * 1024 * 1024);
    return JSON.parse(bytes);
  };
  const read = (name: string): unknown => json(readFileSync(join(directory, name), "utf8"));
  const execute = (argv: string[], name: string): Uint8Array => {
    if (deps.execute) return deps.execute(argv, name);
    // Workflow job timeouts bound execution; command diagnostics stay in private runner files.
    const childEnv =
      argv[0] === "gh" ? { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN } : { ...env };
    const result = Bun.spawnSync([...argv], { env: childEnv, maxBuffer: 2 * 1024 * 1024 });
    persist(`${name}.stdout`, result.stdout);
    persist(`${name}.stderr`, result.stderr);
    requireEvidence(result.exitCode === 0);
    return result.stdout;
  };
  const fresh = () => {
    const value = json(
      Buffer.from(
        execute(["gh", "api", "repos/deconfined/tarubot/git/ref/heads/main"], "freshness"),
      ).toString(),
    ) as { object?: { sha?: unknown } };
    requireEvidence(value?.object?.sha === release.commit);
  };
  const phase = (name: string) =>
    execute(["bash", "ops/tofu/ci/tofu-ci.sh", name], `phase-${name}`);
  const tofu = (args: string[], name: string) => {
    const bytes = Buffer.from(execute(["tofu", "-chdir=ops/tofu", ...args], name));
    requireEvidence(bytes.length <= 2 * 1024 * 1024);
    persist(`${name}.json`, bytes);
    return json(bytes.toString());
  };
  const noHostPending = () =>
    (
      deps.enrollment ??
      hostEnrollmentRecords(env.STATE_BUCKET ?? "", env.STATE_ENDPOINT ?? "", env)
    ).requireNoPending();
  fresh();
  phase("prepare");
  // No automatic input can request replacement, deletion, import or access-list removal.
  requireEvidence(
    readFileSync(join(directory, "replace"), "utf8") === "" &&
      !env.ALLOW_DESTROY &&
      !env.ALLOW_ACCESS_REMOVAL,
  );
  write("release-context.json", release);
  phase("init");
  phase("control_read");
  if (command === "plan") {
    phase("plan");
    phase("summarize");
    const context = read("control-context.json") as { snapshot: Snapshot };
    const decision = requireAutomaticPlan(read("plan.json"), read("values.tfvars.json"), context);
    if (decision === "no-changes") {
      const before = stateEvidence(tofu(["state", "pull"], "state-before"));
      requireEvidence(isDeepStrictEqual(before, context.snapshot.state));
      const shown = tofu(["show", "-json"], "applied-state");
      verifyAppliedPlan(read("plan.json"), shown);
      const reopened = stateEvidence(tofu(["state", "pull"], "state-verified"));
      requireEvidence(isDeepStrictEqual(reopened, before));
      // Reopen all completion links; a copied Plan snapshot is never sufficient by itself.
      const records = deps.records ?? infrastructureRecords(directory, env);
      requireEvidence(isDeepStrictEqual(await records.inspect(reopened), context.snapshot));
      await noHostPending();
    }
    fresh();
    requireEvidence(env.GITHUB_OUTPUT);
    appendFileSync(
      env.GITHUB_OUTPUT,
      `decision=${decision}\nverified=${decision === "no-changes"}\n`,
    );
    return;
  }
  requireEvidence(env.LINODE_TOKEN && env.CLOUDFLARE_API_TOKEN);
  const shown = tofu(["show", "-json", join(directory, "plan.bin")], "plan");
  const context = read("control-context.json") as { snapshot: Snapshot };
  const inputs = read("values.tfvars.json") as Record<string, unknown>;
  requireEvidence(requireAutomaticPlan(shown, inputs, context) === "safe");
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "plan.bin")))
    .digest("hex");
  const binding = handoffBinding(directory, env);
  requireEvidence(env.DIGEST === digest && env.BINDING === binding);
  const before = stateEvidence(tofu(["state", "pull"], "state-before"));
  requireEvidence(isDeepStrictEqual(before, context.snapshot.state));
  fresh();
  await noHostPending();
  const records = deps.records ?? infrastructureRecords(directory, env);
  // Native Records begin reopens the baseline and durably readbacks intent + pending before Apply.
  const ticket = await records.begin(
    context.snapshot,
    inputs,
    { commit: release.commit, run: release.publication_run },
    binding,
    "apply",
  );
  requireEvidence(handoffBinding(directory, env) === binding);
  fresh();
  execute(
    ["tofu", "-chdir=ops/tofu", "apply", "-input=false", "-json", join(directory, "plan.bin")],
    "apply",
  );
  const state = stateEvidence(tofu(["state", "pull"], "state-after"));
  verifyAppliedPlan(shown, tofu(["show", "-json"], "applied-state"));
  requireEvidence(
    isDeepStrictEqual(stateEvidence(tofu(["state", "pull"], "state-verified")), state),
  );
  await records.finish(ticket, state);
  fresh();
  requireEvidence(env.GITHUB_OUTPUT);
  appendFileSync(env.GITHUB_OUTPUT, "verified=true\n");
}
if (import.meta.main) {
  try {
    const command = process.argv[2];
    requireEvidence(
      process.argv.length === 3 &&
        (command === "plan" || command === "apply") &&
        process.env.RUNNER_TEMP,
    );
    const release = releaseIdentity({
      version: process.env.VERSION,
      commit: process.env.COMMIT,
      digest: process.env.RELEASE_DIGEST,
      config_commit: process.env.COMMIT,
      publication_run: process.env.PUBLICATION_RUN,
      schema_head: process.env.SCHEMA_HEAD,
    });
    await automaticInfrastructure(
      command,
      release,
      join(process.env.RUNNER_TEMP, "tofu"),
      process.env,
    );
  } catch {
    console.log(
      "::error::Automatic infrastructure refused or failed; promotion is blocked. Reconcile any pending operation before another write.",
    );
    process.exitCode = 1;
  }
}
