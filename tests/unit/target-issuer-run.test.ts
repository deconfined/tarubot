/** Invented REST passes both real native readers; no JSON/Boolean proof echo is injected. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertCurrentTargetIssuerProof,
  createCurrentTargetIssuerReader,
  currentTargetIssuerEvidence,
  reserveCurrentTargetIssuerMint,
  type CurrentReader,
  type CurrentTargetIssuerProof,
} from "../../scripts/target-issuer-run.js";
import {
  openEncryptedTargetCandidate,
  sealPendingTargetCandidate,
  targetCandidateFileName,
} from "../../scripts/target-candidate.js";
import { targetIssuancePins as pins } from "../../scripts/target-issuance.js";
import {
  candidateProducer,
  candidateRelease,
  nativeTargetFixture,
} from "../fixtures/infra/applied-target.js";
import { baselineRunFixture } from "../fixtures/infra/baseline-run.js";
const scratch: string[] = [];
export function cleanupLiveIssuerFixtures(): void {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
  scratch.length = 0;
}
afterAll(cleanupLiveIssuerFixtures);
const api = "https://api.github.com/repos/deconfined/tarubot";
export const candidatePassphrase = "invented-original-candidate-dedicated-key-123456789";
/** Shared within the six-file milestone: ciphertext is produced only from a real24 native cap. */
export async function liveIssuerFixture(
  mode: "apply" | "no-changes" = "no-changes",
  lifetime = 86_400_000,
) {
  const native = await nativeTargetFixture();
  const ticket = mode === "apply" ? await native.begin() : null;
  const preparation = native.prepare(native.clock.now + lifetime);
  const caps = ticket
    ? await native.journal.finishTargetCandidates(ticket, preparation, native.evidence(mode))
    : await native.journal.inspectTargetCandidates(preparation, {
        expected_snapshot: native.snapshot,
        ...native.evidence(mode),
      });
  const directory = mkdtempSync(join(tmpdir(), "private-current-issuer-test-"));
  scratch.push(directory);
  chmodSync(directory, 0o700);
  const pending = caps[0];
  if (!pending) throw new Error("missing-invented-pending");
  await sealPendingTargetCandidate(pending, {
    directory,
    candidate_passphrase: candidatePassphrase,
  });
  const file = join(directory, targetCandidateFileName("staging"));
  const expected = {
    target: "staging" as const,
    release: candidateRelease,
    producer: candidateProducer,
    mode,
  };
  const candidate = openEncryptedTargetCandidate({
    bytes: readFileSync(file),
    candidate_passphrase: candidatePassphrase,
    expected,
  });
  const old = baselineRunFixture(candidate.baseline_writer, { automatic: mode === "apply" });
  const clock = { now: candidate.issued_at + 2000 };
  const owner = { id: old.configuration.owner_id, login: "deconfined" };
  const repository = {
    id: old.configuration.repository_id,
    full_name: pins.repository,
    fork: false,
    owner,
  };
  const release = candidate.release,
    runUrl = `${api}/actions/runs/${release.publication_run}`;
  const iso = (value: number) => new Date(value).toISOString();
  const at = candidate.issued_at;
  const step = (
    name: string,
    number: number,
    start: number,
    end: number,
    conclusion = "success",
  ) => ({
    name,
    number,
    status: "completed",
    conclusion,
    started_at: conclusion === "success" ? iso(start) : null,
    completed_at: conclusion === "success" ? iso(end) : null,
  });
  const job = (
    id: number,
    name: string,
    start: number,
    end: number,
    steps: ReturnType<typeof step>[],
  ) => ({
    id,
    name,
    run_id: Number(release.publication_run),
    run_attempt: 1,
    head_sha: release.commit,
    head_branch: "main",
    run_url: runUrl,
    url: `${api}/actions/jobs/${id}`,
    check_run_url: `${api}/check-runs/${id + 1000}`,
    status: "completed",
    conclusion: "success" as string | null,
    started_at: iso(start),
    completed_at: iso(end) as string | null,
    steps,
  });
  const plan = job(101, pins.plan, at - 20_000, mode === "apply" ? at - 10_000 : at + 500, [
    step("Plan and require automatic policy", 1, at - 15_000, mode === "apply" ? at - 12_000 : at),
    step(pins.projection, 2, at + 1, at + 100, mode === "apply" ? "skipped" : "success"),
  ]);
  const apply = job(102, pins.apply, at - 9000, at + 500, [
    step("Recheck policy and apply exact saved plan", 1, at - 8000, at),
    step(pins.projection, 2, at + 1, at + 100),
  ]);
  if (mode === "no-changes") {
    apply.conclusion = "skipped";
    apply.steps = [];
  }
  const seal = job(103, pins.issuer, at + 1000, at + 2000, [
    step(pins.sealing, 1, at + 1100, at + 2000),
  ]);
  seal.status = "in_progress";
  seal.conclusion = null;
  seal.completed_at = null;
  const sealing = seal.steps[0];
  if (!sealing) throw new Error("missing-invented-seal");
  sealing.status = "in_progress";
  sealing.conclusion = null as unknown as string;
  sealing.completed_at = null;
  const jobs = { total_count: 3, jobs: [plan, apply, seal] };
  const run = {
    id: Number(release.publication_run),
    head_sha: release.commit,
    head_branch: "main",
    event: "push",
    run_attempt: 1,
    url: runUrl,
    status: "in_progress",
    conclusion: null as string | null,
    path: ".github/workflows/publish.yml",
    repository,
    head_repository: repository,
    referenced_workflows: ["release", "release-infra"].map((name) => ({
      path: `deconfined/tarubot/.github/workflows/${name}.yml@refs/heads/main`,
      ref: "refs/heads/main",
      sha: release.config_commit,
    })),
  };
  const configuration = {
    target: "staging" as const,
    owner_id: owner.id,
    repository_id: repository.id,
    environment_id: 345678,
    token: "invented_current_issuer_read_token_12345",
  };
  const gate = {
    id: configuration.environment_id,
    name: "target-seal",
    url: `${api}/environments/target-seal`,
    protection_rules: [] as unknown[],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const policies = { total_count: 1, branch_policies: [{ id: 11, name: "main", type: "branch" }] };
  const data: Record<string, unknown> = {
    ...old.data,
    [api]: repository,
    [runUrl]: run,
    [`${api}/branches/main`]: { name: "main", protected: true, commit: { sha: release.commit } },
    [`${runUrl}/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [gate.url]: gate,
    [`${gate.url}/deployment-branch-policies?per_page=100&page=1`]: policies,
  };
  for (const entry of jobs.jobs) data[entry.url] = entry;
  const seen: string[] = [];
  let hook: ((url: string) => void) | undefined;
  const get: CurrentReader = async (request) => {
    request.beforeRead();
    seen.push(request.url);
    hook?.(request.url);
    if (!Object.hasOwn(data, request.url)) throw new Error("unexpected-invented-url");
    return {
      status: 200,
      url: request.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(data[request.url])),
    };
  };
  const read = createCurrentTargetIssuerReader(configuration, { get, now: () => clock.now });
  return {
    native,
    candidate,
    file,
    expected,
    old,
    clock,
    data,
    seen,
    get,
    read,
    configuration,
    plan,
    apply,
    seal,
    run,
    gate,
    policies,
    hook: (value: typeof hook) => {
      hook = value;
    },
    request: { candidate, expected },
  };
}
describe("native current target issuer", () => {
  test("both modes require original writer and final source while exact Seal remains in progress", async () => {
    for (const mode of ["no-changes", "apply"] as const) {
      const f = await liveIssuerFixture(mode),
        proof = await f.read(f.request);
      assertCurrentTargetIssuerProof(proof);
      const evidence = currentTargetIssuerEvidence(proof);
      expect(evidence.candidate.baseline_writer).toEqual(f.candidate.baseline_writer);
      expect(evidence.issuer.check_run_id).toBe(1103);
      expect(evidence.source.apply !== null).toBe(mode === "apply");
      expect(f.seen.filter((url) => url === f.apply.url).length).toBe(2);
      expect(Object.isFrozen(evidence.source.plan.critical_step)).toBe(true);
      expect(() =>
        assertCurrentTargetIssuerProof({ ...proof } as CurrentTargetIssuerProof),
      ).toThrow("invalid-target-issuer-run");
    }
  });
  test("failed old writer, source, current Seal, skipped contradiction and changed reopen deny", async () => {
    for (const mutate of [
      (f: Awaited<ReturnType<typeof liveIssuerFixture>>) => {
        f.old.apply.conclusion = "failure";
      },
      (f: Awaited<ReturnType<typeof liveIssuerFixture>>) => {
        const projection = f.plan.steps[1];
        if (!projection) throw new Error("missing-invented-projection");
        projection.conclusion = "failure";
      },
      (f: Awaited<ReturnType<typeof liveIssuerFixture>>) => {
        f.seal.status = "completed";
        f.seal.conclusion = "success";
      },
      (f: Awaited<ReturnType<typeof liveIssuerFixture>>) => {
        f.apply.conclusion = "success";
      },
      (f: Awaited<ReturnType<typeof liveIssuerFixture>>) => {
        let n = 0;
        f.hook((url) => {
          if (url === f.plan.url && ++n === 2) f.plan.check_run_url = `${api}/check-runs/9999`;
        });
      },
    ]) {
      const f = await liveIssuerFixture();
      mutate(f);
      await expect(f.read(f.request)).rejects.toThrow("invalid-target-issuer-run");
    }
  });
  test("false and asynchronous refusal callbacks deny before authority GET", async () => {
    for (const refusal of [
      () => false,
      () => Promise.resolve(),
      () => Promise.reject(new Error("invented-private-refusal")),
    ]) {
      const f = await liveIssuerFixture();
      await expect(f.read(f.request, refusal as unknown as () => void)).rejects.toThrow(
        "invalid-target-issuer-run",
      );
      expect(f.seen).toHaveLength(0);
    }
  });
  test("old proof expiry stops all later GETs and cannot be refreshed", async () => {
    const f = await liveIssuerFixture();
    f.hook(() => {
      f.clock.now += 30_000;
    });
    await expect(f.read(f.request)).rejects.toThrow("invalid-target-issuer-run");
    expect(f.seen).toHaveLength(1);
    const next = await liveIssuerFixture(),
      proof = await next.read(next.request);
    next.clock.now += 30_000;
    expect(() => assertCurrentTargetIssuerProof(proof)).toThrow("invalid-target-issuer-run");
    next.clock.now -= 30_000;
    expect(() => reserveCurrentTargetIssuerMint(proof)).toThrow("invalid-target-issuer-run");
  });
  test("first clock cost belongs to original physical window", async () => {
    const f = await liveIssuerFixture("no-changes", 2100);
    const read = createCurrentTargetIssuerReader(f.configuration, {
      get: f.get,
      now: () => {
        const until = performance.now() + 120;
        while (performance.now() < until) {}
        return f.clock.now;
      },
    });
    await expect(read(f.request)).rejects.toThrow("invalid-target-issuer-run");
    expect(f.seen).toHaveLength(0);
  });
  test("held initial baseline refuses at original expiry and offers no continuation GET", async () => {
    const f = await liveIssuerFixture("no-changes", 2200);
    let offered = 0;
    const read = createCurrentTargetIssuerReader(f.configuration, {
      now: () => f.clock.now,
      get: async (input) => {
        offered++;
        await new Promise((resolve) => setTimeout(resolve, 350));
        return f.get(input);
      },
    });
    const started = performance.now();
    await expect(read(f.request)).rejects.toThrow("invalid-target-issuer-run");
    expect(performance.now() - started).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(offered).toBe(1);
    expect(f.seen).toHaveLength(0);
  });
  test("a repeated reader call permanently fences its retained proof", async () => {
    const f = await liveIssuerFixture(),
      proof = await f.read(f.request);
    const offers = f.seen.length;
    await expect(f.read(f.request)).rejects.toThrow("invalid-target-issuer-run");
    expect(f.seen).toHaveLength(offers);
    expect(() => assertCurrentTargetIssuerProof(proof)).toThrow("invalid-target-issuer-run");
  });
});
