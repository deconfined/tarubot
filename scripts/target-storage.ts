/**
 * Descriptor-only native persistence. Explicit route/credentials and a dedicated per-target
 * descriptor passphrase are required; no state/trust/environment configuration is inspected.
 * Consume-only and seal-only capabilities expose no raw client/store/key/list/delete/version API.
 * Owner IAM must independently restrict the physical prefix; this module cannot attest IAM.
 */
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { privateDigest, type ControlStore } from "./infra-control.js";
import type { TargetRole } from "./ssh-trust.js";
import { AppliedTargetHandoff, type VerifyAppliedTargetJob } from "./target-handoff.js";

type Value = Record<string, unknown>;
type NativeReader = Pick<Bun.S3Client, "file" | "presign">;
type NativeClient = NativeReader & Partial<Pick<Bun.S3Client, "write">>;
type NativeDependencies = {
  /** Trusted test capability only, never a caller-selected URL or CLI transport. */
  createClient?: (configuration: Bun.S3Options) => NativeClient;
  now?: () => number;
};
const maximumBytes = 65_568;
const nativeBudget = 20_000;
const operationBudget = 60_000;
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface TargetDescriptorStorageConfig {
  target: TargetRole;
  bucket: string;
  /** Canonical regional HTTPS origin, before the bucket hostname is prepended. */
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string | null };
  /** Dedicated descriptor passphrase, never a state/trust/recovery passphrase. */
  descriptor_passphrase: string;
}
interface TargetStorageMetadata {
  readonly target: TargetRole;
  readonly namespace: string;
  /** Actual physical route digest, used as the handoff backend; private metadata, not approval. */
  readonly binding: string;
}
export interface TargetDescriptorConsumer extends TargetStorageMetadata {
  consume(
    request: Parameters<AppliedTargetHandoff["read"]>[0],
  ): ReturnType<AppliedTargetHandoff["read"]>;
}
export interface TargetDescriptorProducer extends TargetStorageMetadata {
  seal(
    request: Parameters<AppliedTargetHandoff["seal"]>[0],
  ): ReturnType<AppliedTargetHandoff["seal"]>;
}

function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-storage");
}
function exact(value: unknown, keys: string[]): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Value;
  valid(isDeepStrictEqual(Reflect.ownKeys(result).sort(), [...keys].sort()));
  return result;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/** Bounded plain snapshots reject getters, cycles and mutable shared authority references. */
