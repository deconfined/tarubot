/** Execution-only native proofs and real encrypted records; no actual GitHub or backend calls. */
import { describe, expect, test } from "bun:test";
import {
  assertInfrastructureBaselineRunProof,
  createInfrastructureBaselineRunVerifier,
  type InfrastructureBaselineRunRequest,
  type InfrastructureBaselineRunProof,
} from "../../scripts/infra-baseline-run.js";
import {
  InfrastructureJournal,
  RecordCodec,
  stateEvidence,
  type ControlStore,
} from "../../scripts/infra-control.js";
import { baselineRunFixture, baselineFixtureInstant } from "../fixtures/infra/baseline-run.js";
import {
  assertTargetCandidatePreparation,
  prepareTargetCandidates,
  withinTargetCandidatePreparation,
} from "../../scripts/target-candidate.js";

const request: InfrastructureBaselineRunRequest = {
  kind: "baseline",
  run: { commit: "b".repeat(40), run: "23456" },
};
const failure = "invalid-infrastructure-baseline-run";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}

describe("original infrastructure JOB execution barrier", () => {
  test("manual baseline, Apply and adoption require exact owner approval and successful original critical steps", async () => {
    for (const [kind, adoption] of [
      ["baseline", false],
      ["apply", false],
      ["apply", true],
    ] as const) {
      const expected = { ...request, kind };
      const f = baselineRunFixture(expected, { adoption });
      const proof = await f.verify(expected);
      expect(() => assertInfrastructureBaselineRunProof(proof, expected)).not.toThrow();
      expect(Object.keys(proof)).toEqual([]);
      expect(JSON.stringify(proof)).toBe("{}");
      expect(f.seen.every((get) => get.method === "GET" && get.redirect === "error")).toBe(true);
      expect(
        f.seen.filter((get) => get.url === "https://api.github.com/repos/deconfined/tarubot"),
      ).toHaveLength(2);
      expect(
        f.seen.every((get) => get.headers.Authorization === `Bearer ${f.configuration.token}`),
      ).toBe(true);
    }
  });
  test("automatic completed Apply JOB succeeds while publication remains active or later fails", async () => {
    const expected = { ...request, kind: "apply" as const };
    for (const conclusion of [null, "success", "failure", "cancelled"]) {
      const f = baselineRunFixture(expected, { automatic: true });
      f.run.status = conclusion === null ? "in_progress" : "completed";
      f.run.conclusion = conclusion;
      const proof = await f.verify(expected);
      expect(() => assertInfrastructureBaselineRunProof(proof, expected)).not.toThrow();
      expect(f.seen.some((get) => get.url.includes("/environments/infra-auto"))).toBe(true);
      expect(f.seen.some((get) => get.url.endsWith("/approvals"))).toBe(false);
    }
  });
  test("failure, queueing, reruns, wrong original source, repository, job and critical step cannot complete a baseline", async () => {
    const mutations: ((f: ReturnType<typeof baselineRunFixture>) => void)[] = [
      (f) => {
        f.run.conclusion = "failure";
      },
      (f) => {
        f.run.status = "queued";
      },
      (f) => {
        f.run.run_attempt = 2;
      },
      (f) => {
        f.run.head_sha = "c".repeat(40);
      },
      (f) => {
        f.run.path = ".github/workflows/control-recovery.yml";
      },
      (f) => {
        f.run.triggering_actor = { id: 654321, login: "deconfined" };
      },
      (f) => {
        f.repository.id = 654321;
      },
      (f) => {
        f.repository.owner.id = 654321;
      },
      (f) => {
        f.run.head_repository.fork = true;
      },
      (f) => {
        f.apply.status = "in_progress";
      },
      (f) => {
        f.apply.conclusion = "failure";
      },
      (f) => {
        f.apply.name = "Unrelated successful job";
      },
      (f) => {
        present(f.apply.steps[2]).conclusion = "skipped";
      },
      (f) => {
        f.jobs.jobs.push(structuredClone(f.apply));
        f.jobs.total_count++;
      },
      (f) => {
        f.gate.protection_rules = [];
      },
      (f) => {
        present(f.policies.branch_policies[0]).name = "*";
      },
      (f) => {
        present(f.approvals[0]).state = "rejected";
      },
      (f) => {
        present(present(f.approvals[0]).environments[0]).id++;
      },
      (f) => {
        f.data["https://api.github.com/repos/deconfined/tarubot/branches/main"] = {
          name: "main",
          protected: false,
        };
      },
    ];
    for (const mutate of mutations) {
      const f = baselineRunFixture(request);
      mutate(f);
      await expect(f.verify(request)).rejects.toThrow(failure);
    }
  });
  test("automatic scope rejects manual environment, missing called-workflow SHA and a nonterminal critical step", async () => {
    const expected = { ...request, kind: "apply" as const };
    for (const mutate of [
      (f: ReturnType<typeof baselineRunFixture>) => {
        f.gate.name = "infra";
      },
      (f: ReturnType<typeof baselineRunFixture>) => {
        present(f.run.referenced_workflows[1]).sha = "c".repeat(40);
      },
      (f: ReturnType<typeof baselineRunFixture>) => {
        present(f.apply.steps[0]).status = "in_progress";
      },
      (f: ReturnType<typeof baselineRunFixture>) => {
        present(f.apply.steps[0]).name = "Seal applied target descriptor";
      },
    ]) {
      const f = baselineRunFixture(expected, { automatic: true });
      mutate(f);
      await expect(f.verify(expected)).rejects.toThrow(failure);
    }
  });
  test("current repository, approval, main protection or selected job changes during readbacks refuse", async () => {
    for (const key of ["repository", "approval", "job", "main"]) {
      const f = baselineRunFixture(request);
      let jobs = 0;
      const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
        now: () => f.clock.now,
        get: async (get) => {
          if (get.url.includes("/attempts/1/jobs") && ++jobs === 2) {
            if (key === "repository") f.repository.id++;
            if (key === "approval") present(f.approvals[0]).state = "rejected";
            if (key === "job") f.apply.id++;
            if (key === "main")
              f.data["https://api.github.com/repos/deconfined/tarubot/branches/main"] = {
                name: "main",
                protected: true,
                commit: { sha: "c".repeat(40) },
              };
          }
          return f.get(get);
        },
      });
      await expect(verify(request)).rejects.toThrow(failure);
    }
  });
  test("redirects, partial/wrong/duplicate MIME, duplicate JSON, pagination and hostile errors produce fixed refusal", async () => {
    for (const mode of [
      "redirect",
      "mime",
      "charset",
      "duplicate-header",
      "duplicate-json",
      "pagination",
      "error",
    ]) {
      const f = baselineRunFixture(request);
      const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
        now: () => f.clock.now,
        get: async (get) => {
          if (mode === "error") throw new Error("invented private token and backend diagnostic");
          const result = await f.get(get);
          if (mode === "redirect") result.status = 302;
          if (mode === "mime")
            result.headers["content-type"] = "application/json; charset=utf-8,application/json";
          if (mode === "charset")
            result.headers["content-type"] = "application/json; charset=latin1";
          if (mode === "duplicate-header") result.headers["Content-Type"] = "application/json";
          if (mode === "duplicate-json")
            result.body = Buffer.from('{"id":234567,"\\u0069d":234567}');
          if (mode === "pagination") result.headers.link = "invented continuation";
          return result;
        },
      });
      await expect(verify(request)).rejects.toThrow(failure);
    }
  });
  test("caller echoes, serialization, other runs and expiry cannot reuse an execution capability", async () => {
    const f = baselineRunFixture(request);
    const proof = await f.verify(request);
    for (const value of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), true])
      expect(() => assertInfrastructureBaselineRunProof(value, request)).toThrow(failure);
    expect(() =>
      assertInfrastructureBaselineRunProof(proof, {
        ...request,
        run: { ...request.run, run: "23457" },
      }),
    ).toThrow(failure);
    f.clock.now += 30_000;
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).toThrow(failure);
  });
  test("configuration/request getters never run and pending callers cannot alter captured source identity", async () => {
    const f = baselineRunFixture(request);
    let getter = 0;
    const hostile = Object.defineProperty({ ...request }, "run", {
      enumerable: true,
      get() {
        getter++;
        return request.run;
      },
    });
    await expect(f.verify(hostile)).rejects.toThrow(failure);
    expect(getter).toBe(0);
    const mutable = structuredClone(request);
    const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
      now: () => f.clock.now,
      get: async (get) => {
        mutable.run.run = "98765";
        return f.get(get);
      },
    });
    const proof = await verify(mutable);
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).not.toThrow();
    expect(() => assertInfrastructureBaselineRunProof(proof, mutable)).toThrow(failure);
  });
  test("never-resolving injection is physically timed out, even with a frozen wall clock", async () => {
    const f = baselineRunFixture(request);
    let calls = 0;
    const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
      now: () => f.clock.now,
      get: async (get) => {
        if (++calls === 1) {
          f.clock.now += 59_990;
          return f.get(get);
        }
        return new Promise(() => {});
      },
    });
    await expect(verify(request)).rejects.toThrow(failure);
    expect(calls).toBe(2);
  });
  test("frozen-wall physical first-response age cannot be hidden or renewed by final readbacks", () => {
    // Isolated performance fixture advances without sleeps or changes to the parent runtime.
    const source = `
      import { performance } from "node:perf_hooks";
      let elapsed = 0;
      Object.defineProperty(performance, "now", { value: () => elapsed });
      const { baselineRunFixture } = await import(${JSON.stringify(new URL("../fixtures/infra/baseline-run.ts", import.meta.url).href)});
      const { createInfrastructureBaselineRunVerifier } = await import(${JSON.stringify(new URL("../../scripts/infra-baseline-run.ts", import.meta.url).href)});
      const request = ${JSON.stringify(request)};
      const f = baselineRunFixture(request);
      const verify = createInfrastructureBaselineRunVerifier(f.configuration, { now: () => f.clock.now, get: async input => { elapsed += 2500; return f.get(input); } });
      try { await verify(request); process.exit(1); } catch (error) { if (error.message !== ${JSON.stringify(failure)}) process.exit(2); }
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      env: { TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.byteLength).toBe(0);
    expect(child.stderr.byteLength).toBe(0);
  });
  test("optional callback only refuses and the original proof retains that exact refusal", async () => {
    for (const returned of [true, false, {}, Promise.resolve()]) {
      const f = baselineRunFixture(request);
      const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
        get: f.get,
        now: () => f.clock.now,
      });
      await expect(verify(request, (() => returned) as () => void)).rejects.toThrow(failure);
      expect(f.seen).toHaveLength(0);
    }
    const f = baselineRunFixture(request),
      verify = createInfrastructureBaselineRunVerifier(f.configuration, {
        get: f.get,
        now: () => f.clock.now,
      });
    let denied = false;
    const proof = await verify(request, () => {
      if (denied) throw new Error("invented-private-preparation-denial");
    });
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).not.toThrow();
    denied = true;
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).toThrow(failure);
    denied = false;
    // A fresh one-argument invocation remains compatible, but never rebinds the old proof.
    const fresh = await verify(request);
    expect(() => assertInfrastructureBaselineRunProof(fresh, request)).not.toThrow();
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).toThrow(failure);
  });
  test("scheduled mock GET cannot offer after its original refusal changes", async () => {
    const f = baselineRunFixture(request);
    let denied = false,
      samples = 0,
      offers = 0;
    const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
      now: () => f.clock.now,
      get: async (input) => {
        offers++;
        return f.get(input);
      },
    });
    await expect(
      verify(request, () => {
        if (++samples === 1)
          queueMicrotask(() => {
            denied = true;
          });
        if (denied) throw new Error("invented-original-budget-expired");
      }),
    ).rejects.toThrow(failure);
    expect(offers).toBe(0);
  });
  test("the actual-offer clock cannot consume its enclosing deadline before the last refusal", async () => {
    const f = baselineRunFixture(request);
    let denied = false,
      samples = 0,
      offers = 0;
    const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
      now: () => {
        // Initial, post-snapshot, scheduling and then actual-offer clock samples.
        if (++samples === 4) denied = true;
        return f.clock.now;
      },
      get: async (input) => {
        offers++;
        return f.get(input);
      },
    });
    await expect(
      verify(request, () => {
        if (denied) throw new Error("invented-shorter-original-deadline");
      }),
    ).rejects.toThrow(failure);
    expect(samples).toBe(4);
    expect(offers).toBe(0);
  });
  test("expired original preparation fences a held response without any NEXT mock GET or rebind", async () => {
    const f = baselineRunFixture(request);
    const release = {
      version: "2.36.24",
      commit: "a".repeat(40),
      config_commit: "a".repeat(40),
      digest: `sha256:${"e".repeat(64)}`,
      publication_run: "34567",
      schema_head: "010_invented.sql",
    };
    const preparation = prepareTargetCandidates(
      {
        targets: ["staging"],
        release,
        producer: {
          repository: "deconfined/tarubot",
          workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
          ref: "refs/heads/main",
          event: "push",
          attempt: 1,
          commit: release.commit,
          run: release.publication_run,
        },
        expires_at: baselineFixtureInstant + 2000,
      },
      { now: () => f.clock.now },
    );
    let held = false,
      announce!: () => void,
      resume!: () => void;
    const entered = new Promise<void>((resolve) => {
        announce = resolve;
      }),
      waiting = new Promise<void>((resolve) => {
        resume = resolve;
      }),
      offers: string[] = [];
    const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
      now: () => f.clock.now,
      get: async (input) => {
        offers.push(input.url);
        if (!held) {
          held = true;
          announce();
          await waiting;
        }
        return f.get(input);
      },
    });
    const old = withinTargetCandidatePreparation(preparation, () =>
      verify(request, () => assertTargetCandidatePreparation(preparation)),
    ).then(
      () => "unexpected-proof",
      (error: Error) => error.message,
    );
    await entered;
    expect(await old).toBe("invalid-target-candidate");
    const fresh = await verify(request);
    expect(() => assertInfrastructureBaselineRunProof(fresh, request)).not.toThrow();
    const count = offers.length;
    resume();
    await Bun.sleep(0);
    expect(offers).toHaveLength(count);
  });
  test("physical origin precedes the first clock and hostile request snapshot", () => {
    const source = `
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const {baselineRunFixture}=await import(${JSON.stringify(new URL("../fixtures/infra/baseline-run.ts", import.meta.url).href)});
      const {createInfrastructureBaselineRunVerifier}=await import(${JSON.stringify(new URL("../../scripts/infra-baseline-run.ts", import.meta.url).href)});
      const request=${JSON.stringify(request)};
      for(const phase of ["clock","input"]){
        elapsed=0;const f=baselineRunFixture(request);let first=true,offers=0;
        const verify=createInfrastructureBaselineRunVerifier(f.configuration,{now:()=>{if(phase==="clock"&&first){first=false;elapsed=60000;}return f.clock.now;},get:async input=>{offers++;return f.get(input);}});
        const input=phase==="input"?new Proxy(request,{ownKeys(target){elapsed=60000;return Reflect.ownKeys(target);}}):request;
        try{await verify(input);process.exit(1);}catch(error){if(error.message!==${JSON.stringify(failure)})process.exit(2);}
        if(offers!==0)process.exit(3);
      }
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      env: { TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.byteLength).toBe(0);
    expect(child.stderr.byteLength).toBe(0);
  });
  test("constructor captures the mock reader exactly once", async () => {
    const f = baselineRunFixture(request);
    let captures = 0;
    const dependencies = {
      now: () => f.clock.now,
      get get() {
        captures++;
        return captures === 1 ? f.get : undefined;
      },
    };
    const verify = createInfrastructureBaselineRunVerifier(
      f.configuration,
      dependencies as Parameters<typeof createInfrastructureBaselineRunVerifier>[1],
    );
    const proof = await verify(request);
    expect(captures).toBe(1);
    expect(f.seen.length).toBeGreaterThan(0);
    expect(() => assertInfrastructureBaselineRunProof(proof, request)).not.toThrow();
  });
  test("swallowed snapshot, clock and refusal reentry cannot restore an original proof", async () => {
    for (const phase of ["snapshot", "clock", "denial"]) {
      for (const matching of [false, true]) {
        const f = baselineRunFixture(request);
        let proof: unknown,
          enabled = false,
          refusals = 0;
        const reenter = () => {
          if (!enabled) return;
          enabled = false;
          const nested = matching ? request : { ...request, run: { ...request.run, run: "23457" } };
          try {
            assertInfrastructureBaselineRunProof(proof, nested);
          } catch {
            refusals++;
          }
        };
        const verify = createInfrastructureBaselineRunVerifier(f.configuration, {
          get: f.get,
          now: () => {
            if (phase === "clock") reenter();
            return f.clock.now;
          },
        });
        proof = await verify(request, () => {
          if (phase === "denial") reenter();
        });
        enabled = true;
        const expected =
          phase === "snapshot"
            ? new Proxy(request, {
                ownKeys(target) {
                  reenter();
                  return Reflect.ownKeys(target);
                },
              })
            : request;
        expect(() => assertInfrastructureBaselineRunProof(proof, expected)).toThrow(failure);
        expect(refusals).toBe(1);
        expect(() => assertInfrastructureBaselineRunProof(proof, request)).toThrow(failure);
      }
    }
  });
});

