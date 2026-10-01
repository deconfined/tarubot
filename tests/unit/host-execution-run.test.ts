/** Invented read-only phase observations. No API, environment, OIDC, controller or SSH action. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createCurrentHostPhaseVerifier,
  currentHostPhasePins as pins,
  type CurrentHostPhaseProof,
  type CurrentHostPhaseRequest,
} from "../../scripts/host-execution-run.js";
import type {
  GitHubReadRequest,
  GitHubReadResponse,
  GitHubReader,
} from "../../scripts/trust-run.js";

const api = "https://api.github.com/repos/deconfined/tarubot";
const instant = 1_800_000_000_000;
const failure = "invalid-current-host-phase";
const moduleUrl = new URL("../../scripts/host-execution-run.ts", import.meta.url).href;
function present<T>(value: T | undefined): T {
  if (value === undefined) throw Error("missing-invented-fixture");
  return value;
}
const stamp = (offset: number) => new Date(instant + offset).toISOString();
function fixture(phase: CurrentHostPhaseRequest["phase"] = "execution") {
  const configuration = {
    target: "staging" as const,
    owner_id: 100,
    repository_id: 200,
    workflow_id: 300,
    environment_id: 400,
    token: "invented_read_token_123456789",
  };
  const request: CurrentHostPhaseRequest = {
    phase,
    release: {
      version: "2.36.34",
      commit: "a".repeat(40),
      config_commit: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      publication_run: "500",
      schema_head: "001_invented.sql",
    },
  };
  const repo = {
    id: 200,
    full_name: "deconfined/tarubot",
    fork: false,
    owner: { id: 100, login: "deconfined" },
  };
  const run = {
    id: 500,
    workflow_id: 300,
    head_sha: request.release.commit,
    head_branch: "main",
    event: "push",
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    url: `${api}/actions/runs/500`,
    path: ".github/workflows/publish.yml",
    repository: repo,
    head_repository: repo,
    referenced_workflows: [
      { path: pins.orchestration, ref: "refs/heads/main", sha: request.release.config_commit },
      { path: pins.host, ref: "refs/heads/main", sha: request.release.config_commit },
    ],
  };
  const main = { name: "main", protected: true, commit: { sha: request.release.commit } };
  const gate = {
    id: 400,
    name: "staging",
    url: `${api}/environments/staging`,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [] as unknown[],
  };
  const policy = { total_count: 1, branch_policies: [{ id: 401, name: "main", type: "branch" }] };
  const complete = (name: string, number: number, begin: number, end: number) => ({
    name,
    number,
    status: "completed",
    conclusion: "success",
    started_at: stamp(begin),
    completed_at: stamp(end),
  });
  const prep =
    phase === "preparation"
      ? {
          name: pins.preparation,
          number: 3,
          status: "in_progress",
          conclusion: null,
          started_at: stamp(-4500),
          completed_at: null as string | null,
        }
      : complete(pins.preparation, 3, -4500, -4400);
  const execute = {
    name: pins.execution,
    number: 4,
    status: phase === "preparation" ? "queued" : "in_progress",
    conclusion: null,
    started_at: phase === "preparation" ? null : stamp(-4300),
    completed_at: null as string | null,
  };
  const job = {
    id: 600,
    name: pins.job as string,
    run_id: 500,
    run_attempt: 1,
    head_sha: request.release.commit,
    head_branch: "main",
    url: `${api}/actions/jobs/600`,
    run_url: run.url,
    check_run_url: `${api}/check-runs/700`,
    status: "in_progress",
    conclusion: null,
    started_at: stamp(-5000),
    completed_at: null as string | null,
    steps: [
      complete(pins.request, 1, -4900, -4800),
      complete(pins.freshness, 2, -4700, -4600),
      prep,
      execute,
    ],
  };
  const jobs = { total_count: 1, jobs: [job] };
  const check = {
    id: 700,
    name: pins.job,
    url: `${api}/check-runs/700`,
    head_sha: request.release.commit,
    status: "in_progress",
    conclusion: null,
    started_at: job.started_at,
    completed_at: null as string | null,
    app: { id: 800, slug: "github-actions" },
    check_suite: { id: 900 },
  };
  const data: Record<string, unknown> = {
    [api]: repo,
    [`${api}/actions/runs/500`]: run,
    [`${api}/branches/main`]: main,
    [`${api}/environments/staging`]: gate,
    [`${api}/environments/staging/deployment-branch-policies?per_page=100&page=1`]: policy,
    [`${api}/actions/runs/500/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [`${api}/actions/jobs/600`]: job,
    [`${api}/check-runs/700`]: check,
  };
  const seen: GitHubReadRequest[] = [];
  const clock = { now: instant };
  const get: GitHubReader = async (input) => {
    seen.push(structuredClone(input));
    if (!Object.hasOwn(data, input.url)) throw new Error("invented-private-unexpected-route");
    return {
      status: 200,
      url: input.url,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: Buffer.from(JSON.stringify(data[input.url])),
    };
  };
  const verifier = createCurrentHostPhaseVerifier(configuration, { get, now: () => clock.now });
  return {
    configuration,
    request,
    repo,
    run,
    main,
    gate,
    policy,
    job,
    jobs,
    prep,
    execute,
    check,
    data,
    seen,
    clock,
    get,
    verifier,
  };
}
function isolated(source: string): void {
  // Native function/clock fixtures stay in this subprocess; no network method survives spying.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
    env: { TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({
    code: child.exitCode,
    output: Buffer.from(child.stdout).toString(),
    diagnostic: Buffer.from(child.stderr).toString(),
  }).toEqual({ code: 0, output: "", diagnostic: "" });
}

function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* A held original clock hook must count physical work. */
  }
}