function snapshot(value: unknown): unknown {
  let size = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    valid(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      size += Buffer.byteLength(input);
      valid(size <= 65_536);
      return input;
    }
    if (typeof input === "number") {
      valid(Number.isFinite(input));
      return input;
    }
    valid(input !== null && typeof input === "object" && !ancestors.has(input));
    ancestors.add(input);
    valid(Object.getOwnPropertySymbols(input).length === 0);
    const properties = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      valid(input.length <= 1024 && Object.keys(properties).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const property = properties[String(index)];
        valid(property?.enumerable === true && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    } else {
      valid(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const output: Value = {};
      for (const [key, property] of Object.entries(properties)) {
        valid(property.enumerable === true && Object.hasOwn(property, "value"));
        size += Buffer.byteLength(key);
        valid(size <= 65_536);
        Object.defineProperty(output, key, {
          value: copy(property.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = output;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
function configuration(value: unknown): TargetDescriptorStorageConfig {
  const config = exact(snapshot(value), [
    "target",
    "bucket",
    "endpoint",
    "region",
    "credentials",
    "descriptor_passphrase",
  ]);
  valid(config.target === "staging" || config.target === "production");
  valid(
    typeof config.bucket === "string" &&
      config.bucket.length >= 3 &&
      config.bucket.length <= 63 &&
      label.test(config.bucket),
  );
  valid(typeof config.endpoint === "string" && config.endpoint.startsWith("https://"));
  const host = config.endpoint.slice("https://".length);
  valid(
    host.split(".").length >= 2 &&
      host.split(".").every((part) => label.test(part)) &&
      isIP(host) === 0 &&
      !host.startsWith(`${config.bucket}.`) &&
      `${config.bucket}.${host}`.length <= 253,
  );
  valid(typeof config.region === "string" && label.test(config.region));
  const credentials = exact(config.credentials, ["accessKeyId", "secretAccessKey", "sessionToken"]);
  valid(
    typeof credentials.accessKeyId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(credentials.accessKeyId),
  );
  valid(
    typeof credentials.secretAccessKey === "string" &&
      /^[\x21-\x7e]{1,4096}$/u.test(credentials.secretAccessKey),
  );
  valid(
    credentials.sessionToken === null ||
      (typeof credentials.sessionToken === "string" &&
        /^[\x21-\x7e]{1,8192}$/u.test(credentials.sessionToken)),
  );
  valid(
    typeof config.descriptor_passphrase === "string" &&
      config.descriptor_passphrase.length >= 32 &&
      config.descriptor_passphrase.length <= 4096,
  );
  return config as unknown as TargetDescriptorStorageConfig;
}

/** Each invocation has its own cancellation fence; a late promise cannot enter a later call. */
class Operation {
  readonly #now: () => number;
  readonly #started: number;
  readonly #deadline: number;
  readonly #physicalDeadline: number;
  #previous: number;
  #active = true;
  constructor(now: () => number, expiresAt: unknown) {
    this.#now = now;
    const started = now();
    integer(started);
    integer(expiresAt);
    valid(expiresAt > started && expiresAt - started <= 3_600_000);
    this.#started = started;
    this.#previous = started;
    this.#deadline = Math.min(expiresAt, started + operationBudget);
    this.#physicalDeadline = performance.now() + (this.#deadline - started);
  }
  clock(): number {
    const now = this.#now();
    integer(now);
    valid(
      this.#active &&
        now >= this.#previous &&
        now >= this.#started &&
        now < this.#deadline &&
        performance.now() < this.#physicalDeadline,
    );
    this.#previous = now;
    return now;
  }
  remaining(): number {
    const remaining = Math.min(
      this.#deadline - this.clock(),
      this.#physicalDeadline - performance.now(),
    );
    valid(remaining > 0);
    return remaining;
  }
  stop(): void {
    this.#active = false;
  }
  async wait<T>(work: () => Promise<T>, limit: number): Promise<T> {
    const remaining = Math.min(limit, this.remaining());
    valid(Number.isFinite(remaining) && remaining > 0);
    const physicalDeadline = performance.now() + remaining;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.clock();
          return work();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.stop();
            reject(new Error("invalid-target-storage"));
          }, remaining);
        }),
      ]);
      this.clock();
      valid(performance.now() < physicalDeadline);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Standalone narrow adapter reuses the reviewed Bun routing/presign/stream pattern. Existing
 * control-storage scopes/allowlists/native behavior are untouched. All native methods are
 * captured privately. Reads/writes are bounded to20s and the enclosing call to60s/receipt expiry.
 * Cancellation is best effort; a timed-out write may persist and must be independently reconciled.
 * Bun1.4.2's native file API supplies no redirect control or complete HTTP response metadata.
 * Presigning proves the intended route/credential scope, not final-response URL/status. Its
 * pre-byte NoSuchKey contract requires an independently trusted compatible backend. Consumer
 * hashes/AEAD/exact readbacks validate complete ciphertext; this is no full HTTP attestation.
 */
class NativeTargetStore implements TargetStorageMetadata {
  readonly target: TargetRole;
  readonly namespace: string;
  readonly binding: string;
  readonly #config: TargetDescriptorStorageConfig;
  readonly #origin: string;
  readonly #allowed: RegExp;
  readonly #file: NativeReader["file"];
  readonly #presign: NativeReader["presign"];
  readonly #write: Bun.S3Client["write"] | undefined;
  constructor(config: TargetDescriptorStorageConfig, client: NativeClient, writer: boolean) {
    this.#config = config;
    this.target = config.target;
    this.namespace = `tarubot/applied-target/v1/${config.target}/`;
    this.#origin = `https://${config.bucket}.${config.endpoint.slice("https://".length)}`;
    this.#allowed = new RegExp(
      `^applied-target/${config.target}/([1-9][0-9]{0,15})/[a-f0-9]{40}/[a-f0-9]{64}$`,
      "u",
    );
    const file = client.file;
    const presign = client.presign;
    const write = writer ? client.write : undefined;
    valid(
      typeof file === "function" &&
        typeof presign === "function" &&
        (!writer || typeof write === "function"),
    );
    this.#file = file.bind(client);
    this.#presign = presign.bind(client);
    this.#write = write?.bind(client);
    this.binding = privateDigest({
      purpose: "tarubot-applied-target-storage-v1",
      target: this.target,
      namespace: this.namespace,
      bucket: config.bucket,
      endpoint: this.#origin,
      region: config.region,
      virtualHostedStyle: true,
    });
    // Presigning is local only, with a documentation fixture key; it performs no native HTTP.
    this.#assertClient(
      this.#key(`applied-target/${this.target}/1/${"0".repeat(40)}/${"0".repeat(64)}`),
    );
    Object.freeze(this);
  }
  #key(path: string): string {
    valid(typeof path === "string");
    const match = this.#allowed.exec(path);
    valid(match !== null && Number.isSafeInteger(Number(match[1])));
    return this.namespace + path;
  }
  #assertClient(key: string): void {
    const url = new URL(this.#presign(key, { method: "GET", expiresIn: 1 }));
    const date = url.searchParams.get("X-Amz-Date");
    valid(typeof date === "string" && /^[0-9]{8}T[0-9]{6}Z$/u.test(date));
    const credential = `${this.#config.credentials.accessKeyId}/${date.slice(0, 8)}/${this.#config.region}/s3/aws4_request`;
    valid(
      url.origin === this.#origin &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        url.pathname === `/${key}` &&
        url.searchParams.getAll("X-Amz-Credential").length === 1 &&
        url.searchParams.get("X-Amz-Credential") === credential &&
        url.searchParams.getAll("X-Amz-Security-Token").length <= 1 &&
        url.searchParams.get("X-Amz-Security-Token") === this.#config.credentials.sessionToken,
    );
  }
  async read(path: string, operation: Operation): Promise<Uint8Array | null> {
    const key = this.#key(path);
    let observedBytes = false;
    try {
      operation.clock();
      this.#assertClient(key);
      const reader = this.#file(key, { retry: 0 }).stream().getReader();
      const physicalDeadline = performance.now() + nativeBudget;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await operation.wait(
            () => reader.read(),
            physicalDeadline - performance.now(),
          );
          if (chunk.done) break;
          valid(chunk.value instanceof Uint8Array);
          observedBytes ||= chunk.value.byteLength > 0;
          size += chunk.value.byteLength;
          valid(size <= maximumBytes);
          chunks.push(Uint8Array.from(chunk.value));
        }
        valid(size >= 32);
      } catch (error) {
        // Do not await a possibly unresolved cancellation acknowledgement. Cancellation closes
        // pending reads immediately; its late private diagnostics do not extend the deadline.
        try {
          void reader.cancel().catch(() => {});
        } catch {
          /* The failure remains fenced. */
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
      operation.clock();
      this.#assertClient(key);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      // A complete native NoSuchKey before any bytes is definite absence; denied/wrong-bucket/
      // partial/timeout errors refuse. Recheck the operation and actual routing before null.
      if (
        !observedBytes &&
        error instanceof Error &&
        "code" in error &&
        error.code === "NoSuchKey"
      ) {
        operation.clock();
        this.#assertClient(key);
        return null;
      }
      throw new Error("target-storage-read-failed");
    }
  }
  async write(path: string, value: Uint8Array, operation: Operation): Promise<void> {
    // Consumer backing credentials may be broader: no write method is captured or invoked.
    valid(this.#write !== undefined);
    const key = this.#key(path);
    valid(
      value instanceof Uint8Array && value.byteLength >= 32 && value.byteLength <= maximumBytes,
    );
    const bytes = Uint8Array.from(value);
    try {
      operation.clock();
      this.#assertClient(key);
      const write = this.#write;
      await operation.wait(
        () => write(key, bytes, { type: "application/octet-stream", retry: 0 }),
        nativeBudget,
      );
      operation.clock();
      this.#assertClient(key);
    } catch {
      throw new Error("target-storage-write-failed");
    }
  }
}

interface CapturedConfiguration {
  config: TargetDescriptorStorageConfig;
  store: NativeTargetStore;
  now: () => number;
}
function capture(
  value: TargetDescriptorStorageConfig,
  dependencies: NativeDependencies,
  writer: boolean,
): CapturedConfiguration {
  // Capture trusted capability functions once; snapshot only supplied plain authority data.
  const createClient =
    dependencies.createClient ?? ((options: Bun.S3Options) => new Bun.S3Client(options));
  const now = dependencies.now ?? Date.now;
  valid(typeof createClient === "function" && typeof now === "function");
  const config = configuration(value);
  const options: Bun.S3Options = {
    bucket: config.bucket,
    endpoint: `https://${config.bucket}.${config.endpoint.slice("https://".length)}`,
    region: config.region,
    virtualHostedStyle: true,
    retry: 0,
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey,
    sessionToken: config.credentials.sessionToken ?? "",
  };
  return { config, store: new NativeTargetStore(config, createClient(options), writer), now };
}
function handoff(
  captured: CapturedConfiguration,
  operation: Operation,
  verify: VerifyAppliedTargetJob,
): AppliedTargetHandoff {
  const store: ControlStore = {
    read: (path) => captured.store.read(path, operation),
    write: (path, bytes) => captured.store.write(path, bytes, operation),
  };
  return new AppliedTargetHandoff(
    {
      target: captured.store.target,
      backend: captured.store.binding,
      descriptor_passphrase: captured.config.descriptor_passphrase,
    },
    { store, verifyProducerJob: verify, now: () => operation.clock() },
  );
}
function metadata(value: CapturedConfiguration): TargetStorageMetadata {
  return {
    target: value.store.target,
    namespace: value.store.namespace,
    binding: value.store.binding,
  };
}

class Consumer implements TargetDescriptorConsumer {
  readonly target: TargetRole;
  readonly namespace: string;
  readonly binding: string;
  readonly #captured: CapturedConfiguration;
  readonly #verify: VerifyAppliedTargetJob;
  constructor(captured: CapturedConfiguration, verify: VerifyAppliedTargetJob) {
    this.#captured = captured;
    this.#verify = verify;
    const data = metadata(captured);
    this.target = data.target;
    this.namespace = data.namespace;
    this.binding = data.binding;
    Object.freeze(this);
  }
  async consume(
    request: Parameters<AppliedTargetHandoff["read"]>[0],
  ): ReturnType<AppliedTargetHandoff["read"]> {
    let operation: Operation | undefined;
    try {
      const input = exact(snapshot(request), ["context", "receipt"]);
      operation = new Operation(this.#captured.now, (input.receipt as Value)?.expires_at);
      const boundary = handoff(this.#captured, operation, this.#verify);
      const result = await operation.wait(
        () => boundary.read(input as unknown as Parameters<AppliedTargetHandoff["read"]>[0]),
        operationBudget,
      );
      operation.clock();
      return result;
    } catch {
      throw new Error("target-storage-consume-failed");
    } finally {
      operation?.stop();
    }
  }
}
class Producer implements TargetDescriptorProducer {
  readonly target: TargetRole;
  readonly namespace: string;
  readonly binding: string;
  readonly #captured: CapturedConfiguration;
  #busy = false;
  #fenced = false;
  constructor(captured: CapturedConfiguration) {
    this.#captured = captured;
    const data = metadata(captured);
    this.target = data.target;
    this.namespace = data.namespace;
    this.binding = data.binding;
    Object.freeze(this);
  }
  /** Caller must hold the independent serialized infrastructure writer; this is no distributed lock. */
  async seal(
    request: Parameters<AppliedTargetHandoff["seal"]>[0],
  ): ReturnType<AppliedTargetHandoff["seal"]> {
    let operation: Operation | undefined;
    let ownsOperation = false;
    try {
      valid(!this.#busy && !this.#fenced);
      this.#busy = true;
      ownsOperation = true;
      const input = exact(snapshot(request), ["context", "envelope", "expires_at"]);
      operation = new Operation(this.#captured.now, input.expires_at);
      // Producer cannot authenticate consumption, even if its backing S3 credentials can read.
      const boundary = handoff(this.#captured, operation, async () => {
        throw new Error("target-producer-cannot-consume");
      });
      const result = await operation.wait(
        () => boundary.seal(input as unknown as Parameters<AppliedTargetHandoff["seal"]>[0]),
        operationBudget,
      );
      operation.clock();
      return result;
    } catch {
      if (ownsOperation) this.#fenced = true;
      throw new Error("target-storage-seal-failed");
    } finally {
      operation?.stop();
      if (ownsOperation) this.#busy = false;
    }
  }
}

/** Read-only consumer; mandatory independent sealing JOB verifier, no seal/raw-write capability. */
export function createTargetDescriptorConsumer(
  value: TargetDescriptorStorageConfig,
  dependencies: NativeDependencies & { verifyProducerJob: VerifyAppliedTargetJob },
): TargetDescriptorConsumer {
  try {
    const verify = dependencies.verifyProducerJob;
    valid(typeof verify === "function");
    return new Consumer(capture(value, dependencies, false), verify);
  } catch {
    throw new Error("invalid-target-storage");
  }
}
/** Seal-only producer; failed/uncertain seals fence this instance and authorize no retry/overwrite. */
export function createTargetDescriptorProducer(
  value: TargetDescriptorStorageConfig,
  dependencies: NativeDependencies = {},
): TargetDescriptorProducer {
  try {
    return new Producer(capture(value, dependencies, true));
  } catch {
    throw new Error("invalid-target-storage");
  }
}
