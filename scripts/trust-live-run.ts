/**
 * GET-only evidence for the exact owner-approved job BEFORE an enrollment/recovery mutation.
 * Future workflow/job/environment pins match the final-run reader; none is created here.
 * This proof cannot attest dispatch inputs, an encrypted grant, outcome hashes or serialization.
 * Live authority must separately bind the reviewed job's immutable event and private grant.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { GitHubReader, GitHubReadResponse, TrustRunRequest } from "./trust-run.js";

type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const origin = "https://api.github.com";
const prefix = `/repos/${repository}`;
const maxBody = 1_048_576;
const operationBudget = 60_000;
const proofLifetime = 10_000;

function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-live-trust-run-evidence");
}
function object(value: unknown): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function list(value: unknown, maximum: number): unknown[] {
  valid(Array.isArray(value) && value.length <= maximum);
  return value;
}
function identifier(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function owner(value: unknown, ownerId: number): void {
  const identity = object(value);
  valid(identity.login === "deconfined" && identity.id === ownerId);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Copy the four bounded data fields without invoking untrusted request accessors. */
function requestSnapshot(value: unknown): TrustRunRequest {
  const input = object(value);
  const fields = ["kind", "target", "commit", "run"];
  valid(isDeepStrictEqual(Reflect.ownKeys(input).sort(), fields.sort()));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copied: Value = {};
  for (const field of fields) {
    const property = descriptors[field];
    valid(property?.enumerable === true && Object.hasOwn(property, "value"));
    copied[field] = property.value;
  }
  valid(copied.kind === "enrollment" || copied.kind === "recovery");
  valid(copied.target === "infra" || copied.target === "staging" || copied.target === "production");
  valid(copied.kind !== "enrollment" || copied.target !== "infra");
  valid(typeof copied.commit === "string" && /^[a-f0-9]{40}$/u.test(copied.commit));
  valid(typeof copied.run === "string" && /^[1-9][0-9]{0,15}$/u.test(copied.run));
  valid(Number.isSafeInteger(Number(copied.run)));
  return frozen(copied as unknown as TrustRunRequest);
}
function pins(request: TrustRunRequest) {
  const enrollment = request.kind === "enrollment";
  return {
    path: `.github/workflows/${enrollment ? "trust-enroll" : "control-recovery"}.yml`,
    job: enrollment
      ? `Enroll ${request.target}`
      : request.target === "infra"
        ? "Recover infrastructure"
        : `Recover ${request.target} trust`,
    environment: `${enrollment ? "trust" : "recover"}-${request.target}`,
    // The same step must later complete successfully for scripts/trust-run.ts to grant readers.
    step: enrollment ? "Persist completed enrollment" : "Verify restored journal",
  };
}

/** Reject duplicate decoded authority keys and bounded-depth JSON before JSON.parse chooses one. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[index] ?? "")) index++;
  };
  const string = () => {
    valid(source[index] === '"');
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("invalid-live-trust-run-evidence");
  };
  const value = (depth: number): void => {
    valid(++nodes <= 65_536 && depth <= 64);
    whitespace();
    const first = source[index];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      index++;
      whitespace();
      const end = first === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          valid(!keys.has(key));
          keys.add(key);
          whitespace();
          valid(source[index++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[index++];
        if (next === end) return;
        valid(next === ",");
      }
    }
    const start = index;
    while (index < source.length && !/^[,}\] \t\r\n]$/u.test(source[index] ?? "")) index++;
    valid(index > start);
    JSON.parse(source.slice(start, index));
  };
  value(0);
  whitespace();
  valid(index === source.length);
  return JSON.parse(source) as unknown;
}

/** Direct HTTPS uses no CLI/proxy/token-file transport, redirects, retries or pooled session. */
const nativeGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    valid(
      url.origin === origin &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        input.method === "GET",
    );
    valid(
      Number.isSafeInteger(input.timeout_ms) && input.timeout_ms > 0 && input.timeout_ms <= 10_000,
    );
    const agent = new Agent({ keepAlive: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (response) accept(response);
      else reject(new Error("invalid-live-trust-run-evidence"));
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
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.body_limit) {
            finish();
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.complete) return finish();
          const headers: Record<string, string> = Object.create(null);
          // Preserve duplicate native headers; their joined values must fail strict JSON/encoding checks.
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const name = response.rawHeaders[index]?.toLowerCase();
            const value = response.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined)
              headers[name] = Object.hasOwn(headers, name) ? `${headers[name]},${value}` : value;
          }
          finish({
            status: response.statusCode ?? 0,
            url: input.url,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", () => finish());
    timer = setTimeout(() => {
      finish();
      request.destroy();
    }, input.timeout_ms);
    request.end();
  });