describe("future read-only current Host phases", () => {
  test("both phases require exact sixteen GET observations and return only an opaque proof", async () => {
    for (const phase of ["preparation", "execution"] as const) {
      const f = fixture(phase),
        proof = await f.verifier.verify(f.request);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.keys(proof)).toEqual([]);
      expect(JSON.stringify(proof)).toBe("{}");
      expect(Object.keys(f.verifier).sort()).toEqual(["assert", "remaining", "verify", "within"]);
      f.verifier.assert(proof, f.request);
      const remaining = f.verifier.remaining(proof, f.request);
      expect(Number.isSafeInteger(remaining) && remaining > 0 && remaining <= 30_000).toBe(true);
      expect(f.seen.map((input) => input.url)).toEqual([
        api,
        `${api}/actions/runs/500`,
        `${api}/branches/main`,
        `${api}/environments/staging`,
        `${api}/environments/staging/deployment-branch-policies?per_page=100&page=1`,
        `${api}/actions/runs/500/attempts/1/jobs?per_page=100&page=1`,
        `${api}/actions/jobs/600`,
        `${api}/check-runs/700`,
        `${api}/actions/jobs/600`,
        `${api}/check-runs/700`,
        `${api}/actions/runs/500/attempts/1/jobs?per_page=100&page=1`,
        `${api}/environments/staging`,
        `${api}/environments/staging/deployment-branch-policies?per_page=100&page=1`,
        `${api}/branches/main`,
        `${api}/actions/runs/500`,
        api,
      ]);
      for (const input of f.seen) {
        expect(input.method).toBe("GET");
        expect(input.redirect).toBe("error");
        expect(input.timeout_ms > 0 && input.timeout_ms <= 10_000).toBe(true);
        expect(input.headers["Accept-Encoding"]).toBe("identity");
        expect(input.headers["Cache-Control"]).toBe("no-cache");
      }
    }
  });
  test("production refuses before dependency hooks or any GET", async () => {
    const f = fixture();
    let touched = 0;
    const deps = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          touched++;
          throw Error("private");
        },
      },
    );
    await expect(
      createCurrentHostPhaseVerifier({ ...f.configuration, target: "production" }, deps).verify(
        f.request,
      ),
    ).rejects.toThrow(failure);
    expect(touched).toBe(0);
    expect(f.seen).toHaveLength(0);
  });
  test("current graph and old critical step names cannot satisfy future declarations", async () => {
    const source = readFileSync(
      new URL("../../.github/workflows/host.yml", import.meta.url),
      "utf8",
    );
    expect(source.includes(pins.preparation)).toBe(false);
    expect(source.includes(pins.execution)).toBe(false);
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.job.name = "Release pipeline / staging / Host";
      },
      (f: ReturnType<typeof fixture>) => {
        f.prep.name = "Configure the host";
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(f.verifier.verify(f.request)).rejects.toThrow(failure);
    }
  });
  test("future execute row can be absent during preparation, but visible contradictions deny", async () => {
    const absent = fixture("preparation");
    absent.job.steps.pop();
    await absent.verifier.verify(absent.request);
    expect(absent.seen).toHaveLength(16);
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.execute.status = "in_progress";
      },
      (f: ReturnType<typeof fixture>) => {
        f.execute.started_at = stamp(-4300);
      },
      (f: ReturnType<typeof fixture>) => {
        f.job.steps.push(structuredClone(f.execute));
      },
    ]) {
      const f = fixture("preparation");
      mutate(f);
      await expect(f.verifier.verify(f.request)).rejects.toThrow(failure);
    }
    const noExecution = fixture();
    noExecution.job.steps.pop();
    await expect(noExecution.verifier.verify(noExecution.request)).rejects.toThrow(failure);
  });
  test("UTC Z and +00:00 are canonical; invalid normalized dates and unsupported offsets deny", async () => {
    const zero = fixture();
    zero.job.started_at = zero.job.started_at.replace("Z", "+00:00");
    zero.check.started_at = zero.job.started_at;
    for (const step of zero.job.steps) {
      if (step.started_at) step.started_at = step.started_at.replace("Z", "+00:00");
      if (step.completed_at) step.completed_at = step.completed_at.replace("Z", "+00:00");
    }
    await zero.verifier.verify(zero.request);
    for (const stamp of [
      "2027-02-30T00:00:00.000Z",
      "2027-01-01T00:00:00.000-08:00",
      "2027-01-01T00:00:00.000+01:00",
      "2027-01-01 00:00:00Z",
    ]) {
      const f = fixture();
      f.job.started_at = stamp;
      f.check.started_at = stamp;
      await expect(f.verifier.verify(f.request)).rejects.toThrow(failure);
    }
  });
  test("API proof explicitly does not attest evaluated release values or job environment", async () => {
    const f = fixture();
    f.request.release.version = "9.8.7";
    f.request.release.digest = `sha256:${"c".repeat(64)}`;
    f.request.release.schema_head = "999_invented.sql";
    // REST fixture has no version/digest/schema/event/controller/environment-job claim.
    const proof = await f.verifier.verify(f.request);
    f.verifier.assert(proof, f.request);
    const source = readFileSync(
      new URL("../../scripts/host-execution-run.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "Reading a staging gate does NOT prove that the selected job used that environment",
    );
    expect(source).toContain("caller assertions, not API facts");
    expect(Object.keys(proof)).toEqual([]);
    const altered = structuredClone(f.request);
    altered.release.digest = `sha256:${"d".repeat(64)}`;
    expect(() => f.verifier.assert(proof, altered)).toThrow(failure);
  });
  test("configured native numeric identities and same protected reusable revisions are mandatory", async () => {
    const mutations = [
      (f: ReturnType<typeof fixture>) => {
        f.repo.id++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.repo.owner.id++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.workflow_id++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.gate.id++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.main.protected = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.main.commit.sha = "c".repeat(40);
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.run.referenced_workflows[0]).sha = "c".repeat(40);
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.run.referenced_workflows[1]).sha = "c".repeat(40);
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.run_attempt = 2;
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.event = "workflow_dispatch";
      },
      (f: ReturnType<typeof fixture>) => {
        f.gate.protection_rules.push({ type: "required_reviewers" });
      },
      (f: ReturnType<typeof fixture>) => {
        present(f.policy.branch_policies[0]).name = "other";
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await expect(f.verifier.verify(f.request)).rejects.toThrow(failure);
    }
  });
  test("actual critical identity, status and timestamp ordering cannot be substituted", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.prep.status = "in_progress";
      },
      (f: ReturnType<typeof fixture>) => {
        f.prep.conclusion = "failure";
      },
      (f: ReturnType<typeof fixture>) => {
        f.prep.number = 5;
      },
      (f: ReturnType<typeof fixture>) => {
        f.execute.started_at = stamp(-4600);
      },
      (f: ReturnType<typeof fixture>) => {
        f.execute.completed_at = stamp(-4200);
      },
      (f: ReturnType<typeof fixture>) => {
        f.job.check_run_url = "https://apiXgithubXcom/repos/deconfined/tarubot/check-runs/700";
      },
      (f: ReturnType<typeof fixture>) => {
        f.check.id++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.check.app.slug = "invented";
      },
      (f: ReturnType<typeof fixture>) => {
        f.check.started_at = stamp(-4999);
      },
      (f: ReturnType<typeof fixture>) => {
        f.jobs.jobs.push(structuredClone(f.job));
        f.jobs.total_count++;
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(f.verifier.verify(f.request)).rejects.toThrow(failure);
    }
  });
  test("every reopened original job/check/page/run/gate/policy/repository change refuses", async () => {
    for (const index of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      const f = fixture();
      let calls = 0;
      const get: GitHubReader = async (input) => {
        const result = await f.get(input);
        if (++calls === index) {
          const data = JSON.parse(Buffer.from(result.body).toString()) as Record<string, unknown>;
          data.invented_change = true;
          result.body = Buffer.from(JSON.stringify(data));
        }
        return result;
      };
      await expect(
        createCurrentHostPhaseVerifier(f.configuration, { get, now: () => f.clock.now }).verify(
          f.request,
        ),
      ).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(index === 8 ? 10 : index);
    }
  });
});

