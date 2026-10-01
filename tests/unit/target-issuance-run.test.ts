/** Real native parser/opaque timing tests use invented public REST evidence only. */
import { describe, expect, test } from "bun:test";
import {
  createTargetIssuanceRunReader,
  qualifyTargetIssuanceRunProof,
  inspectQualifiedTargetIssuanceRunData,
  type QualifiedTargetIssuanceRunData,
  assertTargetIssuanceRunProof,
  type TargetIssuanceRunProof,
} from "../../scripts/target-issuance-run.js";
import {
  targetIssuancePins as pins,
  type TargetIssuanceStatementV2,
} from "../../scripts/target-issuance.js";
import type { GitHubReader, GitHubReadRequest } from "../../scripts/trust-run.js";

const instant = 1_800_000_000_000;
const issued = instant - 600_000;
const api = "https://api.github.com/repos/deconfined/tarubot";
function fixture(mode: "apply" | "no-changes" = "apply") {
  const owner = { id: 123456, login: "deconfined" };
  const repository = { id: 234567, full_name: "deconfined/tarubot", fork: false, owner };
  const release = {
    version: "2.36.22",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "23456",
    schema_head: "010_invented.sql",
  };
  const content = {
    schema: 2 as const,
    purpose: "tarubot-applied-target-content-v2" as const,
    target: "staging" as const,
    backend: "c".repeat(64),
    release,
    producer: {
      repository: "deconfined/tarubot" as const,
      workflow_ref: pins.publication,
      ref: "refs/heads/main" as const,
      event: "push" as const,
      attempt: 1 as const,
      commit: release.commit,
      run: release.publication_run,
    },
    mode,
    path: `applied-target-content-v2/staging/23456/${release.commit}/${"d".repeat(64)}`,
    payload_digest: "d".repeat(64),
    ciphertext_digest: "e".repeat(64),
    issued_at: issued - 1000,
    expires_at: issued - 1000 + 86_400_000,
  };
  const source = {
    plan: {
      job_id: 101,
      check_run_id: 1101,
      critical_step: { name: "Plan and require automatic policy" as const, number: 1 },
      projection_step: { name: pins.projection, number: 2 },
    },
    apply:
      mode === "apply"
        ? {
            job_id: 102,
            check_run_id: 1102,
            critical_step: {
              name: "Recheck policy and apply exact saved plan" as const,
              number: 1,
            },
            projection_step: { name: pins.projection, number: 2 },
          }
        : null,
  };
  const issuer = {
    repository_owner_id: owner.id,
    repository_id: repository.id,
    job_path: pins.issuer,
    job_id: 103,
    check_run_id: 1103,
    critical_step: { name: pins.sealing, number: 1 },
  };
  const statement: TargetIssuanceStatementV2 = {
    schema: 2,
    purpose: "tarubot-applied-target-issuance-v2",
    content_receipt: content,
    source,
    issuer,
    issued_at: issued,
    valid_until: issued + 86_400_000 - 1000,
  };
  const context = { target: content.target, backend: content.backend, release };
  const configuration = {
    owner_id: owner.id,
    repository_id: repository.id,
    environment_id: 345678,
    subject: "repo:deconfined/tarubot:environment:target-seal",
    token: "invented_target_issuance_read_token_12345",
  };
  const runUrl = `${api}/actions/runs/23456`;
  const iso = (at: number) => new Date(at).toISOString();
  const step = (
    name: string,
    number: number,
    start: number,
    end: number,
    conclusion: "success" | "skipped" = "success",
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
    check: number,
    name: string,
    start: number,
    end: number,
    steps: ReturnType<typeof step>[],
  ) => ({
    id,
    name,
    run_id: 23456,
    run_attempt: 1,
    head_sha: release.commit,
    head_branch: "main",
    run_url: runUrl,
    url: `${api}/actions/jobs/${id}`,
    check_run_url: `${api}/check-runs/${check}`,
    status: "completed",
    conclusion: "success",
    started_at: iso(start),
    completed_at: iso(end),
    steps,
  });
  const plan = job(101, 1101, pins.plan, issued - 120_000, issued - 60_000, [
    step(source.plan.critical_step.name, 1, issued - 110_000, issued - 100_000),
    step(
      pins.projection,
      2,
      issued - 90_000,
      issued - 70_000,
      mode === "apply" ? "skipped" : "success",
    ),
  ]);
  const apply = job(102, 1102, pins.apply, issued - 50_000, issued - 10_000, [
    step("Recheck policy and apply exact saved plan", 1, issued - 45_000, issued - 35_000),
    step(pins.projection, 2, issued - 30_000, issued - 15_000),
  ]);
  if (mode === "no-changes") {
    apply.conclusion = "skipped";
    apply.steps = [];
  }
  const seal = job(103, 1103, pins.issuer, issued - 5000, issued + 20_000, [
    step(pins.sealing, 1, issued - 2000, issued + 15_000),
  ]);
  const run = {
    id: 23456,
    head_sha: release.commit,
    head_branch: "main",
    event: "push",
    run_attempt: 1,
    url: runUrl,
    status: "in_progress",
    conclusion: null as string | null,
    path: ".github/workflows/publish.yml",
    repository,
    head_repository: structuredClone(repository),
    referenced_workflows: ["release", "release-infra"].map((name) => ({
      path: `deconfined/tarubot/.github/workflows/${name}.yml@refs/heads/main`,
      ref: "refs/heads/main",
      sha: release.config_commit,
    })),
  };
  const gate = {
    id: configuration.environment_id,
    name: "target-seal",
    url: `${api}/environments/target-seal`,
    protection_rules: [] as unknown[],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const policies = {
    total_count: 1,
    branch_policies: [{ id: 3030, name: "main", type: "branch" }],
  };
  const jobs = { total_count: 3, jobs: [plan, apply, seal] };
  const main = { name: "main", protected: true, commit: { sha: release.commit } };
  const data: Record<string, unknown> = {
    [api]: repository,
    [runUrl]: run,
    [`${runUrl}/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [gate.url]: gate,
    [`${gate.url}/deployment-branch-policies?per_page=100&page=1`]: policies,
    [`${api}/branches/main`]: main,
    [plan.url]: plan,
    [apply.url]: apply,
    [seal.url]: seal,
  };
  const calls: GitHubReadRequest[] = [],
    clock = { now: instant };
  const get: GitHubReader = async (input) => {
    calls.push(structuredClone(input));
    if (!Object.hasOwn(data, input.url)) throw new Error("invented unexpected URL");
    return {
      status: 200,
      url: input.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(data[input.url])),
    };
  };
  return {
    statement,
    context,
    configuration,
    owner,
    repository,
    run,
    gate,
    policies,
    main,
    jobs,
    plan,
    apply,
    seal,
    data,
    get,
    calls,
    clock,
  };
}

function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("missing-invented-fixture");
  return value;
}
function runConfiguration(f: ReturnType<typeof fixture>) {
  return {
    owner_id: f.configuration.owner_id,
    repository_id: f.configuration.repository_id,
    environment_id: f.configuration.environment_id,
    token: f.configuration.token,
  };
}
const failure = "invalid-target-issuance-run";
describe("native historical target issuance execution", () => {
  test("both modes require exact source primary/projection and distinct signed check-run identities", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const f = fixture(mode);
      const proof = await createTargetIssuanceRunReader(runConfiguration(f), {
        get: f.get,
        now: () => f.clock.now,
      })(f.statement);
      expect(() => assertTargetIssuanceRunProof(proof, f.statement, issued + 2000)).not.toThrow();
      expect(JSON.stringify(proof)).toBe("{}");
      expect(Object.keys(proof)).toEqual([]);
      expect(
        f.calls.every(
          (call) =>
            call.method === "GET" &&
            call.redirect === "error" &&
            call.headers.Authorization === `Bearer ${f.configuration.token}`,
        ),
      ).toBe(true);
      expect(f.calls.filter((call) => call.url === api)).toHaveLength(2);
      expect(f.calls.filter((call) => call.url === f.seal.url)).toHaveLength(2);
      expect(f.calls.filter((call) => call.url === f.apply.url)).toHaveLength(2);
    }
  });
  test("job/check-run numbers may coincide across their separate namespaces", async () => {
    const f = fixture();
    f.statement.issuer.check_run_id = f.statement.issuer.job_id;
    f.seal.check_run_url = `${api}/check-runs/${f.seal.id}`;
    const proof = await createTargetIssuanceRunReader(runConfiguration(f), {
      get: f.get,
      now: () => f.clock.now,
    })(f.statement);
    expect(() => assertTargetIssuanceRunProof(proof, f.statement, issued)).not.toThrow();
  });
  test("completed-success publication is allowed; failure, queue, rerun and status regression are refused", async () => {
    for (const mode of ["success", "failure", "queued", "attempt2", "regression"]) {
      const f = fixture();
      if (mode !== "queued") f.run.status = "completed";
      if (mode === "queued") f.run.status = "queued";
      f.run.conclusion = mode === "success" || mode === "regression" ? "success" : "failure";
      if (mode === "attempt2") f.run.run_attempt = 2;
      let runs = 0;
      const read = createTargetIssuanceRunReader(runConfiguration(f), {
        now: () => f.clock.now,
        get: async (input) => {
          if (input.url === f.run.url && ++runs === 2 && mode === "regression") {
            f.run.status = "in_progress";
            f.run.conclusion = null;
          }
          return f.get(input);
        },
      });
      if (mode === "success") {
        const proof = await read(f.statement);
        expect(() => assertTargetIssuanceRunProof(proof, f.statement)).not.toThrow();
      } else await expect(read(f.statement)).rejects.toThrow(failure);
    }
  });
  test("generic successful source jobs, missing/skipped projection, reversed steps and late source completion refuse", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.plan.name = "Plan infrastructure";
      },
      (f) => {
        present(f.apply.steps[1]).name = "Unrelated projection";
      },
      (f) => {
        present(f.apply.steps[1]).conclusion = "skipped";
      },
      (f) => {
        present(f.apply.steps[0]).conclusion = "skipped";
      },
      (f) => {
        present(f.apply.steps[1]).number = 1;
      },
      (f) => {
        present(f.apply.steps[1]).started_at = new Date(issued - 40_000).toISOString();
      },
      (f) => {
        f.apply.completed_at = new Date(issued + 10_000).toISOString();
      },
      (f) => {
        present(f.plan.steps[1]).conclusion = "success";
      },
      (f) => {
        f.seal.name = "Other / Seal target descriptors";
      },
      (f) => {
        present(f.seal.steps[0]).status = "in_progress";
      },
      (f) => {
        f.jobs.jobs.push(structuredClone(f.seal));
        f.jobs.total_count++;
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await expect(
        createTargetIssuanceRunReader(runConfiguration(f), { get: f.get, now: () => f.clock.now })(
          f.statement,
        ),
      ).rejects.toThrow(failure);
    }
    const f = fixture("no-changes");
    f.apply.conclusion = "success";
    await expect(
      createTargetIssuanceRunReader(runConfiguration(f), { get: f.get, now: () => f.clock.now })(
        f.statement,
      ),
    ).rejects.toThrow(failure);
  });
  test("current repository, head, gate, branch policy, source URL/check-run and reusable revision must match independently", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.repository.id++;
      },
      (f) => {
        f.repository.owner.id++;
      },
      (f) => {
        f.run.head_repository.fork = true;
      },
      (f) => {
        f.main.commit.sha = "f".repeat(40);
      },
      (f) => {
        f.main.protected = false;
      },
      (f) => {
        f.gate.id++;
      },
      (f) => {
        f.gate.protection_rules.push({ type: "required_reviewers" });
      },
      (f) => {
        present(f.policies.branch_policies[0]).name = "*";
      },
      (f) => {
        f.plan.check_run_url = `${api}/check-runs/1101?foreign=1`;
      },
      (f) => {
        f.seal.check_run_url = `${api}/check-runs/1102`;
      },
      (f) => {
        f.seal.url = `${api}/actions/jobs/999`;
      },
      (f) => {
        present(f.run.referenced_workflows[1]).sha = "f".repeat(40);
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await expect(
        createTargetIssuanceRunReader(runConfiguration(f), { get: f.get, now: () => f.clock.now })(
          f.statement,
        ),
      ).rejects.toThrow(failure);
    }
  });
  test("one-second terminal precision cannot hide an out-of-step receipt/statement or an oversized issuer job", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        present(f.seal.steps[0]).started_at = new Date(issued + 2000).toISOString();
      },
      (f: ReturnType<typeof fixture>) => {
        f.seal.started_at = new Date(issued - 600_001).toISOString();
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.seal.steps[0]).completed_at = "2026-09-30T00:00:00+00:00";
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.seal.steps[0]).completed_at = "2026-02-30T00:00:00Z";
      },
    ]) {
      const f = fixture();
      change(f);
      await expect(
        createTargetIssuanceRunReader(runConfiguration(f), { get: f.get, now: () => f.clock.now })(
          f.statement,
        ),
      ).rejects.toThrow(failure);
    }
    const f = fixture();
    const proof = await createTargetIssuanceRunReader(runConfiguration(f), {
      get: f.get,
      now: () => f.clock.now,
    })(f.statement);
    expect(() => assertTargetIssuanceRunProof(proof, f.statement, issued + 16_000)).not.toThrow();
    expect(() => assertTargetIssuanceRunProof(proof, f.statement, issued + 16_001)).toThrow(
      failure,
    );
  });
  test("each final identity/time readback is mandatory and cannot renew the initial observation", async () => {
    for (const field of ["repo", "main", "gate", "time", "step", "job"]) {
      const f = fixture();
      let lists = 0;
      const reader = createTargetIssuanceRunReader(runConfiguration(f), {
        now: () => f.clock.now,
        get: async (input) => {
          if (input.url.includes("/attempts/1/jobs") && ++lists === 2) {
            if (field === "repo") f.repository.id++;
            if (field === "main") f.main.commit.sha = "f".repeat(40);
            if (field === "gate") f.gate.id++;
            if (field === "time")
              present(f.seal.steps[0]).completed_at = new Date(issued + 14_000).toISOString();
            if (field === "step") present(f.seal.steps[0]).number++;
            if (field === "job") f.seal.id++;
          }
          return f.get(input);
        },
      });
      await expect(reader(f.statement)).rejects.toThrow(failure);
    }
    const f = fixture();
    const reader = createTargetIssuanceRunReader(runConfiguration(f), {
      now: () => f.clock.now,
      get: async (input) => {
        const result = await f.get(input);
        f.clock.now += 2000;
        return result;
      },
    });
    await expect(reader(f.statement)).rejects.toThrow(failure);
  });
  test("HTTP ambiguity, duplicate JSON/headers, partial data and hostile errors stay fixed", async () => {
    for (const mode of [
      "redirect",
      "mime",
      "duplicate-header",
      "duplicate-json",
      "partial",
      "pagination",
      "compression",
      "error",
      "utf8",
    ]) {
      const f = fixture();
      const reader = createTargetIssuanceRunReader(runConfiguration(f), {
        now: () => f.clock.now,
        get: async (input) => {
          if (mode === "error") throw new Error("invented private token and address");
          const result = await f.get(input);
          if (mode === "redirect") result.status = 302;
          if (mode === "mime") result.headers["content-type"] = "application/json; charset=latin1";
          if (mode === "duplicate-header") result.headers["Content-Type"] = "application/json";
          if (mode === "duplicate-json") result.body = Buffer.from('{"id":1,"\\u0069d":2}');
          if (mode === "partial")
            result.headers["content-length"] = String(result.body.byteLength + 1);
          if (mode === "pagination") result.headers.link = "invented next";
          if (mode === "compression") result.headers["content-encoding"] = "gzip";
          if (mode === "utf8") result.body = Uint8Array.from([0xff]);
          return result;
        },
      });
      await expect(reader(f.statement)).rejects.toThrow(failure);
    }
  });
  test("skipped counterpart must agree with both direct reads and cannot contain executed source steps", async () => {
    for (const mode of ["success", "check", "projection", "second-read"]) {
      const f = fixture("no-changes"),
        direct = structuredClone(f.apply);
      f.data[f.apply.url] = direct;
      if (mode === "success") direct.conclusion = "success";
      if (mode === "check") direct.check_run_url = `${api}/check-runs/999`;
      if (mode === "projection")
        direct.steps = [
          {
            name: pins.projection,
            number: 2,
            status: "completed",
            conclusion: "success",
            started_at: new Date(issued - 30000).toISOString(),
            completed_at: new Date(issued - 15000).toISOString(),
          },
        ];
      let reads = 0;
      const reader = createTargetIssuanceRunReader(runConfiguration(f), {
        now: () => f.clock.now,
        get: async (request) => {
          if (request.url === f.apply.url && ++reads === 2 && mode === "second-read")
            direct.conclusion = "success";
          return f.get(request);
        },
      });
      await expect(reader(f.statement)).rejects.toThrow(failure);
      expect(f.apply.conclusion).toBe("skipped");
      expect(reads).toBe(mode === "second-read" ? 2 : 1);
    }
  });
  test("scheduled GET offers deny after original time changes and observed proof failures never revive", async () => {
    const f = fixture();
    let samples = 0,
      offers = 0;
    const reader = createTargetIssuanceRunReader(runConfiguration(f), {
      now: () => {
        const at = f.clock.now;
        if (++samples === 2)
          queueMicrotask(() => {
            f.clock.now = instant + 30000;
          });
        return at;
      },
      get: async (request) => {
        offers++;
        return f.get(request);
      },
    });
    await expect(reader(f.statement)).rejects.toThrow(failure);
    expect(offers).toBe(0);
    for (const mode of ["expiry", "rollback"]) {
      const g = fixture(),
        proof = await createTargetIssuanceRunReader(runConfiguration(g), {
          get: g.get,
          now: () => g.clock.now,
        })(g.statement);
      g.clock.now = mode === "expiry" ? instant + 30000 : instant - 1;
      expect(() => assertTargetIssuanceRunProof(proof, g.statement)).toThrow(failure);
      g.clock.now = instant;
      expect(() => assertTargetIssuanceRunProof(proof, g.statement)).toThrow(failure);
    }
  });
  test("unresolved response is bounded and accessor/echo/configuration mutation cannot mint timing authority", async () => {
    const f = fixture();
    let calls = 0;
    const read = createTargetIssuanceRunReader(runConfiguration(f), {
      now: () => f.clock.now,
      get: async (input) => {
        if (++calls === 1) {
          const reply = await f.get(input);
          f.clock.now += 29_990;
          return reply;
        }
        return new Promise(() => {});
      },
    });
    await expect(read(f.statement)).rejects.toThrow(failure);
    expect(calls).toBe(2);
    const g = fixture();
    let getters = 0;
    const hostile = Object.defineProperty({ ...g.statement }, "source", {
      enumerable: true,
      get() {
        getters++;
        return g.statement.source;
      },
    });
    await expect(
      createTargetIssuanceRunReader(runConfiguration(g), { get: g.get, now: () => g.clock.now })(
        hostile,
      ),
    ).rejects.toThrow(failure);
    expect(getters).toBe(0);
    const mutable = structuredClone(runConfiguration(g));
    const reader = createTargetIssuanceRunReader(mutable, { get: g.get, now: () => g.clock.now });
    mutable.repository_id++;
    const proof = await reader(g.statement);
    for (const echo of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), true] as unknown[])
      expect(() => assertTargetIssuanceRunProof(echo, g.statement, issued)).toThrow(failure);
    g.clock.now += 30_000;
    expect(() => assertTargetIssuanceRunProof(proof, g.statement)).toThrow(failure);
    expect(() => assertTargetIssuanceRunProof({} as TargetIssuanceRunProof, g.statement)).toThrow(
      failure,
    );
  });
  test("caller snapshot reentry permanently fences the native proof's owning assertion", async () => {
    for (const matching of [false, true]) {
      const f = fixture(),
        proof = await createTargetIssuanceRunReader(runConfiguration(f), {
          get: f.get,
          now: () => f.clock.now,
        })(f.statement);
      expect(() => assertTargetIssuanceRunProof(proof, f.statement)).not.toThrow();
      let enter = true,
        refusals = 0;
      const expected = new Proxy(f.statement, {
        ownKeys(target) {
          if (enter) {
            enter = false;
            const nested = structuredClone(f.statement);
            if (!matching) nested.content_receipt.backend = "f".repeat(64);
            try {
              assertTargetIssuanceRunProof(proof, nested);
            } catch {
              refusals++;
            }
          }
          return Reflect.ownKeys(target);
        },
      });
      expect(() => assertTargetIssuanceRunProof(proof, expected)).toThrow(failure);
      expect(refusals).toBe(1);
      expect(() => assertTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
    }
  });
  test("clock reentry cannot swallow a native proof denial and continue the outer barrier", async () => {
    for (const matching of [false, true]) {
      const f = fixture();
      let proof: unknown,
        enter = false,
        refusals = 0;
      const read = createTargetIssuanceRunReader(runConfiguration(f), {
        get: f.get,
        now: () => {
          if (enter) {
            enter = false;
            const nested = structuredClone(f.statement);
            if (!matching) nested.content_receipt.backend = "f".repeat(64);
            try {
              assertTargetIssuanceRunProof(proof, nested);
            } catch {
              refusals++;
            }
          }
          return f.clock.now;
        },
      });
      proof = await read(f.statement);
      enter = true;
      expect(() => assertTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
      expect(refusals).toBe(1);
      expect(() => assertTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
    }
  });
});

describe("one-way native run history DATA", () => {
  test("retains complete ordered original observations without extra GETs or a live proof", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const f = fixture(mode);
      const read = createTargetIssuanceRunReader(runConfiguration(f), {
        get: f.get,
        now: () => f.clock.now,
      });
      const proof = await read(f.statement);
      const count = f.calls.length;
      const data = qualifyTargetIssuanceRunProof(proof, f.statement, issued + 2000);
      const history = inspectQualifiedTargetIssuanceRunData(data);
      expect(f.calls.length).toBe(count);
      expect(history.observations.length).toBe(count);
      expect(history.observations.map((row) => row.url)).toEqual(f.calls.map((row) => row.url));
      expect(history.observations.map((row) => row.sequence)).toEqual(
        f.calls.map((_, index) => index + 1),
      );
      expect(history.statement).toEqual(f.statement);
      expect(history.seal).toEqual({
        started: Date.parse(present(present(f.seal.steps[0]).started_at)),
        completed: Date.parse(present(present(f.seal.steps[0]).completed_at)),
      });
      expect(history.observation.started_at).toBe(instant);
      const before = JSON.stringify(history);
      present(f.plan.steps[0]).name = "invented later source mutation";
      f.repository.owner.login = "invented later owner";
      expect(JSON.stringify(inspectQualifiedTargetIssuanceRunData(data))).toBe(before);
      expect(Object.isFrozen(history.identities)).toBe(true);
      expect(JSON.stringify(history)).not.toContain(f.configuration.token);
      expect(() => assertTargetIssuanceRunProof(data, f.statement)).toThrow(failure);
      expect(() => assertTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
      expect(() => qualifyTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
      expect(() =>
        inspectQualifiedTargetIssuanceRunData({} as QualifiedTargetIssuanceRunData),
      ).toThrow(failure);
      // Historical DATA inspection has no borrowed proof clock or authority epoch.
      f.clock.now += 86_400_000;
      expect(inspectQualifiedTargetIssuanceRunData(data).statement.valid_until).toBe(
        f.statement.valid_until,
      );
    }
  });
  test("wrong context, swallowed unknown nested qualification, and observed short expiry retire the original", async () => {
    const f = fixture();
    const proof = await createTargetIssuanceRunReader(runConfiguration(f), {
      get: f.get,
      now: () => f.clock.now,
    })(f.statement);
    const hostile = new Proxy(f.statement, {
      ownKeys(target) {
        try {
          qualifyTargetIssuanceRunProof({} as TargetIssuanceRunProof, f.statement);
        } catch {
          /* Deliberately swallowed. */
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => qualifyTargetIssuanceRunProof(proof, hostile)).toThrow(failure);
    expect(() => assertTargetIssuanceRunProof(proof, f.statement)).toThrow(failure);
    const g = fixture();
    const original = await createTargetIssuanceRunReader(runConfiguration(g), {
      get: g.get,
      now: () => g.clock.now,
    })(g.statement);
    g.clock.now += 29_980;
    assertTargetIssuanceRunProof(original, g.statement);
    const end = performance.now() + 60;
    while (performance.now() < end) {
      /* Frozen wall consumes the already observed residual. */
    }
    expect(() => qualifyTargetIssuanceRunProof(original, g.statement)).toThrow(failure);
    expect(g.calls.length).toBe(f.calls.length);
    const h = fixture();
    const cap = await createTargetIssuanceRunReader(runConfiguration(h), {
      get: h.get,
      now: () => h.clock.now,
    })(h.statement);
    expect(() =>
      qualifyTargetIssuanceRunProof(cap, {
        ...h.statement,
        valid_until: h.statement.valid_until - 1,
      }),
    ).toThrow(failure);
    expect(() => assertTargetIssuanceRunProof(cap, h.statement)).toThrow(failure);
  });
});

test("run history retention keeps ordinary large responses and bounds only qualification aggregate", async () => {
  const f = fixture();
  Object.defineProperty(f.main, "invented_extra", { value: "x".repeat(70_000), enumerable: true });
  const proof = await createTargetIssuanceRunReader(runConfiguration(f), {
    get: f.get,
    now: () => f.clock.now,
  })(f.statement);
  const history = inspectQualifiedTargetIssuanceRunData(
    qualifyTargetIssuanceRunProof(proof, f.statement),
  );
  const main = present(history.observations.find((row) => row.url.endsWith("/branches/main")));
  expect(
    (JSON.parse(main.canonical_json) as { invented_extra: string }).invented_extra.length,
  ).toBe(70_000);
  const g = fixture();
  for (const row of [g.gate, g.policies, g.main])
    Object.defineProperty(row, "invented_extra", { value: "y".repeat(800_000), enumerable: true });
  const cap = await createTargetIssuanceRunReader(runConfiguration(g), {
    get: g.get,
    now: () => g.clock.now,
  })(g.statement);
  // Existing 1MiB responses still verify normally; a new oversized handoff is denied.
  expect(() => assertTargetIssuanceRunProof(cap, g.statement)).not.toThrow();
  const count = g.calls.length;
  expect(() => qualifyTargetIssuanceRunProof(cap, g.statement)).toThrow(failure);
  expect(g.calls.length).toBe(count);
  expect(() => assertTargetIssuanceRunProof(cap, g.statement)).toThrow(failure);
});
