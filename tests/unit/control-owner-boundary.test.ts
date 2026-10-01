import { verifyInventedBaselineRun } from "../fixtures/infra/baseline-run.js";
/** Invented GitHub configuration/run evidence and encrypted histories; no real credentials/API. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ControlConsumerGuard,
  guardedControlStore,
  type ControlConsumerScope,
} from "../../scripts/control-consumer.js";
import {
  GitHubControlOwnerBoundary,
  controlOwnerEnvironments,
  type ControlOwnerBoundaryConfiguration,
} from "../../scripts/control-owner-boundary.js";
import { ciphertextDigest, type VersionedControlStore } from "../../scripts/control-recovery.js";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  stateEvidence,
  type ControlStore,
} from "../../scripts/infra-control.js";
import { TrustJournal, canonicalEd25519, type ValidatorPin } from "../../scripts/ssh-trust.js";
import type { GitHubReader, GitHubReadRequest } from "../../scripts/trust-run.js";

const instant = 1_800_000_000_000;
const api = "https://api.github.com/repos/deconfined/tarubot";
const owner = { id: 123456, login: "deconfined" };
const repairGeneration = "11111111-1111-4111-8111-111111111111";
const revision = "22222222-2222-4222-8222-222222222222";
const trustGeneration = "33333333-3333-4333-8333-333333333333";
const run = { commit: "b".repeat(40), run: "12345" };
const pin: ValidatorPin = {
  name: "unbound",
  version: "1.26.1",
  mode: "local-validating",
  binary_sha256: "c".repeat(64),
  anchor_sha256: "d".repeat(64),
  runtime_manifest_sha256: "e".repeat(64),
};
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
type Value = Record<string, unknown>;
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}
function object(value: unknown): Value {
  if (!value || typeof value !== "object") throw new Error("missing-invented-object");
  return value as Value;
}
class Memory implements VersionedControlStore {
  data = new Map<string, Uint8Array>();
  reads: string[] = [];
  writes: string[] = [];
  versions = 0;
  async read(path: string): Promise<Uint8Array | null> {
    this.reads.push(path);
    const value = this.data.get(path);
    return value ? Uint8Array.from(value) : null;
  }
  async readVersion(path: string, _version: string): Promise<Uint8Array | null> {
    this.versions++;
    return this.read(path);
  }
  async write(path: string, value: Uint8Array): Promise<void> {
    this.writes.push(path);
    this.data.set(path, Uint8Array.from(value));
  }
}
function fixture(target: ControlConsumerScope["target"] = "infra") {
  const scope: ControlConsumerScope = {
    target,
    backend: "a".repeat(64),
    namespace: `tarubot/control/v1/${target === "infra" ? "infra" : `trust-${target}`}/`,
  };
  const common = {
    ...scope,
    passphrase: "invented private control passphrase with sufficient entropy",
    owner_id: owner.id,
    repository_id: 234567,
    environment_id: 1010,
    token: "invented_config_read_token_12345",
  };
  const configuration: ControlOwnerBoundaryConfiguration =
    target === "infra" ? { ...common, target } : { ...common, target, validator: pin };
  const store = new Memory();
  const name = controlOwnerEnvironments[target];
  const record: Value = { schema: 1, ...scope, revision, repair: { mode: "never-repaired" } };
  const variable = {
    name: "CONTROL_OWNER_ANCHOR",
    value: JSON.stringify(record),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const repo = {
    id: configuration.repository_id,
    full_name: "deconfined/tarubot",
    fork: false,
    owner,
  };
  const environment = {
    id: configuration.environment_id,
    name: String(name),
    url: `${api}/environments/${name}`,
  };
  const gateName = `recover-${target}`;
  const gate = {
    id: 2020,
    name: gateName,
    url: `${api}/environments/${gateName}`,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: owner }],
      },
    ],
  };
  const job = {
    id: 102,
    run_id: 12345,
    run_attempt: 1,
    head_sha: run.commit,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    name: target === "infra" ? "Recover infrastructure" : `Recover ${target} trust`,
    run_url: `${api}/actions/runs/12345`,
    steps: [
      { name: "Verify restored journal", number: 1, status: "completed", conclusion: "success" },
    ],
  };
  const publicRun = {
    id: 12345,
    head_sha: run.commit,
    head_branch: "main",
    event: "workflow_dispatch",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/control-recovery.yml",
    actor: owner,
    triggering_actor: owner,
    repository: repo,
    head_repository: repo,
    url: `${api}/actions/runs/12345`,
  };
  const data: Record<string, unknown> = {
    [api]: repo,
    [`${api}/environments/${name}`]: environment,
    [`${api}/environments/${name}/variables/CONTROL_OWNER_ANCHOR`]: variable,
    [`${api}/actions/runs/12345`]: publicRun,
    [`${api}/environments/${gateName}`]: gate,
    [`${api}/environments/${gateName}/deployment-branch-policies?per_page=100&page=1`]: {
      total_count: 1,
      branch_policies: [{ id: 101, name: "main", type: "branch" }],
    },
    [`${api}/branches/main`]: { name: "main", protected: true },
    [`${api}/actions/runs/12345/attempts/1/jobs?per_page=100&page=1`]: {
      total_count: 1,
      jobs: [job],
    },
    [`${api}/actions/runs/12345/approvals`]: [
      {
        state: "approved",
        user: owner,
        environments: [{ id: gate.id, name: gate.name, url: gate.url }],
      },
    ],
  };
  const seen: GitHubReadRequest[] = [];
  const get: GitHubReader = async (input) => {
    seen.push(structuredClone(input));
    if (!Object.hasOwn(data, input.url)) throw new Error("unexpected-invented-api-path");
    return {
      status: 200,
      url: input.url,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: Buffer.from(JSON.stringify(data[input.url])),
    };
  };
  const clock = { now: instant };
  const make = (
    overrides: Partial<ConstructorParameters<typeof GitHubControlOwnerBoundary>[1]> = {},
  ) =>
    new GitHubControlOwnerBoundary(configuration, {
      store,
      get,
      now: () => clock.now,
      ...overrides,
    });
  const sync = () => {
    variable.value = JSON.stringify(record);
  };
  return {
    target,
    scope,
    configuration,
    store,
    name,
    record,
    variable,
    repo,
    environment,
    gate,
    job,
    publicRun,
    data,
    seen,
    get,
    clock,
    make,
    sync,
  };
}
type Fixture = ReturnType<typeof fixture>;
async function refusal(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toThrow("invalid-control-owner-boundary");
}

function codec(f: Fixture): RecordCodec {
  return new RecordCodec(
    f.configuration.passphrase,
    f.target === "infra"
      ? f.scope.backend
      : privateDigest({
          purpose: "tarubot-ssh-trust-v1",
          target: f.target,
          backend: f.scope.backend,
        }),
  );
}
async function ordinaryHistory(f: Fixture, store: VersionedControlStore = f.store) {
  if (f.target === "infra") {
    const evidence = stateEvidence({
      version: 4,
      terraform_version: "1.12.6",
      lineage: "44444444-4444-4444-8444-444444444444",
      serial: 10,
      resources: [],
      outputs: {},
    });
    const values = {
      ...JSON.parse(
        readFileSync(
          new URL("../../ops/tofu/examples/example.tfvars.json", import.meta.url),
          "utf8",
        ),
      ),
      hosts: {},
      database_ids: {},
    };
    const journal = new InfrastructureJournal(store, codec(f), {
      verifyBaselineRun: verifyInventedBaselineRun,
    });
    const ticket = await journal.begin(
      await journal.inspect(evidence),
      values,
      run,
      "f".repeat(64),
      "baseline",
    );
    await journal.finish(ticket, evidence);
    return {
      desired: ticket.generation,
      inspect: async (replacement?: ControlStore) =>
        (replacement
          ? new InfrastructureJournal(replacement, codec(f), {
              verifyBaselineRun: verifyInventedBaselineRun,
            })
          : journal
        ).inspect(evidence),
    };
  }
  const target = f.target;
  const journal = new TrustJournal(store, {
    target,
    backend: f.scope.backend,
    passphrase: f.configuration.passphrase,
    validator: pin,
    now: () => f.clock.now,
  });
  const descriptor = {
    schema: 1 as const,
    target,
    provider: "linode" as const,
    instance_id: "100",
    fqdn: "host.example.org",
    addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
    dns_zone_id: "a".repeat(32),
    applied_generation: "55555555-5555-4555-8555-555555555555",
    state: { lineage: "66666666-6666-4666-8666-666666666666", serial: 12, digest: "b".repeat(64) },
  };
  const grant = {
    schema: 1 as const,
    target,
    generation: trustGeneration,
    previous: null,
    kind: "initial" as const,
    descriptor_digest: privateDigest(descriptor),
    run,
    approved_at: instant - 1000,
    expires_at: instant + 60_000,
  };
  await journal.recordAuthorization(grant);
  const round = [
    { address: descriptor.addresses.ipv4, key },
    { address: descriptor.addresses.ipv6, key },
  ];
  const ticket = await journal.begin(grant, descriptor, run, async () => ({
    schema: 1,
    observed_at: instant,
    rounds: [round, structuredClone(round)],
  }));
  const sshfp = canonicalEd25519(key).sshfp;
  const record = {
    id: "c".repeat(32),
    zone_id: descriptor.dns_zone_id,
    name: descriptor.fqdn,
    type: "SSHFP" as const,
    sshfp,
  };
  let written = false;
  const dns = {
    schema: 1 as const,
    validator: pin,
    name: descriptor.fqdn,
    type: "SSHFP" as const,
    secure: true as const,
    bogus: false as const,
    havedata: true as const,
    nxdomain: false as const,
    rcode: 0 as const,
    observed_at: instant,
    ttl: 300,
    expires_at: instant + 300_000,
    records: [sshfp],
  };
  await journal.publish(
    ticket,
    {
      read: async () => (written ? [record] : []),
      write: async () => {
        written = true;
        return record;
      },
    },
    async () => dns,
  );
  await journal.finish(ticket);
  return {
    desired: trustGeneration,
    inspect: async (replacement?: ControlStore) =>
      (replacement
        ? new TrustJournal(replacement, {
            target,
            backend: f.scope.backend,
            passphrase: f.configuration.passphrase,
            validator: pin,
            now: () => f.clock.now,
          })
        : journal
      ).inspect(descriptor),
  };
}
/** Construct invented already-completed repair metadata over actual complete journal bytes. */
async function completed(f: Fixture) {
  const history = await ordinaryHistory(f);
  const ordinary = codec(f);
  const manifest = [...f.store.data].map(([path, bytes]) => ({
    path,
    version: "invented-v1",
    ciphertext_sha256: ciphertextDigest(bytes),
    plaintext_digest: privateDigest(ordinary.open(path, bytes)),
    expected_latest_sha256: ciphertextDigest(bytes),
  }));
  const current = present(
    manifest.find(
      (entry) => entry.path === (f.target === "infra" ? "current" : `trust/${f.target}/current`),
    ),
  );
  const authorization = {
    schema: 1 as const,
    ...f.scope,
    generation: repairGeneration,
    desired_generation: history.desired,
    expected_current_sha256: current.ciphertext_sha256,
    expected_recovery_sha256: null,
    manifest_digest: privateDigest(manifest),
    outcome_digest: "f".repeat(64),
    run,
    approved_at: instant - 1000,
    expires_at: instant + 60_000,
  };
  const fence = {
    schema: 1,
    ...f.scope,
    generation: repairGeneration,
    authorization_digest: privateDigest(authorization),
    manifest_digest: authorization.manifest_digest,
    expected_current_sha256: authorization.expected_current_sha256,
    expected_recovery_sha256: null,
    run,
    fence_digest: "f".repeat(64),
    expires_at: authorization.expires_at,
  };
  const intent = {
    schema: 1,
    authorization,
    manifest,
    fence,
    previous: null,
    started_at: instant - 1,
  };
  const intentDigest = privateDigest(intent);
  const metadata = new RecordCodec(
    f.configuration.passphrase,
    privateDigest({ purpose: "tarubot-control-recovery-v1", ...f.scope }),
  );
  for (const [suffix, value] of Object.entries({
    registration: { schema: 1, generation: repairGeneration, intent_digest: intentDigest },
    current: {
      schema: 1,
      generation: repairGeneration,
      pending: false,
      intent_digest: intentDigest,
    },
    [`intents/${repairGeneration}`]: intent,
    [`completed/${repairGeneration}`]: {
      schema: 1,
      generation: repairGeneration,
      intent_digest: intentDigest,
      restored_digest: privateDigest(manifest.map((e) => [e.path, e.ciphertext_sha256]).sort()),
      finished_at: instant,
    },
  })) {
    const path = `recovery/${f.target}/${suffix}`;
    f.store.data.set(path, metadata.seal(path, value));
  }
  f.record.repair = {
    mode: "completed-repair",
    generation: repairGeneration,
    intent_digest: intentDigest,
    ...run,
  };
  f.sync();
  return { history, metadata, intent };
}