describe("original phase proof and callback fences", () => {
  test("copies, unknown capabilities, wrong expected context and other factories cannot authorize", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    expect(() => f.verifier.assert(structuredClone(proof), f.request)).toThrow(failure);
    expect(() => f.verifier.assert({} as CurrentHostPhaseProof, f.request)).toThrow(failure);
    f.verifier.assert(proof, f.request);
    const other = fixture();
    expect(() => other.verifier.assert(proof, other.request)).toThrow(failure);
    expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
    const another = fixture(),
      cap = await another.verifier.verify(another.request);
    const wrong = structuredClone(another.request);
    wrong.phase = "preparation";
    expect(() => another.verifier.assert(cap, wrong)).toThrow(failure);
    expect(() => another.verifier.assert(cap, another.request)).toThrow(failure);
  });
  test("monotonic wall expiry and retained denial permanently refuse the same proof", async () => {
    for (const reason of ["expiry", "rollback", "denial"]) {
      const f = fixture();
      let live = true;
      const proof = await f.verifier.verify(f.request, () => {
        if (!live) throw Error("invented-private-denial");
      });
      if (reason === "expiry") f.clock.now += 30_000;
      else if (reason === "rollback") f.clock.now--;
      else live = false;
      expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
      f.clock.now = instant;
      live = true;
      expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
      expect(f.seen).toHaveLength(16);
    }
  });
  test("remaining counts the final clock callback and returns a strict original shrinking integer", async () => {
    const f = fixture();
    let active = false,
      calls = 0;
    const verifier = createCurrentHostPhaseVerifier(f.configuration, {
      get: f.get,
      now: () => {
        if (active && ++calls === 6) f.clock.now += 10_000;
        return f.clock.now;
      },
    });
    const proof = await verifier.verify(f.request);
    active = true;
    const left = verifier.remaining(proof, f.request);
    // Owned expected-input capture adds its checkpoint before assert and remaining sample.
    expect(calls).toBe(6);
    expect(Number.isSafeInteger(left) && left > 0 && left <= 20_000).toBe(true);
  });
  test("snapshot hooks and first clock are counted from the original physical origin", () => {
    const f = fixture();
    for (const mode of ["config", "deps", "input", "clock", "denial"])
      isolated(`
      import {performance} from "node:perf_hooks";
      let physical=0;Object.defineProperty(performance,"now",{value:()=>physical});
      const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
      const cfg=${JSON.stringify(f.configuration)}, input=${JSON.stringify(f.request)};
      const mode=${JSON.stringify(mode)};let offers=0,clocks=0;
      const late=(value)=>new Proxy(value,{ownKeys(target){physical=30000;return Reflect.ownKeys(target);}});
      const configuration=mode==="config"?late(cfg):cfg;
      const expected=mode==="input"?late(input):input;
      const deps={get:async()=>{offers++;throw Error("native must not offer");},now:()=>{clocks++;if(mode==="clock")physical=30000;return ${instant};}};
      const dependencies=mode==="deps"?new Proxy(deps,{getOwnPropertyDescriptor(target,key){physical=30000;return Reflect.getOwnPropertyDescriptor(target,key);}}):deps;
      const verifier=createCurrentHostPhaseVerifier(configuration,dependencies);
      try{await verifier.verify(expected,()=>{if(mode==="denial")physical=30000;});process.exit(1);}catch(e){if(e.message!==${JSON.stringify(failure)}||offers!==0)process.exit(2);}
    `);
  });
  test("caught correct or wrong nested verification from every synchronous hook fences outer", async () => {
    for (const mode of ["clock", "denial", "input", "get", "response"])
      for (const wrong of [false, true]) {
        const f = fixture();
        let called = false,
          nested: Promise<unknown> | undefined;
        const bad = structuredClone(f.request);
        if (wrong) bad.phase = "preparation";
        let verifier: ReturnType<typeof createCurrentHostPhaseVerifier>;
        const invoke = () => {
          if (!called) {
            called = true;
            nested = verifier.verify(bad).catch(() => {});
          }
        };
        const get: GitHubReader = async (input) => {
          if (mode === "get") invoke();
          const response = await f.get(input);
          if (mode === "response")
            return new Proxy(response, {
              getOwnPropertyDescriptor(target, key) {
                invoke();
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            });
          return response;
        };
        verifier = createCurrentHostPhaseVerifier(f.configuration, {
          get,
          now: () => {
            if (mode === "clock") invoke();
            return instant;
          },
        });
        const wanted =
          mode === "input"
            ? new Proxy(f.request, {
                ownKeys(target) {
                  invoke();
                  return Reflect.ownKeys(target);
                },
              })
            : f.request;
        await expect(
          verifier.verify(wanted, () => {
            if (mode === "denial") invoke();
          }),
        ).rejects.toThrow(failure);
        await nested;
        expect(f.seen).toHaveLength(mode === "response" || mode === "get" ? 1 : 0);
      }
  });
  test("independent awaited calls retain separate original proofs without a shared cache", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.verifier.verify(f.request), f.verifier.verify(f.request)]);
    expect(a).not.toBe(b);
    expect(f.seen).toHaveLength(32);
    f.verifier.assert(a, f.request);
    f.verifier.assert(b, f.request);
  });
  test("held GET rejects on the shorter original wall remainder and stops late fanout", async () => {
    const f = fixture();
    let release: (value: GitHubReadResponse) => void = () => {};
    const get: GitHubReader = (input) => {
      const response = f.get(input);
      f.clock.now = instant + 29_960;
      return new Promise((accept) => {
        release = accept;
        void response;
      });
    };
    const started = performance.now();
    await expect(
      createCurrentHostPhaseVerifier(f.configuration, { get, now: () => f.clock.now }).verify(
        f.request,
      ),
    ).rejects.toThrow(failure);
    expect(performance.now() - started < 300).toBe(true);
    expect(f.seen).toHaveLength(1);
    release({
      status: 200,
      url: api,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(f.repo)),
    });
    await Bun.sleep(20);
    expect(f.seen).toHaveLength(1);
  });
  test("guarded work copies owned results and fences concurrent, nested and timed-out work", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    const value = { private_invented: [1, 2] };
    const result = await f.verifier.within(proof, f.request, async () => value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(result.private_invented).not.toBe(value.private_invented);
    const held = f.verifier.within(proof, f.request, () => new Promise(() => {}));
    await expect(f.verifier.within(proof, f.request, async () => 1)).rejects.toThrow(failure);
    await expect(held).rejects.toThrow(failure);
    expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
    const nested = fixture(),
      native = await nested.verifier.verify(nested.request);
    await expect(
      nested.verifier.within(native, nested.request, async () => {
        await nested.verifier.within(native, nested.request, async () => 1).catch(() => {});
        return 2;
      }),
    ).rejects.toThrow(failure);
    const timed = fixture(),
      cap = await timed.verifier.verify(timed.request);
    await expect(
      timed.verifier.within(cap, timed.request, () => {
        timed.clock.now += 29_960;
        return new Promise(() => {});
      }),
    ).rejects.toThrow(failure);
    expect(() => timed.verifier.assert(cap, timed.request)).toThrow(failure);
  });
  test("synchronous public work allows only its own pure assertions under the same original anchor", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    expect(
      await f.verifier.within(proof, f.request, async () => {
        f.verifier.assert(proof, f.request);
        expect(f.verifier.remaining(proof, f.request)).toBeGreaterThan(0);
        return "invented";
      }),
    ).toBe("invented");
    expect(f.seen).toHaveLength(16);
    for (const mode of ["short", "copy", "verify"] as const) {
      const g = fixture(),
        original = await g.verifier.verify(g.request);
      await expect(
        g.verifier.within(original, g.request, async () => {
          if (mode === "short") {
            g.clock.now += 29_980;
            spin(60);
          }
          try {
            if (mode === "verify") await g.verifier.verify(g.request);
            else g.verifier.assert(mode === "copy" ? { ...original } : original, g.request);
          } catch {
            /* Catching a denied nested entry cannot restore the original public work. */
          }
          return "withheld";
        }),
      ).rejects.toThrow(failure);
      expect(g.seen).toHaveLength(16);
      expect(() => g.verifier.assert(original, g.request)).toThrow(failure);
    }
  });
  test("starved timers cannot deliver a queued native fulfillment after the saved original deadline", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    await expect(
      f.verifier.within(proof, f.request, () => {
        f.clock.now += 29_980;
        return new Promise<string>((accept) =>
          queueMicrotask(() => {
            spin(60);
            accept("invented");
          }),
        );
      }),
    ).rejects.toThrow(failure);
    expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
  });
  test("owned synchronous work and result copying retain their pre-hook physical anchor", async () => {
    for (const mode of ["work", "copy"] as const) {
      const f = fixture(),
        proof = await f.verifier.verify(f.request);
      const shorten = () => {
        f.clock.now += 29_980;
        spin(60);
      };
      // Reflection belongs to the owned copy, even when its first trap moves the wall clock.
      const value = new Proxy(
        { invented: true },
        {
          ownKeys(target) {
            if (mode === "copy") shorten();
            return Reflect.ownKeys(target);
          },
        },
      );
      await expect(
        f.verifier.within(proof, f.request, () => {
          if (mode === "work") shorten();
          return Promise.resolve(value);
        }),
      ).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(16);
      expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
    }
  });
  test("an asynchronous resume starts its own callback anchor without charging the idle gap twice", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    const result = await f.verifier.within(
      proof,
      f.request,
      () =>
        new Promise<string>((accept) => {
          setTimeout(() => {
            f.clock.now += 29_900;
            accept("invented");
          }, 180);
        }),
    );
    expect(result).toBe("invented");
    expect(f.seen).toHaveLength(16);
  });
  test("native fulfillment is copied before then-getter assimilation or nested result callbacks", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    let thenReads = 0;
    const result = { value: 1 },
      pending = Promise.resolve(result);
    // biome-ignore lint/suspicious/noThenProperty: hostile assimilation is the behavior under test.
    Object.defineProperty(result, "then", {
      enumerable: true,
      get() {
        thenReads++;
        return () => {};
      },
    });
    await expect(f.verifier.within(proof, f.request, () => pending)).rejects.toThrow(failure);
    expect(thenReads).toBe(0);
    expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
  });
  test("strict clock/refusal contracts drain rejected native promises across realms without then access", () => {
    const f = fixture();
    isolated(`
      import {runInNewContext} from "node:vm";
      const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
      let unhandled=0,reads=0,offers=0;process.on("unhandledRejection",()=>unhandled++);
      const configuration=${JSON.stringify(f.configuration)}, request=${JSON.stringify(f.request)};
      for(const mode of ["denial","clock","final-clock"])for(const realm of [false,true]){
        const bad=realm?runInNewContext('Promise.reject(Error("private"))'):Promise.reject(Error("private"));
        Object.defineProperty(bad,"then",{get(){reads++;throw Error("private then");}});
        let clocks=0;const verifier=createCurrentHostPhaseVerifier(configuration,{get:async()=>{offers++;throw Error("must not read");},now:()=>mode==="clock"||(mode==="final-clock"&&++clocks===2)?bad:${instant}});
        try{await verifier.verify(request,mode==="denial"?()=>bad:undefined);process.exit(1);}catch(e){if(e.message!==${JSON.stringify(failure)})process.exit(2);}
      }
      await Bun.sleep(20);if(unhandled||reads||offers)process.exit(3);
    `);
  });
  test("bad Boolean/nonfinite returns and accessor dependencies refuse without authority", async () => {
    for (const value of [false, true, {}, Promise.resolve()]) {
      const f = fixture();
      await expect(
        f.verifier.verify(f.request, (() => value) as unknown as () => void),
      ).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(0);
    }
    for (const value of [NaN, Infinity, -1, 1.5]) {
      const f = fixture();
      await expect(
        createCurrentHostPhaseVerifier(f.configuration, { get: f.get, now: () => value }).verify(
          f.request,
        ),
      ).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(0);
    }
    const f = fixture();
    let accessor = 0;
    const deps = Object.defineProperty({}, "get", {
      enumerable: true,
      get() {
        accessor++;
        return f.get;
      },
    });
    await expect(
      createCurrentHostPhaseVerifier(f.configuration, deps).verify(f.request),
    ).rejects.toThrow(failure);
    expect(accessor).toBe(0);
  });
  test("dependency selection is captured once and caller mutation cannot change retained release", async () => {
    const f = fixture();
    let selections = 0;
    const deps = new Proxy(
      { get: f.get, now: () => instant },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "get") selections++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const verifier = createCurrentHostPhaseVerifier(f.configuration, deps),
      proof = await verifier.verify(f.request);
    expect(selections).toBe(1);
    const expected = structuredClone(f.request);
    f.request.release.commit = "c".repeat(40);
    verifier.assert(proof, expected);
    expect(() => verifier.assert(proof, f.request)).toThrow(failure);
  });
});

