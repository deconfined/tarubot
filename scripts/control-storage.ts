/**
 * Scoped native S3 persistence for future journal adapters. All configuration and credentials
 * are explicit; this module reads no environment, token file, state or saved plan. Serialization,
 * owner fences, encrypted readback and recovery guards remain the caller's responsibilities.
 * No lock/CAS, deletion, listing, version discovery or historical-version transport is supplied.
 */
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { privateDigest, type ControlStore } from "./infra-control.js";

export type ControlStorageScope = "infra" | "trust-staging" | "trust-production";
export interface ControlStorageConfig {
  scope: ControlStorageScope;
  bucket: string;
  /** Canonical regional HTTPS origin, before the bucket hostname is prepended. */
  endpoint: string;
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    /** Required nullable input: null means no temporary session credential is authorized. */
    sessionToken: string | null;
  };
}
export interface ScopedControlStore extends ControlStore {
  readonly scope: ControlStorageScope;
  readonly namespace: string;
  /** Private digest of actual routing/scope, excluding credentials; not owner authorization. */
  readonly binding: string;
}
type NativeClient = Pick<Bun.S3Client, "file" | "write" | "presign">;
type Dependencies = {
  /** Internal injected test seam, never caller-selected CLI transport or arbitrary object URL. */
  createClient?: (configuration: Bun.S3Options) => NativeClient;
};
type Value = Record<string, unknown>;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// This matches recovery's aggregate ceiling; native streams allow enforcing it before buffering.
const maximumBytes = 64 * 1024 * 1024;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeSet = Uint8Array.prototype.set;
const nativeBind = Function.prototype.bind;
const nativeThen = Promise.prototype.then;
function requireStorage(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-storage");
}
function synchronousRefusal(callback: (() => void) | undefined): void {
  requireStorage(callback === undefined || typeof callback === "function");
  const result: unknown = callback?.();
  try {
    // Drain real native promises across realms without reading an arbitrary .then getter.
    void Reflect.apply(nativeThen, result, [undefined, () => {}]);
  } catch {
    // Non-promise returns still refuse; no thenable callback is invoked or awaited.
  }
  requireStorage(result === undefined);
}
function exact(value: unknown, keys: string[]): Value {
  requireStorage(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Value;
  requireStorage(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function configuration(value: unknown): ControlStorageConfig {
  const c = exact(structuredClone(value), ["scope", "bucket", "endpoint", "region", "credentials"]);
  requireStorage(
    c.scope === "infra" || c.scope === "trust-staging" || c.scope === "trust-production",
  );
  // Dotted buckets need independently verified TLS semantics; never silently change addressing.
  requireStorage(
    typeof c.bucket === "string" &&
      c.bucket.length >= 3 &&
      c.bucket.length <= 63 &&
      label.test(c.bucket),
  );
  requireStorage(typeof c.endpoint === "string" && c.endpoint.startsWith("https://"));
  const host = c.endpoint.slice("https://".length);
  requireStorage(
    host.split(".").length >= 2 &&
      host.split(".").every((part) => label.test(part)) &&
      isIP(host) === 0 &&
      !host.startsWith(`${c.bucket}.`) &&
      `${c.bucket}.${host}`.length <= 253,
  );
  requireStorage(typeof c.region === "string" && label.test(c.region));
  const credentials = exact(c.credentials, ["accessKeyId", "secretAccessKey", "sessionToken"]);
  requireStorage(
    typeof credentials.accessKeyId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(credentials.accessKeyId),
  );
  requireStorage(
    typeof credentials.secretAccessKey === "string" &&
      /^[\x21-\x7e]{1,4096}$/u.test(credentials.secretAccessKey),
  );
  requireStorage(
    credentials.sessionToken === null ||
      (typeof credentials.sessionToken === "string" &&
        /^[\x21-\x7e]{1,8192}$/u.test(credentials.sessionToken)),
  );
  return structuredClone(c) as unknown as ControlStorageConfig;
}

class NativeControlStore implements ScopedControlStore {
  readonly scope: ControlStorageScope;
  readonly namespace: string;
  readonly binding: string;
  // Freezing public metadata alone does not hide secrets or freeze nested TypeScript-private data.
  readonly #endpoint: string;
  readonly #allowed: RegExp;
  readonly #config: ControlStorageConfig;
  readonly #client: NativeClient;
  readonly #file: NativeClient["file"];
  readonly #presign: NativeClient["presign"];
  #readHook: { fence(): void } | undefined;
  constructor(config: ControlStorageConfig, client: NativeClient) {
    this.#config = structuredClone(config);
    this.#client = client;
    const file = client.file,
      presign = client.presign;
    requireStorage(typeof file === "function" && typeof presign === "function");
    this.#file = Reflect.apply(nativeBind, file, [client]) as NativeClient["file"];
    this.#presign = Reflect.apply(nativeBind, presign, [client]) as NativeClient["presign"];
    // The read path never captures the backing client's write getter/capability.
    this.scope = config.scope;
    this.namespace = `tarubot/control/v1/${config.scope}/`;
    this.#endpoint = `https://${config.bucket}.${config.endpoint.slice("https://".length)}`;
    const target = config.scope === "infra" ? "infra" : config.scope.slice("trust-".length);
    const ordinary =
      target === "infra"
        ? `(?:current|(?:intents|baselines|completed)/${uuid})`
        : `trust/${target}/(?:registration|authorization-current|current|(?:authorizations|attempts|consumed|intents|references|records|publication-intents|publications|completed)/${uuid})`;
    const repair = `recovery/${target}/(?:registration|current|(?:intents|completed)/${uuid})`;
    this.#allowed = new RegExp(`^(?:${ordinary}|${repair})$`, "u");
    this.binding = privateDigest({
      purpose: "tarubot-scoped-control-storage-v1",
      scope: this.scope,
      namespace: this.namespace,
      bucket: config.bucket,
      endpoint: this.#endpoint,
      region: config.region,
      virtualHostedStyle: true,
    });
    this.#assertClient(
      this.namespace + (target === "infra" ? "current" : `trust/${target}/current`),
    );
    Object.freeze(this);
  }
  #key(path: string): string {
    requireStorage(typeof path === "string" && this.#allowed.test(path));
    return this.namespace + path;
  }
  #readHooks<T>(fence: () => void, work: () => T): T {
    if (this.#readHook) {
      this.#readHook.fence();
      fence();
      throw new Error("control-storage-read-failed");
    }
    const reservation = { fence };
    this.#readHook = reservation;
    try {
      return work();
    } finally {
      if (this.#readHook === reservation) this.#readHook = undefined;
    }
  }
  /**
   * Bun 1.4.2 inherits ambient session credentials even when sessionToken is an explicit empty
   * string. Presigning is local, makes no request and verifies the effective native routing and
   * credential scope before every operation. Unexpected fallback fails without changing env.
   */
  #assertClient(key: string): void {
    const url = new URL(this.#presign(key, { method: "GET", expiresIn: 1 }));
    const date = url.searchParams.get("X-Amz-Date");
    requireStorage(typeof date === "string" && /^[0-9]{8}T[0-9]{6}Z$/u.test(date));
    const credential = `${this.#config.credentials.accessKeyId}/${date.slice(0, 8)}/${this.#config.region}/s3/aws4_request`;
    requireStorage(
      url.origin === this.#endpoint &&
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
  async read(path: string, beforeRead?: () => void): Promise<Uint8Array | null> {
    if (this.#readHook) {
      this.#readHook.fence();
      throw new Error("control-storage-read-failed");
    }
    const key = this.#key(path);
    const refusal = beforeRead;
    let fenced = false,
      checking = false,
      observedBytes = false;
    const fence = () => {
      fenced = true;
    };
    const guard = () => {
      let owns = false;
      try {
        requireStorage(!fenced && !checking);
        checking = true;
        owns = true;
        this.#readHooks(fence, () => synchronousRefusal(refusal));
        requireStorage(!fenced && checking);
      } catch {
        fenced = true;
        throw new Error("control-storage-read-failed");
      } finally {
        if (owns) checking = false;
      }
    };
    const capture = <T extends object, K extends keyof T>(receiver: T, name: K): T[K] => {
      try {
        guard();
        const bound = this.#readHooks(fence, () => {
          const method = receiver[name];
          requireStorage(typeof method === "function");
          return Reflect.apply(nativeBind, method, [receiver]) as T[K];
        });
        guard();
        return bound;
      } catch {
        // Preparation/getter failures are never evidence of a missing remote object.
        fenced = true;
        throw new Error("control-storage-read-failed");
      }
    };
    let cancel: (() => Promise<void>) | undefined,
      release: (() => void) | undefined,
      cleaned = false;
    const cleanup = (failed: boolean) => {
      if (cleaned) return;
      cleaned = true;
      if (failed && cancel)
        try {
          // Accepted I/O may need cancellation after refusal. It grants no read/write
          // authority, and an unknown cleanup acknowledgement must not hold failure open.
          void Promise.resolve(this.#readHooks(fence, cancel)).catch(() => {});
        } catch {
          // Cleanup diagnostics stay private; they cannot turn denial into absence.
        }
      if (release)
        try {
          this.#readHooks(fence, release);
        } catch {
          fenced = true;
        }
    };
    try {
      guard();
      try {
        this.#readHooks(fence, () => this.#assertClient(key));
      } catch {
        fenced = true;
        throw new Error("control-storage-read-failed");
      }
      guard();
      const file = this.#readHooks(fence, () => this.#file(key, { retry: 0 }));
      const streamMethod = capture(file, "stream");
      guard();
      const stream = this.#readHooks(fence, streamMethod);
      const getReader = capture(stream, "getReader");
      guard();
      const reader = this.#readHooks(fence, getReader) as ReadableStreamDefaultReader<Uint8Array>;
      const read = capture(reader, "read");
      cancel = capture(reader, "cancel");
      release = capture(reader, "releaseLock");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        guard();
        const chunk = await this.#readHooks(fence, read);
        guard();
        const fields = this.#readHooks(fence, () => Object.getOwnPropertyDescriptors(chunk));
        guard();
        requireStorage(Object.hasOwn(fields.done ?? {}, "value"));
        const done = fields.done?.value;
        requireStorage(typeof done === "boolean");
        if (done) break;
        requireStorage(Object.hasOwn(fields.value ?? {}, "value"));
        const value = fields.value?.value;
        requireStorage(value instanceof Uint8Array && byteLength !== undefined);
        const length = byteLength.call(value) as number;
        observedBytes ||= length > 0;
        size += length;
        requireStorage(size <= maximumBytes);
        const bytes = new Uint8Array(length);
        nativeSet.call(bytes, value);
        guard();
        chunks.push(bytes);
      }
      requireStorage(size > 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        nativeSet.call(bytes, chunk, offset);
        offset += byteLength?.call(chunk) as number;
        guard();
      }
      cleanup(false);
      guard();
      return bytes;
    } catch (error) {
      cleanup(true);
      // Bare 404, denied access, missing bucket and ambiguous reads are never definite absence.
      if (!fenced && !observedBytes && error instanceof Error)
        try {
          guard();
          const code = this.#readHooks(fence, () => Object.getOwnPropertyDescriptor(error, "code"));
          guard();
          if (code && Object.hasOwn(code, "value") && code.value === "NoSuchKey") return null;
        } catch {
          fenced = true;
        }
      fenced = true;
      throw new Error("control-storage-read-failed");
    }
  }
  async write(path: string, value: Uint8Array, beforeWrite?: () => void): Promise<void> {
    if (this.#readHook) {
      this.#readHook.fence();
      throw new Error("control-storage-write-failed");
    }
    const fence = beforeWrite;
    requireStorage(fence === undefined || typeof fence === "function");
    const key = this.#key(path);
    requireStorage(value instanceof Uint8Array && byteLength !== undefined);
    const length = byteLength.call(value) as number;
    requireStorage(length > 0 && length <= maximumBytes);
    const bytes = new Uint8Array(length);
    nativeSet.call(bytes, value);
    let fenced = false;
    const deny = () => {
      fenced = true;
    };
    const guard = () => {
      requireStorage(!fenced);
      this.#readHooks(deny, () => synchronousRefusal(fence));
      requireStorage(!fenced);
    };
    try {
      // Read consumers never capture write. A mutation captures/binds it and prepares owned
      // bytes/options BEFORE its final original denial, including changing accessor hooks.
      const write = this.#readHooks(deny, () => {
        const method = this.#client.write;
        requireStorage(typeof method === "function");
        return Reflect.apply(nativeBind, method, [this.#client]) as NativeClient["write"];
      });
      const options = { type: "application/octet-stream", retry: 0 };
      this.#readHooks(deny, () => this.#assertClient(key));
      // A denial-only journal fence runs after synchronous routing/presign preparation too.
      // No await separates this check from initiation; an in-flight PUT remains uncertain.
      guard();
      await this.#readHooks(deny, () => write(key, bytes, options));
      guard();
    } catch {
      // An acknowledgement failure may follow a successful write; leave the journal fenced.
      throw new Error("control-storage-write-failed");
    }
  }
}

/** Explicit regional endpoint -> exact bucket-qualified virtual host; no environment factory. */
export function createControlStorage(
  value: ControlStorageConfig,
  dependencies: Dependencies = {},
): ScopedControlStore {
  try {
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
    return new NativeControlStore(
      config,
      (dependencies.createClient ?? ((configuration) => new Bun.S3Client(configuration)))(options),
    );
  } catch {
    throw new Error("invalid-control-storage");
  }
}