describe("independently current owner control configuration", () => {
  test("the same refusal runs after clocks and queued preparation before an actual GitHub offer", async () => {
    for (const queued of [false, true]) {
      const f = fixture();
      let live = true,
        calls = 0;
      const boundary = f.make({
        now: () => {
          calls++;
          if (queued && calls === 1)
            queueMicrotask(() => {
              live = false;
            });
          else if (!queued && calls === 4) live = false;
          return instant;
        },
      });
      await refusal(
        boundary.readOwnerAnchor(f.scope, () => {
          if (!live) throw new Error("private-original-window");
        }),
      );
      expect(f.seen).toHaveLength(0);
    }
    for (const value of [
      true,
      false,
      {},
      Promise.resolve(),
      Promise.reject(new Error("private-refusal")),
    ]) {
      const f = fixture();
      await refusal(f.make().readOwnerAnchor(f.scope, (() => value) as () => void));
      expect(f.seen).toHaveLength(0);
    }
  });
  test("swallowed nested clock, snapshot and response denials fence the owning boundary", async () => {
    for (const phase of ["clock", "snapshot", "response"] as const) {
      for (const wrong of [false, true]) {
        const f = fixture();
        let boundary: GitHubControlOwnerBoundary;
        let nested = true;
        const reenter = () => {
          if (!nested) return;
          nested = false;
          void boundary
            .readOwnerAnchor(wrong ? { ...f.scope, target: "production" } : f.scope)
            .catch(() => {});
        };
        boundary = f.make({
          now: () => {
            if (phase === "clock") reenter();
            return instant;
          },
          get: async (request) => {
            const response = await f.get(request);
            if (phase === "response")
              Object.defineProperty(response, "body", {
                get() {
                  reenter();
                  return Buffer.from(JSON.stringify(f.data[request.url]));
                },
              });
            return response;
          },
        });
        const scope =
          phase === "snapshot"
            ? new Proxy(f.scope, {
                ownKeys(value) {
                  reenter();
                  return Reflect.ownKeys(value);
                },
              })
            : f.scope;
        await refusal(boundary.readOwnerAnchor(scope));
        expect(f.seen).toHaveLength(phase === "response" ? 1 : 0);
      }
    }
  });
  test("first clock and caller snapshot costs consume the original physical budget", () => {
    for (const phase of ["clock", "snapshot"]) {
      const f = fixture();
      const modulePath = new URL("../../scripts/control-owner-boundary.ts", import.meta.url)
        .pathname;
      const program = `
        import { performance } from "node:perf_hooks";
        const input = ${JSON.stringify({ configuration: f.configuration, scope: f.scope, phase })};
        let elapsed = 0, gets = 0, calls = 0, code;
        Object.defineProperty(performance, "now", { value: () => elapsed });
        const { GitHubControlOwnerBoundary } = await import(${JSON.stringify(modulePath)});
        const boundary = new GitHubControlOwnerBoundary(input.configuration, {
          store: { read: async () => null, write: async () => {}, readVersion: async () => null },
          now: () => { if (input.phase === "clock" && ++calls === 1) elapsed = 60000; return ${instant}; },
          get: async () => { gets++; throw Error("unexpected-native-offer"); },
        });
        const scope = input.phase === "snapshot" ? new Proxy(input.scope, {
          ownKeys(value) { elapsed = 60000; return Reflect.ownKeys(value); },
        }) : input.scope;
        try { await boundary.readOwnerAnchor(scope); code = "accepted"; } catch(error) { code = error.message; }
        console.log(JSON.stringify({ gets, code }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(Buffer.from(child.stderr).toString()).toBe("");
      expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
        gets: 0,
        code: "invalid-control-owner-boundary",
      });
    }
  });
  test("native HTTP end and response callbacks retain the refusal without opening a connection", () => {
    for (const phase of ["valid", "end-getter", "response", "data", "headers", "nested-headers"]) {
      const f = fixture();
      const modulePath = new URL("../../scripts/control-owner-boundary.ts", import.meta.url)
        .pathname;
      const program = `
        import { spyOn } from "bun:test";
        import * as https from "node:https";
        import { EventEmitter } from "node:events";
        const input = ${JSON.stringify({ configuration: f.configuration, scope: f.scope, data: f.data, phase })};
        let live = true, offers = 0, ends = 0, headerReads = 0, code;
        let boundary;
        const request = (options, accept) => {
          offers++;
          const handle = new EventEmitter();
          handle.destroy = () => {};
          Object.defineProperty(handle, "end", { get() {
            if (input.phase === "end-getter") live = false;
            return () => {
              ends++;
              queueMicrotask(() => {
                const response = new EventEmitter();
                response.destroy = () => {};
                response.complete = true;
                response.statusCode = 200;
                Object.defineProperty(response, "rawHeaders", { get() {
                  headerReads++;
                  if (input.phase === "headers") live = false;
                  if (input.phase === "nested-headers") void boundary.readOwnerAnchor(input.scope).catch(() => {});
                  return ["content-type", "application/json"];
                } });
                if (input.phase === "response") live = false;
                accept(response);
                if (input.phase === "data") live = false;
                response.emit("data", Buffer.from(JSON.stringify(input.data["https://api.github.com" + options.path])));
                response.emit("end");
              });
            };
          } });
          return handle;
        };
        const patched = spyOn(https, "request").mockImplementation(request);
        // Refuse to import/run the native adapter unless the transport is exactly our fake.
        const transport = await import("node:https");
        if (transport.request !== patched || https.request !== patched) throw Error("fake transport not installed");
        const { GitHubControlOwnerBoundary } = await import(${JSON.stringify(modulePath)});
        boundary = new GitHubControlOwnerBoundary(input.configuration, {
          store: { read: async () => null, write: async () => {}, readVersion: async () => null },
          now: () => ${instant},
        });
        try { await boundary.readOwnerAnchor(input.scope, () => { if (!live) throw Error("private-expired"); }); code = "accepted"; }
        catch(error) { code = error.message; }
        console.log(JSON.stringify({ offers, ends, headerReads, code }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ exit: child.exitCode, diagnostic: Buffer.from(child.stderr).toString() }).toEqual({
        exit: 0,
        diagnostic: "",
      });
      expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
        offers: phase === "valid" ? 6 : 1,
        ends: phase === "end-getter" ? 0 : phase === "valid" ? 6 : 1,
        headerReads: phase === "valid" ? 6 : ["headers", "nested-headers"].includes(phase) ? 1 : 0,
        code: phase === "valid" ? "accepted" : "invalid-control-owner-boundary",
      });
    }
  });
  test("all completed-repair metadata reads retain the original pure owner window without extra GETs", async () => {
    const f = fixture();
    await completed(f);
    const calls: { path: string; refusal: (() => void) | undefined }[] = [];
    const read = f.store.read.bind(f.store);
    f.store.read = async (path, refusal?: () => void) => {
      refusal?.();
      calls.push({ path, refusal });
      const bytes = await read(path);
      refusal?.();
      return bytes;
    };
    let live = true;
    const boundary = f.make();
    await boundary.confirmCompletedRepair({ ...f.scope, generation: repairGeneration }, () => {
      if (!live) throw new Error("private-original-window");
    });
    expect(f.seen.length).toBeGreaterThan(0);
    const gets = f.seen.length;
    const paths = calls.map((entry) => entry.path);
    for (const suffix of [
      "registration",
      "current",
      `intents/${repairGeneration}`,
      `completed/${repairGeneration}`,
    ])
      expect(paths).toContain(`recovery/infra/${suffix}`);
    expect(calls.every((entry) => typeof entry.refusal === "function")).toBe(true);
    live = false;
    for (const entry of calls) expect(() => entry.refusal?.()).toThrow();
    live = true;
    // A later call has its own window, but cannot restore any abandoned original callback.
    await boundary.readOwnerAnchor(f.scope);
    expect(f.seen).toHaveLength(gets + 6);
    for (const entry of calls) expect(() => entry.refusal?.()).toThrow();
  });
  test("a final owner mismatch permanently fences already accepted repair metadata callbacks", async () => {
    const f = fixture();
    await completed(f);
    const callbacks: (() => void)[] = [];
    const read = f.store.read.bind(f.store);
    let currentReads = 0;
    f.store.read = async (path, refusal?: () => void) => {
      if (refusal) callbacks.push(refusal);
      const bytes = await read(path);
      if (path === "recovery/infra/current" && ++currentReads === 2) {
        f.record.revision = "77777777-7777-4777-8777-777777777777";
        f.sync();
      }
      return bytes;
    };
    const boundary = f.make();
    await refusal(boundary.confirmCompletedRepair({ ...f.scope, generation: repairGeneration }));
    expect(callbacks.length).toBeGreaterThan(0);
    for (const callback of callbacks) expect(callback).toThrow("invalid-control-owner-boundary");
    await boundary.readOwnerAnchor(f.scope);
    for (const callback of callbacks) expect(callback).toThrow("invalid-control-owner-boundary");
  });
  test("all targets require explicit scoped current variables and compatible bounded public anchor shape", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target),
        boundary = f.make();
      const anchor = await boundary.readOwnerAnchor(f.scope);
      expect(anchor).toEqual({
        schema: 1,
        ...f.scope,
        revision,
        repair: { mode: "never-repaired" },
        observed_at: instant,
        expires_at: expect.any(Number),
      });
      expect(anchor.expires_at).toBeGreaterThan(instant);
      expect(anchor.expires_at).toBeLessThanOrEqual(instant + 30_000);
      expect(Object.isFrozen(anchor.repair)).toBe(true);
      expect(f.seen.map((r) => r.url)).toEqual([
        api,
        `${api}/environments/${f.name}`,
        `${api}/environments/${f.name}/variables/CONTROL_OWNER_ANCHOR`,
        api,
        `${api}/environments/${f.name}`,
        `${api}/environments/${f.name}/variables/CONTROL_OWNER_ANCHOR`,
      ]);
      expect(
        f.seen.every(
          (r) =>
            r.method === "GET" &&
            r.redirect === "error" &&
            r.headers.Authorization === `Bearer ${f.configuration.token}` &&
            !r.url.includes(f.configuration.token),
        ),
      ).toBe(true);
      expect(f.store.reads).toHaveLength(0);
      expect(f.store.writes).toHaveLength(0);
    }
  });

  test("404/304 absence and stale snapshots never establish bootstrap or cached authority", async () => {
    for (const status of [404, 304, 302, 503]) {
      const f = fixture();
      await refusal(
        f
          .make({
            get: async (r) => ({
              status,
              url: r.url,
              headers: { "content-type": "application/json" },
              body: Buffer.from("{}"),
            }),
          })
          .readOwnerAnchor(f.scope),
      );
    }
    const f = fixture(),
      boundary = f.make();
    await boundary.readOwnerAnchor(f.scope);
    f.record.repair = { mode: "repairing", generation: repairGeneration };
    f.record.revision = "44444444-4444-4444-8444-444444444444";
    f.sync();
    expect((await boundary.readOwnerAnchor(f.scope)).repair.mode).toBe("repairing");
    f.record.revision = revision;
    f.record.repair = { mode: "never-repaired" };
    f.sync();
    await refusal(boundary.readOwnerAnchor(f.scope));
  });

  test("private fields cannot change under the same owner revision, even though public12 shape hides them", async () => {
    const f = fixture();
    await completed(f);
    const boundary = f.make();
    await boundary.readOwnerAnchor(f.scope);
    object(f.record.repair).intent_digest = "e".repeat(64);
    f.sync();
    await refusal(boundary.readOwnerAnchor(f.scope));
    const metadata = fixture(),
      reader = metadata.make();
    await reader.readOwnerAnchor(metadata.scope);
    metadata.variable.updated_at = "2026-01-02T00:00:00Z";
    await refusal(reader.readOwnerAnchor(metadata.scope));
  });

  test("repo/owner/environment IDs, namespace, revision, shape and exact variable identity all refuse", async () => {
    const changes: ((f: Fixture) => void)[] = [
      (f) => {
        f.repo.id++;
      },
      (f) => {
        f.repo.owner = { ...owner, id: 654321 };
      },
      (f) => {
        f.repo.fork = true;
      },
      (f) => {
        f.environment.id++;
      },
      (f) => {
        f.environment.name = "control-other";
      },
      (f) => {
        f.environment.url = "https://example.org";
      },
      (f) => {
        f.variable.name = "OTHER";
      },
      (f) => {
        f.record.backend = "b".repeat(64);
        f.sync();
      },
      (f) => {
        f.record.namespace = "tarubot/control/v1/trust-staging/";
        f.sync();
      },
      (f) => {
        f.record.revision = "bad";
        f.sync();
      },
      (f) => {
        f.record.extra = true;
        f.sync();
      },
      (f) => {
        f.variable.updated_at = "2099-01-01T00:00:00Z";
      },
      (f) => {
        f.variable.value = '{"schema":2,"s\\u0063hema":1}';
      },
      (f) => {
        f.record.repair = {};
        f.sync();
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await refusal(f.make().readOwnerAnchor(f.scope));
    }
  });

  test("configuration changes during either round refuse before returning current authority", async () => {
    for (const phase of ["first", "final"] as const) {
      const f = fixture();
      let calls = 0;
      await refusal(
        f
          .make({
            get: async (r) => {
              const response = await f.get(r);
              calls++;
              if (calls === (phase === "first" ? 3 : 4)) {
                f.record.revision = "44444444-4444-4444-8444-444444444444";
                f.sync();
              }
              return response;
            },
          })
          .readOwnerAnchor(f.scope),
      );
    }
  });

  // Every real encrypted journal read invokes both guards across all three scopes; the explicit
  // test bound accommodates password derivation without mocking the production crypto checks.
  test("actual completed encrypted history and independently matching owner-approved final recovery permit all targets", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target);
      const { history } = await completed(f);
      const initialWrites = f.store.writes.length;
      f.store.reads = [];
      const boundary = f.make();
      await boundary.confirmCompletedRepair({ ...f.scope, generation: repairGeneration });
      expect(f.seen.some((r) => r.url === `${api}/actions/runs/${run.run}`)).toBe(true);
      expect(f.store.reads.every((path) => path.startsWith(`recovery/${target}/`))).toBe(true);
      expect(f.store.versions).toBe(0);
      expect(f.store.writes).toHaveLength(initialWrites);
      const guard = new ControlConsumerGuard(f.scope, {
        store: f.store,
        owner: boundary,
        now: () => instant,
      });
      expect((await history.inspect(guardedControlStore(f.store, guard))).generation).toBe(
        history.desired,
      );
    }
  }, 20_000);

  test("a generic successful run cannot authenticate a different private intent, generation or run", async () => {
    for (const field of ["intent_digest", "generation", "commit", "run"] as const) {
      const f = fixture();
      await completed(f);
      object(f.record.repair)[field] =
        field === "generation"
          ? trustGeneration
          : field === "commit"
            ? "c".repeat(40)
            : field === "run"
              ? "12346"
              : "c".repeat(64);
      f.sync();
      await refusal(f.make().confirmCompletedRepair({ ...f.scope, generation: repairGeneration }));
      expect(f.seen.some((r) => r.url.includes("/actions/runs/"))).toBe(false);
    }
  });

  test("missing/pending/corrupt completion cannot be excused by successful owner run evidence", async () => {
    for (const phase of ["absent", "pending", "corrupt"] as const) {
      const f = fixture();
      const { metadata } = await completed(f);
      const path = "recovery/infra/current";
      if (phase === "absent") f.store.data.delete("recovery/infra/registration");
      if (phase === "pending") {
        const value = object(metadata.open(path, present(f.store.data.get(path))));
        value.pending = true;
        f.store.data.set(path, metadata.seal(path, value));
      }
      if (phase === "corrupt")
        f.store.data.set(
          `recovery/infra/completed/${repairGeneration}`,
          Uint8Array.from([1, 2, 3]),
        );
      await refusal(f.make().confirmCompletedRepair({ ...f.scope, generation: repairGeneration }));
      expect(f.seen.some((r) => r.url.includes("/actions/runs/"))).toBe(false);
    }
  });

  test("actual final-run approval, attempt, source, repository and critical-step failures remain fatal", async () => {
    for (const phase of ["failure", "rerun", "nonowner", "step", "repo", "approval"] as const) {
      const f = fixture();
      await completed(f);
      if (phase === "failure") f.publicRun.conclusion = "failure";
      if (phase === "rerun") f.publicRun.run_attempt = 2;
      if (phase === "nonowner") f.publicRun.actor = { ...owner, id: 654321 };
      if (phase === "step") present(f.job.steps[0]).name = "Other step";
      if (phase === "repo") f.publicRun.head_repository = { ...f.repo, id: 654321 };
      if (phase === "approval") f.data[`${api}/actions/runs/12345/approvals`] = [];
      await refusal(f.make().confirmCompletedRepair({ ...f.scope, generation: repairGeneration }));
    }
  });

  test("whole owner record must remain unchanged after final GitHub proof, including hidden same-revision fields", async () => {
    for (const phase of ["private", "revision", "metadata"] as const) {
      const f = fixture();
      await completed(f);
      let mutated = false;
      await refusal(
        f
          .make({
            get: async (r) => {
              const response = await f.get(r);
              if (!mutated && r.url.includes("/actions/runs/")) {
                mutated = true;
                if (phase === "private") object(f.record.repair).intent_digest = "e".repeat(64);
                if (phase === "revision")
                  f.record.revision = "44444444-4444-4444-8444-444444444444";
                if (phase === "metadata") f.variable.updated_at = "2026-01-02T00:00:00Z";
                f.sync();
              }
              return response;
            },
          })
          .confirmCompletedRepair({ ...f.scope, generation: repairGeneration }),
      );
    }
  });

  test("actual ordinary infra and trust journals use owner-guarded access, with repairing denying further I/O", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target),
        boundary = f.make();
      const guard = new ControlConsumerGuard(f.scope, {
        store: f.store,
        owner: boundary,
        now: () => f.clock.now,
      });
      const store = guardedControlStore(f.store, guard);
      const history = await ordinaryHistory(f, {
        ...store,
        readVersion: async () => {
          throw new Error("unused-invented-version-read");
        },
      });
      expect((await history.inspect()).generation).toBe(history.desired);
      f.record.repair = { mode: "repairing", generation: repairGeneration };
      f.record.revision = "44444444-4444-4444-8444-444444444444";
      f.sync();
      const writes = f.store.writes.length;
      await expect(
        store.write(
          target === "infra" ? "current" : `trust/${target}/current`,
          Uint8Array.from([1, 2, 3]),
        ),
      ).rejects.toThrow("control-consumer-write-failed");
      expect(f.store.writes).toHaveLength(writes);
    }
  });

  test("configuration, scope and raw-reader capabilities are snapshotted and private across awaits", async () => {
    const f = fixture();
    await completed(f);
    const dependencies = { store: f.store, get: f.get, now: () => instant };
    const boundary = new GitHubControlOwnerBoundary(f.configuration, dependencies);
    const request = { ...f.scope, generation: repairGeneration };
    let changed = false;
    const original = f.store.read.bind(f.store);
    f.store.read = async () => {
      throw new Error("invented-shadow-read");
    };
    dependencies.get = async () => {
      throw new Error("invented-shadow-token");
    };
    f.configuration.passphrase = "wrong passphrase which must never replace the captured one";
    await boundary.confirmCompletedRepair(request);
    expect(f.store.reads.length).toBeGreaterThan(0);
    f.store.read = original;
    const safe = fixture();
    const operation = safe
      .make({
        get: async (r) => {
          const response = await safe.get(r);
          if (!changed) {
            changed = true;
            safe.scope.backend = "c".repeat(64);
          }
          return response;
        },
      })
      .readOwnerAnchor(safe.scope);
    expect((await operation).backend).toBe("a".repeat(64));
    expect(JSON.stringify(boundary)).toBe("{}");
    expect(Bun.inspect(boundary)).not.toContain("invented_config_read_token");
    expect(Object.isFrozen(boundary)).toBe(true);
  });

  test("HTTP ambiguity, duplicate JSON, oversized bodies, compression and diagnostics refuse privately", async () => {
    const f = fixture();
    const response = await f.get({
      url: api,
      method: "GET",
      headers: {},
      timeout_ms: 1000,
      body_limit: 1_048_576,
      redirect: "error",
    });
    for (const change of [
      { headers: { "content-type": "application/json; charset=utf-8,application/json" } },
      { headers: { "content-type": "application/json", "Content-Type": "application/json" } },
      { headers: { "content-type": "application/json", "content-encoding": "gzip" } },
      { headers: { "content-type": "application/json", age: "1" } },
      { body: Buffer.alloc(1_048_577) },
      { body: Buffer.from([0xc0, 0xaf]) },
      { body: Buffer.from('{"id":1,"i\\u0064":234567}') },
    ])
      await refusal(
        f.make({ get: async () => ({ ...response, ...change }) }).readOwnerAnchor(f.scope),
      );
    await expect(
      f
        .make({
          get: async () => {
            throw new Error("invented-private-token-and-address-diagnostic");
          },
        })
        .readOwnerAnchor(f.scope),
    ).rejects.toThrow(/^invalid-control-owner-boundary$/u);
  });

  test("frozen wall clocks cannot extend physical budgets, oldest anchor freshness or unresolved GET", () => {
    for (const phase of [
      "operation",
      "freshness",
      "first-get-age",
      "remaining",
      "unresolved",
    ] as const) {
      const f = fixture();
      const modulePath = new URL("../../scripts/control-owner-boundary.ts", import.meta.url)
        .pathname;
      // Isolate the test-only monotonic clock replacement. Only invented HTTPS data is used.
      const program = `
        import { performance } from "node:perf_hooks";
        const input = ${JSON.stringify({ configuration: f.configuration, scope: f.scope, data: f.data, phase })};
        let elapsed = 0, gets = 0, clockCalls = 0, code = "unexpected-success", expiry = null;
        Object.defineProperty(performance, "now", { value: () => elapsed });
        const { GitHubControlOwnerBoundary } = await import(${JSON.stringify(modulePath)});
        const boundary = new GitHubControlOwnerBoundary(input.configuration, {
          store: { read: async () => null, write: async () => { throw Error("unexpected-write"); }, readVersion: async () => null },
          now: () => { clockCalls++; if (input.phase === "unresolved" && clockCalls > 1) elapsed = 59990; return ${instant}; },
          get: async request => {
            gets++;
            if (input.phase === "unresolved") return new Promise(() => {});
            elapsed = input.phase === "operation" ? 60001 : input.phase === "first-get-age"
              ? elapsed + [8000,5000,5000,8000,5000,5000][gets-1]
              : gets * (input.phase === "freshness" ? 6000 : 2000);
            return { status: 200, url: request.url, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(input.data[request.url])) };
          },
        });
        try { const anchor = await boundary.readOwnerAnchor(input.scope); code = "verified"; expiry = anchor.expires_at; }
        catch (error) { code = error.message; }
        console.log(JSON.stringify({ gets, code, expiry }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(Buffer.from(child.stderr).toString()).toBe("");
      expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
        gets: phase === "operation" || phase === "unresolved" ? 1 : 6,
        code: phase === "remaining" ? "verified" : "invalid-control-owner-boundary",
        expiry: phase === "remaining" ? instant + 18000 : null,
      });
    }
  });

  test("accessors and invalid configuration fail before authority I/O; late wall clocks fail fixed", async () => {
    const f = fixture();
    let calls = 0;
    Object.defineProperty(f.configuration, "passphrase", {
      enumerable: true,
      get: () => {
        calls++;
        return "invented getter passphrase with sufficient entropy";
      },
    });
    expect(() => f.make()).toThrow("invalid-control-owner-boundary");
    expect(calls).toBe(0);
    expect(f.seen).toHaveLength(0);
    const target = fixture(),
      request = { ...target.scope };
    Object.defineProperty(request, "backend", {
      enumerable: true,
      get: () => {
        calls++;
        return "a".repeat(64);
      },
    });
    await refusal(target.make().readOwnerAnchor(request));
    expect(calls).toBe(0);
    const late = fixture();
    await refusal(
      late
        .make({
          get: async (r) => {
            const response = await late.get(r);
            late.clock.now = instant + 60_000;
            return response;
          },
        })
        .readOwnerAnchor(late.scope),
    );
    const reversed = fixture();
    await refusal(
      reversed
        .make({
          get: async (r) => {
            const response = await reversed.get(r);
            reversed.clock.now--;
            return response;
          },
        })
        .readOwnerAnchor(reversed.scope),
    );
  });
});