const codec = new RecordCodec(
  "invented baseline barrier passphrase with sufficient entropy",
  "a".repeat(64),
);
const before = stateEvidence({
  version: 4,
  terraform_version: "1.12.6",
  lineage: "11111111-1111-4111-8111-111111111111",
  serial: 10,
  resources: [],
  outputs: {},
});
const after = { ...before, serial: 11, digest: "c".repeat(64) };
class Memory implements ControlStore {
  data = new Map<string, Uint8Array>();
  writes: string[] = [];
  readHook: ((path: string) => void) | undefined;
  writeHook: ((path: string) => void) | undefined;
  async read(path: string) {
    this.readHook?.(path);
    const bytes = this.data.get(path);
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async write(path: string, bytes: Uint8Array) {
    this.writes.push(path);
    this.data.set(path, Uint8Array.from(bytes));
    this.writeHook?.(path);
  }
}
async function history() {
  const f = baselineRunFixture(request);
  const store = new Memory();
  const journal = new InfrastructureJournal(store, codec, { verifyBaselineRun: f.verify });
  const ticket = await journal.begin(
    await journal.inspect(before),
    { invented: "inputs" },
    request.run,
    "b".repeat(64),
    "baseline",
  );
  await journal.finish(ticket, before);
  return { f, store, journal, ticket };
}
describe("encrypted baseline and original execution binding", () => {
  test("final current PUT persisted then lost ACK cannot become authority from a failed original run", async () => {
    const f = baselineRunFixture(request);
    const store = new Memory();
    const journal = new InfrastructureJournal(store, codec, { verifyBaselineRun: f.verify });
    const ticket = await journal.begin(
      await journal.inspect(before),
      {},
      request.run,
      "b".repeat(64),
      "baseline",
    );
    store.writeHook = (path) => {
      if (
        path === "current" &&
        (codec.open(path, present(store.data.get(path))) as { pending: string | null }).pending ===
          null
      )
        throw new Error("invented lost final ACK");
    };
    await expect(journal.finish(ticket, before)).rejects.toThrow("invented lost final ACK");
    expect(codec.open("current", present(store.data.get("current")))).toEqual({
      baseline: ticket.generation,
      pending: null,
    });
    f.run.conclusion = "failure";
    const reopened = new InfrastructureJournal(store, codec, { verifyBaselineRun: f.verify });
    await expect(reopened.inspect(before)).rejects.toThrow(failure);
    const count = store.writes.length;
    await expect(
      reopened.begin(
        { generation: ticket.generation, state: before, inputs: {} },
        {},
        { commit: "c".repeat(40), run: "34567" },
        "d".repeat(64),
        "apply",
      ),
    ).rejects.toThrow(failure);
    expect(store.writes).toHaveLength(count);
  });
  test("finish structurally reopens while its own JOB is in progress; ordinary readers still wait for exact final success", async () => {
    const f = baselineRunFixture(request);
    f.run.status = "in_progress";
    f.run.conclusion = null;
    const store = new Memory();
    const journal = new InfrastructureJournal(store, codec, { verifyBaselineRun: f.verify });
    const ticket = await journal.begin(
      await journal.inspect(before),
      {},
      request.run,
      "b".repeat(64),
      "baseline",
    );
    await journal.finish(ticket, before);
    expect(f.seen).toHaveLength(0);
    await expect(journal.inspect(before)).rejects.toThrow(failure);
    f.run.status = "completed";
    f.run.conclusion = "success";
    expect((await journal.inspect(before)).generation).toBe(ticket.generation);
  });
  test("missing verifier and an invented proof echo refuse nonempty baseline reuse", async () => {
    const h = await history();
    await expect(new InfrastructureJournal(h.store, codec).inspect(before)).rejects.toThrow(
      "invalid-control-record",
    );
    const echo = new InfrastructureJournal(h.store, codec, {
      verifyBaselineRun: async () => ({}) as InfrastructureBaselineRunProof,
    });
    await expect(echo.inspect(before)).rejects.toThrow(failure);
  });
  test("same-plaintext ciphertext replacement or linked-record changes during proof refuse", async () => {
    for (const mode of ["same-plaintext", "completion", "current"]) {
      const h = await history();
      const verify = createInfrastructureBaselineRunVerifier(h.f.configuration, {
        now: () => h.f.clock.now,
        get: async (get) => {
          const path = mode === "completion" ? `completed/${h.ticket.generation}` : "current";
          const value =
            mode === "completion"
              ? { generation: h.ticket.generation, baseline: "f".repeat(64) }
              : mode === "current"
                ? { baseline: h.ticket.generation, pending: h.ticket.generation }
                : codec.open(path, present(h.store.data.get(path)));
          h.store.data.set(path, codec.seal(path, value));
          return h.f.get(get);
        },
      });
      await expect(
        new InfrastructureJournal(h.store, codec, { verifyBaselineRun: verify }).inspect(before),
      ).rejects.toThrow("invalid-control-record");
    }
  });
  test("begin retains the ORIGINAL proof through a persisted held write and refuses continuation after expiry", async () => {
    const h = await history();
    const snapshot = await h.journal.inspect(before);
    const count = h.store.writes.length;
    h.store.writeHook = (path) => {
      if (path.startsWith("intents/")) h.f.clock.now = baselineFixtureInstant + 30_000;
    };
    await expect(
      h.journal.begin(
        snapshot,
        { next: true },
        { commit: "c".repeat(40), run: "34567" },
        "d".repeat(64),
        "apply",
      ),
    ).rejects.toThrow(failure);
    expect(h.store.writes).toHaveLength(count + 1);
    expect(h.store.writes.at(-1)).toStartWith("intents/");
    // The persisted orphan is uncertain; no automatic retry or pending-reference write follows.
    expect(codec.open("current", present(h.store.data.get("current")))).toEqual({
      baseline: h.ticket.generation,
      pending: null,
    });
  });
  test("captured state/inputs/run/ticket reject getters and resist mutations across awaits", async () => {
    const h = await history();
    let calls = 0;
    const getter = Object.defineProperty({ ...before }, "digest", {
      enumerable: true,
      get() {
        calls++;
        return before.digest;
      },
    });
    await expect(h.journal.inspect(getter)).rejects.toThrow("invalid-control-record");
    expect(calls).toBe(0);
    const state = { ...before };
    const values = { next: "captured" };
    const nextRun = { commit: "c".repeat(40), run: "34567" };
    const snapshot = await h.journal.inspect(state);
    h.store.readHook = () => {
      state.digest = "f".repeat(64);
      values.next = "changed";
      nextRun.run = "98765";
    };
    const ticket = await h.journal.begin(snapshot, values, nextRun, "d".repeat(64), "apply");
    const saved = codec.open(
      `intents/${ticket.generation}`,
      present(h.store.data.get(`intents/${ticket.generation}`)),
    ) as { inputs: unknown; run: unknown };
    expect(saved.inputs).toEqual({ next: "captured" });
    expect(saved.run).toEqual({ commit: "c".repeat(40), run: "34567" });
    h.store.readHook = () => {
      ticket.generation = "22222222-2222-4222-8222-222222222222";
      after.digest = "e".repeat(64);
    };
    const expectedTicket = { ...ticket },
      expectedState = { ...after };
    await h.journal.finish(ticket, after);
    expect(
      codec.open(
        `baselines/${expectedTicket.generation}`,
        present(h.store.data.get(`baselines/${expectedTicket.generation}`)),
      ),
    ).toMatchObject({ state: expectedState });
  });
});
