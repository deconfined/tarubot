/** Invented GitHub responses only: no API request, owner action or environment configuration. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createTrustEnrollmentRunVerifier,
  readTrustRun,
  type GitHubReadRequest,
  type GitHubReadResponse,
  type GitHubReader,
  type TrustRunRequest,
  type TrustEnrollmentRunProof,
  type TrustEnrollmentRunRequest,
} from "../../scripts/trust-run.js";

const api = "https://api.github.com/repos/deconfined/tarubot";
const instant = 1_800_000_000_000;
const owner = { login: "deconfined", id: 123456 };
// Fixture mutations must fail explicitly if an invented nested record is absent.
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}
function fixture(
  kind: TrustRunRequest["kind"] = "enrollment",
  target: TrustRunRequest["target"] = "staging",
) {
  const request: TrustRunRequest = { kind, target, commit: "a".repeat(40), run: "12345" };
  const workflow = `.github/workflows/${kind === "enrollment" ? "trust-enroll" : "control-recovery"}.yml`;
  const job =
    kind === "enrollment"
      ? `Enroll ${target}`
      : target === "infra"
        ? "Recover infrastructure"
        : `Recover ${target} trust`;
  const environment = `${kind === "enrollment" ? "trust" : "recover"}-${target}`;
  const run = {
    id: 12345,
    head_sha: request.commit,
    head_branch: "main",
    event: "workflow_dispatch",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: workflow,
    actor: owner,
    triggering_actor: owner,
    repository: { id: 200, full_name: "deconfined/tarubot", fork: false, owner },
    head_repository: { id: 200, full_name: "deconfined/tarubot", fork: false, owner },
    url: `${api}/actions/runs/12345`,
  };
  const env = {
    id: 100,
    name: environment,
    url: `${api}/environments/${environment}`,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: owner }],
      },
    ],
  };
  const policies = { total_count: 1, branch_policies: [{ id: 101, name: "main", type: "branch" }] };
  const main = { name: "main", protected: true };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        id: 102,
        run_id: 12345,
        run_attempt: 1,
        head_sha: request.commit,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        name: job,
        url: `${api}/actions/jobs/102`,
        check_run_url: `${api}/check-runs/103`,
        run_url: run.url,
        steps: [
          {
            name:
              kind === "enrollment" ? "Persist completed enrollment" : "Verify restored journal",
            number: 1,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
  };
  const reviews = [
    {
      state: "approved",
      user: owner,
      environments: [{ id: env.id, name: env.name, url: env.url }],
    },
  ];
  const data: Record<string, unknown> = {
    [`${api}/actions/runs/12345`]: run,
    [`${api}/environments/${environment}`]: env,
    [`${api}/environments/${environment}/deployment-branch-policies?per_page=100&page=1`]: policies,
    [`${api}/branches/main`]: main,
    [`${api}/actions/runs/12345/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [`${api}/actions/runs/12345/approvals`]: reviews,
    [`${api}/actions/jobs/102`]: jobs.jobs[0],
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
  return {
    request,
    workflow,
    job,
    environment,
    run,
    env,
    policies,
    main,
    jobs,
    reviews,
    data,
    get,
    seen,
  };
}
async function refusal(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toThrow("invalid-trust-run-evidence");
}

describe("pinned read-only trust workflow success", () => {
  test("missing or malformed private owner IDs refuse before any API read", async () => {
    const f = fixture();
    for (const id of [undefined, null, 0, -1, "123456", Number.MAX_SAFE_INTEGER + 1]) {
      await refusal(
        readTrustRun(f.request, {
          owner_id: id as number,
          get: f.get,
          now: () => instant,
        }),
      );
    }
    expect(f.seen).toHaveLength(0);
  });
  test("each supported scope binds the literal workflow/job/new gate and exact owner approval", async () => {
    for (const [kind, target] of [
      ["enrollment", "staging"],
      ["enrollment", "production"],
      ["recovery", "infra"],
      ["recovery", "staging"],
      ["recovery", "production"],
    ] as const) {
      const f = fixture(kind, target);
      const proof = await readTrustRun(f.request, {
        owner_id: owner.id,
        get: f.get,
        now: () => instant,
      });
      expect(proof).toMatchObject({
        schema: 1,
        workflow: f.workflow,
        target,
        job: f.job,
        environment: f.environment,
        commit: f.request.commit,
        run: f.request.run,
        attempt: 1,
        conclusion: "success",
        reviewer: owner,
      });
      expect(
        f.seen.every(
          (r) =>
            r.method === "GET" &&
            r.url.startsWith(`${api}/`) &&
            r.redirect === "error" &&
            r.timeout_ms === 10000 &&
            r.body_limit === 1048576,
        ),
      ).toBe(true);
      expect(
        f.seen.every(
          (r) =>
            r.headers.Authorization === undefined &&
            r.headers["X-GitHub-Api-Version"] === "2026-03-10",
        ),
      ).toBe(true);
      expect(f.seen.filter((r) => r.url.endsWith("/actions/runs/12345"))).toHaveLength(2);
    }
  });
  test("no caller-selected workflow, gate, repository or arbitrary success job can confer authority", async () => {
    const f = fixture();
    for (const request of [
      { ...f.request, workflow: ".github/workflows/ci.yml" },
      { ...f.request, kind: "other" },
      { ...f.request, target: "infra" },
      { ...f.request, run: "../approvals" },
      { ...f.request, run: "9999999999999999" },
      { ...f.request, commit: "main" },
    ]) {
      await refusal(
        readTrustRun(request as TrustRunRequest, {
          owner_id: owner.id,
          get: f.get,
          now: () => instant,
        }),
      );
      expect(f.seen).toHaveLength(0);
    }
  });
  test("non-owner actors, another repository/ref/commit/workflow and nonfinal first attempts fail", async () => {
    for (const delta of [
      { actor: { ...owner, id: 1 } },
      { triggering_actor: { ...owner, login: "invented-operator" } },
      { head_sha: "b".repeat(40) },
      { head_branch: "feature" },
      { event: "push" },
      { run_attempt: 2 },
      { status: "in_progress" },
      { conclusion: "skipped" },
      { path: ".github/workflows/ci.yml" },
      { repository: { full_name: "other/tarubot", fork: false, owner } },
      { head_repository: { full_name: "deconfined/tarubot", fork: true, owner } },
    ]) {
      const f = fixture();
      Object.assign(f.run, delta);
      await refusal(
        readTrustRun(f.request, { owner_id: owner.id, get: f.get, now: () => instant }),
      );
    }
  });
  test("missing owner gate, automatic existing target environments and broad/tag rules fail", async () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.env.name = "staging";
      },
      (f: ReturnType<typeof fixture>) => {
        f.env.protection_rules = [];
      },
      (f: ReturnType<typeof fixture>) => {
        present(present(f.env.protection_rules[0]).reviewers[0]).reviewer = { ...owner, id: 1 };
      },
      (f: ReturnType<typeof fixture>) => {
        f.env.deployment_branch_policy.custom_branch_policies = false;
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.policies.branch_policies[0]).name = "*";
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.policies.branch_policies[0]).type = "tag";
      },
      (f: ReturnType<typeof fixture>) => {
        delete (present(f.policies.branch_policies[0]) as { type?: string }).type;
      },
      (f: ReturnType<typeof fixture>) => {
        f.policies.total_count = 2;
      },
      (f: ReturnType<typeof fixture>) => {
        f.main.protected = false;
      },
    ]) {
      const f = fixture();
      edit(f);
      await refusal(
        readTrustRun(f.request, { owner_id: owner.id, get: f.get, now: () => instant }),
      );
    }
  });
  test("a successful generic or other-target job and skipped completion steps cannot satisfy enrollment", async () => {
    for (const delta of [
      { name: "Build" },
      { name: "Enroll production" },
      { conclusion: "skipped" },
      { run_attempt: 2 },
      { run_id: 54321 },
      { head_sha: "b".repeat(40) },
      { steps: [] },
      {
        steps: [
          {
            name: "Persist completed enrollment",
            status: "completed",
            conclusion: "skipped",
            number: 1,
          },
        ],
      },
    ]) {
      const f = fixture();
      Object.assign(present(f.jobs.jobs[0]), delta);
      await refusal(
        readTrustRun(f.request, { owner_id: owner.id, get: f.get, now: () => instant }),
      );
    }
    for (const fault of ["duplicate", "other-target-success", "partial-page"]) {
      const f = fixture();
      if (fault === "partial-page") f.jobs.total_count = 101;
      else {
        f.jobs.jobs.push({
          ...present(f.jobs.jobs[0]),
          id: 103,
          name: fault === "duplicate" ? f.job : "Enroll production",
        });
        f.jobs.total_count = 2;
      }
      await refusal(
        readTrustRun(f.request, { owner_id: owner.id, get: f.get, now: () => instant }),
      );
    }
  });
  test("another reviewer/account/environment, rejection, missing review or inconsistent environment ID fails", async () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.reviews.length = 0;
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.reviews[0]).state = "rejected";
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.reviews[0]).user = { ...owner, id: 1 };
      },
      (f: ReturnType<typeof fixture>) => {
        present(present(f.reviews[0]).environments[0]).name = "production";
      },
      (f: ReturnType<typeof fixture>) => {
        present(present(f.reviews[0]).environments[0]).id = 101;
      },
      (f: ReturnType<typeof fixture>) => {
        f.reviews.push({ ...present(f.reviews[0]), state: "rejected" });
      },
    ]) {
      const f = fixture();
      edit(f);
      await refusal(
        readTrustRun(f.request, { owner_id: owner.id, get: f.get, now: () => instant }),
      );
    }
  });
  test("reruns and changed gate settings during the final reread fail closed", async () => {
    for (const fault of ["rerun", "gate", "policy", "main"]) {
      const f = fixture();
      const calls = new Map<string, number>();
      const get: GitHubReader = async (r) => {
        const count = (calls.get(r.url) ?? 0) + 1;
        calls.set(r.url, count);
        if (count === 2) {
          if (fault === "rerun" && r.url.endsWith("/actions/runs/12345")) f.run.run_attempt = 2;
          if (fault === "gate" && r.url.endsWith(`/environments/${f.environment}`))
            f.env.protection_rules = [];
          if (fault === "policy" && r.url.includes("deployment-branch-policies"))
            present(f.policies.branch_policies[0]).name = "*";
          if (fault === "main" && r.url.endsWith("/branches/main")) f.main.protected = false;
        }
        return f.get(r);
      };
      await refusal(readTrustRun(f.request, { owner_id: owner.id, get, now: () => instant }));
    }
  });
  test("transport caps, redirects, non-JSON, invalid UTF-8, pagination and private exceptions are redacted failures", async () => {
    const edits: Array<(r: GitHubReadResponse) => void> = [
      (r) => {
        r.status = 302;
        r.headers.location = "https://example.org/private";
      },
      (r) => {
        r.status = 403;
      },
      (r) => {
        r.url = "https://example.org";
      },
      (r) => {
        r.headers.link = '<https://example.org/private>; rel="next"';
      },
      (r) => {
        r.headers["content-type"] = "text/html";
      },
      (r) => {
        r.headers["content-type"] = "application/json; charset=utf-8,application/json";
      },
      (r) => {
        r.headers["content-type"] = "application/json; charset=iso-8859-1";
      },
      (r) => {
        r.headers["content-type"] = "application/json; nonsense";
      },
      (r) => {
        r.headers["content-encoding"] = "gzip";
      },
      (r) => {
        r.headers.Location = "https://example.org/private";
      },
      (r) => {
        r.headers["Content-Type"] = "application/json";
      },
      (r) => {
        r.body = Buffer.from("invented private malformed JSON");
      },
      (r) => {
        r.body = new Uint8Array(1048577);
      },
      (r) => {
        r.body = Uint8Array.from([255]);
      },
    ];
    for (const edit of edits) {
      const f = fixture();
      await refusal(
        readTrustRun(f.request, {
          owner_id: owner.id,
          get: async (r) => {
            const response = await f.get(r);
            edit(response);
            return response;
          },
          now: () => instant,
        }),
      );
    }
    const f = fixture();
    await refusal(
      readTrustRun(f.request, {
        owner_id: owner.id,
        get: async () => {
          throw new Error("invented private token diagnostic");
        },
        now: () => instant,
      }),
    );
  });
  test("a bounded session and snapshot resist asynchronous request/header mutation", async () => {
    const f = fixture();
    let now = instant;
    await refusal(
      readTrustRun(f.request, {
        owner_id: owner.id,
        get: async (r) => {
          now += 60_001;
          return f.get(r);
        },
        now: () => now,
      }),
    );
    const g = fixture();
    const token = "invented_read_token_123456789";
    const proof = await readTrustRun(g.request, {
      owner_id: owner.id,
      token,
      now: () => instant,
      get: async (r) => {
        const response = await g.get(r);
        g.request.target = "production";
        g.request.commit = "b".repeat(40);
        r.headers.Authorization = "changed";
        return response;
      },
    });
    expect(proof.target).toBe("staging");
    expect(proof.commit).toBe("a".repeat(40));
    expect(g.seen.every((r) => r.headers.Authorization === `Bearer ${token}`)).toBe(true);
    await refusal(
      readTrustRun(g.request, {
        owner_id: owner.id,
        get: g.get,
        token: "private\nheader",
        now: () => instant,
      }),
    );
    const source = readFileSync(new URL("../../scripts/trust-run.ts", import.meta.url), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("import.meta.main");
  });
  test("remaining session time caps each read and final/backwards observations fail", async () => {
    const f = fixture();
    let clock = instant;
    const proof = await readTrustRun(f.request, {
      owner_id: owner.id,
      now: () => clock,
      get: async (r) => {
        const response = await f.get(r);
        clock = instant + 59_500;
        return response;
      },
    });
    expect(proof.observed_at).toBe(instant + 59_500);
    expect(f.seen[0]?.timeout_ms).toBe(10_000);
    expect(f.seen.slice(1).every((r) => r.timeout_ms === 500)).toBe(true);

    const late = fixture();
    await refusal(
      readTrustRun(late.request, {
        owner_id: owner.id,
        get: late.get,
        // The final response arrived after the same original wall budget.
        now: () => instant + (late.seen.length === 10 ? 60_001 : 0),
      }),
    );
    expect(late.seen).toHaveLength(10);
    const backwards = fixture();
    let backwardsClock = instant + 10;
    await refusal(
      readTrustRun(backwards.request, {
        owner_id: owner.id,
        get: async (r) => {
          const response = await backwards.get(r);
          backwardsClock = instant + 5;
          return response;
        },
        now: () => backwardsClock,
      }),
    );
    expect(backwards.seen).toHaveLength(1);
  });
});

// The existing fixture is still a public REST fixture: only the real verifier brands proof.
function nativeFixture() {
  const f = fixture();
  const request: TrustEnrollmentRunRequest = {
    target: "staging",
    run: { commit: f.request.commit, run: f.request.run },
  };
  const configuration = {
    target: "staging" as const,
    owner_id: owner.id,
    repository_id: 200,
    environment_id: 100,
    token: "invented_read_token_123456789",
  };
  return { ...f, nativeRequest: request, configuration };
}
function isolated(source: string): void {
  // Only mocked native methods and an isolated physical clock run in this child.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
    env: { TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: child.exitCode, diagnostic: Buffer.from(child.stderr).toString() }).toEqual({
    code: 0,
    diagnostic: "",
  });
  expect(child.stdout.byteLength).toBe(0);
  expect(child.stderr.byteLength).toBe(0);
}
const trustModule = new URL("../../scripts/trust-run.ts", import.meta.url).href;

describe("native original enrollment proof", () => {
  test("swallowed correct/wrong factory calls from clock, denial and input hooks fence the original read", async () => {
    for (const target of ["staging", "production"] as const)
      for (const phase of ["clock", "denial", "input"] as const) {
        const f = nativeFixture();
        let first = true;
        let verifier: ReturnType<typeof createTrustEnrollmentRunVerifier>;
        const nested = () => {
          if (!first) return;
          first = false;
          void verifier.verify({ ...f.nativeRequest, target }).catch(() => {});
        };
        verifier = createTrustEnrollmentRunVerifier(f.configuration, {
          get: f.get,
          now: () => {
            if (phase === "clock") nested();
            return instant;
          },
        });
        const expected =
          phase === "input"
            ? new Proxy(f.nativeRequest, {
                ownKeys(input) {
                  nested();
                  return Reflect.ownKeys(input);
                },
              })
            : f.nativeRequest;
        await refusal(
          verifier.verify(expected, () => {
            if (phase === "denial") nested();
          }),
        );
        expect(f.seen).toHaveLength(0);
      }
  });
  test("all public methods fence the saved original proof when called from its clock hook", async () => {
    for (const method of ["assert", "remaining", "within", "verify"] as const)
      for (const genuine of [true, false]) {
        const f = nativeFixture();
        let reenter = false;
        let proof: TrustEnrollmentRunProof;
        let verifier: ReturnType<typeof createTrustEnrollmentRunVerifier>;
        verifier = createTrustEnrollmentRunVerifier(f.configuration, {
          get: f.get,
          now: () => {
            if (reenter) {
              reenter = false;
              try {
                const passed = genuine ? proof : ({} as TrustEnrollmentRunProof);
                if (method === "verify")
                  void verifier
                    .verify({ ...f.nativeRequest, target: genuine ? "staging" : "production" })
                    .catch(() => {});
                else if (method === "within")
                  void verifier
                    .within(passed, f.nativeRequest, async () => "nested")
                    .catch(() => {});
                else verifier[method](passed, f.nativeRequest);
              } catch {
                /* Refusal cannot be swallowed to restore the outer proof. */
              }
            }
            return instant;
          },
        });
        proof = await verifier.verify(f.nativeRequest);
        const offers = f.seen.length;
        reenter = true;
        expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
        expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
        expect(f.seen).toHaveLength(offers);
      }
  });
  test("the synchronous hook reservation permits independent awaited reads", async () => {
    const f = nativeFixture();
    let offers = 0,
      announce!: () => void,
      resume!: () => void;
    const entered = new Promise<void>((r) => {
      announce = r;
    });
    const waiting = new Promise<void>((r) => {
      resume = r;
    });
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      now: () => instant,
      get: async (input) => {
        if (++offers === 1) {
          announce();
          await waiting;
        }
        return f.get(input);
      },
    });
    const original = verifier.verify(f.nativeRequest);
    await entered;
    const independent = await verifier.verify(f.nativeRequest);
    resume();
    const first = await original;
    verifier.assert(first, f.nativeRequest);
    verifier.assert(independent, f.nativeRequest);
    expect(f.seen).toHaveLength(28);
  });
  test("retains real final job/check/step, exact configured IDs and the original immutable request", async () => {
    const f = nativeFixture();
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => instant,
    });
    const original = structuredClone(f.nativeRequest);
    const proof = await verifier.verify(f.nativeRequest);
    expect(Object.keys(proof)).toEqual([]);
    expect(Object.isFrozen(proof)).toBe(true);
    verifier.assert(proof, original);
    expect(verifier.remaining(proof, original)).toBeGreaterThan(0);
    expect(verifier.remaining(proof, original)).toBeLessThanOrEqual(30_000);
    expect(f.seen).toHaveLength(14);
    expect(f.seen.filter((r) => r.url === `${api}/actions/jobs/102`)).toHaveLength(2);
    expect(f.seen.filter((r) => r.url.endsWith("/approvals"))).toHaveLength(2);
    expect(
      await verifier.within(proof, original, async () => {
        verifier.assert(proof, original);
        return "bounded-read";
      }),
    ).toBe("bounded-read");
    f.nativeRequest.run.commit = "b".repeat(40);
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
    expect(() => verifier.assert(proof, original)).toThrow("invalid-trust-run-evidence");
  });
  test("caller receipts, copies and another factory never restore native evidence", async () => {
    const f = nativeFixture();
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => instant,
    });
    const proof = await verifier.verify(f.nativeRequest);
    const receipt = await readTrustRun(f.request, {
      owner_id: owner.id,
      get: f.get,
      now: () => instant,
    });
    for (const echo of [
      receipt,
      structuredClone(proof),
      { ...proof },
      JSON.parse(JSON.stringify(proof)),
    ]) {
      expect(() => verifier.assert(echo as TrustEnrollmentRunProof, f.nativeRequest)).toThrow(
        "invalid-trust-run-evidence",
      );
    }
    // A cross-factory attempt has the genuine object, so its saved original state is fenced.
    const other = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => instant,
    });
    expect(() => other.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
  });
  test("the original request is captured before a caller clock can mutate it", async () => {
    const f = nativeFixture();
    const original = structuredClone(f.nativeRequest);
    let first = true;
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => {
        if (first) {
          first = false;
          f.nativeRequest.run.commit = "b".repeat(40);
        }
        return instant;
      },
    });
    const proof = await verifier.verify(f.nativeRequest);
    verifier.assert(proof, original);
    expect(f.seen).toHaveLength(14);
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
  });
  test("native-only repository/gate/job/check/step identity is mandatory", async () => {
    const edits: Array<(f: ReturnType<typeof nativeFixture>) => void> = [
      (f) => {
        f.run.repository.id++;
      },
      (f) => {
        f.run.head_repository.id++;
      },
      (f) => {
        f.env.id++;
      },
      (f) => {
        present(f.jobs.jobs[0]).url = `${api}/actions/jobs/999`;
      },
      (f) => {
        present(f.jobs.jobs[0]).check_run_url =
          "https://apiXgithubXcom/repos/deconfined/tarubot/check-runs/103";
      },
      (f) => {
        present(f.jobs.jobs[0]).check_run_url = `${api}/check-runs/0103`;
      },
      (f) => {
        present(present(f.jobs.jobs[0]).steps[0]).number = 0;
      },
      (f) => {
        present(f.jobs.jobs[0]).steps.push({
          name: "Other",
          number: 1,
          status: "completed",
          conclusion: "success",
        });
      },
      (f) => {
        f.run.status = "in_progress";
      },
      (f) => {
        present(f.jobs.jobs[0]).conclusion = "failure";
      },
      (f) => {
        f.data[`${api}/actions/jobs/102`] = { ...present(f.jobs.jobs[0]), id: 999 };
      },
    ];
    for (const edit of edits) {
      const f = nativeFixture();
      edit(f);
      const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
        get: f.get,
        now: () => instant,
      });
      await refusal(verifier.verify(f.nativeRequest));
    }
    const f = nativeFixture();
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => instant,
    });
    await refusal(verifier.verify({ ...f.nativeRequest, target: "production" }));
    expect(f.seen).toHaveLength(0);
  });
  test("changed direct job, approvals or jobs-page final evidence refuses a delivered proof", async () => {
    for (const route of ["job", "jobs", "approvals"] as const) {
      const f = nativeFixture();
      let reads = 0;
      const selected =
        route === "job"
          ? `${api}/actions/jobs/102`
          : route === "jobs"
            ? `${api}/actions/runs/12345/attempts/1/jobs?per_page=100&page=1`
            : `${api}/actions/runs/12345/approvals`;
      const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
        now: () => instant,
        get: async (input) => {
          const response = await f.get(input);
          if (input.url === selected && ++reads === 2) response.body = Buffer.from("{}");
          return response;
        },
      });
      await refusal(verifier.verify(f.nativeRequest));
      expect(reads).toBe(2);
    }
  });
  test("swallowed nested assertion and concurrent work permanently fence the owning proof", async () => {
    const f = nativeFixture();
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => instant,
    });
    const proof = await verifier.verify(f.nativeRequest);
    const proxy = new Proxy(f.nativeRequest, {
      ownKeys(target) {
        try {
          verifier.assert(proof, f.nativeRequest);
        } catch {
          /* Swallowed denial still fences. */
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => verifier.assert(proof, proxy)).toThrow("invalid-trust-run-evidence");
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
    const g = nativeFixture();
    const v = createTrustEnrollmentRunVerifier(g.configuration, { get: g.get, now: () => instant });
    const p = await v.verify(g.nativeRequest);
    let release!: () => void, announce!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      announce = r;
    });
    const original = v.within(p, g.nativeRequest, async () => {
      announce();
      await held;
      return "late";
    });
    await entered;
    await refusal(v.within(p, g.nativeRequest, async () => "nested"));
    release();
    await refusal(original);
    expect(() => v.assert(p, g.nativeRequest)).toThrow("invalid-trust-run-evidence");
  });
  test("the same denial is retained after delivery and after clock callbacks", async () => {
    const f = nativeFixture();
    let denied = false,
      denyDuringClock = false;
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => {
        if (denyDuringClock) denied = true;
        return instant;
      },
    });
    const proof = await verifier.verify(f.nativeRequest, () => {
      if (denied) throw new Error("private-refusal");
    });
    denyDuringClock = true;
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
    denied = false;
    denyDuringClock = false;
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
  });
  test("held and abandoned work is bounded by original expiry with no next late GET", async () => {
    for (const native of [false, true]) {
      const f = nativeFixture();
      let clock = instant,
        offers = 0,
        release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const get: GitHubReader = (input) => {
        offers++;
        clock += (native ? 30_000 : 60_000) - 40;
        return held.then(() => f.get(input));
      };
      const started = performance.now();
      const read = native
        ? createTrustEnrollmentRunVerifier(f.configuration, { get, now: () => clock }).verify(
            f.nativeRequest,
          )
        : readTrustRun(f.request, { owner_id: owner.id, get, now: () => clock });
      await refusal(read);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(offers).toBe(1);
      release();
      await Bun.sleep(5);
      expect(offers).toBe(1);
    }
    const f = nativeFixture();
    let clock = instant;
    const verifier = createTrustEnrollmentRunVerifier(f.configuration, {
      get: f.get,
      now: () => clock,
    });
    const proof = await verifier.verify(f.nativeRequest);
    clock += 29_980;
    await refusal(verifier.within(proof, f.nativeRequest, () => new Promise(() => {})));
    expect(() => verifier.assert(proof, f.nativeRequest)).toThrow("invalid-trust-run-evidence");
  });
  test("physical origin precedes first clock, config/dependency hooks and request reflection", () => {
    const f = nativeFixture();
    isolated(`
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const {readTrustRun,createTrustEnrollmentRunVerifier}=await import(${JSON.stringify(trustModule)});
      const input=${JSON.stringify({ configuration: f.configuration, legacy: f.request, native: f.nativeRequest })};
      for(const native of [false,true])for(const phase of ["clock","input","deps","config"]){
        elapsed=0;let offers=0,first=true;
        const bound=native?30000:60000;
        const deps={owner_id:${owner.id},now:()=>{if(phase==="clock"&&first){first=false;elapsed=bound;}return ${instant};},get:async()=>{offers++;throw Error("private");}};
        if(phase==="deps")Object.defineProperty(deps,"get",{get(){elapsed=bound;return async()=>{offers++;};}});
        const expected=phase==="input"?new Proxy(native?input.native:input.legacy,{ownKeys(target){elapsed=bound;return Reflect.ownKeys(target);}}):(native?input.native:input.legacy);
        const config=phase==="config"?new Proxy(input.configuration,{ownKeys(target){elapsed=bound;return Reflect.ownKeys(target);}}):input.configuration;
        try{
          if(native)await createTrustEnrollmentRunVerifier(config,deps).verify(expected);
          else if(phase==="config")await readTrustRun(expected,new Proxy(deps,{getOwnPropertyDescriptor(target,key){elapsed=bound;return Reflect.getOwnPropertyDescriptor(target,key);}}));
          else await readTrustRun(expected,deps);
          process.exit(1);
        }catch(error){if(error.message!=="invalid-trust-run-evidence")process.exit(2);}
        if(offers!==0)process.exit(3);
      }
    `);
  });
  test("strict refusal/clock callbacks drain rejected cross-realm promises without reading then", async () => {
    // Rejections stay inside this isolated process so an unhandled private diagnostic fails it.
    const f = nativeFixture();
    isolated(`
      import vm from "node:vm";
      const {readTrustRun,createTrustEnrollmentRunVerifier}=await import(${JSON.stringify(trustModule)});
      const input=${JSON.stringify({ configuration: f.configuration, legacy: f.request, native: f.nativeRequest })};
      let unhandled=0;process.on("unhandledRejection",()=>unhandled++);
      for(const native of [false,true])for(const phase of ["denial","clock"]){
        let offers=0,thenReads=0;
        const value=vm.runInNewContext('Promise.reject(Error("private-diagnostic"))');
        Object.defineProperty(value,"then",{get(){thenReads++;throw Error("private-then");}});
        const deps={owner_id:${owner.id},get:async()=>{offers++;throw Error("private");},now:()=>phase==="clock"?value:${instant}};
        try{if(native)await createTrustEnrollmentRunVerifier(input.configuration,deps).verify(input.native,()=>phase==="denial"?value:undefined);
          else await readTrustRun(input.legacy,deps,()=>phase==="denial"?value:undefined);process.exit(1);
        }catch(error){if(error.message!=="invalid-trust-run-evidence")process.exit(2);}
        if(offers||thenReads)process.exit(3);
      }
      await new Promise(r=>setTimeout(r,5));if(unhandled)process.exit(4);
    `);
    for (const returned of [false, true, {}, Promise.resolve()]) {
      const g = nativeFixture();
      await refusal(
        readTrustRun(
          g.request,
          { owner_id: owner.id, get: g.get, now: () => instant },
          (() => returned) as () => void,
        ),
      );
      expect(g.seen).toHaveLength(0);
    }
  });
  test("actual byte copies resist iterator/length substitution, duplicate JSON and response accessors", async () => {
    for (const attack of ["iterator", "length", "duplicate", "getter"] as const) {
      const f = fixture();
      let iteratorCalls = 0,
        getters = 0;
      await refusal(
        readTrustRun(f.request, {
          owner_id: owner.id,
          now: () => instant,
          get: async (input) => {
            const response = await f.get(input);
            if (attack === "iterator") {
              const valid = response.body;
              response.body = new Uint8Array([255]);
              Object.defineProperty(response.body, Symbol.iterator, {
                value: function* () {
                  iteratorCalls++;
                  yield* valid;
                },
              });
            } else if (attack === "length") {
              response.body = new Uint8Array(1_048_577);
              Object.defineProperty(response.body, "byteLength", { value: 1 });
            } else if (attack === "duplicate") {
              response.body = Buffer.from(
                Buffer.from(response.body)
                  .toString()
                  .replace('"id":12345', '"id":12345,"\\u0069d":12345'),
              );
            } else
              Object.defineProperty(response, "status", {
                get() {
                  getters++;
                  return 200;
                },
              });
            return response;
          },
        }),
      );
      expect(f.seen).toHaveLength(1);
      expect(iteratorCalls).toBe(0);
      expect(getters).toBe(0);
    }
  });
});

