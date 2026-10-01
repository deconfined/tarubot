/**
 * Native public execution evidence for the ORIGINAL infrastructure baseline writer job.
 * GET evidence proves execution, not private state/hash attribution. The journal separately
 * captures/reopens authenticated ciphertext under the owner-provisioned trusted-writer/codec
 * contract. A hostile writer holding that codec key requires a separate signed receipt design.
 * No environment/token lookup, dispatch, approval, state, provider or host operation occurs here.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { appliedTargetJobPaths } from "./target-producer-run.js";
import type { GitHubReader, GitHubReadRequest, GitHubReadResponse } from "./trust-run.js";

type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const api = "https://api.github.com";
const prefix = `/repos/${repository}`;
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const maxOperation = 60_000;
const maxAge = 30_000;
const automaticStep = "Recheck policy and apply exact saved plan";

function requireRun(value: unknown): asserts value {
  if (!value) throw new Error("invalid-infrastructure-baseline-run");
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
function integer(value: unknown): asserts value is number {
  requireRun(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function list(value: unknown): unknown[] {
  requireRun(Array.isArray(value));
  return value;
}
/** Bounded private inputs are plain snapshots; accessor-bearing callers execute no getter. */
function snapshot(value: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
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
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      requireRun(input.length <= 1024 && Object.keys(descriptors).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireRun(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireRun(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
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
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Uint8Array.from(bytes),
  );
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
    throw new Error("invalid-infrastructure-baseline-run");
  };
  const value = (depth: number): void => {
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
  return JSON.parse(source) as unknown;
}

export interface InfrastructureBaselineRunRequest {
  kind: "baseline" | "apply";
  run: { commit: string; run: string };
}
function request(value: unknown): InfrastructureBaselineRunRequest {
  const data = exact(snapshot(value), ["kind", "run"]);
  requireRun(data.kind === "baseline" || data.kind === "apply");
  const r = exact(data.run, ["commit", "run"]);
  requireRun(typeof r.commit === "string" && /^[a-f0-9]{40}$/u.test(r.commit));
  requireRun(typeof r.run === "string" && /^[1-9][0-9]{0,15}$/u.test(r.run));
  integer(Number(r.run));
  requireRun(String(Number(r.run)) === r.run);
  return data as unknown as InfrastructureBaselineRunRequest;
}
declare const proofBrand: unique symbol;
/** Execution-only opaque result. No private generation/state/hash is authenticated by GitHub. */
export type InfrastructureBaselineRunProof = Readonly<{ [proofBrand]: true }>;
export type VerifyInfrastructureBaselineRun = (
  request: InfrastructureBaselineRunRequest,
  denial?: () => void,
) => Promise<InfrastructureBaselineRunProof>;
interface ProofState {
  request: InfrastructureBaselineRunRequest;
  clock: () => number;
  last: number;
  expires: number;
  physicalExpires: number;
  fenced: boolean;
  checking: boolean;
}
// Identity, not shape, authorizes use: an echo, spread or serialized proof has no entry here.
const proofs = new WeakMap<InfrastructureBaselineRunProof, ProofState>();
export function assertInfrastructureBaselineRunProof(
  value: unknown,
  expected: InfrastructureBaselineRunRequest,
): void {
  let saved: ProofState | undefined,
    reserved = false;
  try {
    requireRun(value !== null && typeof value === "object");
    saved = proofs.get(value as InfrastructureBaselineRunProof);
    requireRun(saved && !saved.fenced && !saved.checking);
    // Reserve before caller snapshots and the original denial clock can reenter. A nested
    // refusal permanently fences the outer assertion, and cannot release its reservation.
    saved.checking = true;
    reserved = true;
    const captured = request(expected);
    requireRun(!saved.fenced && saved.checking && isDeepStrictEqual(saved.request, captured));
    const at = saved.clock();
    integer(at);
    requireRun(
      !saved.fenced &&
        saved.checking &&
        at >= saved.last &&
        at < saved.expires &&
        performance.now() < saved.physicalExpires,
    );
    saved.last = at;
  } catch {
    if (saved) saved.fenced = true;
    throw new Error("invalid-infrastructure-baseline-run");
  } finally {
    if (saved && reserved) saved.checking = false;
  }
}
/** Bound post-proof private reads to the ORIGINAL wall/physical expiry; late results grant nothing. */
export async function withinInfrastructureBaselineRunProof<T>(
  value: unknown,
  expected: InfrastructureBaselineRunRequest,
  work: () => Promise<T>,
): Promise<T> {
  assertInfrastructureBaselineRunProof(value, expected);
  const saved = proofs.get(value as InfrastructureBaselineRunProof);
  requireRun(saved);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = Math.min(
      saved.expires - saved.last,
      saved.physicalExpires - performance.now(),
    );
    requireRun(remaining > 0);
    const result = await Promise.race([
      Promise.resolve().then(() => {
        assertInfrastructureBaselineRunProof(value, expected);
        return work();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("invalid-infrastructure-baseline-run")),
          remaining,
        );
      }),
    ]);
    assertInfrastructureBaselineRunProof(value, expected);
    return result;
  } catch (error) {
    saved.fenced = true;
    // Preserve the existing trusted adapter's effect diagnostic while denying every future
    // use of this proof. New candidate transport folds it at its own private boundary.
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed direct HTTPS; no ambient proxy/token/CLI configuration, redirects or retries. */
const directGet = (
  input: GitHubReadRequest,
  beforeRead?: () => void,
): Promise<GitHubReadResponse> =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    if (
      input.method !== "GET" ||
      url.origin !== api ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
    ) {
      reject(new Error("invalid-infrastructure-baseline-run"));
      return;
    }
    const agent = new Agent({ keepAlive: false }),
      chunks: Buffer[] = [];
    let size = 0,
      finished = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (value) accept(value);
      else reject(new Error("invalid-infrastructure-baseline-run"));
    };
    // Route/header construction is not authorization. The per-invocation refusal clock is
    // checked again immediately before offering this fixed-origin native HTTPS request.
    try {
      beforeRead?.();
    } catch {
      agent.destroy();
      reject(new Error("invalid-infrastructure-baseline-run"));
      return;
    }
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.github.com",
        servername: "api.github.com",
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
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
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.complete) {
            finish();
            return;
          }
          const headers: Record<string, string> = Object.create(null);
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase(),
              value = response.rawHeaders[i + 1];
            if (name === undefined || value === undefined) {
              finish();
              return;
            }
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
    req.on("error", () => finish());
    timer = setTimeout(() => {
      finish();
      req.destroy();
    }, input.timeout_ms);
    req.end();
  });