export interface LiveTrustRunProof {
  schema: 1;
  purpose: "tarubot-live-owner-run-v1";
  repository: "deconfined/tarubot";
  kind: TrustRunRequest["kind"];
  target: TrustRunRequest["target"];
  workflow: string;
  commit: string;
  run: string;
  attempt: 1;
  status: "in_progress";
  conclusion: null;
  job: string;
  job_id: number;
  critical_step: { name: string; number: number; status: "in_progress"; conclusion: null };
  environment: string;
  environment_id: number;
  reviewer: { login: "deconfined"; id: number };
  observed_at: number;
  expires_at: number;
}

/**
 * Primary API2026-03-10 contracts (GET only):
 * https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
 * https://docs.github.com/en/rest/deployments/environments#get-an-environment
 * https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies
 * https://docs.github.com/en/rest/branches/branches#get-a-branch
 * Official OpenAPI documents nullable conclusions and job/step in_progress states:
 * https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json
 * The API supplies approval history, not approval timestamps or dispatch inputs. It also does
 * not attest private grant/event hashes or provide an atomic authorization fence. The caller
 * must independently bind those, hold the serialized writer boundary and refresh before writes.
 */
export async function readLiveTrustRun(
  expected: TrustRunRequest,
  dependencies: { owner_id: number; token?: string; get?: GitHubReader; now?: () => number },
): Promise<LiveTrustRunProof> {
  try {
    // Capture explicit trusted capabilities once, before request processing or any await.
    const ownerId = dependencies.owner_id;
    const token = dependencies.token;
    const get = dependencies.get ?? nativeGet;
    const now = dependencies.now ?? Date.now;
    identifier(ownerId);
    valid(typeof get === "function" && typeof now === "function");
    valid(
      token === undefined ||
        (typeof token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(token)),
    );
    const request = requestSnapshot(expected);
    const pin = pins(request);
    const timestamp = () => {
      const time = now();
      identifier(time);
      return time;
    };
    const started = timestamp();
    const physicalStarted = performance.now();
    const physicalElapsed = () => {
      const elapsed = performance.now() - physicalStarted;
      valid(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= operationBudget);
      return elapsed;
    };
    let previous = started;
    const checkedTime = () => {
      physicalElapsed();
      const time = timestamp();
      valid(time >= previous && time - started <= operationBudget);
      previous = time;
      return time;
    };
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "TaruBot-live-trust-evidence",
      "Accept-Encoding": "identity",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const read = async (path: string) => {
      const url = `${origin}${prefix}${path}`;
      const remaining = Math.min(
        operationBudget - (checkedTime() - started),
        operationBudget - physicalElapsed(),
      );
      const timeout = Math.floor(Math.min(10_000, remaining));
      valid(timeout > 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: GitHubReadResponse;
      try {
        // The physical timer also bounds a trusted injected reader with a frozen wall clock.
        response = await Promise.race([
          Promise.resolve().then(() =>
            get({
              url,
              method: "GET",
              headers: { ...headers },
              timeout_ms: timeout,
              body_limit: maxBody,
              redirect: "error",
            }),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("invalid-live-trust-run-evidence")), timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      valid(
        response.status === 200 &&
          response.url === url &&
          response.body instanceof Uint8Array &&
          response.body.length > 0 &&
          response.body.length <= maxBody,
      );
      const received: Record<string, string> = Object.create(null);
      let headerSize = 0;
      for (const [name, value] of Object.entries(object(response.headers))) {
        const lower = name.toLowerCase();
        valid(
          /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
            typeof value === "string" &&
            /^[\t\x20-\x7e]*$/u.test(value) &&
            !Object.hasOwn(received, lower),
        );
        headerSize += name.length + value.length + 4;
        valid(headerSize <= 16 * 1024);
        received[lower] = value;
      }
      valid(
        typeof received["content-type"] === "string" &&
          /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
            received["content-type"],
          ),
      );
      valid(
        received.location === undefined &&
          received.link === undefined &&
          (received["content-encoding"] === undefined ||
            received["content-encoding"] === "identity"),
      );
      if (received["content-length"] !== undefined)
        valid(
          /^[0-9]{1,7}$/u.test(received["content-length"]) &&
            Number(received["content-length"]) === response.body.length,
        );
      const body = Uint8Array.from(response.body);
      const value = json(body);
      return { value, observed_at: checkedTime(), observed_elapsed: physicalElapsed() };
    };
    const verifyRun = (value: unknown) => {
      const run = object(value);
      valid(
        run.id === Number(request.run) &&
          run.head_sha === request.commit &&
          run.head_branch === "main" &&
          run.event === "workflow_dispatch" &&
          run.run_attempt === 1 &&
          run.status === "in_progress" &&
          run.conclusion === null &&
          run.url === `${origin}${prefix}/actions/runs/${request.run}`,
      );
      valid(
        [
          pin.path,
          `${pin.path}@main`,
          `${pin.path}@refs/heads/main`,
          `${repository}/${pin.path}@main`,
          `${repository}/${pin.path}@refs/heads/main`,
        ].includes(run.path as string),
      );
      identifier(run.workflow_id);
      owner(run.actor, ownerId);
      owner(run.triggering_actor, ownerId);
      const source = object(run.repository);
      const head = object(run.head_repository);
      for (const repo of [source, head]) {
        identifier(repo.id);
        valid(repo.full_name === repository && repo.fork === false);
        owner(repo.owner, ownerId);
      }
      valid(source.id === head.id);
      // Run timestamps legitimately change while in progress; compare only bound authority.
      return {
        run: request.run,
        commit: request.commit,
        workflow_id: run.workflow_id,
        repository_id: source.id,
        actor: ownerId,
        path: pin.path,
      };
    };
    const envPath = `/environments/${pin.environment}`;
    const verifyGate = (value: unknown) => {
      const env = object(value);
      identifier(env.id);
      valid(env.name === pin.environment && env.url === `${origin}${prefix}${envPath}`);
      const policy = object(env.deployment_branch_policy);
      valid(policy.protected_branches === false && policy.custom_branch_policies === true);
      const rules = list(env.protection_rules, 16).map(object);
      const reviewerRules = rules.filter((rule) => rule.type === "required_reviewers");
      valid(reviewerRules.length === 1 && reviewerRules[0]?.prevent_self_review === false);
      const reviewers = list(reviewerRules[0]?.reviewers, 6).map(object);
      valid(reviewers.length === 1 && reviewers[0]?.type === "User");
      owner(reviewers[0]?.reviewer, ownerId);
      valid(env.can_admins_bypass === undefined || typeof env.can_admins_bypass === "boolean");
      return {
        id: env.id,
        name: env.name,
        url: env.url,
        policy: structuredClone(policy),
        rules: structuredClone(rules),
        can_admins_bypass: env.can_admins_bypass ?? null,
      };
    };
    const verifyPolicies = (value: unknown) => {
      const policy = object(value);
      const entries = list(policy.branch_policies, 100).map(object);
      valid(
        policy.total_count === 1 &&
          entries.length === 1 &&
          entries[0]?.name === "main" &&
          entries[0]?.type === "branch",
      );
      identifier(entries[0]?.id);
      return { id: entries[0].id, name: "main", type: "branch" };
    };
    const verifyMain = (value: unknown) => {
      const branch = object(value);
      valid(
        branch.name === "main" &&
          branch.protected === true &&
          object(branch.commit).sha === request.commit,
      );
      return { name: "main", protected: true, commit: request.commit };
    };
    const verifyJobs = (value: unknown) => {
      const page = object(value);
      const jobs = list(page.jobs, 100).map(object);
      valid(page.total_count === jobs.length && jobs.length > 0);
      for (const job of jobs) identifier(job.id);
      valid(new Set(jobs.map((job) => job.id)).size === jobs.length);
      const selected = jobs.filter((job) => job.name === pin.job);
      valid(selected.length === 1);
      const job = selected[0];
      valid(
        job !== undefined &&
          job.run_id === Number(request.run) &&
          job.run_attempt === 1 &&
          job.head_sha === request.commit &&
          job.head_branch === "main" &&
          job.status === "in_progress" &&
          job.conclusion === null &&
          job.run_url === `${origin}${prefix}/actions/runs/${request.run}` &&
          job.url === `${origin}${prefix}/actions/jobs/${job.id}`,
      );
      const steps = list(job.steps, 1000).map(object);
      for (const step of steps) {
        identifier(step.number);
        valid(
          typeof step.name === "string" &&
            step.name.length > 0 &&
            step.name.length <= 200 &&
            ["queued", "in_progress", "completed"].includes(step.status as string),
        );
      }
      valid(new Set(steps.map((step) => step.number)).size === steps.length);
      const critical = steps.filter((step) => step.name === pin.step);
      valid(
        critical.length === 1 &&
          critical[0]?.status === "in_progress" &&
          critical[0]?.conclusion === null &&
          steps.filter((step) => step.status === "in_progress").length === 1,
      );
      const otherTargets = jobs.filter(
        (other) =>
          other.name !== pin.job &&
          typeof other.name === "string" &&
          /^(Enroll (staging|production)|Recover (infrastructure|(staging|production) trust))$/u.test(
            other.name,
          ),
      );
      for (const other of otherTargets)
        valid(other.status === "completed" && other.conclusion === "skipped");
      return {
        id: job.id as number,
        critical_step: {
          name: pin.step,
          number: critical[0].number as number,
          status: "in_progress" as const,
          conclusion: null,
        },
        other_targets: otherTargets
          .map((other) => ({ id: other.id, name: other.name }))
          .sort((a, b) => Number(a.id) - Number(b.id)),
      };
    };
    const verifyApproval = (value: unknown, environmentId: number) => {
      const reviews = list(value, 1000).map(object);
      const matching = reviews.filter((review) => {
        valid(["approved", "rejected", "pending"].includes(review.state as string));
        const environments = list(review.environments, 100).map(object);
        for (const env of environments) identifier(env.id);
        valid(new Set(environments.map((env) => env.id)).size === environments.length);
        return environments.some((env) => env.name === pin.environment || env.id === environmentId);
      });
      valid(matching.length === 1 && matching[0]?.state === "approved");
      const review = matching[0];
      valid(review !== undefined);
      owner(review.user, ownerId);
      const bound = list(review.environments, 100)
        .map(object)
        .filter((env) => env.name === pin.environment || env.id === environmentId);
      valid(
        bound.length === 1 &&
          bound[0]?.name === pin.environment &&
          bound[0]?.id === environmentId &&
          bound[0]?.url === `${origin}${prefix}${envPath}`,
      );
      return { owner_id: ownerId, environment_id: environmentId, state: "approved" };
    };

    const run = verifyRun((await read(`/actions/runs/${request.run}`)).value);
    const gate = verifyGate((await read(envPath)).value);
    const policyPath = `${envPath}/deployment-branch-policies?per_page=100&page=1`;
    const policies = verifyPolicies((await read(policyPath)).value);
    const main = verifyMain((await read("/branches/main")).value);
    const jobPath = `/actions/runs/${request.run}/attempts/1/jobs?per_page=100&page=1`;
    const job = verifyJobs((await read(jobPath)).value);
    const reviewPath = `/actions/runs/${request.run}/approvals`;
    const approval = verifyApproval((await read(reviewPath)).value, gate.id);
    // Reopen every authority source, including the selected current step: a live run can remain
    // in progress after its mutation job finishes. Gate/approval/job/run changes always stop.
    const finalGate = await read(envPath);
    valid(isDeepStrictEqual(verifyGate(finalGate.value), gate));
    valid(isDeepStrictEqual(verifyPolicies((await read(policyPath)).value), policies));
    valid(isDeepStrictEqual(verifyMain((await read("/branches/main")).value), main));
    valid(isDeepStrictEqual(verifyApproval((await read(reviewPath)).value, gate.id), approval));
    valid(isDeepStrictEqual(verifyJobs((await read(jobPath)).value), job));
    valid(isDeepStrictEqual(verifyRun((await read(`/actions/runs/${request.run}`)).value), run));
    const observedAt = finalGate.observed_at;
    const expiresAt = observedAt + proofLifetime;
    // The oldest observation of the final verification round bounds the whole proof. A late
    // API response cannot extend approval/gate/head evidence with a newly stamped clock value.
    valid(
      checkedTime() < expiresAt && physicalElapsed() - finalGate.observed_elapsed < proofLifetime,
    );
    return frozen({
      schema: 1,
      purpose: "tarubot-live-owner-run-v1",
      repository,
      kind: request.kind,
      target: request.target,
      workflow: pin.path,
      commit: request.commit,
      run: request.run,
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      job: pin.job,
      job_id: job.id,
      critical_step: job.critical_step,
      environment: pin.environment,
      environment_id: gate.id,
      reviewer: { login: "deconfined", id: ownerId },
      observed_at: observedAt,
      expires_at: expiresAt,
    });
  } catch {
    throw new Error("invalid-live-trust-run-evidence");
  }
}