describe("bounded response bytes and native offer barriers", () => {
  test("response redirects, header ambiguity, substitution bytes and invalid JSON never offer a next GET", async () => {
    for (const mode of [
      "status",
      "redirect",
      "link",
      "gzip",
      "duplicate-header",
      "duplicate-json",
      "utf8",
      "oversize",
      "shared",
    ] as const) {
      const f = fixture();
      let iterations = 0;
      const get: GitHubReader = async (input) => {
        const r = await f.get(input);
        if (mode === "status") r.status = 503;
        if (mode === "redirect") r.url = "https://example.org/private";
        if (mode === "link") r.headers.link = '<https://example.org/private>; rel="next"';
        if (mode === "gzip") r.headers["content-encoding"] = "gzip";
        if (mode === "duplicate-header") r.headers["Content-Type"] = "application/json";
        if (mode === "duplicate-json") r.body = Buffer.from('{"id":200,"id":200}');
        if (mode === "utf8") {
          const bytes = new Uint8Array([255]);
          Object.defineProperty(bytes, Symbol.iterator, {
            value: function* () {
              iterations++;
              yield* Buffer.from(JSON.stringify(f.repo));
            },
          });
          r.body = bytes;
        }
        if (mode === "oversize") {
          r.body = new Uint8Array(1_048_577);
          Object.defineProperty(r.body, "byteLength", { value: 1 });
        }
        if (mode === "shared") r.body = new Uint8Array(new SharedArrayBuffer(1));
        return r;
      };
      await expect(
        createCurrentHostPhaseVerifier(f.configuration, { get, now: () => instant }).verify(
          f.request,
        ),
      ).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(1);
      expect(iterations).toBe(0);
    }
  });
  test("malformed input, response getters and private transport errors have fixed diagnostics", async () => {
    const f = fixture();
    let getters = 0;
    const input = Object.defineProperty({ phase: "execution" }, "release", {
      enumerable: true,
      get() {
        getters++;
        return f.request.release;
      },
    });
    await expect(f.verifier.verify(input as CurrentHostPhaseRequest)).rejects.toThrow(failure);
    expect(getters).toBe(0);
    expect(f.seen).toHaveLength(0);
    for (const get of [
      async () => {
        throw Error("invented-private-key-bearer-host-details");
      },
      async (request: GitHubReadRequest) =>
        Object.defineProperty(
          { status: 200, url: request.url, headers: {}, body: new Uint8Array() },
          "body",
          {
            enumerable: true,
            get() {
              getters++;
              throw Error("invented-private-body");
            },
          },
        ),
    ]) {
      const reader = createCurrentHostPhaseVerifier(f.configuration, { get, now: () => instant });
      let diagnostic = "";
      try {
        await reader.verify(f.request);
      } catch (error) {
        diagnostic = (error as Error).message;
      }
      expect(diagnostic).toBe(failure);
      expect(diagnostic).not.toContain("private");
    }
    expect(getters).toBe(0);
  });
  test("same actual phase progressing or source identity changing during direct reads denies", async () => {
    for (const mode of ["phase", "check", "reference", "main"]) {
      const f = fixture("preparation");
      let reads = 0;
      const get: GitHubReader = async (input) => {
        if (++reads === 7) {
          if (mode === "phase") {
            f.prep.status = "completed";
            f.prep.conclusion = "success";
            f.prep.completed_at = stamp(-4400);
            f.execute.status = "in_progress";
            f.execute.started_at = stamp(-4300);
          }
          if (mode === "check") f.check.id++;
          if (mode === "reference") present(f.run.referenced_workflows[1]).sha = "c".repeat(40);
          if (mode === "main") f.main.commit.sha = "c".repeat(40);
        }
        return f.get(input);
      };
      await expect(
        createCurrentHostPhaseVerifier(f.configuration, { get, now: () => instant }).verify(
          f.request,
        ),
      ).rejects.toThrow(failure);
    }
  });
  test("default native request/end/response/chunk/header offers use the original LAST guard", () => {
    const f = fixture();
    for (const mode of [
      "valid",
      "end-getter",
      "on-getter",
      "response",
      "data",
      "headers",
      "complete",
      "status",
      "physical",
      "nested-end",
      "final-denial",
      "short-cap",
      "same-hook-short-cap",
    ])
      isolated(`
      import {spyOn} from "bun:test";
      import * as https from "node:https";
      import {EventEmitter} from "node:events";
      import {performance} from "node:perf_hooks";
      let physical=0;Object.defineProperty(performance,"now",{value:()=>physical});
      const cfg=${JSON.stringify(f.configuration)}, expected=${JSON.stringify(f.request)}, data=${JSON.stringify(f.data)}, mode=${JSON.stringify(mode)};
      let offers=0,ends=0,headerReads=0,live=true,verifier,wall=1800000000000,denials=0;
      const fake=(options,accept)=>{
        offers++;
        if(options.hostname!=="api.github.com"||options.method!=="GET"||options.rejectUnauthorized!==true||options.agent.keepAlive!==false)throw Error("unsafe native route");
        const handle=new EventEmitter();handle.destroy=()=>{};
        if(["on-getter","short-cap"].includes(mode))Object.defineProperty(handle,"on",{get(){if(mode==="on-getter")live=false;else wall+=29980;return EventEmitter.prototype.on;}});
        Object.defineProperty(handle,"end",{get(){
          if(mode==="end-getter")live=false;
          if(mode==="short-cap")physical+=60;
          if(mode==="same-hook-short-cap"){wall+=29980;physical+=60;}
          if(mode==="nested-end")void verifier.verify({...expected,phase:"preparation"}).catch(()=>{});
          return()=>{ends++;queueMicrotask(()=>{
            const response=new EventEmitter();response.destroy=()=>{};
            Object.defineProperty(response,"complete",{get(){if(mode==="complete")live=false;return true;}});
            Object.defineProperty(response,"statusCode",{get(){if(mode==="status")live=false;return 200;}});
            Object.defineProperty(response,"rawHeaders",{get(){headerReads++;if(mode==="headers")live=false;return ["content-type","application/json"];}});
            if(mode==="response")live=false;
            if(mode==="physical")physical=30000;
            accept(response);
            if(mode==="data")live=false;
            response.emit("data",Buffer.from(JSON.stringify(data["https://api.github.com"+options.path])));response.emit("end");
          });};
        }});return handle;
      };
      const patched=spyOn(https,"request").mockImplementation(fake);
      const transport=await import("node:https");if(transport.request!==patched||https.request!==patched)throw Error("native fake not installed");
      const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
      verifier=createCurrentHostPhaseVerifier(cfg,{now:()=>wall});
      let code;try{await verifier.verify(expected,()=>{if(mode==="final-denial"&&++denials===16)wall+=30000;if(!live)throw Error("invented private refusal");});code="accepted";}catch(e){code=e.message;}
      if(code!==(mode==="valid"?"accepted":${JSON.stringify(failure)}))throw Error("wrong diagnostic "+mode+":"+code);
      if(offers!==(mode==="valid"?16:mode==="final-denial"?0:1))throw Error("late offer "+mode+":"+offers);
      if(ends!==(mode==="valid"?16:["end-getter","on-getter","nested-end","final-denial","short-cap","same-hook-short-cap"].includes(mode)?0:1))throw Error("late end "+mode+":"+ends);
      const expectedHeaders=mode==="valid"?16:["headers","status"].includes(mode)?1:0;
      if(headerReads!==expectedHeaders)throw Error("late header read "+mode+":"+headerReads);
    `);
  });
});

