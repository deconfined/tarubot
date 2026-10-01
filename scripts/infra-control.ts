/** Encrypted single-writer journals. Expected revisions/readback are NOT storage locks or CAS. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertControlJournalOperationController,
  assertControlJournalPublicEntry,
  withinControlJournalOperation,
  type ControlJournalOperation,
  type ControlJournalOperationController,
} from "./control-consumer.js";
import {
  assertInfrastructureBaselineRunProof,
  withinInfrastructureBaselineRunProof,
  type InfrastructureBaselineRunRequest,
  type InfrastructureBaselineRunProof,
  type VerifyInfrastructureBaselineRun,
} from "./infra-baseline-run.js";
import { deriveAppliedTarget, type AppliedTargetProducer } from "./target-descriptor.js";
import type { ReleaseIdentity } from "./release-policy.js";
import type { TargetRole } from "./ssh-trust.js";
import {
  assertTargetCandidatePreparation,
  fenceTargetCandidatePreparation,
  prepareTargetCandidates,
  reserveTargetCandidatePreparation,
  targetCandidateDeclaration,
  withinTargetCandidatePreparation,
  type TargetCandidateDeclaration,
  type TargetCandidatePreparation,
  type TargetCandidatePreparationData,
} from "./target-candidate.js";
import { targetIssuancePins } from "./target-issuance.js";

type ObjectValue = Record<string, unknown>;
const domain = "tarubot-infra-control-v1";
const limit = 2 * 1024 * 1024;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeSet = Uint8Array.prototype.set;
/** Bound native ciphertext copies without invoking transport-owned iterators or named getters. */
function encryptedBytes(value: unknown): Uint8Array {
  requireRecord(value instanceof Uint8Array && byteLength !== undefined);
  const length = byteLength.call(value) as number;
  requireRecord(length >= 32 && length <= limit + 32);
  const result = new Uint8Array(length);
  nativeSet.call(result, value);
  return result;
}

