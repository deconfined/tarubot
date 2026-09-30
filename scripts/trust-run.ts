/**
 * Read-only final-run evidence for future owner-gated enrollment/recovery workflows.
 * No dispatch/approval/cancel/rerun APIs, environment mutation, CLI or inherited token lookup.
 * These workflow/job/step/environment pins are declarations; integration remains absent.
 */
import { Agent, request as httpsRequest } from "node:https";
import { isDeepStrictEqual } from "node:util";

type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const api = "https://api.github.com";
const prefix = `/repos/${repository}`;
const maxBody = 1_048_576;

function requireRun(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-trust-run-evidence");
}
function object(value: unknown): Value {
  requireRun(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireRun(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function list(value: unknown): unknown[] {
  requireRun(Array.isArray(value));
  return value;
}
function identifier(value: unknown): asserts value is number {
  requireRun(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function ownerIdentity(value: unknown, ownerId: number): void {
  const user = object(value);
  requireRun(user.login === "deconfined" && user.id === ownerId);
}
export interface TrustRunRequest {
  kind: "enrollment" | "recovery";
  target: "infra" | "staging" | "production";
  commit: string;
  run: string;
}
export interface GitHubReadRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  timeout_ms: number;
  body_limit: 1048576;
  redirect: "error";
}
export interface GitHubReadResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
export type GitHubReader = (request: GitHubReadRequest) => Promise<GitHubReadResponse>;

/** Explicit direct HTTPS agent does not inherit proxy/CLI configuration; credentials stay headers. */
const directGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    requireRun(
      url.origin === api && url.username === "" && url.password === "" && input.method === "GET",
    );
    const agent = new Agent({ keepAlive: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (error) reject(new Error("trust-run-read-failed"));
      else if (value) accept(value);
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.github.com",
        servername: "api.github.com",
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
      },
      (response) => {
        response.on("error", () => finish(new Error("trust-run-read-failed")));
        response.on("aborted", () => finish(new Error("trust-run-read-failed")));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.body_limit) {
            finish(new Error("trust-run-read-failed"));
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase();
            const value = response.rawHeaders[i + 1];
            if (name !== undefined && value !== undefined)
              headers[name] = Object.hasOwn(headers, name) ? `${headers[name]},${value}` : value;
          }
          finish(undefined, {
            status: response.statusCode ?? 0,
            url: input.url,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", () => finish(new Error("trust-run-read-failed")));
    timer = setTimeout(() => {
      finish(new Error("trust-run-read-failed"));
      request.destroy();
    }, input.timeout_ms);
    request.end();
  });

function contract(request: TrustRunRequest) {
  requireRun(request.kind === "enrollment" || request.kind === "recovery");
  requireRun(
    request.target === "infra" || request.target === "staging" || request.target === "production",
  );
  requireRun(request.kind !== "enrollment" || request.target !== "infra");
  const enrollment = request.kind === "enrollment";
  return {
    path: `.github/workflows/${enrollment ? "trust-enroll" : "control-recovery"}.yml`,
    job: enrollment
      ? `Enroll ${request.target}`
      : request.target === "infra"
        ? "Recover infrastructure"
        : `Recover ${request.target} trust`,
    environment: `${enrollment ? "trust" : "recover"}-${request.target}`,
    step: enrollment ? "Persist completed enrollment" : "Verify restored journal",
  };
}
export interface TrustRunProof {
  schema: 1;
  repository: "deconfined/tarubot";
  workflow: string;
  target: TrustRunRequest["target"];
  commit: string;
  run: string;
  attempt: 1;
  conclusion: "success";
  job: string;
  job_id: number;
  environment: string;
  environment_id: number;
  reviewer: { login: "deconfined"; id: number };
  observed_at: number;
}

/**
 * Primary REST contracts, API2026-03-10 (GET only):
 * https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
 * https://docs.github.com/en/rest/deployments/environments#get-an-environment
 * https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies
 * https://docs.github.com/en/rest/branches/branches#get-a-branch
 * Official OpenAPI's deployment-branch-policy.type and job.run_attempt are required here even
 * where examples omit them: https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json
 * The caller separately binds the durable grant/generation/private intent to this exact run.
 * This API does not expose dispatch inputs or prove private outcome/manifest hashes.
 */
export async function readTrustRun(
  expected: TrustRunRequest,
  dependencies: { owner_id: number; get?: GitHubReader; token?: string; now?: () => number },
): Promise<TrustRunProof> {
  try {
    // The independently configured owner account ID remains private runner configuration,
    // rather than copying a historic infrastructure/account identifier into new source.
    const ownerId = dependencies.owner_id;
    identifier(ownerId);
    const request = structuredClone(
      exact(expected, ["kind", "target", "commit", "run"]),
    ) as unknown as TrustRunRequest;
    const pin = contract(request);
    requireRun(typeof request.commit === "string" && /^[a-f0-9]{40}$/u.test(request.commit));
    requireRun(typeof request.run === "string" && /^[1-9][0-9]{0,15}$/u.test(request.run));
    requireRun(Number.isSafeInteger(Number(request.run)));
    const token = dependencies.token;
    requireRun(
      token === undefined ||
        (typeof token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(token)),
    );
    const get = dependencies.get ?? directGet;
    const now = dependencies.now ?? Date.now;
    const timestamp = () => {
      const value = now();
      requireRun(Number.isSafeInteger(value) && value > 0);
      return value;
    };
    const started = timestamp();
    let lastObserved = started;
    // A late final observation and a clock moving backwards cannot mint fresh evidence.
    const checkedTimestamp = () => {
      const value = timestamp();
      requireRun(value >= lastObserved && value - started <= 60_000);
      lastObserved = value;
      return value;
    };
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "TaruBot-trust-evidence",
      "Accept-Encoding": "identity",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const read = async (path: string) => {
      const url = `${api}${prefix}${path}`;
      const remaining = 60_000 - (checkedTimestamp() - started);
      requireRun(remaining > 0);
      const response = await get({
        url,
        method: "GET",
        headers: { ...headers },
        timeout_ms: Math.min(10_000, remaining),
        body_limit: maxBody,
        redirect: "error",
      });
      requireRun(
        response.status === 200 &&
          response.url === url &&
          response.body instanceof Uint8Array &&
          response.body.length <= maxBody,
      );
      const h: Record<string, string> = {};
      for (const [name, value] of Object.entries(object(response.headers))) {
        const lower = name.toLowerCase();
        requireRun(typeof value === "string" && !Object.hasOwn(h, lower));
        h[lower] = value;
      }
      requireRun(
        typeof h["content-type"] === "string" &&
          /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
            h["content-type"],
          ),
      );
      requireRun(
        h.location === undefined &&
          h.link === undefined &&
          (h["content-encoding"] === undefined || h["content-encoding"] === "identity"),
      );
      checkedTimestamp();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown;
    };
    const verifyRun = (value: unknown) => {
      const r = object(value);
      requireRun(
        r.id === Number(request.run) &&
          r.head_sha === request.commit &&
          r.head_branch === "main" &&
          r.event === "workflow_dispatch" &&
          r.run_attempt === 1 &&
          r.status === "completed" &&
          r.conclusion === "success",
      );
      requireRun(
        [
          pin.path,
          `${pin.path}@main`,
          `${pin.path}@refs/heads/main`,
          `${repository}/${pin.path}@main`,
          `${repository}/${pin.path}@refs/heads/main`,
        ].includes(r.path as string),
      );
      ownerIdentity(r.actor, ownerId);
      ownerIdentity(r.triggering_actor, ownerId);
      for (const source of [r.repository, r.head_repository]) {
        const repo = object(source);
        requireRun(repo.full_name === repository && repo.fork === false);
        ownerIdentity(repo.owner, ownerId);
      }
      requireRun(r.url === `${api}${prefix}/actions/runs/${request.run}`);
      return r;
    };
    const firstRun = verifyRun(await read(`/actions/runs/${request.run}`));
    const envPath = `/environments/${pin.environment}`;
    const verifyEnvironment = (value: unknown) => {
      const env = object(value);
      identifier(env.id);
      requireRun(env.name === pin.environment && env.url === `${api}${prefix}${envPath}`);
      const policy = object(env.deployment_branch_policy);
      requireRun(policy.protected_branches === false && policy.custom_branch_policies === true);
      const rules = list(env.protection_rules).map(object);
      const reviewers = rules.filter((rule) => rule.type === "required_reviewers");
      requireRun(reviewers.length === 1 && reviewers[0]?.prevent_self_review === false);
      const allowed = list(reviewers[0]?.reviewers).map(object);
      requireRun(allowed.length === 1 && allowed[0]?.type === "User");
      ownerIdentity(allowed[0]?.reviewer, ownerId);
      return env;
    };
    const env = verifyEnvironment(await read(envPath));
    const branchPolicies = await read(`${envPath}/deployment-branch-policies?per_page=100&page=1`);
    const verifyPolicies = (value: unknown) => {
      const p = object(value);
      const entries = list(p.branch_policies).map(object);
      requireRun(
        p.total_count === 1 &&
          entries.length === 1 &&
          entries[0]?.name === "main" &&
          entries[0]?.type === "branch",
      );
      identifier(entries[0]?.id);
    };
    verifyPolicies(branchPolicies);
    const main = object(await read("/branches/main"));
    requireRun(main.name === "main" && main.protected === true);
    const jobsPage = object(
      await read(`/actions/runs/${request.run}/attempts/1/jobs?per_page=100&page=1`),
    );
    const jobs = list(jobsPage.jobs).map(object);
    requireRun(jobs.length <= 100 && jobsPage.total_count === jobs.length);
    requireRun(new Set(jobs.map((job) => job.id)).size === jobs.length);
    const selected = jobs.filter((job) => job.name === pin.job);
    requireRun(selected.length === 1);
    const job = selected[0];
    requireRun(job !== undefined);
    identifier(job.id);
    requireRun(
      job.run_id === Number(request.run) &&
        job.run_attempt === 1 &&
        job.head_sha === request.commit &&
        job.head_branch === "main" &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        job.run_url === `${api}${prefix}/actions/runs/${request.run}`,
    );
    const critical = list(job.steps)
      .map(object)
      .filter((step) => step.name === pin.step);
    requireRun(
      critical.length === 1 &&
        critical[0]?.status === "completed" &&
        critical[0]?.conclusion === "success",
    );
    for (const other of jobs)
      if (
        other.name !== pin.job &&
        typeof other.name === "string" &&
        /^(Enroll (staging|production)|Recover (infrastructure|(staging|production) trust))$/u.test(
          other.name,
        )
      )
        requireRun(other.status === "completed" && other.conclusion === "skipped");
    const approvals = list(await read(`/actions/runs/${request.run}/approvals`));
    requireRun(approvals.length > 0 && approvals.length <= 1000);
    const matching = approvals
      .map(object)
      .filter((review) =>
        list(review.environments).some((e) => object(e).name === pin.environment),
      );
    requireRun(matching.length === 1);
    const review = matching[0];
    requireRun(review !== undefined && review.state === "approved");
    ownerIdentity(review.user, ownerId);
    const approved = list(review.environments)
      .map(object)
      .filter((e) => e.name === pin.environment);
    requireRun(approved.length === 1 && approved[0]?.id === env.id && approved[0]?.url === env.url);
    // Re-read live protection and latest run status. A rerun, lost gate, altered environment or
    // changed branch policy while gathering evidence cannot satisfy a first-attempt proof.
    requireRun(isDeepStrictEqual(verifyEnvironment(await read(envPath)), env));
    const finalPolicies = await read(`${envPath}/deployment-branch-policies?per_page=100&page=1`);
    verifyPolicies(finalPolicies);
    requireRun(isDeepStrictEqual(finalPolicies, branchPolicies));
    const finalMain = object(await read("/branches/main"));
    requireRun(finalMain.name === "main" && finalMain.protected === true);
    const finalRun = verifyRun(await read(`/actions/runs/${request.run}`));
    requireRun(isDeepStrictEqual(finalRun, firstRun));
    return {
      schema: 1,
      repository,
      workflow: pin.path,
      target: request.target,
      commit: request.commit,
      run: request.run,
      attempt: 1,
      conclusion: "success",
      job: pin.job,
      job_id: job.id,
      environment: pin.environment,
      environment_id: env.id as number,
      reviewer: { login: "deconfined", id: ownerId },
      observed_at: checkedTimestamp(),
    };
  } catch {
    throw new Error("invalid-trust-run-evidence");
  }
}
