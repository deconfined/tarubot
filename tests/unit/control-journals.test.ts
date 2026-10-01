import { verifyInventedBaselineRun, baselineRunFixture } from "../fixtures/infra/baseline-run.js";
/** Factory tests use invented native streams/GitHub responses and genuine encrypted histories. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ControlConsumerScope } from "../../scripts/control-consumer.js";
import {
  controlOwnerEnvironments,
  type ControlOwnerBoundaryConfiguration,
} from "../../scripts/control-owner-boundary.js";
import {
  createControlJournal,
  type ControlJournalConfiguration,
} from "../../scripts/control-journals.js";
import { ciphertextDigest, type VersionedControlStore } from "../../scripts/control-recovery.js";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  stateEvidence,
  type ControlStore,
  type Snapshot,
} from "../../scripts/infra-control.js";
import {
  TrustJournal,
  canonicalEd25519,
  type ValidatorPin,
  type TargetDescriptor,
  type DnssecEvidence,
} from "../../scripts/ssh-trust.js";
import type { GitHubReader, GitHubReadRequest } from "../../scripts/trust-run.js";
import {
  targetCandidatePreparation,
  type TargetCandidatePreparation,
} from "../../scripts/target-candidate.js";
import { candidateRelease, candidateProducer } from "../fixtures/infra/applied-target.js";

const instant = 1_800_000_000_000;
const api = "https://api.github.com/repos/deconfined/tarubot";
const owner = { id: 123456, login: "deconfined" };
const repairGeneration = "11111111-1111-4111-8111-111111111111";
const revision = "22222222-2222-4222-8222-222222222222";
const trustGeneration = "33333333-3333-4333-8333-333333333333";
const run = { commit: "b".repeat(40), run: "12345" };
// Ordinary baseline execution and the independent repair run are distinct source jobs.
const baselineRun = { commit: "b".repeat(40), run: "23456" };
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
    backend:
      target === "infra"
        ? privateDigest({
            backend: "invented exact backend.hcl bytes\n",
            key: "tarubot/infra.tfstate",
          })
        : "a".repeat(64),
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
  if (target === "infra")
    Object.assign(data, baselineRunFixture({ kind: "baseline", run: baselineRun }).data);
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
    sync,
  };
}
type Fixture = ReturnType<typeof fixture>;

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
async function ordinaryHistory(
  f: Fixture,
  store: VersionedControlStore = f.store,
  factoryJournal?: InfrastructureJournal | TrustJournal,
) {
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
    const journal = factoryJournal
      ? (factoryJournal as InfrastructureJournal)
      : new InfrastructureJournal(store, codec(f), {
          verifyBaselineRun: verifyInventedBaselineRun,
        });
    const ticket = await journal.begin(
      await journal.inspect(evidence),
      values,
      baselineRun,
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
  const journal = factoryJournal
    ? (factoryJournal as TrustJournal)
    : new TrustJournal(store, {
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

/** Real scoped storage is exercised through native-shaped invented clients, not a store override. */
function nativeFixture(target: ControlConsumerScope["target"] = "infra") {
  const f = fixture(target);
  const c = f.configuration;
  const common = {
    backend: c.backend,
    passphrase: c.passphrase,
    owner: {
      owner_id: c.owner_id,
      repository_id: c.repository_id,
      environment_id: c.environment_id,
      token: c.token,
    },
    storage: {
      scope: target === "infra" ? ("infra" as const) : (`trust-${target}` as const),
      bucket: "invented-journal-bucket",
      endpoint: "https://region.example.org",
      region: "us-east-1",
      credentials: {
        accessKeyId: "invented_access",
        secretAccessKey: "invented-secret-marker",
        sessionToken: null,
      },
    },
  };
  const configuration: ControlJournalConfiguration = structuredClone(
    target === "infra" ? { ...common, target } : { ...common, target, validator: pin },
  );
  const calls: Array<{ method: string; key: string; retry?: number | undefined }> = [];
  const constructed: Bun.S3Options[] = [];
  let beforeRead: (key: string) => Promise<void> = async () => {};
  let afterWrite: (key: string) => Promise<void> = async () => {};
  let readError: unknown = null;
  const createClient = (options: Bun.S3Options) => {
    constructed.push(structuredClone(options));
    const logical = (key: string) => {
      if (!key.startsWith(f.scope.namespace)) throw new Error("invented-wrong-namespace");
      return key.slice(f.scope.namespace.length);
    };
    return {
      presign(key: string) {
        calls.push({ method: "presign", key });
        const url = new URL(`${options.endpoint}/${key}`);
        url.searchParams.set("X-Amz-Date", "20260930T000000Z");
        url.searchParams.set(
          "X-Amz-Credential",
          `${options.accessKeyId}/20260930/${options.region}/s3/aws4_request`,
        );
        if (options.sessionToken)
          url.searchParams.set("X-Amz-Security-Token", options.sessionToken);
        return url.toString();
      },
      file(key: string, readOptions: Bun.S3Options) {
        calls.push({ method: "read", key, retry: readOptions.retry });
        const path = logical(key);
        return {
          stream: () =>
            new ReadableStream<Uint8Array>({
              async start(controller) {
                try {
                  await beforeRead(path);
                  if (readError !== null) throw readError;
                  const value = f.store.data.get(path);
                  if (!value)
                    throw Object.assign(new Error("invented-absent"), { code: "NoSuchKey" });
                  controller.enqueue(Uint8Array.from(value));
                  controller.close();
                } catch (error) {
                  controller.error(error);
                }
              },
            }),
        };
      },
      async write(key: string, bytes: Uint8Array, writeOptions: Bun.S3Options) {
        calls.push({ method: "write", key, retry: writeOptions.retry });
        const path = logical(key);
        f.store.data.set(path, Uint8Array.from(bytes));
        await afterWrite(path);
        return bytes.byteLength;
      },
    } as unknown as Bun.S3Client;
  };
  const dependencies = { createClient, get: f.get, now: () => f.clock.now };
  const make = () => createControlJournal(configuration, dependencies);
  return {
    ...f,
    config: configuration,
    dependencies,
    calls,
    constructed,
    make,
    beforeRead: (callback: typeof beforeRead) => {
      beforeRead = callback;
    },
    afterWrite: (callback: typeof afterWrite) => {
      afterWrite = callback;
    },
    readError: (error: unknown) => {
      readError = error;
    },
  };
}
type NativeFixture = ReturnType<typeof nativeFixture>;
test("infrastructure factory keeps its captured native clock for denial-only candidate preparation", () => {
  const f = nativeFixture(),
    journal = f.make() as InfrastructureJournal;
  const calls = structuredClone(f.calls);
  const preparation = journal.prepareTargetCandidates({
    targets: ["staging"],
    release: candidateRelease,
    producer: candidateProducer,
  });
  expect(targetCandidatePreparation(preparation).issued_at).toBe(instant);
  expect(f.seen).toHaveLength(0);
  expect(f.calls).toEqual(calls);
  f.clock.now += 60_000;
  expect(() => targetCandidatePreparation(preparation)).toThrow("invalid-target-candidate");
});
function ordinaryCalls(f: NativeFixture) {
  return f.calls.filter((call) => call.method !== "presign" && !call.key.includes("/recovery/"));
}
async function inspectFactory(f: NativeFixture) {
  // A direct pure journal only constructs test history/arguments; the returned production factory
  // journal is the ONLY object used for the exercised guarded ordinary operation.
  const current = f.store.data.get(f.target === "infra" ? "current" : `trust/${f.target}/current`);
  const head = codec(f).open(
    f.target === "infra" ? "current" : `trust/${f.target}/current`,
    present(current),
  );
  if (f.target === "infra") {
    const baseline = codec(f).open(
      `baselines/${String(object(head).baseline)}`,
      present(f.store.data.get(`baselines/${String(object(head).baseline)}`)),
    );
    return (f.make() as InfrastructureJournal).inspect(
      object(baseline).state as Parameters<InfrastructureJournal["inspect"]>[0],
    );
  }
  const record = codec(f).open(
    `trust/${f.target}/records/${String(object(head).generation)}`,
    present(f.store.data.get(`trust/${f.target}/records/${String(object(head).generation)}`)),
  );
  return (f.make() as TrustJournal).inspect(object(record).descriptor as TargetDescriptor);
}
async function refused(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("expected-invented-refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^(?:invalid-control-record|invalid-ssh-trust|control-journal-operation-failed|control-consumer-(?:read|write|guard)-failed)$/u,
    );
    expect((error as Error).message).not.toContain("invented-secret");
  }
}

