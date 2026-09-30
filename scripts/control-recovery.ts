/**
 * Offline owner-fenced restoration of completed control history. No provider/state mutation,
 * SSH observation, DNS write, transport implementation or CLI is present. Adapters must keep
 * automation and hand writers fenced through independent final run success and must call
 * guardConsumer before every normal begin/connection reader. Readback is never a lock or CAS.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  stateEvidence,
  verifyAppliedPlan,
  type ControlStore,
  type RunIdentity,
} from "./infra-control.js";
import { classifyPlan, inputs } from "./infra-policy.js";
import {
  TrustJournal,
  targetDescriptor,
  type DnssecEvidence,
  type TargetRole,
  type TrustSnapshot,
  type ValidatorPin,
} from "./ssh-trust.js";

type Value = Record<string, unknown>;
export type RecoveryTarget = "infra" | TargetRole;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const freshAge = 60_000;

function requireRecovery(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-recovery");
}
function object(value: unknown): Value {
  requireRecovery(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const v = object(value);
  requireRecovery(isDeepStrictEqual(Object.keys(v).sort(), [...keys].sort()));
  return v;
}
function generation(value: unknown): asserts value is string {
  requireRecovery(typeof value === "string" && uuid.test(value));
}
function digest(value: unknown): asserts value is string {
  requireRecovery(typeof value === "string" && sha.test(value));
}
function optionalDigest(value: unknown): asserts value is string | null {
  if (value !== null) digest(value);
}
function time(value: unknown): asserts value is number {
  requireRecovery(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function target(value: unknown): asserts value is RecoveryTarget {
  requireRecovery(value === "infra" || value === "staging" || value === "production");
}
function runIdentity(value: unknown): RunIdentity {
  const r = exact(value, ["commit", "run"]);
  requireRecovery(typeof r.commit === "string" && /^[a-f0-9]{40}$/u.test(r.commit));
  requireRecovery(typeof r.run === "string" && /^[1-9][0-9]{0,19}$/u.test(r.run));
  return structuredClone(r) as unknown as RunIdentity;
}
/** Byte hashes bind exact encrypted versions, never a privilege to reencrypt another path. */
export function ciphertextDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function bytesDigest(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : ciphertextDigest(bytes);
}

