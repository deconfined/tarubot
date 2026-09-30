/**
 * Offline SSH trust foundation. Adapters must supply owner-approved evidence and hold the shared
 * target writer group for the entire operation. Readback is persistence evidence, never CAS or
 * a distributed lock. This module contains no network, environment, host login or CLI adapter.
 */
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  privateDigest,
  RecordCodec,
  type ControlStore,
  type StateEvidence,
} from "./infra-control.js";

type ObjectValue = Record<string, unknown>;
export type TargetRole = "staging" | "production";
export const dnssecValidatorVersion = "1.26.1";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const evidenceAge = 60_000;
const approvalLifetime = 24 * 60 * 60_000;

/** Input, storage and dependency failures must never expose private names, keys or diagnostics. */
function requireTrust(value: unknown): asserts value {
  if (!value) throw new Error("invalid-ssh-trust");
}
function exact(value: unknown, keys: string[]): ObjectValue {
  requireTrust(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as ObjectValue;
  requireTrust(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function generation(value: unknown): asserts value is string {
  requireTrust(typeof value === "string" && uuid.test(value));
}
function fingerprint(value: unknown): asserts value is string {
  requireTrust(typeof value === "string" && sha256.test(value));
}
function timestamp(value: unknown): asserts value is number {
  requireTrust(Number.isSafeInteger(value) && typeof value === "number" && value >= 0);
}
function role(value: unknown): asserts value is TargetRole {
  requireTrust(value === "staging" || value === "production");
}
function dnsName(value: unknown): asserts value is string {
  requireTrust(
    typeof value === "string" &&
      value.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
        value,
      ) &&
      isIP(value) === 0,
  );
}
function recordId(value: unknown): asserts value is string {
  requireTrust(typeof value === "string" && /^[a-f0-9]{32}$/u.test(value));
}
function runIdentity(value: unknown): { commit: string; run: string } {
  const run = exact(value, ["commit", "run"]);
  requireTrust(typeof run.commit === "string" && /^[a-f0-9]{40}$/u.test(run.commit));
  requireTrust(typeof run.run === "string" && /^[1-9][0-9]{0,19}$/u.test(run.run));
  return structuredClone(run) as { commit: string; run: string };
}

export interface Sshfp {
  algorithm: 4;
  digest_type: 2;
  fingerprint: string;
}

function sshfpValue(value: unknown): Sshfp {
  const data = exact(value, ["algorithm", "digest_type", "fingerprint"]);
  requireTrust(data.algorithm === 4 && data.digest_type === 2);
  fingerprint(data.fingerprint);
  return structuredClone(data) as unknown as Sshfp;
}

/** RFC 8709's complete SSH public-key blob is hashed; hashing only the raw 32 bytes is wrong. */
export function canonicalEd25519(value: unknown): { key: string; blob: Uint8Array; sshfp: Sshfp } {
  requireTrust(typeof value === "string" && /^ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(value));
  const encoded = value.slice("ssh-ed25519 ".length);
  const blob = Buffer.from(encoded, "base64");
  requireTrust(
    blob.length === 51 &&
      blob.toString("base64") === encoded &&
      blob.readUInt32BE(0) === 11 &&
      blob.subarray(4, 15).equals(Buffer.from("ssh-ed25519")) &&
      blob.readUInt32BE(15) === 32,
  );
  return {
    key: value,
    blob: new Uint8Array(blob),
    sshfp: {
      algorithm: 4,
      digest_type: 2,
      fingerprint: createHash("sha256").update(blob).digest("hex"),
    },
  };
}

export interface TargetDescriptor {
  schema: 1;
  target: TargetRole;
  provider: "linode";
  instance_id: string;
  fqdn: string;
  addresses: { ipv4: string; ipv6: string };
  dns_zone_id: string;
  applied_generation: string;
  state: StateEvidence;
}

/** The future adapter must obtain this minimized descriptor from verified, successfully applied state. */
export function targetDescriptor(value: unknown): TargetDescriptor {
  const d = exact(value, [
    "schema",
    "target",
    "provider",
    "instance_id",
    "fqdn",
    "addresses",
    "dns_zone_id",
    "applied_generation",
    "state",
  ]);
  requireTrust(d.schema === 1 && d.provider === "linode");
  role(d.target);
  requireTrust(typeof d.instance_id === "string" && /^[1-9][0-9]{0,19}$/u.test(d.instance_id));
  dnsName(d.fqdn);
  recordId(d.dns_zone_id);
  generation(d.applied_generation);
  const addresses = exact(d.addresses, ["ipv4", "ipv6"]);
  requireTrust(typeof addresses.ipv4 === "string" && isIP(addresses.ipv4) === 4);
  requireTrust(typeof addresses.ipv6 === "string" && isIP(addresses.ipv6) === 6);
  try {
    requireTrust(new URL(`http://[${addresses.ipv6}]/`).hostname.slice(1, -1) === addresses.ipv6);
  } catch {
    throw new Error("invalid-ssh-trust");
  }
  const state = exact(d.state, ["lineage", "serial", "digest"]);
  generation(state.lineage);
  requireTrust(
    Number.isSafeInteger(state.serial) && typeof state.serial === "number" && state.serial >= 0,
  );
  fingerprint(state.digest);
  return structuredClone(d) as unknown as TargetDescriptor;
}

/** Ordinary safe infrastructure maintenance does not authorize a new key or require reenrollment. */
function instanceBinding(d: TargetDescriptor): string {
  const { applied_generation: _generation, state: _state, ...identity } = d;
  return privateDigest(identity);
}

export interface EnrollmentAuthorization {
  schema: 1;
  target: TargetRole;
  generation: string;
  previous: string | null;
  kind: "initial" | "rotation";
  descriptor_digest: string;
  run: { commit: string; run: string };
  approved_at: number;
  expires_at: number;
}

/** Shape validation is not owner approval; only a separately owner-fenced adapter may persist it. */
export function enrollmentAuthorization(value: unknown): EnrollmentAuthorization {
  const a = exact(value, [
    "schema",
    "target",
    "generation",
    "previous",
    "kind",
    "descriptor_digest",
    "run",
    "approved_at",
    "expires_at",
  ]);
  requireTrust(a.schema === 1);
  role(a.target);
  generation(a.generation);
  if (a.previous !== null) generation(a.previous);
  requireTrust(a.kind === "initial" || a.kind === "rotation");
  requireTrust((a.kind === "initial") === (a.previous === null));
  requireTrust(a.previous !== a.generation);
  fingerprint(a.descriptor_digest);
  runIdentity(a.run);
  timestamp(a.approved_at);
  timestamp(a.expires_at);
  requireTrust(a.expires_at > a.approved_at && a.expires_at - a.approved_at <= approvalLifetime);
  return structuredClone(a) as unknown as EnrollmentAuthorization;
}

export interface Observation {
  address: string;
  key: string | null;
}
export interface ScanEvidence {
  schema: 1;
  observed_at: number;
  rounds: [Observation[], Observation[]];
}

/** Both expected addresses are accounted for; a consistently unreachable family permits the other. */
function observedKey(value: unknown, descriptor: TargetDescriptor, now: number): string {
  const scan = exact(value, ["schema", "observed_at", "rounds"]);
  requireTrust(scan.schema === 1);
  timestamp(scan.observed_at);
  requireTrust(scan.observed_at <= now && now - scan.observed_at <= evidenceAge);
  requireTrust(Array.isArray(scan.rounds) && scan.rounds.length === 2);
  const expected = [descriptor.addresses.ipv4, descriptor.addresses.ipv6].sort();
  const observed: Map<string, string | null>[] = [];
  for (const round of scan.rounds) {
    requireTrust(Array.isArray(round) && round.length === 2);
    const keys = new Map<string, string | null>();
    for (const entry of round) {
      const observation = exact(entry, ["address", "key"]);
      requireTrust(
        typeof observation.address === "string" && expected.includes(observation.address),
      );
      requireTrust(!keys.has(observation.address));
      const key = observation.key === null ? null : canonicalEd25519(observation.key).key;
      keys.set(observation.address, key);
    }
    requireTrust(isDeepStrictEqual([...keys.keys()].sort(), expected));
    observed.push(keys);
  }
  const keys = new Set<string>();
  for (const address of expected) {
    const first = observed[0]?.get(address);
    requireTrust(first === observed[1]?.get(address));
    if (typeof first === "string") keys.add(first);
  }
  requireTrust(keys.size === 1);
  return [...keys][0] as string;
}

export interface ValidatorPin {
  name: "unbound";
  version: typeof dnssecValidatorVersion;
  mode: "local-validating";
  binary_sha256: string;
  anchor_sha256: string;
  runtime_manifest_sha256: string;
}

function validatorPin(value: unknown): ValidatorPin {
  const pin = exact(value, [
    "name",
    "version",
    "mode",
    "binary_sha256",
    "anchor_sha256",
    "runtime_manifest_sha256",
  ]);
  requireTrust(
    pin.name === "unbound" &&
      pin.version === dnssecValidatorVersion &&
      pin.mode === "local-validating",
  );
  fingerprint(pin.binary_sha256);
  fingerprint(pin.anchor_sha256);
  fingerprint(pin.runtime_manifest_sha256);
  return structuredClone(pin) as unknown as ValidatorPin;
}

export interface DnssecEvidence {
  schema: 1;
  validator: ValidatorPin;
  name: string;
  type: "SSHFP";
  secure: true;
  bogus: false;
  havedata: true;
  nxdomain: false;
  rcode: 0;
  observed_at: number;
  ttl: number;
  expires_at: number;
  records: { algorithm: number; digest_type: number; fingerprint: string }[];
}

/** Only the pinned local validator adapter can supply this result. An AD bit is never evidence. */
export function dnssecEvidence(
  value: unknown,
  name: string,
  sshfp: Sshfp,
  expectedPin: ValidatorPin,
  now: number,
): DnssecEvidence {
  dnsName(name);
  sshfpValue(sshfp);
  validatorPin(expectedPin);
  timestamp(now);
  const d = exact(value, [
    "schema",
    "validator",
    "name",
    "type",
    "secure",
    "bogus",
    "havedata",
    "nxdomain",
    "rcode",
    "observed_at",
    "ttl",
    "expires_at",
    "records",
  ]);
  requireTrust(isDeepStrictEqual(validatorPin(d.validator), expectedPin));
  requireTrust(d.schema === 1 && d.name === name && d.type === "SSHFP");
  requireTrust(
    d.secure === true &&
      d.bogus === false &&
      d.havedata === true &&
      d.nxdomain === false &&
      d.rcode === 0,
  );
  timestamp(d.observed_at);
  timestamp(d.expires_at);
  requireTrust(
    typeof d.ttl === "number" && Number.isSafeInteger(d.ttl) && d.ttl > 0 && d.ttl <= 86400,
  );
  requireTrust(d.expires_at === d.observed_at + d.ttl * 1000);
  requireTrust(d.observed_at <= now && now < d.expires_at && now - d.observed_at <= evidenceAge);
  requireTrust(Array.isArray(d.records) && d.records.length > 0 && d.records.length <= 32);
  const matching: ObjectValue[] = [];
  for (const entry of d.records) {
    const rr = exact(entry, ["algorithm", "digest_type", "fingerprint"]);
    for (const code of [rr.algorithm, rr.digest_type])
      requireTrust(
        typeof code === "number" && Number.isSafeInteger(code) && code > 0 && code <= 255,
      );
    requireTrust(
      typeof rr.fingerprint === "string" && /^(?:[a-f0-9]{2}){1,64}$/u.test(rr.fingerprint),
    );
    if (rr.algorithm === 4 && rr.digest_type === 2) matching.push(rr);
  }
  requireTrust(matching.length === 1 && isDeepStrictEqual(matching[0], sshfp));
  return structuredClone(d) as unknown as DnssecEvidence;
}

export interface SshfpRecord {
  id: string;
  zone_id: string;
  name: string;
  type: "SSHFP";
  sshfp: Sshfp;
}
function sshfpRecord(value: unknown): SshfpRecord {
  const rr = exact(value, ["id", "zone_id", "name", "type", "sshfp"]);
  recordId(rr.id);
  recordId(rr.zone_id);
  dnsName(rr.name);
  requireTrust(rr.type === "SSHFP");
  sshfpValue(rr.sshfp);
  return structuredClone(rr) as unknown as SshfpRecord;
}

export interface PublicationRequest {
  target: TargetRole;
  generation: string;
  zone_id: string;
  name: string;
  type: "SSHFP";
  record_id: string | null;
  previous: SshfpRecord | null;
  sshfp: Sshfp;
}
export interface DnsWriter {
  /** List every 4/2 record at this exact zone/name; never hide conflicts by filtering by owned ID. */
  read(request: PublicationRequest): Promise<SshfpRecord[]>;
  /** Create only when previous is null; otherwise patch only record_id, after predecessor readback. */
  write(request: PublicationRequest): Promise<SshfpRecord>;
}
export interface TrustTicket {
  operation: string;
  generation: string;
  binding: string;
}
export interface TrustSnapshot {
  generation: string;
  enrollment_run: { commit: string; run: string };
  descriptor: TargetDescriptor;
  key: string;
  sshfp: Sshfp;
  record: SshfpRecord;
}
interface Head {
  schema: 1;
  target: TargetRole;
  generation: string | null;
  pending: string | null;
}
interface Registration {
  schema: 1;
  target: TargetRole;
  generation: string;
  authorization_digest: string;
}
interface Intent {
  schema: 1;
  target: TargetRole;
  operation: string;
  authorization: EnrollmentAuthorization;
  descriptor: TargetDescriptor;
  enrollment_run: { commit: string; run: string };
  previous: { generation: string; trust_digest: string } | null;
  started_at: number;
}
interface TrustRecord {
  schema: 1;
  target: TargetRole;
  generation: string;
  operation: string;
  binding: string;
  enrollment_run: { commit: string; run: string };
  descriptor: TargetDescriptor;
  key: string;
  sshfp: Sshfp;
  observations: ScanEvidence;
}
interface Publication {
  schema: 1;
  target: TargetRole;
  operation: string;
  request: PublicationRequest;
  record: SshfpRecord;
  dns: DnssecEvidence;
  verified_at: number;
}
interface CompletedTrust {
  record: TrustRecord;
  publication: Publication;
  intent: Intent;
}

/**
 * One serialized writer owns a target. A dedicated per-target passphrase is required: callers
 * must not pass the infrastructure state passphrase or let target readers load state credentials.
 * Purpose/role/backend separation below additionally prevents cross-target ciphertext replay.
 */
export class TrustJournal {
  // Runtime privacy keeps journal keys, target bindings and validators out of diagnostics.
  readonly #codec: RecordCodec;
  readonly #target: TargetRole;
  readonly #pin: ValidatorPin;
  readonly #now: () => number;
  readonly #store: ControlStore;
  constructor(
    store: ControlStore,
    options: {
      target: TargetRole;
      backend: string;
      passphrase: string;
      validator: ValidatorPin;
      now?: () => number;
    },
  ) {
    try {
      this.#store = store;
      const { now, ...configuration } = options;
      const config = structuredClone(configuration);
      role(config.target);
      fingerprint(config.backend);
      requireTrust(typeof config.passphrase === "string" && config.passphrase.length >= 32);
      this.#target = config.target;
      this.#pin = validatorPin(config.validator);
      this.#now = now ?? Date.now;
      this.#codec = new RecordCodec(
        config.passphrase,
        privateDigest({
          purpose: "tarubot-ssh-trust-v1",
          target: config.target,
          backend: config.backend,
        }),
      );
    } catch {
      throw new Error("invalid-ssh-trust");
    }
  }
  #time(): number {
    try {
      const now = this.#now();
      timestamp(now);
      return now;
    } catch {
      throw new Error("invalid-ssh-trust");
    }
  }
  /** Approval stays live at mutation/return boundaries after asynchronous evidence reads. */
  #authorizedNow(a: EnrollmentAuthorization): number {
    const now = this.#time();
    requireTrust(a.target === this.#target && a.approved_at <= now && now < a.expires_at);
    return now;
  }
  #path(path: string): string {
    return `trust/${this.#target}/${path}`;
  }
  async #read(path: string): Promise<unknown | null> {
    try {
      const bytes = await this.#store.read(this.#path(path));
      return bytes === null ? null : this.#codec.open(this.#path(path), bytes);
    } catch {
      throw new Error("invalid-ssh-trust");
    }
  }
  async #persist(
    path: string,
    value: unknown,
    historical = false,
    requireFresh?: () => void,
  ): Promise<void> {
    try {
      const key = this.#path(path);
      // This check is a convention under the repository writer group, not conditional storage.
      if (historical) requireTrust((await this.#store.read(key)) === null);
      const bytes = this.#codec.seal(key, value);
      // A historical existence read and write acknowledgement may cross a freshness deadline.
      requireFresh?.();
      await this.#store.write(key, bytes);
      const readback = await this.#store.read(key);
      requireTrust(readback !== null && Buffer.from(bytes).equals(Buffer.from(readback)));
      requireFresh?.();
    } catch {
      throw new Error("invalid-ssh-trust");
    }
  }
  async #head(): Promise<Head | null> {
    const value = await this.#read("current");
    if (value === null) return null;
    const h = exact(value, ["schema", "target", "generation", "pending"]);
    requireTrust(h.schema === 1 && h.target === this.#target);
    if (h.generation !== null) generation(h.generation);
    if (h.pending !== null) generation(h.pending);
    requireTrust(h.generation !== null || h.pending !== null);
    return h as unknown as Head;
  }
  async #authorization(id: string): Promise<EnrollmentAuthorization> {
    generation(id);
    const a = enrollmentAuthorization(await this.#read(`authorizations/${id}`));
    requireTrust(a.target === this.#target && a.generation === id);
    return a;
  }
  async #latestAuthorization(): Promise<EnrollmentAuthorization> {
    const pointer = exact(await this.#read("authorization-current"), [
      "schema",
      "target",
      "generation",
      "previous",
      "authorization_digest",
    ]);
    requireTrust(pointer.schema === 1 && pointer.target === this.#target);
    generation(pointer.generation);
    const a = await this.#authorization(pointer.generation);
    requireTrust(
      pointer.previous === a.previous && pointer.authorization_digest === privateDigest(a),
    );
    return a;
  }
  async #registration(): Promise<Registration> {
    const r = exact(await this.#read("registration"), [
      "schema",
      "target",
      "generation",
      "authorization_digest",
    ]);
    requireTrust(r.schema === 1 && r.target === this.#target);
    generation(r.generation);
    const a = await this.#authorization(r.generation);
    requireTrust(
      a.kind === "initial" && a.previous === null && r.authorization_digest === privateDigest(a),
    );
    return r as unknown as Registration;
  }
  #intent(value: unknown): Intent {
    const i = exact(value, [
      "schema",
      "target",
      "operation",
      "authorization",
      "descriptor",
      "enrollment_run",
      "previous",
      "started_at",
    ]);
    requireTrust(i.schema === 1 && i.target === this.#target);
    generation(i.operation);
    const a = enrollmentAuthorization(i.authorization);
    const d = targetDescriptor(i.descriptor);
    runIdentity(i.enrollment_run);
    requireTrust(
      a.target === this.#target &&
        d.target === this.#target &&
        a.descriptor_digest === privateDigest(d),
    );
    timestamp(i.started_at);
    requireTrust(a.approved_at <= i.started_at && i.started_at < a.expires_at);
    if (i.previous !== null) {
      const previous = exact(i.previous, ["generation", "trust_digest"]);
      generation(previous.generation);
      fingerprint(previous.trust_digest);
      requireTrust(previous.generation === a.previous);
    } else requireTrust(a.previous === null);
    return i as unknown as Intent;
  }
  async #requireIntent(i: Intent): Promise<string> {
    requireTrust(
      isDeepStrictEqual(await this.#authorization(i.authorization.generation), i.authorization),
    );
    const binding = privateDigest(i);
    requireTrust(
      isDeepStrictEqual(await this.#read(`attempts/${i.authorization.generation}`), {
        schema: 1,
        target: this.#target,
        generation: i.authorization.generation,
        operation: i.operation,
        binding,
      }),
    );
    requireTrust(
      isDeepStrictEqual(await this.#read(`consumed/${i.authorization.generation}`), {
        schema: 1,
        target: this.#target,
        generation: i.authorization.generation,
        operation: i.operation,
        binding,
      }),
    );
    return binding;
  }
  #trustRecord(value: unknown, i: Intent, binding: string): TrustRecord {
    const t = exact(value, [
      "schema",
      "target",
      "generation",
      "operation",
      "binding",
      "enrollment_run",
      "descriptor",
      "key",
      "sshfp",
      "observations",
    ]);
    requireTrust(
      t.schema === 1 &&
        t.target === this.#target &&
        t.generation === i.authorization.generation &&
        t.operation === i.operation &&
        t.binding === binding,
    );
    requireTrust(isDeepStrictEqual(runIdentity(t.enrollment_run), i.enrollment_run));
    requireTrust(isDeepStrictEqual(targetDescriptor(t.descriptor), i.descriptor));
    const scan = exact(t.observations, ["schema", "observed_at", "rounds"]);
    timestamp(scan.observed_at);
    requireTrust(scan.observed_at >= i.started_at);
    const key = canonicalEd25519(t.key);
    requireTrust(
      observedKey(scan, i.descriptor, scan.observed_at) === key.key &&
        isDeepStrictEqual(t.sshfp, key.sshfp),
    );
    return t as unknown as TrustRecord;
  }
  async #storedTrust(id: string): Promise<{ record: TrustRecord; intent: Intent }> {
    generation(id);
    const ref = exact(await this.#read(`references/${id}`), [
      "schema",
      "target",
      "generation",
      "operation",
      "trust_digest",
    ]);
    requireTrust(ref.schema === 1 && ref.target === this.#target && ref.generation === id);
    generation(ref.operation);
    const i = this.#intent(await this.#read(`intents/${ref.operation}`));
    requireTrust(i.operation === ref.operation && i.authorization.generation === id);
    const binding = await this.#requireIntent(i);
    const record = this.#trustRecord(await this.#read(`records/${id}`), i, binding);
    requireTrust(ref.trust_digest === privateDigest(record));
    return { record, intent: i };
  }
  #request(record: TrustRecord, previous: SshfpRecord | null): PublicationRequest {
    return {
      target: this.#target,
      generation: record.generation,
      zone_id: record.descriptor.dns_zone_id,
      name: record.descriptor.fqdn,
      type: "SSHFP",
      record_id: previous?.id ?? null,
      previous,
      sshfp: record.sshfp,
    };
  }
  #publication(value: unknown, record: TrustRecord, previous: SshfpRecord | null): Publication {
    const p = exact(value, [
      "schema",
      "target",
      "operation",
      "request",
      "record",
      "dns",
      "verified_at",
    ]);
    requireTrust(p.schema === 1 && p.target === this.#target && p.operation === record.operation);
    requireTrust(isDeepStrictEqual(p.request, this.#request(record, previous)));
    const rr = sshfpRecord(p.record);
    requireTrust(
      rr.zone_id === record.descriptor.dns_zone_id &&
        rr.name === record.descriptor.fqdn &&
        isDeepStrictEqual(rr.sshfp, record.sshfp),
    );
    if (previous) requireTrust(rr.id === previous.id);
    timestamp(p.verified_at);
    requireTrust(p.verified_at >= record.observations.observed_at);
    dnssecEvidence(p.dns, rr.name, rr.sshfp, this.#pin, p.verified_at);
    return p as unknown as Publication;
  }
  async #completed(id: string, depth = 0): Promise<CompletedTrust> {
    // Bound corrupt/cyclic ancestry instead of recursively trusting a newest-generation pointer.
    requireTrust(depth < 64);
    const { record, intent } = await this.#storedTrust(id);
    let previous: CompletedTrust | null = null;
    if (intent.previous !== null) {
      previous = await this.#completed(intent.previous.generation, depth + 1);
      requireTrust(intent.previous.trust_digest === privateDigest(previous.record));
      requireTrust(
        previous.record.descriptor.fqdn === record.descriptor.fqdn &&
          previous.record.descriptor.dns_zone_id === record.descriptor.dns_zone_id,
      );
    } else requireTrust((await this.#registration()).generation === id);
    const publication = this.#publication(
      await this.#read(`publications/${record.operation}`),
      record,
      previous?.publication.record ?? null,
    );
    requireTrust(
      isDeepStrictEqual(
        await this.#read(`publication-intents/${record.operation}`),
        publication.request,
      ),
    );
    const done = exact(await this.#read(`completed/${id}`), [
      "schema",
      "target",
      "generation",
      "operation",
      "binding",
      "trust_digest",
      "publication_digest",
      "finished_at",
    ]);
    requireTrust(
      done.schema === 1 &&
        done.target === this.#target &&
        done.generation === id &&
        done.operation === record.operation &&
        done.binding === record.binding &&
        done.trust_digest === privateDigest(record) &&
        done.publication_digest === privateDigest(publication),
    );
    timestamp(done.finished_at);
    requireTrust(done.finished_at >= publication.verified_at);
    dnssecEvidence(
      publication.dns,
      record.descriptor.fqdn,
      record.sshfp,
      this.#pin,
      done.finished_at,
    );
    return { record, publication, intent };
  }
  async #current(): Promise<CompletedTrust> {
    const registration = await this.#registration();
    const head = await this.#head();
    requireTrust(head !== null && head.pending === null && head.generation !== null);
    const a = await this.#latestAuthorization();
    const consumed = await this.#read(`consumed/${a.generation}`);
    const attempt = await this.#read(`attempts/${a.generation}`);
    // Consumption before pending publication is also an interrupted operation, never an empty role.
    requireTrust(
      consumed === null
        ? attempt === null && a.previous === head.generation
        : a.generation === head.generation,
    );
    const current = await this.#completed(head.generation);
    requireTrust(registration.target === current.record.target);
    return current;
  }
  /** Owner-fenced setup only. This API cannot establish approval from a flag, a missing record or a caller claim. */
  async recordAuthorization(value: unknown): Promise<void> {
    const a = enrollmentAuthorization(value);
    const now = this.#time();
    requireTrust(a.target === this.#target && a.approved_at <= now && now < a.expires_at);
    if (a.kind === "initial") {
      requireTrust(
        (await this.#head()) === null &&
          (await this.#read("registration")) === null &&
          (await this.#read("authorization-current")) === null,
      );
      requireTrust((await this.#read(`consumed/${a.generation}`)) === null);
    } else {
      const current = await this.#current();
      requireTrust(current.record.generation === a.previous);
    }
    await this.#persist(`authorizations/${a.generation}`, a, true);
    if (a.kind === "initial")
      await this.#persist(
        "registration",
        {
          schema: 1,
          target: this.#target,
          generation: a.generation,
          authorization_digest: privateDigest(a),
        },
        true,
      );
    await this.#persist("authorization-current", {
      schema: 1,
      target: this.#target,
      generation: a.generation,
      previous: a.previous,
      authorization_digest: privateDigest(a),
    });
    requireTrust(isDeepStrictEqual(await this.#latestAuthorization(), a));
    await this.#registration();
  }
  /** An absent current record is always a refusal here, including before authorized initial enrollment. */
  async inspect(value: unknown): Promise<TrustSnapshot> {
    const d = targetDescriptor(value);
    requireTrust(d.target === this.#target);
    const { record, publication } = await this.#current();
    requireTrust(instanceBinding(record.descriptor) === instanceBinding(d));
    return structuredClone({
      generation: record.generation,
      enrollment_run: record.enrollment_run,
      descriptor: record.descriptor,
      key: record.key,
      sshfp: record.sshfp,
      record: publication.record,
    });
  }
  /** Guard and consume authorization before scanning, so interrupted operations can never observe again. */
  async begin(
    authorization: unknown,
    descriptor: unknown,
    enrollmentRun: unknown,
    observe: () => Promise<ScanEvidence>,
  ): Promise<TrustTicket> {
    const a = enrollmentAuthorization(authorization);
    const d = targetDescriptor(descriptor);
    const enrollment_run = structuredClone(runIdentity(enrollmentRun));
    const now = this.#time();
    requireTrust(
      a.target === this.#target &&
        d.target === this.#target &&
        a.descriptor_digest === privateDigest(d) &&
        a.approved_at <= now &&
        now < a.expires_at,
    );
    requireTrust(isDeepStrictEqual(await this.#latestAuthorization(), a));
    const registration = await this.#registration();
    requireTrust((await this.#read(`attempts/${a.generation}`)) === null);
    requireTrust((await this.#read(`consumed/${a.generation}`)) === null);
    let previous: Intent["previous"] = null;
    if (a.kind === "initial")
      requireTrust(registration.generation === a.generation && (await this.#head()) === null);
    else {
      const current = await this.#current();
      requireTrust(
        current.record.generation === a.previous &&
          current.record.descriptor.fqdn === d.fqdn &&
          current.record.descriptor.dns_zone_id === d.dns_zone_id,
      );
      previous = {
        generation: current.record.generation,
        trust_digest: privateDigest(current.record),
      };
    }
    const intent: Intent = {
      schema: 1,
      target: this.#target,
      operation: randomUUID(),
      authorization: a,
      descriptor: d,
      enrollment_run,
      previous,
      started_at: now,
    };
    const binding = privateDigest(intent);
    // Reserve the permanent link first: even a failed intent acknowledgement leaves indexed work.
    // It also prevents recreating an observed attempt if its consumed/head link is later lost.
    await this.#persist(
      `attempts/${a.generation}`,
      {
        schema: 1,
        target: this.#target,
        generation: a.generation,
        operation: intent.operation,
        binding,
      },
      true,
    );
    await this.#persist(`intents/${intent.operation}`, intent, true);
    await this.#persist(
      `consumed/${a.generation}`,
      {
        schema: 1,
        target: this.#target,
        generation: a.generation,
        operation: intent.operation,
        binding,
      },
      true,
    );
    await this.#persist("current", {
      schema: 1,
      target: this.#target,
      generation: a.previous,
      pending: intent.operation,
    });
    let observations: ScanEvidence;
    try {
      // Durable consumption may outlast the grant; it cannot authorize a late first scan.
      this.#authorizedNow(a);
      observations = structuredClone(await observe());
      this.#authorizedNow(a);
    } catch {
      throw new Error("invalid-ssh-trust");
    }
    const key = canonicalEd25519(observedKey(observations, d, this.#time()));
    await this.#requireIntent(intent);
    requireTrust(
      isDeepStrictEqual(await this.#head(), {
        schema: 1,
        target: this.#target,
        generation: a.previous,
        pending: intent.operation,
      }),
    );
    const record: TrustRecord = {
      schema: 1,
      target: this.#target,
      generation: a.generation,
      operation: intent.operation,
      binding,
      enrollment_run,
      descriptor: d,
      key: key.key,
      sshfp: key.sshfp,
      observations,
    };
    this.#trustRecord(record, intent, binding);
    await this.#persist(`records/${a.generation}`, record, true);
    await this.#persist(
      `references/${a.generation}`,
      {
        schema: 1,
        target: this.#target,
        generation: a.generation,
        operation: intent.operation,
        trust_digest: privateDigest(record),
      },
      true,
    );
    await this.#persist("current", {
      schema: 1,
      target: this.#target,
      generation: a.generation,
      pending: intent.operation,
    });
    const ticket = { operation: intent.operation, generation: a.generation, binding };
    await this.#active(ticket);
    return ticket;
  }
  async #active(
    value: unknown,
  ): Promise<{ record: TrustRecord; intent: Intent; previous: SshfpRecord | null }> {
    const ticket = exact(value, ["operation", "generation", "binding"]);
    generation(ticket.operation);
    generation(ticket.generation);
    fingerprint(ticket.binding);
    const registration = await this.#registration();
    const a = await this.#latestAuthorization();
    requireTrust(a.generation === ticket.generation);
    this.#authorizedNow(a);
    requireTrust(
      isDeepStrictEqual(await this.#head(), {
        schema: 1,
        target: this.#target,
        generation: ticket.generation,
        pending: ticket.operation,
      }),
    );
    const { record, intent } = await this.#storedTrust(ticket.generation);
    if (intent.previous === null) requireTrust(registration.generation === record.generation);
    requireTrust(record.operation === ticket.operation && record.binding === ticket.binding);
    const previous =
      intent.previous === null ? null : await this.#completed(intent.previous.generation);
    if (previous) requireTrust(intent.previous?.trust_digest === privateDigest(previous.record));
    this.#authorizedNow(a);
    return { record, intent, previous: previous?.publication.record ?? null };
  }
  /** Persist exact DNS intent before the sole owned-record writer; interrupted publication never retries. */
  async publish(
    ticket: TrustTicket,
    writer: DnsWriter,
    validate: (request: PublicationRequest) => Promise<DnssecEvidence>,
  ): Promise<void> {
    const { record, intent, previous } = await this.#active(ticket);
    const request = this.#request(record, previous);
    requireTrust((await this.#read(`publication-intents/${ticket.operation}`)) === null);
    let before: SshfpRecord[];
    try {
      before = structuredClone(await writer.read(structuredClone(request)));
    } catch {
      throw new Error("invalid-ssh-trust");
    }
    requireTrust(Array.isArray(before));
    requireTrust(isDeepStrictEqual(before.map(sshfpRecord), previous === null ? [] : [previous]));
    await this.#persist(`publication-intents/${ticket.operation}`, request, true, () => {
      this.#authorizedNow(intent.authorization);
    });
    await this.#active(ticket);
    let returned: SshfpRecord;
    let readback: SshfpRecord[];
    let dns: DnssecEvidence;
    try {
      this.#authorizedNow(intent.authorization);
      returned = sshfpRecord(await writer.write(structuredClone(request)));
      readback = structuredClone(await writer.read(structuredClone(request)));
      dns = structuredClone(await validate(structuredClone(request)));
    } catch {
      throw new Error("invalid-ssh-trust");
    }
    requireTrust(
      Array.isArray(readback) && isDeepStrictEqual(readback.map(sshfpRecord), [returned]),
    );
    const publication = this.#publication(
      {
        schema: 1,
        target: this.#target,
        operation: ticket.operation,
        request,
        record: returned,
        dns,
        verified_at: this.#time(),
      },
      record,
      previous,
    );
    await this.#active(ticket);
    await this.#persist(`publications/${ticket.operation}`, publication, true, () => {
      const now = this.#authorizedNow(intent.authorization);
      dnssecEvidence(publication.dns, record.descriptor.fqdn, record.sshfp, this.#pin, now);
    });
  }
  /**
   * Completion returns only after exact readback. A last pointer write may persist while its
   * acknowledgement fails: latest-object storage cannot recognize that interruption later.
   * Connections therefore also require independent successful evidence for enrollment_run.
   */
  async finish(ticket: TrustTicket): Promise<void> {
    const { record, intent, previous } = await this.#active(ticket);
    const publication = this.#publication(
      await this.#read(`publications/${ticket.operation}`),
      record,
      previous,
    );
    requireTrust(
      isDeepStrictEqual(
        await this.#read(`publication-intents/${ticket.operation}`),
        publication.request,
      ),
    );
    const requireFresh = (): number => {
      const now = this.#authorizedNow(intent.authorization);
      dnssecEvidence(publication.dns, record.descriptor.fqdn, record.sshfp, this.#pin, now);
      return now;
    };
    const now = requireFresh();
    await this.#persist(
      `completed/${record.generation}`,
      {
        schema: 1,
        target: this.#target,
        generation: record.generation,
        operation: record.operation,
        binding: record.binding,
        trust_digest: privateDigest(record),
        publication_digest: privateDigest(publication),
        finished_at: now,
      },
      true,
      requireFresh,
    );
    await this.#persist(
      "current",
      {
        schema: 1,
        target: this.#target,
        generation: record.generation,
        pending: null,
      },
      false,
      requireFresh,
    );
    await this.inspect(record.descriptor);
    // An expired final acknowledgement/reopen fails the enrollment run even if its pointer
    // persisted; independent workflow success remains mandatory for subsequent connections.
    requireFresh();
  }
  /**
   * Reopen every durable link, independently confirm the enrollment workflow's final success,
   * then obtain fresh pinned local DNSSEC validation. The injected confirmation is an owner-
   * fenced integration boundary, never a self-authorizing command-line Boolean or remote AD flag.
   * That adapter must bind the exact repository/workflow, target, commit and run, first attempt,
   * owner enrollment gate and final successful conclusion before returning true.
   */
  async connectionTrust(
    descriptor: unknown,
    confirmRun: (run: { commit: string; run: string }) => Promise<boolean>,
    validate: (snapshot: TrustSnapshot) => Promise<DnssecEvidence>,
  ): Promise<TrustSnapshot & { expires_at: number }> {
    const snapshot = await this.inspect(descriptor);
    let value: DnssecEvidence;
    try {
      requireTrust((await confirmRun(structuredClone(snapshot.enrollment_run))) === true);
      value = structuredClone(await validate(structuredClone(snapshot)));
    } catch {
      throw new Error("invalid-ssh-trust");
    }
    const dns = dnssecEvidence(
      value,
      snapshot.descriptor.fqdn,
      snapshot.sshfp,
      this.#pin,
      this.#time(),
    );
    requireTrust(isDeepStrictEqual(await this.inspect(descriptor), snapshot));
    // Reopening the durable chain can outlast a short DNS TTL; return only still-live evidence.
    dnssecEvidence(dns, snapshot.descriptor.fqdn, snapshot.sshfp, this.#pin, this.#time());
    return { ...snapshot, expires_at: dns.expires_at };
  }
}
