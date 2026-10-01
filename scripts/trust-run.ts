/**
 * Read-only final-run evidence for future owner-gated enrollment/recovery workflows.
 * No dispatch/approval/cancel/rerun APIs, environment mutation, CLI or inherited token lookup.
 * These workflow/job/step/environment pins are declarations; integration remains absent.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, types } from "node:util";

type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const api = "https://api.github.com";
const prefix = `/repos/${repository}`;
const maxBody = 1_048_576;
const nativeThen = Promise.prototype.then;
const nativeSet = Uint8Array.prototype.set;
const nativeLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)?.get;
requireRun(nativeLength && nativeBuffer);
/** Intrinsic typed-array copies never execute an iterator or trust shadowed byte lengths. */
function copyBytes(value: unknown, limit: number, check: () => void): Uint8Array {
  check();
  requireRun(types.isUint8Array(value));
  requireRun(
    !types.isSharedArrayBuffer(Reflect.apply(nativeBuffer as () => ArrayBuffer, value, [])),
  );
  const length: unknown = Reflect.apply(nativeLength as () => number, value, []);
  requireRun(typeof length === "number" && length <= limit);
  check();
  const result = new Uint8Array(length);
  Reflect.apply(nativeSet, result, [value]);
  check();
  requireRun(Reflect.apply(nativeLength as () => number, value, []) === length);
  return result;
}

// Applying the captured intrinsic drains even cross-realm native promises without reading
// a caller's then property. A refused promise never becomes an approval or a fresh clock.
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Ordinary values and thenables still fail the synchronous contract. */
  }
}

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

