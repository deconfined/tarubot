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
function requireStorage(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-storage");
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
  constructor(config: ControlStorageConfig, client: NativeClient) {
    this.#config = structuredClone(config);
    this.#client = client;
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
  /**
   * Bun 1.4.2 inherits ambient session credentials even when sessionToken is an explicit empty
   * string. Presigning is local, makes no request and verifies the effective native routing and
   * credential scope before every operation. Unexpected fallback fails without changing env.
   */
  #assertClient(key: string): void {
    const url = new URL(this.#client.presign(key, { method: "GET", expiresIn: 1 }));
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
  async read(path: string): Promise<Uint8Array | null> {
    const key = this.#key(path);
    try {
      this.#assertClient(key);
    } catch {
      throw new Error("control-storage-read-failed");
    }
    let observedBytes = false;
    try {
      const reader = this.#client.file(key, { retry: 0 }).stream().getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          requireStorage(chunk.value instanceof Uint8Array);
          observedBytes ||= chunk.value.byteLength > 0;
          size += chunk.value.byteLength;
          requireStorage(size <= maximumBytes);
          chunks.push(Uint8Array.from(chunk.value));
        }
        requireStorage(size > 0);
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation diagnostics are private; the original failure still blocks consumers.
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      // Bare 404, denied access, missing bucket and ambiguous reads are never definite absence.
      if (!observedBytes && error instanceof Error && "code" in error && error.code === "NoSuchKey")
        return null;
      throw new Error("control-storage-read-failed");
    }
  }
  async write(path: string, value: Uint8Array, beforeWrite?: () => void): Promise<void> {
    const fence = beforeWrite;
    requireStorage(fence === undefined || typeof fence === "function");
    const key = this.#key(path);
    requireStorage(
      value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maximumBytes,
    );
    const bytes = Uint8Array.from(value);
    try {
      this.#assertClient(key);
      // A denial-only journal fence runs after synchronous routing/presign preparation too.
      // No await separates this check from initiation; an in-flight PUT remains uncertain.
      requireStorage(fence?.() === undefined);
      await this.#client.write(key, bytes, { type: "application/octet-stream", retry: 0 });
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
