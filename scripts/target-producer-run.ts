/**
 * Direct, bounded GET-only GitHub evidence for a private applied-target sealing JOB.
 * No environment/token lookup, dispatch, approval, rerun, provider, state or workflow adapter.
 * GitHub cannot attest private receipt bytes: independently authenticated sealing evidence is
 * mandatory. The callback is a trusted integration capability, never a caller echo/CLI Boolean.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { releaseIdentity } from "./release-policy.js";
import type {
  AppliedTargetJobProof,
  AppliedTargetJobRequest,
  AppliedTargetReceipt,
} from "./target-handoff.js";
import type { GitHubReader, GitHubReadResponse } from "./trust-run.js";

type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const api = "https://api.github.com";
const prefix = `/repos/${repository}`;
const publication = `${repository}/.github/workflows/publish.yml@refs/heads/main`;
const infrastructure = `${repository}/.github/workflows/release-infra.yml@refs/heads/main`;
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const maxOperation = 60_000;
const maxAge = 30_000;

/**
 * Exact FUTURE REST graph names, not suffix matches. Integration must establish these caller
 * names and the sealing step in publish -> release -> release-infra before this can succeed.
 * Existing workflows are not modified or assumed to expose these declarations.
 */
export const appliedTargetJobPaths = Object.freeze({
  "no-changes": "Replacement release orchestration / infrastructure / Plan infrastructure",
  apply: "Replacement release orchestration / infrastructure / Apply infrastructure",
});