describe("mandatory owner-guarded ordinary journal factories", () => {
  test("actual final baseline ACK uncertainty cannot be reused through a fresh factory when its original run failed, queued or reran", async () => {
    for (const mode of ["failure", "queued", "attempt2"]) {
      const f = nativeFixture();
      f.afterWrite(async (path) => {
        if (
          path === "current" &&
          object(codec(f).open(path, present(f.store.data.get(path)))).pending === null
        )
          throw new Error("invented final acknowledgement lost after persistence");
      });
      await expect(ordinaryHistory(f, f.store, f.make())).rejects.toThrow(
        "control-consumer-write-failed",
      );
      const current = object(codec(f).open("current", present(f.store.data.get("current"))));
      expect(current.pending).toBeNull();
      expect(f.store.data.has(`completed/${String(current.baseline)}`)).toBe(true);
      const original = object(f.data[`${api}/actions/runs/${baselineRun.run}`]);
      if (mode === "failure") original.conclusion = "failure";
      if (mode === "queued") original.status = "queued";
      if (mode === "attempt2") original.run_attempt = 2;
      await expect(inspectFactory(f)).rejects.toThrow("invalid-infrastructure-baseline-run");
      expect(
        ordinaryCalls(f).filter((call) => call.method === "write" && call.key.endsWith("/current")),
      ).toHaveLength(3);
    }
  });
  test("fresh factory readers refuse failed original baseline jobs and later Apply authenticates its exact predecessor", async () => {
    const f = nativeFixture();
    const history = await ordinaryHistory(f);
    const b = object(
      codec(f).open(
        `baselines/${history.desired}`,
        present(f.store.data.get(`baselines/${history.desired}`)),
      ),
    );
    const state = b.state as Snapshot["state"];
    const source = object(f.data[`${api}/actions/runs/${baselineRun.run}`]);
    source.conclusion = "failure";
    await expect((f.make() as InfrastructureJournal).inspect(state)).rejects.toThrow(
      "invalid-infrastructure-baseline-run",
    );
    expect(ordinaryCalls(f).filter((call) => call.method === "write")).toHaveLength(0);
    source.conclusion = "success";
    const nextRun = { commit: "c".repeat(40), run: "34567" };
    const execution = baselineRunFixture({ kind: "apply", run: nextRun }, { automatic: true });
    Object.assign(f.data, execution.data);
    const journal = f.make() as InfrastructureJournal;
    const snapshot = await journal.inspect(state);
    const at = f.seen.length;
    const ticket = await journal.begin(
      snapshot,
      object(b.intent).inputs as Value,
      nextRun,
      "d".repeat(64),
      "apply",
    );
    expect(
      f.seen.slice(at).some((get) => get.url === `${api}/actions/runs/${baselineRun.run}`),
    ).toBe(true);
    expect(f.seen.slice(at).some((get) => get.url === `${api}/actions/runs/${nextRun.run}`)).toBe(
      false,
    );
    const after = { ...state, serial: state.serial + 1, digest: "c".repeat(64) };
    await journal.finish(ticket, after);
    expect(execution.run.status).toBe("in_progress");
    const reopened = await (f.make() as InfrastructureJournal).inspect(after);
    expect(reopened.generation).toBe(ticket.generation);
    expect(f.seen.some((get) => get.url === `${api}/actions/runs/${nextRun.run}`)).toBe(true);
  });
  test("original execution proof expiry during a held owner check blocks the raw PUT even after a later operation", async () => {
    const f = nativeFixture();
    const history = await ordinaryHistory(f);
    const baseline = object(
      codec(f).open(
        `baselines/${history.desired}`,
        present(f.store.data.get(`baselines/${history.desired}`)),
      ),
    );
    const state = baseline.state as Snapshot["state"];
    let oldPath: string | undefined;
    let variableReads = 0;
    let held = false;
    let signalHeld!: () => void;
    let releaseHeld!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    f.beforeRead(async (path) => {
      if (oldPath === undefined && path.startsWith("intents/") && !f.store.data.has(path))
        oldPath = path;
    });
    const nativeGet = f.dependencies.get;
    f.dependencies.get = async (request) => {
      // Local absence no longer creates a younger object check. Hold the final anchor
      // round of the SAME operation's mandatory pre-PUT checkpoint near its original deadline.
      if (oldPath && request.url.endsWith("/variables/CONTROL_OWNER_ANCHOR")) {
        if (++variableReads === 2) f.clock.now = instant + 29_990;
      }
      if (oldPath && variableReads === 2 && request.url === api && !held) {
        held = true;
        signalHeld();
        await release;
      }
      return nativeGet(request);
    };
    const journal = f.make() as InfrastructureJournal;
    const snapshot = await journal.inspect(state);
    const old = journal.begin(
      snapshot,
      { next: "old" },
      { commit: "c".repeat(40), run: "34567" },
      "d".repeat(64),
      "apply",
    );
    await entered;
    f.clock.now = instant + 30_001;
    expect(ordinaryCalls(f).filter((call) => call.method === "write")).toHaveLength(0);
    // A later operation obtains a DIFFERENT native proof. It cannot renew the held closure.
    const next = await journal.begin(
      snapshot,
      { next: "new" },
      { commit: "d".repeat(40), run: "45678" },
      "e".repeat(64),
      "apply",
    );
    const written = ordinaryCalls(f).filter((call) => call.method === "write").length;
    expect(written).toBe(2);
    releaseHeld();
    await expect(old).rejects.toThrow("control-consumer-write-failed");
    expect(ordinaryCalls(f).filter((call) => call.method === "write")).toHaveLength(written);
    expect(f.store.data.has(present(oldPath))).toBe(false);
    expect(codec(f).open("current", present(f.store.data.get("current")))).toEqual({
      baseline: history.desired,
      pending: next.generation,
    });
  });
  test("missing/unknown authority refuses before constructing native storage or reading GitHub", () => {
    const f = nativeFixture();
    const mutations = [
      (c: Value) => {
        delete c.owner;
      },
      (c: Value) => {
        delete c.backend;
      },
      (c: Value) => {
        delete c.passphrase;
      },
      (c: Value) => {
        delete c.storage;
      },
      (c: Value) => {
        c.backend = "invented raw backend rather than digest";
      },
      (c: Value) => {
        c.passphrase = "short";
      },
      (c: Value) => {
        c.target = "unknown";
      },
      (c: Value) => {
        c.approved = true;
      },
      (c: Value) => {
        object(c.owner).owner_id = 0;
      },
      (c: Value) => {
        delete object(c.owner).repository_id;
      },
      (c: Value) => {
        delete object(c.owner).environment_id;
      },
      (c: Value) => {
        delete object(c.owner).token;
      },
      (c: Value) => {
        object(c.storage).scope = "trust-staging";
      },
      (c: Value) => {
        delete object(object(c.storage).credentials).sessionToken;
      },
      (c: Value) => {
        object(c.storage).endpoint = "http://region.example.org";
      },
      (c: Value) => {
        object(c.storage).bucket = "dotted.bucket";
      },
    ];
    for (const edit of mutations) {
      const c = structuredClone(f.config) as unknown as Value;
      edit(c);
      expect(() =>
        createControlJournal(c as unknown as ControlJournalConfiguration, f.dependencies),
      ).toThrow("invalid-control-journal-factory");
    }
    for (const missing of [undefined, null, {}])
      expect(() =>
        createControlJournal(missing as ControlJournalConfiguration, f.dependencies),
      ).toThrow("invalid-control-journal-factory");
    let invoked = false;
    const c = structuredClone(f.config);
    Object.defineProperty(c, "owner", {
      enumerable: true,
      get: () => {
        invoked = true;
        return f.config.owner;
      },
    });
    expect(() => createControlJournal(c, f.dependencies)).toThrow(
      "invalid-control-journal-factory",
    );
    expect(invoked).toBe(false);
    // A small-byte tree can still contain many nodes. Instrument traversal independently of
    // the eventual schema refusal so the resource bound, rather than unknown-field checks, wins.
    let traversed = 0;
    const broad = structuredClone(f.config) as unknown as Value;
    object(broad.owner).token = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [
        `n${index}`,
        new Proxy(
          {},
          {
            getPrototypeOf(value) {
              traversed++;
              return Reflect.getPrototypeOf(value);
            },
          },
        ),
      ]),
    );
    expect(() =>
      createControlJournal(broad as unknown as ControlJournalConfiguration, f.dependencies),
    ).toThrow("invalid-control-journal-factory");
    expect(traversed).toBeGreaterThan(0);
    expect(traversed).toBeLessThan(4096);
    expect(f.constructed).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  test("returns only the exact frozen journal, with explicit scoped credentials and no exposed capabilities", () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = nativeFixture(target),
        journal = f.make();
      expect(journal).toBeInstanceOf(target === "infra" ? InfrastructureJournal : TrustJournal);
      expect(Object.isFrozen(journal)).toBe(true);
      expect(Object.keys(journal)).toEqual([]);
      expect(f.seen).toHaveLength(0);
      expect(f.constructed).toEqual([
        {
          bucket: f.config.storage.bucket,
          endpoint: "https://invented-journal-bucket.region.example.org",
          region: "us-east-1",
          virtualHostedStyle: true,
          retry: 0,
          accessKeyId: "invented_access",
          secretAccessKey: "invented-secret-marker",
          sessionToken: "",
        },
      ]);
      for (const key of [
        "store",
        "raw",
        "owner",
        "guard",
        "codec",
        "configuration",
        "passphrase",
        "token",
        "recovery",
      ])
        expect(Reflect.get(journal, key)).toBeUndefined();
      for (const diagnostic of [JSON.stringify(journal), Bun.inspect(journal)])
        for (const secret of [
          f.config.passphrase,
          f.config.owner.token,
          "invented-secret-marker",
          f.scope.backend,
        ])
          expect(diagnostic).not.toContain(secret);
      expect(Reflect.set(journal, "store", f.store)).toBe(false);
      expect(Reflect.set(journal, "inspect", () => true)).toBe(false);
      expect(f.calls).toEqual([
        {
          method: "presign",
          key: `${f.scope.namespace}${target === "infra" ? "current" : `trust/${target}/current`}`,
        },
      ]);
    }
  });

  test("never-repaired scopes write and reopen genuine encrypted ordinary history through all actual guards", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = nativeFixture(target);
      const history = await ordinaryHistory(f, f.store, f.make());
      expect((await inspectFactory(f)).generation).toBe(history.desired);
      expect(f.seen.length).toBeGreaterThan(0);
      expect(ordinaryCalls(f).length).toBeGreaterThan(0);
      expect(f.calls.some((call) => call.method === "write")).toBe(true);
      expect(
        [...f.store.data.values()].every(
          (bytes) => Buffer.from(bytes).subarray(0, 4).toString() === "TIC1",
        ),
      ).toBe(true);
      expect(f.calls.every((call) => call.key.startsWith(f.scope.namespace))).toBe(true);
      expect(
        f.calls.filter((call) => call.method !== "presign").every((call) => call.retry === 0),
      ).toBe(true);
      expect(f.store.versions).toBe(0);
    }
  }, 20_000);

  test("independently pinned completed repair requires the actual encrypted graph and exact owner-approved final run for all targets", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = nativeFixture(target),
        finished = await completed(f);
      expect((await inspectFactory(f)).generation).toBe(finished.history.desired);
      expect(
        f.seen.some((request) => request.url === `${api}/actions/runs/${run.run}/approvals`),
      ).toBe(true);
      expect(
        f.seen.some((request) => request.url === `${api}/environments/recover-${target}`),
      ).toBe(true);
      expect(f.store.versions).toBe(0);
      expect(f.calls.some((call) => call.method === "write")).toBe(false);
    }
  }, 25_000);

  test("repairing owner scope blocks ordinary access before any raw ordinary read or write", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = nativeFixture(target);
      const history = await ordinaryHistory(f);
      f.record.repair = { mode: "repairing", generation: repairGeneration };
      f.sync();
      await refused(inspectFactory(f));
      if (target === "infra") {
        const snapshot = (await history.inspect()) as Snapshot;
        await refused(
          (f.make() as InfrastructureJournal).begin(
            snapshot,
            snapshot.inputs ?? {},
            run,
            "e".repeat(64),
            "apply",
          ),
        );
      } else {
        const path = `trust/${target}/authorizations/${trustGeneration}`;
        await refused(
          (f.make() as TrustJournal).recordAuthorization(
            codec(f).open(path, present(f.store.data.get(path))),
          ),
        );
      }
      expect(ordinaryCalls(f)).toHaveLength(0);
      expect(f.calls.some((call) => call.method === "write")).toBe(false);
    }
  });

  test("never-repaired authority cannot clear existing repair metadata, and missing/pending linked completion cannot excuse it", async () => {
    const f = nativeFixture();
    const finished = await completed(f);
    f.record.repair = { mode: "never-repaired" };
    f.record.revision = "99999999-9999-4999-8999-999999999999";
    f.sync();
    await refused(inspectFactory(f));
    expect(ordinaryCalls(f)).toHaveLength(0);
    f.record.repair = {
      mode: "completed-repair",
      generation: repairGeneration,
      intent_digest: privateDigest(finished.intent),
      ...run,
    };
    f.sync();
    f.store.data.delete(`recovery/infra/completed/${repairGeneration}`);
    await refused(inspectFactory(f));
    expect(ordinaryCalls(f)).toHaveLength(0);
    expect(f.seen.some((request) => request.url.includes("/actions/runs/"))).toBe(false);
  });

  test("generic successful run cannot authenticate a different private repair intent or unapproved gate", async () => {
    const f = nativeFixture();
    const finished = await completed(f);
    object(f.record.repair).intent_digest = "0".repeat(64);
    f.sync();
    await refused(inspectFactory(f));
    expect(f.seen.some((request) => request.url.includes("/actions/runs/"))).toBe(false);
    object(f.record.repair).intent_digest = privateDigest(finished.intent);
    f.sync();
    f.data[`${api}/actions/runs/${run.run}/approvals`] = [];
    await refused(inspectFactory(f));
    expect(f.seen.some((request) => request.url.includes("/approvals"))).toBe(true);
    expect(ordinaryCalls(f)).toHaveLength(0);
  });

  test("ordinary ciphertext corruption and wrong historical backend remain refusals after valid owner checks", async () => {
    const f = nativeFixture();
    await ordinaryHistory(f);
    const good = Uint8Array.from(present(f.store.data.get("current")));
    const corrupt = Uint8Array.from(good);
    corrupt[corrupt.length - 1] = present(corrupt[corrupt.length - 1]) ^ 1;
    f.store.data.set("current", corrupt);
    // Keep valid caller arguments separately: the factory must fail while opening the raw record.
    const raw = codec(f).open("current", good);
    const baseline = object(
      codec(f).open(
        `baselines/${String(object(raw).baseline)}`,
        present(f.store.data.get(`baselines/${String(object(raw).baseline)}`)),
      ),
    );
    await refused((f.make() as InfrastructureJournal).inspect(baseline.state as Snapshot["state"]));
    expect(ordinaryCalls(f).length).toBeGreaterThan(0);
    f.store.data.set("current", good);
    const different = privateDigest({
      backend: "invented exact backend.hcl bytes",
      key: "tarubot/infra.tfstate",
    });
    f.config.backend = different;
    f.record.backend = different;
    f.sync();
    await refused((f.make() as InfrastructureJournal).inspect(baseline.state as Snapshot["state"]));
  });

  test("owner HTTP failures and denied raw metadata never use an earlier successful scope as authority", async () => {
    const f = nativeFixture();
    const baseline = await ordinaryHistory(f);
    const journal = f.make() as InfrastructureJournal;
    const snapshot = await baseline.inspect();
    await journal.inspect((snapshot as Snapshot).state);
    const before = ordinaryCalls(f).length;
    const original = f.dependencies.get;
    // The captured transport reads current API data each time; deleting config is a hard failure.
    delete f.data[`${api}/environments/${f.name}/variables/CONTROL_OWNER_ANCHOR`];
    await refused(journal.inspect((snapshot as Snapshot).state));
    expect(ordinaryCalls(f)).toHaveLength(before);
    f.data[`${api}/environments/${f.name}/variables/CONTROL_OWNER_ANCHOR`] = f.variable;
    expect(f.dependencies.get).toBe(original);
    f.readError(
      Object.assign(new Error("invented-private-storage-detail"), { code: "AccessDenied" }),
    );
    await refused(journal.inspect((snapshot as Snapshot).state));
    expect(ordinaryCalls(f)).toHaveLength(before);
  });

  test("a changed owner revision during local reads refuses the whole-operation final delivery", async () => {
    const f = nativeFixture();
    const history = await ordinaryHistory(f);
    f.beforeRead(async (path) => {
      if (path === "current") {
        f.record.revision = "77777777-7777-4777-8777-777777777777";
        f.record.repair = { mode: "repairing", generation: repairGeneration };
        f.sync();
      }
    });
    await refused(inspectFactory(f));
    expect(ordinaryCalls(f).map((call) => call.key)).toEqual(
      [
        "current",
        `intents/${history.desired}`,
        `baselines/${history.desired}`,
        `completed/${history.desired}`,
        "current",
        `intents/${history.desired}`,
        `baselines/${history.desired}`,
        `completed/${history.desired}`,
      ].map((path) => `${f.scope.namespace}${path}`),
    );
  });

  test("persisted pending write with failed acknowledgement receives no retry or later completed authority", async () => {
    const f = nativeFixture(),
      history = await ordinaryHistory(f);
    const snapshot = (await history.inspect()) as Snapshot;
    const journal = f.make() as InfrastructureJournal;
    f.afterWrite(async (path) => {
      if (path === "current") throw new Error("invented-private-after-persist-error");
    });
    await refused(journal.begin(snapshot, snapshot.inputs ?? {}, run, "e".repeat(64), "apply"));
    const head = object(codec(f).open("current", present(f.store.data.get("current"))));
    expect(typeof head.pending).toBe("string");
    expect(
      f.calls.filter(
        (call) => call.method === "write" && call.key === `${f.scope.namespace}current`,
      ),
    ).toHaveLength(1);
    await refused(journal.inspect(snapshot.state));
    expect(
      f.calls.filter(
        (call) => call.method === "write" && call.key === `${f.scope.namespace}current`,
      ),
    ).toHaveLength(1);
  });

  test("caller configuration and dependency replacements cannot substitute captured journal authority", async () => {
    const f = nativeFixture("staging");
    const history = await ordinaryHistory(f);
    const original = structuredClone(f.config);
    const journal = f.make() as TrustJournal;
    f.config.backend = "0".repeat(64);
    f.config.passphrase = "changed private passphrase with sufficient entropy";
    f.config.owner.token = "changed_invented_token_1234567890";
    f.config.storage.scope = "trust-production";
    f.config.storage.endpoint = "https://other.example.org";
    if (f.config.target === "infra") throw new Error("wrong-invented-target");
    f.config.validator.binary_sha256 = "0".repeat(64);
    f.dependencies.get = async () => {
      throw new Error("invented substituted getter");
    };
    f.dependencies.now = () => 0;
    const record = codec(f).open(
      `trust/staging/records/${history.desired}`,
      present(f.store.data.get(`trust/staging/records/${history.desired}`)),
    );
    expect((await journal.inspect(object(record).descriptor as TargetDescriptor)).generation).toBe(
      history.desired,
    );
    expect(
      f.seen.every((request) => request.headers.Authorization === `Bearer ${original.owner.token}`),
    ).toBe(true);
    expect(f.constructed[0]?.endpoint).toBe("https://invented-journal-bucket.region.example.org");
  });
});