describe("capture and remaining regressions", () => {
  test("void work is safely bounded and delivers no authority or transport output", async () => {
    const f = fixture(),
      proof = await f.verifier.verify(f.request);
    expect(await f.verifier.within(proof, f.request, async () => {})).toBeUndefined();
    f.verifier.assert(proof, f.request);
    expect(f.seen).toHaveLength(16);
  });
  test("late first metadata capture stops every subsequent descriptor offer", () => {
    const f = fixture();
    for (const mode of ["config", "deps", "response"])
      isolated(`
      import {performance} from "node:perf_hooks";
      let physical=0;Object.defineProperty(performance,"now",{value:()=>physical});
      const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
      const cfg=${JSON.stringify(f.configuration)}, expected=${JSON.stringify(f.request)}, mode=${JSON.stringify(mode)};
      let metadata=0,offers=0;
      const late=(value)=>new Proxy(value,{getOwnPropertyDescriptor(target,key){metadata++;physical=30000;return Reflect.getOwnPropertyDescriptor(target,key);}});
      const get=async(input)=>{offers++;return late({status:200,url:input.url,headers:{"content-type":"application/json"},body:Buffer.from(${JSON.stringify(JSON.stringify(f.repo))})});};
      const deps={get,now:()=>${instant}};
      const verifier=createCurrentHostPhaseVerifier(mode==="config"?late(cfg):cfg,mode==="deps"?late(deps):deps);
      try{await verifier.verify(expected);process.exit(1);}catch(e){if(e.message!==${JSON.stringify(failure)}||metadata!==1||offers!==(mode==="response"?1:0))process.exit(2);}
    `);
  });
  test("final physical clock cost shrinks remaining without a later refreshing hook", () => {
    const f = fixture();
    isolated(`
      import {performance} from "node:perf_hooks";
      let physical=0;Object.defineProperty(performance,"now",{value:()=>physical});
      const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
      const cfg=${JSON.stringify(f.configuration)}, expected=${JSON.stringify(f.request)}, data=${JSON.stringify(f.data)};
      let active=false,calls=0;
      const verifier=createCurrentHostPhaseVerifier(cfg,{now:()=>{if(active&&++calls===6)physical+=10000;return ${instant};},get:async(input)=>({status:200,url:input.url,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify(data[input.url]))})});
      const proof=await verifier.verify(expected);active=true;
      const left=verifier.remaining(proof,expected);
      if(calls!==6||left!==20000)throw Error("remaining renewed or stale:"+left+":"+calls);
    `);
  });
  test("caught malformed production-shaped nested request fences original before any GET", async () => {
    const f = fixture();
    let once = false,
      nested: Promise<unknown> | undefined;
    const verifier = createCurrentHostPhaseVerifier(f.configuration, {
      get: f.get,
      now: () => {
        if (!once) {
          once = true;
          nested = verifier
            .verify({ ...f.request, target: "production" } as CurrentHostPhaseRequest)
            .catch(() => {});
        }
        return instant;
      },
    });
    await expect(verifier.verify(f.request)).rejects.toThrow(failure);
    await nested;
    expect(f.seen).toHaveLength(0);
  });
});

