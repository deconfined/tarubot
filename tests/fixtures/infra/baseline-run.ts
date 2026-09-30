/** Invented REST responses pass the REAL native parser; no Boolean/JSON proof stub is accepted. */
import {
  createInfrastructureBaselineRunVerifier,
  type InfrastructureBaselineRunRequest,
  type VerifyInfrastructureBaselineRun,
} from "../../../scripts/infra-baseline-run.js";
import { appliedTargetJobPaths } from "../../../scripts/target-producer-run.js";
import type { GitHubReader, GitHubReadRequest } from "../../../scripts/trust-run.js";

export const baselineFixtureInstant = 1_800_000_000_000;
const api = "https://api.github.com/repos/deconfined/tarubot";
export function baselineRunFixture(
  expected: InfrastructureBaselineRunRequest,
  options: { automatic?: boolean; adoption?: boolean } = {},
) {
  const automatic = options.automatic ?? false;
  const owner = { id: 123456, login: "deconfined" };
  const repository = { id: 234567, full_name: "deconfined/tarubot", fork: false, owner };
  const runUrl = `${api}/actions/runs/${expected.run.run}`;
  const gateName = automatic ? "infra-auto" : "infra";
  const gate = {
    id: 3030,
    name: gateName,
    url: `${api}/environments/${gateName}`,
    protection_rules: automatic
      ? []
      : [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ type: "User", reviewer: owner }],
          },
        ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const run = {
    id: Number(expected.run.run),
    head_sha: expected.run.commit,
    head_branch: "main",
    run_attempt: 1,
    url: runUrl,
    repository,
    head_repository: structuredClone(repository),
    path: `.github/workflows/${automatic ? "publish" : "infra"}.yml`,
    event: automatic ? "push" : "workflow_dispatch",
    status: automatic ? "in_progress" : "completed",
    conclusion: automatic ? null : "success",
    actor: owner,
    triggering_actor: owner,
    referenced_workflows: automatic
      ? ["release", "release-infra"].map((name) => ({
          path: `deconfined/tarubot/.github/workflows/${name}.yml@refs/heads/main`,
          ref: "refs/heads/main",
          sha: expected.run.commit,
        }))
      : [],
  };
  const step = (name: string, number: number, conclusion: "success" | "skipped") => ({
    name,
    number,
    status: "completed",
    conclusion,
  });
  const job = (name: string, id: number, steps: ReturnType<typeof step>[]) => ({
    id,
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: expected.run.commit,
    head_branch: "main",
    run_url: runUrl,
    status: "completed",
    conclusion: "success",
    steps,
  });
  const plan = job(automatic ? appliedTargetJobPaths["no-changes"] : "Plan", 101, [
    step(automatic ? "Plan and require automatic policy" : "Plan", 1, "success"),
  ]);
  const apply = job(
    automatic ? appliedTargetJobPaths.apply : "Apply",
    102,
    automatic
      ? [step("Recheck policy and apply exact saved plan", 1, "success")]
      : [
          step("Apply", 1, expected.kind === "apply" ? "success" : "skipped"),
          step(
            "Verify adoption with read-only provider credentials",
            2,
            options.adoption ? "success" : "skipped",
          ),
          step(
            "Establish initial baseline without provider changes",
            3,
            expected.kind === "baseline" ? "success" : "skipped",
          ),
        ],
  );
  const jobs = { total_count: 2, jobs: [plan, apply] };
  const policies = { total_count: 1, branch_policies: [{ id: 11, name: "main", type: "branch" }] };
  const approvals = [
    {
      state: "approved",
      user: owner,
      environments: [{ id: gate.id, name: gateName, url: gate.url }],
    },
  ];
  const data: Record<string, unknown> = {
    [api]: repository,
    [runUrl]: run,
    [`${runUrl}/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [gate.url]: gate,
    [`${gate.url}/deployment-branch-policies?per_page=100&page=1`]: policies,
    [`${api}/branches/main`]: { name: "main", protected: true },
    [`${runUrl}/approvals`]: approvals,
  };
  const seen: GitHubReadRequest[] = [];
  const clock = { now: baselineFixtureInstant };
  const get: GitHubReader = async (request) => {
    seen.push(structuredClone(request));
    if (!Object.hasOwn(data, request.url)) throw new Error("unexpected-invented-baseline-url");
    return {
      status: 200,
      url: request.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(data[request.url])),
    };
  };
  const configuration = {
    owner_id: owner.id,
    repository_id: repository.id,
    token: "invented_baseline_read_token_12345",
  };
  const verify = createInfrastructureBaselineRunVerifier(configuration, {
    get,
    now: () => clock.now,
  });
  return {
    data,
    run,
    plan,
    apply,
    jobs,
    gate,
    policies,
    approvals,
    repository,
    seen,
    clock,
    get,
    configuration,
    verify,
  };
}

/** Internal fixture capability only. Each invented source graph is independently parsed and branded. */
export const verifyInventedBaselineRun: VerifyInfrastructureBaselineRun = async (request) =>
  baselineRunFixture(request).verify(request);
