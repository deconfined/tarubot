/** Native live Seal evidence. Public execution proves no private candidate authorship; protected
 * reviewed projection origin, private artifact transfer and owner provisioned keys remain prerequisites. */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  assertInfrastructureBaselineRunProof,
  createInfrastructureBaselineRunVerifier,
  type InfrastructureBaselineRunProof,
} from "./infra-baseline-run.js";
import {
  targetCandidateDeclaration,
  type TargetCandidateContext,
  type TargetCandidateDeclaration,
} from "./target-candidate.js";
import type { GitHubReadRequest, GitHubReadResponse } from "./trust-run.js";
import {
  captureTargetIssuance,
  targetIssuancePins,
  targetIssuanceResponse,
  type TargetIssuanceStatementV2,
} from "./target-issuance.js";
const nativeThen = Promise.prototype.then;
/** Drain native rejected promises solely to keep refusal diagnostics private; never await them. */
function drainRejectedPromise(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Non-native promises and ordinary values grant no authority. */
  }
}
type Value = Record<string, unknown>;
const api = "https://api.github.com",
  prefix = "/repos/deconfined/tarubot",
  maxBody = 1_048_576,
  maxHeaders = 16_384,
  age = 30_000,
  issuerBudget = 600_000;
function requireRun(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-issuer-run");
}
function object(value: unknown): Value {
  requireRun(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function list(value: unknown): unknown[] {
  requireRun(Array.isArray(value));
  return value;
}
function integer(value: unknown): asserts value is number {
  requireRun(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function time(value: unknown): number {
  requireRun(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
  );
  const at = Date.parse(value);
  integer(at);
  requireRun(
    new Date(at).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z")),
  );
  return at;
}
export interface CurrentTargetIssuerConfiguration {
  target: "staging" | "production";
  owner_id: number;
  repository_id: number;
  environment_id: number;
  token: string;
}
export interface CurrentTargetIssuerRequest {
  candidate: TargetCandidateDeclaration;
  expected: TargetCandidateContext;
}
export type CurrentReader = (
  input: GitHubReadRequest & { beforeRead: () => void },
) => Promise<GitHubReadResponse>;
declare const currentBrand: unique symbol;
export type CurrentTargetIssuerProof = Readonly<{ [currentBrand]: true }>;
interface Evidence {
  candidate: TargetCandidateDeclaration;
  source: TargetIssuanceStatementV2["source"];
  issuer: TargetIssuanceStatementV2["issuer"];
  seal_started_at: number;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface ProofState {
  evidence: Readonly<Evidence>;
  baseline: InfrastructureBaselineRunProof;
  operation: () => number;
  remaining: () => number;
  fence: () => void;
  checking: boolean;
  phase: "ready" | "minting" | "finished" | "fenced";
}
const proofs = new WeakMap<CurrentTargetIssuerProof, ProofState>();
function active(saved: ProofState): boolean {
  return saved.phase !== "fenced";
}
export function fenceCurrentTargetIssuerProof(value: CurrentTargetIssuerProof): void {
  const saved = proofs.get(value);
  if (saved) {
    saved.phase = "fenced";
    saved.fence();
  }
}
/** Saved baseline assertions retain the original proof; this never refreshes any reader clock. */
export function assertCurrentTargetIssuerProof(value: CurrentTargetIssuerProof): void {
  const saved = proofs.get(value);
  let owned = false;
  try {
    requireRun(saved && saved.phase !== "fenced" && !saved.checking);
    saved.checking = true;
    owned = true;
    saved.operation();
    requireRun(active(saved) && saved.checking);
  } catch {
    if (saved) fenceCurrentTargetIssuerProof(value);
    throw new Error("invalid-target-issuer-run");
  } finally {
    if (saved && owned) saved.checking = false;
  }
}
/** Deadline-wrap unresolved work without a renewed proof; late continuations retain this fence. */
export async function withinCurrentTargetIssuerProof<T>(
  value: CurrentTargetIssuerProof,
  work: () => Promise<T>,
): Promise<T> {
  const saved = proofs.get(value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertCurrentTargetIssuerProof(value);
    requireRun(saved && typeof work === "function");
    const remaining = saved.remaining();
    requireRun(remaining > 0);
    const result = await Promise.race([
      Promise.resolve().then(() => {
        assertCurrentTargetIssuerProof(value);
        return work();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          fenceCurrentTargetIssuerProof(value);
          reject(new Error("invalid-target-issuer-run"));
        }, remaining);
      }),
    ]);
    assertCurrentTargetIssuerProof(value);
    return result;
  } catch {
    if (saved) fenceCurrentTargetIssuerProof(value);
    throw new Error("invalid-target-issuer-run");
  } finally {
    clearTimeout(timer);
  }
}
/** Internal native bridge: a declaration alone has no entry and cannot reserve a mint. */
export function reserveCurrentTargetIssuerMint(
  value: CurrentTargetIssuerProof,
): Readonly<Evidence> {
  const saved = proofs.get(value);
  try {
    requireRun(saved && saved.phase === "ready" && !saved.checking);
    saved.phase = "minting";
    assertCurrentTargetIssuerProof(value);
    return saved.evidence;
  } catch {
    if (saved) fenceCurrentTargetIssuerProof(value);
    throw new Error("invalid-target-issuer-run");
  }
}
export function finishCurrentTargetIssuerMint(value: CurrentTargetIssuerProof): void {
  const saved = proofs.get(value);
  try {
    requireRun(saved?.phase === "minting");
    assertCurrentTargetIssuerProof(value);
    saved.phase = "finished";
  } catch {
    if (saved) fenceCurrentTargetIssuerProof(value);
    throw new Error("invalid-target-issuer-run");
  }
}
/** Only read-only minimized immutable data escapes; this is not a JSON proof constructor. */
export function currentTargetIssuerEvidence(value: CurrentTargetIssuerProof): Readonly<Evidence> {
  assertCurrentTargetIssuerProof(value);
  const saved = proofs.get(value);
  requireRun(saved);
  return saved.evidence;
}
const directGet: CurrentReader = (input) =>
  new Promise((accept, reject) => {
    let agent: Agent | undefined,
      req: ReturnType<typeof httpsRequest> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      ended = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (response?: GitHubReadResponse) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      agent?.destroy();
      if (response) accept(response);
      else {
        req?.destroy();
        reject(new Error("invalid-target-issuer-run"));
      }
    };
    const guard = () => {
      try {
        input.beforeRead();
        requireRun(!ended);
      } catch {
        finish();
        throw new Error("invalid-target-issuer-run");
      }
    };
    try {
      guard();
      const url = new URL(input.url);
      requireRun(
        input.method === "GET" &&
          url.origin === api &&
          (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) &&
          url.protocol === "https:" &&
          !url.port &&
          !url.username &&
          !url.password &&
          !url.hash,
      );
      agent = new Agent({ keepAlive: false });
      const options = {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: maxHeaders,
      };
      guard();
      req = httpsRequest(options, (response) => {
        try {
          guard();
        } catch {
          response.destroy();
          return;
        }
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          try {
            guard();
            size += chunk.length;
            requireRun(size <= input.body_limit);
            guard();
            chunks.push(Buffer.from(chunk));
            guard();
          } catch {
            finish();
            response.destroy();
          }
        });
        response.on("end", () => {
          try {
            guard();
            requireRun(response.complete);
            const headers: Record<string, string> = Object.create(null);
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              guard();
              const key = response.rawHeaders[index]?.toLowerCase(),
                value = response.rawHeaders[index + 1];
              requireRun(key !== undefined && value !== undefined);
              headers[key] = Object.hasOwn(headers, key) ? `${headers[key]},${value}` : value;
            }
            guard();
            const body = Buffer.concat(chunks);
            guard();
            finish({ status: response.statusCode ?? 0, url: input.url, headers, body });
          } catch {
            finish();
          }
        });
      });
      req.on("error", () => finish());
      timer = setTimeout(() => finish(), input.timeout_ms);
      guard();
      req.end();
    } catch {
      finish();
    }
  });