describe("whole ordinary-journal volume and native checkpoints", () => {
  test("completed repair infra inspect/begin/finish preserve34-GET authority checks without per-read amplification", async () => {
    const f = nativeFixture();
    const completion = await completed(f);
    const baseline = object(
      codec(f).open(
        `baselines/${completion.history.desired}`,
        present(f.store.data.get(`baselines/${completion.history.desired}`)),
      ),
    );
    const state = object(baseline.state) as unknown as Snapshot["state"];
    const journal = f.make() as InfrastructureJournal;
    const beforeInspect = f.seen.length,
      beforeReads = ordinaryCalls(f).length;
    const snapshot = await journal.inspect(state);
    expect(f.seen.length - beforeInspect).toBe(82); // 68owner +14independent original baseline.
    expect(ordinaryCalls(f).length - beforeReads).toBe(8);
    const beforeBegin = f.seen.length,
      beforeBeginObjects = ordinaryCalls(f).length;
    const ticket = await journal.begin(
      snapshot,
      object(baseline.intent).inputs as Value,
      { commit: "c".repeat(40), run: "34567" },
      "d".repeat(64),
      "apply",
    );
    expect(f.seen.length - beforeBegin).toBe(150); // 136owner +14baseline; two PUT checkpoints.
    expect(ordinaryCalls(f).length - beforeBeginObjects).toBe(13);
    const beforeFinish = f.seen.length,
      beforeFinishObjects = ordinaryCalls(f).length;
    await journal.finish(ticket, { ...state, serial: state.serial + 1, digest: "c".repeat(64) });
    expect(f.seen.length - beforeFinish).toBe(204); // Initial/final plus one fresh check per4PUT.
    expect(ordinaryCalls(f).length - beforeFinishObjects).toBe(16);
    expect(Object.isFrozen(ticket)).toBe(true);
  });
  test("trust private inspection delegation reuses one original proof; publish stays entirely per-object", async () => {
    const f = nativeFixture("staging");
    const history = await ordinaryHistory(f, f.store, f.make());
    expect(f.seen).toHaveLength(1176); //60authorization +108begin +960excluded publish +48finish.
    const record = object(
      codec(f).open(
        `trust/staging/records/${history.desired}`,
        present(f.store.data.get(`trust/staging/records/${history.desired}`)),
      ),
    );
    const descriptor = record.descriptor as TargetDescriptor;
    const journal = f.make() as TrustJournal;
    let at = f.seen.length,
      io = ordinaryCalls(f).length;
    const snapshot = await journal.inspect(descriptor);
    expect(f.seen.length - at).toBe(24);
    expect(ordinaryCalls(f).length - io).toBe(18);
    const publication = object(
      codec(f).open(
        `trust/staging/publications/${String(record.operation)}`,
        present(f.store.data.get(`trust/staging/publications/${String(record.operation)}`)),
      ),
    );
    at = f.seen.length;
    io = ordinaryCalls(f).length;
    const connection = await journal.connectionTrust(
      descriptor,
      async () => true,
      async () => publication.dns as DnssecEvidence,
    );
    expect(connection.generation).toBe(snapshot.generation);
    expect(f.seen.length - at).toBe(24);
    expect(ordinaryCalls(f).length - io).toBe(36);
  });
  test("changed critical execution and semantically equal new repair ciphertext refuse before the next raw PUT", async () => {
    for (const changed of ["step", "ciphertext"]) {
      const f = nativeFixture();
      const completion = await completed(f);
      const b = object(
        codec(f).open(
          `baselines/${completion.history.desired}`,
          present(f.store.data.get(`baselines/${completion.history.desired}`)),
        ),
      );
      const state = b.state as Snapshot["state"];
      const journal = f.make() as InfrastructureJournal;
      const snapshot = await journal.inspect(state);
      f.beforeRead(async (path) => {
        if (!path.startsWith("intents/") || f.store.data.has(path)) return;
        if (changed === "step") {
          const page = object(
            f.data[`${api}/actions/runs/${run.run}/attempts/1/jobs?per_page=100&page=1`],
          );
          const job = object((page.jobs as unknown[])[0]);
          object((job.steps as unknown[])[0]).number = 2;
        } else {
          const key = `recovery/infra/completed/${repairGeneration}`;
          const bytes = present(f.store.data.get(key));
          f.store.data.set(
            key,
            completion.metadata.seal(key, completion.metadata.open(key, bytes)),
          );
        }
      });
      await expect(
        journal.begin(
          snapshot,
          object(b.intent).inputs as Value,
          { commit: "c".repeat(40), run: "34567" },
          "d".repeat(64),
          "apply",
        ),
      ).rejects.toThrow("control-consumer-write-failed");
      expect(ordinaryCalls(f).filter((call) => call.method === "write")).toHaveLength(0);
    }
  });
});

