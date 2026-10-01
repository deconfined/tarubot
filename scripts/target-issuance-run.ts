/**
 * Fixed native GET-only evidence for the proposed v2 projection/sealing graph. These pins
 * are declarations until separately reviewed workflow integration. GitHub execution and
 * check-run/time evidence do not attest private authorship or the token-requesting process.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { GitHubReader, GitHubReadResponse } from "./trust-run.js";
import {
  captureTargetIssuance,
  targetIssuancePins,
  targetIssuanceResponse,
  targetIssuanceStatement,
  type TargetIssuanceStatementV2,
} from "./target-issuance.js";

type Value = Record<string, unknown>;
const api = "https://api.github.com";
const prefix = "/repos/deconfined/tarubot";
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const age = 30_000;
const issuerBudget = 600_000;
function requireRun(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-issuance-run");
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
declare const runBrand: unique symbol;
export type TargetIssuanceRunProof = Readonly<{ [runBrand]: true }>;
interface ProofState {
  statement: TargetIssuanceStatementV2;
  seal: { started: number; completed: number };
  clock: () => number;
  last: number;
  wall: number;
  physical: number;
  fenced: boolean;
  checking: boolean;
}
const proofs = new WeakMap<TargetIssuanceRunProof, ProofState>();
/** Parsed times stay inside the native capability. Caller timestamps cannot create evidence. */
export function assertTargetIssuanceRunProof(
  value: unknown,
  expected: TargetIssuanceStatementV2,
  signedIat?: number,
): void {
  let saved: ProofState | undefined;
  let reserved = false;
  try {
    requireRun(value !== null && typeof value === "object");
    saved = proofs.get(value as TargetIssuanceRunProof);
    requireRun(saved && !saved.fenced && !saved.checking);
    // Caller snapshot traps and clocks may catch a nested denial. Reserve first and
    // retain that permanent fence throughout this assertion's own reservation.
    saved.checking = true;
    reserved = true;
    const statement = targetIssuanceStatement(expected);
    requireRun(!saved.fenced && saved.checking && isDeepStrictEqual(saved.statement, statement));
    const at = saved.clock();
    integer(at);
    requireRun(
      !saved.fenced &&
        saved.checking &&
        at >= saved.last &&
        at < saved.wall &&
        performance.now() < saved.physical,
    );
    if (signedIat !== undefined) {
      integer(signedIat);
      requireRun(
        signedIat >= statement.issued_at - 1000 &&
          signedIat < statement.issued_at + 30_000 &&
          signedIat >= saved.seal.started - 1000 &&
          signedIat <= saved.seal.completed + 1000 &&
          statement.valid_until <= signedIat + 86_400_000,
      );
    }
    saved.last = at;
  } catch {
    if (saved) saved.fenced = true;
    throw new Error("invalid-target-issuance-run");
  } finally {
    if (reserved && saved) saved.checking = false;
  }
}
/** Fixed repository origin/path. No inherited proxy, redirects, retry or external URL argument. */
const directGet: GitHubReader = (input) =>
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
      reject(new Error("invalid-target-issuance-run"));
      return;
    }
    const agent = new Agent({ keepAlive: false }),
      chunks: Buffer[] = [];
    let size = 0,
      ended = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      agent.destroy();
      if (response) accept(response);
      else reject(new Error("invalid-target-issuance-run"));
    };
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
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const key = response.rawHeaders[index]?.toLowerCase(),
              value = response.rawHeaders[index + 1];
            if (key === undefined || value === undefined) {
              finish();
              return;
            }
            headers[key] = Object.hasOwn(headers, key) ? `${headers[key]},${value}` : value;
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
export interface TargetIssuanceRunConfiguration {
  owner_id: number;
  repository_id: number;
  environment_id: number;
  token: string;
}
export type ReadTargetIssuanceRun = (
  statement: TargetIssuanceStatementV2,
) => Promise<TargetIssuanceRunProof>;
class Reader {
  readonly #config: TargetIssuanceRunConfiguration;
  readonly #get: GitHubReader;
  readonly #clock: () => number;
  constructor(
    configuration: TargetIssuanceRunConfiguration,
    dependencies: { get?: GitHubReader; now?: () => number },
  ) {
    const c = object(captureTargetIssuance(configuration));
    requireRun(
      isDeepStrictEqual(
        Object.keys(c).sort(),
        ["owner_id", "repository_id", "environment_id", "token"].sort(),
      ),
    );
    for (const key of ["owner_id", "repository_id", "environment_id"]) integer(c[key]);
    requireRun(typeof c.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(c.token));
    this.#config = c as unknown as TargetIssuanceRunConfiguration;
    const get = dependencies.get ?? directGet,
      clock = dependencies.now ?? Date.now;
    requireRun(typeof get === "function" && typeof clock === "function");
    this.#get = get;
    this.#clock = clock;
    Object.freeze(this);
  }
  async read(input: TargetIssuanceStatementV2): Promise<TargetIssuanceRunProof> {
    try {
      const s = targetIssuanceStatement(input);
      requireRun(
        s.issuer.repository_owner_id === this.#config.owner_id &&
          s.issuer.repository_id === this.#config.repository_id,
      );
      const physical = performance.now(),
        started = this.#clock();
      integer(started);
      let last = started;
      const wall = Math.min(started + age, s.valid_until),
        physicalExpiry = physical + wall - started;
      const tick = () => {
        const at = this.#clock();
        integer(at);
        requireRun(
          at >= last && at >= s.issued_at && at < wall && performance.now() < physicalExpiry,
        );
        last = at;
        return at;
      };
      const read = async (path: string) => {
        const url = `${api}${prefix}${path}`,
          remaining = Math.min(10_000, wall - tick(), physicalExpiry - performance.now());
        requireRun(remaining > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            Promise.resolve().then(() => {
              // Scheduling is not authorization: deny again at the actual GET offer.
              tick();
              return this.#get({
                url,
                method: "GET",
                redirect: "error",
                timeout_ms: remaining,
                body_limit: maxBody,
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2026-03-10",
                  "Accept-Encoding": "identity",
                  "Cache-Control": "no-cache",
                  "User-Agent": "TaruBot-target-issuance-run-v2",
                  Authorization: `Bearer ${this.#config.token}`,
                },
              });
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("invalid-target-issuance-run")), remaining);
            }),
          ]);
          tick();
          const result = targetIssuanceResponse(response, url);
          tick();
          return result;
        } finally {
          clearTimeout(timer);
        }
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
      const release = s.content_receipt.release,
        runPath = `/actions/runs/${release.publication_run}`,
        runUrl = `${api}${prefix}${runPath}`;
      let publicationCompleted = false;
      const run = (value: unknown) => {
        const r = object(value);
        requireRun(
          r.id === Number(release.publication_run) &&
            r.head_sha === release.commit &&
            r.head_branch === "main" &&
            r.event === "push" &&
            r.run_attempt === 1 &&
            r.url === runUrl &&
            ((r.status === "in_progress" && r.conclusion === null) ||
              (r.status === "completed" && r.conclusion === "success")),
        );
        requireRun(!publicationCompleted || r.status === "completed");
        publicationCompleted ||= r.status === "completed";
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
          end = time(job.completed_at);
        requireRun(start <= end && end <= tick());
        return { started: start, completed: end };
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
            j.status === "completed" &&
            j.conclusion === "success",
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
        identity:
          | TargetIssuanceStatementV2["source"]["plan"]
          | NonNullable<TargetIssuanceStatementV2["source"]["apply"]>,
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
        const seal = verifyStep(job, s.issuer.critical_step, "success");
        requireRun(seal);
        requireRun(
          job.bounds.completed - job.bounds.started <= issuerBudget &&
            seal.completed - seal.started <= issuerBudget &&
            s.content_receipt.issued_at >= seal.started - 1000 &&
            s.content_receipt.issued_at <= seal.completed + 1000 &&
            s.issued_at >= seal.started - 1000 &&
            s.issued_at <= seal.completed + 1000,
        );
        return { id: job.job.id, check: checkRun(job.job.check_run_url), bounds: job.bounds, seal };
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
      const proof = Object.freeze({}) as TargetIssuanceRunProof;
      proofs.set(proof, {
        statement: s,
        seal: firstJobs.issuer.seal,
        clock: this.#clock,
        last,
        wall,
        physical: physicalExpiry,
        fenced: false,
        checking: false,
      });
      assertTargetIssuanceRunProof(proof, s);
      return proof;
    } catch {
      throw new Error("invalid-target-issuance-run");
    }
  }
}
export function createTargetIssuanceRunReader(
  configuration: TargetIssuanceRunConfiguration,
  dependencies: { get?: GitHubReader; now?: () => number } = {},
): ReadTargetIssuanceRun {
  try {
    const reader = new Reader(configuration, dependencies);
    return reader.read.bind(reader);
  } catch {
    throw new Error("invalid-target-issuance-run");
  }
}