class Reader {
  #config!: CurrentTargetIssuerConfiguration;
  #get!: CurrentReader;
  #clock!: () => number;
  #custom = false;
  #phase: "ready" | "reading" | "finished" | "fenced" = "ready";
  #activeProof: CurrentTargetIssuerProof | undefined;
  readonly #configuration: CurrentTargetIssuerConfiguration;
  readonly #dependencies: { get?: CurrentReader; now?: () => number };
  constructor(
    configuration: CurrentTargetIssuerConfiguration,
    dependencies: { get?: CurrentReader; now?: () => number },
  ) {
    // Capturing caller data waits until physical time and a one-use phase have been reserved.
    this.#configuration = configuration;
    this.#dependencies = dependencies;
    Object.freeze(this);
  }
  #available(): boolean {
    return this.#phase === "reading" || this.#phase === "finished";
  }
  async read(
    input: CurrentTargetIssuerRequest,
    denial?: () => void,
  ): Promise<CurrentTargetIssuerProof> {
    const physicalStart = performance.now();
    let fenced = false,
      checking = false;
    let current: CurrentTargetIssuerProof | undefined;
    try {
      requireRun(this.#phase === "ready");
      this.#phase = "reading";
      const captureGuard = () => {
        requireRun(this.#phase === "reading" && performance.now() < physicalStart + age);
      };
      captureGuard();
      const c = object(captureTargetIssuance(this.#configuration));
      requireRun(
        isDeepStrictEqual(
          Object.keys(c).sort(),
          ["target", "owner_id", "repository_id", "environment_id", "token"].sort(),
        ),
      );
      for (const key of ["owner_id", "repository_id", "environment_id"]) integer(c[key]);
      requireRun(typeof c.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(c.token));
      requireRun(c.target === "staging" || c.target === "production");
      this.#config = c as unknown as CurrentTargetIssuerConfiguration;
      captureGuard();
      const suppliedGet = this.#dependencies.get;
      captureGuard();
      const get = suppliedGet ?? directGet,
        clock = this.#dependencies.now ?? Date.now;
      captureGuard();
      requireRun(typeof get === "function" && typeof clock === "function");
      this.#get = get;
      this.#clock = clock;
      this.#custom = suppliedGet !== undefined;
      captureGuard();
      requireRun(denial === undefined || typeof denial === "function");
      const refuse = denial ?? (() => {});
      let last = 0,
        wall = Infinity,
        physicalExpiry = physicalStart + age;
      const operation = () => {
        let owned = false;
        try {
          requireRun(!fenced && this.#available() && !checking);
          checking = true;
          owned = true;
          const refusal = refuse();
          if (refusal !== undefined) {
            fenced = true;
            drainRejectedPromise(refusal);
          }
          requireRun(refusal === undefined);
          requireRun(!fenced && this.#available());
          const at = this.#clock();
          if (typeof at !== "number") {
            fenced = true;
            drainRejectedPromise(at);
          }
          const afterClock = refuse();
          if (afterClock !== undefined) {
            fenced = true;
            drainRejectedPromise(afterClock);
          }
          requireRun(afterClock === undefined);
          integer(at);
          requireRun(
            !fenced &&
              this.#available() &&
              at >= last &&
              at < wall &&
              performance.now() < physicalExpiry,
          );
          last = at;
          return at;
        } catch {
          fenced = true;
          throw new Error("invalid-target-issuer-run");
        } finally {
          if (owned) checking = false;
        }
      };
      const started = operation();
      const request = object(captureTargetIssuance(input));
      requireRun(isDeepStrictEqual(Object.keys(request).sort(), ["candidate", "expected"]));
      const candidate = targetCandidateDeclaration(
        request.candidate,
        request.expected as TargetCandidateContext,
      );
      requireRun(candidate.target === this.#config.target && candidate.issued_at <= started);
      wall = Math.min(started + age, candidate.expires_at);
      physicalExpiry = physicalStart + Math.min(age, candidate.expires_at - started);
      operation();
      // Baseline denial checks only this original operation: it must never recurse into the
      // combined current proof, whose assertion in turn asserts this same baseline proof.
      const verifyBaseline = createInfrastructureBaselineRunVerifier(
        {
          owner_id: this.#config.owner_id,
          repository_id: this.#config.repository_id,
          token: this.#config.token,
        },
        {
          ...(this.#custom
            ? {
                get: (offered: GitHubReadRequest) => {
                  operation();
                  return this.#get({
                    ...offered,
                    beforeRead: () => {
                      operation();
                    },
                  });
                },
              }
            : {}),
          now: this.#clock,
        },
      );
      operation();
      const baselineRemaining = Math.min(wall - operation(), physicalExpiry - performance.now());
      requireRun(baselineRemaining > 0);
      let baselineTimer: ReturnType<typeof setTimeout> | undefined;
      let baseline: InfrastructureBaselineRunProof;
      try {
        baseline = await Promise.race([
          Promise.resolve().then(() => {
            operation();
            return verifyBaseline(candidate.baseline_writer, () => {
              operation();
            });
          }),
          new Promise<never>((_, reject) => {
            baselineTimer = setTimeout(() => {
              fenced = true;
              reject(new Error("invalid-target-issuer-run"));
            }, baselineRemaining);
          }),
        ]);
      } finally {
        clearTimeout(baselineTimer);
      }
      operation();
      const tick = () => {
        operation();
        assertInfrastructureBaselineRunProof(baseline, candidate.baseline_writer);
        return operation();
      };
      const read = async (path: string) => {
        const url = `${api}${prefix}${path}`;
        const remaining = Math.min(10_000, wall - tick(), physicalExpiry - performance.now());
        requireRun(remaining > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            Promise.resolve().then(() => {
              tick();
              const offered = {
                url,
                method: "GET" as const,
                redirect: "error" as const,
                timeout_ms: remaining,
                body_limit: maxBody as 1048576,
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2026-03-10",
                  "Accept-Encoding": "identity",
                  "Cache-Control": "no-cache",
                  "User-Agent": "TaruBot-target-issuer-run-v2",
                  Authorization: `Bearer ${this.#config.token}`,
                },
                beforeRead: () => {
                  tick();
                },
              };
              tick();
              return this.#get(offered);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                fenced = true;
                reject(new Error("invalid-target-issuer-run"));
              }, remaining);
            }),
          ]);
          tick();
          const result = targetIssuanceResponse(response, url);
          tick();
          return result;
        } catch {
          fenced = true;
          throw new Error("invalid-target-issuer-run");
        } finally {
          clearTimeout(timer);
        }
      };
      const release = candidate.release;
      const initialPage = object(
        await read(`/actions/runs/${release.publication_run}/attempts/1/jobs?per_page=100&page=1`),
      );
      const initialRows = list(initialPage.jobs).map(object);
      requireRun(initialRows.length <= 100 && initialPage.total_count === initialRows.length);
      const selected = (path: string) => {
        const rows = initialRows.filter((row) => row.name === path);
        requireRun(rows.length === 1 && rows[0]);
        return rows[0];
      };
      const identity = (path: string, primary: string) => {
        const job = selected(path),
          steps = list(job.steps).map(object);
        const critical = steps.filter((step) => step.name === primary),
          projection = steps.filter((step) => step.name === targetIssuancePins.projection);
        requireRun(
          critical.length === 1 &&
            critical[0] &&
            (path === targetIssuancePins.issuer || (projection.length === 1 && projection[0])),
        );
        const url = job.check_run_url;
        requireRun(
          typeof url === "string" &&
            /^https:\/\/api\.github\.com\/repos\/deconfined\/tarubot\/check-runs\/[1-9][0-9]{0,15}$/u.test(
              url,
            ),
        );
        const check = Number(url.slice(url.lastIndexOf("/") + 1));
        integer(check);
        integer(job.id);
        integer(critical[0].number);
        if (path !== targetIssuancePins.issuer) {
          integer(projection[0]?.number);
          requireRun(Number(critical[0].number) < Number(projection[0]?.number));
        }
        return {
          job_id: job.id,
          check_run_id: check,
          critical_step: { name: primary, number: critical[0].number },
          projection_step: {
            name: targetIssuancePins.projection,
            number: Number(projection[0]?.number ?? 0),
          },
        };
      };
      const live = identity(targetIssuancePins.issuer, targetIssuancePins.sealing);
      const s = {
        content_receipt: candidate,
        source: {
          plan: identity(targetIssuancePins.plan, "Plan and require automatic policy"),
          apply:
            candidate.mode === "apply"
              ? identity(targetIssuancePins.apply, "Recheck policy and apply exact saved plan")
              : null,
        },
        issuer: {
          repository_owner_id: this.#config.owner_id,
          repository_id: this.#config.repository_id,
          job_path: targetIssuancePins.issuer,
          job_id: live.job_id,
          check_run_id: live.check_run_id,
          critical_step: live.critical_step,
        },
      };
      const owner = (value: unknown) => {
        const o = object(value);
        requireRun(o.id === this.#config.owner_id && o.login === "deconfined");
      };
      const repository = (value: unknown) => {
        const r = object(value);
        requireRun(
          r.id === this.#config.repository_id &&
            r.full_name === targetIssuancePins.repository &&
            r.fork === false,
        );
        owner(r.owner);
        return { id: r.id, name: r.full_name, fork: r.fork, owner: r.owner };
      };
      const runPath = `/actions/runs/${release.publication_run}`,
        runUrl = `${api}${prefix}${runPath}`;

      const run = (value: unknown) => {
        const r = object(value);
        requireRun(
          r.id === Number(release.publication_run) &&
            r.head_sha === release.commit &&
            r.head_branch === "main" &&
            r.event === "push" &&
            r.run_attempt === 1 &&
            r.url === runUrl &&
            r.status === "in_progress" &&
            r.conclusion === null,
        );

        requireRun(
          [
            ".github/workflows/publish.yml",
            ".github/workflows/publish.yml@main",
            ".github/workflows/publish.yml@refs/heads/main",
            "deconfined/tarubot/.github/workflows/publish.yml@main",
            targetIssuancePins.publication,
          ].includes(r.path as string),
        );
        repository(r.repository);
        repository(r.head_repository);
        const refs = list(r.referenced_workflows).map(object);
        requireRun(refs.length <= 50 && new Set(refs.map((ref) => ref.path)).size === refs.length);
        const bindings = ["release", "release-infra"].map((name) => {
          const stem = `deconfined/tarubot/.github/workflows/${name}.yml@`,
            chosen = refs.filter(
              (ref) => typeof ref.path === "string" && ref.path.startsWith(stem),
            );
          requireRun(chosen.length === 1);
          const ref = chosen[0];
          requireRun(
            ref &&
              [`${stem}main`, `${stem}refs/heads/main`].includes(ref.path as string) &&
              ref.ref === "refs/heads/main" &&
              ref.sha === release.config_commit,
          );
          return { path: `${stem}refs/heads/main`, sha: ref.sha, ref: ref.ref };
        });
        return { id: r.id, commit: r.head_sha, bindings };
      };
      const main = (value: unknown) => {
        const m = object(value);
        requireRun(
          m.name === "main" && m.protected === true && object(m.commit).sha === release.commit,
        );
        return m;
      };
      const gatePath = "/environments/target-seal",
        policiesPath = `${gatePath}/deployment-branch-policies?per_page=100&page=1`;
      const gate = (value: unknown) => {
        const g = object(value),
          p = object(g.deployment_branch_policy),
          rules = list(g.protection_rules).map(object);
        requireRun(
          g.id === this.#config.environment_id &&
            g.name === targetIssuancePins.environment &&
            g.url === `${api}${prefix}${gatePath}` &&
            p.protected_branches === false &&
            p.custom_branch_policies === true &&
            rules.length <= 100 &&
            !rules.some((rule) => rule.type === "required_reviewers"),
        );
        // This automatic issuer gate supplies no separate owner-deployment approval claim.
        return g;
      };
      const policies = (value: unknown) => {
        const p = object(value),
          rows = list(p.branch_policies).map(object);
        requireRun(
          p.total_count === 1 &&
            rows.length === 1 &&
            rows[0]?.name === "main" &&
            rows[0]?.type === "branch",
        );
        integer(rows[0]?.id);
        return p;
      };
      const jobBounds = (job: Value) => {
        const start = time(job.started_at),
          end = job.name === targetIssuancePins.issuer ? tick() : time(job.completed_at);
        requireRun(start <= end && end <= tick());
        return { started: start, completed: job.name === targetIssuancePins.issuer ? 0 : end };
      };
      const checkRun = (value: unknown): number => {
        requireRun(typeof value === "string");
        const stem = `${api}${prefix}/check-runs/`;
        requireRun(value.startsWith(stem));
        const text = value.slice(stem.length);
        requireRun(/^[1-9][0-9]{0,15}$/u.test(text));
        const id = Number(text);
        integer(id);
        requireRun(String(id) === text && value === `${stem}${id}`);
        return id;
      };
      const verifyJob = (
        value: unknown,
        path: string,
        identity: { job_id: number; check_run_id: number },
      ) => {
        const j = object(value);
        requireRun(
          j.id === identity.job_id &&
            j.name === path &&
            j.run_id === Number(release.publication_run) &&
            j.run_attempt === 1 &&
            j.head_sha === release.commit &&
            j.head_branch === "main" &&
            j.run_url === runUrl &&
            j.url === `${api}${prefix}/actions/jobs/${j.id}` &&
            checkRun(j.check_run_url) === identity.check_run_id &&
            (path === targetIssuancePins.issuer
              ? j.status === "in_progress" && j.conclusion === null && j.completed_at === null
              : j.status === "completed" && j.conclusion === "success"),
        );
        const bounds = jobBounds(j),
          steps = list(j.steps).map(object);
        requireRun(steps.length > 0 && steps.length <= 1000);
        for (const step of steps) integer(step.number);
        requireRun(new Set(steps.map((step) => step.number)).size === steps.length);
        return { job: j, bounds, steps };
      };
      const verifyStep = (
        job: ReturnType<typeof verifyJob>,
        identity: { name: string; number: number },
        conclusion: "success" | "skipped",
      ) => {
        const found = job.steps.filter((step) => step.name === identity.name);
        requireRun(found.length === 1);
        const step = found[0];
        requireRun(
          step &&
            step.number === identity.number &&
            step.status === "completed" &&
            step.conclusion === conclusion,
        );
        if (conclusion === "skipped") return null;
        const start = time(step.started_at),
          end = time(step.completed_at);
        requireRun(start <= end && start >= job.bounds.started && end <= job.bounds.completed);
        return { started: start, completed: end };
      };
      const verifySource = (
        job: ReturnType<typeof verifyJob>,
        identity: {
          job_id: number;
          check_run_id: number;
          critical_step: { name: string; number: number };
          projection_step: { name: string; number: number };
        },
        project: boolean,
      ) => {
        const primary = verifyStep(job, identity.critical_step, "success"),
          projection = verifyStep(job, identity.projection_step, project ? "success" : "skipped");
        requireRun(primary);
        if (project) requireRun(projection && primary.completed <= projection.started);
        return {
          id: job.job.id,
          check: checkRun(job.job.check_run_url),
          bounds: job.bounds,
          primary,
          projection,
        };
      };
      const issuer = (job: ReturnType<typeof verifyJob>) => {
        const matches = job.steps.filter((step) => step.name === targetIssuancePins.sealing);
        requireRun(matches.length === 1 && matches[0]);
        const seal = matches[0],
          started = time(seal.started_at);
        requireRun(
          seal.number === s.issuer.critical_step.number &&
            seal.status === "in_progress" &&
            seal.conclusion === null &&
            seal.completed_at === null &&
            started >= job.bounds.started &&
            started <= tick() &&
            tick() - job.bounds.started < issuerBudget,
        );
        for (const step of job.steps) {
          requireRun(
            Number(step.number) <= Number(seal.number)
              ? step === seal ||
                  (step.status === "completed" &&
                    (step.conclusion === "success" || step.conclusion === "skipped"))
              : step.status === "pending" && step.conclusion === null,
          );
        }
        return {
          id: job.job.id,
          check: checkRun(job.job.check_run_url),
          bounds: job.bounds,
          seal: { started },
        };
      };
      const jobsPath = `${runPath}/attempts/1/jobs?per_page=100&page=1`;
      const skippedApply = (value: unknown) => {
        const j = object(value);
        integer(j.id);
        requireRun(
          j.name === targetIssuancePins.apply &&
            j.run_id === Number(release.publication_run) &&
            j.run_attempt === 1 &&
            j.head_sha === release.commit &&
            j.head_branch === "main" &&
            j.run_url === runUrl &&
            j.url === `${api}${prefix}/actions/jobs/${j.id}` &&
            j.status === "completed" &&
            j.conclusion === "skipped",
        );
        const steps = list(j.steps).map(object);
        requireRun(steps.length <= 1000);
        for (const step of steps) {
          integer(step.number);
          requireRun(
            typeof step.name === "string" &&
              step.status === "completed" &&
              step.conclusion === "skipped",
          );
        }
        requireRun(new Set(steps.map((step) => step.number)).size === steps.length);
        return {
          id: j.id,
          check: checkRun(j.check_run_url),
          name: j.name,
          run: j.run_id,
          attempt: j.run_attempt,
          head: j.head_sha,
          branch: j.head_branch,
          url: j.url,
          run_url: j.run_url,
          status: j.status,
          conclusion: j.conclusion,
          started_at: j.started_at ?? null,
          completed_at: j.completed_at ?? null,
          steps,
        };
      };
      const jobs = (value: unknown) => {
        const page = object(value),
          rows = list(page.jobs).map(object);
        requireRun(rows.length <= 100 && page.total_count === rows.length);
        for (const row of rows) integer(row.id);
        requireRun(new Set(rows.map((row) => row.id)).size === rows.length);
        const select = (path: string) => {
          const selected = rows.filter((row) => row.name === path);
          requireRun(selected.length === 1 && selected[0]);
          return selected[0];
        };
        const plan = verifySource(
          verifyJob(select(targetIssuancePins.plan), targetIssuancePins.plan, s.source.plan),
          s.source.plan,
          s.content_receipt.mode === "no-changes",
        );
        let apply: ReturnType<typeof verifySource> | null = null;
        if (s.source.apply !== null)
          apply = verifySource(
            verifyJob(select(targetIssuancePins.apply), targetIssuancePins.apply, s.source.apply),
            s.source.apply,
            true,
          );
        const skipped =
          s.source.apply === null ? skippedApply(select(targetIssuancePins.apply)) : null;
        const sealed = issuer(
          verifyJob(select(targetIssuancePins.issuer), targetIssuancePins.issuer, s.issuer),
        );
        requireRun(
          plan.bounds.completed <= (apply?.bounds.started ?? sealed.bounds.started) &&
            (apply?.bounds.completed ?? plan.bounds.completed) <= sealed.bounds.started,
        );
        const checks = [plan.check, sealed.check, apply?.check ?? skipped?.check];
        requireRun(new Set(checks).size === checks.length);
        return {
          ids: rows.map((row) => row.id).sort((a, b) => Number(a) - Number(b)),
          plan,
          apply,
          skipped,
          issuer: sealed,
        };
      };
      const firstRepo = repository(await read("")),
        firstRun = run(await read(runPath)),
        firstMain = main(await read("/branches/main")),
        firstGate = gate(await read(gatePath)),
        firstPolicies = policies(await read(policiesPath)),
        firstJobs = jobs(await read(jobsPath));
      const direct = async () => {
        const plan = verifySource(
          verifyJob(
            await read(`/actions/jobs/${s.source.plan.job_id}`),
            targetIssuancePins.plan,
            s.source.plan,
          ),
          s.source.plan,
          s.content_receipt.mode === "no-changes",
        );
        requireRun(isDeepStrictEqual(plan, firstJobs.plan));
        if (s.source.apply !== null)
          requireRun(
            isDeepStrictEqual(
              verifySource(
                verifyJob(
                  await read(`/actions/jobs/${s.source.apply.job_id}`),
                  targetIssuancePins.apply,
                  s.source.apply,
                ),
                s.source.apply,
                true,
              ),
              firstJobs.apply,
            ),
          );
        if (firstJobs.skipped !== null)
          requireRun(
            isDeepStrictEqual(
              skippedApply(await read(`/actions/jobs/${firstJobs.skipped.id}`)),
              firstJobs.skipped,
            ),
          );
        requireRun(
          isDeepStrictEqual(
            issuer(
              verifyJob(
                await read(`/actions/jobs/${s.issuer.job_id}`),
                targetIssuancePins.issuer,
                s.issuer,
              ),
            ),
            firstJobs.issuer,
          ),
        );
      };
      await direct();
      // No response or clock check stamps a fresh lifetime. Every exact identity is reopened.
      requireRun(isDeepStrictEqual(jobs(await read(jobsPath)), firstJobs));
      await direct();
      requireRun(isDeepStrictEqual(gate(await read(gatePath)), firstGate));
      requireRun(isDeepStrictEqual(policies(await read(policiesPath)), firstPolicies));
      requireRun(isDeepStrictEqual(main(await read("/branches/main")), firstMain));
      requireRun(isDeepStrictEqual(run(await read(runPath)), firstRun));
      requireRun(isDeepStrictEqual(repository(await read("")), firstRepo));
      tick();
      const source = candidate.mode === "apply" ? firstJobs.apply : firstJobs.plan;
      requireRun(
        source &&
          candidate.issued_at >= source.primary.started - 1000 &&
          candidate.issued_at <= source.primary.completed + 1000,
      );
      current = Object.freeze({}) as CurrentTargetIssuerProof;
      const evidence = freeze({
        candidate,
        source: s.source as TargetIssuanceStatementV2["source"],
        issuer: s.issuer as TargetIssuanceStatementV2["issuer"],
        seal_started_at: firstJobs.issuer.seal.started,
      });
      proofs.set(current, {
        evidence,
        baseline,
        operation: tick,
        remaining: () => Math.min(wall - tick(), physicalExpiry - performance.now()),
        fence: () => {
          fenced = true;
        },
        checking: false,
        phase: "ready",
      });
      this.#activeProof = current;
      this.#phase = "finished";
      assertCurrentTargetIssuerProof(current);
      return current;
    } catch {
      fenced = true;
      this.#phase = "fenced";
      if (this.#activeProof) fenceCurrentTargetIssuerProof(this.#activeProof);
      if (current) fenceCurrentTargetIssuerProof(current);
      throw new Error("invalid-target-issuer-run");
    }
  }
}
export function createCurrentTargetIssuerReader(
  configuration: CurrentTargetIssuerConfiguration,
  dependencies: { get?: CurrentReader; now?: () => number } = {},
): (request: CurrentTargetIssuerRequest, denial?: () => void) => Promise<CurrentTargetIssuerProof> {
  try {
    const reader = new Reader(configuration, dependencies);
    return reader.read.bind(reader);
  } catch {
    throw new Error("invalid-target-issuer-run");
  }
}
