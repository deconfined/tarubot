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
  assertInfrastructureBaselineRunProof,
  withinInfrastructureBaselineRunProof,
  type InfrastructureBaselineRunRequest,
  type InfrastructureBaselineRunProof,
  type VerifyInfrastructureBaselineRun,
} from "./infra-baseline-run.js";

type ObjectValue = Record<string, unknown>;
const domain = "tarubot-infra-control-v1";
const limit = 2 * 1024 * 1024;

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

/** GET null means a definite absent key only, never permission denial or an ambiguous failure. */
export interface ControlStore {
  read(key: string): Promise<Uint8Array | null>;
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

/** One shared workflow group must enclose read→begin→provider Apply→finish, including recovery. */
export class InfrastructureJournal {
  // Trusted dependency capabilities remain caller-owned; instance shadows cannot replace them.
  readonly #store: ControlStore;
  readonly #codec: RecordCodec;
  readonly #verify: VerifyInfrastructureBaselineRun | undefined;
  constructor(
    store: ControlStore,
    codec: RecordCodec,
    dependencies: { verifyBaselineRun?: VerifyInfrastructureBaselineRun } = {},
  ) {
    this.#store = store;
    this.#codec = codec;
    const verify = dependencies.verifyBaselineRun;
    requireRecord(verify === undefined || typeof verify === "function");
    this.#verify = verify;
  }
  async #read(path: string): Promise<unknown | null> {
    const bytes = await this.#store.read(path);
    return bytes === null ? null : this.#codec.open(path, bytes);
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
    path: string,
    value: unknown,
    historical = false,
    boundary: ExecutionBoundary | null = null,
  ): Promise<void> {
    // Refusing an existing history key is a safety check, NOT atomic conditional creation.
    if (historical)
      requireRecord((await this.#within(boundary, () => this.#store.read(path))) === null);
    const bytes = this.#codec.seal(path, value);
    const beforeWrite =
      boundary === null
        ? undefined
        : () => assertInfrastructureBaselineRunProof(boundary.proof, boundary.request);
    await this.#within(boundary, () => this.#store.write(path, bytes, beforeWrite));
    const readback = await this.#within(boundary, () => this.#store.read(path));
    requireRecord(readback !== null && Buffer.from(bytes).equals(Buffer.from(readback)));
  }
  async #head(): Promise<Head | null> {
    const value = await this.#read("current");
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
  async #structural(state: StateEvidence, boundary: ExecutionBoundary | null = null) {
    const records = new Map<string, Uint8Array>();
    const read = async (path: string) => {
      const value = await this.#within(boundary, () => this.#store.read(path));
      if (value === null) return null;
      requireRecord(value instanceof Uint8Array && value.length > 0 && value.length <= limit + 32);
      const bytes = Uint8Array.from(value);
      records.set(path, bytes);
      return this.#codec.open(path, bytes);
    };
    const current = await read("current");
    if (current === null)
      return {
        records,
        snapshot: { generation: null, state, inputs: null } as Snapshot,
        request: null,
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
    };
  }
  /** Missing baseline is review-required; missing referenced history or any pending intent stops. */
  async #inspection(state: StateEvidence) {
    const first = await this.#structural(state);
    if (first.request === null) return { snapshot: first.snapshot, boundary: null };
    const verify = this.#verify;
    requireRecord(verify);
    // GET evidence proves ORIGINAL execution only; these exact private records remain locally
    // bound by their authenticated backend/path bytes, never by an echoed GitHub hash claim.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proof: InfrastructureBaselineRunProof;
    try {
      proof = await Promise.race([
        Promise.resolve().then(() =>
          verify(capturePrivate(first.request) as InfrastructureBaselineRunRequest),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("invalid-control-record")), 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assertInfrastructureBaselineRunProof(proof, first.request);
    const boundary = { proof, request: first.request };
    const final = await this.#structural(state, boundary);
    requireRecord(
      isDeepStrictEqual(first.snapshot, final.snapshot) &&
        isDeepStrictEqual(first.records, final.records),
    );
    assertInfrastructureBaselineRunProof(proof, first.request);
    return { snapshot: capturePrivate(first.snapshot) as Snapshot, boundary };
  }
  async inspect(state: StateEvidence): Promise<Snapshot> {
    state = capturePrivate(state) as StateEvidence;
    validateState(state);
    return (await this.#inspection(state)).snapshot;
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
    validateRun(run);
    digest(binding);
    object(inputs);
    validateState(snapshot.state);
    const inspected = await this.#inspection(snapshot.state);
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
    await this.#persist(`intents/${intent.generation}`, intent, true, inspected.boundary);
    // A crash after this reference is persisted requires owner reconciliation, even before Apply.
    await this.#persist(
      "current",
      { baseline: snapshot.generation, pending: intent.generation },
      false,
      inspected.boundary,
    );
    if (inspected.boundary)
      assertInfrastructureBaselineRunProof(inspected.boundary.proof, inspected.boundary.request);
    return { generation: intent.generation, binding };
  }
  async finish(ticket: Ticket, state: StateEvidence): Promise<void> {
    const captured = capturePrivate({ ticket, state }) as { ticket: Ticket; state: StateEvidence };
    ({ ticket, state } = captured);
    generation(ticket.generation);
    digest(ticket.binding);
    validateState(state);
    const intent = await this.#read(`intents/${ticket.generation}`);
    this.#validateIntent(intent);
    requireRecord(intent.binding === ticket.binding);
    requireRecord(
      isDeepStrictEqual(await this.#head(), {
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
    await this.#persist(`baselines/${intent.generation}`, baseline, true);
    await this.#persist("current", { baseline: intent.generation, pending: intent.generation });
    await this.#persist(
      `completed/${intent.generation}`,
      { generation: intent.generation, baseline: privateDigest(baseline) },
      true,
    );
    await this.#persist("current", { baseline: intent.generation, pending: null });
    // Reopen all links, not merely the last write, before downstream use is permitted.
    // This current writer JOB has not finished yet. Structural reopen supplies no downstream
    // authority; subsequent ordinary inspect/begin independently require its final success.
    const reopened = await this.#structural(state);
    requireRecord(reopened.snapshot.generation === ticket.generation);
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