describe("final refusal cost cannot outlive an old clock sample", () => {
  test("last refusal cost shrinks returned remaining from the FIRST original clock", async () => {
    const f = fixture();
    let active = false,
      refusals = 0;
    const proof = await f.verifier.verify(f.request, () => {
      if (active && ++refusals === 6) f.clock.now += 10_000;
    });
    active = true;
    const left = f.verifier.remaining(proof, f.request);
    expect(refusals).toBe(6);
    expect(left > 0 && left <= 20_000).toBe(true);
  });
  test("last pre-offer refusal advancing the full original age yields zero GET offers", async () => {
    const f = fixture();
    let refusals = 0;
    await expect(
      f.verifier.verify(f.request, () => {
        if (++refusals === 12) f.clock.now += 30_000;
      }),
    ).rejects.toThrow(failure);
    expect(refusals).toBe(12);
    expect(f.seen).toHaveLength(0);
  });
  test("final clock failure and caught nested phase calls fence before the first offer", async () => {
    for (const wrong of [false, true]) {
      const f = fixture();
      let clocks = 0,
        nested: Promise<unknown> | undefined;
      const verifier = createCurrentHostPhaseVerifier(f.configuration, {
        get: f.get,
        now: () => {
          if (++clocks === 2)
            nested = verifier
              .verify({ ...f.request, phase: wrong ? "preparation" : "execution" })
              .catch(() => {});
          return instant;
        },
      });
      await expect(verifier.verify(f.request)).rejects.toThrow(failure);
      await nested;
      expect(f.seen).toHaveLength(0);
    }
  });
  test("active work deadline also counts final refusal cost before any scheduled work", async () => {
    const f = fixture();
    let active = false,
      refusals = 0,
      works = 0;
    const proof = await f.verifier.verify(f.request, () => {
      if (active && ++refusals === 4) f.clock.now += 30_000;
    });
    active = true;
    await expect(
      f.verifier.within(proof, f.request, async () => {
        works++;
      }),
    ).rejects.toThrow(failure);
    expect(works).toBe(0);
    expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
  });
});