function requireProducer(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-target-producer-evidence");
}
function object(value: unknown): Value {
  requireProducer(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireProducer(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function list(value: unknown): unknown[] {
  requireProducer(Array.isArray(value));
  return value;
}
function integer(value: unknown): asserts value is number {
  requireProducer(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Copy bounded plain authority data without invoking getters or retaining caller references. */
function snapshot(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    requireProducer(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireProducer(bytes <= 65_536);
      return input;
    }
    if (typeof input === "number") {
      requireProducer(Number.isFinite(input));
      return input;
    }
    requireProducer(input !== null && typeof input === "object" && !ancestors.has(input));
    ancestors.add(input);
    requireProducer(Object.getOwnPropertySymbols(input).length === 0);
    const properties = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      requireProducer(input.length <= 1024 && Object.keys(properties).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const property = properties[String(index)];
        requireProducer(property?.enumerable === true && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    } else {
      requireProducer(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const output: Value = {};
      for (const [key, property] of Object.entries(properties)) {
        requireProducer(property.enumerable === true && Object.hasOwn(property, "value"));
        bytes += Buffer.byteLength(key);
        requireProducer(bytes <= 65_536);
        Object.defineProperty(output, key, {
          value: copy(property.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = output;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}

/** JSON.parse alone silently accepts duplicate authority keys, including escaped equivalents. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[index] ?? "")) index++;
  };
  const string = () => {
    requireProducer(source[index] === '"');
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("invalid-target-producer-evidence");
  };
  const value = (depth: number): void => {
    requireProducer(++nodes <= 65_536 && depth <= 64);
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
          requireProducer(!keys.has(key));
          keys.add(key);
          whitespace();
          requireProducer(source[index++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[index++];
        if (next === end) return;
        requireProducer(next === ",");
      }
    }
    const start = index;
    while (index < source.length && !/^[,}\] \t\r\n]$/u.test(source[index] ?? "")) index++;
    requireProducer(index > start);
    JSON.parse(source.slice(start, index));
  };
  value(0);
  whitespace();
  requireProducer(index === source.length);
  return JSON.parse(source) as unknown;
}

/** Freshly verified public writer identity, to bind the independently authenticated receipt. */
export interface AppliedTargetWriterIdentity {
  repository: "deconfined/tarubot";
  repository_owner_id: number;
  publication_workflow_ref: typeof publication;
  ref: "refs/heads/main";
  event: "push";
  run: string;
  attempt: 1;
  head_commit: string;
  reusable_workflow_ref: typeof infrastructure;
  reusable_workflow_commit: string;
  job_path: string;
  job_id: number;
  critical_step: AppliedTargetJobProof["critical_step"];
}
export interface AppliedTargetSealingRequest {
  request: AppliedTargetJobRequest;
  writer: AppliedTargetWriterIdentity;
}
/** This authenticated response and all receipt digests remain private, never public outputs. */
export interface AuthenticatedAppliedTargetSealing extends AppliedTargetSealingRequest {
  schema: 1;
  purpose: "tarubot-authenticated-applied-target-sealing-v1";
  authenticated_at: number;
  expires_at: number;
}
/**
 * An integration must authenticate protected private writer evidence independently of these
 * GitHub GETs, matching EVERY request receipt field and writer field. Returning this data from
 * an unauthenticated echo does not implement this capability. No adapter is supplied here.
 */
export type VerifyAppliedTargetSealing = (
  request: AppliedTargetSealingRequest,
) => Promise<AuthenticatedAppliedTargetSealing>;

/** Explicit HTTPS agent has no inherited proxy/CLI configuration. Tokens stay in headers. */
const directGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    requireProducer(
      input.method === "GET" &&
        url.origin === api &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        url.pathname.startsWith(`${prefix}/`),
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
      else reject(new Error("invalid-target-producer-evidence"));
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
        maxHeaderSize: maxHeaders,
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
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase();
            const value = response.rawHeaders[i + 1];
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

function requestContract(value: unknown): AppliedTargetJobRequest {
  const request = exact(value, ["receipt", "job", "requested_at"]);
  integer(request.requested_at);
  const receipt = exact(request.receipt, [
    "schema",
    "purpose",
    "target",
    "backend",
    "release",
    "producer",
    "mode",
    "path",
    "payload_digest",
    "ciphertext_digest",
    "issued_at",
    "expires_at",
  ]);
  requireProducer(
    receipt.schema === 1 &&
      receipt.purpose === "tarubot-applied-target-handoff-v1" &&
      (receipt.target === "staging" || receipt.target === "production") &&
      typeof receipt.backend === "string" &&
      /^[a-f0-9]{64}$/u.test(receipt.backend) &&
      (receipt.mode === "apply" || receipt.mode === "no-changes"),
  );
  const release = releaseIdentity(receipt.release);
  requireProducer(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
  integer(Number(release.publication_run));
  const producer = exact(receipt.producer, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  requireProducer(
    producer.repository === repository &&
      producer.workflow_ref === publication &&
      producer.ref === "refs/heads/main" &&
      producer.event === "push" &&
      producer.attempt === 1 &&
      producer.commit === release.commit &&
      producer.run === release.publication_run,
  );
  for (const digest of [receipt.payload_digest, receipt.ciphertext_digest])
    requireProducer(typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest));
  requireProducer(
    receipt.path ===
      `applied-target/${receipt.target}/${producer.run}/${producer.commit}/${receipt.payload_digest}`,
  );
  integer(receipt.issued_at);
  integer(receipt.expires_at);
  requireProducer(
    receipt.expires_at > receipt.issued_at && receipt.expires_at - receipt.issued_at <= 3_600_000,
  );
  const job = exact(request.job, ["workflow_ref", "workflow_commit", "job_name", "critical_step"]);
  requireProducer(
    job.workflow_ref === infrastructure &&
      job.workflow_commit === release.config_commit &&
      job.job_name ===
        (receipt.mode === "apply" ? "Apply infrastructure" : "Plan infrastructure") &&
      job.critical_step === "Seal applied target descriptor",
  );
  return request as unknown as AppliedTargetJobRequest;
}

/**
 * REST API2026-03-10: workflow-runs get, workflow-jobs attempt list/get and branches get.
 * https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
 * https://docs.github.com/en/rest/actions/workflow-jobs#get-a-job-for-a-workflow-run
 * https://docs.github.com/en/rest/branches/branches#get-a-branch
 * Referenced reusable workflow SHA and exact nested job names are separate checks. A name
 * alone cannot attribute private bytes to a workflow; the sealing capability supplies that
 * independent binding. The publication run may still be in_progress awaiting its consumer.
 */
export async function readAppliedTargetProducerJob(
  expected: AppliedTargetJobRequest,
  dependencies: {
    owner_id: number;
    verifySealingReceipt: VerifyAppliedTargetSealing;
    get?: GitHubReader;
    token?: string;
    now?: () => number;
  },
): Promise<AppliedTargetJobProof> {
  try {
    const request = requestContract(snapshot(expected));
    const ownerId = dependencies.owner_id;
    integer(ownerId);
    const verifySealingReceipt = dependencies.verifySealingReceipt;
    requireProducer(typeof verifySealingReceipt === "function");
    const get = dependencies.get ?? directGet;
    const now = dependencies.now ?? Date.now;
    requireProducer(typeof get === "function" && typeof now === "function");
    const token = dependencies.token;
    requireProducer(
      token === undefined ||
        (typeof token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(token)),
    );
    const timestamp = () => {
      const result = now();
      integer(result);
      return result;
    };
    const started = timestamp();
    const physicalStarted = performance.now();
    const physicalReceiptExpiry = physicalStarted + (request.receipt.expires_at - started);
    let authenticatedExpiry: number | undefined;
    let authenticatedPhysicalExpiry: number | undefined;
    const physicalElapsed = () => {
      const elapsed = performance.now() - physicalStarted;
      requireProducer(
        Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed <= maxOperation &&
          performance.now() < physicalReceiptExpiry &&
          (authenticatedPhysicalExpiry === undefined ||
            performance.now() < authenticatedPhysicalExpiry),
      );
      return elapsed;
    };
    let last = started;
    const current = () => {
      physicalElapsed();
      const time = timestamp();
      requireProducer(
        time >= last &&
          time - started <= maxOperation &&
          time >= request.requested_at &&
          time - request.requested_at <= maxOperation &&
          time >= request.receipt.issued_at &&
          time < request.receipt.expires_at &&
          (authenticatedExpiry === undefined || time < authenticatedExpiry),
      );
      last = time;
      return time;
    };
    current();
    const remainingTime = () => {
      const remaining = Math.min(
        10_000,
        maxOperation - (current() - started),
        maxOperation - physicalElapsed(),
        physicalReceiptExpiry - performance.now(),
        request.receipt.expires_at - last,
        authenticatedExpiry === undefined ? Infinity : authenticatedExpiry - last,
        authenticatedPhysicalExpiry === undefined
          ? Infinity
          : authenticatedPhysicalExpiry - performance.now(),
      );
      requireProducer(remaining > 0);
      return remaining;
    };
    // Real per-call and whole-operation deadlines also bound a frozen injected wall clock.
    // The trusted capabilities may finish later; their late result cannot mint a proof.
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      const remaining = remainingTime();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("invalid-target-producer-evidence")),
              remaining,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "TaruBot-target-producer-evidence",
      "Accept-Encoding": "identity",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    let lastReadAt = started;
    let lastReadPhysical = physicalStarted;
    const read = async (path: string): Promise<unknown> => {
      const url = `${api}${prefix}${path}`;
      const response = await bounded(() =>
        get({
          url,
          method: "GET",
          headers: { ...headers },
          timeout_ms: remainingTime(),
          body_limit: maxBody,
          redirect: "error",
        }),
      );
      current();
      requireProducer(
        response.status === 200 &&
          response.url === url &&
          response.body instanceof Uint8Array &&
          response.body.length <= maxBody,
      );
      const h: Record<string, string> = Object.create(null);
      let size = 0;
      for (const [name, value] of Object.entries(object(response.headers))) {
        const lower = name.toLowerCase();
        requireProducer(
          /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
            typeof value === "string" &&
            !/[\r\n\0]/u.test(value) &&
            !Object.hasOwn(h, lower),
        );
        size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        requireProducer(size <= maxHeaders);
        h[lower] = value;
      }
      requireProducer(
        typeof h["content-type"] === "string" &&
          /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
            h["content-type"],
          ),
      );
      requireProducer(
        h.location === undefined &&
          h.link === undefined &&
          (h["content-encoding"] === undefined || h["content-encoding"] === "identity"),
      );
      if (h["content-length"] !== undefined)
        requireProducer(
          /^(0|[1-9][0-9]*)$/u.test(h["content-length"]) &&
            Number(h["content-length"]) === response.body.length,
        );
      // Copy transport bytes before parsing; shared memory is not retained as evidence.
      const value = json(Buffer.from(response.body));
      lastReadAt = current();
      lastReadPhysical = performance.now();
      return value;
    };
    const release = request.receipt.release;
    const runPath = `/actions/runs/${release.publication_run}`;
    const runUrl = `${api}${prefix}${runPath}`;
    const workflowPaths = [".github/workflows/release.yml", ".github/workflows/release-infra.yml"];
    let completedPublication = false;
    const verifyRun = (value: unknown) => {
      const run = object(value);
      requireProducer(
        run.id === Number(release.publication_run) &&
          run.head_sha === release.commit &&
          run.head_branch === "main" &&
          run.event === "push" &&
          run.run_attempt === 1 &&
          run.url === runUrl &&
          ((run.status === "in_progress" && run.conclusion === null) ||
            (run.status === "completed" && run.conclusion === "success")),
      );
      // An attempt-one completed run cannot legitimately become active again. Do not accept a
      // rerun/status regression merely because attempt metadata has not yet caught up.
      requireProducer(!completedPublication || run.status === "completed");
      completedPublication = run.status === "completed";
      requireProducer(
        [
          ".github/workflows/publish.yml",
          ".github/workflows/publish.yml@main",
          ".github/workflows/publish.yml@refs/heads/main",
          `${repository}/.github/workflows/publish.yml@main`,
          publication,
        ].includes(run.path as string),
      );
      for (const source of [run.repository, run.head_repository]) {
        const repo = object(source);
        const owner = object(repo.owner);
        requireProducer(
          repo.full_name === repository &&
            repo.fork === false &&
            owner.login === "deconfined" &&
            owner.id === ownerId,
        );
      }
      const referenced = list(run.referenced_workflows).map(object);
      requireProducer(
        referenced.length <= 50 &&
          new Set(referenced.map((ref) => ref.path)).size === referenced.length,
      );
      const bindings = workflowPaths.map((path) => {
        const candidates = referenced.filter(
          (ref) => typeof ref.path === "string" && ref.path.startsWith(`${repository}/${path}@`),
        );
        requireProducer(candidates.length === 1);
        const ref = candidates[0];
        requireProducer(
          ref !== undefined &&
            ref.sha === release.config_commit &&
            ref.ref === "refs/heads/main" &&
            [`${repository}/${path}@main`, `${repository}/${path}@refs/heads/main`].includes(
              ref.path as string,
            ),
        );
        return { path: `${repository}/${path}@refs/heads/main`, sha: ref.sha, ref: ref.ref };
      });
      // Only stable identity participates in readback; legitimate in_progress -> success is allowed.
      return { run: release.publication_run, commit: release.commit, bindings };
    };
    const verifyMain = (value: unknown) => {
      const main = object(value);
      requireProducer(
        main.name === "main" &&
          main.protected === true &&
          object(main.commit).sha === release.commit,
      );
    };
    const jobPath = appliedTargetJobPaths[request.receipt.mode];
    const verifyJob = (value: unknown) => {
      const job = object(value);
      integer(job.id);
      requireProducer(
        job.name === jobPath &&
          job.run_id === Number(release.publication_run) &&
          job.run_attempt === 1 &&
          job.head_sha === release.commit &&
          job.head_branch === "main" &&
          job.run_url === runUrl &&
          job.url === `${api}${prefix}/actions/jobs/${job.id}` &&
          job.status === "completed" &&
          job.conclusion === "success",
      );
      const steps = list(job.steps).map(object);
      requireProducer(steps.length > 0 && steps.length <= 1000);
      for (const step of steps) integer(step.number);
      requireProducer(new Set(steps.map((step) => step.number)).size === steps.length);
      const critical = steps.filter((step) => step.name === request.job.critical_step);
      requireProducer(
        critical.length === 1 &&
          critical[0]?.status === "completed" &&
          critical[0]?.conclusion === "success",
      );
      return {
        id: job.id,
        critical_step: {
          name: request.job.critical_step,
          number: critical[0]?.number as number,
          status: "completed" as const,
          conclusion: "success" as const,
        },
      };
    };
    const jobsPath = `${runPath}/attempts/1/jobs?per_page=100&page=1`;
    const verifyJobs = (value: unknown) => {
      const page = object(value);
      const jobs = list(page.jobs).map(object);
      requireProducer(jobs.length <= 100 && page.total_count === jobs.length);
      for (const job of jobs) integer(job.id);
      requireProducer(new Set(jobs.map((job) => job.id)).size === jobs.length);
      const selected = jobs.filter((job) => job.name === jobPath);
      requireProducer(selected.length === 1);
      // Apply follows a successful Plan; no-changes skips Apply. Neither route permits a
      // second successful sealing step, and the other exact graph job cannot be ambiguous.
      const otherPath =
        appliedTargetJobPaths[request.receipt.mode === "apply" ? "no-changes" : "apply"];
      const otherJobs = jobs.filter((job) => job.name === otherPath);
      requireProducer(otherJobs.length <= 1);
      for (const job of otherJobs) {
        requireProducer(
          job.run_id === Number(release.publication_run) &&
            job.run_attempt === 1 &&
            job.head_sha === release.commit &&
            job.head_branch === "main" &&
            job.run_url === runUrl &&
            job.url === `${api}${prefix}/actions/jobs/${job.id}` &&
            job.status === "completed" &&
            job.conclusion === (request.receipt.mode === "apply" ? "success" : "skipped"),
        );
        const otherSeal = list(job.steps)
          .map(object)
          .filter((step) => step.name === request.job.critical_step);
        requireProducer(
          otherSeal.length <= 1 &&
            otherSeal.every((step) => step.status === "completed" && step.conclusion === "skipped"),
        );
      }
      return {
        selected: verifyJob(selected[0]),
        ids: jobs.map((job) => job.id).sort((a, b) => Number(a) - Number(b)),
      };
    };
    verifyMain(await read("/branches/main"));
    const firstRun = verifyRun(await read(runPath));
    const firstJobs = verifyJobs(await read(jobsPath));
    requireProducer(
      isDeepStrictEqual(
        verifyJob(await read(`/actions/jobs/${firstJobs.selected.id}`)),
        firstJobs.selected,
      ),
    );
    const writer: AppliedTargetWriterIdentity = {
      repository,
      repository_owner_id: ownerId,
      publication_workflow_ref: publication,
      ref: "refs/heads/main",
      event: "push",
      run: release.publication_run,
      attempt: 1,
      head_commit: release.commit,
      reusable_workflow_ref: infrastructure,
      reusable_workflow_commit: release.config_commit,
      job_path: jobPath,
      job_id: firstJobs.selected.id,
      critical_step: firstJobs.selected.critical_step,
    };
    const sealingRequest: AppliedTargetSealingRequest = { request, writer };
    // Callback input is a separate copy: mutations cannot alter pinned evidence or final proof.
    const authenticated = exact(
      snapshot(
        await bounded(() =>
          verifySealingReceipt(snapshot(sealingRequest) as AppliedTargetSealingRequest),
        ),
      ),
      ["schema", "purpose", "request", "writer", "authenticated_at", "expires_at"],
    );
    const authenticatedNow = current();
    const authenticatedPhysical = performance.now();
    requireProducer(
      authenticated.schema === 1 &&
        authenticated.purpose === "tarubot-authenticated-applied-target-sealing-v1" &&
        isDeepStrictEqual(authenticated.request, request) &&
        isDeepStrictEqual(authenticated.writer, writer),
    );
    integer(authenticated.authenticated_at);
    integer(authenticated.expires_at);
    requireProducer(
      authenticated.authenticated_at >= request.requested_at &&
        authenticated.authenticated_at <= authenticatedNow &&
        authenticatedNow - authenticated.authenticated_at <= maxAge &&
        authenticated.expires_at > authenticatedNow &&
        authenticated.expires_at <= authenticated.authenticated_at + maxAge &&
        authenticated.expires_at <= request.receipt.expires_at,
    );
    authenticatedExpiry = authenticated.expires_at;
    authenticatedPhysicalExpiry =
      authenticatedPhysical + (authenticated.expires_at - authenticatedNow);
    // Independently reopen exact public links after private authentication; no latest/run fallback.
    const finalJobs = await read(jobsPath);
    const observed = lastReadAt;
    const physicalObserved = lastReadPhysical;
    requireProducer(isDeepStrictEqual(verifyJobs(finalJobs), firstJobs));
    requireProducer(
      isDeepStrictEqual(
        verifyJob(await read(`/actions/jobs/${writer.job_id}`)),
        firstJobs.selected,
      ),
    );
    verifyMain(await read("/branches/main"));
    requireProducer(isDeepStrictEqual(verifyRun(await read(runPath)), firstRun));
    const finished = current();
    const expires = Math.min(
      observed + maxAge,
      authenticated.expires_at,
      request.receipt.expires_at,
    );
    requireProducer(
      finished < expires &&
        performance.now() - physicalObserved < maxAge &&
        performance.now() - authenticatedPhysical < authenticated.expires_at - authenticatedNow,
    );
    // The oldest final-round response stamps every public authority link. Later readbacks
    // cannot renew its 30-second lifetime; independently authenticated sealing expiry also caps it.
    return frozen({
      schema: 1,
      purpose: "tarubot-applied-target-job-proof-v1",
      receipt: request.receipt as AppliedTargetReceipt,
      producer: request.receipt.producer,
      head_commit: release.commit,
      workflow_ref: request.job.workflow_ref,
      workflow_commit: request.job.workflow_commit,
      job_name: request.job.job_name,
      job_id: writer.job_id,
      status: "completed",
      conclusion: "success",
      critical_step: writer.critical_step,
      observed_at: observed,
      expires_at: expires,
    });
  } catch {
    throw new Error("invalid-target-producer-evidence");
  }
}
