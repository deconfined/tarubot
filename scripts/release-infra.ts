/** New automatic adapter. Reuses planning/journal components, not the legacy reviewed Apply path. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { legacyTargetJournal } from "./infra-control-cli.js";
import {
  stateEvidence,
  verifyAppliedPlan,
  type InfrastructureJournal,
  type Snapshot,
} from "./infra-control.js";
import { classifyPlan, handoffBinding } from "./infra-policy.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import {
  assertTargetCandidatePreparation,
  remainingTargetCandidatePreparation,
  sealPendingTargetCandidate,
  type TargetCandidatePreparation,
} from "./target-candidate.js";
import type { AppliedTargetProducer } from "./target-descriptor.js";
import type { TargetRole } from "./ssh-trust.js";

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
  execute?: (argv: string[], name: string, timeout?: number) => Uint8Array;
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
  let preparation: TargetCandidatePreparation | undefined;
  const denial = () => {
    if (preparation) assertTargetCandidatePreparation(preparation);
  };
  const persist = (name: string, bytes: string | Uint8Array) => {
    const path = join(directory, name);
    denial();
    writeFileSync(path, bytes, { mode: 0o600 });
    denial();
  };
  const write = (name: string, value: unknown) => {
    denial();
    const bytes = JSON.stringify(value);
    denial();
    persist(name, bytes);
  };
  const json = (bytes: string): unknown => {
    denial();
    requireEvidence(Buffer.byteLength(bytes) <= 2 * 1024 * 1024);
    const value = JSON.parse(bytes);
    denial();
    return value;
  };
  const read = (name: string): unknown => {
    denial();
    const bytes = readFileSync(join(directory, name), "utf8");
    denial();
    return json(bytes);
  };
  const injectedExecute = deps.execute;
  const execute = (argv: string[], name: string, bounded = false): Uint8Array => {
    denial();
    if (injectedExecute) {
      const timeout =
        bounded && preparation ? remainingTargetCandidatePreparation(preparation) : undefined;
      const bytes = injectedExecute(argv, name, timeout);
      denial();
      return bytes;
    }
    // Copy argv/environment before the last original-window clock and physical budget check.
    const childEnv =
      argv[0] === "gh" ? { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN } : { ...env };
    const args = [...argv];
    const timeout =
      bounded && preparation ? remainingTargetCandidatePreparation(preparation) : undefined;
    if (timeout === undefined) denial();
    const result = Bun.spawnSync(args, {
      env: childEnv,
      ...(timeout === undefined ? {} : { timeout, maxBuffer: 2 * 1024 * 1024 }),
    });
    denial();
    persist(`${name}.stdout`, result.stdout);
    persist(`${name}.stderr`, result.stderr);
    requireEvidence(result.exitCode === 0);
    return result.stdout;
  };
  const fresh = () => {
    const result = json(
      Buffer.from(
        execute(
          ["gh", "api", "repos/deconfined/tarubot/git/ref/heads/main"],
          "freshness",
          preparation !== undefined,
        ),
      ).toString(),
    ) as { object?: { sha?: unknown } };
    requireEvidence(result?.object?.sha === release.commit);
  };
  const phase = (name: string) =>
    execute(["bash", "ops/tofu/ci/tofu-ci.sh", name], `phase-${name}`);
  const tofu = (args: string[], name: string) => {
    const bytes = execute(["tofu", "-chdir=ops/tofu", ...args], name, preparation !== undefined);
    denial();
    const copy = Buffer.from(bytes);
    denial();
    requireEvidence(copy.length <= 2 * 1024 * 1024);
    persist(`${name}.json`, copy);
    return json(copy.toString());
  };
  const producer: AppliedTargetProducer = {
    repository: "deconfined/tarubot",
    workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
    ref: "refs/heads/main",
    event: "push",
    attempt: 1,
    commit: release.commit,
    run: release.publication_run,
  };
  // These runtime-only candidate keys are separate from provider/state/trust/descriptor keys.
  // The inactive lane refuses missing keys; no key or projected hash becomes an Actions output.
  const candidateConfiguration = (value: Record<string, unknown>) => {
    requireEvidence(
      value.hosts !== null && typeof value.hosts === "object" && !Array.isArray(value.hosts),
    );
    const targets = Object.values(value.hosts).map((host) => (host as { role?: unknown }).role);
    requireEvidence(
      targets.length > 0 &&
        targets.length <= 2 &&
        new Set(targets).size === targets.length &&
        targets.every((target) => target === "staging" || target === "production"),
    );
    const result = (targets as TargetRole[]).sort().map((target) => {
      const candidate_passphrase =
        env[
          target === "staging"
            ? "TARGET_CANDIDATE_STAGING_PASSPHRASE"
            : "TARGET_CANDIDATE_PRODUCTION_PASSPHRASE"
        ];
      requireEvidence(
        typeof candidate_passphrase === "string" &&
          candidate_passphrase.length >= 32 &&
          candidate_passphrase.length <= 4096 &&
          candidate_passphrase !== env.TF_VAR_state_passphrase,
      );
      return { target, candidate_passphrase, directory: join(directory, "target-candidates") };
    });
    requireEvidence(
      new Set(result.map((value) => value.candidate_passphrase)).size === result.length,
    );
    return result;
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
      const configuration = candidateConfiguration(
        read("values.tfvars.json") as Record<string, unknown>,
      );
      const journal = deps.journal ?? legacyTargetJournal(directory, env);
      preparation = journal.prepareTargetCandidates({
        targets: configuration.map((value) => value.target),
        release,
        producer,
      });
      // Retain full private readbacks; exactly the existing pull/show/pull commands are used.
      const state_readback = tofu(["state", "pull", "-unencrypted"], "state-before");
      const before = stateEvidence(state_readback);
      requireEvidence(isDeepStrictEqual(before, context.snapshot.state));
      const applied_show = tofu(["show", "-json"], "applied-state");
      verifyAppliedPlan(read("plan.json"), applied_show);
      const state_reopened = tofu(["state", "pull", "-unencrypted"], "state-verified");
      requireEvidence(isDeepStrictEqual(stateEvidence(state_reopened), before));
      const candidates = await journal.inspectTargetCandidates(preparation, {
        expected_snapshot: context.snapshot,
        plan: read("plan.json"),
        applied_show,
        state_readback,
        state_reopened,
      });
      denial();
      mkdirSync(configuration[0]?.directory ?? "", { recursive: true, mode: 0o700 });
      denial();
      for (const [index, candidate] of candidates.entries()) {
        const config = configuration[index];
        requireEvidence(config);
        await sealPendingTargetCandidate(candidate, {
          directory: config.directory,
          candidate_passphrase: config.candidate_passphrase,
        });
      }
    }
    fresh();
    requireEvidence(env.GITHUB_OUTPUT);
    denial();
    appendFileSync(
      env.GITHUB_OUTPUT,
      `decision=${decision}\nverified=${decision === "no-changes"}\n`,
    );
    denial();
    return;
  }
  requireEvidence(command === "apply" && env.LINODE_TOKEN && env.CLOUDFLARE_API_TOKEN);
  const shown = tofu(["show", "-json", join(directory, "plan.bin")], "plan");
  const context = read("control-context.json") as { snapshot: Snapshot };
  const inputs = read("values.tfvars.json") as Record<string, unknown>;
  requireEvidence(requireAutomaticPlan(shown, inputs, context) === "safe");
  const configuration = candidateConfiguration(inputs);
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "plan.bin")))
    .digest("hex");
  const binding = handoffBinding(directory, env);
  requireEvidence(env.DIGEST === digest && env.BINDING === binding);
  const journal = deps.journal ?? legacyTargetJournal(directory, env);
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
  // Provider Apply can legitimately outlive a candidate window. Start only after its success,
  // before snapshots and the same existing two raw-state reads surrounding applied show.
  preparation = journal.prepareTargetCandidates({
    targets: configuration.map((value) => value.target),
    release,
    producer,
  });
  const state_readback = tofu(["state", "pull", "-unencrypted"], "state-after");
  const state = stateEvidence(state_readback);
  const applied_show = tofu(["show", "-json"], "applied-state");
  verifyAppliedPlan(shown, applied_show);
  const state_reopened = tofu(["state", "pull", "-unencrypted"], "state-verified");
  requireEvidence(isDeepStrictEqual(stateEvidence(state_reopened), state));
  const candidates = await journal.finishTargetCandidates(ticket, preparation, {
    plan: shown,
    applied_show,
    state_readback,
    state_reopened,
  });
  denial();
  mkdirSync(configuration[0]?.directory ?? "", { recursive: true, mode: 0o700 });
  denial();
  for (const [index, candidate] of candidates.entries()) {
    const config = configuration[index];
    requireEvidence(config);
    await sealPendingTargetCandidate(candidate, {
      directory: config.directory,
      candidate_passphrase: config.candidate_passphrase,
    });
  }
  fresh();
  requireEvidence(env.GITHUB_OUTPUT);
  denial();
  appendFileSync(env.GITHUB_OUTPUT, "verified=true\n");
  denial();
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