/** Bounded private inputs are plain snapshots; accessor-bearing callers execute no getter. */
function snapshot(value: unknown, check: () => void = () => {}): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    check();
    requireRun(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      requireRun(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireRun(bytes <= 65_536);
      return input;
    }
    requireRun(input !== null && typeof input === "object" && !ancestors.has(input));
    requireRun(Object.getOwnPropertySymbols(input).length === 0);
    check();
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    check();
    let result: unknown;
    if (Array.isArray(input)) {
      const length: unknown = descriptors.length?.value;
      requireRun(
        typeof length === "number" &&
          Number.isInteger(length) &&
          length >= 0 &&
          length <= 1024 &&
          Object.keys(descriptors).length === length + 1,
      );
      result = Array.from({ length }, (_, index) => {
        const item = descriptors[String(index)];
        requireRun(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      check();
      requireRun(prototype === Object.prototype || prototype === null);
      const data: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireRun(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireRun(bytes <= 65_536);
        Object.defineProperty(data, key, { value: copy(item.value, depth + 1), enumerable: true });
      }
      result = data;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
/** Complete bounded UTF-8 JSON; duplicate decoded keys never silently replace evidence. */
function json(bytes: Uint8Array, check: () => void): unknown {
  check();
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[at] ?? "")) at++;
  };
  const string = () => {
    requireRun(source[at] === '"');
    const start = at++;
    while (at < source.length) {
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
      if (source[at - 1] === "\\") at++;
    }
    throw new Error("invalid-trust-run-evidence");
  };
  const value = (depth: number): void => {
    check();
    requireRun(++nodes <= 65_536 && depth <= 32);
    whitespace();
    const first = source[at];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      at++;
      whitespace();
      const end = first === "{" ? "}" : "]",
        keys = new Set<string>();
      if (source[at] === end) {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          requireRun(!keys.has(key));
          keys.add(key);
          whitespace();
          requireRun(source[at++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[at++];
        if (next === end) return;
        requireRun(next === ",");
      }
    }
    const start = at;
    while (at < source.length && !/^[,}\] \t\r\n]$/u.test(source[at] ?? "")) at++;
    requireRun(at > start);
    const result = JSON.parse(source.slice(start, at)) as unknown;
    requireRun(typeof result !== "number" || Number.isFinite(result));
  };
  value(0);
  whitespace();
  requireRun(at === source.length);
  check();
  const result = JSON.parse(source) as unknown;
  check();
  return result;
}

/** Explicit direct HTTPS agent; the original operation guards each actual native offer. */
function directGet(
  input: GitHubReadRequest,
  check: () => void,
  capture: <T>(work: () => T) => T,
): Promise<GitHubReadResponse> {
  return new Promise((accept, reject) => {
    let agent: Agent | undefined;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: unknown, value?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error !== undefined) {
        request?.destroy();
        response?.destroy();
      }
      agent?.destroy();
      if (error !== undefined) reject(new Error("trust-run-read-failed"));
      else if (value) accept(value);
    };
    const guarded = (work: () => void) => {
      if (finished) return;
      try {
        check();
        capture(work);
        check();
      } catch (error) {
        finish(error);
      }
    };
    try {
      check();
      const url = new URL(input.url);
      requireRun(
        url.origin === api &&
          url.username === "" &&
          url.password === "" &&
          url.hash === "" &&
          url.pathname.startsWith(`${prefix}/`) &&
          input.method === "GET",
      );
      agent = new Agent({ keepAlive: false });
      const options = {
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
      };
      // Route, headers and Agent preparation cannot move the original authorization barrier.
      check();
      request = httpsRequest(options, (incoming) => {
        response = incoming;
        if (finished) {
          incoming.destroy();
          return;
        }
        guarded(() => {
          const on = incoming.on.bind(incoming);
          check();
          on("error", () => finish(new Error("trust-run-read-failed")));
          check();
          on("aborted", () => finish(new Error("trust-run-read-failed")));
          check();
          on("data", (chunk: Buffer) =>
            guarded(() => {
              const bytes = copyBytes(chunk, input.body_limit - size, check);
              size += bytes.byteLength;
              check();
              chunks.push(Buffer.from(bytes));
            }),
          );
          check();
          on("end", () =>
            guarded(() => {
              const complete = incoming.complete;
              check();
              requireRun(complete);
              const headers: Record<string, string> = {};
              check();
              const raw = list(snapshot(incoming.rawHeaders, check));
              check();
              requireRun(raw.length % 2 === 0 && raw.length <= 256);
              let bytes = 0;
              for (let i = 0; i < raw.length; i += 2) {
                check();
                const key = raw[i],
                  value = raw[i + 1];
                requireRun(typeof key === "string");
                const name = key.toLowerCase();
                requireRun(
                  typeof name === "string" &&
                    typeof value === "string" &&
                    !Object.hasOwn(headers, name),
                );
                bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
                requireRun(bytes <= 16_384);
                Object.defineProperty(headers, name, { value, enumerable: true });
              }
              check();
              const body = Buffer.concat(chunks);
              check();
              const status = incoming.statusCode ?? 0;
              check();
              finish(undefined, {
                status,
                url: input.url,
                headers,
                body,
              });
            }),
          );
        });
      });
      check();
      const on = request.on.bind(request);
      check();
      on("error", () => finish(new Error("trust-run-read-failed")));
      check();
      timer = setTimeout(() => finish(new Error("trust-run-read-failed")), input.timeout_ms);
      const end = request.end.bind(request);
      check();
      end();
      check();
    } catch (error) {
      finish(error);
    }
  });
}