export interface VersionedControlStore extends ControlStore {
  /** Null is definite absence of this exact historical version; ambiguous reads must throw. */
  readVersion(path: string, version: string): Promise<Uint8Array | null>;
}
export interface RecoveryVersion {
  path: string;
  version: string;
  ciphertext_sha256: string;
  plaintext_digest: string;
  expected_latest_sha256: string | null;
}
export interface RecoveryAuthorization {
  schema: 1;
  target: RecoveryTarget;
  backend: string;
  namespace: string;
  generation: string;
  desired_generation: string;
  expected_current_sha256: string | null;
  expected_recovery_sha256: string | null;
  manifest_digest: string;
  outcome_digest: string;
  run: RunIdentity;
  approved_at: number;
  expires_at: number;
}
/** Parsing a grant is never owner approval; the independent owner-fenced adapter supplies that. */
export function recoveryAuthorization(value: unknown): RecoveryAuthorization {
  const a = exact(value, [
    "schema",
    "target",
    "backend",
    "namespace",
    "generation",
    "desired_generation",
    "expected_current_sha256",
    "expected_recovery_sha256",
    "manifest_digest",
    "outcome_digest",
    "run",
    "approved_at",
    "expires_at",
  ]);
  requireRecovery(a.schema === 1);
  target(a.target);
  digest(a.backend);
  requireRecovery(
    typeof a.namespace === "string" && /^[a-z0-9][a-z0-9/_-]{1,127}[/]$/u.test(a.namespace),
  );
  generation(a.generation);
  generation(a.desired_generation);
  optionalDigest(a.expected_current_sha256);
  optionalDigest(a.expected_recovery_sha256);
  digest(a.manifest_digest);
  digest(a.outcome_digest);
  runIdentity(a.run);
  time(a.approved_at);
  time(a.expires_at);
  requireRecovery(a.expires_at > a.approved_at && a.expires_at - a.approved_at <= 86_400_000);
  return structuredClone(a) as unknown as RecoveryAuthorization;
}
export interface OwnerFenceReceipt {
  schema: 1;
  target: RecoveryTarget;
  backend: string;
  namespace: string;
  generation: string;
  authorization_digest: string;
  manifest_digest: string;
  expected_current_sha256: string | null;
  expected_recovery_sha256: string | null;
  run: RunIdentity;
  fence_digest: string;
  expires_at: number;
}
export interface SuccessfulRunReceipt {
  schema: 1;
  target: RecoveryTarget;
  backend: string;
  generation: string;
  binding_digest: string;
  commit: string;
  run: string;
  attempt: 1;
  conclusion: "success";
}
export interface VerifiedOutcomeReceipt {
  schema: 1;
  target: RecoveryTarget;
  backend: string;
  namespace: string;
  generation: string;
  desired_generation: string;
  outcome_digest: string;
  observed_at: number;
}
export interface OwnerRecoveryBoundary {
  /**
   * Independently verify the real owner gate, exact grant and automation+hand-writer fence.
   * Hold that fence throughout; this cannot be implemented by echoing caller data/CLI Booleans.
   */
  assertOwnerFence(authorization: RecoveryAuthorization): Promise<OwnerFenceReceipt>;
  /** Independently collect/verify actual state+no-change provider or owned DNS evidence.
   * Never implement this by accepting supplied shapes or echoing the caller's JSON/Boolean. */
  verifyOutcome(request: {
    authorization: RecoveryAuthorization;
    outcome: unknown;
  }): Promise<VerifiedOutcomeReceipt>;
  /** Bind the repository/workflow/owner gate, exact commit/run, first attempt and final success. */
  confirmRecoveryRun(request: {
    target: RecoveryTarget;
    backend: string;
    generation: string;
    binding_digest: string;
    run: RunIdentity;
  }): Promise<SuccessfulRunReceipt>;
  /** Same independent final-run proof for an existing enrollment, never a new observation. */
  confirmEnrollmentRun(request: {
    target: TargetRole;
    backend: string;
    generation: string;
    binding_digest: string;
    run: RunIdentity;
  }): Promise<SuccessfulRunReceipt>;
}
type RecoveryOptions = {
  backend: string;
  namespace: string;
  passphrase: string;
  now?: () => number;
} & ({ target: "infra" } | { target: TargetRole; validator: ValidatorPin });
interface LoadedVersion {
  entry: RecoveryVersion;
  bytes: Uint8Array;
  value: unknown;
}
interface RepairIntent {
  schema: 1;
  authorization: RecoveryAuthorization;
  manifest: RecoveryVersion[];
  fence: OwnerFenceReceipt;
  previous: { generation: string; intent_digest: string } | null;
  started_at: number;
}
interface RepairCompletion {
  schema: 1;
  generation: string;
  intent_digest: string;
  restored_digest: string;
  finished_at: number;
}