interface Configuration {
  owner_id: number;
  repository_id: number;
  token: string;
}
interface Dependencies {
  get?: GitHubReader;
  now?: () => number;
}
class BaselineReader {
  readonly #config: Configuration;
  readonly #get: GitHubReader;
  readonly #clock: () => number;
  readonly #native: boolean;
  constructor(value: Configuration, dependencies: Dependencies) {
    const config = exact(snapshot(value), ["owner_id", "repository_id", "token"]);
    integer(config.owner_id);
    integer(config.repository_id);
    requireRun(typeof config.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(config.token));
    this.#config = config as unknown as Configuration;
    // Capture once: a changing accessor cannot select the native path after supplying a mock.
    const get = dependencies.get,
      clock = dependencies.now ?? Date.now;
    this.#get = get ?? directGet;
    this.#native = get === undefined;
    this.#clock = clock;
    requireRun(typeof this.#get === "function" && typeof this.#clock === "function");
    Object.freeze(this);
  }
  async verify(
    input: InfrastructureBaselineRunRequest,
    denial?: () => void,
  ): Promise<InfrastructureBaselineRunProof> {
    // This instant precedes input snapshots, the refusal callback and the FIRST wall clock.
    const physicalStarted = performance.now();
    let fenced = false,
      checking = false,
      started: number | undefined,
      last: number | undefined;
    const tick = () => {
      try {
        requireRun(!fenced && !checking);
        checking = true;
        // The optional callback only refuses. No truthy value, promise or caller receipt can
        // substitute for the native verifier's fixed execution checks or grant more time.
        requireRun(denial === undefined || typeof denial === "function");
        const result = denial?.();
        requireRun(result === undefined);
        const at = this.#clock();
        integer(at);
        // The clock itself can consume a shorter enclosing budget. Reopen the same refusal
        // after that callback before any actual read offer or proof use may proceed.
        const afterClock = denial?.();
        requireRun(afterClock === undefined);
        if (started === undefined) started = at;
        requireRun(
          !fenced &&
            at >= (last ?? started) &&
            at - started < maxOperation &&
            performance.now() - physicalStarted < maxOperation,
        );
        last = at;
        return at;
      } catch {
        fenced = true;
        throw new Error("invalid-infrastructure-baseline-run");
      } finally {
        checking = false;
      }
    };
    try {
      const origin = tick(),
        expected = request(input);
      tick();
      const read = async (path: string): Promise<unknown> => {
        const url = `${api}${prefix}${path}`;
        const remaining = Math.min(
          10_000,
          maxOperation - (tick() - origin),
          maxOperation - (performance.now() - physicalStarted),
        );
        requireRun(remaining > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            Promise.resolve().then(() => {
              const input: GitHubReadRequest = {
                url,
                method: "GET",
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2026-03-10",
                  "Accept-Encoding": "identity",
                  "Cache-Control": "no-cache",
                  "User-Agent": "TaruBot-infrastructure-baseline",
                  Authorization: `Bearer ${this.#config.token}`,
                },
                timeout_ms: remaining,
                body_limit: maxBody,
                redirect: "error",
              };
              // Scheduling is not authority: retain the original refusal clock at the
              // actual mock/native offer, including abandoned operations and queued reads.
              tick();
              return this.#native ? directGet(input, tick) : this.#get(input);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("invalid-infrastructure-baseline-run")),
                remaining,
              );
            }),
          ]);
          tick();
          requireRun(
            response.status === 200 &&
              response.url === url &&
              response.body instanceof Uint8Array &&
              response.body.length > 0 &&
              response.body.length <= maxBody,
          );
          const headers: Record<string, string> = Object.create(null);
          let headerSize = 0;
          for (const [name, value] of Object.entries(object(response.headers))) {
            requireRun(typeof value === "string");
            headerSize += name.length + value.length;
            const key = name.toLowerCase();
            requireRun(!Object.hasOwn(headers, key));
            headers[key] = value;
          }
          requireRun(
            headerSize <= maxHeaders &&
              typeof headers["content-type"] === "string" &&
              /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
                headers["content-type"],
              ),
          );
          requireRun(
            headers.location === undefined &&
              headers.link === undefined &&
              (headers["content-encoding"] === undefined ||
                headers["content-encoding"] === "identity"),
          );
          const data = json(Uint8Array.from(response.body));
          tick();
          return data;
        } catch {
          fenced = true;
          throw new Error("invalid-infrastructure-baseline-run");
        } finally {
          clearTimeout(timer);
        }
      };
      const owner = (value: unknown) => {
        const o = object(value);
        requireRun(o.id === this.#config.owner_id && o.login === "deconfined");
      };
      const runPath = `/actions/runs/${expected.run.run}`,
        runUrl = `${api}${prefix}${runPath}`;
      let automatic: boolean | undefined,
        completed = false;
      const verifyRun = (value: unknown) => {
        const r = object(value);
        requireRun(
          r.id === Number(expected.run.run) &&
            r.head_sha === expected.run.commit &&
            r.head_branch === "main" &&
            r.run_attempt === 1 &&
            r.url === runUrl,
        );
        for (const source of [r.repository, r.head_repository]) {
          const repo = object(source);
          requireRun(
            repo.full_name === repository &&
              repo.id === this.#config.repository_id &&
              repo.fork === false,
          );
          owner(repo.owner);
        }
        const mode = r.event === "push";
        requireRun(automatic === undefined || automatic === mode);
        automatic = mode;
        const workflow = mode ? "publish" : "infra",
          path = `.github/workflows/${workflow}.yml`;
        requireRun(
          [
            path,
            `${path}@main`,
            `${path}@refs/heads/main`,
            `${repository}/${path}@main`,
            `${repository}/${path}@refs/heads/main`,
          ].includes(r.path as string),
        );
        if (!mode) {
          requireRun(
            r.event === "workflow_dispatch" &&
              r.status === "completed" &&
              r.conclusion === "success",
          );
          owner(r.actor);
          owner(r.triggering_actor);
        } else {
          requireRun(expected.kind === "apply");
          // A downstream publication failure does not undo a completed infrastructure JOB.
          requireRun(
            (r.status === "in_progress" && r.conclusion === null) ||
              (r.status === "completed" &&
                [
                  "success",
                  "failure",
                  "cancelled",
                  "timed_out",
                  "neutral",
                  "skipped",
                  "action_required",
                  "stale",
                  "startup_failure",
                ].includes(r.conclusion as string)),
          );
          requireRun(!completed || r.status === "completed");
          completed ||= r.status === "completed";
        }
        const bindings: unknown[] = [];
        if (mode) {
          const refs = list(r.referenced_workflows).map(object);
          requireRun(
            refs.length <= 50 && new Set(refs.map((ref) => ref.path)).size === refs.length,
          );
          for (const name of ["release", "release-infra"]) {
            const stem = `${repository}/.github/workflows/${name}.yml@`;
            const selected = refs.filter(
              (ref) => typeof ref.path === "string" && ref.path.startsWith(stem),
            );
            requireRun(selected.length === 1);
            const ref = selected[0];
            requireRun(
              ref &&
                [`${stem}main`, `${stem}refs/heads/main`].includes(ref.path as string) &&
                ref.sha === expected.run.commit &&
                ref.ref === "refs/heads/main",
            );
            bindings.push({ path: `${stem}refs/heads/main`, sha: ref.sha, ref: ref.ref });
          }
        }
        return { id: r.id, commit: r.head_sha, path, event: r.event, bindings };
      };
      const verifyRepository = (value: unknown) => {
        const repo = object(value);
        requireRun(
          repo.full_name === repository &&
            repo.id === this.#config.repository_id &&
            repo.fork === false,
        );
        owner(repo.owner);
        return { id: repo.id, full_name: repo.full_name, fork: repo.fork, owner: repo.owner };
      };
      // Current repository identity is independent of the historical run's embedded objects.
      const currentRepository = verifyRepository(await read(""));
      const firstRun = verifyRun(await read(runPath));
      const gateName = automatic ? "infra-auto" : "infra",
        gatePath = `/environments/${gateName}`;
      const verifyGate = (value: unknown) => {
        const gate = object(value);
        integer(gate.id);
        requireRun(gate.name === gateName && gate.url === `${api}${prefix}${gatePath}`);
        const policy = object(gate.deployment_branch_policy);
        requireRun(policy.protected_branches === false && policy.custom_branch_policies === true);
        const rules = list(gate.protection_rules).map(object);
        requireRun(rules.length <= 100);
        const reviewers = rules.filter((rule) => rule.type === "required_reviewers");
        if (automatic) requireRun(reviewers.length === 0);
        else {
          requireRun(reviewers.length === 1 && reviewers[0]?.prevent_self_review === false);
          const people = list(reviewers[0]?.reviewers).map(object);
          requireRun(people.length === 1 && people[0]?.type === "User");
          owner(people[0]?.reviewer);
        }
        return gate;
      };
      const verifyPolicies = (value: unknown) => {
        const p = object(value),
          entries = list(p.branch_policies).map(object);
        requireRun(
          p.total_count === 1 &&
            entries.length === 1 &&
            entries[0]?.name === "main" &&
            entries[0]?.type === "branch",
        );
        integer(entries[0]?.id);
        return p;
      };
      const verifyMain = (value: unknown) => {
        const main = object(value);
        requireRun(main.name === "main" && main.protected === true);
        // Original jobs may be older than current main; their own exact head_sha is checked.
        return main;
      };
      const step = (job: Value, name: string, status: "success" | "skipped") => {
        const steps = list(job.steps).map(object);
        requireRun(steps.length > 0 && steps.length <= 1000);
        for (const s of steps) integer(s.number);
        requireRun(new Set(steps.map((s) => s.number)).size === steps.length);
        const selected = steps.filter((s) => s.name === name);
        requireRun(
          selected.length === 1 &&
            selected[0]?.status === "completed" &&
            selected[0]?.conclusion === status,
        );
        return { name, number: selected[0]?.number, status: "completed", conclusion: status };
      };
      const verifyJobs = (value: unknown) => {
        const page = object(value),
          jobs = list(page.jobs).map(object);
        requireRun(jobs.length <= 100 && page.total_count === jobs.length);
        for (const job of jobs) integer(job.id);
        requireRun(new Set(jobs.map((job) => job.id)).size === jobs.length);
        const selected = (name: string) => {
          const found = jobs.filter((job) => job.name === name);
          requireRun(found.length === 1);
          const job = found[0];
          requireRun(
            job &&
              job.run_id === Number(expected.run.run) &&
              job.run_attempt === 1 &&
              job.head_sha === expected.run.commit &&
              job.head_branch === "main" &&
              job.run_url === runUrl &&
              job.status === "completed" &&
              job.conclusion === "success",
          );
          return job;
        };
        const plan = selected(automatic ? appliedTargetJobPaths["no-changes"] : "Plan"),
          apply = selected(automatic ? appliedTargetJobPaths.apply : "Apply");
        const critical = [
          step(plan, automatic ? "Plan and require automatic policy" : "Plan", "success"),
        ];
        if (automatic) critical.push(step(apply, automaticStep, "success"));
        else if (expected.kind === "baseline") {
          critical.push(
            step(apply, "Establish initial baseline without provider changes", "success"),
            step(apply, "Apply", "skipped"),
            step(apply, "Verify adoption with read-only provider credentials", "skipped"),
          );
        } else {
          critical.push(
            step(apply, "Apply", "success"),
            step(apply, "Establish initial baseline without provider changes", "skipped"),
          );
          const adoption = list(apply.steps)
            .map(object)
            .filter((s) => s.name === "Verify adoption with read-only provider credentials");
          requireRun(
            adoption.length === 1 &&
              (adoption[0]?.conclusion === "success" || adoption[0]?.conclusion === "skipped"),
          );
          critical.push(
            step(
              apply,
              "Verify adoption with read-only provider credentials",
              adoption[0]?.conclusion as "success" | "skipped",
            ),
          );
        }
        return { plan: plan.id, apply: apply.id, critical };
      };
      const jobsPath = `${runPath}/attempts/1/jobs?per_page=100&page=1`,
        policiesPath = `${gatePath}/deployment-branch-policies?per_page=100&page=1`;
      const jobs = verifyJobs(await read(jobsPath)),
        gate = verifyGate(await read(gatePath)),
        policies = verifyPolicies(await read(policiesPath)),
        main = verifyMain(await read("/branches/main"));
      const verifyApprovals = (value: unknown) => {
        const approvals = list(value).map(object);
        requireRun(approvals.length > 0 && approvals.length <= 1000);
        const matching = approvals.filter((review) =>
          list(review.environments).some((env) => object(env).name === gateName),
        );
        requireRun(matching.length === 1 && matching[0]?.state === "approved");
        owner(matching[0]?.user);
        const environments = list(matching[0]?.environments)
          .map(object)
          .filter((env) => env.name === gateName);
        requireRun(
          environments.length === 1 &&
            environments[0]?.id === gate.id &&
            environments[0]?.url === gate.url,
        );
        return matching[0];
      };
      const approvals = automatic ? undefined : verifyApprovals(await read(`${runPath}/approvals`));
      requireRun(isDeepStrictEqual(verifyJobs(await read(jobsPath)), jobs));
      requireRun(isDeepStrictEqual(verifyGate(await read(gatePath)), gate));
      requireRun(isDeepStrictEqual(verifyPolicies(await read(policiesPath)), policies));
      requireRun(isDeepStrictEqual(verifyMain(await read("/branches/main")), main));
      if (!automatic)
        requireRun(
          isDeepStrictEqual(verifyApprovals(await read(`${runPath}/approvals`)), approvals),
        );
      requireRun(isDeepStrictEqual(verifyRun(await read(runPath)), firstRun));
      requireRun(isDeepStrictEqual(verifyRepository(await read("")), currentRepository));
      const at = tick(),
        elapsed = performance.now() - physicalStarted;
      requireRun(at - origin < maxAge && elapsed < maxAge);
      const proof = Object.freeze({}) as InfrastructureBaselineRunProof;
      proofs.set(proof, {
        request: expected,
        clock: tick,
        last: at,
        expires: origin + maxAge,
        physicalExpires: physicalStarted + maxAge,
        fenced: false,
        checking: false,
      });
      assertInfrastructureBaselineRunProof(proof, expected);
      return proof;
    } catch {
      fenced = true;
      throw new Error("invalid-infrastructure-baseline-run");
    }
  }
}
/** Only the native parser can mint branded proofs; caller-supplied JSON/Boolean never grants reuse. */
export function createInfrastructureBaselineRunVerifier(
  configuration: Configuration,
  dependencies: Dependencies = {},
): VerifyInfrastructureBaselineRun {
  try {
    const reader = new BaselineReader(configuration, dependencies);
    return reader.verify.bind(reader);
  } catch {
    throw new Error("invalid-infrastructure-baseline-run");
  }
}

/** Primary API2026-03-10 GET contracts:
 * https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run
 * https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
 * https://docs.github.com/en/rest/deployments/environments#get-an-environment
 * https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies
 * https://docs.github.com/en/rest/branches/branches#get-a-branch
 * These APIs expose execution/gate data, never dispatch inputs or private baseline digests.
 */
