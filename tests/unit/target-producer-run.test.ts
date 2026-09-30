/** Invented GitHub/private sealing evidence only; no API, workflow, credential or host operation. */
import { describe, expect, test } from "bun:test";
import {
  appliedTargetJobPaths,
  readAppliedTargetProducerJob,
  type AppliedTargetSealingRequest,
  type AuthenticatedAppliedTargetSealing,
  type VerifyAppliedTargetSealing,
} from "../../scripts/target-producer-run.js";
import type { AppliedTargetJobRequest } from "../../scripts/target-handoff.js";
import type {
  GitHubReader,
  GitHubReadRequest,
  GitHubReadResponse,
} from "../../scripts/trust-run.js";

const api = "https://api.github.com/repos/deconfined/tarubot";
const instant = 1_800_000_000_000;
const owner = { login: "deconfined", id: 123456 };
type Value = Record<string, unknown>;
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}
function object(value: unknown): Value {
  if (!value || typeof value !== "object") throw new Error("missing-invented-object");
  return value as Value;
}
function fixture(mode: "apply" | "no-changes" = "no-changes") {
  const release = {
    version: "2.36.12",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "12345",
    schema_head: "001_schema.sql",
  };
  const producer = {
    repository: "deconfined/tarubot" as const,
    workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" as const,
    ref: "refs/heads/main" as const,
    event: "push" as const,
    attempt: 1 as const,
    commit: release.commit,
    run: release.publication_run,
  };
  const request: AppliedTargetJobRequest = {
    receipt: {
      schema: 1,
      purpose: "tarubot-applied-target-handoff-v1",
      target: "staging",
      backend: "c".repeat(64),
      release,
      producer,
      mode,
      path: `applied-target/staging/12345/${release.commit}/${"d".repeat(64)}`,
      payload_digest: "d".repeat(64),
      ciphertext_digest: "e".repeat(64),
      issued_at: instant - 1000,
      expires_at: instant + 3_599_000,
    },
    job: {
      workflow_ref: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
      workflow_commit: release.config_commit,
      job_name: mode === "apply" ? "Apply infrastructure" : "Plan infrastructure",
      critical_step: "Seal applied target descriptor",
    },
    requested_at: instant,
  };
  const run = {
    id: 12345,
    head_sha: release.commit,
    head_branch: "main",
    event: "push",
    run_attempt: 1,
    status: "in_progress",
    conclusion: null as string | null,
    path: ".github/workflows/publish.yml",
    // Push actors need not be the repository owner; protected private writer authentication is separate.
    actor: { login: "invented-contributor", id: 987654 },
    triggering_actor: owner,
    repository: { full_name: "deconfined/tarubot", fork: false, owner },
    head_repository: { full_name: "deconfined/tarubot", fork: false, owner },
    url: `${api}/actions/runs/12345`,
    referenced_workflows: [
      {
        path: "deconfined/tarubot/.github/workflows/release.yml@main",
        ref: "refs/heads/main",
        sha: release.config_commit,
      },
      {
        path: "deconfined/tarubot/.github/workflows/release-infra.yml@main",
        ref: "refs/heads/main",
        sha: release.config_commit,
      },
    ],
  };
  const main = { name: "main", protected: true, commit: { sha: release.commit } };
  const job = {
    id: 102,
    run_id: 12345,
    run_attempt: 1,
    head_sha: release.commit,
    head_branch: "main",
    name: String(appliedTargetJobPaths[mode]),
    run_url: run.url,
    url: `${api}/actions/jobs/102`,
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: "Seal applied target descriptor",
        number: 3,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  const jobs = { total_count: 1, jobs: [job] };
  const data: Record<string, unknown> = {
    [`${api}/branches/main`]: main,
    [`${api}/actions/runs/12345`]: run,
    [`${api}/actions/runs/12345/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [`${api}/actions/jobs/102`]: job,
  };
  const seen: GitHubReadRequest[] = [];
  const get: GitHubReader = async (r) => {
    seen.push(structuredClone(r));
    if (!Object.hasOwn(data, r.url)) throw new Error("unexpected-invented-api-path");
    return {
      status: 200,
      url: r.url,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: Buffer.from(JSON.stringify(data[r.url])),
    };
  };
  const sealingSeen: AppliedTargetSealingRequest[] = [];
  const verify: VerifyAppliedTargetSealing = async (r) => {
    sealingSeen.push(structuredClone(r));
    return {
      schema: 1,
      purpose: "tarubot-authenticated-applied-target-sealing-v1",
      ...structuredClone(r),
      authenticated_at: instant,
      expires_at: instant + 30_000,
    };
  };
  const invoke = (overrides: Partial<Parameters<typeof readAppliedTargetProducerJob>[1]> = {}) =>
    readAppliedTargetProducerJob(request, {
      owner_id: owner.id,
      get,
      verifySealingReceipt: verify,
      now: () => instant,
      ...overrides,
    });
  return { request, run, main, jobs, job, data, seen, get, verify, sealingSeen, invoke };
}
async function refusal(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toThrow("invalid-target-producer-evidence");
}

describe("exact private applied-target producer job", () => {
  test("both modes require successful exact nested JOB and private receipt while publication awaits staging", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const f = fixture(mode);
      const proof = await f.invoke();
      expect(Object.keys(proof).sort()).toEqual(
        [
          "schema",
          "purpose",
          "receipt",
          "producer",
          "head_commit",
          "workflow_ref",
          "workflow_commit",
          "job_name",
          "job_id",
          "status",
          "conclusion",
          "critical_step",
          "observed_at",
          "expires_at",
        ].sort(),
      );
      expect(proof).toEqual({
        schema: 1,
        purpose: "tarubot-applied-target-job-proof-v1",
        receipt: f.request.receipt,
        producer: f.request.receipt.producer,
        head_commit: f.request.receipt.release.commit,
        workflow_ref: f.request.job.workflow_ref,
        workflow_commit: f.request.job.workflow_commit,
        job_name: f.request.job.job_name,
        job_id: 102,
        status: "completed",
        conclusion: "success",
        critical_step: {
          name: "Seal applied target descriptor",
          number: 3,
          status: "completed",
          conclusion: "success",
        },
        observed_at: instant,
        expires_at: instant + 30_000,
      });
      expect(f.run.status).toBe("in_progress");
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.receipt.release)).toBe(true);
      expect(Object.isFrozen(proof.critical_step)).toBe(true);
      expect(f.sealingSeen).toHaveLength(1);
      expect(f.sealingSeen[0]?.request).toEqual(f.request);
      expect(f.sealingSeen[0]?.writer).toMatchObject({
        repository_owner_id: owner.id,
        job_path: appliedTargetJobPaths[mode],
        job_id: 102,
        attempt: 1,
        reusable_workflow_commit: f.request.receipt.release.config_commit,
      });
      expect(f.seen).toHaveLength(8);
      expect(
        f.seen.every(
          (r) =>
            r.method === "GET" &&
            r.url.startsWith(`${api}/`) &&
            r.redirect === "error" &&
            r.body_limit === 1048576 &&
            r.timeout_ms === 10000 &&
            r.headers.Authorization === undefined &&
            r.headers["X-GitHub-Api-Version"] === "2026-03-10",
        ),
      ).toBe(true);
      expect(f.seen.filter((r) => r.url.endsWith("/actions/jobs/102"))).toHaveLength(2);
    }
  });
  test("publication may already succeed or progress to success during independent sealing authentication", async () => {
    const completed = fixture();
    completed.run.status = "completed";
    completed.run.conclusion = "success";
    expect((await completed.invoke()).conclusion).toBe("success");
    const progressing = fixture();
    await progressing.invoke({
      verifySealingReceipt: async (r) => {
        progressing.run.status = "completed";
        progressing.run.conclusion = "success";
        return progressing.verify(r);
      },
    });
    expect(progressing.sealingSeen).toHaveLength(1);
    const regressing = fixture();
    regressing.run.status = "completed";
    regressing.run.conclusion = "success";
    await refusal(
      regressing.invoke({
        verifySealingReceipt: async (r) => {
          regressing.run.status = "in_progress";
          regressing.run.conclusion = null;
          return regressing.verify(r);
        },
      }),
    );
  });
  test("invalid request fields/private owner/callback/token fail before any API or sealing read", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => Object.assign(f.request, { url: "https://example.org" }),
      (f) => {
        f.request.receipt.backend = "secret";
      },
      (f) => {
        f.request.receipt.path += "/other";
      },
      (f) => {
        f.request.receipt.payload_digest = "bad";
      },
      (f) => {
        f.request.receipt.ciphertext_digest = "bad";
      },
      (f) => Object.assign(f.request.receipt.producer, { event: "workflow_dispatch" }),
      (f) => Object.assign(f.request.receipt.producer, { repository: "invented/tarubot" }),
      (f) => Object.assign(f.request.receipt.producer, { attempt: 2 }),
      (f) => Object.assign(f.request.receipt.release, { publication_run: "9007199254740992" }),
      (f) => {
        f.request.receipt.release.config_commit = "f".repeat(40);
      },
      (f) => Object.assign(f.request.job, { job_name: "Apply infrastructure" }),
      (f) => Object.assign(f.request.job, { critical_step: "other" }),
      (f) => {
        f.request.receipt.expires_at = instant;
      },
      (f) => {
        f.request.receipt.issued_at = instant + 1;
      },
      (f) => {
        f.request.receipt.expires_at += 1;
      },
      (f) => {
        f.request.requested_at = instant + 1;
      },
      (f) => {
        f.request.requested_at = instant - 60_001;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await refusal(f.invoke());
      expect(f.seen).toHaveLength(0);
      expect(f.sealingSeen).toHaveLength(0);
    }
    for (const overrides of [
      { owner_id: 0 },
      { owner_id: Number.MAX_SAFE_INTEGER + 1 },
      { token: "Bearer secret\n" },
      { verifySealingReceipt: undefined as unknown as VerifyAppliedTargetSealing },
    ]) {
      const f = fixture();
      await refusal(f.invoke(overrides));
      expect(f.seen).toHaveLength(0);
    }
  });
  test("accessors are refused without execution; entry snapshots survive caller and dependency mutation", async () => {
    const accessor = fixture();
    let invoked = false;
    Object.defineProperty(accessor.request, "receipt", {
      enumerable: true,
      get: () => {
        invoked = true;
        return {};
      },
    });
    await refusal(accessor.invoke());
    expect(invoked).toBe(false);
    expect(accessor.seen).toHaveLength(0);
    const f = fixture();
    const original = structuredClone(f.request);
    const deps = {
      owner_id: owner.id,
      get: f.get,
      verifySealingReceipt: f.verify,
      now: () => instant,
    };
    const pending = readAppliedTargetProducerJob(f.request, deps);
    f.request.receipt.release.commit = "f".repeat(40);
    deps.get = async () => {
      throw new Error("replacement-should-not-run");
    };
    deps.verifySealingReceipt = async () => {
      throw new Error("replacement-should-not-run");
    };
    const proof = await pending;
    expect(proof.receipt).toEqual(original.receipt);
    expect(f.sealingSeen[0]?.request).toEqual(original);
  });
  test("main must stay protected at this exact head and root/head repositories cannot fork or change owner", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.main.protected = false;
      },
      (f) => {
        f.main.name = "other";
      },
      (f) => {
        f.main.commit.sha = "f".repeat(40);
      },
      (f) => {
        f.run.repository.fork = true;
      },
      (f) => {
        f.run.head_repository.fork = true;
      },
      (f) => {
        f.run.head_repository.full_name = "invented/tarubot";
      },
      (f) => Object.assign(f.run.repository, { owner: { ...owner, id: 1 } }),
      (f) => Object.assign(f.run.head_repository, { owner: { ...owner, login: "invented-owner" } }),
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await refusal(f.invoke());
      expect(f.sealingSeen).toHaveLength(0);
    }
  });
  test("failed/unknown/queued/rerun/foreign publication cannot be excused by a successful job", async () => {
    for (const mutation of [
      { id: 12346 },
      { head_sha: "f".repeat(40) },
      { event: "workflow_dispatch" },
      { head_branch: "other" },
      { run_attempt: 2 },
      { path: ".github/workflows/ci.yml" },
      { status: "queued" },
      { status: "waiting" },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "unknown" },
      { status: "in_progress", conclusion: "success" },
      { url: `${api}/actions/runs/12346` },
    ]) {
      const f = fixture();
      Object.assign(f.run, mutation);
      await refusal(f.invoke());
      expect(f.sealingSeen).toHaveLength(0);
    }
  });
  test("both exact reusable workflow references must uniquely match main and config commit", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.run.referenced_workflows.pop();
      },
      (f) => {
        f.run.referenced_workflows.shift();
      },
      (f) => {
        present(f.run.referenced_workflows[1]).sha = "f".repeat(40);
      },
      (f) => {
        present(f.run.referenced_workflows[1]).ref = "refs/tags/main";
      },
      (f) => {
        present(f.run.referenced_workflows[1]).path =
          "invented/tarubot/.github/workflows/release-infra.yml@main";
      },
      (f) => {
        present(f.run.referenced_workflows[1]).path += "-other";
      },
      (f) => {
        f.run.referenced_workflows.push(structuredClone(present(f.run.referenced_workflows[1])));
      },
      (f) => {
        f.run.referenced_workflows.push({
          ...present(f.run.referenced_workflows[1]),
          path: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
        });
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await refusal(f.invoke());
      expect(f.sealingSeen).toHaveLength(0);
    }
    const f = fixture();
    for (const ref of f.run.referenced_workflows)
      ref.path = ref.path.replace("@main", "@refs/heads/main");
    expect((await f.invoke()).workflow_commit).toBe(f.request.job.workflow_commit);
  });
  test("bare/suffix/other-mode names, duplicate jobs, pagination and ambiguous critical steps refuse", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.job.name = "Plan infrastructure";
      },
      (f) => {
        f.job.name = `other / ${appliedTargetJobPaths["no-changes"]}`;
      },
      (f) => {
        f.job.name = appliedTargetJobPaths.apply;
      },
      (f) => {
        f.jobs.jobs.push({ ...f.job, id: 103 });
        f.jobs.total_count++;
      },
      (f) => {
        f.jobs.jobs.push({ ...f.job, name: "other" });
        f.jobs.total_count++;
      },
      (f) => {
        f.jobs.total_count++;
      },
      (f) => {
        f.job.steps = [];
      },
      (f) => {
        f.job.steps.push({ ...present(f.job.steps[0]), number: 4 });
      },
      (f) => {
        f.job.steps.push({ ...present(f.job.steps[0]), name: "other" });
      },
      (f) => {
        present(f.job.steps[0]).number = 0;
      },
      (f) => {
        present(f.job.steps[0]).status = "in_progress";
      },
      (f) => {
        present(f.job.steps[0]).conclusion = "skipped";
      },
      (f) => {
        f.jobs.jobs.push({ ...f.job, id: 103, name: appliedTargetJobPaths.apply });
        f.jobs.total_count++;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await refusal(f.invoke());
      expect(f.sealingSeen).toHaveLength(0);
    }
    const f = fixture();
    f.jobs.jobs.push({
      ...f.job,
      id: 103,
      url: `${api}/actions/jobs/103`,
      name: appliedTargetJobPaths.apply,
      conclusion: "skipped",
      steps: [],
    });
    f.jobs.total_count++;
    expect((await f.invoke()).job_id).toBe(102);
  });
  test("Apply follows a successful Plan whose sealing step skipped, and both modes cannot seal successfully", async () => {
    const f = fixture("apply");
    const plan = {
      ...f.job,
      id: 103,
      url: `${api}/actions/jobs/103`,
      name: appliedTargetJobPaths["no-changes"],
      steps: [{ ...present(f.job.steps[0]), conclusion: "skipped" }],
    };
    f.jobs.jobs.push(plan);
    f.jobs.total_count++;
    expect((await f.invoke()).job_id).toBe(102);
    present(plan.steps[0]).conclusion = "success";
    await refusal(f.invoke());
    present(plan.steps[0]).conclusion = "skipped";
    plan.conclusion = "failure";
    await refusal(f.invoke());
  });
  test("job individual and attempt-list records must bind the same complete first-attempt job", async () => {
    for (const delta of [
      { run_id: 1 },
      { run_attempt: 2 },
      { head_sha: "f".repeat(40) },
      { head_branch: "other" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { run_url: `${api}/actions/runs/1` },
      { url: `${api}/actions/jobs/1` },
      { id: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const f = fixture();
      Object.assign(f.job, delta);
      await refusal(f.invoke());
    }
    const f = fixture();
    f.data[`${api}/actions/jobs/102`] = {
      ...f.job,
      steps: [{ ...present(f.job.steps[0]), number: 4 }],
    };
    await refusal(f.invoke());
    expect(f.sealingSeen).toHaveLength(0);
  });
});

describe("private sealing authentication and bounded direct transport", () => {
  test("GitHub success alone/boolean/echo/foreign receipt or protected writer cannot mint proof", async () => {
    const mutations: Array<(proof: AuthenticatedAppliedTargetSealing) => void> = [
      (p) => {
        p.purpose = "foreign" as AuthenticatedAppliedTargetSealing["purpose"];
      },
      (p) => {
        p.request.receipt.payload_digest = "f".repeat(64);
      },
      (p) => {
        p.request.receipt.ciphertext_digest = "f".repeat(64);
      },
      (p) => {
        p.request.receipt.backend = "f".repeat(64);
      },
      (p) => {
        p.request.receipt.target = "production";
      },
      (p) => {
        p.request.receipt.release.digest = `sha256:${"f".repeat(64)}`;
      },
      (p) => {
        p.request.receipt.path += "other";
      },
      (p) => {
        p.request.receipt.issued_at--;
      },
      (p) => {
        p.request.receipt.expires_at--;
      },
      (p) => {
        p.request.requested_at--;
      },
      (p) => {
        p.writer.repository_owner_id++;
      },
      (p) => {
        p.writer.job_path = "Plan infrastructure";
      },
      (p) => {
        p.writer.job_id++;
      },
      (p) => {
        p.writer.critical_step.number++;
      },
      (p) => {
        p.writer.reusable_workflow_commit = "f".repeat(40);
      },
      (p) => {
        p.writer.run = "12346";
      },
      (p) => {
        p.authenticated_at = instant + 1;
      },
      (p) => {
        p.authenticated_at = instant - 1;
      },
      (p) => {
        p.expires_at = instant;
      },
      (p) => {
        p.expires_at = instant + 30_001;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      await refusal(
        f.invoke({
          verifySealingReceipt: async (r) => {
            const proof = await f.verify(r);
            mutate(proof);
            return proof;
          },
        }),
      );
    }
    for (const value of [true, { authenticated: true }, { request: fixture().request }]) {
      const f = fixture();
      await refusal(
        f.invoke({ verifySealingReceipt: async () => value as AuthenticatedAppliedTargetSealing }),
      );
    }
    const f = fixture();
    await refusal(
      f.invoke({
        verifySealingReceipt: async () => {
          throw new Error("private-secret-do-not-print");
        },
      }),
    );
  });
  test("post-authentication readbacks reject changed main/rerun/failure/job/step/workflow or new job ambiguity", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.main.commit.sha = "f".repeat(40);
      },
      (f) => {
        f.main.protected = false;
      },
      (f) => {
        f.run.run_attempt = 2;
      },
      (f) => {
        f.run.status = "completed";
        f.run.conclusion = "failure";
      },
      (f) => {
        f.job.conclusion = "cancelled";
      },
      (f) => {
        present(f.job.steps[0]).number = 4;
      },
      (f) => {
        present(f.run.referenced_workflows[1]).sha = "f".repeat(40);
      },
      (f) => {
        f.jobs.jobs.push({ ...f.job, id: 103 });
        f.jobs.total_count++;
      },
      (f) => {
        f.jobs.jobs.push({ ...f.job, id: 103, name: "other" });
        f.jobs.total_count++;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      await refusal(
        f.invoke({
          verifySealingReceipt: async (r) => {
            const proof = await f.verify(r);
            mutate(f);
            return proof;
          },
        }),
      );
      expect(f.sealingSeen).toHaveLength(1);
    }
    const f = fixture();
    await refusal(
      f.invoke({
        verifySealingReceipt: async (r) => {
          const proof = await f.verify(r);
          // An untrusted callback cannot mutate pinned internal receipt through its input copy.
          r.request.receipt.payload_digest = "f".repeat(64);
          proof.request = r.request;
          return proof;
        },
      }),
    );
  });
  test("redirects/pagination/ambiguous JSON headers/invalid UTF8/truncation/oversize and duplicate JSON keys refuse", async () => {
    const corruptions: Array<(response: GitHubReadResponse) => void> = [
      (r) => {
        r.status = 302;
      },
      (r) => {
        r.url += "?other";
      },
      (r) => {
        r.headers.location = "https://example.org";
      },
      (r) => {
        r.headers.link = '<https://example.org>; rel="next"';
      },
      (r) => {
        r.headers["content-encoding"] = "gzip";
      },
      (r) => {
        r.headers["Content-Type"] = "application/json";
      },
      (r) => {
        r.headers["content-type"] = "application/json,application/json";
      },
      (r) => {
        r.headers["content-type"] = "application/json;charset=utf-8,application/json;charset=utf-8";
      },
      (r) => {
        r.headers["content-type"] = "text/plain";
      },
      (r) => {
        r.headers["content-type"] = "application/json;charset=latin-1";
      },
      (r) => {
        r.headers["content-length"] = String(r.body.length + 1);
      },
      (r) => {
        r.headers["x-extra"] = "x".repeat(16_384);
      },
      (r) => {
        r.headers["x-extra"] = "line\r\nother";
      },
      (r) => {
        r.body = Buffer.from([0xff]);
      },
      (r) => {
        r.body = Buffer.from("{}").subarray(0, 1);
      },
      (r) => {
        r.body = Buffer.alloc(1_048_577);
      },
      (r) => {
        r.body = Buffer.from(
          '{"name":"foreign","name":"main","protected":true,"commit":{"sha":"' +
            "a".repeat(40) +
            '"}}',
        );
      },
      (r) => {
        r.body = Buffer.from(
          '{"name":"foreign","\\u006eame":"main","protected":true,"commit":{"sha":"' +
            "a".repeat(40) +
            '"}}',
        );
      },
    ];
    for (const corrupt of corruptions) {
      const f = fixture();
      await refusal(
        f.invoke({
          get: async (r) => {
            const response = await f.get(r);
            corrupt(response);
            return response;
          },
        }),
      );
      expect(f.sealingSeen).toHaveLength(0);
    }
    const f = fixture();
    await refusal(
      f.invoke({
        get: async () => {
          throw new Error("private-token-do-not-print");
        },
      }),
    );
  });
  test("clock rollback, late GET/callback and expired authentication stop after each await", async () => {
    for (const phase of ["get", "callback", "final"] as const) {
      const f = fixture();
      let clock = instant;
      await refusal(
        f.invoke({
          now: () => clock,
          get: async (r) => {
            const response = await f.get(r);
            if (phase === "get") clock = instant + 60_001;
            if (phase === "final" && f.sealingSeen.length > 0) clock = instant + 30_000;
            return response;
          },
          verifySealingReceipt: async (r) => {
            const proof = await f.verify(r);
            if (phase === "callback") clock = instant - 1;
            return proof;
          },
        }),
      );
    }
  });
  test("oldest final-round observation bounds proof and physical authentication expiry survives a frozen wall clock", async () => {
    const f = fixture();
    let clock = instant;
    const proof = await f.invoke({
      now: () => clock,
      get: async (r) => {
        const response = await f.get(r);
        if (f.sealingSeen.length > 0) clock += 1000;
        return response;
      },
    });
    expect(proof.observed_at).toBe(instant + 1000);
    expect(clock).toBe(instant + 4000);
    expect(proof.expires_at).toBe(instant + 30_000);
    const expired = fixture();
    await refusal(
      expired.invoke({
        verifySealingReceipt: async (r) => ({
          ...(await expired.verify(r)),
          expires_at: instant + 10,
        }),
        get: async (r) => {
          const response = await expired.get(r);
          if (expired.sealingSeen.length > 0) await Bun.sleep(15);
          return response;
        },
      }),
    );
    expect(expired.sealingSeen).toHaveLength(1);
  });
  test("real timers bound an unresolved GET or sealing capability even when injected clock stands still", async () => {
    for (const phase of ["get", "callback"] as const) {
      const f = fixture();
      f.request.receipt.expires_at = instant + 10;
      await refusal(
        f.invoke(
          phase === "get"
            ? { get: async () => new Promise<never>(() => {}) }
            : { verifySealingReceipt: async () => new Promise<never>(() => {}) },
        ),
      );
    }
  });
  test("explicit token stays in fixed GET headers; returned proof and callback inputs do not expose it", async () => {
    const f = fixture();
    const token = "invented_private_read_token_12345";
    const proof = await f.invoke({ token });
    expect(
      f.seen.every((r) => r.headers.Authorization === `Bearer ${token}` && !r.url.includes(token)),
    ).toBe(true);
    expect(JSON.stringify(proof)).not.toContain(token);
    expect(JSON.stringify(f.sealingSeen)).not.toContain(token);
    expect(object(proof).token).toBeUndefined();
  });
});
