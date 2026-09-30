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

type ObjectValue = Record<string, unknown>;
const domain = "tarubot-infra-control-v1";
const limit = 2 * 1024 * 1024;

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
export interface Ticket {
  generation: string;
  binding: string;
}

/** GET null means a definite absent key only, never permission denial or an ambiguous failure. */
export interface ControlStore {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
}

/** Authenticated encryption binds ciphertext to both backend and object path (no cross-key replay). */
export class RecordCodec {
  private readonly key: Buffer;
  constructor(
    passphrase: string,
    private readonly backend: string,
  ) {
    requireRecord(passphrase.length >= 32);
    digest(backend);
    // Separate the control-record key from native state encryption and handoff HMAC domains.
    this.key = scryptSync(passphrase, `${domain}:${backend}`, 32, {
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
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${domain}:${this.backend}:${path}`));
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
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(4, 16));
      decipher.setAAD(Buffer.from(`${domain}:${this.backend}:${path}`));
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
  constructor(
    private readonly store: ControlStore,
    private readonly codec: RecordCodec,
  ) {}
  private async read(path: string): Promise<unknown | null> {
    const bytes = await this.store.read(path);
    return bytes === null ? null : this.codec.open(path, bytes);
  }
  private async persist(path: string, value: unknown, historical = false): Promise<void> {
    // Refusing an existing history key is a safety check, NOT atomic conditional creation.
    if (historical) requireRecord((await this.store.read(path)) === null);
    const bytes = this.codec.seal(path, value);
    await this.store.write(path, bytes);
    const readback = await this.store.read(path);
    requireRecord(readback !== null && Buffer.from(bytes).equals(Buffer.from(readback)));
  }
  private async head(): Promise<Head | null> {
    const value = await this.read("current");
    if (value === null) return null;
    const h = exact(value, ["baseline", "pending"]);
    if (h.baseline !== null) generation(h.baseline);
    if (h.pending !== null) generation(h.pending);
    requireRecord(h.baseline !== null || h.pending !== null);
    return h as unknown as Head;
  }
  private validateIntent(value: unknown): asserts value is Intent {
    const i = exact(value, [
      "generation",
      "previous",
      "kind",
      "run",
      "binding",
      "inputs",
      "before",
    ]);
    generation(i.generation);
    if (i.previous !== null) generation(i.previous);
    requireRecord(i.kind === "apply" || i.kind === "baseline");
    requireRecord((i.kind === "baseline") === (i.previous === null));
    validateRun(i.run);
    digest(i.binding);
    object(i.inputs);
    validateState(i.before);
  }
  private async baseline(id: string): Promise<Baseline> {
    const b = exact(await this.read(`baselines/${id}`), ["intent", "state"]);
    this.validateIntent(b.intent);
    validateState(b.state);
    requireRecord(b.intent.generation === id);
    requireRecord(isDeepStrictEqual(await this.read(`intents/${id}`), b.intent));
    requireRecord(
      isDeepStrictEqual(await this.read(`completed/${id}`), {
        generation: id,
        baseline: privateDigest(b),
      }),
    );
    return b as unknown as Baseline;
  }
  /** Missing baseline is review-required; missing referenced history or any pending intent stops. */
  async inspect(state: StateEvidence): Promise<Snapshot> {
    validateState(state);
    const head = await this.head();
    if (head === null) return { generation: null, state, inputs: null };
    requireRecord(head.pending === null && head.baseline !== null);
    const baseline = await this.baseline(head.baseline);
    requireRecord(isDeepStrictEqual(baseline.state, state));
    return { generation: head.baseline, state, inputs: baseline.intent.inputs };
  }
  async begin(
    snapshot: Snapshot,
    inputs: ObjectValue,
    run: RunIdentity,
    binding: string,
    kind: "apply" | "baseline",
  ): Promise<Ticket> {
    validateRun(run);
    digest(binding);
    object(inputs);
    requireRecord(isDeepStrictEqual(await this.inspect(snapshot.state), snapshot));
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
    this.validateIntent(intent);
    await this.persist(`intents/${intent.generation}`, intent, true);
    // A crash after this reference is persisted requires owner reconciliation, even before Apply.
    await this.persist("current", { baseline: snapshot.generation, pending: intent.generation });
    return { generation: intent.generation, binding };
  }
  async finish(ticket: Ticket, state: StateEvidence): Promise<void> {
    generation(ticket.generation);
    digest(ticket.binding);
    validateState(state);
    const intent = await this.read(`intents/${ticket.generation}`);
    this.validateIntent(intent);
    requireRecord(intent.binding === ticket.binding);
    requireRecord(
      isDeepStrictEqual(await this.head(), {
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
    await this.persist(`baselines/${intent.generation}`, baseline, true);
    await this.persist("current", { baseline: intent.generation, pending: intent.generation });
    await this.persist(
      `completed/${intent.generation}`,
      { generation: intent.generation, baseline: privateDigest(baseline) },
      true,
    );
    await this.persist("current", { baseline: intent.generation, pending: null });
    // Reopen all links, not merely the last write, before downstream use is permitted.
    await this.inspect(state);
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