test("excluded target and publication entries only deny active synchronous origins, including wrong inputs", async () => {
  for (const method of ["prepare", "inspect", "finish"] as const)
    for (const wrong of [false, true]) {
      const f = nativeFixture();
      const history = await ordinaryHistory(f);
      const b = object(
        codec(f).open(
          `baselines/${history.desired}`,
          present(f.store.data.get(`baselines/${history.desired}`)),
        ),
      );
      const state = b.state as Snapshot["state"];
      const journal = f.make() as InfrastructureJournal;
      const snapshot = await journal.inspect(state);
      const ticket = await journal.begin(
        snapshot,
        object(b.intent).inputs as Value,
        { commit: candidateRelease.commit, run: candidateRelease.publication_run },
        "d".repeat(64),
        "apply",
      );
      const preparation = journal.prepareTargetCandidates({
        targets: ["staging"],
        release: candidateRelease,
        producer: candidateProducer,
      });
      f.seen.length = 0;
      f.calls.length = 0;
      const hostile = new Proxy(state, {
        ownKeys(value) {
          try {
            if (method === "prepare")
              journal.prepareTargetCandidates(
                wrong
                  ? ({} as Parameters<InfrastructureJournal["prepareTargetCandidates"]>[0])
                  : {
                      targets: ["staging"],
                      release: candidateRelease,
                      producer: candidateProducer,
                    },
              );
            else if (method === "inspect")
              void journal
                .inspectTargetCandidates(
                  wrong ? ({} as TargetCandidatePreparation) : preparation,
                  {} as Parameters<InfrastructureJournal["inspectTargetCandidates"]>[1],
                )
                .catch(() => {});
            else
              void journal
                .finishTargetCandidates(
                  wrong ? { ...ticket } : ticket,
                  preparation,
                  {} as Parameters<InfrastructureJournal["finishTargetCandidates"]>[2],
                )
                .catch(() => {});
          } catch {
            /* A swallowed excluded-entry refusal must still stop the original operation. */
          }
          return Reflect.ownKeys(value);
        },
      });
      await expect(journal.inspect(hostile)).rejects.toThrow("control-journal-operation-failed");
      expect(f.seen).toHaveLength(0);
      expect(ordinaryCalls(f)).toHaveLength(0);
    }
  for (const wrong of [false, true]) {
    const f = nativeFixture("staging");
    const history = await ordinaryHistory(f);
    const record = object(
      codec(f).open(
        `trust/staging/records/${history.desired}`,
        present(f.store.data.get(`trust/staging/records/${history.desired}`)),
      ),
    );
    const journal = f.make() as TrustJournal;
    let effects = 0;
    const descriptor = new Proxy(record.descriptor as TargetDescriptor, {
      ownKeys(value) {
        const ticket = wrong
          ? {}
          : {
              generation: String(record.generation),
              operation: String(record.operation),
              binding: String(record.binding),
            };
        void journal
          .publish(
            ticket as Parameters<TrustJournal["publish"]>[0],
            {
              read: async () => {
                effects++;
                return [];
              },
              write: async () => {
                effects++;
                throw new Error("unexpected invented DNS mutation");
              },
            },
            async () => {
              effects++;
              throw new Error("unexpected invented DNS measurement");
            },
          )
          .catch(() => {});
        return Reflect.ownKeys(value);
      },
    });
    await expect(journal.inspect(descriptor)).rejects.toThrow("control-journal-operation-failed");
    expect(f.seen).toHaveLength(0);
    expect(ordinaryCalls(f)).toHaveLength(0);
    expect(effects).toBe(0);
  }
}, 15_000);