/** One original wall/physical operation, with a refusal-only callback and permanent fence. */
class Operation {
  #started = 0;
  #last = 0;
  #checking = false;
  #fenced = false;
  constructor(
    readonly physical: number,
    readonly budget: number,
    readonly now: () => number,
    readonly denial?: () => void,
    readonly capture: <T>(work: () => T) => T = (work) => work(),
  ) {}
  fence(): void {
    this.#fenced = true;
  }
  assertAlive(): void {
    requireRun(!this.#fenced && performance.now() - this.physical < this.budget);
  }
  tick(): number {
    let owned = false;
    try {
      requireRun(!this.#fenced && !this.#checking);
      this.#checking = true;
      owned = true;
      requireRun(performance.now() - this.physical < this.budget);
      const refuse = () => {
        if (this.denial === undefined) return;
        requireRun(typeof this.denial === "function");
        const result = this.denial();
        if (result !== undefined) {
          this.fence();
          drain(result);
        }
        requireRun(result === undefined && !this.#fenced && this.#checking);
      };
      refuse();
      const value: unknown = this.now();
      if (typeof value !== "number") {
        this.fence();
        drain(value);
      }
      identifier(value);
      requireRun(
        !this.#fenced && this.#checking && performance.now() - this.physical < this.budget,
      );
      refuse();
      if (this.#started === 0) this.#started = value;
      requireRun(value >= this.#last && value - this.#started < this.budget);
      this.#last = value;
      return value;
    } catch {
      this.fence();
      throw new Error("invalid-trust-run-evidence");
    } finally {
      if (owned) this.#checking = false;
    }
  }
  remaining(): number {
    const value = this.tick();
    return Math.min(
      this.budget - (value - this.#started),
      this.budget - (performance.now() - this.physical),
    );
  }
  async within<T>(work: () => Promise<T>, limit = this.budget): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.min(limit, this.remaining());
      requireRun(remaining > 0);
      let end = performance.now() + remaining;
      let rejectDeadline: (reason: Error) => void = () => {};
      const schedule = () => {
        // Caller work may consume wall/physical time synchronously before returning its
        // promise. Shorten the same timer; never restart or extend the original deadline.
        end = Math.min(end, performance.now() + this.remaining());
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            this.fence();
            rejectDeadline(new Error("invalid-trust-run-evidence"));
          },
          Math.max(0, end - performance.now()),
        );
      };
      const timeout = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      schedule();
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.tick();
          const pending = work();
          try {
            this.tick();
            schedule();
          } catch (error) {
            drain(pending);
            throw error;
          }
          return pending;
        }),
        timeout,
      ]);
      this.tick();
      return result;
    } catch {
      this.fence();
      throw new Error("invalid-trust-run-evidence");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Descriptor reads capture each dependency once, without executing an accessor. */
function dependency(value: unknown, name: string, check: () => void): unknown {
  check();
  const d = Object.getOwnPropertyDescriptor(object(value), name);
  check();
  requireRun(d === undefined || Object.hasOwn(d, "value"));
  return d?.value;
}

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
export interface TrustRunDependencies {
  owner_id: number;
  get?: GitHubReader;
  token?: string;
  now?: () => number;
}
interface EnrollmentExecution {
  job_id: number;
  check_run_id: number;
  critical_step_number: number;
}
interface NativePins {
  repository_id: number;
  environment_id: number;
  execution?: Readonly<EnrollmentExecution>;
}
export async function readTrustRun(
  expected: TrustRunRequest,
  dependencies: TrustRunDependencies,
  denial?: () => void,
): Promise<TrustRunProof> {
  // This anchor precedes every caller/config/clock hook, including the first clock call.
  const physical = performance.now();
  try {
    const captured = captureDependencies(dependencies, physical, 60_000);
    const operation = new Operation(physical, 60_000, captured.now, denial);
    return await operation.within(() => readCore(expected, captured, operation));
  } catch {
    throw new Error("invalid-trust-run-evidence");
  }
}
function captureDependencies(value: TrustRunDependencies, physical: number, budget: number) {
  const initial = () => requireRun(performance.now() - physical < budget);
  const now = dependency(value, "now", initial) ?? Date.now;
  const get = dependency(value, "get", initial);
  const ownerId = dependency(value, "owner_id", initial);
  const token = dependency(value, "token", initial);
  initial();
  requireRun(typeof now === "function" && (get === undefined || typeof get === "function"));
  identifier(ownerId);
  requireRun(
    token === undefined || (typeof token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(token)),
  );
  return {
    ownerId,
    token: token as string | undefined,
    now: now as () => number,
    get: get as GitHubReader | undefined,
  };
}
async function readCore(
  expected: TrustRunRequest,
  captured: ReturnType<typeof captureDependencies>,
  operation: Operation,
  native?: NativePins,
): Promise<TrustRunProof> {
  try {
    operation.tick();
    const { ownerId, token, get } = captured;
    const request = exact(
      operation.capture(() =>
        snapshot(expected, () => {
          operation.tick();
        }),
      ),
      ["kind", "target", "commit", "run"],
    ) as unknown as TrustRunRequest;
    operation.tick();
    const pin = contract(request);
    requireRun(typeof request.commit === "string" && /^[a-f0-9]{40}$/u.test(request.commit));
    requireRun(typeof request.run === "string" && /^[1-9][0-9]{0,15}$/u.test(request.run));
    identifier(Number(request.run));
    requireRun(String(Number(request.run)) === request.run);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "TaruBot-trust-evidence",
      "Accept-Encoding": "identity",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const read = async (path: string) => {
      const url = `${api}${prefix}${path}`;
      const remaining = operation.remaining();
      const input: GitHubReadRequest = {
        url,
        method: "GET",
        headers: { ...headers },
        timeout_ms: Math.min(10_000, remaining),
        body_limit: maxBody,
        redirect: "error",
      };
      const response = await operation.within(() => {
        operation.tick();
        return operation.capture(() =>
          get
            ? get(input)
            : directGet(
                input,
                () => {
                  operation.tick();
                },
                operation.capture,
              ),
        );
      }, input.timeout_ms);
      operation.tick();
      // Capture metadata before the body copy. No response getter executes as evidence.
      const [status, finalUrl, rawBody, rawHeaders] = operation.capture(() => [
        dependency(response, "status", () => {
          operation.tick();
        }),
        dependency(response, "url", () => {
          operation.tick();
        }),
        dependency(response, "body", () => {
          operation.tick();
        }),
        dependency(response, "headers", () => {
          operation.tick();
        }),
      ]);
      requireRun(status === 200 && finalUrl === url && types.isUint8Array(rawBody));
      operation.tick();
      const body = copyBytes(rawBody, maxBody, () => {
        operation.tick();
      });
      operation.tick();
      const h: Record<string, string> = {};
      let headerBytes = 0;
      for (const [name, value] of Object.entries(
        object(
          operation.capture(() =>
            snapshot(rawHeaders, () => {
              operation.tick();
            }),
          ),
        ),
      )) {
        const lower = name.toLowerCase();
        requireRun(typeof value === "string" && !Object.hasOwn(h, lower));
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        requireRun(headerBytes <= 16_384 && Object.keys(h).length < 128);
        Object.defineProperty(h, lower, { value, enumerable: true });
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
      operation.tick();
      const data = json(body, () => {
        operation.tick();
      });
      operation.tick();
      return data;
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
        requireRun(
          repo.full_name === repository &&
            repo.fork === false &&
            (native === undefined || repo.id === native.repository_id),
        );
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
      requireRun(native === undefined || env.id === native.environment_id);
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
    const verifyNativeJob = (value: unknown) => {
      const actual = object(value);
      requireRun(isDeepStrictEqual(actual, job));
      requireRun(actual.url === `${api}${prefix}/actions/jobs/${job.id}`);
      requireRun(typeof actual.check_run_url === "string");
      const checkPrefix = `${api}${prefix}/check-runs/`;
      requireRun(actual.check_run_url.startsWith(checkPrefix));
      const checkId = actual.check_run_url.slice(checkPrefix.length);
      requireRun(/^[1-9][0-9]{0,15}$/u.test(checkId));
      identifier(Number(checkId));
      requireRun(String(Number(checkId)) === checkId);
      const steps = list(actual.steps).map(object);
      requireRun(
        steps.length > 0 &&
          steps.length <= 100 &&
          new Set(steps.map((step) => step.number)).size === steps.length,
      );
      for (const step of steps) identifier(step.number);
      identifier(critical[0]?.number);
      return Number(checkId);
    };
    if (native) {
      const checkRunId = verifyNativeJob(job);
      native.execution = Object.freeze({
        job_id: job.id,
        check_run_id: checkRunId,
        critical_step_number: critical[0]?.number as number,
      });
      verifyNativeJob(await read(`/actions/jobs/${job.id}`));
    }
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
    if (native) {
      verifyNativeJob(await read(`/actions/jobs/${job.id}`));
      requireRun(
        isDeepStrictEqual(
          await read(`/actions/runs/${request.run}/attempts/1/jobs?per_page=100&page=1`),
          jobsPage,
        ),
      );
      requireRun(
        isDeepStrictEqual(await read(`/actions/runs/${request.run}/approvals`), approvals),
      );
    }
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
      observed_at: operation.tick(),
    };
  } catch {
    throw new Error("invalid-trust-run-evidence");
  }
}

export interface TrustEnrollmentRunConfiguration {
  target: "staging" | "production";
  owner_id: number;
  repository_id: number;
  environment_id: number;
  token: string;
}
export interface TrustEnrollmentRunRequest {
  target: "staging" | "production";
  run: { commit: string; run: string };
}
declare const enrollmentBrand: unique symbol;
/** Native execution evidence only; public JSON receipts cannot construct this identity. */
export type TrustEnrollmentRunProof = Readonly<{ [enrollmentBrand]: true }>;
export interface TrustEnrollmentRunVerifier {
  verify(
    expected: TrustEnrollmentRunRequest,
    denial?: () => void,
  ): Promise<TrustEnrollmentRunProof>;
  assert(proof: TrustEnrollmentRunProof, expected: TrustEnrollmentRunRequest): void;
  remaining(proof: TrustEnrollmentRunProof, expected: TrustEnrollmentRunRequest): number;
  within<T>(
    proof: TrustEnrollmentRunProof,
    expected: TrustEnrollmentRunRequest,
    work: () => Promise<T>,
  ): Promise<T>;
}
interface EnrollmentState {
  owner: object;
  request: TrustEnrollmentRunRequest;
  evidence: Readonly<TrustRunProof>;
  execution: Readonly<EnrollmentExecution>;
  operation: Operation;
  checking: boolean;
  working: boolean;
  fenced: boolean;
}
const enrollmentProofs = new WeakMap<TrustEnrollmentRunProof, EnrollmentState>();
function enrollmentRequest(value: unknown, check: () => void): TrustEnrollmentRunRequest {
  const data = exact(snapshot(value, check), ["target", "run"]);
  requireRun(data.target === "staging" || data.target === "production");
  const run = exact(data.run, ["commit", "run"]);
  requireRun(typeof run.commit === "string" && /^[a-f0-9]{40}$/u.test(run.commit));
  requireRun(typeof run.run === "string" && /^[1-9][0-9]{0,15}$/u.test(run.run));
  identifier(Number(run.run));
  requireRun(String(Number(run.run)) === run.run);
  return data as unknown as TrustEnrollmentRunRequest;
}
function fenceEnrollment(saved: EnrollmentState | undefined): void {
  if (saved) {
    saved.fenced = true;
    saved.operation.fence();
  }
}

/**
 * A distinct, factory-bound enrollment verifier retains the same ORIGINAL <=30s operation.
 * Numeric repository/gate IDs, real final job/check/critical-step identity and direct reopens
 * are additional native requirements; legacy recovery receipts and their pins stay unchanged.
 * Execution does not authenticate a private journal hash: trusted reviewed writer, journal
 * ciphertext links and owner-bound ordinary-read checks remain separate mandatory evidence.
 */
export function createTrustEnrollmentRunVerifier(
  configuration: TrustEnrollmentRunConfiguration,
  dependencies: { get?: GitHubReader; now?: () => number } = {},
): TrustEnrollmentRunVerifier {
  const physical = performance.now();
  try {
    const initial = () => requireRun(performance.now() - physical < 30_000);
    initial();
    const config = exact(snapshot(configuration, initial), [
      "target",
      "owner_id",
      "repository_id",
      "environment_id",
      "token",
    ]) as unknown as TrustEnrollmentRunConfiguration;
    initial();
    requireRun(config.target === "staging" || config.target === "production");
    identifier(config.owner_id);
    identifier(config.repository_id);
    identifier(config.environment_id);
    requireRun(typeof config.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(config.token));
    const now = dependency(dependencies, "now", initial) ?? Date.now;
    const get = dependency(dependencies, "get", initial);
    requireRun(typeof now === "function" && (get === undefined || typeof get === "function"));
    initial();
    Object.freeze(config);
    const owner = Object.freeze({});
    const captured = {
      ownerId: config.owner_id,
      token: config.token,
      now: now as () => number,
      get: get as GitHubReader | undefined,
    };
    let currentHook: { operation: Operation; saved: EnrollmentState | undefined } | undefined;
    const entry = () => {
      if (currentHook) {
        currentHook.operation.fence();
        fenceEnrollment(currentHook.saved);
        throw new Error("invalid-trust-run-evidence");
      }
    };
    const hook = <T>(
      operation: Operation,
      saved: EnrollmentState | undefined,
      work: () => T,
    ): T => {
      const previous = currentHook;
      currentHook = { operation, saved: saved ?? previous?.saved };
      let result: unknown;
      try {
        requireRun(previous === undefined || previous.operation === operation);
        operation.assertAlive();
        result = work();
        operation.assertAlive();
        return result as T;
      } catch (error) {
        operation.fence();
        drain(result);
        throw error;
      } finally {
        currentHook = previous;
      }
    };
    const assertion = (proof: TrustEnrollmentRunProof, expected: TrustEnrollmentRunRequest) => {
      let saved: EnrollmentState | undefined,
        owned = false;
      try {
        requireRun(proof !== null && typeof proof === "object");
        saved = enrollmentProofs.get(proof);
        // Save the real state before any mismatch so a cross-factory/nested denial fences it.
        requireRun(saved && saved.owner === owner && !saved.fenced && !saved.checking);
        saved.checking = true;
        owned = true;
        const retained = saved;
        const request = hook(retained.operation, retained, () =>
          enrollmentRequest(expected, () => {
            retained.operation.tick();
          }),
        );
        requireRun(!saved.fenced && saved.checking && isDeepStrictEqual(saved.request, request));
        saved.operation.tick();
        requireRun(!saved.fenced && saved.checking);
        return saved;
      } catch {
        fenceEnrollment(saved);
        throw new Error("invalid-trust-run-evidence");
      } finally {
        if (saved && owned) saved.checking = false;
      }
    };
    return Object.freeze({
      async verify(
        expected: TrustEnrollmentRunRequest,
        denial?: () => void,
      ): Promise<TrustEnrollmentRunProof> {
        const startedPhysical = performance.now();
        entry();
        let saved: EnrollmentState | undefined, operation: Operation;
        const capture = <T>(work: () => T): T => hook(operation, saved, work);
        operation = new Operation(
          startedPhysical,
          30_000,
          () => capture(captured.now),
          denial === undefined ? undefined : () => capture(() => denial()),
          capture,
        );
        try {
          // No authority is delivered until every direct final execution/protection reopen ends.
          const request = capture(() =>
            enrollmentRequest(expected, () => {
              operation.assertAlive();
            }),
          );
          operation.tick();
          requireRun(request.target === config.target);
          const pins: NativePins = {
            repository_id: config.repository_id,
            environment_id: config.environment_id,
          };
          const evidence = await operation.within(() =>
            readCore(
              {
                kind: "enrollment",
                target: request.target,
                commit: request.run.commit,
                run: request.run.run,
              },
              captured,
              operation,
              pins,
            ),
          );
          operation.tick();
          Object.freeze(request.run);
          Object.freeze(request);
          Object.freeze(evidence.reviewer);
          Object.freeze(evidence);
          requireRun(pins.execution !== undefined && pins.execution.job_id === evidence.job_id);
          const proof = Object.freeze({}) as TrustEnrollmentRunProof;
          saved = {
            owner,
            request,
            evidence,
            execution: pins.execution,
            operation,
            checking: false,
            working: false,
            fenced: false,
          };
          enrollmentProofs.set(proof, saved);
          assertion(proof, request);
          return proof;
        } catch {
          operation.fence();
          throw new Error("invalid-trust-run-evidence");
        }
      },
      assert(proof: TrustEnrollmentRunProof, expected: TrustEnrollmentRunRequest): void {
        entry();
        assertion(proof, expected);
      },
      remaining(proof: TrustEnrollmentRunProof, expected: TrustEnrollmentRunRequest): number {
        entry();
        const saved = assertion(proof, expected);
        try {
          const remaining = saved.operation.remaining();
          requireRun(!saved.fenced && remaining > 0);
          return remaining;
        } catch {
          fenceEnrollment(saved);
          throw new Error("invalid-trust-run-evidence");
        }
      },
      async within<T>(
        proof: TrustEnrollmentRunProof,
        expected: TrustEnrollmentRunRequest,
        work: () => Promise<T>,
      ): Promise<T> {
        let saved: EnrollmentState | undefined,
          owned = false;
        try {
          entry();
          // Reserve the work phase before expected/clock hooks can start a nested operation.
          requireRun(proof !== null && typeof proof === "object");
          saved = enrollmentProofs.get(proof);
          requireRun(saved && saved.owner === owner && !saved.fenced && !saved.working);
          saved.working = true;
          owned = true;
          assertion(proof, expected);
          requireRun(!saved.fenced && saved.working && typeof work === "function");
          const result = await saved.operation.within(() => {
            assertion(proof, expected);
            return work();
          });
          assertion(proof, expected);
          requireRun(!saved.fenced && saved.working);
          return result;
        } catch {
          fenceEnrollment(saved);
          throw new Error("invalid-trust-run-evidence");
        } finally {
          if (saved && owned) saved.working = false;
        }
      },
    });
  } catch {
    throw new Error("invalid-trust-run-evidence");
  }
}