test("an observed short wall cap survives synchronous work before its promise/timer is installed", async () => {
  const f = fixture();
  let active = false,
    clocks = 0,
    works = 0;
  const verifier = createCurrentHostPhaseVerifier(f.configuration, {
    get: f.get,
    now: () => {
      if (active && ++clocks === 7) f.clock.now += 29_980;
      return f.clock.now;
    },
  });
  const proof = await verifier.verify(f.request);
  active = true;
  await expect(
    verifier.within(proof, f.request, () => {
      works++;
      spin(60);
      return Promise.resolve("invented-late");
    }),
  ).rejects.toThrow(failure);
  expect(works).toBe(1);
  expect(() => verifier.assert(proof, f.request)).toThrow(failure);
});

test("a later original proof observation immediately rearms an already-held wait", async () => {
  const f = fixture(),
    proof = await f.verifier.verify(f.request);
  const began = performance.now();
  await expect(
    f.verifier.within(
      proof,
      f.request,
      () =>
        new Promise<void>(() => {
          setTimeout(() => {
            f.clock.now += 29_980;
            f.verifier.assert(proof, f.request);
          }, 2);
        }),
    ),
  ).rejects.toThrow(failure);
  expect(performance.now() - began < 300).toBe(true);
  expect(() => f.verifier.assert(proof, f.request)).toThrow(failure);
});

