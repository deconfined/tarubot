/** Invented GitHub responses only: no API request, owner action or environment configuration. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readTrustRun,
  type GitHubReadRequest,
  type GitHubReadResponse,
  type GitHubReader,
  type TrustRunRequest,
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
    repository: { full_name: "deconfined/tarubot", fork: false, owner },
    head_repository: { full_name: "deconfined/tarubot", fork: false, owner },
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
    let observations = 0;
    await refusal(
      readTrustRun(late.request, {
        owner_id: owner.id,
        get: late.get,
        // Ten reads each check before/after; only the final proof timestamp is too late.
        now: () => instant + (++observations === 22 ? 60_001 : 0),
      }),
    );
    expect(late.seen).toHaveLength(10);
    const backwards = fixture();
    let calls = 0;
    await refusal(
      readTrustRun(backwards.request, {
        owner_id: owner.id,
        get: backwards.get,
        now: () => instant + (++calls < 4 ? 10 : 5),
      }),
    );
    expect(backwards.seen).toHaveLength(1);
  });
});
