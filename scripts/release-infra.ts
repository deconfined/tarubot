/** New automatic adapter. Reuses planning/journal components, not the legacy reviewed Apply path. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { infrastructureJournal } from "./infra-control-cli.js";
import {
  stateEvidence,
  verifyAppliedPlan,
  type InfrastructureJournal,
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
  journal?: InfrastructureJournal;
}
/** The workflow's infra concurrency group must enclose BOTH phases; this helper is not a lock. */
export async function automaticInfrastructure(
  command: "plan" | "apply",
  release: ReleaseIdentity,
  directory: string,
  env: NodeJS.ProcessEnv,
  deps: Dependencies = {},
): Promise<void> {
  requireAutomaticCaller(release, env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const read = (name: string): unknown => JSON.parse(readFileSync(join(directory, name), "utf8"));
  const execute =
    deps.execute ??
    ((argv, name) => {
      const childEnv =
        argv[0] === "gh" ? { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN } : env;
      const result = Bun.spawnSync(argv, { env: childEnv });
      writeFileSync(join(directory, `${name}.stdout`), result.stdout, { mode: 0o600 });
      writeFileSync(join(directory, `${name}.stderr`), result.stderr, { mode: 0o600 });
      requireEvidence(result.exitCode === 0);
      return result.stdout;
    });
  const fresh = () => {
    const result = JSON.parse(
      Buffer.from(
        execute(["gh", "api", "repos/deconfined/tarubot/git/ref/heads/main"], "freshness"),
      ).toString(),
    );
    requireEvidence(result?.object?.sha === release.commit);
  };
  const phase = (name: string) =>
    execute(["bash", "ops/tofu/ci/tofu-ci.sh", name], `phase-${name}`);
  const tofu = (args: string[], name: string) => {
    const bytes = execute(["tofu", "-chdir=ops/tofu", ...args], name);
    writeFileSync(join(directory, `${name}.json`), bytes, { mode: 0o600 });
    return JSON.parse(Buffer.from(bytes).toString());
  };
  fresh();
  phase("prepare");
  // No input/secret may opt this lane into replace, deletion or access removal.
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
    const decision = requireAutomaticPlan(
      read("plan.json"),
      read("values.tfvars.json"),
      read("control-context.json"),
    );
    if (decision === "no-changes") {
      // A read-only continuation still needs stable state and a completed matching baseline.
      const context = read("control-context.json") as { snapshot: Snapshot };
      const before = stateEvidence(tofu(["state", "pull", "-unencrypted"], "state-before"));
      requireEvidence(isDeepStrictEqual(before, context.snapshot.state));
      verifyAppliedPlan(read("plan.json"), tofu(["show", "-json"], "applied-state"));
      requireEvidence(
        isDeepStrictEqual(
          stateEvidence(tofu(["state", "pull", "-unencrypted"], "state-verified")),
          before,
        ),
      );
      const journal = deps.journal ?? infrastructureJournal(directory, env);
      requireEvidence(isDeepStrictEqual(await journal.inspect(before), context.snapshot));
    }
    fresh();
    requireEvidence(env.GITHUB_OUTPUT);
    appendFileSync(
      env.GITHUB_OUTPUT,
      `decision=${decision}\nverified=${decision === "no-changes"}\n`,
    );
    return;
  }
  requireEvidence(command === "apply" && env.LINODE_TOKEN && env.CLOUDFLARE_API_TOKEN);
  const shown = tofu(["show", "-json", join(directory, "plan.bin")], "plan");
  const context = read("control-context.json") as { snapshot: Snapshot };
  const inputs = read("values.tfvars.json") as Record<string, unknown>;
  requireEvidence(requireAutomaticPlan(shown, inputs, context) === "safe");
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "plan.bin")))
    .digest("hex");
  const binding = handoffBinding(directory, env);
  requireEvidence(env.DIGEST === digest && env.BINDING === binding);
  const journal = deps.journal ?? infrastructureJournal(directory, env);
  const before = stateEvidence(tofu(["state", "pull", "-unencrypted"], "state-before"));
  requireEvidence(isDeepStrictEqual(before, context.snapshot.state));
  fresh();
  const ticket = await journal.begin(
    context.snapshot,
    inputs,
    { commit: release.commit, run: release.publication_run },
    binding,
    "apply",
  );
  requireEvidence(handoffBinding(directory, env) === binding);
  fresh();
  // The exact saved file alone; no replan with write credentials and no unconditional repair.
  execute(
    ["tofu", "-chdir=ops/tofu", "apply", "-input=false", "-json", join(directory, "plan.bin")],
    "apply",
  );
  const state = stateEvidence(tofu(["state", "pull", "-unencrypted"], "state-after"));
  verifyAppliedPlan(shown, tofu(["show", "-json"], "applied-state"));
  requireEvidence(
    isDeepStrictEqual(
      stateEvidence(tofu(["state", "pull", "-unencrypted"], "state-verified")),
      state,
    ),
  );
  await journal.finish(ticket, state);
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
