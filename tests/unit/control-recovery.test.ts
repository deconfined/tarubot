/** Invented versioned encrypted objects exercise actual journals; no provider, host or network. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ControlRecovery,
  ciphertextDigest,
  recoveryAuthorization,
  type OwnerFenceReceipt,
  type OwnerRecoveryBoundary,
  type RecoveryAuthorization,
  type RecoveryTarget,
  type RecoveryVersion,
  type VersionedControlStore,
} from "../../scripts/control-recovery.js";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  stateEvidence,
} from "../../scripts/infra-control.js";
import {
  TrustJournal,
  canonicalEd25519,
  type DnsWriter,
  type ValidatorPin,
} from "../../scripts/ssh-trust.js";

const instant = 1_800_000_000_000;
const backend = "a".repeat(64);
const passphrase = "invented private recovery passphrase with sufficient entropy";
const repairGeneration = "11111111-1111-4111-8111-111111111111";
const trustGeneration = "22222222-2222-4222-8222-222222222222";
const run = { commit: "b".repeat(40), run: "12345" };
const pin: ValidatorPin = {
  name: "unbound",
  version: "1.26.1",
  mode: "local-validating",
  binary_sha256: "c".repeat(64),
  anchor_sha256: "d".repeat(64),
  runtime_manifest_sha256: "d".repeat(64),
};
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";

/** Version IDs and exact ciphertext are retained even when the latest object is lost/corrupted. */
class Versions implements VersionedControlStore {
  data = new Map<string, Uint8Array>();
  history = new Map<string, Uint8Array>();
  latest = new Map<string, string>();
  writes: string[] = [];
  faultAt = 0;
  fault: "before" | "after" | "readback" | null = null;
  corrupt: string | null = null;
  async read(path: string): Promise<Uint8Array | null> {
    if (this.corrupt === path) {
      this.corrupt = null;
      return Uint8Array.from([1, 2, 3]);
    }
    const bytes = this.data.get(path);
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async readVersion(path: string, version: string): Promise<Uint8Array | null> {
    const bytes = this.history.get(`${path}\0${version}`);
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(path);
    const fail = this.writes.length === this.faultAt;
    if (fail && this.fault === "before") throw new Error("invented-private-provider-diagnostic");
    this.data.set(path, Uint8Array.from(bytes));
    const version = `version-${this.writes.length}`;
    this.latest.set(path, version);
    this.history.set(`${path}\0${version}`, Uint8Array.from(bytes));
    if (fail && this.fault === "after") throw new Error("invented-private-write-diagnostic");
    if (fail && this.fault === "readback") this.corrupt = path;
  }
  snapshot(): Map<string, string> {
    return new Map(this.latest);
  }
  async manifest(saved: Map<string, string>, codec: RecordCodec): Promise<RecoveryVersion[]> {
    const result: RecoveryVersion[] = [];
    for (const [path, version] of saved) {
      const bytes = await this.readVersion(path, version);
      if (!bytes) throw new Error("missing-invented-version");
      result.push({
        path,
        version,
        ciphertext_sha256: ciphertextDigest(bytes),
        plaintext_digest: privateDigest(codec.open(path, bytes)),
        expected_latest_sha256: this.data.has(path)
          ? ciphertextDigest(this.data.get(path) as Uint8Array)
          : null,
      });
    }
    return result;
  }
}
function ownerBoundary() {
  const flags = { succeeded: false, enrollment: true };
  const owner: OwnerRecoveryBoundary = {
    assertOwnerFence: async (a): Promise<OwnerFenceReceipt> => ({
      schema: 1,
      target: a.target,
      backend: a.backend,
      namespace: a.namespace,
      generation: a.generation,
      authorization_digest: privateDigest(a),
      manifest_digest: a.manifest_digest,
      expected_current_sha256: a.expected_current_sha256,
      expected_recovery_sha256: a.expected_recovery_sha256,
      run: structuredClone(a.run),
      fence_digest: "e".repeat(64),
      expires_at: a.expires_at,
    }),
    verifyOutcome: async ({ authorization: a, outcome }) => ({
      schema: 1,
      target: a.target,
      backend: a.backend,
      namespace: a.namespace,
      generation: a.generation,
      desired_generation: a.desired_generation,
      outcome_digest: a.outcome_digest,
      observed_at: (outcome as { observed_at: number }).observed_at,
    }),
    confirmRecoveryRun: async (r) =>
      ({
        schema: 1,
        target: r.target,
        backend: r.backend,
        generation: r.generation,
        binding_digest: r.binding_digest,
        ...r.run,
        attempt: 1,
        conclusion: flags.succeeded ? "success" : "failure",
      }) as never,
    confirmEnrollmentRun: async (r) =>
      ({
        schema: 1,
        target: r.target,
        backend: r.backend,
        generation: r.generation,
        binding_digest: r.binding_digest,
        ...r.run,
        attempt: 1,
        conclusion: flags.enrollment ? "success" : "failure",
      }) as never,
  };
  return { owner, flags };
}
const namespace = (target: RecoveryTarget) => `tarubot/control/v1/${target}/`;
function authorization(
  target: RecoveryTarget,
  desired: string,
  manifest: RecoveryVersion[],
  outcome: unknown,
): RecoveryAuthorization {
  const current = manifest.find(
    (e) => e.path === (target === "infra" ? "current" : `trust/${target}/current`),
  );
  if (!current) throw new Error("missing-invented-current");
  return {
    schema: 1,
    target,
    backend,
    namespace: namespace(target),
    generation: repairGeneration,
    desired_generation: desired,
    expected_current_sha256: current.expected_latest_sha256,
    expected_recovery_sha256: null,
    manifest_digest: privateDigest(manifest),
    outcome_digest: privateDigest(outcome),
    run,
    approved_at: instant - 1000,
    expires_at: instant + 60_000,
  };
}
async function infraFixture() {
  const store = new Versions();
  const codec = new RecordCodec(passphrase, backend);
  const journal = new InfrastructureJournal(store, codec);
  const values = {
    ...JSON.parse(
      readFileSync(new URL("../../ops/tofu/examples/example.tfvars.json", import.meta.url), "utf8"),
    ),
    hosts: {},
    database_ids: {},
  };
  const state = {
    version: 4,
    terraform_version: "1.12.6",
    lineage: "33333333-3333-4333-8333-333333333333",
    serial: 10,
    resources: [],
    outputs: {},
  };
  const evidence = stateEvidence(state);
  const ticket = await journal.begin(
    await journal.inspect(evidence),
    values,
    run,
    "f".repeat(64),
    "baseline",
  );
  await journal.finish(ticket, evidence);
  const saved = store.snapshot();
  await journal.begin(await journal.inspect(evidence), values, run, "f".repeat(64), "apply");
  store.data.delete(`baselines/${ticket.generation}`);
  const outputs = {
    addresses: { sensitive: true, value: {} },
    hosts: { sensitive: false, value: {} },
  };
  const plan = {
    format_version: "1.2",
    terraform_version: "1.12.6",
    errored: false,
    complete: true,
    variables: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
    resource_changes: [],
    planned_values: { root_module: { resources: [] }, outputs },
    output_changes: Object.fromEntries(
      Object.entries(outputs).map(([k]) => [
        k,
        { actions: ["no-op"], before: {}, after: {}, after_unknown: false },
      ]),
    ),
  };
  const outcome = {
    schema: 1,
    target: "infra",
    observed_at: instant,
    state,
    plan,
    shown_state: {
      format_version: "1.0",
      terraform_version: "1.12.6",
      values: { root_module: { resources: [] }, outputs },
    },
  };
  const manifest = await store.manifest(saved, codec);
  const a = authorization("infra", ticket.generation, manifest, outcome);
  const clock = { now: instant };
  const { owner, flags } = ownerBoundary();
  const recovery = new ControlRecovery(
    store,
    { target: "infra", backend, namespace: namespace("infra"), passphrase, now: () => clock.now },
    owner,
  );
  const initialWrites = store.writes.length;
  return {
    store,
    codec,
    journal,
    saved,
    manifest,
    a,
    outcome,
    clock,
    owner,
    flags,
    recovery,
    evidence,
    initialWrites,
  };
}
async function trustFixture() {
  const store = new Versions();
  const codec = new RecordCodec(
    passphrase,
    privateDigest({ purpose: "tarubot-ssh-trust-v1", target: "staging", backend }),
  );
  const clock = { now: instant };
  const journal = new TrustJournal(store, {
    target: "staging",
    backend,
    passphrase,
    validator: pin,
    now: () => clock.now,
  });
  const descriptor = {
    schema: 1 as const,
    target: "staging" as const,
    provider: "linode" as const,
    instance_id: "100",
    fqdn: "host.example.org",
    addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
    dns_zone_id: "a".repeat(32),
    applied_generation: "44444444-4444-4444-8444-444444444444",
    state: { lineage: "55555555-5555-4555-8555-555555555555", serial: 12, digest: "b".repeat(64) },
  };
  const grant = {
    schema: 1 as const,
    target: "staging" as const,
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
  const writer: DnsWriter = {
    read: async () => (written ? [record] : []),
    write: async () => {
      written = true;
      return record;
    },
  };
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
  await journal.publish(ticket, writer, async () => dns);
  await journal.finish(ticket);
  const saved = store.snapshot();
  store.data.delete(`trust/staging/references/${trustGeneration}`);
  await store.write(
    "trust/staging/current",
    codec.seal("trust/staging/current", {
      schema: 1,
      target: "staging",
      generation: trustGeneration,
      pending: "66666666-6666-4666-8666-666666666666",
    }),
  );
  const outcome = {
    schema: 1,
    target: "staging",
    observed_at: instant,
    descriptor,
    dns,
    owned_record: record,
  };
  const manifest = await store.manifest(saved, codec);
  const a = authorization("staging", trustGeneration, manifest, outcome);
  const { owner, flags } = ownerBoundary();
  const recovery = new ControlRecovery(
    store,
    {
      target: "staging",
      backend,
      namespace: namespace("staging"),
      passphrase,
      validator: pin,
      now: () => clock.now,
    },
    owner,
  );
  return {
    store,
    codec,
    journal,
    manifest,
    a,
    outcome,
    clock,
    owner,
    flags,
    recovery,
    initialWrites: store.writes.length,
  };
}
const rebind = (a: RecoveryAuthorization, manifest: RecoveryVersion[], outcome: unknown) => ({
  ...a,
  manifest_digest: privateDigest(manifest),
  outcome_digest: privateDigest(outcome),
});
async function refusal(action: Promise<unknown>) {
  await expect(action).rejects.toThrow("invalid-control-recovery");
}

describe("owner-fenced completed-history restoration", () => {
  test("diagnostics hide passphrases and external shadows cannot replace history or owner fences", async () => {
    const f = await infraFixture();
    const shadowStore = new Versions();
    expect(Object.keys(f.recovery)).toEqual([]);
    expect(JSON.stringify(f.recovery)).toBe("{}");
    for (const diagnostic of [JSON.stringify(f.recovery), Bun.inspect(f.recovery)]) {
      expect(diagnostic).not.toContain(passphrase);
      expect(diagnostic).not.toContain(backend);
      expect(diagnostic).not.toContain(namespace("infra"));
    }
    for (const name of [
      "codec",
      "repairCodec",
      "clock",
      "options",
      "store",
      "owner",
      "fence",
      "bound",
    ])
      expect(Reflect.get(f.recovery, name)).toBeUndefined();
    Object.assign(f.recovery, {
      store: shadowStore,
      codec: new RecordCodec(`${passphrase}-shadow`, "f".repeat(64)),
      repairCodec: new RecordCodec(`${passphrase}-shadow`, "e".repeat(64)),
      options: {
        target: "production",
        backend: "e".repeat(64),
        namespace: "other/",
        passphrase: "short",
      },
      clock: () => 0,
      owner: {
        confirmRecoveryRun: async () => ({ conclusion: "success" }),
      },
      fence: async () => ({}),
      bound: () => {},
      fresh: () => {},
    });
    await f.recovery.restore(f.a, f.manifest, f.outcome);
    expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
    await refusal(f.recovery.guardConsumer(f.a.generation));
    f.flags.succeeded = true;
    await f.recovery.guardConsumer(f.a.generation);
    expect(shadowStore.writes).toEqual([]);
  });
  test("plain constructor authority is captured once and accessor failures stay redacted", async () => {
    const f = await infraFixture();
    let accesses = 0;
    const recovery = new ControlRecovery(
      f.store,
      {
        get target(): "infra" {
          accesses++;
          return accesses === 1 ? "infra" : ("production" as "infra");
        },
        backend,
        namespace: namespace("infra"),
        passphrase,
        now: () => instant,
      },
      f.owner,
    );
    await recovery.restore(f.a, f.manifest, f.outcome);
    expect(accesses).toBe(1);
    expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
    expect(
      () =>
        new ControlRecovery(
          f.store,
          {
            target: "infra",
            backend,
            namespace: namespace("infra"),
            get passphrase(): string {
              throw new Error("invented-private-accessor-diagnostic");
            },
          },
          f.owner,
        ),
    ).toThrow("invalid-control-recovery");
  });
  test("same-key encrypted versions restore a verified baseline; the mandatory reader guard waits for run success", async () => {
    const f = await infraFixture();
    await refusal(f.recovery.guardConsumer(f.a.generation));
    await f.recovery.restore(f.a, f.manifest, f.outcome);
    expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
    for (const e of f.manifest)
      expect(ciphertextDigest(f.store.data.get(e.path) as Uint8Array)).toBe(e.ciphertext_sha256);
    await refusal(f.recovery.guardConsumer(f.a.generation));
    f.flags.succeeded = true;
    await f.recovery.guardConsumer(f.a.generation);
    const writes = f.store.writes.length;
    await refusal(f.recovery.restore(f.a, f.manifest, f.outcome));
    expect(f.store.writes).toHaveLength(writes);
    await refusal(f.recovery.guardConsumer(trustGeneration));
  });
  test("a complete trust chain requires current owned DNS, fresh local DNSSEC and original enrollment success", async () => {
    const f = await trustFixture();
    await f.recovery.restore(f.a, f.manifest, f.outcome);
    expect((await f.journal.inspect(f.outcome.descriptor)).key).toBe(key);
    await refusal(f.recovery.guardConsumer(f.a.generation));
    f.flags.succeeded = true;
    await f.recovery.guardConsumer(f.a.generation);
  });
  test("strict grants reject unknown fields, stale approvals and mismatched scope or private digests", async () => {
    const f = await infraFixture();
    for (const delta of [
      { extra: "invented-private" },
      { target: "production" },
      { backend: "b".repeat(64) },
      { namespace: "another/" },
      { generation: "../current" },
      { desired_generation: trustGeneration },
      { expected_current_sha256: null },
      { expected_recovery_sha256: "c".repeat(64) },
      { manifest_digest: "d".repeat(64) },
      { outcome_digest: "e".repeat(64) },
      { run: { ...run, run: "0" } },
      { expires_at: instant },
      { approved_at: instant + 1 },
    ]) {
      await refusal(f.recovery.restore({ ...f.a, ...delta }, f.manifest, f.outcome));
      expect(f.store.writes).toHaveLength(f.initialWrites);
    }
    expect(() =>
      recoveryAuthorization({ ...f.a, expires_at: f.a.approved_at + 86_400_001 }),
    ).toThrow("invalid-control-recovery");
  });
  test("missing, cross-key, duplicated or unrelated version selections grant no writes", async () => {
    const f = await infraFixture();
    for (const edit of [
      (m: RecoveryVersion[]) => {
        m.pop();
      },
      (m: RecoveryVersion[]) => {
        m.push(structuredClone(m[0] as RecoveryVersion));
      },
      (m: RecoveryVersion[]) => {
        (m[0] as RecoveryVersion).version = "missing-version";
      },
      (m: RecoveryVersion[]) => {
        (m[0] as RecoveryVersion).ciphertext_sha256 = "f".repeat(64);
      },
      (m: RecoveryVersion[]) => {
        (m[0] as RecoveryVersion).path = "../current";
      },
      (m: RecoveryVersion[]) => {
        const source = m.find((e) => e.path.startsWith("intents/")) as RecoveryVersion;
        const destination = m.find((e) => e.path.startsWith("baselines/")) as RecoveryVersion;
        f.store.history.set(
          `${destination.path}\0${source.version}`,
          f.store.history.get(`${source.path}\0${source.version}`) as Uint8Array,
        );
        destination.version = source.version;
        destination.ciphertext_sha256 = source.ciphertext_sha256;
        destination.plaintext_digest = source.plaintext_digest;
      },
    ]) {
      const m = structuredClone(f.manifest);
      edit(m);
      await refusal(f.recovery.restore(rebind(f.a, m, f.outcome), m, f.outcome));
      expect(f.store.writes).toHaveLength(f.initialWrites);
    }
    const pending = [...f.store.latest.keys()].find(
      (k) => k.startsWith("intents/") && !f.saved.has(k),
    );
    if (!pending) throw new Error("missing-invented-pending-intent");
    const extras = await f.store.manifest(
      new Map([[pending, f.store.latest.get(pending) as string]]),
      f.codec,
    );
    const m = [...f.manifest, ...extras];
    await refusal(f.recovery.restore(rebind(f.a, m, f.outcome), m, f.outcome));
    expect(f.store.writes).toHaveLength(f.initialWrites);
  });
  test("advanced or unknown provider/state outcomes cannot be repaired into an older baseline", async () => {
    const f = await infraFixture();
    for (const delta of [
      { observed_at: instant - 60_001 },
      { state: { ...f.outcome.state, serial: 11 } },
      { plan: { ...f.outcome.plan, errored: true } },
      {
        shown_state: {
          ...f.outcome.shown_state,
          values: { root_module: { resources: [] }, outputs: {} },
        },
      },
    ]) {
      const outcome = { ...f.outcome, ...delta };
      await refusal(f.recovery.restore(rebind(f.a, f.manifest, outcome), f.manifest, outcome));
      expect(f.store.writes).toHaveLength(f.initialWrites);
    }
  });
  test("all completed Infrastructure predecessors must match the next generation's exact before-state", async () => {
    const f = await infraFixture();
    // Reopen a complete native baseline, then build a second generation without any provider.
    for (const entry of f.manifest) {
      const bytes = await f.store.readVersion(entry.path, entry.version);
      if (!bytes) throw new Error("missing-invented-history");
      f.store.data.set(entry.path, bytes);
    }
    const priorId = f.a.desired_generation;
    const values = (await f.journal.inspect(f.evidence)).inputs;
    if (!values) throw new Error("missing-invented-inputs");
    const next = await f.journal.begin(
      await f.journal.inspect(f.evidence),
      values,
      run,
      "f".repeat(64),
      "apply",
    );
    const state = { ...f.outcome.state, serial: 11 };
    await f.journal.finish(next, stateEvidence(state));
    // The old generation is internally consistent but its state is incompatible with the
    // next intent. Ordinary inspect validates only its selected generation; recovery walks all.
    const prior = f.codec.open(
      `baselines/${priorId}`,
      f.store.data.get(`baselines/${priorId}`) as Uint8Array,
    ) as { intent: { before: { serial: number } }; state: { serial: number } };
    prior.state.serial = 9;
    prior.intent.before.serial = 9;
    await f.store.write(`intents/${priorId}`, f.codec.seal(`intents/${priorId}`, prior.intent));
    await f.store.write(`baselines/${priorId}`, f.codec.seal(`baselines/${priorId}`, prior));
    await f.store.write(
      `completed/${priorId}`,
      f.codec.seal(`completed/${priorId}`, { generation: priorId, baseline: privateDigest(prior) }),
    );
    expect((await f.journal.inspect(stateEvidence(state))).generation).toBe(next.generation);
    const selected = new Map(
      [...f.store.latest].filter(
        ([path]) => path === "current" || path.endsWith(priorId) || path.endsWith(next.generation),
      ),
    );
    const manifest = await f.store.manifest(selected, f.codec);
    const outcome = { ...f.outcome, state };
    const a = authorization("infra", next.generation, manifest, outcome);
    const beforeWrites = f.store.writes.length;
    await refusal(f.recovery.restore(a, manifest, outcome));
    expect(f.store.writes).toHaveLength(beforeWrites);
  });
  test("conflicting DNS, changed instance identity or unsuccessful enrollment cannot restore trust", async () => {
    const f = await trustFixture();
    for (const delta of [
      { owned_record: { ...f.outcome.owned_record, id: "d".repeat(32) } },
      { descriptor: { ...f.outcome.descriptor, instance_id: "101" } },
      { dns: { ...f.outcome.dns, secure: false } },
    ]) {
      const outcome = { ...f.outcome, ...delta };
      await refusal(f.recovery.restore(rebind(f.a, f.manifest, outcome), f.manifest, outcome));
      expect(f.store.writes).toHaveLength(f.initialWrites);
    }
    f.flags.enrollment = false;
    await refusal(f.recovery.restore(f.a, f.manifest, f.outcome));
    expect(f.store.writes).toHaveLength(f.initialWrites);
  });
  test("every before/after/readback interruption blocks guarded consumers, including last-ack ambiguity", async () => {
    for (const fault of ["before", "after", "readback"] as const)
      for (let step = 1; step <= 7; step++) {
        const f = await infraFixture();
        f.store.fault = fault;
        f.store.faultAt = f.initialWrites + step;
        await refusal(f.recovery.restore(f.a, f.manifest, f.outcome));
        await refusal(f.recovery.guardConsumer(f.a.generation));
        // Completed normal history can become visible before final repair-run success. Readers
        // must use the separate guard instead of interpreting a normal completed head as repair success.
        if (step === 7 && fault !== "before")
          expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
      }
  });
  test("the owner fence refreshes hashes/run identity and refuses expiry during write acknowledgement", async () => {
    for (const boundary of ["wrong-run", "changing-fence", "latest-head", "expiry"] as const) {
      const f = await infraFixture();
      const original = f.owner.assertOwnerFence;
      let checks = 0;
      f.owner.assertOwnerFence = async (a) => {
        const r = await original(a);
        checks++;
        if (boundary === "wrong-run") r.run.run = "99999";
        if (boundary === "changing-fence" && checks > 1) r.fence_digest = "f".repeat(64);
        if (boundary === "latest-head" && checks === 2)
          f.store.data.set(
            "current",
            f.codec.seal("current", { baseline: null, pending: trustGeneration }),
          );
        return r;
      };
      if (boundary === "expiry") {
        const write = f.store.write.bind(f.store);
        f.store.write = async (path, bytes) => {
          await write(path, bytes);
          f.clock.now = f.a.expires_at;
        };
      }
      await refusal(f.recovery.restore(f.a, f.manifest, f.outcome));
      await refusal(f.recovery.guardConsumer(f.a.generation));
      expect(f.store.writes.length - f.initialWrites).toBeLessThanOrEqual(1);
    }
  });
  test("independently verified actual outcome receipt is required before writes and before completion", async () => {
    for (const fault of [
      "absent",
      "wrong-outcome",
      "wrong-scope",
      "stale",
      "after-restoration",
    ] as const) {
      const f = await infraFixture();
      const verify = f.owner.verifyOutcome;
      let calls = 0;
      f.owner.verifyOutcome = async (request) => {
        calls++;
        if (fault === "absent") throw new Error("invented-private-provider-diagnostic");
        const proof = await verify(request);
        if (fault === "wrong-outcome" || (fault === "after-restoration" && calls === 2))
          proof.outcome_digest = "f".repeat(64);
        if (fault === "wrong-scope") proof.namespace = "another/";
        if (fault === "stale") proof.observed_at -= 60_001;
        return proof;
      };
      await refusal(f.recovery.restore(f.a, f.manifest, f.outcome));
      if (fault === "after-restoration") {
        expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
        expect(calls).toBe(2);
      } else expect(f.store.writes).toHaveLength(f.initialWrites);
      await refusal(f.recovery.guardConsumer(f.a.generation));
    }
  });
  test("caller and callback mutations cannot rewrite the already-bound outcome snapshot", async () => {
    const f = await infraFixture();
    const fence = f.owner.assertOwnerFence;
    f.owner.assertOwnerFence = async (a) => {
      f.outcome.state.serial = 11;
      return fence(a);
    };
    const verify = f.owner.verifyOutcome;
    const observed: number[] = [];
    f.owner.verifyOutcome = async (request) => {
      const outcome = request.outcome as typeof f.outcome;
      observed.push(outcome.state.serial);
      const proof = await verify(request);
      outcome.state.serial = 12;
      return proof;
    };
    await f.recovery.restore(f.a, f.manifest, f.outcome);
    expect(observed).toEqual([10, 10]);
    expect((await f.journal.inspect(f.evidence)).generation).toBe(f.a.desired_generation);
  });
  test("missing repair markers/history or a late changed pending pointer remain fenced", async () => {
    for (const missing of [
      "current",
      "registration",
      `intents/${repairGeneration}`,
      `completed/${repairGeneration}`,
    ]) {
      const f = await infraFixture();
      await f.recovery.restore(f.a, f.manifest, f.outcome);
      f.flags.succeeded = true;
      f.store.data.delete(`recovery/infra/${missing}`);
      await refusal(f.recovery.guardConsumer(f.a.generation));
    }
    const f = await infraFixture();
    await f.recovery.restore(f.a, f.manifest, f.outcome);
    f.flags.succeeded = true;
    const confirm = f.owner.confirmRecoveryRun;
    f.owner.confirmRecoveryRun = async (r) => {
      const receipt = await confirm(r);
      f.store.data.delete("recovery/infra/current");
      return receipt;
    };
    await refusal(f.recovery.guardConsumer(f.a.generation));
  });
});
