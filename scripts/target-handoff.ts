/**
 * Private applied-target transport, with no backend, environment, GitHub or workflow adapter.
 * A dedicated per-target descriptor passphrase is required; never supply a state/trust key.
 * Successful sealing only proves persistence. Consumption independently proves the exact
 * infrastructure sealing JOB succeeded: publication's overall run may still await staging.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonical, privateDigest, RecordCodec, type ControlStore } from "./infra-control.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import type { TargetRole } from "./ssh-trust.js";
import {
  appliedTargetEnvelope,
  type AppliedTargetEnvelope,
  type AppliedTargetProducer,
} from "./target-descriptor.js";

type Value = Record<string, unknown>;
const purpose = "tarubot-applied-target-handoff-v1";
const workflow = "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main";
const maxPayload = 65_536;
const maxLifetime = 3_600_000;
const maxOperation = 60_000;
const maxProofAge = 30_000;
const sha = /^[a-f0-9]{64}$/u;

function requireHandoff(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-handoff");
}
function exact(value: unknown, keys: string[]): Value {
  requireHandoff(value !== null && typeof value === "object" && !Array.isArray(value));
  const object = value as Value;
  requireHandoff(isDeepStrictEqual(Object.keys(object).sort(), [...keys].sort()));
  return object;
}
function integer(value: unknown): asserts value is number {
  requireHandoff(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function digest(value: unknown): asserts value is string {
  requireHandoff(typeof value === "string" && sha.test(value));
}
function target(value: unknown): asserts value is TargetRole {
  requireHandoff(value === "staging" || value === "production");
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot only bounded JSON data, without invoking caller getters or retaining shared memory. */
function snapshot(value: unknown): unknown {
  let size = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    requireHandoff(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      size += Buffer.byteLength(input);
      requireHandoff(size <= maxPayload);
      return input;
    }
    if (typeof input === "number") {
      requireHandoff(Number.isFinite(input));
      return input;
    }
    requireHandoff(typeof input === "object" && input !== null);
    requireHandoff(!ancestors.has(input));
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const symbols = Object.getOwnPropertySymbols(input);
    requireHandoff(symbols.length === 0);
    let result: unknown;
    if (Array.isArray(input)) {
      requireHandoff(input.length <= 1024);
      requireHandoff(Object.keys(descriptors).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const property = descriptors[String(index)];
        requireHandoff(property?.enumerable === true && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    } else {
      requireHandoff(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const output: Value = {};
      for (const [key, property] of Object.entries(descriptors)) {
        requireHandoff(property.enumerable === true && Object.hasOwn(property, "value"));
        size += Buffer.byteLength(key);
        requireHandoff(size <= maxPayload);
        Object.defineProperty(output, key, {
          value: copy(property.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      result = output;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}

export interface AppliedTargetContext {
  target: TargetRole;
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
}
function context(value: unknown, expectedTarget: TargetRole): AppliedTargetContext {
  const c = exact(value, ["target", "release", "producer"]);
  target(c.target);
  requireHandoff(c.target === expectedTarget);
  const release = releaseIdentity(c.release);
  const producer = exact(c.producer, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  requireHandoff(
    producer.repository === "deconfined/tarubot" &&
      producer.workflow_ref ===
        "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" &&
      producer.ref === "refs/heads/main" &&
      producer.event === "push" &&
      producer.attempt === 1 &&
      producer.commit === release.commit &&
      producer.run === release.publication_run &&
      /^[1-9][0-9]{0,19}$/u.test(String(producer.run)),
  );
  return { target: c.target, release, producer: producer as unknown as AppliedTargetProducer };
}

/** This receipt stays inside the private handoff, never in a public artifact or workflow output. */
export interface AppliedTargetReceipt {
  schema: 1;
  purpose: "tarubot-applied-target-handoff-v1";
  target: TargetRole;
  backend: string;
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
  mode: "apply" | "no-changes";
  path: string;
  payload_digest: string;
  ciphertext_digest: string;
  issued_at: number;
  expires_at: number;
}
function path(c: AppliedTargetContext, payloadDigest: string): string {
  return `applied-target/${c.target}/${c.producer.run}/${c.producer.commit}/${payloadDigest}`;
}
function receipt(value: unknown, c: AppliedTargetContext, backend: string): AppliedTargetReceipt {
  const r = exact(value, [
    "schema",
    "purpose",
    "target",
    "backend",
    "release",
    "producer",
    "mode",
    "path",
    "payload_digest",
    "ciphertext_digest",
    "issued_at",
    "expires_at",
  ]);
  requireHandoff(r.schema === 1 && r.purpose === purpose && r.backend === backend);
  requireHandoff(
    isDeepStrictEqual(
      context({ target: r.target, release: r.release, producer: r.producer }, c.target),
      c,
    ),
  );
  requireHandoff(r.mode === "apply" || r.mode === "no-changes");
  digest(r.payload_digest);
  digest(r.ciphertext_digest);
  requireHandoff(r.path === path(c, r.payload_digest));
  integer(r.issued_at);
  integer(r.expires_at);
  requireHandoff(r.expires_at > r.issued_at && r.expires_at - r.issued_at <= maxLifetime);
  return r as unknown as AppliedTargetReceipt;
}

/** Proposed pins, not existing workflow integration or authority to create/operate a job. */
export interface AppliedTargetJobPin {
  workflow_ref: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main";
  workflow_commit: string;
  job_name: "Plan infrastructure" | "Apply infrastructure";
  critical_step: "Seal applied target descriptor";
}
export interface AppliedTargetJobRequest {
  receipt: AppliedTargetReceipt;
  job: AppliedTargetJobPin;
  requested_at: number;
}
export interface AppliedTargetJobProof {
  schema: 1;
  purpose: "tarubot-applied-target-job-proof-v1";
  receipt: AppliedTargetReceipt;
  producer: AppliedTargetProducer;
  head_commit: string;
  workflow_ref: AppliedTargetJobPin["workflow_ref"];
  workflow_commit: string;
  job_name: AppliedTargetJobPin["job_name"];
  job_id: number;
  status: "completed";
  conclusion: "success";
  critical_step: {
    name: "Seal applied target descriptor";
    number: number;
    status: "completed";
    conclusion: "success";
  };
  observed_at: number;
  expires_at: number;
}
/**
 * Mandatory independent boundary: obtain the exact producer JOB's final outcome and current
 * head/release, and authenticate its private sealing receipt. A generic successful run/job,
 * caller echo, CLI Boolean or GitHub GET alone cannot attest these private payload hashes.
 * No proof of overall publication-run final success is required or accepted as a substitute.
 */
export type VerifyAppliedTargetJob = (
  request: AppliedTargetJobRequest,
) => Promise<AppliedTargetJobProof>;

function jobProof(
  value: unknown,
  request: AppliedTargetJobRequest,
  now: number,
): AppliedTargetJobProof {
  const p = exact(value, [
    "schema",
    "purpose",
    "receipt",
    "producer",
    "head_commit",
    "workflow_ref",
    "workflow_commit",
    "job_name",
    "job_id",
    "status",
    "conclusion",
    "critical_step",
    "observed_at",
    "expires_at",
  ]);
  requireHandoff(
    p.schema === 1 &&
      p.purpose === "tarubot-applied-target-job-proof-v1" &&
      isDeepStrictEqual(p.receipt, request.receipt) &&
      isDeepStrictEqual(p.producer, request.receipt.producer) &&
      p.head_commit === request.receipt.release.commit &&
      p.workflow_ref === request.job.workflow_ref &&
      p.workflow_commit === request.job.workflow_commit &&
      p.job_name === request.job.job_name &&
      p.status === "completed" &&
      p.conclusion === "success",
  );
  integer(p.job_id);
  const step = exact(p.critical_step, ["name", "number", "status", "conclusion"]);
  requireHandoff(
    step.name === request.job.critical_step &&
      step.status === "completed" &&
      step.conclusion === "success",
  );
  integer(step.number);
  integer(p.observed_at);
  integer(p.expires_at);
  requireHandoff(
    p.observed_at >= request.requested_at &&
      p.observed_at <= now &&
      now - p.observed_at <= maxProofAge &&
      p.expires_at > now &&
      p.expires_at <= p.observed_at + maxProofAge,
  );
  return p as unknown as AppliedTargetJobProof;
}

export interface AppliedTargetHandoffConfig {
  target: TargetRole;
  backend: string;
  descriptor_passphrase: string;
}
export interface AuthenticatedAppliedTarget {
  envelope: AppliedTargetEnvelope;
  receipt: AppliedTargetReceipt;
  proof: AppliedTargetJobProof;
}

/**
 * The enclosing producer must already hold its serialized infrastructure writer boundary.
 * No compare-and-swap/lock/version guarantees are inferred from absence checks or readbacks.
 * Failed/uncertain writes stop; this API offers no overwrite, resume, retry or latest-pointer.
 */
export class AppliedTargetHandoff {
  readonly target: TargetRole;
  readonly backend: string;
  readonly binding: string;
  readonly #codec: RecordCodec;
  readonly #read: ControlStore["read"];
  readonly #write: ControlStore["write"];
  readonly #verify: VerifyAppliedTargetJob;
  readonly #now: () => number;

  constructor(
    configuration: AppliedTargetHandoffConfig,
    dependencies: {
      store: ControlStore;
      verifyProducerJob: VerifyAppliedTargetJob;
      now?: () => number;
    },
  ) {
    try {
      // Capture capability functions once; constructor getters cannot substitute a different
      // verifier after its type was checked. The transport remains a trusted injected boundary.
      const store = dependencies.store;
      const read = store?.read;
      const write = store?.write;
      const verify = dependencies.verifyProducerJob;
      const now = dependencies.now;
      const config = exact(snapshot(configuration), ["target", "backend", "descriptor_passphrase"]);
      target(config.target);
      digest(config.backend);
      requireHandoff(
        typeof config.descriptor_passphrase === "string" &&
          config.descriptor_passphrase.length >= 32 &&
          config.descriptor_passphrase.length <= 4096,
      );
      requireHandoff(
        typeof read === "function" && typeof write === "function" && typeof verify === "function",
      );
      requireHandoff(now === undefined || typeof now === "function");
      this.target = config.target;
      this.backend = config.backend;
      this.binding = privateDigest({ purpose, target: this.target, backend: this.backend });
      this.#codec = new RecordCodec(config.descriptor_passphrase, this.binding);
      this.#read = read.bind(store);
      this.#write = write.bind(store);
      this.#verify = verify;
      this.#now = now ?? Date.now;
      Object.freeze(this);
    } catch {
      throw new Error("invalid-target-handoff");
    }
  }

  #clock(): () => number {
    const started = this.#now();
    integer(started);
    let previous = started;
    return () => {
      const time = this.#now();
      integer(time);
      requireHandoff(time >= previous && time - started <= maxOperation);
      previous = time;
      return time;
    };
  }
  #fresh(receipt: AppliedTargetReceipt, now: number): void {
    requireHandoff(receipt.issued_at <= now && receipt.expires_at > now);
  }
  #bytes(value: unknown): Uint8Array {
    requireHandoff(
      value instanceof Uint8Array && value.length >= 32 && value.length <= maxPayload + 32,
    );
    return Uint8Array.from(value);
  }

  async #wait<T>(operation: () => Promise<T>, tick: () => number, deadline: number): Promise<T> {
    const remaining = deadline - tick();
    requireHandoff(remaining > 0 && remaining <= maxOperation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("invalid-target-handoff")), remaining);
        }),
        operation(),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async seal(request: {
    context: AppliedTargetContext;
    envelope: AppliedTargetEnvelope;
    expires_at: number;
  }): Promise<AppliedTargetReceipt> {
    try {
      // Copy bounded inputs before the first await, including the expected producer context.
      const input = exact(snapshot(request), ["context", "envelope", "expires_at"]);
      const c = context(input.context, this.target);
      const envelope = appliedTargetEnvelope(input.envelope, c);
      const tick = this.#clock();
      const issuedAt = tick();
      integer(input.expires_at);
      requireHandoff(input.expires_at > issuedAt && input.expires_at - issuedAt <= maxLifetime);
      const payloadDigest = privateDigest(envelope);
      const header = {
        schema: 1 as const,
        purpose,
        target: this.target,
        backend: this.backend,
        release: c.release,
        producer: c.producer,
        mode: envelope.verification.mode,
        path: path(c, payloadDigest),
        payload_digest: payloadDigest,
        issued_at: issuedAt,
        expires_at: input.expires_at,
      };
      const plaintext = { header, envelope };
      requireHandoff(Buffer.byteLength(canonical(plaintext)) <= maxPayload);
      const bytes = this.#codec.seal(header.path, plaintext);
      const result = receipt({ ...header, ciphertext_digest: hash(bytes) }, c, this.backend);
      const deadline = Math.min(result.expires_at, issuedAt + maxOperation);
      requireHandoff((await this.#wait(() => this.#read(result.path), tick, deadline)) === null);
      this.#fresh(result, tick());
      // Transport receives its own copy so it cannot mutate the bytes whose digest is expected.
      // A timeout cannot cancel an already-started write; it is uncertain and grants no retry.
      await this.#wait(() => this.#write(result.path, Uint8Array.from(bytes)), tick, deadline);
      this.#fresh(result, tick());
      const reopened = this.#bytes(await this.#wait(() => this.#read(result.path), tick, deadline));
      this.#fresh(result, tick());
      requireHandoff(Buffer.from(reopened).equals(bytes));
      return freeze(result);
    } catch {
      throw new Error("target-handoff-seal-failed");
    }
  }

  async read(request: {
    context: AppliedTargetContext;
    receipt: AppliedTargetReceipt;
  }): Promise<AuthenticatedAppliedTarget> {
    try {
      const input = exact(snapshot(request), ["context", "receipt"]);
      const c = context(input.context, this.target);
      const expected = receipt(input.receipt, c, this.backend);
      const tick = this.#clock();
      const started = tick();
      this.#fresh(expected, started);
      const deadline = Math.min(expected.expires_at, started + maxOperation);
      const bytes = this.#bytes(await this.#wait(() => this.#read(expected.path), tick, deadline));
      this.#fresh(expected, tick());
      requireHandoff(hash(bytes) === expected.ciphertext_digest);
      const opened = exact(snapshot(this.#codec.open(expected.path, bytes)), [
        "header",
        "envelope",
      ]);
      const { ciphertext_digest: _ciphertextDigest, ...header } = expected;
      requireHandoff(isDeepStrictEqual(opened.header, header));
      const envelope = appliedTargetEnvelope(opened.envelope, c);
      requireHandoff(
        privateDigest(envelope) === expected.payload_digest &&
          envelope.verification.mode === expected.mode,
      );
      const evidenceRequest = freeze({
        receipt: expected,
        job: {
          workflow_ref: workflow,
          workflow_commit: c.release.config_commit,
          job_name: expected.mode === "apply" ? "Apply infrastructure" : "Plan infrastructure",
          critical_step: "Seal applied target descriptor",
        },
        requested_at: tick(),
      } satisfies AppliedTargetJobRequest);
      const evidence = snapshot(
        await this.#wait(() => this.#verify(evidenceRequest), tick, deadline),
      );
      const observed = tick();
      this.#fresh(expected, observed);
      const proof = jobProof(evidence, evidenceRequest, observed);
      const finalBytes = this.#bytes(
        await this.#wait(
          () => this.#read(expected.path),
          tick,
          Math.min(deadline, proof.expires_at),
        ),
      );
      const finalTime = tick();
      this.#fresh(expected, finalTime);
      jobProof(proof, evidenceRequest, finalTime);
      requireHandoff(Buffer.from(finalBytes).equals(Buffer.from(bytes)));
      return freeze({ envelope, receipt: expected, proof });
    } catch {
      throw new Error("target-handoff-read-failed");
    }
  }
}
