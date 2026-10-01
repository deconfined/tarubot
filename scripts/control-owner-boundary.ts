/**
 * Independent current GitHub owner configuration for ordinary control-record consumers.
 * No environment mutation, secret/env lookup, repair, provider, host or state operation.
 * The owner must provision configuration administration and reader credentials separately:
 * reviewer gates do NOT prove who can edit a variable. Normal workflow/S3 writers must have
 * no configuration write permission, and the owner must independently fence active writers.
 * Fresh GETs/readbacks are checks, never a storage lock, CAS or atomic writer fence.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type {
  ControlConsumerBoundary,
  ControlConsumerScope,
  OwnerControlAnchor,
} from "./control-consumer.js";
import {
  ControlRecovery,
  type OwnerRecoveryBoundary,
  type VersionedControlStore,
} from "./control-recovery.js";
import { privateDigest } from "./infra-control.js";
import {
  readTrustRun,
  type GitHubReader,
  type GitHubReadRequest,
  type GitHubReadResponse,
} from "./trust-run.js";

type Value = Record<string, unknown>;
const api = "https://api.github.com";
const prefix = "/repos/deconfined/tarubot";
const variableName = "CONTROL_OWNER_ANCHOR";
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const maxOperation = 60_000;
const maxFreshAge = 30_000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeSet = Uint8Array.prototype.set;
const nativeThen = Promise.prototype.then;
function copyBytes(value: Uint8Array, maximum: number): Uint8Array {
  requireOwner(value instanceof Uint8Array && byteLength !== undefined);
  const length = byteLength.call(value) as number;
  requireOwner(length > 0 && length <= maximum);
  const copy = new Uint8Array(length);
  nativeSet.call(copy, value);
  return copy;
}

/** Future owner-created configuration environments; this module creates/changes none. */
export const controlOwnerEnvironments = Object.freeze({
  infra: "control-infra",
  staging: "control-staging",
  production: "control-production",
});