/** Caller-owned private data is captured before awaits, without getters or shared references. */
function capturePrivate(value: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    requireRecord(++nodes <= 65_536 && depth <= 32);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      requireRecord(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireRecord(bytes <= limit);
      return input;
    }
    requireRecord(input !== null && typeof input === "object" && !ancestors.has(input));
    requireRecord(Object.getOwnPropertySymbols(input).length === 0);
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      requireRecord(input.length <= 65_536 && Object.keys(descriptors).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireRecord(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireRecord(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const data: ObjectValue = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireRecord(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireRecord(bytes <= limit);
        Object.defineProperty(data, key, { value: copy(item.value, depth + 1), enumerable: true });
      }
      result = data;
    }
    ancestors.delete(input);
    return result;
  };
  const result = copy(value, 0);
  requireRecord(Buffer.byteLength(JSON.stringify(result)) <= limit);
  return result;
}

/** Transport errors, JSON and provider data never become public diagnostics. */
function requireRecord(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-control-record");
}
function object(value: unknown): ObjectValue {
  requireRecord(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function exact(value: unknown, keys: string[]): ObjectValue {
  const result = object(value);
  requireRecord(isDeepStrictEqual(Object.keys(result).sort(), keys.sort()));
  return result;
}
function generation(value: unknown): asserts value is string {
  requireRecord(
    typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value),
  );
}
function digest(value: unknown): asserts value is string {
  requireRecord(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}
/** Stable private hashes include all JSON fields; input order does not create a new generation. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  requireRecord(value !== undefined && (typeof value !== "number" || Number.isFinite(value)));
  return JSON.stringify(value);
}
export function privateDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface StateEvidence {
  lineage: string;
  serial: number;
  digest: string;
}
function validateState(value: unknown): asserts value is StateEvidence {
  const s = exact(value, ["lineage", "serial", "digest"]);
  generation(s.lineage);
  requireRecord(Number.isSafeInteger(s.serial) && Number(s.serial) >= 0);
  digest(s.digest);
}
/** Call only on private `state pull -unencrypted` output; never log its content or digest. */
export function stateEvidence(value: unknown): StateEvidence {
  const state = object(value);
  requireRecord(
    state.version === 4 && Array.isArray(state.resources) && state.terraform_version === "1.12.6",
  );
  const result = { lineage: state.lineage, serial: state.serial, digest: privateDigest(state) };
  validateState(result);
  return result;
}

export interface RunIdentity {
  commit: string;
  run: string;
}
function validateRun(value: unknown): asserts value is RunIdentity {
  const r = exact(value, ["commit", "run"]);
  requireRecord(typeof r.commit === "string" && /^[0-9a-f]{40}$/u.test(r.commit));
  requireRecord(typeof r.run === "string" && /^[1-9][0-9]*$/u.test(r.run));
}
interface Head {
  baseline: string | null;
  pending: string | null;
}
export interface Snapshot {
  generation: string | null;
  state: StateEvidence;
  inputs: ObjectValue | null;
}
interface Intent {
  generation: string;
  previous: string | null;
  kind: "apply" | "baseline";
  run: RunIdentity;
  binding: string;
  inputs: ObjectValue;
  before: StateEvidence;
}
interface Baseline {
  intent: Intent;
  state: StateEvidence;
}
interface ExecutionBoundary {
  proof: InfrastructureBaselineRunProof;
  request: InfrastructureBaselineRunRequest;
}
function validateIntent(value: unknown): asserts value is Intent {
  const i = exact(value, ["generation", "previous", "kind", "run", "binding", "inputs", "before"]);
  generation(i.generation);
  if (i.previous !== null) generation(i.previous);
  requireRecord(i.previous !== i.generation && (i.kind === "apply" || i.kind === "baseline"));
  requireRecord((i.kind === "baseline") === (i.previous === null));
  validateRun(i.run);
  digest(i.binding);
  object(i.inputs);
  validateState(i.before);
}
/**
 * Pure consistency validation for already decrypted selected history. No store, key, execution
 * proof or ordinary-journal authority is returned. Owner-fenced recovery separately verifies
 * its actual remote outcome, owner fence and final repair run before consumers may resume.
 */
export function validateInfrastructureBaselineLinks(value: unknown): Baseline {
  const data = exact(capturePrivate(value), [
    "generation",
    "current",
    "intent",
    "baseline",
    "completion",
    "state",
  ]);
  generation(data.generation);
  validateState(data.state);
  const h = exact(data.current, ["baseline", "pending"]);
  requireRecord(h.baseline === data.generation && h.pending === null);
  const b = exact(data.baseline, ["intent", "state"]);
  validateIntent(data.intent);
  validateState(b.state);
  requireRecord(
    data.intent.generation === data.generation && isDeepStrictEqual(b.intent, data.intent),
  );
  requireRecord(isDeepStrictEqual(b.state, data.state));
  requireRecord(
    isDeepStrictEqual(data.completion, { generation: data.generation, baseline: privateDigest(b) }),
  );
  return b as unknown as Baseline;
}
export interface Ticket {
  generation: string;
  binding: string;
}

interface CompletedProjectionLinks {
  current: unknown;
  intent: Intent;
  baseline: unknown;
  completion: unknown;
}
interface StructuralProjection {
  records: Map<string, Uint8Array>;
  snapshot: Snapshot;
  request: InfrastructureBaselineRunRequest | null;
  links: CompletedProjectionLinks | null;
}
interface CurrentWriter {
  original: Ticket;
  intent: Intent;
  predecessor: CompletedProjectionLinks | null;
  predecessorBytes: Map<string, Uint8Array>;
  phase: "writing" | "projecting" | "projected" | "fenced";
}
export interface TargetProjectionEvidence {
  plan: unknown;
  applied_show: unknown;
  state_readback: unknown;
  state_reopened: unknown;
}
declare const pendingTargetBrand: unique symbol;
/** Native pending data only; it cannot authorize an ordinary baseline or any host action. */
export type PendingTargetCandidate = Readonly<{ [pendingTargetBrand]: true }>;
interface PendingState {
  declaration: TargetCandidateDeclaration;
  preparation: TargetCandidatePreparation;
  boundary: ExecutionBoundary | null;
  checkWriter: () => void;
  stopWriter: () => void;
  beforeSeal: () => Promise<void>;
  phase: "pending" | "sealing" | "sealed" | "fenced";
}
const pendingTargets = new WeakMap<PendingTargetCandidate, PendingState>();
/** Internal module bridge consumes an actual native cap, never a caller JSON/AEAD declaration. */
export function consumePendingTargetCandidateForSeal(value: PendingTargetCandidate) {
  const state = pendingTargets.get(value);
  requireRecord(state);
  const fence = () => {
    state.phase = "fenced";
    fenceTargetCandidatePreparation(state.preparation);
    state.stopWriter();
  };
  // A nested/repeated denial fences the saved capability even when that call never owned
  // a reservation. A caller catching its error cannot restore the outer operation.
  const phase = state.phase;
  if (phase !== "pending") {
    fence();
    throw new Error("invalid-target-candidate");
  }
  state.phase = "sealing";
  const check = () => {
    try {
      requireRecord(state.phase === "sealing");
      assertTargetCandidatePreparation(state.preparation);
      requireRecord(state.phase === "sealing");
      state.checkWriter();
      if (state.boundary)
        assertInfrastructureBaselineRunProof(state.boundary.proof, state.boundary.request);
      requireRecord(state.phase === "sealing");
      state.checkWriter();
    } catch {
      fence();
      throw new Error("invalid-target-candidate");
    }
  };
  return Object.freeze({
    declaration: state.declaration,
    check,
    fence,
    beforeSeal: async () => {
      check();
      await state.beforeSeal();
      check();
    },
    within: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await withinTargetCandidatePreparation(state.preparation, () =>
          state.boundary
            ? withinInfrastructureBaselineRunProof(
                state.boundary.proof,
                state.boundary.request,
                async () => {
                  check();
                  const value = await work();
                  check();
                  return value;
                },
              )
            : Promise.resolve().then(async () => {
                check();
                const value = await work();
                check();
                return value;
              }),
        );
      } catch {
        fence();
        throw new Error("invalid-target-candidate");
      }
    },
    complete: () => {
      check();
      state.phase = "sealed";
    },
  });
}

/** GET null means a definite absent key only, never permission denial or an ambiguous failure. */
export interface ControlStore {
  /** Optional synchronous refusal only; it cannot approve an object or renew authority. */
  read(key: string, beforeRead?: () => void): Promise<Uint8Array | null>;
  /** Trusted wrappers invoke this synchronous fence after awaited checks, before raw mutation. */
  write(key: string, bytes: Uint8Array, beforeWrite?: () => void): Promise<void>;
}

/** Authenticated encryption binds ciphertext to both backend and object path (no cross-key replay). */
export class RecordCodec {
  // Derived key material and backend bindings must not become ordinary diagnostic properties.
  readonly #key: Buffer;
  readonly #backend: string;
  constructor(passphrase: string, backend: string) {
    requireRecord(passphrase.length >= 32);
    digest(backend);
    this.#backend = backend;
    // Separate the control-record key from native state encryption and handoff HMAC domains.
    this.#key = scryptSync(passphrase, `${domain}:${backend}`, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
  }
  seal(path: string, value: unknown): Uint8Array {
    const plaintext = Buffer.from(canonical(value));
    requireRecord(plaintext.length <= limit);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`${domain}:${this.#backend}:${path}`));
    return Buffer.concat([
      Buffer.from("TIC1"),
      nonce,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  open(path: string, bytes: Uint8Array): unknown {
    try {
      const data = Buffer.from(bytes);
      requireRecord(
        data.length >= 32 && data.length <= limit + 32 && data.subarray(0, 4).toString() === "TIC1",
      );
      const decipher = createDecipheriv("aes-256-gcm", this.#key, data.subarray(4, 16));
      decipher.setAAD(Buffer.from(`${domain}:${this.#backend}:${path}`));
      decipher.setAuthTag(data.subarray(-16));
      return JSON.parse(
        Buffer.concat([decipher.update(data.subarray(16, -16)), decipher.final()]).toString(),
      );
    } catch {
      throw new Error("invalid-control-record");
    }
  }
}

/**
 * Private records for the reviewed Infrastructure workflow. The protected job and its environment
 * credentials authorize work; these records detect stale inputs and interrupted operations.
 * One Actions concurrency group must enclose inspect→begin→provider Apply→finish. Readback and
 * refusing existing history keys are recovery checks, not a storage lock or conditional write.
 */
export class InfrastructureRecords {
  readonly #store: ControlStore;
  readonly #codec: RecordCodec;
  constructor(store: ControlStore, codec: RecordCodec) {
    this.#store = store;
    this.#codec = codec;
  }
  async #read(path: string): Promise<unknown | null> {
    const bytes = await this.#store.read(path);
    return bytes === null ? null : this.#codec.open(path, encryptedBytes(bytes));
  }
  async #persist(path: string, value: unknown, historical = false): Promise<void> {
    if (historical) requireRecord((await this.#store.read(path)) === null);
    const bytes = this.#codec.seal(path, value);
    await this.#store.write(path, bytes);
    const readback = await this.#store.read(path);
    requireRecord(readback !== null && Buffer.from(bytes).equals(encryptedBytes(readback)));
  }
  async #head(): Promise<Head | null> {
    const value = await this.#read("current");
    if (value === null) return null;
    const head = exact(value, ["baseline", "pending"]);
    if (head.baseline !== null) generation(head.baseline);
    if (head.pending !== null) generation(head.pending);
    requireRecord(head.baseline !== null || head.pending !== null);
    return head as unknown as Head;
  }
  async #snapshot(state: StateEvidence): Promise<Snapshot> {
    const current = await this.#head();
    if (current === null) return { generation: null, state, inputs: null };
    generation(current.baseline);
    requireRecord(current.pending === null);
    const id = current.baseline;
    const intent = await this.#read(`intents/${id}`);
    const baseline = await this.#read(`baselines/${id}`);
    const completion = await this.#read(`completed/${id}`);
    const linked = validateInfrastructureBaselineLinks({
      generation: id,
      current,
      intent,
      baseline,
      completion,
      state,
    });
    return { generation: id, state, inputs: linked.intent.inputs };
  }
  async inspect(state: StateEvidence): Promise<Snapshot> {
    state = capturePrivate(state) as StateEvidence;
    validateState(state);
    return this.#snapshot(state);
  }
  async begin(
    snapshot: Snapshot,
    inputs: ObjectValue,
    run: RunIdentity,
    binding: string,
    kind: "apply" | "baseline",
  ): Promise<Ticket> {
    const captured = capturePrivate({ snapshot, inputs, run, binding, kind }) as {
      snapshot: Snapshot;
      inputs: ObjectValue;
      run: RunIdentity;
      binding: string;
      kind: "apply" | "baseline";
    };
    ({ snapshot, inputs, run, binding, kind } = captured);
    exact(snapshot, ["generation", "state", "inputs"]);
    validateState(snapshot.state);
    requireRecord(isDeepStrictEqual(await this.#snapshot(snapshot.state), snapshot));
    requireRecord(
      kind === "baseline" ? snapshot.generation === null : snapshot.generation !== null,
    );
    const intent: Intent = {
      generation: randomUUID(),
      previous: snapshot.generation,
      kind,
      run,
      binding,
      inputs,
      before: snapshot.state,
    };
    validateIntent(intent);
    // Provider Apply may start only after BOTH writes and their exact readbacks succeed.
    await this.#persist(`intents/${intent.generation}`, intent, true);
    await this.#persist("current", { baseline: intent.previous, pending: intent.generation });
    return { generation: intent.generation, binding };
  }
  async finish(ticket: Ticket, state: StateEvidence): Promise<void> {
    const captured = capturePrivate({ ticket, state }) as { ticket: Ticket; state: StateEvidence };
    ({ ticket, state } = captured);
    exact(ticket, ["generation", "binding"]);
    generation(ticket.generation);
    digest(ticket.binding);
    validateState(state);
    const intent = await this.#read(`intents/${ticket.generation}`);
    validateIntent(intent);
    requireRecord(intent.binding === ticket.binding);
    requireRecord(
      isDeepStrictEqual(await this.#head(), {
        baseline: intent.previous,
        pending: intent.generation,
      }),
    );
    requireRecord(state.lineage === intent.before.lineage);
    // Baseline establishment changes no state; a real Apply must advance the same state lineage.
    requireRecord(
      intent.kind === "baseline"
        ? isDeepStrictEqual(state, intent.before)
        : state.serial > intent.before.serial,
    );
    const baseline: Baseline = { intent, state };
    await this.#persist(`baselines/${intent.generation}`, baseline, true);
    await this.#persist("current", { baseline: intent.generation, pending: intent.generation });
    await this.#persist(
      `completed/${intent.generation}`,
      { generation: intent.generation, baseline: privateDigest(baseline) },
      true,
    );
    await this.#persist("current", { baseline: intent.generation, pending: null });
    // Reopen every completion link before returning a usable applied-input baseline.
    requireRecord((await this.#snapshot(state)).generation === ticket.generation);
  }
}

/** Dormant target-projection journal; the manual Infrastructure CLI uses InfrastructureRecords. */
export class InfrastructureJournal {
  // Trusted dependency capabilities remain caller-owned; instance shadows cannot replace them.
  readonly #store: ControlStore;
  readonly #storeRead: ControlStore["read"];
  readonly #operationController: ControlJournalOperationController | undefined;
  readonly #codec: RecordCodec;
  readonly #verify: VerifyInfrastructureBaselineRun | undefined;
  readonly #clock: () => number;
  readonly #writers = new WeakMap<Ticket, CurrentWriter>();
  readonly #generations = new Map<string, CurrentWriter>();
  constructor(
    store: ControlStore,
    codec: RecordCodec,
    dependencies: {
      verifyBaselineRun?: VerifyInfrastructureBaselineRun;
      now?: () => number;
      operationController?: ControlJournalOperationController;
    } = {},
  ) {
    this.#store = store;
    this.#operationController = dependencies.operationController;
    if (this.#operationController)
      assertControlJournalOperationController(this.#operationController, store);
    const read = store.read;
    requireRecord(typeof read === "function");
    this.#storeRead = read.bind(store);
    this.#codec = codec;
    const verify = dependencies.verifyBaselineRun;
    requireRecord(verify === undefined || typeof verify === "function");
    this.#verify = verify;
    const clock = dependencies.now ?? Date.now;
    requireRecord(typeof clock === "function");
    this.#clock = clock;
  }
  #capture<T>(context: ControlJournalOperation | undefined, work: () => T): T {
    return context ? context.capture(work) : work();
  }
  async #read(
    context: ControlJournalOperation | undefined,
    path: string,
    denial?: () => void,
  ): Promise<unknown | null> {
    const bytes = await this.#readBytes(context, path, null, denial);
    return bytes === null ? null : this.#codec.open(path, encryptedBytes(bytes));
  }
  #readFence(
    context: ControlJournalOperation | undefined,
    boundary: ExecutionBoundary | null,
    denial?: () => void,
  ): (() => void) | undefined {
    if (context === undefined && boundary === null && denial === undefined) return undefined;
    return () => {
      context?.assert();
      requireRecord(denial?.() === undefined);
      if (boundary) assertInfrastructureBaselineRunProof(boundary.proof, boundary.request);
      // An execution assertion's clock can consume the shorter candidate preparation.
      context?.assert();
      requireRecord(denial?.() === undefined);
    };
  }
  async #readBytes(
    context: ControlJournalOperation | undefined,
    path: string,
    boundary: ExecutionBoundary | null = null,
    denial?: () => void,
  ): Promise<Uint8Array | null> {
    const fence = this.#readFence(context, boundary, denial);
    fence?.();
    const bytes = await this.#within(boundary, () => {
      fence?.();
      return context ? context.store.read(path, fence) : this.#storeRead(path, fence);
    });
    fence?.();
    return bytes;
  }
  async #within<T>(boundary: ExecutionBoundary | null, work: () => Promise<T>): Promise<T> {
    if (boundary === null) return work();
    return withinInfrastructureBaselineRunProof(boundary.proof, boundary.request, () => {
      // Recheck at the actual invocation, including a queued mutation, after scheduling.
      assertInfrastructureBaselineRunProof(boundary.proof, boundary.request);
      return work();
    });
  }
  async #persist(
    context: ControlJournalOperation | undefined,
    path: string,
    value: unknown,
    historical = false,
    boundary: ExecutionBoundary | null = null,
    denial?: () => void,
  ): Promise<void> {
    // Refusing an existing history key is a safety check, NOT atomic conditional creation.
    denial?.();
    if (historical)
      requireRecord((await this.#readBytes(context, path, boundary, denial)) === null);
    denial?.();
    const bytes = this.#capture(context, () => this.#codec.seal(path, value));
    denial?.();
    const beforeWrite =
      boundary === null && denial === undefined
        ? undefined
        : () => {
            denial?.();
            if (boundary) assertInfrastructureBaselineRunProof(boundary.proof, boundary.request);
          };
    await this.#within(boundary, () =>
      (context?.store ?? this.#store).write(path, bytes, beforeWrite),
    );
    denial?.();
    const readback = await this.#readBytes(context, path, boundary, denial);
    denial?.();
    requireRecord(
      readback !== null && Buffer.from(bytes).equals(Buffer.from(encryptedBytes(readback))),
    );
    denial?.();
  }
  async #head(
    context: ControlJournalOperation | undefined,
    denial?: () => void,
  ): Promise<Head | null> {
    const value = await this.#read(context, "current", denial);
    if (value === null) return null;
    const h = exact(value, ["baseline", "pending"]);
    if (h.baseline !== null) generation(h.baseline);
    if (h.pending !== null) generation(h.pending);
    requireRecord(h.baseline !== null || h.pending !== null);
    return h as unknown as Head;
  }
  #validateIntent(value: unknown): asserts value is Intent {
    validateIntent(value);
  }
  async #structural(
    context: ControlJournalOperation | undefined,
    state: StateEvidence,
    boundary: ExecutionBoundary | null = null,
    denial?: () => void,
  ): Promise<StructuralProjection> {
    const records = new Map<string, Uint8Array>();
    const read = async (path: string) => {
      denial?.();
      const value = await this.#readBytes(context, path, boundary, denial);
      denial?.();
      if (value === null) return null;
      const bytes = encryptedBytes(value);
      denial?.();
      records.set(path, bytes);
      return this.#codec.open(path, bytes);
    };
    const current = await read("current");
    if (current === null)
      return {
        records,
        snapshot: { generation: null, state, inputs: null } as Snapshot,
        request: null,
        links: null,
      };
    const head = exact(current, ["baseline", "pending"]);
    generation(head.baseline);
    requireRecord(head.pending === null);
    const id = head.baseline;
    const intent = await read(`intents/${id}`),
      baseline = await read(`baselines/${id}`),
      completion = await read(`completed/${id}`);
    const linked = validateInfrastructureBaselineLinks({
      generation: id,
      current,
      intent,
      baseline,
      completion,
      state,
    });
    return {
      records,
      snapshot: { generation: id, state, inputs: linked.intent.inputs } as Snapshot,
      request: {
        kind: linked.intent.kind,
        run: linked.intent.run,
      } as InfrastructureBaselineRunRequest,
      links: { current, intent: linked.intent, baseline, completion } as CompletedProjectionLinks,
    };
  }
  /** Missing baseline is review-required; missing referenced history or any pending intent stops. */
  async #inspection(
    context: ControlJournalOperation | undefined,
    state: StateEvidence,
    denial?: () => void,
  ) {
    const first = await this.#structural(context, state, null, denial);
    if (first.request === null)
      return { snapshot: first.snapshot, boundary: null, links: null, records: first.records };
    const verify = this.#verify;
    requireRecord(verify);
    // GET evidence proves ORIGINAL execution only; these exact private records remain locally
    // bound by their authenticated backend/path bytes, never by an echoed GitHub hash claim.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proof: InfrastructureBaselineRunProof;
    try {
      proof = await Promise.race([
        Promise.resolve().then(() => {
          denial?.();
          return verify(
            capturePrivate(first.request) as InfrastructureBaselineRunRequest,
            this.#readFence(context, null, denial),
          );
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("invalid-control-record")), 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    denial?.();
    assertInfrastructureBaselineRunProof(proof, first.request);
    const boundary = { proof, request: first.request };
    const final = await this.#structural(context, state, boundary, denial);
    requireRecord(
      isDeepStrictEqual(first.snapshot, final.snapshot) &&
        isDeepStrictEqual(first.records, final.records),
    );
    assertInfrastructureBaselineRunProof(proof, first.request);
    denial?.();
    return {
      snapshot: capturePrivate(first.snapshot) as Snapshot,
      boundary,
      links: final.links,
      records: final.records,
    };
  }
  async inspect(state: StateEvidence): Promise<Snapshot> {
    return withinControlJournalOperation(this.#operationController, this.#store, (context) =>
      this.#inspect(context, state),
    );
  }
  async #inspect(
    context: ControlJournalOperation | undefined,
    state: StateEvidence,
  ): Promise<Snapshot> {
    state = this.#capture(context, () => capturePrivate(state)) as StateEvidence;
    validateState(state);
    return (await this.#inspection(context, state)).snapshot;
  }
  async begin(
    snapshot: Snapshot,
    inputs: ObjectValue,
    run: RunIdentity,
    binding: string,
    kind: "apply" | "baseline",
  ): Promise<Ticket> {
    return withinControlJournalOperation(this.#operationController, this.#store, (context) =>
      this.#begin(context, snapshot, inputs, run, binding, kind),
    );
  }
  async #begin(
    context: ControlJournalOperation | undefined,
    snapshot: Snapshot,
    inputs: ObjectValue,
    run: RunIdentity,
    binding: string,
    kind: "apply" | "baseline",
  ): Promise<Ticket> {
    const captured = this.#capture(context, () =>
      capturePrivate({ snapshot, inputs, run, binding, kind }),
    ) as {
      snapshot: Snapshot;
      inputs: ObjectValue;
      run: RunIdentity;
      binding: string;
      kind: "apply" | "baseline";
    };
    ({ snapshot, inputs, run, binding, kind } = captured);
    validateRun(run);
    digest(binding);
    object(inputs);
    validateState(snapshot.state);
    const inspected = await this.#inspection(context, snapshot.state);
    requireRecord(isDeepStrictEqual(inspected.snapshot, snapshot));
    requireRecord(
      kind === "baseline" ? snapshot.generation === null : snapshot.generation !== null,
    );
    const intent: Intent = {
      generation: randomUUID(),
      previous: snapshot.generation,
      kind,
      run,
      binding,
      inputs,
      before: snapshot.state,
    };
    this.#validateIntent(intent);
    await this.#persist(context, `intents/${intent.generation}`, intent, true, inspected.boundary);
    // A crash after this reference is persisted requires owner reconciliation, even before Apply.
    await this.#persist(
      context,
      "current",
      { baseline: snapshot.generation, pending: intent.generation },
      false,
      inspected.boundary,
    );
    if (inspected.boundary)
      assertInfrastructureBaselineRunProof(inspected.boundary.proof, inspected.boundary.request);
    const ticket = { generation: intent.generation, binding };
    const writer: CurrentWriter = {
      original: { ...ticket },
      intent: capturePrivate(intent) as Intent,
      predecessor:
        inspected.links === null
          ? null
          : (capturePrivate(inspected.links) as CompletedProjectionLinks),
      predecessorBytes: new Map(
        [...inspected.records]
          .filter(([path]) => path !== "current")
          .map(([path, bytes]) => [path, Uint8Array.from(bytes)]),
      ),
      phase: "writing",
    };
    context?.onFailure(() => {
      writer.phase = "fenced";
    });
    this.#writers.set(ticket, writer);
    this.#generations.set(ticket.generation, writer);
    return context ? context.retain(ticket) : ticket;
  }
  async finish(ticket: Ticket, state: StateEvidence): Promise<void> {
    try {
      return await withinControlJournalOperation(
        this.#operationController,
        this.#store,
        (context) => this.#finishEntry(context, ticket, state),
      );
    } catch (error) {
      // A first-clock refusal can precede private helper entry. It still consumes the exact
      // native writer's transition, so a later deferred projection cannot resurrect it.
      const writer = this.#writers.get(ticket);
      if (writer) writer.phase = "fenced";
      throw error;
    }
  }
  async #finishEntry(
    context: ControlJournalOperation | undefined,
    ticket: Ticket,
    state: StateEvidence,
  ): Promise<void> {
    // A compatible serialized/manual finish grants no current-ticket projection. Matching
    // legacy attempts also fence pending data already prepared by this journal instance.
    const native = this.#writers.get(ticket);
    const nativePhase = native?.phase;
    if (native) native.phase = "fenced";
    requireRecord(nativePhase !== "projecting");
    const captured = this.#capture(context, () => capturePrivate({ ticket, state })) as {
      ticket: Ticket;
      state: StateEvidence;
    };
    ({ ticket, state } = captured);
    const writer = this.#generations.get(ticket.generation);
    if (writer) {
      const phase = writer.phase;
      writer.phase = "fenced";
      requireRecord(phase !== "projecting");
    }
    await this.#finish(context, ticket, state);
  }
  async #finish(
    context: ControlJournalOperation | undefined,
    ticket: Ticket,
    state: StateEvidence,
    denial?: () => void,
    expectedIntent?: Intent,
  ) {
    denial?.();
    generation(ticket.generation);
    digest(ticket.binding);
    validateState(state);
    const intent = await this.#read(context, `intents/${ticket.generation}`, denial);
    this.#validateIntent(intent);
    requireRecord(intent.binding === ticket.binding);
    if (expectedIntent) requireRecord(isDeepStrictEqual(intent, expectedIntent));
    requireRecord(
      isDeepStrictEqual(await this.#head(context, denial), {
        baseline: intent.previous,
        pending: intent.generation,
      }),
    );
    requireRecord(state.lineage === intent.before.lineage);
    // Reviewed baseline adoption writes no provider/state changes. Apply must advance state.
    requireRecord(
      intent.kind === "baseline"
        ? isDeepStrictEqual(state, intent.before)
        : state.serial > intent.before.serial,
    );
    const baseline: Baseline = { intent, state };
    await this.#persist(context, `baselines/${intent.generation}`, baseline, true, null, denial);
    await this.#persist(
      context,
      "current",
      { baseline: intent.generation, pending: intent.generation },
      false,
      null,
      denial,
    );
    await this.#persist(
      context,
      `completed/${intent.generation}`,
      { generation: intent.generation, baseline: privateDigest(baseline) },
      true,
      null,
      denial,
    );
    await this.#persist(
      context,
      "current",
      { baseline: intent.generation, pending: null },
      false,
      null,
      denial,
    );
    // Reopen all links, not merely the last write, before downstream use is permitted.
    // This current writer JOB has not finished yet. Structural reopen supplies no downstream
    // authority; subsequent ordinary inspect/begin independently require its final success.
    const reopened = await this.#structural(context, state, null, denial);
    requireRecord(reopened.snapshot.generation === ticket.generation);
    denial?.();
    return reopened;
  }
  /** The factory-captured clock starts a denial-only preparation, never a job/approval proof. */
  prepareTargetCandidates(input: {
    targets: readonly TargetRole[];
    release: ReleaseIdentity;
    producer: AppliedTargetProducer;
    expires_at?: number;
  }): TargetCandidatePreparation {
    assertControlJournalPublicEntry(this.#operationController, this.#store);
    return prepareTargetCandidates(input, { now: this.#clock });
  }
  async #reopenPredecessor(
    context: ControlJournalOperation | undefined,
    writer: CurrentWriter,
    denial: () => void,
  ): Promise<void> {
    for (const [path, expected] of writer.predecessorBytes) {
      denial();
      const value = await this.#readBytes(context, path, null, denial);
      denial();
      requireRecord(Buffer.from(encryptedBytes(value)).equals(Buffer.from(expected)));
      denial();
    }
    denial();
  }
  async #reopenProjection(
    context: ControlJournalOperation | undefined,
    state: StateEvidence,
    records: Map<string, Uint8Array>,
    boundary: ExecutionBoundary | null,
    denial: () => void,
  ): Promise<void> {
    const reopened = await this.#structural(context, state, boundary, denial);
    requireRecord(isDeepStrictEqual(reopened.records, records));
    denial();
  }
  #targetCandidates(
    preparation: TargetCandidatePreparation,
    data: TargetCandidatePreparationData,
    evidence: TargetProjectionEvidence,
    reopened: StructuralProjection,
    prior: CompletedProjectionLinks | null,
    boundary: ExecutionBoundary | null,
    mode: "apply" | "no-changes",
    checkWriter: () => void,
    stopWriter: () => void,
    beforeSeal: () => Promise<void>,
  ): readonly PendingTargetCandidate[] {
    const links = reopened.links;
    requireRecord(links && reopened.snapshot.generation);
    const declarations = data.targets.map((target) => {
      assertTargetCandidatePreparation(preparation);
      checkWriter();
      const envelope = deriveAppliedTarget({
        target,
        release: data.release,
        producer: data.producer,
        mode,
        ...evidence,
        snapshot: reopened.snapshot,
        completed: links,
        prior_completed:
          prior === null
            ? null
            : {
                generation: prior.intent.generation,
                intent: prior.intent,
                baseline: prior.baseline,
                completion: prior.completion,
              },
      });
      assertTargetCandidatePreparation(preparation);
      checkWriter();
      return targetCandidateDeclaration(
        {
          schema: 2,
          purpose: "tarubot-applied-target-candidate-v2",
          target,
          release: data.release,
          producer: data.producer,
          mode,
          source_job_path: mode === "apply" ? targetIssuancePins.apply : targetIssuancePins.plan,
          baseline_writer: { kind: links.intent.kind, run: links.intent.run },
          envelope,
          issued_at: data.issued_at,
          expires_at: data.expires_at,
        },
        { target, release: data.release, producer: data.producer, mode },
      );
    });
    assertTargetCandidatePreparation(preparation);
    checkWriter();
    if (boundary) assertInfrastructureBaselineRunProof(boundary.proof, boundary.request);
    return Object.freeze(
      declarations.map((declaration) => {
        const value = Object.freeze({}) as PendingTargetCandidate;
        pendingTargets.set(value, {
          declaration,
          preparation,
          boundary,
          checkWriter,
          stopWriter,
          beforeSeal,
          phase: "pending",
        });
        return value;
      }),
    );
  }
  /** No-change projection retains the same real original-writer proof and exact reopened bytes. */
  async inspectTargetCandidates(
    preparation: TargetCandidatePreparation,
    value: TargetProjectionEvidence & { expected_snapshot: Snapshot },
  ): Promise<readonly PendingTargetCandidate[]> {
    try {
      assertControlJournalPublicEntry(this.#operationController, this.#store);
    } catch {
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
    // Deferred native baseline proofs retain their original24 refusal, never a closed whole-method cap.
    return this.#inspectTargetCandidates(undefined, preparation, value);
  }
  async #inspectTargetCandidates(
    context: ControlJournalOperation | undefined,
    preparation: TargetCandidatePreparation,
    value: TargetProjectionEvidence & { expected_snapshot: Snapshot },
  ): Promise<readonly PendingTargetCandidate[]> {
    let stopped = false;
    try {
      const data = reserveTargetCandidatePreparation(preparation);
      const checkWriter = () => requireRecord(!stopped);
      const denial = () => {
        assertTargetCandidatePreparation(preparation);
        checkWriter();
      };
      const captured = exact(
        this.#capture(context, () => capturePrivate(value)),
        ["expected_snapshot", "plan", "applied_show", "state_readback", "state_reopened"],
      );
      denial();
      const evidence = {
        plan: captured.plan,
        applied_show: captured.applied_show,
        state_readback: captured.state_readback,
        state_reopened: captured.state_reopened,
      };
      const observed = stateEvidence(evidence.state_readback);
      requireRecord(isDeepStrictEqual(stateEvidence(evidence.state_reopened), observed));
      const inspected = await withinTargetCandidatePreparation(preparation, () =>
        this.#inspection(context, observed, denial),
      );
      denial();
      requireRecord(
        inspected.boundary &&
          inspected.links &&
          isDeepStrictEqual(inspected.snapshot, captured.expected_snapshot),
      );
      const { boundary } = inspected;
      const reopened = {
        snapshot: inspected.snapshot,
        records: inspected.records,
        request: boundary.request,
        links: inspected.links,
      };
      const stopWriter = () => {
        stopped = true;
      };
      context?.onFailure(() => {
        stopped = true;
        fenceTargetCandidatePreparation(preparation);
      });
      const beforeSeal = () =>
        this.#reopenProjection(undefined, observed, inspected.records, boundary, denial);
      return this.#targetCandidates(
        preparation,
        data,
        evidence,
        reopened,
        null,
        boundary,
        "no-changes",
        checkWriter,
        stopWriter,
        beforeSeal,
      );
    } catch {
      stopped = true;
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
  }
  /**
   * Current-ticket projection is pending data, not ordinary baseline reuse. Reserve the exact
   * in-process begin object before caller hooks; copied/manual tickets cannot enter this path.
   */
  async finishTargetCandidates(
    ticket: Ticket,
    preparation: TargetCandidatePreparation,
    value: TargetProjectionEvidence,
  ): Promise<readonly PendingTargetCandidate[]> {
    try {
      assertControlJournalPublicEntry(this.#operationController, this.#store);
    } catch {
      const writer = this.#writers.get(ticket);
      if (writer) writer.phase = "fenced";
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
    return this.#finishTargetCandidates(undefined, ticket, preparation, value);
  }
  async #finishTargetCandidates(
    context: ControlJournalOperation | undefined,
    ticket: Ticket,
    preparation: TargetCandidatePreparation,
    value: TargetProjectionEvidence,
  ): Promise<readonly PendingTargetCandidate[]> {
    const writer = this.#writers.get(ticket);
    if (!writer) {
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
    const phase = writer.phase;
    writer.phase = "fenced";
    if (phase !== "writing") {
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
    writer.phase = "projecting";
    context?.onFailure(() => {
      writer.phase = "fenced";
      fenceTargetCandidatePreparation(preparation);
    });
    try {
      const data = reserveTargetCandidatePreparation(preparation);
      const originalTicket = () => {
        requireRecord(isDeepStrictEqual(capturePrivate(ticket), writer.original));
      };
      const checkWriter = () => {
        requireRecord(writer.phase === "projecting");
        originalTicket();
        requireRecord(writer.phase === "projecting");
      };
      const denial = () => {
        assertTargetCandidatePreparation(preparation);
        checkWriter();
      };
      const capturedTicket = this.#capture(context, () => capturePrivate(ticket)) as Ticket;
      requireRecord(
        isDeepStrictEqual(capturedTicket, writer.original) &&
          writer.intent.kind === "apply" &&
          isDeepStrictEqual(writer.intent.run, {
            commit: data.release.commit,
            run: data.release.publication_run,
          }) &&
          writer.predecessor,
      );
      const evidence = exact(
        this.#capture(context, () => capturePrivate(value)),
        ["plan", "applied_show", "state_readback", "state_reopened"],
      ) as unknown as TargetProjectionEvidence;
      denial();
      const observed = stateEvidence(evidence.state_readback);
      requireRecord(isDeepStrictEqual(stateEvidence(evidence.state_reopened), observed));
      const reopened = await withinTargetCandidatePreparation(preparation, async () => {
        await this.#reopenPredecessor(context, writer, denial);
        const result = await this.#finish(context, capturedTicket, observed, denial, writer.intent);
        await this.#reopenPredecessor(context, writer, denial);
        denial();
        return result;
      });
      denial();
      // Prepare every role atomically as local data; no partial candidate escapes if one fails.
      const candidates = this.#targetCandidates(
        preparation,
        data,
        evidence,
        reopened,
        writer.predecessor,
        null,
        "apply",
        checkWriter,
        () => {
          writer.phase = "fenced";
        },
        async () => {
          const pendingDenial = () => {
            assertTargetCandidatePreparation(preparation);
            requireRecord(writer.phase === "projected");
            originalTicket();
            requireRecord(writer.phase === "projected");
          };
          await this.#reopenPredecessor(undefined, writer, pendingDenial);
          await this.#reopenProjection(undefined, observed, reopened.records, null, pendingDenial);
        },
      );
      writer.phase = "projected";
      // Pending guards require the final local phase and fence if legacy finish intervenes.
      for (const candidate of candidates) {
        const pending = pendingTargets.get(candidate);
        requireRecord(pending);
        pending.checkWriter = () => {
          requireRecord(writer.phase === "projected");
          originalTicket();
          requireRecord(writer.phase === "projected");
        };
      }
      return candidates;
    } catch {
      writer.phase = "fenced";
      fenceTargetCandidatePreparation(preparation);
      throw new Error("invalid-target-candidate");
    }
  }
}

/** Compare known planned values to the post-Apply show; only explicitly unknown subtrees vary. */
function matches(expected: unknown, actual: unknown, unknown: unknown): boolean {
  if (unknown === true) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) =>
        matches(v, actual[i], Array.isArray(unknown) ? unknown[i] : undefined),
      )
    );
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const a = object(actual);
    const u =
      unknown !== null && typeof unknown === "object" && !Array.isArray(unknown)
        ? object(unknown)
        : {};
    // Unknown fields may be omitted in planned_values; no other extra field is permitted.
    return (
      Object.keys(a).every((k) => Object.hasOwn(expected, k) || u[k] === true) &&
      Object.entries(expected).every(([k, v]) => Object.hasOwn(a, k) && matches(v, a[k], u[k]))
    );
  }
  return isDeepStrictEqual(expected, actual);
}
export function verifyAppliedPlan(plan: unknown, shownState: unknown): void {
  const p = object(plan);
  const s = object(shownState);
  requireRecord(
    p.format_version === "1.2" &&
      s.format_version === "1.0" &&
      p.terraform_version === "1.12.6" &&
      s.terraform_version === "1.12.6",
  );
  requireRecord(p.errored === false && Array.isArray(p.resource_changes));
  const planned = object(p.planned_values);
  const actual = object(s.values);
  const resources = (values: ObjectValue) => {
    const root = object(values.root_module);
    requireRecord(root.child_modules === undefined && Array.isArray(root.resources));
    const entries = root.resources.map((value: unknown) => {
      const r = object(value);
      requireRecord(typeof r.address === "string" && r.mode === "managed");
      return [r.address, r] as const;
    });
    requireRecord(new Set(entries.map(([key]) => key)).size === entries.length);
    return new Map(entries);
  };
  const expected = resources(planned);
  const observed = resources(actual);
  requireRecord(isDeepStrictEqual([...expected.keys()].sort(), [...observed.keys()].sort()));
  const changes = new Map<string, ObjectValue>();
  for (const entry of p.resource_changes) {
    const r = object(entry);
    requireRecord(typeof r.address === "string" && !changes.has(r.address));
    changes.set(r.address, object(r.change));
  }
  for (const [address, resource] of expected) {
    const found = observed.get(address);
    const change = changes.get(address);
    requireRecord(found && change);
    for (const key of ["mode", "type", "name", "provider_name", "index"])
      requireRecord(isDeepStrictEqual(resource[key], found[key]));
    requireRecord(matches(resource.values, found.values, change.after_unknown));
  }
  const outputs = object(planned.outputs ?? {});
  const found = object(actual.outputs ?? {});
  const outputChanges = object(p.output_changes ?? {});
  requireRecord(isDeepStrictEqual(Object.keys(outputs).sort(), Object.keys(found).sort()));
  for (const [key, value] of Object.entries(outputs)) {
    const output = object(value);
    const observedOutput = object(found[key]);
    const change = object(outputChanges[key]);
    requireRecord(
      output.sensitive === observedOutput.sensitive &&
        matches(output.value, observedOutput.value, change.after_unknown),
    );
  }
}