/** Complete-history restoration only. Partial remote outcomes without matching history stop. */
export class ControlRecovery {
  private readonly codec: RecordCodec;
  private readonly repairCodec: RecordCodec;
  private readonly clock: () => number;
  private readonly options: RecoveryOptions;
  constructor(
    private readonly store: VersionedControlStore,
    options: RecoveryOptions,
    private readonly owner: OwnerRecoveryBoundary,
  ) {
    target(options.target);
    digest(options.backend);
    requireRecovery(
      typeof options.namespace === "string" &&
        /^[a-z0-9][a-z0-9/_-]{1,127}[/]$/u.test(options.namespace),
    );
    requireRecovery(typeof options.passphrase === "string" && options.passphrase.length >= 32);
    const { now: _now, ...configuration } = options;
    this.options = structuredClone(configuration);
    this.clock = options.now ?? Date.now;
    this.codec = new RecordCodec(
      options.passphrase,
      options.target === "infra"
        ? options.backend
        : privateDigest({
            purpose: "tarubot-ssh-trust-v1",
            target: options.target,
            backend: options.backend,
          }),
    );
    this.repairCodec = new RecordCodec(
      options.passphrase,
      privateDigest({
        purpose: "tarubot-control-recovery-v1",
        target: options.target,
        backend: options.backend,
        namespace: options.namespace,
      }),
    );
  }
  private now(): number {
    const now = this.clock();
    time(now);
    return now;
  }
  private prefix(): string {
    return `recovery/${this.options.target}/`;
  }
  private currentKey(): string {
    return this.options.target === "infra" ? "current" : `trust/${this.options.target}/current`;
  }
  private bound(a: RecoveryAuthorization): void {
    requireRecovery(
      a.target === this.options.target &&
        a.backend === this.options.backend &&
        a.namespace === this.options.namespace,
    );
  }
  private fresh(a: RecoveryAuthorization, observedAt: number): void {
    const now = this.now();
    requireRecovery(a.approved_at <= now && now < a.expires_at);
    requireRecovery(observedAt <= now && now - observedAt <= freshAge);
  }
  private manifest(value: unknown): RecoveryVersion[] {
    requireRecovery(Array.isArray(value) && value.length > 0 && value.length <= 1024);
    const entries = value.map((entry) => {
      const v = exact(entry, [
        "path",
        "version",
        "ciphertext_sha256",
        "plaintext_digest",
        "expected_latest_sha256",
      ]);
      requireRecovery(typeof v.path === "string");
      const id = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
      const allowed =
        this.options.target === "infra"
          ? new RegExp(`^(current|(?:intents|baselines|completed)/${id})$`, "u")
          : new RegExp(
              `^trust/${this.options.target}/(?:registration|authorization-current|current|(?:authorizations|attempts|consumed|intents|references|records|publication-intents|publications|completed)/${id})$`,
              "u",
            );
      requireRecovery(allowed.test(v.path));
      requireRecovery(
        typeof v.version === "string" &&
          v.version !== "null" &&
          /^[A-Za-z0-9._~+/-]{1,1024}$/u.test(v.version),
      );
      digest(v.ciphertext_sha256);
      digest(v.plaintext_digest);
      optionalDigest(v.expected_latest_sha256);
      return structuredClone(v) as unknown as RecoveryVersion;
    });
    requireRecovery(new Set(entries.map((e) => e.path)).size === entries.length);
    requireRecovery(entries.some((e) => e.path === this.currentKey()));
    return entries;
  }
  private async load(manifest: RecoveryVersion[]): Promise<Map<string, LoadedVersion>> {
    const loaded = new Map<string, LoadedVersion>();
    let total = 0;
    for (const entry of manifest) {
      const bytes = await this.store.readVersion(entry.path, entry.version);
      requireRecovery(bytes !== null && ciphertextDigest(bytes) === entry.ciphertext_sha256);
      total += bytes.length;
      requireRecovery(total <= 64 * 1024 * 1024);
      const value = this.codec.open(entry.path, bytes);
      requireRecovery(privateDigest(value) === entry.plaintext_digest);
      loaded.set(entry.path, { entry, bytes: Uint8Array.from(bytes), value });
    }
    return loaded;
  }
  private async fence(
    a: RecoveryAuthorization,
    observedAt: number,
    expected?: OwnerFenceReceipt,
  ): Promise<OwnerFenceReceipt> {
    this.fresh(a, observedAt);
    const r = this.fenceReceipt(
      await this.owner.assertOwnerFence(structuredClone(a)),
      a,
      this.now(),
    );
    this.fresh(a, observedAt);
    if (expected) requireRecovery(isDeepStrictEqual(r, expected));
    return r;
  }
  private fenceReceipt(value: unknown, a: RecoveryAuthorization, at: number): OwnerFenceReceipt {
    const r = exact(value, [
      "schema",
      "target",
      "backend",
      "namespace",
      "generation",
      "authorization_digest",
      "manifest_digest",
      "expected_current_sha256",
      "expected_recovery_sha256",
      "run",
      "fence_digest",
      "expires_at",
    ]);
    requireRecovery(
      r.schema === 1 &&
        r.target === a.target &&
        r.backend === a.backend &&
        r.namespace === a.namespace &&
        r.generation === a.generation,
    );
    requireRecovery(
      r.authorization_digest === privateDigest(a) &&
        r.manifest_digest === a.manifest_digest &&
        r.expected_current_sha256 === a.expected_current_sha256 &&
        r.expected_recovery_sha256 === a.expected_recovery_sha256,
    );
    requireRecovery(isDeepStrictEqual(runIdentity(r.run), a.run));
    digest(r.fence_digest);
    time(r.expires_at);
    requireRecovery(at < r.expires_at && r.expires_at <= a.expires_at);
    return structuredClone(r) as unknown as OwnerFenceReceipt;
  }
  private successfulRun(
    value: unknown,
    target: RecoveryTarget,
    generation: string,
    binding: string,
    run: RunIdentity,
  ): void {
    requireRecovery(
      isDeepStrictEqual(
        exact(value, [
          "schema",
          "target",
          "backend",
          "generation",
          "binding_digest",
          "commit",
          "run",
          "attempt",
          "conclusion",
        ]),
        {
          schema: 1,
          target,
          backend: this.options.backend,
          generation,
          binding_digest: binding,
          commit: run.commit,
          run: run.run,
          attempt: 1,
          conclusion: "success",
        },
      ),
    );
  }
  private async actualOutcome(
    a: RecoveryAuthorization,
    outcome: unknown,
    observedAt: number,
  ): Promise<void> {
    this.fresh(a, observedAt);
    const proof = await this.owner.verifyOutcome({
      authorization: structuredClone(a),
      outcome: structuredClone(outcome),
    });
    requireRecovery(
      isDeepStrictEqual(
        exact(proof, [
          "schema",
          "target",
          "backend",
          "namespace",
          "generation",
          "desired_generation",
          "outcome_digest",
          "observed_at",
        ]),
        {
          schema: 1,
          target: a.target,
          backend: a.backend,
          namespace: a.namespace,
          generation: a.generation,
          desired_generation: a.desired_generation,
          outcome_digest: a.outcome_digest,
          observed_at: observedAt,
        },
      ),
    );
    this.fresh(a, observedAt);
  }
  private async verifyHistory(
    loaded: Map<string, LoadedVersion>,
    outcome: unknown,
    desired: string,
  ): Promise<void> {
    const o = exact(
      outcome,
      this.options.target === "infra"
        ? ["schema", "target", "observed_at", "state", "plan", "shown_state"]
        : ["schema", "target", "observed_at", "descriptor", "dns", "owned_record"],
    );
    requireRecovery(o.schema === 1 && o.target === this.options.target);
    time(o.observed_at);
    const used = new Set<string>();
    let headOverride: Uint8Array | null = null;
    const view: ControlStore = {
      read: async (key) => {
        used.add(key);
        if (key === this.currentKey() && headOverride) return Uint8Array.from(headOverride);
        const record = loaded.get(key);
        requireRecovery(record !== undefined);
        return Uint8Array.from(record.bytes);
      },
      write: async () => {
        throw new Error("invalid-control-recovery");
      },
    };
    const head = object(loaded.get(this.currentKey())?.value);
    if (this.options.target === "infra") {
      requireRecovery(head.baseline === desired && head.pending === null);
      const state = stateEvidence(o.state);
      const journal = new InfrastructureJournal(view, this.codec);
      const snapshot = await journal.inspect(state);
      requireRecovery(snapshot.generation === desired && snapshot.inputs !== null);
      requireRecovery(
        classifyPlan(o.plan, snapshot.inputs, snapshot.inputs).decision === "no-changes",
      );
      verifyAppliedPlan(o.plan, o.shown_state);
      // InfrastructureJournal validates a completed generation's links; recovery additionally
      // traverses each predecessor and requires the next intent's exact before-state evidence.
      const seen = new Set<string>();
      let id: string | null = desired;
      let nextBefore: unknown = null;
      while (id !== null) {
        requireRecovery(seen.size < 64 && !seen.has(id));
        seen.add(id);
        const b = object(loaded.get(`baselines/${id}`)?.value);
        const i = object(b.intent);
        headOverride = this.codec.seal("current", { baseline: id, pending: null });
        await journal.inspect(b.state as Parameters<InfrastructureJournal["inspect"]>[0]);
        inputs(i.inputs);
        if (nextBefore !== null) requireRecovery(isDeepStrictEqual(nextBefore, b.state));
        const before = object(i.before);
        const after = object(b.state);
        requireRecovery(before.lineage === after.lineage);
        requireRecovery(
          i.kind === "baseline"
            ? isDeepStrictEqual(before, after)
            : Number(after.serial) > Number(before.serial),
        );
        nextBefore = i.before;
        requireRecovery(i.previous === null || typeof i.previous === "string");
        id = i.previous as string | null;
      }
    } else {
      requireRecovery(head.generation === desired && head.pending === null);
      const latest = object(
        loaded.get(`trust/${this.options.target}/authorization-current`)?.value,
      );
      requireRecovery(latest.generation === desired);
      const descriptor = targetDescriptor(o.descriptor);
      const journal = new TrustJournal(view, { ...this.options, now: this.clock });
      const enrolled = await journal.inspect(descriptor);
      const enrollmentBinding = privateDigest(enrolled);
      const snapshot = await journal.connectionTrust(
        descriptor,
        async (run) => {
          this.successfulRun(
            await this.owner.confirmEnrollmentRun({
              target: this.options.target as TargetRole,
              backend: this.options.backend,
              generation: desired,
              binding_digest: enrollmentBinding,
              run,
            }),
            this.options.target,
            desired,
            enrollmentBinding,
            run,
          );
          return true;
        },
        async (_snapshot: TrustSnapshot) => structuredClone(o.dns) as DnssecEvidence,
      );
      requireRecovery(
        snapshot.generation === desired && isDeepStrictEqual(snapshot.record, o.owned_record),
      );
    }
    // Every selected object must be required by the validated chain. No hidden/unrelated
    // manifest entry can acquire write authority from a valid current pointer.
    requireRecovery(isDeepStrictEqual([...used].sort(), [...loaded.keys()].sort()));
  }
  private async metadata(path: string): Promise<unknown | null> {
    const bytes = await this.store.read(this.prefix() + path);
    return bytes === null ? null : this.repairCodec.open(this.prefix() + path, bytes);
  }
  private async completedRepair(id: string, depth = 0): Promise<RepairIntent> {
    requireRecovery(depth < 64);
    generation(id);
    const i = exact(await this.metadata(`intents/${id}`), [
      "schema",
      "authorization",
      "manifest",
      "fence",
      "previous",
      "started_at",
    ]);
    requireRecovery(i.schema === 1);
    const a = recoveryAuthorization(i.authorization);
    this.bound(a);
    requireRecovery(a.generation === id);
    const manifest = this.manifest(i.manifest);
    requireRecovery(privateDigest(manifest) === a.manifest_digest);
    time(i.started_at);
    requireRecovery(a.approved_at <= i.started_at && i.started_at < a.expires_at);
    const done = exact(await this.metadata(`completed/${id}`), [
      "schema",
      "generation",
      "intent_digest",
      "restored_digest",
      "finished_at",
    ]);
    requireRecovery(
      done.schema === 1 && done.generation === id && done.intent_digest === privateDigest(i),
    );
    requireRecovery(
      done.restored_digest ===
        privateDigest(manifest.map((e) => [e.path, e.ciphertext_sha256]).sort()),
    );
    time(done.finished_at);
    requireRecovery(done.finished_at >= i.started_at && done.finished_at < a.expires_at);
    this.fenceReceipt(i.fence, a, done.finished_at);
    if (i.previous !== null) {
      const prior = exact(i.previous, ["generation", "intent_digest"]);
      generation(prior.generation);
      requireRecovery(prior.generation !== id);
      requireRecovery(
        privateDigest(await this.completedRepair(prior.generation, depth + 1)) ===
          prior.intent_digest,
      );
    }
    return structuredClone(i) as unknown as RepairIntent;
  }
  /**
   * REQUIRED before normal journal begin/connection readers after recovery. The owner supplies
   * its independently recorded expected repair generation; a missing marker is never permission.
   * Adapters integrating this guard are absent. Never activate restoration without those guards.
   */
  async guardConsumer(expectedGeneration: string): Promise<void> {
    try {
      generation(expectedGeneration);
      const registration = exact(await this.metadata("registration"), [
        "schema",
        "generation",
        "intent_digest",
      ]);
      requireRecovery(registration.schema === 1);
      generation(registration.generation);
      const head = exact(await this.metadata("current"), [
        "schema",
        "generation",
        "pending",
        "intent_digest",
      ]);
      requireRecovery(
        head.schema === 1 && head.generation === expectedGeneration && head.pending === false,
      );
      const intent = await this.completedRepair(expectedGeneration);
      requireRecovery(head.intent_digest === privateDigest(intent));
      const initial = await this.completedRepair(registration.generation);
      requireRecovery(
        registration.intent_digest === privateDigest(initial) && initial.previous === null,
      );
      let ancestor = intent;
      let depth = 0;
      while (ancestor.previous !== null) {
        requireRecovery(++depth < 64);
        ancestor = await this.completedRepair(ancestor.previous.generation);
      }
      requireRecovery(ancestor.authorization.generation === registration.generation);
      this.successfulRun(
        await this.owner.confirmRecoveryRun({
          target: this.options.target,
          backend: this.options.backend,
          generation: expectedGeneration,
          binding_digest: privateDigest(intent),
          run: intent.authorization.run,
        }),
        this.options.target,
        expectedGeneration,
        privateDigest(intent),
        intent.authorization.run,
      );
      requireRecovery(isDeepStrictEqual(await this.metadata("current"), head));
      requireRecovery(isDeepStrictEqual(await this.metadata("registration"), registration));
    } catch {
      throw new Error("invalid-control-recovery");
    }
  }
  /** No provider Apply, new observation or DNS retry is available; only exact approved bytes. */
  async restore(authorization: unknown, versions: unknown, outcome: unknown): Promise<void> {
    try {
      // Callers and owner-boundary callbacks cannot rewrite already-bound outcome evidence
      // while version reads, validation and restoration cross asynchronous boundaries.
      outcome = structuredClone(outcome);
      const a = recoveryAuthorization(authorization);
      this.bound(a);
      const manifest = this.manifest(versions);
      requireRecovery(
        privateDigest(manifest) === a.manifest_digest &&
          privateDigest(outcome) === a.outcome_digest,
      );
      const observedAt = object(outcome).observed_at;
      time(observedAt);
      this.fresh(a, observedAt);
      const current = manifest.find((e) => e.path === this.currentKey());
      requireRecovery(
        current !== undefined && current.expected_latest_sha256 === a.expected_current_sha256,
      );
      const expected = new Map(manifest.map((e) => [e.path, e.expected_latest_sha256]));
      const loaded = await this.load(manifest);
      await this.verifyHistory(loaded, outcome, a.desired_generation);
      for (const entry of manifest)
        requireRecovery(
          bytesDigest(await this.store.read(entry.path)) === entry.expected_latest_sha256,
        );
      const repairHead = `${this.prefix()}current`;
      requireRecovery(
        bytesDigest(await this.store.read(repairHead)) === a.expected_recovery_sha256,
      );
      let previous: RepairIntent["previous"] = null;
      if (a.expected_recovery_sha256 !== null) {
        const head = object(await this.metadata("current"));
        generation(head.generation);
        await this.guardConsumer(head.generation);
        const prior = await this.completedRepair(head.generation);
        previous = { generation: head.generation, intent_digest: privateDigest(prior) };
      } else requireRecovery((await this.metadata("registration")) === null);
      const fence = await this.fence(a, observedAt);
      await this.actualOutcome(a, outcome, observedAt);
      const intent: RepairIntent = {
        schema: 1,
        authorization: a,
        manifest,
        fence,
        previous,
        started_at: this.now(),
      };
      const intentDigest = privateDigest(intent);
      let repairPointerExpected = a.expected_recovery_sha256;
      const requireLatest = async () => {
        for (const [path, hash] of expected)
          requireRecovery(bytesDigest(await this.store.read(path)) === hash);
        requireRecovery(bytesDigest(await this.store.read(repairHead)) === repairPointerExpected);
      };
      const write = async (key: string, bytes: Uint8Array, before: string | null) => {
        await this.fence(a, observedAt, fence);
        await requireLatest();
        requireRecovery(bytesDigest(await this.store.read(key)) === before);
        this.fresh(a, observedAt);
        await this.store.write(key, Uint8Array.from(bytes));
        const readback = await this.store.read(key);
        requireRecovery(readback !== null && Buffer.from(bytes).equals(Buffer.from(readback)));
        if (expected.has(key)) expected.set(key, ciphertextDigest(bytes));
        if (key === repairHead) repairPointerExpected = ciphertextDigest(bytes);
        this.fresh(a, observedAt);
        await this.fence(a, observedAt, fence);
        await requireLatest();
        this.fresh(a, observedAt);
      };
      const persist = async (path: string, value: unknown, before: string | null = null) => {
        const key = this.prefix() + path;
        await write(key, this.repairCodec.seal(key, value), before);
      };
      await persist(`intents/${a.generation}`, intent);
      if (previous === null)
        await persist("registration", {
          schema: 1,
          generation: a.generation,
          intent_digest: intentDigest,
        });
      await persist(
        "current",
        { schema: 1, generation: a.generation, pending: true, intent_digest: intentDigest },
        a.expected_recovery_sha256,
      );
      const pendingHash = bytesDigest(await this.store.read(repairHead));
      digest(pendingHash);
      // Restore dependency/history records first; current is last. The separate recovery
      // pointer still blocks guarded consumers even when a completed normal head is visible.
      const ordered = [...manifest].sort(
        (x, y) => Number(x.path === this.currentKey()) - Number(y.path === this.currentKey()),
      );
      for (const entry of ordered) {
        const version = loaded.get(entry.path);
        requireRecovery(version !== undefined);
        if (entry.expected_latest_sha256 !== entry.ciphertext_sha256)
          await write(entry.path, version.bytes, entry.expected_latest_sha256);
        expected.set(entry.path, entry.ciphertext_sha256);
      }
      for (const [key, hash] of expected)
        requireRecovery(bytesDigest(await this.store.read(key)) === hash);
      await this.verifyHistory(loaded, outcome, a.desired_generation);
      await this.actualOutcome(a, outcome, observedAt);
      this.fresh(a, observedAt);
      const done: RepairCompletion = {
        schema: 1,
        generation: a.generation,
        intent_digest: intentDigest,
        restored_digest: privateDigest(manifest.map((e) => [e.path, e.ciphertext_sha256]).sort()),
        finished_at: this.now(),
      };
      await persist(`completed/${a.generation}`, done);
      await persist(
        "current",
        { schema: 1, generation: a.generation, pending: false, intent_digest: intentDigest },
        pendingHash,
      );
      requireRecovery(isDeepStrictEqual(await this.completedRepair(a.generation), intent));
      // A final ack/reopen may already have persisted a completed pointer before failing.
      // The reader guard additionally requires independent final success of this owner run.
      for (const [key, hash] of expected)
        requireRecovery(bytesDigest(await this.store.read(key)) === hash);
      this.fresh(a, observedAt);
      await this.fence(a, observedAt, fence);
    } catch {
      throw new Error("invalid-control-recovery");
    }
  }
}
