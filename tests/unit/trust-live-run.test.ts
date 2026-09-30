/** Invented GET-only GitHub metadata: no live API, token lookup, workflow or owner action. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readLiveTrustRun } from "../../scripts/trust-live-run.js";
import {
  readTrustRun,
  type GitHubReader,
  type GitHubReadRequest,
  type GitHubReadResponse,
  type TrustRunRequest,
} from "../../scripts/trust-run.js";

const api = "https://api.github.com/repos/deconfined/tarubot";
const instant = 1_800_000_000_000;
const ownerIdentity = { login: "deconfined", id: 123456 };
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-live-fixture");
  return value;
}
function fixture(
  kind: TrustRunRequest["kind"] = "enrollment",
  target: TrustRunRequest["target"] = "staging",
) {
  const request: TrustRunRequest = { kind, target, commit: "a".repeat(40), run: "12345" };
  const workflow = `.github/workflows/${kind === "enrollment" ? "trust-enroll" : "control-recovery"}.yml`;
  const jobName =
    kind === "enrollment"
      ? `Enroll ${target}`
      : target === "infra"
        ? "Recover infrastructure"
        : `Recover ${target} trust`;
  const environment = `${kind === "enrollment" ? "trust" : "recover"}-${target}`;
  const stepName =
    kind === "enrollment" ? "Persist completed enrollment" : "Verify restored journal";
  const run = {
    id: 12345,
    workflow_id: 103,
    head_sha: request.commit,
    head_branch: "main",
    event: "workflow_dispatch",
    run_attempt: 1,
    status: "in_progress",
    conclusion: null as string | null,
    path: workflow,
    actor: structuredClone(ownerIdentity),
    triggering_actor: structuredClone(ownerIdentity),
    repository: {
      id: 104,
      full_name: "deconfined/tarubot",
      fork: false,
      owner: structuredClone(ownerIdentity),
    },
    head_repository: {
      id: 104,
      full_name: "deconfined/tarubot",
      fork: false,
      owner: structuredClone(ownerIdentity),
    },
    url: `${api}/actions/runs/12345`,
    updated_at: "2027-01-15T08:00:00Z",
  };
  const env = {
    id: 100,
    name: environment,
    url: `${api}/environments/${environment}`,
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: structuredClone(ownerIdentity) }],
      },
    ],
  };
  const policies = { total_count: 1, branch_policies: [{ id: 101, name: "main", type: "branch" }] };
  const main = { name: "main", protected: true, commit: { sha: request.commit } };
  const job = {
    id: 102,
    run_id: 12345,
    run_attempt: 1,
    head_sha: request.commit,
    head_branch: "main",
    status: "in_progress",
    conclusion: null as string | null,
    name: jobName,
    run_url: run.url,
    url: `${api}/actions/jobs/102`,
    steps: [
      {
        name: "Read immutable event and private grant",
        number: 1,
        status: "completed",
        conclusion: "success" as string | null,
      },
      { name: stepName, number: 2, status: "in_progress", conclusion: null as string | null },
      { name: "Cleanup", number: 3, status: "queued", conclusion: null as string | null },
    ],
  };
  const jobs = { total_count: 1, jobs: [job] };
  const reviews = [
    {
      state: "approved",
      user: structuredClone(ownerIdentity),
      environments: [{ id: env.id, name: env.name, url: env.url }],
    },
  ];
  const paths = {
    run: `${api}/actions/runs/12345`,
    gate: `${api}/environments/${environment}`,
    policies: `${api}/environments/${environment}/deployment-branch-policies?per_page=100&page=1`,
    main: `${api}/branches/main`,
    jobs: `${api}/actions/runs/12345/attempts/1/jobs?per_page=100&page=1`,
    reviews: `${api}/actions/runs/12345/approvals`,
  };
  const data: Record<string, unknown> = {
    [paths.run]: run,
    [paths.gate]: env,
    [paths.policies]: policies,
    [paths.main]: main,
    [paths.jobs]: jobs,
    [paths.reviews]: reviews,
  };
  const seen: GitHubReadRequest[] = [];
  const get: GitHubReader = async (request) => {
    seen.push(structuredClone(request));
    if (!Object.hasOwn(data, request.url)) throw new Error("unexpected-invented-live-api-path");
    return {
      status: 200,
      url: request.url,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: Buffer.from(JSON.stringify(data[request.url])),
    };
  };
  const read = (
    override: Partial<{
      owner_id: number;
      token: string;
      get: GitHubReader;
      now: () => number;
    }> = {},
  ) =>
    readLiveTrustRun(request, { owner_id: ownerIdentity.id, get, now: () => instant, ...override });
  return {
    request,
    workflow,
    jobName,
    environment,
    stepName,
    run,
    env,
    policies,
    main,
    job,
    jobs,
    reviews,
    paths,
    data,
    seen,
    get,
    read,
  };
}
async function refusal(action: Promise<unknown>) {
  try {
    await action;
    throw new Error("expected-invented-live-refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid-live-trust-run-evidence");
  }
}

describe("read-only live owner mutation job evidence", () => {
  test("each proposed scope binds the exact first-attempt live job, shared critical step and approved owner gate", async () => {
    for (const [kind, target] of [
      ["enrollment", "staging"],
      ["enrollment", "production"],
      ["recovery", "infra"],
      ["recovery", "staging"],
      ["recovery", "production"],
    ] as const) {
      const f = fixture(kind, target);
      const proof = await f.read();
      expect(proof).toEqual({
        schema: 1,
        purpose: "tarubot-live-owner-run-v1",
        repository: "deconfined/tarubot",
        kind,
        target,
        workflow: f.workflow,
        commit: f.request.commit,
        run: f.request.run,
        attempt: 1,
        status: "in_progress",
        conclusion: null,
        job: f.jobName,
        job_id: 102,
        critical_step: { name: f.stepName, number: 2, status: "in_progress", conclusion: null },
        environment: f.environment,
        environment_id: 100,
        reviewer: { login: "deconfined", id: ownerIdentity.id },
        observed_at: instant,
        expires_at: instant + 10_000,
      });
      expect(f.seen).toHaveLength(12);
      expect(new Set(f.seen.map((request) => request.url))).toEqual(
        new Set(Object.values(f.paths)),
      );
      expect(
        f.seen.every(
          (request) =>
            request.method === "GET" &&
            request.url.startsWith(`${api}/`) &&
            request.redirect === "error" &&
            request.body_limit === 1_048_576 &&
            request.timeout_ms > 0 &&
            request.timeout_ms <= 10_000,
        ),
      ).toBe(true);
      expect(
        f.seen.every(
          (request) =>
            request.headers["X-GitHub-Api-Version"] === "2026-03-10" &&
            request.headers["Accept-Encoding"] === "identity" &&
            request.headers.Authorization === undefined,
        ),
      ).toBe(true);
      expect(Object.isFrozen(proof.critical_step)).toBe(true);
      expect(Object.isFrozen(proof.reviewer)).toBe(true);
      for (const unsupported of ["grant", "inputs", "outcome_digest", "approval_timestamp"])
        expect(Object.hasOwn(proof, unsupported)).toBe(false);
    }
  });

  test("the shared step must be live before mutation and later completed for independent final-run evidence", async () => {
    const f = fixture();
    await f.read();
    await expect(
      readTrustRun(f.request, { owner_id: ownerIdentity.id, get: f.get, now: () => instant }),
    ).rejects.toThrow("invalid-trust-run-evidence");
    f.run.status = "completed";
    f.run.conclusion = "success";
    f.job.status = "completed";
    f.job.conclusion = "success";
    for (const step of f.job.steps) {
      step.status = "completed";
      step.conclusion = "success";
    }
    await refusal(f.read());
    const final = await readTrustRun(f.request, {
      owner_id: ownerIdentity.id,
      get: f.get,
      now: () => instant,
    });
    expect(final.job).toBe(f.jobName);
    expect(final.conclusion).toBe("success");
  });

  test("missing private owner ID, malformed token or request and accessor authority reject before any GET", async () => {
    const f = fixture();
    for (const id of [undefined, null, 0, -1, "123456", Number.MAX_SAFE_INTEGER + 1])
      await refusal(f.read({ owner_id: id as number }));
    for (const token of [
      "short",
      "x".repeat(2049),
      "invented-secret-token\nheader",
      "invented-secret-token space",
    ])
      await refusal(f.read({ token }));
    for (const changed of [
      { kind: "other" },
      { target: "other" },
      { kind: "enrollment", target: "infra" },
      { run: "0" },
      { run: "01" },
      { run: "9999999999999999" },
      { run: "12345/foreign" },
      { commit: "A".repeat(40) },
      { commit: "a".repeat(41) },
      { approved: true },
    ])
      await refusal(
        readLiveTrustRun({ ...f.request, ...changed } as TrustRunRequest, {
          owner_id: ownerIdentity.id,
          get: f.get,
        }),
      );
    let invoked = false;
    const getter = { ...f.request };
    Object.defineProperty(getter, "target", {
      enumerable: true,
      get() {
        invoked = true;
        return "staging";
      },
    });
    await refusal(readLiveTrustRun(getter, { owner_id: ownerIdentity.id, get: f.get }));
    expect(invoked).toBe(false);
    expect(f.seen).toHaveLength(0);
  });

  test("run binds current owner dispatch, main source, repository, workflow and first attempt", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.run.id++;
      },
      (f) => {
        f.run.run_attempt = 2;
      },
      (f) => {
        f.run.head_sha = "b".repeat(40);
      },
      (f) => {
        f.run.head_branch = "other";
      },
      (f) => {
        f.run.event = "push";
      },
      (f) => {
        f.run.path = ".github/workflows/deploy.yml";
      },
      (f) => {
        f.run.path += "@other";
      },
      (f) => {
        f.run.workflow_id = 0;
      },
      (f) => {
        f.run.actor.id++;
      },
      (f) => {
        f.run.actor.login = "invented-other-owner";
      },
      (f) => {
        f.run.triggering_actor.id++;
      },
      (f) => {
        f.run.repository.fork = true;
      },
      (f) => {
        f.run.head_repository.fork = true;
      },
      (f) => {
        f.run.repository.full_name = "invented/foreign";
      },
      (f) => {
        f.run.head_repository.id++;
      },
      (f) => {
        f.run.repository.owner.id++;
      },
      (f) => {
        f.run.head_repository.owner.login = "invented-other-owner";
      },
      (f) => {
        f.run.url += "/foreign";
      },
      (f) => {
        f.run.conclusion = "success";
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await refusal(f.read());
    }
    for (const status of [
      "completed",
      "queued",
      "waiting",
      "pending",
      "skipped",
      "cancelled",
      "requested",
    ]) {
      const f = fixture();
      f.run.status = status;
      await refusal(f.read());
    }
    for (const suffix of ["", "@main", "@refs/heads/main"]) {
      const f = fixture();
      f.run.path = `deconfined/tarubot/${f.workflow}${suffix || "@main"}`;
      expect((await f.read()).workflow).toBe(f.workflow);
    }
  });

  test("protected owner gate and one explicit main branch policy are mandatory", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.env.name = "staging";
      },
      (f) => {
        f.env.id = 0;
      },
      (f) => {
        f.env.url += "/foreign";
      },
      (f) => {
        f.env.deployment_branch_policy.protected_branches = true;
      },
      (f) => {
        f.env.deployment_branch_policy.custom_branch_policies = false;
      },
      (f) => {
        f.env.protection_rules = [];
      },
      (f) => {
        f.env.protection_rules.push(structuredClone(present(f.env.protection_rules[0])));
      },
      (f) => {
        present(f.env.protection_rules[0]).prevent_self_review = true;
      },
      (f) => {
        present(present(f.env.protection_rules[0]).reviewers[0]).type = "Team";
      },
      (f) => {
        present(present(f.env.protection_rules[0]).reviewers[0]).reviewer.id++;
      },
      (f) => {
        present(f.env.protection_rules[0]).reviewers.push({
          type: "User",
          reviewer: { login: "invented-other-owner", id: 123457 },
        });
      },
      (f) => {
        f.policies.total_count = 2;
      },
      (f) => {
        present(f.policies.branch_policies[0]).type = "tag";
      },
      (f) => {
        present(f.policies.branch_policies[0]).name = "*";
      },
      (f) => {
        present(f.policies.branch_policies[0]).id = 0;
      },
      (f) => {
        f.policies.branch_policies.push({ id: 105, name: "other", type: "branch" });
      },
      (f) => {
        f.main.protected = false;
      },
      (f) => {
        f.main.name = "other";
      },
      (f) => {
        f.main.commit.sha = "b".repeat(40);
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await refusal(f.read());
    }
  });

  test("owner approval must match exact target environment ID/name/URL with no conflicting review", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.reviews.length = 0;
      },
      (f) => {
        present(f.reviews[0]).state = "rejected";
      },
      (f) => {
        present(f.reviews[0]).state = "pending";
      },
      (f) => {
        present(f.reviews[0]).user.id++;
      },
      (f) => {
        present(f.reviews[0]).user.login = "invented-other-owner";
      },
      (f) => {
        present(present(f.reviews[0]).environments[0]).id++;
      },
      (f) => {
        present(present(f.reviews[0]).environments[0]).name = "trust-production";
      },
      (f) => {
        present(present(f.reviews[0]).environments[0]).url += "/foreign";
      },
      (f) => {
        f.reviews.push(structuredClone(present(f.reviews[0])));
      },
      (f) => {
        present(f.reviews[0]).environments.push(
          structuredClone(present(present(f.reviews[0]).environments[0])),
        );
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await refusal(f.read());
    }
    const f = fixture();
    f.reviews.unshift({
      state: "approved",
      user: { login: "invented-other-owner", id: 123457 },
      environments: [
        { id: 105, name: "trust-production", url: `${api}/environments/trust-production` },
      ],
    });
    expect((await f.read()).environment).toBe("trust-staging");
  });

  test("exact selected job and one active critical step are required; other target jobs must be skipped", async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.jobs.total_count = 2;
      },
      (f) => {
        f.jobs.jobs = [];
        f.jobs.total_count = 0;
      },
      (f) => {
        f.jobs.jobs.push(structuredClone(f.job));
        f.jobs.total_count++;
      },
      (f) => {
        f.jobs.jobs.push({ ...structuredClone(f.job), id: 106 });
        f.jobs.total_count++;
      },
      (f) => {
        f.job.name = "Other generic successful job";
      },
      (f) => {
        f.job.run_id++;
      },
      (f) => {
        f.job.run_attempt = 2;
      },
      (f) => {
        f.job.head_sha = "b".repeat(40);
      },
      (f) => {
        f.job.head_branch = "other";
      },
      (f) => {
        f.job.run_url += "/foreign";
      },
      (f) => {
        f.job.url += "/foreign";
      },
      (f) => {
        f.job.conclusion = "success";
      },
      (f) => {
        present(f.job.steps[1]).name = "Generic operation";
      },
      (f) => {
        present(f.job.steps[1]).number = 0;
      },
      (f) => {
        present(f.job.steps[1]).number = 1;
      },
      (f) => {
        present(f.job.steps[1]).conclusion = "success";
      },
      (f) => {
        f.job.steps.push({ ...structuredClone(present(f.job.steps[1])), number: 4 });
      },
      (f) => {
        present(f.job.steps[2]).status = "in_progress";
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await refusal(f.read());
    }
    for (const status of ["completed", "queued", "waiting", "pending", "skipped", "cancelled"]) {
      const f = fixture();
      f.job.status = status;
      await refusal(f.read());
      const g = fixture();
      present(g.job.steps[1]).status = status;
      await refusal(g.read());
    }
    for (const status of ["in_progress", "queued", "completed"]) {
      const f = fixture();
      f.jobs.jobs.push({
        ...structuredClone(f.job),
        id: 106,
        name: "Enroll production",
        status,
        conclusion: "success",
      });
      f.jobs.total_count++;
      await refusal(f.read());
    }
    const f = fixture();
    f.jobs.jobs.push({
      ...structuredClone(f.job),
      id: 106,
      name: "Enroll production",
      status: "completed",
      conclusion: "skipped",
    });
    f.jobs.total_count++;
    expect((await f.read()).job).toBe("Enroll staging");
  });

  test("a changed gate/head/policy/approval/job/run on any final reread refuses live authority", async () => {
    const changes: Array<
      [keyof ReturnType<typeof fixture>["paths"], (f: ReturnType<typeof fixture>) => void]
    > = [
      [
        "gate",
        (f) => {
          f.env.id++;
        },
      ],
      [
        "gate",
        (f) => {
          f.env.can_admins_bypass = true;
        },
      ],
      [
        "gate",
        (f) => {
          present(present(f.env.protection_rules[0]).reviewers[0]).reviewer.id++;
        },
      ],
      [
        "policies",
        (f) => {
          present(f.policies.branch_policies[0]).id++;
        },
      ],
      [
        "policies",
        (f) => {
          present(f.policies.branch_policies[0]).name = "other";
        },
      ],
      [
        "main",
        (f) => {
          f.main.commit.sha = "b".repeat(40);
        },
      ],
      [
        "main",
        (f) => {
          f.main.protected = false;
        },
      ],
      [
        "reviews",
        (f) => {
          present(f.reviews[0]).state = "rejected";
        },
      ],
      [
        "jobs",
        (f) => {
          f.job.status = "completed";
          f.job.conclusion = "success";
        },
      ],
      [
        "jobs",
        (f) => {
          present(f.job.steps[1]).status = "completed";
          present(f.job.steps[1]).conclusion = "success";
        },
      ],
      [
        "jobs",
        (f) => {
          f.job.id++;
          f.job.url = `${api}/actions/jobs/${f.job.id}`;
        },
      ],
      [
        "jobs",
        (f) => {
          present(f.job.steps[1]).number = 4;
        },
      ],
      [
        "run",
        (f) => {
          f.run.run_attempt = 2;
        },
      ],
      [
        "run",
        (f) => {
          f.run.workflow_id++;
        },
      ],
      [
        "run",
        (f) => {
          f.run.status = "completed";
          f.run.conclusion = "cancelled";
        },
      ],
    ];
    for (const [source, change] of changes) {
      const f = fixture();
      const seen = new Map<string, number>();
      await refusal(
        f.read({
          get: async (request) => {
            const count = (seen.get(request.url) ?? 0) + 1;
            seen.set(request.url, count);
            if (request.url === f.paths[source] && count === 2) change(f);
            return f.get(request);
          },
        }),
      );
    }
    const f = fixture();
    const proof = await f.read({
      get: async (request) => {
        f.run.updated_at = "2027-01-15T08:00:10Z";
        return f.get(request);
      },
    });
    expect(proof.status).toBe("in_progress");
  });

  test("clock, total budget and the oldest final authority observation bound short-lived proofs", async () => {
    for (const bad of [0, NaN, Infinity, 1.5]) {
      const f = fixture();
      await refusal(f.read({ now: () => bad }));
      expect(f.seen).toHaveLength(0);
    }
    for (const delta of [-1, 60_001]) {
      const f = fixture();
      let time = instant;
      await refusal(
        f.read({
          now: () => time,
          get: async (request) => {
            time = instant + delta;
            return f.get(request);
          },
        }),
      );
    }
    const f = fixture();
    let time = instant;
    const proof = await f.read({
      now: () => time,
      get: async (request) => {
        time += 100;
        return f.get(request);
      },
    });
    expect(proof.observed_at).toBe(instant + 700);
    expect(proof.expires_at).toBe(instant + 10_700);
    expect(proof.expires_at - time).toBe(9500);
    const late = fixture();
    let slowTime = instant;
    await refusal(
      late.read({
        now: () => slowTime,
        get: async (request) => {
          slowTime += 2000;
          return late.get(request);
        },
      }),
    );
    expect(late.seen).toHaveLength(12);
    const shrinking = fixture();
    let shrinkingTime = instant;
    await refusal(
      shrinking.read({
        now: () => shrinkingTime,
        get: async (request) => {
          shrinkingTime += 5500;
          return shrinking.get(request);
        },
      }),
    );
    expect(shrinking.seen.some((request) => request.timeout_ms < 10_000)).toBe(true);
  });

  test("caller and dependency mutations across awaited GETs cannot replace captured owner/token/request", async () => {
    const f = fixture();
    const token = "invented-private-github-reader-token";
    let ownerAccesses = 0;
    let tokenAccesses = 0;
    const configuration = {
      get owner_id() {
        ownerAccesses++;
        return ownerIdentity.id;
      },
      get token() {
        tokenAccesses++;
        return token;
      },
      get: async (request: GitHubReadRequest) => {
        f.request.target = "production";
        f.request.run = "54321";
        f.request.commit = "b".repeat(40);
        configuration.get = async () => {
          throw new Error("replaced-invented-reader");
        };
        return f.get(request);
      },
      now: () => instant,
    };
    const expected = structuredClone(f.request);
    const proof = await readLiveTrustRun(f.request, configuration);
    expect(proof.target).toBe(expected.target);
    expect(proof.run).toBe(expected.run);
    expect(proof.commit).toBe(expected.commit);
    expect(ownerAccesses).toBe(1);
    expect(tokenAccesses).toBe(1);
    expect(
      f.seen.every(
        (request) =>
          request.headers.Authorization === `Bearer ${token}` && !request.url.includes(token),
      ),
    ).toBe(true);
    expect(JSON.stringify(proof)).not.toContain(token);
  });
});

describe("bounded live-run JSON transport", () => {
  test("never-resolving injected readers stop at the remaining real timer budget", async () => {
    const f = fixture();
    let clockReads = 0;
    let timeout = 0;
    await refusal(
      f.read({
        now: () => instant + (clockReads++ === 0 ? 0 : 59_990),
        get: async (request) => {
          timeout = request.timeout_ms;
          return new Promise<GitHubReadResponse>(() => {});
        },
      }),
    );
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(10);
  });

  test("a frozen wall clock cannot extend physical operation or final authority freshness", async () => {
    for (const phase of ["operation", "final-round"]) {
      const f = fixture();
      const modulePath = new URL("../../scripts/trust-live-run.ts", import.meta.url).pathname;
      // A private subprocess isolates this test-only monotonic-clock replacement from other
      // suites. All metadata is invented and every transport call uses this in-memory fixture.
      const program = `
        import { performance } from "node:perf_hooks";
        const input = ${JSON.stringify({ request: f.request, data: f.data, phase })};
        let elapsed = 0, calls = 0;
        Object.defineProperty(performance, "now", { value: () => elapsed });
        const { readLiveTrustRun } = await import(${JSON.stringify(modulePath)});
        let code = "unexpected-success";
        try {
          await readLiveTrustRun(input.request, {
            owner_id: ${ownerIdentity.id}, now: () => ${instant},
            get: async request => {
              calls++;
              elapsed = input.phase === "operation" ? 60001 : calls * 2000;
              return { status: 200, url: request.url, headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify(input.data[request.url])) };
            },
          });
        } catch (error) { code = error.message; }
        console.log(JSON.stringify({ calls, code }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = Buffer.from(child.stdout).toString();
      const stderr = Buffer.from(child.stderr).toString();
      expect(stderr).toBe("");
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        calls: phase === "operation" ? 1 : 12,
        code: "invalid-live-trust-run-evidence",
      });
    }
  });

  test("duplicate JSON authority keys including escaped equivalents are rejected before last-value parsing", async () => {
    for (const duplicate of [
      '"status":"completed","status":"in_progress"',
      '"statu\\u0073":"completed","status":"in_progress"',
    ]) {
      const f = fixture();
      await refusal(
        f.read({
          get: async (request) => {
            const response = await f.get(request);
            if (request.url === f.paths.run)
              response.body = Buffer.from(
                Buffer.from(response.body).toString().replace('"status":"in_progress"', duplicate),
              );
            return response;
          },
        }),
      );
      expect(f.seen).toHaveLength(1);
    }
    const deep = fixture();
    await refusal(
      deep.read({
        get: async (request) => ({
          ...(await deep.get(request)),
          body: Buffer.from(`${"[".repeat(65)}null${"]".repeat(65)}`),
        }),
      }),
    );
  });

  test("single JSON MIME allows UTF-8 only and rejects folded duplicate or case-variant headers", async () => {
    for (const contentType of [
      "application/json",
      'Application/JSON; Charset="UTF-8"',
      "application/json ; charset = utf-8\t",
    ]) {
      const f = fixture();
      expect(
        (
          await f.read({
            get: async (request) => ({
              ...(await f.get(request)),
              headers: { "content-type": contentType },
            }),
          })
        ).status,
      ).toBe("in_progress");
    }
    for (const contentType of [
      "application/json,application/json",
      "application/json; charset=utf-8,application/json",
      "application/json; charset=latin1",
      "application/json; charset=utf-8; ignored=true",
      "application/json; nonsense",
      "text/json",
      "application/json\r\nX-Forged: yes",
    ]) {
      const f = fixture();
      await refusal(
        f.read({
          get: async (request) => ({
            ...(await f.get(request)),
            headers: { "content-type": contentType },
          }),
        }),
      );
    }
    const f = fixture();
    await refusal(
      f.read({
        get: async (request) => ({
          ...(await f.get(request)),
          headers: { "content-type": "application/json", "Content-Type": "application/json" },
        }),
      }),
    );
  });

  test("redirects/pagination/compression, wrong response identity, size and parsing failures stay fixed", async () => {
    const changes: Array<(response: GitHubReadResponse) => void> = [
      (response) => {
        response.status = 302;
      },
      (response) => {
        response.status = 403;
      },
      (response) => {
        response.url = "https://invented.example.org/foreign";
      },
      (response) => {
        response.headers.location = "https://invented.example.org/redirect";
      },
      (response) => {
        response.headers.link = "<https://invented.example.org/next>; rel=next";
      },
      (response) => {
        response.headers["content-encoding"] = "gzip";
      },
      (response) => {
        response.headers["content-encoding"] = "identity,identity";
      },
      (response) => {
        response.headers["content-length"] = "0";
      },
      (response) => {
        response.headers.large = "x".repeat(16 * 1024);
      },
      (response) => {
        response.body = new Uint8Array(1_048_577);
      },
      (response) => {
        response.body = new Uint8Array();
      },
      (response) => {
        response.body = new Uint8Array([255]);
      },
      (response) => {
        response.body = Buffer.from("invented-private-github-error-diagnostic");
      },
    ];
    for (const change of changes) {
      const f = fixture();
      await refusal(
        f.read({
          get: async (request) => {
            const response = await f.get(request);
            change(response);
            return response;
          },
        }),
      );
    }
    const f = fixture();
    await refusal(
      f.read({
        get: async () => {
          throw new Error("invented-private-token-and-owner-diagnostic");
        },
      }),
    );
  });

  test("native path is fixed direct GET-only HTTPS and never reads inherited token or workflow controls", () => {
    const source = readFileSync(
      new URL("../../scripts/trust-live-run.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "process.env",
      "Bun.env",
      "execFile",
      "spawn(",
      "actions/workflows",
      "actions/jobs/" + "{",
      'method: "POST"',
      'method: "PATCH"',
      'method: "PUT"',
      'method: "DELETE"',
    ])
      expect(source).not.toContain(forbidden);
    expect(source).toContain("rejectUnauthorized: true");
    expect(source).toContain("maxHeaderSize: 16 * 1024");
    expect(source).toContain("response.rawHeaders");
    expect(source).toContain("keepAlive: false");
  });
});