function requireOwner(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-owner-boundary");
}
function synchronousRefusal(callback: (() => void) | undefined): void {
  requireOwner(callback === undefined || typeof callback === "function");
  const result: unknown = callback?.();
  try {
    // Drain real native promises across realms without reading an arbitrary .then getter.
    void Reflect.apply(nativeThen, result, [undefined, () => {}]);
  } catch {
    // Non-promise returns still refuse; no thenable callback is invoked or awaited.
  }
  requireOwner(result === undefined);
}
function object(value: unknown): Value {
  requireOwner(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireOwner(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  requireOwner(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Bound plain authority snapshots never execute an accessor or retain caller-owned objects. */
function snapshot(input: unknown): unknown {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    requireOwner(++nodes <= 4096 && depth <= 16);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      requireOwner(Number.isFinite(value));
      return value;
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      requireOwner(bytes <= 65_536);
      return value;
    }
    requireOwner(value !== null && typeof value === "object" && !ancestors.has(value));
    ancestors.add(value);
    requireOwner(Object.getOwnPropertySymbols(value).length === 0);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let result: unknown;
    if (Array.isArray(value)) {
      requireOwner(value.length <= 1024 && Object.keys(descriptors).length === value.length + 1);
      result = Array.from({ length: value.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireOwner(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireOwner(
        Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      );
      const output: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireOwner(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireOwner(bytes <= 65_536);
        Object.defineProperty(output, key, {
          value: copy(item.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}
/** Reject duplicate decoded authority keys, including escaped equivalents and nested records. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  let index = 0,
    nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[index] ?? "")) index++;
  };
  const string = () => {
    requireOwner(source[index] === '"');
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("invalid-control-owner-boundary");
  };
  const value = (depth: number): void => {
    requireOwner(++nodes <= 65_536 && depth <= 64);
    whitespace();
    const first = source[index];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      index++;
      whitespace();
      const end = first === "{" ? "}" : "]",
        keys = new Set<string>();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          requireOwner(!keys.has(key));
          keys.add(key);
          whitespace();
          requireOwner(source[index++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[index++];
        if (next === end) return;
        requireOwner(next === ",");
      }
    }
    const start = index;
    while (index < source.length && !/^[,}\] \t\r\n]$/u.test(source[index] ?? "")) index++;
    requireOwner(index > start);
    JSON.parse(source.slice(start, index));
  };
  value(0);
  whitespace();
  requireOwner(index === source.length);
  return JSON.parse(source) as unknown;
}

type WithoutClock<T> = T extends unknown ? Omit<T, "now"> : never;
type RecoveryOptions = WithoutClock<ConstructorParameters<typeof ControlRecovery>[1]>;
export type ControlOwnerBoundaryConfiguration = RecoveryOptions & {
  owner_id: number;
  repository_id: number;
  environment_id: number;
  /** Explicit GET-only credential provisioned by the owner; never the S3 credential. */
  token: string;
};
interface OwnerRecord extends ControlConsumerScope {
  schema: 1;
  revision: string;
  repair:
    | { mode: "never-repaired" }
    | { mode: "repairing"; generation: string }
    | {
        mode: "completed-repair";
        generation: string;
        intent_digest: string;
        commit: string;
        run: string;
      };
}
interface CurrentRecord {
  record: OwnerRecord;
  identity: string;
  observed: number;
  physicalObserved: number;
}
interface Budget {
  stop(): void;
  now(): number;
  capture<T>(work: () => T): T;
  wait<T>(work: () => Promise<T>, whole?: boolean, preserveError?: boolean): Promise<T>;
  remaining(whole?: boolean): number;
  remainingSnapshot(whole?: boolean): Readonly<{ wall: number; remaining: number }>;
}
/** Native journal bridge is factory-private. A copied object or an owner callback cannot mint it. */
export interface NativeOwnerJournalAccess {
  readonly scope: ControlConsumerScope;
  readonly owner: ControlConsumerBoundary;
  now(): number;
  capture<T>(work: () => T): T;
  within<T>(work: () => Promise<T>): Promise<T>;
  /** Denial-only minimum of the SAME original wall/physical window. */
  remaining(): number;
  /** Cached ORIGINAL clock/limits after the last hook; invokes no caller clock or refusal. */
  remainingSnapshot(): Readonly<{ wall: number; remaining: number }>;
  stop(): void;
  beginCheck(refusal?: () => void): () => void;
  finishCheck(): void;
  metadata(path: string, bytes: Uint8Array | null): void;
}
const nativeOwners = new WeakMap<
  object,
  { start(): NativeOwnerJournalAccess; assertEntry(): void; scope: ControlConsumerScope }
>();
export function beginNativeOwnerJournalOperation(owner: object): NativeOwnerJournalAccess {
  const start = nativeOwners.get(owner);
  requireOwner(start !== undefined);
  return start.start();
}
export function isNativeControlOwnerBoundary(owner: object): boolean {
  return nativeOwners.has(owner);
}
/** Denial only: an excluded public method cannot swallow an active native clock/snapshot hook. */
export function assertNativeControlOwnerPublicEntry(owner: object): void {
  const native = nativeOwners.get(owner);
  requireOwner(native !== undefined);
  native.assertEntry();
}
export function matchesNativeControlOwnerBoundary(
  owner: object,
  expected: ControlConsumerScope,
): boolean {
  const native = nativeOwners.get(owner);
  return native !== undefined && isDeepStrictEqual(native.scope, expected);
}

type Hook = <T>(fence: () => void, work: () => T) => T;
function budget(
  clock: () => number,
  refusal: (() => void) | undefined,
  hooks: Hook,
  maximum = maxOperation,
): Budget {
  // Includes the first denial/clock and caller snapshot, rather than starting after them.
  const physicalStarted = performance.now();
  let physicalEnd = physicalStarted + maximum;
  let started: number | undefined,
    last: number | undefined,
    fenced = false,
    checking = false;
  const anchors: number[] = [];
  const ownedHook = <T>(at: number, work: () => T): T => {
    anchors.push(at);
    try {
      return work();
    } finally {
      anchors.pop(); // Synchronous only: never retain this offer anchor across an await.
    }
  };
  const waits = new Set<{
    end: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    timerEnd: number | undefined;
    reject(reason: Error): void;
  }>();
  const fence = () => {
    fenced = true;
    for (const bound of waits) {
      clearTimeout(bound.timer);
      bound.reject(new Error("invalid-control-owner-boundary"));
    }
  };
  const rearm = () => {
    for (const bound of waits) {
      bound.end = Math.min(bound.end, physicalEnd);
      if (fenced || performance.now() >= bound.end) {
        fence();
        return;
      }
      if (bound.timer !== undefined && bound.timerEnd === bound.end) continue;
      clearTimeout(bound.timer);
      bound.timerEnd = bound.end;
      bound.timer = setTimeout(fence, Math.max(0, bound.end - performance.now()));
    }
  };
  const alive = () => requireOwner(!fenced && checking && performance.now() < physicalEnd);
  const sample = () => {
    alive();
    const at: unknown = clock();
    try {
      void Reflect.apply(nativeThen, at, [undefined, () => {}]);
    } catch {}
    integer(at);
    return at;
  };
  const observeNow = (observedPhysical: number) => {
    // Project each shortened wall observation from BEFORE its hooks. A later frozen clock
    // cannot offer the same residual time again after synchronous work consumes it.
    for (const anchor of anchors) observedPhysical = Math.min(observedPhysical, anchor);
    let owns = false;
    try {
      requireOwner(!fenced && !checking && observedPhysical < physicalEnd);
      checking = true;
      owns = true;
      return hooks(fence, () => {
        const observe = (at: number) => {
          if (started === undefined) started = at;
          physicalEnd = Math.min(physicalEnd, observedPhysical + (started + maximum - at));
          requireOwner(
            !fenced &&
              checking &&
              at >= (last ?? started) &&
              at - started < maximum &&
              performance.now() < physicalEnd,
          );
          last = at;
          rearm();
          requireOwner(!fenced);
          return at;
        };
        alive();
        synchronousRefusal(refusal);
        observe(sample());
        alive();
        synchronousRefusal(refusal);
        // Preserve the FIRST epoch, then observe time spent by the last denial hook. No
        // caller callback follows this final sample or can renew its retained projection.
        return observe(sample());
      });
    } catch {
      fence();
      throw new Error("invalid-control-owner-boundary");
    } finally {
      if (owns) checking = false;
    }
  };
  const now = () => observeNow(performance.now());
  const finishCapture = (at: number, captured: unknown) => {
    try {
      observeNow(at);
    } catch (error) {
      // A refused post-hook observation withholds the callback's native Promise too.
      // Drain its rejection intrinsically without reading a caller-controlled then.
      try {
        void Reflect.apply(nativeThen, captured, [undefined, () => {}]);
      } catch {}
      throw error;
    }
  };
  const origin = now();
  const remainingSnapshot = (whole = false) => {
    try {
      requireOwner(!fenced && !checking && last !== undefined);
      const remaining = Math.min(
        whole ? maximum : 10_000,
        maximum - (last - origin),
        physicalEnd - performance.now(),
      );
      requireOwner(remaining > 0);
      return Object.freeze({ wall: last, remaining });
    } catch {
      fence();
      throw new Error("invalid-control-owner-boundary");
    }
  };
  const remaining = (whole = false) => {
    now();
    return remainingSnapshot(whole).remaining;
  };
  return {
    stop: fence,
    now,
    remaining,
    remainingSnapshot,
    capture<T>(work: () => T): T {
      now();
      let owns = false;
      let offeredPhysical: number | undefined;
      let captured: unknown;
      try {
        requireOwner(!fenced && !checking);
        checking = true;
        owns = true;
        offeredPhysical = performance.now();
        const value = ownedHook(offeredPhysical, () => hooks(fence, work));
        captured = value;
        requireOwner(!fenced && checking);
        return value;
      } catch {
        fence();
        throw new Error("invalid-control-owner-boundary");
      } finally {
        if (owns) checking = false;
        // This synchronous hook's cost belongs to its immediate post-hook observation.
        // Its anchor never crosses an await or gets reused by a later continuation.
        finishCapture(offeredPhysical ?? performance.now(), captured);
      }
    },
    async wait<T>(work: () => Promise<T>, whole = false, preserveError = false): Promise<T> {
      const limit = remaining(whole);
      requireOwner(limit > 0);
      const bound = {
        end: Math.min(physicalEnd, performance.now() + limit),
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        timerEnd: undefined as number | undefined,
        reject: (_reason: Error) => {},
      };
      try {
        const schedule = () => {
          bound.end = Math.min(bound.end, performance.now() + remaining(whole));
          rearm();
          requireOwner(!fenced && performance.now() < bound.end);
        };
        const timeout = new Promise<never>((_, reject) => {
          bound.reject = reject;
        });
        void Reflect.apply(nativeThen, timeout, [undefined, () => {}]);
        waits.add(bound);
        schedule();
        const result = await Promise.race([
          Promise.resolve().then(() => {
            requireOwner(performance.now() < bound.end);
            now();
            requireOwner(performance.now() < bound.end);
            const offeredPhysical = performance.now();
            const pending = ownedHook(offeredPhysical, work);
            try {
              observeNow(offeredPhysical);
              schedule();
            } catch (error) {
              try {
                void Reflect.apply(nativeThen, pending, [undefined, () => {}]);
              } catch {}
              throw error;
            }
            return pending;
          }),
          timeout,
        ]);
        // A synchronous fulfillment/copy hook can starve the timer's callback. Its saved
        // deadline still bounds this result and cannot be renewed by another queued wait.
        requireOwner(performance.now() < bound.end);
        now();
        requireOwner(performance.now() < bound.end);
        return result;
      } catch (error) {
        fence();
        if (preserveError) throw error;
        throw new Error("invalid-control-owner-boundary");
      } finally {
        waits.delete(bound);
        clearTimeout(bound.timer);
      }
    },
  };
}

/** Isolated HTTPS, fixed GitHub API origin/repository, no ambient proxy/token or redirects. */
const directGet = (
  input: GitHubReadRequest,
  beforeRead?: () => void,
  capture?: <T>(work: () => T) => T,
): Promise<GitHubReadResponse> =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    if (
      input.method !== "GET" ||
      url.origin !== api ||
      url.username ||
      url.password ||
      url.hash ||
      !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
    ) {
      reject(new Error("invalid-control-owner-boundary"));
      return;
    }
    const agent = new Agent({ keepAlive: false });
    const chunks: Uint8Array[] = [];
    let size = 0,
      finished = false,
      fenced = false,
      checking = false,
      cleaned = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let responseHandle: { destroy(): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        agent.destroy();
      } catch {
        fenced = true;
      }
      if (response && !fenced) accept(response);
      else reject(new Error("invalid-control-owner-boundary"));
    };
    const fail = () => {
      fenced = true;
      finish();
      if (cleaned) return;
      cleaned = true;
      // Accepted I/O cleanup can occur after refusal, but cannot resume or approve a read.
      try {
        responseHandle?.destroy();
      } catch {}
      try {
        request?.destroy();
      } catch {}
    };
    const guard = () => {
      let owns = false;
      try {
        requireOwner(!finished && !fenced && !checking);
        checking = true;
        owns = true;
        synchronousRefusal(beforeRead);
        requireOwner(!finished && !fenced && checking);
      } catch {
        fenced = true;
        throw new Error("invalid-control-owner-boundary");
      } finally {
        if (owns) checking = false;
      }
    };
    const prepare = <T>(work: () => T): T => {
      guard();
      const value = capture ? capture(work) : work();
      guard();
      return value;
    };
    const options = {
      protocol: "https:",
      hostname: "api.github.com",
      servername: "api.github.com",
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: input.headers,
      agent,
      rejectUnauthorized: true,
      maxHeaderSize: maxHeaders,
    };
    try {
      guard();
    } catch {
      fail();
      return;
    }
    try {
      request = httpsRequest(options, (response) => {
        responseHandle = response;
        try {
          prepare(() => {
            response.on("error", fail);
            response.on("aborted", fail);
            response.on("data", (chunk: Buffer) => {
              try {
                prepare(() => {
                  const bytes = copyBytes(chunk, maxBody);
                  size += bytes.length;
                  requireOwner(size <= input.body_limit);
                  chunks.push(bytes);
                });
              } catch {
                fail();
              }
            });
            response.on("end", () => {
              try {
                const result = prepare(() => {
                  requireOwner(response.complete);
                  const rawHeaders = response.rawHeaders;
                  const headers: Record<string, string> = Object.create(null);
                  for (let index = 0; index < rawHeaders.length; index += 2) {
                    const name = rawHeaders[index]?.toLowerCase(),
                      value = rawHeaders[index + 1];
                    requireOwner(name !== undefined && value !== undefined);
                    headers[name] = Object.hasOwn(headers, name)
                      ? `${headers[name]},${value}`
                      : value;
                  }
                  return {
                    status: response.statusCode ?? 0,
                    url: input.url,
                    headers,
                    body: Buffer.concat(chunks),
                  };
                });
                guard();
                finish(result);
              } catch {
                fail();
              }
            });
          });
        } catch {
          fail();
        }
      });
      request.on("error", fail);
      const end = prepare(() => {
        const method = request?.end;
        requireOwner(typeof method === "function");
        return Function.prototype.bind.call(method, request) as () => void;
      });
      timer = setTimeout(fail, input.timeout_ms);
      guard();
      end();
    } catch {
      fail();
    }
  });

/** Read-only implementation of current ControlConsumerBoundary; no raw/key/restore capability. */
export class GitHubControlOwnerBoundary implements ControlConsumerBoundary {
  readonly #configuration: ControlOwnerBoundaryConfiguration;
  readonly #scope: ControlConsumerScope;
  readonly #rawRead: VersionedControlStore["read"];
  readonly #get: GitHubReader;
  readonly #clock: () => number;
  readonly #native: boolean;
  readonly #revisions = new Map<string, string>();
  #lastRevision: string | undefined;
  #hook: { fence(): void } | undefined;
  #journalHook: { fence(): void } | undefined;
  constructor(
    configuration: ControlOwnerBoundaryConfiguration,
    dependencies: {
      store: VersionedControlStore;
      get?: GitHubReader;
      now?: () => number;
    },
  ) {
    try {
      const c = object(snapshot(configuration));
      requireOwner(c.target === "infra" || c.target === "staging" || c.target === "production");
      exact(
        c,
        c.target === "infra"
          ? [
              "target",
              "backend",
              "namespace",
              "passphrase",
              "owner_id",
              "repository_id",
              "environment_id",
              "token",
            ]
          : [
              "target",
              "backend",
              "namespace",
              "passphrase",
              "validator",
              "owner_id",
              "repository_id",
              "environment_id",
              "token",
            ],
      );
      for (const field of ["owner_id", "repository_id", "environment_id"]) integer(c[field]);
      requireOwner(
        typeof c.backend === "string" &&
          sha.test(c.backend) &&
          typeof c.passphrase === "string" &&
          c.passphrase.length >= 32 &&
          typeof c.token === "string" &&
          /^[A-Za-z0-9._-]{20,2048}$/u.test(c.token),
      );
      const namespace = `tarubot/control/v1/${c.target === "infra" ? "infra" : `trust-${c.target}`}/`;
      requireOwner(c.namespace === namespace);
      if (c.target !== "infra") {
        const pin = exact(c.validator, [
          "name",
          "version",
          "mode",
          "binary_sha256",
          "anchor_sha256",
          "runtime_manifest_sha256",
        ]);
        requireOwner(
          pin.name === "unbound" && pin.version === "1.26.1" && pin.mode === "local-validating",
        );
        for (const field of ["binary_sha256", "anchor_sha256", "runtime_manifest_sha256"])
          requireOwner(typeof pin[field] === "string" && sha.test(pin[field]));
      }
      const store = dependencies.store,
        read = store.read,
        readVersion = store.readVersion;
      const capturedGet = dependencies.get,
        get = capturedGet ?? directGet,
        clock = dependencies.now ?? Date.now;
      requireOwner(
        typeof read === "function" &&
          typeof readVersion === "function" &&
          typeof get === "function" &&
          typeof clock === "function",
      );
      this.#configuration = c as unknown as ControlOwnerBoundaryConfiguration;
      this.#scope = { target: c.target, backend: c.backend, namespace } as ControlConsumerScope;
      this.#rawRead = read.bind(store);
      this.#get = get;
      this.#native = capturedGet === undefined;
      this.#clock = clock;
      nativeOwners.set(this, {
        start: () => this.#journalOperation(),
        assertEntry: () => this.#publicEntry(),
        scope: this.#scope,
      });
      Object.freeze(this);
    } catch {
      throw new Error("invalid-control-owner-boundary");
    }
  }
  #hooks<T>(fence: () => void, work: () => T): T {
    if (this.#hook) {
      this.#hook.fence();
      fence();
      throw new Error("invalid-control-owner-boundary");
    }
    const reservation = { fence };
    this.#hook = reservation;
    try {
      return work();
    } finally {
      if (this.#hook === reservation) this.#hook = undefined;
    }
  }
  #operation(refusal?: () => void, maximum = maxOperation): Budget {
    this.#publicEntry();
    return budget(this.#clock, refusal, (fence, work) => this.#hooks(fence, work), maximum);
  }
  #publicEntry(): void {
    if (this.#journalHook) {
      this.#journalHook.fence();
      throw new Error("invalid-control-owner-boundary");
    }
    if (this.#hook) {
      this.#hook.fence();
      throw new Error("invalid-control-owner-boundary");
    }
  }

  #journalOperation(): NativeOwnerJournalAccess {
    const operation = this.#operation(undefined, maxFreshAge);
    let original: unknown[] | undefined;
    let current: unknown[] = [];
    let phase: "idle" | "checking" = "idle";
    let checkBudget = operation;
    let checkIdentity: object | undefined;
    const fail = () => operation.stop();
    const refuse = (refusal: (() => void) | undefined) => {
      if (this.#journalHook) {
        this.#journalHook.fence();
        fail();
        throw new Error("invalid-control-owner-boundary");
      }
      const reservation = { fence: fail };
      this.#journalHook = reservation;
      try {
        // The internal consumer callback may read this same pure clock. A separate entry
        // reservation fences nested public operations without recursively asserting a proof.
        synchronousRefusal(refusal);
        operation.now();
        synchronousRefusal(refusal);
        requireOwner(phase === "checking");
      } catch {
        fail();
        throw new Error("invalid-control-owner-boundary");
      } finally {
        if (this.#journalHook === reservation) this.#journalHook = undefined;
      }
    };
    const beginCheck = (denial?: () => void) => {
      try {
        requireOwner(phase === "idle");
        operation.now();
        phase = "checking";
        current = [];
        const identity = {};
        checkIdentity = identity;
        const check = () => {
          try {
            requireOwner(phase === "checking" && checkIdentity === identity);
            refuse(denial);
            operation.now();
          } catch {
            fail();
            throw new Error("invalid-control-owner-boundary");
          }
        };
        // Supplement this checkpoint with its immutable incoming refusal. The ORIGINAL
        // authority budget/proof stays unchanged; a later check cannot rebind old callbacks.
        checkBudget = {
          stop: operation.stop,
          now: () => {
            check();
            return operation.now();
          },
          remaining: (whole) => {
            check();
            return operation.remaining(whole);
          },
          remainingSnapshot: operation.remainingSnapshot,
          capture: <T>(work: () => T) => {
            check();
            const value = operation.capture(work);
            check();
            return value;
          },
          wait: <T>(work: () => Promise<T>, whole?: boolean) =>
            operation.wait(async () => {
              check();
              const pending = work();
              try {
                check();
              } catch (error) {
                try {
                  void Reflect.apply(nativeThen, pending, [undefined, () => {}]);
                } catch {}
                throw error;
              }
              const value = await pending;
              check();
              return value;
            }, whole),
        };
        check();
        return check;
      } catch {
        fail();
        throw new Error("invalid-control-owner-boundary");
      }
    };
    const finishCheck = () => {
      try {
        requireOwner(phase === "checking");
        operation.now();
        if (original === undefined) original = current;
        else requireOwner(isDeepStrictEqual(original, current));
        phase = "idle";
        checkIdentity = undefined;
        operation.now();
      } catch {
        fail();
        throw new Error("invalid-control-owner-boundary");
      }
    };
    return Object.freeze({
      scope: Object.freeze({ ...this.#scope }),
      now: operation.now,
      capture: operation.capture,
      within: <T>(work: () => Promise<T>) => operation.wait(work, true, true),
      remaining: () => operation.remaining(true),
      remainingSnapshot: () => operation.remainingSnapshot(true),
      stop: fail,
      beginCheck,
      finishCheck,
      // Only native private helpers can supply authority; no caller JSON/parser callback enters.
      owner: Object.freeze({
        readOwnerAnchor: async (input: ControlConsumerScope, refusal?: () => void) => {
          refuse(refusal);
          requireOwner(phase === "checking");
          return this.#anchor(input, checkBudget, current);
        },
        confirmCompletedRepair: async (
          input: ControlConsumerScope & { generation: string },
          refusal?: () => void,
        ) => {
          refuse(refusal);
          requireOwner(phase === "checking");
          return this.#repair(input, checkBudget, current);
        },
      }),
      metadata: (path: string, bytes: Uint8Array | null) => {
        operation.capture(() => {
          requireOwner(phase === "checking");
          current.push({ path, bytes: bytes === null ? null : copyBytes(bytes, 64 * 1024 * 1024) });
        });
      },
    });
  }

  #scopeRequest(input: unknown, completed: boolean): void {
    const request = exact(
      snapshot(input),
      completed
        ? ["target", "backend", "namespace", "generation"]
        : ["target", "backend", "namespace"],
    );
    requireOwner(
      isDeepStrictEqual(
        { target: request.target, backend: request.backend, namespace: request.namespace },
        this.#scope,
      ),
    );
    if (completed)
      requireOwner(typeof request.generation === "string" && uuid.test(request.generation));
  }
  #headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      "User-Agent": "TaruBot-control-owner-boundary",
      Authorization: `Bearer ${this.#configuration.token}`,
    };
  }
  async #response(
    input: GitHubReadRequest,
    operation: Budget,
  ): Promise<{ response: GitHubReadResponse; value: unknown }> {
    requireOwner(
      input.method === "GET" &&
        input.redirect === "error" &&
        input.body_limit === maxBody &&
        input.url.startsWith(`${api}${prefix}`),
    );
    const response = await operation.wait(() => {
      const captured = {
        ...input,
        headers: { ...input.headers },
        timeout_ms: Math.min(input.timeout_ms, operation.remaining()),
      };
      operation.now();
      return this.#native
        ? directGet(
            captured,
            () => {
              operation.now();
            },
            (work) => operation.capture(work),
          )
        : this.#get(captured);
    });
    return operation.capture(() => {
      const body = response.body;
      requireOwner(
        response.status === 200 && response.url === input.url && body instanceof Uint8Array,
      );
      const h: Record<string, string> = Object.create(null);
      let size = 0;
      for (const [name, value] of Object.entries(object(response.headers))) {
        const lower = name.toLowerCase();
        requireOwner(
          /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
            typeof value === "string" &&
            !/[\r\n\0]/u.test(value) &&
            !Object.hasOwn(h, lower),
        );
        size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        requireOwner(size <= maxHeaders);
        h[lower] = value;
      }
      requireOwner(
        typeof h["content-type"] === "string" &&
          /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
            h["content-type"],
          ),
      );
      for (const name of ["location", "link", "content-range"])
        requireOwner(!Object.hasOwn(h, name));
      requireOwner(
        (h["content-encoding"] === undefined || h["content-encoding"] === "identity") &&
          (h.age === undefined || h.age === "0"),
      );
      if (h["content-length"] !== undefined)
        requireOwner(
          /^(0|[1-9][0-9]*)$/u.test(h["content-length"]) &&
            Number(h["content-length"]) === byteLength?.call(body),
        );
      const bytes = copyBytes(body, maxBody);
      const value = json(bytes);
      return { value, response: { status: 200, url: input.url, headers: { ...h }, body: bytes } };
    });
  }
  async #read(path: string, operation: Budget): Promise<unknown> {
    return (
      await this.#response(
        {
          url: `${api}${prefix}${path}`,
          method: "GET",
          headers: this.#headers(),
          timeout_ms: operation.remaining(),
          body_limit: maxBody,
          redirect: "error",
        },
        operation,
      )
    ).value;
  }
  #record(value: unknown): OwnerRecord {
    const record = exact(value, ["schema", "target", "backend", "namespace", "revision", "repair"]);
    requireOwner(
      record.schema === 1 &&
        typeof record.revision === "string" &&
        uuid.test(record.revision) &&
        isDeepStrictEqual(
          { target: record.target, backend: record.backend, namespace: record.namespace },
          this.#scope,
        ),
    );
    const repair = object(record.repair);
    if (repair.mode === "never-repaired") exact(repair, ["mode"]);
    else {
      requireOwner(repair.mode === "repairing" || repair.mode === "completed-repair");
      exact(
        repair,
        repair.mode === "repairing"
          ? ["mode", "generation"]
          : ["mode", "generation", "intent_digest", "commit", "run"],
      );
      requireOwner(typeof repair.generation === "string" && uuid.test(repair.generation));
      if (repair.mode === "completed-repair")
        requireOwner(
          typeof repair.intent_digest === "string" &&
            sha.test(repair.intent_digest) &&
            typeof repair.commit === "string" &&
            /^[a-f0-9]{40}$/u.test(repair.commit) &&
            typeof repair.run === "string" &&
            /^[1-9][0-9]{0,19}$/u.test(repair.run),
        );
    }
    return record as unknown as OwnerRecord;
  }
  async #current(operation: Budget, evidence?: unknown[]): Promise<CurrentRecord> {
    // Include the first request's whole transport time; a slow repository response must not
    // mint a younger anchor after it arrives, including when an injected wall clock stands still.
    const observed = operation.now(),
      physicalObserved = performance.now();
    const repo = object(await this.#read("", operation));
    const owner = object(repo.owner);
    requireOwner(
      repo.id === this.#configuration.repository_id &&
        repo.full_name === "deconfined/tarubot" &&
        repo.fork === false &&
        owner.login === "deconfined" &&
        owner.id === this.#configuration.owner_id,
    );
    const name = controlOwnerEnvironments[this.#scope.target];
    const environment = object(await this.#read(`/environments/${name}`, operation));
    requireOwner(
      environment.id === this.#configuration.environment_id &&
        environment.name === name &&
        environment.url === `${api}${prefix}/environments/${name}`,
    );
    const variable = exact(
      await this.#read(`/environments/${name}/variables/${variableName}`, operation),
      ["name", "value", "created_at", "updated_at"],
    );
    requireOwner(
      variable.name === variableName &&
        typeof variable.value === "string" &&
        Buffer.byteLength(variable.value) <= 16_384,
    );
    const date = (value: unknown) => {
      requireOwner(
        typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value),
      );
      const result = Date.parse(value);
      requireOwner(Number.isFinite(result) && result > 0 && result <= operation.now());
      return result;
    };
    requireOwner(date(variable.updated_at) >= date(variable.created_at));
    const record = this.#record(json(Buffer.from(variable.value)));
    const identity = privateDigest({
      record,
      variable,
      repository_id: repo.id,
      owner_id: owner.id,
      environment: { id: environment.id, name: environment.name, url: environment.url },
    });
    const prior = this.#revisions.get(record.revision);
    requireOwner(prior === undefined || prior === identity);
    // Track contradictions only, never cached authority. Every successful operation still GETs.
    requireOwner(
      this.#lastRevision === undefined ||
        this.#lastRevision === record.revision ||
        prior === undefined,
    );
    requireOwner(prior !== undefined || this.#revisions.size < 128);
    this.#fresh({ record, identity, observed, physicalObserved }, operation);
    this.#revisions.set(record.revision, identity);
    this.#lastRevision = record.revision;
    evidence?.push({ owner_identity: identity, record });
    return { record, identity, observed, physicalObserved };
  }
  #fresh(record: CurrentRecord, operation: Budget): void {
    requireOwner(
      operation.now() - record.observed < maxFreshAge &&
        performance.now() - record.physicalObserved < maxFreshAge,
    );
  }
  #same(before: CurrentRecord, after: CurrentRecord, operation: Budget): void {
    this.#fresh(before, operation);
    this.#fresh(after, operation);
    requireOwner(before.identity === after.identity);
  }

  /** Current authority comes from two whole independent GET rounds, never missing objects/cache. */
  async readOwnerAnchor(
    input: ControlConsumerScope,
    refusal?: () => void,
  ): Promise<OwnerControlAnchor> {
    let operation: Budget | undefined;
    try {
      operation = this.#operation(refusal);
      return await this.#anchor(input, operation);
    } catch {
      operation?.stop();
      throw new Error("invalid-control-owner-boundary");
    }
  }
  async #anchor(
    input: ControlConsumerScope,
    operation: Budget,
    evidence?: unknown[],
  ): Promise<OwnerControlAnchor> {
    operation.capture(() => this.#scopeRequest(input, false));
    const first = await this.#current(operation, evidence),
      final = await this.#current(operation, evidence);
    this.#same(first, final, operation);
    const r = final.record;
    const repair =
      r.repair.mode === "never-repaired"
        ? { mode: "never-repaired" as const }
        : { mode: r.repair.mode, generation: r.repair.generation };
    const remaining = Math.floor(maxFreshAge - (performance.now() - first.physicalObserved));
    requireOwner(remaining > 0);
    return freeze({
      ...this.#scope,
      schema: 1,
      revision: r.revision,
      repair,
      observed_at: first.observed,
      expires_at: Math.min(first.observed + maxFreshAge, operation.now() + remaining),
    });
  }

  /** Restore-only capabilities refuse; only completed encrypted metadata and final run are read. */
  async confirmCompletedRepair(
    input: ControlConsumerScope & { generation: string },
    refusal?: () => void,
  ): Promise<void> {
    let operation: Budget | undefined;
    try {
      operation = this.#operation(refusal);
      await this.#repair(input, operation);
    } catch {
      operation?.stop();
      throw new Error("invalid-control-owner-boundary");
    }
  }
  async #repair(
    input: ControlConsumerScope & { generation: string },
    operation: Budget,
    evidence?: unknown[],
  ): Promise<void> {
    const request = operation.capture(() => snapshot(input)) as ControlConsumerScope & {
      generation: string;
    };
    operation.capture(() => this.#scopeRequest(request, true));
    const first = await this.#current(operation, evidence);
    requireOwner(
      first.record.repair.mode === "completed-repair" &&
        first.record.repair.generation === request.generation,
    );
    const expected = first.record.repair;
    const denied = async (): Promise<never> => {
      throw new Error("invalid-control-owner-boundary");
    };
    const owner: OwnerRecoveryBoundary = {
      assertOwnerFence: denied,
      verifyOutcome: denied,
      confirmEnrollmentRun: denied,
      confirmRecoveryRun: async (runRequest) => {
        const current = await this.#current(operation, evidence);
        this.#same(first, current, operation);
        requireOwner(
          isDeepStrictEqual(runRequest, {
            target: this.#scope.target,
            backend: this.#scope.backend,
            generation: expected.generation,
            binding_digest: expected.intent_digest,
            run: { commit: expected.commit, run: expected.run },
          }),
        );
        const gate = `recover-${this.#scope.target}`;
        const allowed = new Set(
          [
            `/actions/runs/${expected.run}`,
            `/actions/runs/${expected.run}/attempts/1/jobs?per_page=100&page=1`,
            `/actions/runs/${expected.run}/approvals`,
            `/environments/${gate}`,
            `/environments/${gate}/deployment-branch-policies?per_page=100&page=1`,
            "/branches/main",
          ].map((path) => `${api}${prefix}${path}`),
        );
        const proof = await operation.wait(
          () =>
            readTrustRun(
              {
                kind: "recovery",
                target: this.#scope.target,
                commit: expected.commit,
                run: expected.run,
              },
              {
                owner_id: this.#configuration.owner_id,
                token: this.#configuration.token,
                now: () => operation.now(),
                get: async (readRequest) => {
                  requireOwner(allowed.has(readRequest.url));
                  const result = await this.#response(readRequest, operation);
                  evidence?.push({ repair_read: readRequest.url, value: result.value });
                  if (readRequest.url === `${api}${prefix}/actions/runs/${expected.run}`) {
                    const run = object(result.value);
                    requireOwner(
                      object(run.repository).id === this.#configuration.repository_id &&
                        object(run.head_repository).id === this.#configuration.repository_id,
                    );
                  }
                  return result.response;
                },
              },
            ),
          true,
        );
        // Actual parser result stays private, with its original observation held by this window.
        evidence?.push({ repair_run: { ...proof, observed_at: undefined, expires_at: undefined } });
        integer(proof.observed_at);
        requireOwner(
          proof.observed_at <= operation.now() && operation.now() - proof.observed_at < maxFreshAge,
        );
        const final = await this.#current(operation, evidence);
        this.#same(first, final, operation);
        return {
          schema: 1,
          target: this.#scope.target,
          backend: this.#scope.backend,
          generation: expected.generation,
          binding_digest: expected.intent_digest,
          commit: expected.commit,
          run: expected.run,
          attempt: 1,
          conclusion: "success",
        };
      },
    };
    const id = uuid.source.slice(1, -1);
    const metadata = new RegExp(
      `^recovery/${this.#scope.target}/(?:registration|current|(?:intents|completed)/${id})$`,
      "u",
    );
    const store: VersionedControlStore = {
      read: async (path, beforeRead) => {
        requireOwner(metadata.test(path));
        // Every recursive recovery metadata read uses this ORIGINAL owner operation.
        // No consumer check/GET is performed inside a stream checkpoint.
        const fence = () => {
          synchronousRefusal(beforeRead);
          operation.now();
          synchronousRefusal(beforeRead);
        };
        const value = await operation.wait(() => this.#rawRead(path, fence));
        return operation.capture(() => {
          const bytes = value === null ? null : copyBytes(value, 64 * 1024 * 1024);
          evidence?.push({ path, bytes });
          return bytes;
        });
      },
      write: denied,
      readVersion: denied,
    };
    // Historical codec binding is the exact configured backend identity, not physical routing.
    const {
      owner_id: _owner,
      repository_id: _repository,
      environment_id: _environment,
      token: _token,
      ...options
    } = this.#configuration;
    const recovery = new ControlRecovery(store, { ...options, now: () => operation.now() }, owner);
    await operation.wait(() => recovery.guardConsumer(expected.generation), true);
    const final = await this.#current(operation, evidence);
    this.#same(first, final, operation);
  }
}

/**
 * Primary GET contracts (API2026-03-10), with separate Environments:read provisioning:
 * https://docs.github.com/en/rest/actions/variables#get-an-environment-variable
 * https://docs.github.com/en/rest/deployments/environments#get-an-environment
 * https://docs.github.com/en/rest/repos/repos#get-a-repository
 * The variable API returns current value/timestamps, not editor identity or dispatch inputs.
 */
