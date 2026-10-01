/**
 * Separate v2 native descriptor transport. Writer serialization and prefix-scoped owner IAM
 * remain independent prerequisites. No state/trust/v1 key, raw store, list/delete/version API,
 * mint HTTP, workflow operation, provider operation or host capability is supplied here.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { canonical, privateDigest } from "./infra-control.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import type { AppliedTargetEnvelope } from "./target-descriptor.js";
import {
  contentReceiptV2,
  parseTargetContentV2Bytes,
  targetBootstrapV2,
  targetBootstrapV2Path,
  targetContentV2,
  targetContentV2Bytes,
  targetContentV2Digest,
  targetContentV2Path,
} from "./target-content-v2.js";
import {
  assertHistoricalTargetIssuanceProof,
  captureTargetIssuance,
  HistoricalTargetIssuanceVerifier,
  qualifyHistoricalTargetIssuanceProof,
  inspectQualifiedHistoricalTargetIssuanceData,
  fenceQualifiedHistoricalTargetIssuanceData,
  retireHistoricalTargetIssuanceProof,
  type QualifiedHistoricalTargetIssuanceData,
  type HistoricalTargetIssuanceHistory,
  withinHistoricalTargetIssuanceProof,
  type ContentReceiptV2,
  type HistoricalTargetIssuanceProof,
  type TargetIssuanceConfiguration,
  type TargetIssuanceContext,
  type TargetIssuanceStatementV2,
} from "./target-issuance.js";
import {
  captureTargetHistoryHook,
  requireTargetHistoryEntry as requireHistoryEntry,
} from "./target-issuance-run.js";
import type { GitHubReader } from "./trust-run.js";

type Value = Record<string, unknown>;
type NativeReader = Pick<Bun.S3Client, "file" | "presign">;
type NativeClient = NativeReader & Partial<Pick<Bun.S3Client, "write">>;
interface Dependencies {
  /** Trusted native-shaped test seams only; no raw client or verifier is returned. */
  createClient?: (config: Bun.S3Options) => NativeClient;
  now?: () => number;
}
/** Only explicit trusted capability functions are captured, once and without accessor hooks. */
function dependencySnapshot(
  value: Dependencies & { get?: GitHubReader },
  allowGet: boolean,
): Dependencies & { get?: GitHubReader } {
  valid(value !== null && typeof value === "object");
  valid(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const descriptors = Object.getOwnPropertyDescriptors(value),
    allowed = allowGet ? ["createClient", "now", "get"] : ["createClient", "now"];
  valid(
    Object.getOwnPropertySymbols(value).length === 0 &&
      Object.keys(descriptors).every((key) => allowed.includes(key)),
  );
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    valid(
      descriptor.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "function",
    );
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result as Dependencies & { get?: GitHubReader };
}
export interface TargetContentV2StorageConfiguration {
  target: "staging" | "production";
  bucket: string;
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string | null };
  /** Independently provisioned v2 descriptor passphrase, never state/trust/v1 passphrase. */
  descriptor_v2_passphrase: string;
}
interface Metadata {
  readonly target: "staging" | "production";
  readonly namespace: string;
  readonly binding: string;
}
declare const publicationBrand: unique symbol;
export type TargetContentV2Publication = Readonly<{ [publicationBrand]: true }>;
export interface TargetContentV2Producer extends Metadata {
  sealContent(request: {
    envelope: AppliedTargetEnvelope;
    expires_at: number;
  }): Promise<Readonly<{ receipt: ContentReceiptV2; publication: TargetContentV2Publication }>>;
  sealBootstrap(request: {
    publication: TargetContentV2Publication;
    statement: TargetIssuanceStatementV2;
    jwt: string;
  }): Promise<void>;
}
declare const resultBrand: unique symbol;
export type AuthenticatedTargetContentV2 = Readonly<{
  envelope: AppliedTargetEnvelope;
  statement: TargetIssuanceStatementV2;
  [resultBrand]: true;
}>;
export interface TargetContentV2Consumer extends Metadata {
  consume(release: ReleaseIdentity): Promise<AuthenticatedTargetContentV2>;
  /** One-way history handoff from this exact consumer; it retires the original authority. */
  qualify(
    content: AuthenticatedTargetContentV2,
    release: ReleaseIdentity,
  ): Promise<QualifiedTargetContentHistoryV2>;
}
declare const contentHistoryBrand: unique symbol;
export type QualifiedTargetContentHistoryV2 = Readonly<{ [contentHistoryBrand]: true }>;
export interface TargetContentHistoryV2 {
  readonly schema: 1;
  readonly purpose: "tarubot-target-content-history-data-v1";
  readonly context: TargetIssuanceContext;
  readonly content: ReturnType<typeof targetContentV2>;
  readonly statement: TargetIssuanceStatementV2;
  readonly receipt: ContentReceiptV2;
  /** Original artifact expiry only. Inspection never grants a fresh authority epoch. */
  readonly valid_until: number;
  readonly storage: Readonly<{
    binding: string;
    namespace: string;
    read_policy: "serialized-immutable-latest-object";
  }>;
  readonly objects: Readonly<{
    bootstrap: Readonly<{
      path: string;
      size: number;
      ciphertext_digest: string;
      identical_reads: 3;
    }>;
    content: Readonly<{
      path: string;
      size: number;
      ciphertext_digest: string;
      identical_reads: 3;
    }>;
  }>;
  readonly historical: HistoricalTargetIssuanceHistory;
}
const maximum = 65_568;
const budget = 60_000;
const nativeBudget = 20_000;
const historicalBudget = 30_000;
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, "byteLength")?.get;
const nativeSet = Uint8Array.prototype.set;
const nativeThen = Promise.prototype.then;
// Denial-only cleanup never consults a withheld reader/stream's own method getters.
const nativeReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const nativeReaderRelease = ReadableStreamDefaultReader.prototype.releaseLock;
const nativeStreamCancel = ReadableStream.prototype.cancel;
/** Refused clock/native work promises are drained without reading an inherited then getter. */
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Non-native values still fail the fixed synchronous/native promise contract. */
  }
}
function requireTargetHistoryEntry(): void {
  try {
    requireHistoryEntry();
  } catch {
    throw new Error("invalid-target-storage-v2");
  }
}
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-storage-v2");
}
function exact(value: unknown, keys: string[]): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Value;
  valid(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function bytes(value: Uint8Array, minimum = 32, limit = maximum): Uint8Array {
  valid(value instanceof Uint8Array && byteLength);
  const length = byteLength.call(value) as number;
  valid(length >= minimum && length <= limit);
  const copy = new Uint8Array(length);
  nativeSet.call(copy, value);
  return copy;
}
function configuration(value: unknown): TargetContentV2StorageConfiguration {
  const c = exact(captureTargetIssuance(value), [
    "target",
    "bucket",
    "endpoint",
    "region",
    "credentials",
    "descriptor_v2_passphrase",
  ]);
  valid(c.target === "staging" || c.target === "production");
  valid(
    typeof c.bucket === "string" &&
      c.bucket.length >= 3 &&
      c.bucket.length <= 63 &&
      label.test(c.bucket),
  );
  valid(typeof c.endpoint === "string" && c.endpoint.startsWith("https://"));
  const host = c.endpoint.slice(8);
  valid(
    host.split(".").length >= 2 &&
      host.split(".").every((part) => label.test(part)) &&
      isIP(host) === 0 &&
      !host.startsWith(`${c.bucket}.`) &&
      `${c.bucket}.${host}`.length <= 253,
  );
  valid(typeof c.region === "string" && label.test(c.region));
  const credentials = exact(c.credentials, ["accessKeyId", "secretAccessKey", "sessionToken"]);
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
    typeof c.descriptor_v2_passphrase === "string" &&
      c.descriptor_v2_passphrase.length >= 32 &&
      c.descriptor_v2_passphrase.length <= 4096,
  );
  return c as unknown as TargetContentV2StorageConfiguration;
}
/** The first physical instant precedes even the first clock callback and all input/KDF work. */
class Operation {
  readonly #now: () => number;
  readonly #originWall: number;
  readonly #originPhysical: number;
  #wall: number;
  #physical: number;
  #last: number;
  #active = true;
  #checking = false;
  #authority: (() => void) | undefined;
  #authorityWait: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
  #bounds = new Set<{ end: number; rearm?: () => void; reject?: () => void }>();
  #anchors: number[] = [];
  #historyFence: (() => void) | undefined;
  constructor(now: () => number) {
    const physical = performance.now();
    this.#originPhysical = physical;
    this.#now = now;
    const wall: unknown = now();
    if (typeof wall !== "number") {
      this.stop();
      drain(wall);
    }
    integer(wall);
    this.#originWall = wall;
    this.#last = wall;
    this.#wall = wall + budget;
    this.#physical = physical + budget;
    this.clock(physical);
  }
  #live(): void {
    const physical = performance.now();
    valid(this.#active && physical < this.#physical);
    for (const bound of this.#bounds) valid(physical < bound.end);
  }
  clock(anchor = performance.now()): number {
    const beforeHooks = Math.min(anchor, performance.now(), ...this.#anchors);
    let owned = false;
    try {
      this.#live();
      valid(!this.#checking);
      this.#checking = true;
      owned = true;
      const deny =
        this.#historyFence ?? (this.#authority === undefined ? undefined : () => this.stop());
      const now: unknown = deny ? captureTargetHistoryHook(() => this.#now(), deny) : this.#now();
      if (typeof now !== "number") {
        this.stop();
        drain(now);
      }
      integer(now);
      this.#live();
      valid(this.#checking && now >= this.#last && now < this.#wall);
      this.#last = now;
      // Every observed short remainder is projected from BEFORE the caller hook and
      // remains sticky during later frozen-wall route/KDF/stream/body work.
      this.#physical = Math.min(this.#physical, beforeHooks + this.#wall - now);
      this.#live();
      for (const bound of this.#bounds) bound.rearm?.();
      return now;
    } catch {
      this.stop();
      throw new Error("invalid-target-storage-v2");
    } finally {
      if (owned) this.#checking = false;
    }
  }
  guard(anchor = performance.now()): void {
    const beforeHooks = Math.min(anchor, performance.now(), ...this.#anchors);
    valid(Number.isFinite(beforeHooks) && beforeHooks >= 0);
    try {
      this.clock(beforeHooks);
      this.#live();
      this.#authority?.();
      this.#live();
      // Dependent authority can only refuse. The final trusted TIME observation counts its
      // cost, with no recursive authority assertion or new clock epoch after this sample.
      this.clock(beforeHooks);
    } catch {
      this.stop();
      throw new Error("invalid-target-storage-v2");
    }
  }
  bindAuthority(check: () => void, wait?: <T>(work: () => Promise<T>) => Promise<T>): void {
    valid(this.#authority === undefined);
    this.#authority = check;
    this.#authorityWait = wait;
    this.guard();
  }
  restrict(until: number): void {
    integer(until);
    const now = this.clock();
    valid(until > now);
    this.#wall = Math.min(this.#wall, until);
    this.#physical = Math.min(
      this.#physical,
      this.#originPhysical + (until - this.#originWall),
      performance.now() + (until - now),
    );
    this.guard();
  }
  available(): number {
    this.#live();
    const physical = performance.now();
    const n = Math.floor(
      Math.min(
        this.#wall - this.#last,
        this.#physical - physical,
        ...[...this.#bounds].map((bound) => bound.end - physical),
      ),
    );
    valid(n > 0);
    return n;
  }
  remaining(): number {
    this.guard();
    return this.available();
  }
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const bound of this.#bounds) {
      try {
        bound.reject?.();
      } catch {
        /* A failed accepted-I/O cleanup cannot spare another original held scope. */
      }
    }
  }
  capture<T>(work: () => T): T {
    const before = performance.now();
    this.#anchors.push(before);
    let value: T | undefined;
    try {
      this.#live();
      value = work();
      this.guard(before);
      return value;
    } catch (error) {
      drain(value);
      throw error;
    } finally {
      this.#anchors.pop();
    }
  }
  beginHistory(fence: () => void): void {
    valid(this.#historyFence === undefined);
    this.#historyFence = fence;
  }
  /** Synchronous SDK getter/call scope only: failed public reentry cannot be swallowed. */
  hook<T>(work: () => T): T {
    return this.#historyFence ? captureTargetHistoryHook(work, this.#historyFence) : work();
  }
  /** Only terminal history handoff uses this pure barrier after dependent proofs retire.
   * No authority rebinding or native offer is allowed in this final synchronous scope. */
  historyCapture<T>(work: () => T): T {
    const before = performance.now();
    this.#anchors.push(before);
    try {
      this.clock(before);
      const value = work();
      this.clock(before);
      return value;
    } catch {
      this.stop();
      throw new Error("invalid-target-storage-v2");
    } finally {
      this.#anchors.pop();
    }
  }
  /** The idle publication watchdog belongs to this original operation, never a later mint. */
  watch(expire: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound: { end: number; rearm?: () => void; reject?: () => void } = { end: Infinity };
    this.#bounds.add(bound);
    const cancel = () => {
      clearTimeout(timer);
      this.#bounds.delete(bound);
    };
    try {
      this.guard();
      bound.end = this.#physical;
      bound.reject = expire;
      bound.rearm = () => {
        bound.end = Math.min(bound.end, this.#physical);
        clearTimeout(timer);
        const left = bound.end - performance.now();
        if (left <= 0) {
          this.stop();
          throw new Error("invalid-target-storage-v2");
        }
        timer = setTimeout(() => this.stop(), left);
        timer.unref();
      };
      bound.rearm();
      return cancel;
    } catch {
      cancel();
      this.stop();
      throw new Error("invalid-target-storage-v2");
    }
  }
  async wait<T>(work: () => Promise<T>, limit = nativeBudget): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound: { end: number; rearm?: () => void; reject?: () => void } = { end: Infinity };
    this.#bounds.add(bound);
    try {
      bound.end = performance.now() + Math.min(limit, this.remaining());
      let expire: (reason: Error) => void = () => {};
      const timeout = new Promise<never>((_, reject) => {
        expire = reject;
      });
      drain(timeout);
      bound.reject = () => expire(new Error("invalid-target-storage-v2"));
      const arm = () => {
        bound.end = Math.min(bound.end, this.#physical);
        clearTimeout(timer);
        const left = bound.end - performance.now();
        if (left <= 0) {
          this.stop();
          throw new Error("invalid-target-storage-v2");
        }
        timer = setTimeout(() => this.stop(), left);
      };
      bound.rearm = arm;
      arm();
      const pending = new Promise<{ value: T }>((accept, reject) => {
        queueMicrotask(() => {
          let offered: unknown;
          try {
            this.guard();
            const ownedWork = () => this.capture(work);
            offered = this.#authorityWait ? this.#authorityWait(ownedWork) : ownedWork();
            this.guard();
            arm();
            Reflect.apply(nativeThen, offered, [
              (value: T) => {
                try {
                  this.guard();
                  const box = Object.create(null) as { value: T };
                  Object.defineProperty(box, "value", { value, enumerable: true });
                  this.#live();
                  accept(Object.freeze(box));
                } catch {
                  this.stop();
                  reject(new Error("invalid-target-storage-v2"));
                }
              },
              (error: unknown) => {
                try {
                  this.guard();
                  reject(error);
                } catch {
                  this.stop();
                  reject(new Error("invalid-target-storage-v2"));
                }
              },
            ]);
          } catch {
            this.stop();
            drain(offered);
            reject(new Error("invalid-target-storage-v2"));
          }
        });
      });
      const box = await Promise.race([pending, timeout]);
      this.guard();
      this.#live();
      return box.value;
    } catch (error) {
      // Complete NoSuchKey before any bytes remains a guarded absence, not an abandoned
      // read. The owning producer/consumer fences every other failed effect at its boundary.
      this.guard();
      throw error;
    } finally {
      clearTimeout(timer);
      this.#bounds.delete(bound);
    }
  }
}
/** Separate scrypt-derived master and standard HKDF subkeys; every record binds purpose/route. */
class Codec {
  readonly #keys: { content: Buffer; bootstrap: Buffer };
  readonly #context: { target: "staging" | "production"; backend: string };
  constructor(config: TargetContentV2StorageConfiguration, backend: string, op: Operation) {
    op.guard();
    const master = scryptSync(
      config.descriptor_v2_passphrase,
      `tarubot-applied-target-v2:${config.target}:${backend}`,
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    );
    try {
      this.#keys = {
        content: Buffer.from(
          hkdfSync(
            "sha256",
            master,
            Buffer.from(backend),
            Buffer.from("tarubot-applied-target-content-v2"),
            32,
          ),
        ),
        bootstrap: Buffer.from(
          hkdfSync(
            "sha256",
            master,
            Buffer.from(backend),
            Buffer.from("tarubot-applied-target-bootstrap-v2"),
            32,
          ),
        ),
      };
    } finally {
      master.fill(0);
    }
    this.#context = { target: config.target, backend };
    op.guard();
  }
  #aad(kind: "content" | "bootstrap", path: string): Buffer {
    return Buffer.from(
      canonical({ purpose: `tarubot-applied-target-${kind}-v2`, ...this.#context, path }),
    );
  }
  seal(
    kind: "content" | "bootstrap",
    path: string,
    payload: Uint8Array,
    op: Operation,
  ): Uint8Array {
    op.guard();
    const copy = bytes(payload, 1, 65_536),
      nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#keys[kind], nonce);
    cipher.setAAD(this.#aad(kind, path));
    const result = Buffer.concat([
      Buffer.from("TAT2"),
      nonce,
      cipher.update(copy),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    op.guard();
    return bytes(result);
  }
  open(
    kind: "content" | "bootstrap",
    path: string,
    ciphertext: Uint8Array,
    op: Operation,
  ): Uint8Array {
    op.guard();
    const copy = bytes(ciphertext);
    valid(Buffer.from(copy.subarray(0, 4)).toString() === "TAT2");
    const decipher = createDecipheriv("aes-256-gcm", this.#keys[kind], copy.subarray(4, 16));
    decipher.setAAD(this.#aad(kind, path));
    decipher.setAuthTag(copy.subarray(copy.length - 16));
    const result = Buffer.concat([
      decipher.update(copy.subarray(16, copy.length - 16)),
      decipher.final(),
    ]);
    op.guard();
    return bytes(result, 1, 65_536);
  }
}
/**
 * Bun native presigning validates intended routing/credential/session scope, not the final
 * HTTP response URL/status: this API has no redirect control or full response metadata.
 * Pre-byte NoSuchKey therefore also relies on an independently trusted compatible backend.
 * Complete hashes, AEAD and exact reopens attest bytes; retry0 and timeout never undo writes.
 */
class NativeStore implements Metadata {
  readonly target: "staging" | "production";
  readonly namespace: string;
  readonly binding: string;
  readonly #config: TargetContentV2StorageConfiguration;
  readonly #origin: string;
  readonly #file: NativeReader["file"];
  readonly #presign: NativeReader["presign"];
  readonly #write: Bun.S3Client["write"] | undefined;
  constructor(config: TargetContentV2StorageConfiguration, client: NativeClient, writer: boolean) {
    this.#config = config;
    this.target = config.target;
    this.namespace = `tarubot/applied-target/v2/${config.target}/`;
    this.#origin = `https://${config.bucket}.${config.endpoint.slice(8)}`;
    const file = client.file,
      presign = client.presign;
    // Never inspect a consumer's backing write getter, even if its credentials are broader.
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
      purpose: "tarubot-applied-target-storage-v2",
      target: this.target,
      namespace: this.namespace,
      bucket: config.bucket,
      endpoint: this.#origin,
      region: config.region,
      virtualHostedStyle: true,
    });
    Object.freeze(this);
  }
  #key(path: string): string {
    valid(typeof path === "string");
    const match = new RegExp(
      `^applied-target-(?:content-v2/${this.target}/([1-9][0-9]{0,15})/[a-f0-9]{40}/[a-f0-9]{64}|bootstrap-v2/${this.target}/([1-9][0-9]{0,15})/[a-f0-9]{40})$`,
      "u",
    ).exec(path);
    valid(match && Number.isSafeInteger(Number(match[1] ?? match[2])));
    return this.namespace + path;
  }
  #route(key: string): void {
    const raw = this.#presign(key, { method: "GET", expiresIn: 1 });
    valid(typeof raw === "string" && raw.length <= 16_384);
    const url = new URL(raw),
      date = url.searchParams.get("X-Amz-Date");
    valid(typeof date === "string" && /^[0-9]{8}T[0-9]{6}Z$/u.test(date));
    const expected = `${this.#config.credentials.accessKeyId}/${date.slice(0, 8)}/${this.#config.region}/s3/aws4_request`;
    valid(
      url.origin === this.#origin &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname === `/${key}` &&
        url.searchParams.getAll("X-Amz-Credential").length === 1 &&
        url.searchParams.get("X-Amz-Credential") === expected &&
        url.searchParams.getAll("X-Amz-Security-Token").length <= 1 &&
        url.searchParams.get("X-Amz-Security-Token") === this.#config.credentials.sessionToken,
    );
  }
  async read(path: string, op: Operation): Promise<Uint8Array | null> {
    let observed = false;
    let readerOwned: unknown, streamOwned: unknown;
    let released = false;
    try {
      const key = this.#key(path);
      op.guard();
      const beforeRoute = performance.now();
      op.hook(() => this.#route(key));
      // All routing work precedes the LAST guard immediately before the actual SDK offer.
      op.guard(beforeRoute);
      const beforeFile = performance.now();
      const file = op.hook(() => this.#file(key, { retry: 0 }));
      op.guard(beforeFile);
      const beforeStream = performance.now();
      const streamMethod = op.hook(() => file.stream);
      valid(typeof streamMethod === "function");
      const openStream = op.hook(() => streamMethod.bind(file));
      op.guard(beforeStream);
      const beforeOpen = performance.now();
      const stream = op.hook(() => {
        streamOwned = openStream();
        return streamOwned as ReadableStream<Uint8Array>;
      });
      op.guard(beforeOpen);
      const beforeReader = performance.now();
      const readerMethod = op.hook(() => stream.getReader);
      valid(typeof readerMethod === "function");
      const openReader = op.hook(() => readerMethod.bind(stream));
      op.guard(beforeReader);
      const beforeOpenReader = performance.now();
      const reader = op.hook(() => {
        readerOwned = openReader();
        return readerOwned as ReadableStreamDefaultReader<Uint8Array>;
      });
      op.guard(beforeOpenReader);
      const beforeMethods = performance.now();
      const read = op.hook(() => reader.read.bind(reader)),
        cancel = op.hook(() => reader.cancel.bind(reader)),
        release = op.hook(() => reader.releaseLock.bind(reader));
      op.guard(beforeMethods);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const nativeDeadline = performance.now() + nativeBudget;
      try {
        for (;;) {
          const chunk = await op.wait(() => {
            op.guard();
            return op.hook(() => read());
          }, nativeDeadline - performance.now());
          const done = op.capture(() => op.hook(() => chunk.done));
          valid(typeof done === "boolean");
          if (done) break;
          const copy = op.capture(() => {
            const value = op.hook(() => chunk.value);
            valid(value instanceof Uint8Array);
            return bytes(value, 0, maximum - size);
          });
          observed ||= copy.length > 0;
          size += copy.length;
          chunks.push(copy);
          op.guard();
        }
      } catch (error) {
        try {
          drain(op.hook(() => cancel()));
        } catch {
          /* Keep the original denial. */
        }
        throw error;
      } finally {
        try {
          const beforeRelease = performance.now();
          drain(
            op.hook(() => {
              const result = release();
              released = true;
              return result;
            }),
          );
          op.guard(beforeRelease);
        } catch {
          op.stop();
        }
      }
      op.guard();
      valid(size >= 32);
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        nativeSet.call(result, chunk, offset);
        offset += chunk.length;
      }
      op.guard();
      const beforeReopenRoute = performance.now();
      op.hook(() => this.#route(key));
      op.guard(beforeReopenRoute);
      return result;
    } catch (error) {
      const absent = op.capture(() =>
        op.hook(
          () =>
            !observed && error instanceof Error && "code" in error && error.code === "NoSuchKey",
        ),
      );
      if (absent) {
        const key = this.#key(path);
        const beforeRoute = performance.now();
        op.hook(() => this.#route(key));
        op.guard(beforeRoute);
        return null;
      }
      throw new Error("invalid-target-storage-v2");
    } finally {
      if (!released) {
        released = true;
        if (readerOwned !== undefined) {
          try {
            drain(Reflect.apply(nativeReaderCancel, readerOwned, []));
          } catch {
            /* Keep the original refusal. */
          }
          try {
            Reflect.apply(nativeReaderRelease, readerOwned, []);
          } catch {
            /* Unknown cleanup never permits delivery. */
          }
        } else if (streamOwned !== undefined) {
          try {
            drain(Reflect.apply(nativeStreamCancel, streamOwned, []));
          } catch {
            /* Denial-only resource cleanup. */
          }
        }
      }
    }
  }
  async write(path: string, value: Uint8Array, op: Operation): Promise<void> {
    valid(this.#write);
    const key = this.#key(path),
      copy = bytes(value);
    op.guard();
    const beforeRoute = performance.now();
    this.#route(key);
    op.guard(beforeRoute);
    const write = this.#write;
    await op.wait(() => {
      op.guard();
      return write(key, copy, { type: "application/octet-stream", retry: 0 });
    });
    this.#route(key);
    op.guard();
  }
}
interface Captured {
  config: TargetContentV2StorageConfiguration;
  store: NativeStore;
  now: () => number;
}
function capture(
  value: TargetContentV2StorageConfiguration,
  dependencies: Dependencies,
  writer: boolean,
): Captured {
  const c = configuration(value),
    now = dependencies.now ?? Date.now;
  const create =
    dependencies.createClient ?? ((options: Bun.S3Options) => new Bun.S3Client(options));
  valid(typeof now === "function" && typeof create === "function");
  const client = create({
    bucket: c.bucket,
    endpoint: `https://${c.bucket}.${c.endpoint.slice(8)}`,
    region: c.region,
    virtualHostedStyle: true,
    retry: 0,
    ...c.credentials,
    sessionToken: c.credentials.sessionToken ?? "",
  });
  return { config: c, store: new NativeStore(c, client, writer), now };
}
function metadata(c: Captured): Metadata {
  return { target: c.store.target, namespace: c.store.namespace, binding: c.store.binding };
}
function context(c: Captured, release: ReleaseIdentity): TargetIssuanceContext {
  return { target: c.store.target, backend: c.store.binding, release };
}
async function persist(
  store: NativeStore,
  path: string,
  ciphertext: Uint8Array,
  op: Operation,
): Promise<void> {
  valid((await store.read(path, op)) === null);
  await store.write(path, ciphertext, op);
  const reopened = await store.read(path, op);
  valid(reopened && isDeepStrictEqual(reopened, ciphertext));
  op.guard();
}
interface Publication {
  owner: Producer;
  op: Operation;
  codec: Codec;
  receipt: ContentReceiptV2;
  phase: "prepared" | "sealing" | "done";
  cancelDeadline: () => void;
}
const publications = new WeakMap<TargetContentV2Publication, Publication>();
class Producer implements TargetContentV2Producer {
  readonly target: "staging" | "production";
  readonly namespace: string;
  readonly binding: string;
  readonly #c: Captured;
  #busy = false;
  #fenced = false;
  #transition = false;
  constructor(c: Captured) {
    this.#c = c;
    const m = metadata(c);
    this.target = m.target;
    this.namespace = m.namespace;
    this.binding = m.binding;
    Object.freeze(this);
  }
  #deny(): void {
    this.#fenced = true;
  }
  async sealContent(request: {
    envelope: AppliedTargetEnvelope;
    expires_at: number;
  }): Promise<Readonly<{ receipt: ContentReceiptV2; publication: TargetContentV2Publication }>> {
    let op: Operation | undefined,
      owns = false;
    try {
      requireTargetHistoryEntry();
      valid(!this.#busy && !this.#fenced);
      this.#busy = true;
      owns = true;
      op = new Operation(this.#c.now);
      op.bindAuthority(() => valid(!this.#fenced));
      const r = op.capture(() => exact(captureTargetIssuance(request), ["envelope", "expires_at"])),
        envelope = r.envelope as AppliedTargetEnvelope;
      const issued = op.clock(),
        release = releaseIdentity(envelope?.release),
        c = context(this.#c, release);
      const content = targetContentV2(
        {
          schema: 2,
          purpose: "tarubot-applied-target-content-v2",
          target: this.target,
          backend: this.binding,
          release,
          producer: envelope?.verification?.producer,
          mode: envelope?.verification?.mode,
          envelope,
          issued_at: issued,
          expires_at: r.expires_at,
        },
        c,
      );
      valid(content.expires_at > issued);
      op.restrict(content.expires_at);
      const codec = new Codec(this.#c.config, this.binding, op),
        plaintext = targetContentV2Bytes(content),
        payload = targetContentV2Digest(plaintext),
        path = targetContentV2Path(this.target, release, payload);
      const ciphertext = codec.seal("content", path, plaintext, op);
      const receipt = contentReceiptV2(
        {
          schema: 2,
          purpose: content.purpose,
          target: this.target,
          backend: this.binding,
          release,
          producer: content.producer,
          mode: content.mode,
          path,
          payload_digest: payload,
          ciphertext_digest: targetContentV2Digest(ciphertext),
          issued_at: issued,
          expires_at: content.expires_at,
        },
        c,
      );
      await persist(this.#c.store, path, ciphertext, op);
      op.guard();
      const publication = Object.freeze({}) as TargetContentV2Publication;
      const cancelDeadline = op.watch(() => this.#deny());
      publications.set(publication, {
        owner: this,
        op,
        codec,
        receipt,
        phase: "prepared",
        cancelDeadline,
      });
      return Object.freeze({ receipt, publication });
    } catch {
      if (owns) {
        op?.stop();
      }
      // Busy refusal is also a denial: swallowed nested hooks cannot resume the owning call.
      this.#deny();
      throw new Error("invalid-target-storage-v2");
    }
  }
  async sealBootstrap(request: {
    publication: TargetContentV2Publication;
    statement: TargetIssuanceStatementV2;
    jwt: string;
  }): Promise<void> {
    let state: Publication | undefined,
      owns = false;
    try {
      requireTargetHistoryEntry();
      valid(!this.#fenced && this.#busy && !this.#transition);
      this.#transition = true;
      owns = true;
      // Capture the opaque identity separately; ordinary JSON snapshots deliberately cannot copy it.
      valid(request !== null && typeof request === "object");
      const beforeDescriptors = performance.now();
      const descriptors = Object.getOwnPropertyDescriptors(request);
      valid(!this.#fenced && this.#transition);
      valid(
        isDeepStrictEqual(
          Reflect.ownKeys(descriptors).sort(),
          ["publication", "statement", "jwt"].sort(),
        ),
      );
      for (const d of Object.values(descriptors)) valid(d.enumerable && Object.hasOwn(d, "value"));
      state = publications.get(descriptors.publication?.value as TargetContentV2Publication);
      valid(state && state.owner === this && state.phase === "prepared");
      state.phase = "sealing";
      state.op.guard(beforeDescriptors);
      const c = context(this.#c, state.receipt.release),
        bootstrap = state.op.capture(() =>
          targetBootstrapV2(
            {
              schema: 2,
              purpose: "tarubot-applied-target-bootstrap-v2",
              statement: descriptors.statement?.value,
              jwt: descriptors.jwt?.value,
            },
            c,
          ),
        );
      valid(isDeepStrictEqual(bootstrap.statement.content_receipt, state.receipt));
      valid(
        state.op.clock() >= bootstrap.statement.issued_at &&
          state.op.clock() < bootstrap.statement.valid_until,
      );
      state.op.restrict(bootstrap.statement.valid_until);
      const path = targetBootstrapV2Path(this.target, state.receipt.release),
        payload = Buffer.from(canonical(bootstrap));
      const ciphertext = state.codec.seal("bootstrap", path, payload, state.op);
      await persist(this.#c.store, path, ciphertext, state.op);
      state.op.guard();
      state.phase = "done";
      state.cancelDeadline();
      state.op.stop();
      this.#busy = false;
    } catch {
      if (state) {
        state.cancelDeadline();
        state.op.stop();
      }
      this.#deny();
      throw new Error("invalid-target-storage-v2");
    } finally {
      if (owns) this.#transition = false;
    }
  }
}
interface ResultState {
  op: Operation;
  proof: HistoricalTargetIssuanceProof;
  expected: TargetIssuanceContext;
  statement: TargetIssuanceStatementV2;
  checking: boolean;
  phase: "active" | "qualifying" | "retired";
  owner: object;
  content: ReturnType<typeof targetContentV2>;
  receipt: ContentReceiptV2;
  bootstrapPath: string;
  bootstrapBytes: Uint8Array;
  ciphertext: Uint8Array;
}
const results = new WeakMap<AuthenticatedTargetContentV2, ResultState>();
const contentHistories = new WeakMap<
  QualifiedTargetContentHistoryV2,
  {
    history: TargetContentHistoryV2;
    child: QualifiedHistoricalTargetIssuanceData;
    // Complete original ciphertext stays private. No version IDs are synthesized.
    bootstrapBytes: Uint8Array;
    ciphertext: Uint8Array;
    fenced: boolean;
  }
>();
function freezeContentHistory<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeContentHistory(child);
    Object.freeze(value);
  }
  return value;
}
/** Callback-free immutable historical DATA. It supplies no current-job or SSH authority. */
export function inspectQualifiedTargetContentHistoryV2(
  value: QualifiedTargetContentHistoryV2,
): TargetContentHistoryV2 {
  requireTargetHistoryEntry();
  const saved = contentHistories.get(value);
  valid(saved && !saved.fenced);
  inspectQualifiedHistoricalTargetIssuanceData(saved.child);
  return saved.history;
}
export function fenceQualifiedTargetContentHistoryV2(value: QualifiedTargetContentHistoryV2): void {
  requireTargetHistoryEntry();
  const saved = contentHistories.get(value);
  if (saved) {
    saved.fenced = true;
    fenceQualifiedHistoricalTargetIssuanceData(saved.child);
  }
}
/** Only the original native result may reach a later bridge; serialized/copied inspection fails. */
function authenticatedContext(
  value: unknown,
  expected: TargetIssuanceContext,
): { state: ResultState; captured: TargetIssuanceContext } {
  let state: ResultState | undefined,
    owns = false;
  try {
    requireTargetHistoryEntry();
    valid(value !== null && typeof value === "object");
    state = results.get(value as AuthenticatedTargetContentV2);
    valid(state && !state.checking && state.phase === "active");
    state.checking = true;
    owns = true;
    const saved = state;
    const captured = state.op.capture(() =>
      captureTargetHistoryHook(
        () => captureTargetIssuance(expected),
        () => saved.op.stop(),
      ),
    ) as TargetIssuanceContext;
    valid(isDeepStrictEqual(captured, state.expected));
    state.op.guard();
    assertHistoricalTargetIssuanceProof(saved.proof, {
      statement: saved.statement,
      context: saved.expected,
    });
    state.op.guard();
    return { state, captured };
  } catch {
    state?.op.stop();
    throw new Error("invalid-target-storage-v2");
  } finally {
    if (state && owns) state.checking = false;
  }
}
export function assertAuthenticatedTargetContentV2(
  value: unknown,
  expected: TargetIssuanceContext,
): asserts value is AuthenticatedTargetContentV2 {
  authenticatedContext(value, expected);
}
/** Delivery/work is bounded by the SAME original operation and proof; no refresh or new proof. */
export async function withinAuthenticatedTargetContentV2<T>(
  value: AuthenticatedTargetContentV2,
  expected: TargetIssuanceContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    const { state, captured } = authenticatedContext(value, expected);
    const result = await state.op.wait(() => {
      assertAuthenticatedTargetContentV2(value, captured);
      return work();
    }, budget);
    assertAuthenticatedTargetContentV2(value, captured);
    return result;
  } catch {
    results.get(value)?.op.stop();
    throw new Error("invalid-target-storage-v2");
  }
}
class Consumer implements TargetContentV2Consumer {
  readonly target: "staging" | "production";
  readonly namespace: string;
  readonly binding: string;
  readonly #c: Captured;
  readonly #issuance: TargetIssuanceConfiguration;
  readonly #get: GitHubReader | undefined;
  #handoff: ResultState | undefined;
  constructor(c: Captured, issuance: TargetIssuanceConfiguration, get: GitHubReader | undefined) {
    this.#c = c;
    this.#issuance = captureTargetIssuance(issuance) as TargetIssuanceConfiguration;
    this.#get = get;
    const m = metadata(c);
    this.target = m.target;
    this.namespace = m.namespace;
    this.binding = m.binding;
    Object.freeze(this);
  }
  async qualify(
    value: AuthenticatedTargetContentV2,
    release: ReleaseIdentity,
  ): Promise<QualifiedTargetContentHistoryV2> {
    let saved: ResultState | undefined;
    let owns = false;
    let child: QualifiedHistoricalTargetIssuanceData | undefined;
    let result: QualifiedTargetContentHistoryV2 | undefined;
    try {
      requireTargetHistoryEntry();
      if (this.#handoff) {
        this.#handoff.op.stop();
        this.#handoff.phase = "retired";
        throw new Error("invalid-target-storage-v2");
      }
      saved = results.get(value);
      valid(saved && saved.owner === this && !saved.checking && saved.phase === "active");
      saved.checking = true;
      owns = true;
      saved.phase = "qualifying";
      this.#handoff = saved;
      const state = saved;
      const stop = () => {
        state.phase = "retired";
        state.op.stop();
      };
      state.op.beginHistory(stop);
      const expected = state.op.capture(() =>
        captureTargetHistoryHook(
          () => context(this.#c, releaseIdentity(captureTargetIssuance(release))),
          stop,
        ),
      );
      valid(isDeepStrictEqual(expected, state.expected) && state.phase === "qualifying");
      state.op.guard();
      // Reopen the SAME independently resolved paths under the original proof before
      // retirement. Storage is latest-only, with immutable writes/external serialization.
      const bootstrap = await this.#c.store.read(state.bootstrapPath, state.op);
      valid(isDeepStrictEqual(bootstrap, state.bootstrapBytes));
      const content = await this.#c.store.read(state.receipt.path, state.op);
      valid(isDeepStrictEqual(content, state.ciphertext));
      state.op.guard();
      valid(state.phase === "qualifying" && state.checking);
      const base = state.op.capture(() =>
        freezeContentHistory({
          schema: 1 as const,
          purpose: "tarubot-target-content-history-data-v1" as const,
          context: state.expected,
          content: state.content,
          statement: state.statement,
          receipt: state.receipt,
          valid_until: Math.min(state.content.expires_at, state.statement.valid_until),
          storage: {
            binding: this.binding,
            namespace: this.namespace,
            read_policy: "serialized-immutable-latest-object" as const,
          },
          objects: {
            bootstrap: {
              path: state.bootstrapPath,
              size: state.bootstrapBytes.length,
              ciphertext_digest: targetContentV2Digest(state.bootstrapBytes),
              identical_reads: 3 as const,
            },
            content: {
              path: state.receipt.path,
              size: state.ciphertext.length,
              ciphertext_digest: targetContentV2Digest(state.ciphertext),
              identical_reads: 3 as const,
            },
          },
        }),
      );
      // All reads/assertions completed above. From here the original pure operation
      // counts child capture cost, but the retired historical proof is never consulted.
      state.op.historyCapture(() => {
        child = qualifyHistoricalTargetIssuanceProof(state.proof, {
          statement: state.statement,
          context: state.expected,
        });
        return child;
      });
      valid(child);
      const historical = inspectQualifiedHistoricalTargetIssuanceData(child);
      const history = state.op.historyCapture(() => freezeContentHistory({ ...base, historical }));
      valid(state.phase === "qualifying" && state.checking);
      result = Object.freeze({}) as QualifiedTargetContentHistoryV2;
      contentHistories.set(result, {
        history,
        child,
        bootstrapBytes: state.bootstrapBytes,
        ciphertext: state.ciphertext,
        fenced: false,
      });
      return result;
    } catch {
      if (result) fenceQualifiedTargetContentHistoryV2(result);
      if (child) fenceQualifiedHistoricalTargetIssuanceData(child);
      throw new Error("invalid-target-storage-v2");
    } finally {
      if (saved) {
        saved.phase = "retired";
        if (owns) saved.checking = false;
        saved.op.stop();
        retireHistoricalTargetIssuanceProof(saved.proof);
      }
      if (this.#handoff === saved) this.#handoff = undefined;
    }
  }
  async consume(value: ReleaseIdentity): Promise<AuthenticatedTargetContentV2> {
    let op: Operation | undefined;
    try {
      requireTargetHistoryEntry();
      op = new Operation(this.#c.now);
      const operation = op,
        release = op.capture(() => releaseIdentity(captureTargetIssuance(value))),
        c = context(this.#c, release),
        codec = new Codec(this.#c.config, this.binding, op),
        path = targetBootstrapV2Path(this.target, release);
      const bootstrapBytes = await this.#c.store.read(path, op);
      valid(bootstrapBytes);
      const bootstrap = targetBootstrapV2(
        parseTargetContentV2Bytes(codec.open("bootstrap", path, bootstrapBytes, op)),
        c,
      );
      valid(
        op.clock() >= bootstrap.statement.issued_at && op.clock() < bootstrap.statement.valid_until,
      );
      op.restrict(bootstrap.statement.valid_until);
      // The native historical verifier has its own fixed thirty-second observation age.
      // Restrict this SAME earlier operation before invoking it: bootstrap/KDF/capture work
      // is conservatively counted, and its supplied pure clock cannot renew a short proof.
      op.restrict(op.clock() + historicalBudget);
      const verifier = new HistoricalTargetIssuanceVerifier(this.#issuance, {
        ...(this.#get === undefined ? {} : { get: this.#get }),
        now: () => operation.clock(),
      });
      const verify = verifier.verify.bind(verifier);
      const proof = await op.wait(
        () => verify({ statement: bootstrap.statement, context: c, jwt: bootstrap.jwt }),
        budget,
      );
      op.bindAuthority(
        () =>
          assertHistoricalTargetIssuanceProof(proof, {
            statement: bootstrap.statement,
            context: c,
          }),
        (work) =>
          withinHistoricalTargetIssuanceProof(
            proof,
            { statement: bootstrap.statement, context: c },
            work,
          ),
      );
      const receipt = contentReceiptV2(bootstrap.statement.content_receipt, c),
        ciphertext = await this.#c.store.read(receipt.path, op);
      valid(ciphertext);
      valid(targetContentV2Digest(ciphertext) === receipt.ciphertext_digest);
      const plaintext = codec.open("content", receipt.path, ciphertext, op);
      valid(targetContentV2Digest(plaintext) === receipt.payload_digest);
      const content = targetContentV2(parseTargetContentV2Bytes(plaintext), c);
      valid(Buffer.from(targetContentV2Bytes(content)).equals(Buffer.from(plaintext)));
      valid(
        isDeepStrictEqual(
          {
            producer: content.producer,
            mode: content.mode,
            issued_at: content.issued_at,
            expires_at: content.expires_at,
          },
          {
            producer: receipt.producer,
            mode: receipt.mode,
            issued_at: receipt.issued_at,
            expires_at: receipt.expires_at,
          },
        ),
      );
      const reopenedBootstrap = await this.#c.store.read(path, op),
        reopenedContent = await this.#c.store.read(receipt.path, op);
      valid(
        isDeepStrictEqual(reopenedBootstrap, bootstrapBytes) &&
          isDeepStrictEqual(reopenedContent, ciphertext),
      );
      op.guard();
      const result = Object.freeze({
        envelope: content.envelope,
        statement: bootstrap.statement,
      }) as AuthenticatedTargetContentV2;
      results.set(result, {
        op,
        proof,
        expected: c,
        statement: bootstrap.statement,
        checking: false,
        phase: "active",
        owner: this,
        content,
        receipt,
        bootstrapPath: path,
        bootstrapBytes,
        ciphertext,
      });
      assertAuthenticatedTargetContentV2(result, c);
      return result;
    } catch {
      op?.stop();
      throw new Error("invalid-target-storage-v2");
    }
  }
}
export function createTargetContentV2Producer(
  config: TargetContentV2StorageConfiguration,
  dependencies: Dependencies = {},
): TargetContentV2Producer {
  try {
    requireTargetHistoryEntry();
    return new Producer(capture(config, dependencySnapshot(dependencies, false), true));
  } catch {
    throw new Error("invalid-target-storage-v2");
  }
}
/** The real historical verifier is mandatory and constructed internally; no echo/override seam. */
export function createTargetContentV2Consumer(
  config: TargetContentV2StorageConfiguration,
  issuance: TargetIssuanceConfiguration,
  dependencies: Dependencies & { get?: GitHubReader } = {},
): TargetContentV2Consumer {
  try {
    requireTargetHistoryEntry();
    const capturedDependencies = dependencySnapshot(dependencies, true),
      get = capturedDependencies.get;
    valid(get === undefined || typeof get === "function");
    const capturedIssuance = captureTargetIssuance(issuance) as TargetIssuanceConfiguration;
    // Validate immutable issuance configuration at construction without any HTTP.
    new HistoricalTargetIssuanceVerifier(capturedIssuance, {
      ...(get === undefined ? {} : { get }),
    });
    return new Consumer(capture(config, capturedDependencies, false), capturedIssuance, get);
  } catch {
    throw new Error("invalid-target-storage-v2");
  }
}