describe("native trust HTTP offer barriers", () => {
  test("end capture and response/data/header callbacks retain original refusal", () => {
    const f = nativeFixture();
    for (const native of [false, true])
      for (const phase of [
        "valid",
        "end-getter",
        "response",
        "data",
        "headers",
        "complete",
        "status",
        "late-physical",
      ]) {
        isolated(`
        import {spyOn} from "bun:test";
        import * as https from "node:https";
        import {EventEmitter} from "node:events";
        import {performance} from "node:perf_hooks";
        let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
        const input=${JSON.stringify({ configuration: f.configuration, legacy: f.request, native: f.nativeRequest, data: f.data, nativeMode: native, phase })};
        let live=true,offers=0,ends=0,headerReads=0;
        const fake=(options,accept)=>{
          offers++;
          const handle=new EventEmitter();handle.destroy=()=>{};
          Object.defineProperty(handle,"end",{get(){
            if(input.phase==="end-getter")live=false;
            return ()=>{ends++;queueMicrotask(()=>{
              const response=new EventEmitter();response.destroy=()=>{};
              Object.defineProperty(response,"complete",{get(){if(input.phase==="complete")live=false;return true;}});
              Object.defineProperty(response,"statusCode",{get(){if(input.phase==="status")live=false;return 200;}});
              Object.defineProperty(response,"rawHeaders",{get(){headerReads++;if(input.phase==="headers")live=false;return ["content-type","application/json"];}});
              if(input.phase==="response")live=false;
              if(input.phase==="late-physical")elapsed=input.nativeMode?30000:60000;
              accept(response);
              if(input.phase==="data")live=false;
              response.emit("data",Buffer.from(JSON.stringify(input.data["https://api.github.com"+options.path])));
              response.emit("end");
            });};
          }});return handle;
        };
        const patched=spyOn(https,"request").mockImplementation(fake);
        const transport=await import("node:https");if(transport.request!==patched||https.request!==patched)throw Error("fake transport not installed");
        const {readTrustRun,createTrustEnrollmentRunVerifier}=await import(${JSON.stringify(trustModule)});
        let code;
        const denial=()=>{if(!live)throw Error("private-expired");};
        try{if(input.nativeMode)await createTrustEnrollmentRunVerifier(input.configuration,{now:()=>${instant}}).verify(input.native,denial);
          else await readTrustRun(input.legacy,{owner_id:${owner.id},now:()=>${instant}},denial);code="accepted";
        }catch(error){code=error.message;}
        const total=input.nativeMode?14:10;
        if(code!==(input.phase==="valid"?"accepted":"invalid-trust-run-evidence")){console.error(input.nativeMode,input.phase,code,offers,ends,headerReads);process.exit(1);}
        if(offers!==(input.phase==="valid"?total:1))process.exit(2);
        if(ends!==(input.phase==="valid"?total:input.phase==="end-getter"?0:1))process.exit(3);
        const headersExpected=input.phase==="valid"?total:["headers","status"].includes(input.phase)?1:0;
        if(headerReads!==headersExpected)process.exit(4);
      `);
      }
  });
});