test("a held native response discovered after scheduling uses the shorter original timeout", () => {
  const f = fixture();
  isolated(`
    import {spyOn} from "bun:test";
    import * as https from "node:https";
    import {EventEmitter} from "node:events";
    import {performance} from "node:perf_hooks";
    let wall=${instant},offers=0,ends=0;
    const fake=(options,accept)=>{
      offers++;const handle=new EventEmitter();handle.destroy=()=>{};
      handle.end=()=>{ends++;queueMicrotask(()=>{
        const response=new EventEmitter();response.destroy=()=>{};response.complete=false;response.statusCode=200;response.rawHeaders=["content-type","application/json"];
        wall+=29980;accept(response);
        // No data/end callback resolves the accepted native-shaped response.
      });};return handle;
    };
    const patched=spyOn(https,"request").mockImplementation(fake);
    const transport=await import("node:https");if(transport.request!==patched||https.request!==patched)throw Error("native fake not installed");
    const {createCurrentHostPhaseVerifier}=await import(${JSON.stringify(moduleUrl)});
    const verifier=createCurrentHostPhaseVerifier(${JSON.stringify(f.configuration)},{now:()=>wall});
    const started=performance.now();
    try{await verifier.verify(${JSON.stringify(f.request)});throw Error("accepted held response");}catch(e){if(e.message!==${JSON.stringify(failure)})throw e;}
    if(performance.now()-started>=300||offers!==1||ends!==1)throw Error("late held response refusal");
    process.exit(0);
  `);
});
