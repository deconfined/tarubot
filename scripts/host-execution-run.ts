/** READ-ONLY current Host phase observations for an explicitly FUTURE protected graph.
 * This proves neither evaluated reusable inputs/event bytes nor controller/command authority.
 * Reading a staging gate does NOT prove that the selected job used that environment.
 * Version/digest/schema in the expected release remain caller assertions, not API facts.
 * No OIDC, grant, key or environment-secret lookup, SSH or workflow mutation occurs here. */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, types } from "node:util";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import type { GitHubReadRequest, GitHubReadResponse, GitHubReader } from "./trust-run.js";
type Value = Record<string, unknown>;
const repository = "deconfined/tarubot";
const api = "https://api.github.com";
const prefix = `/repos/${repository}`;
const maxBody = 1_048_576;
const nativeThen = Promise.prototype.then;
const nativeSet = Uint8Array.prototype.set;
const nativeLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)?.get;
valid(nativeLength && nativeBuffer);
/** Intrinsic typed-array copies never execute an iterator or trust shadowed byte lengths. */
function copyBytes(value: unknown, limit: number, check: () => void): Uint8Array {
  check();
  valid(types.isUint8Array(value));
  valid(!types.isSharedArrayBuffer(Reflect.apply(nativeBuffer as () => ArrayBuffer, value, [])));
  const length: unknown = Reflect.apply(nativeLength as () => number, value, []);
  valid(typeof length === "number" && length <= limit);
  check();
  const result = new Uint8Array(length);
  Reflect.apply(nativeSet, result, [value]);
  check();
  valid(Reflect.apply(nativeLength as () => number, value, []) === length);
  return result;
}

// Applying the captured intrinsic drains even cross-realm native promises without reading
// a caller's then property. A refused promise never becomes an approval or a fresh clock.
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Ordinary values and thenables still fail the synchronous contract. */
  }
}

function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-current-host-phase");
}
function object(value: unknown): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  valid(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function list(value: unknown): unknown[] {
  valid(Array.isArray(value));
  return value;
}
function identifier(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function ownerIdentity(value: unknown, ownerId: number): void {
  const user = object(value);
  valid(user.login === "deconfined" && user.id === ownerId);
}

function snapshot(value: unknown, check: () => void = () => {}): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    check();
    valid(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      valid(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      valid(bytes <= 65_536);
      return input;
    }
    valid(input !== null && typeof input === "object" && !ancestors.has(input));
    const keys = Reflect.ownKeys(input);
    check();
    valid(keys.length <= 1025 && keys.every((key) => typeof key === "string"));
    ancestors.add(input);
    const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
    for (const key of keys) {
      check();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      check();
      valid(descriptor !== undefined);
      Object.defineProperty(descriptors, key, { value: descriptor, enumerable: true });
    }
    let result: unknown;
    if (Array.isArray(input)) {
      const length: unknown = descriptors.length?.value;
      valid(
        typeof length === "number" &&
          Number.isInteger(length) &&
          length >= 0 &&
          length <= 1024 &&
          Object.keys(descriptors).length === length + 1,
      );
      result = Array.from({ length }, (_, index) => {
        const item = descriptors[String(index)];
        valid(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      check();
      valid(prototype === Object.prototype || prototype === null);
      const data: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        valid(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        valid(bytes <= 65_536);
        Object.defineProperty(data, key, { value: copy(item.value, depth + 1), enumerable: true });
      }
      result = data;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
/** Complete bounded UTF-8 JSON; duplicate decoded keys never silently replace evidence. */
function json(bytes: Uint8Array, check: () => void): unknown {
  check();
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[at] ?? "")) at++;
  };
  const string = () => {
    valid(source[at] === '"');
    const start = at++;
    while (at < source.length) {
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
      if (source[at - 1] === "\\") at++;
    }
    throw new Error("invalid-current-host-phase");
  };
  const value = (depth: number): void => {
    check();
    valid(++nodes <= 65_536 && depth <= 32);
    whitespace();
    const first = source[at];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      at++;
      whitespace();
      const end = first === "{" ? "}" : "]",
        keys = new Set<string>();
      if (source[at] === end) {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          valid(!keys.has(key));
          keys.add(key);
          whitespace();
          valid(source[at++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[at++];
        if (next === end) return;
        valid(next === ",");
      }
    }
    const start = at;
    while (at < source.length && !/^[,}\] \t\r\n]$/u.test(source[at] ?? "")) at++;
    valid(at > start);
    const result = JSON.parse(source.slice(start, at)) as unknown;
    valid(typeof result !== "number" || Number.isFinite(result));
  };
  value(0);
  whitespace();
  valid(at === source.length);
  check();
  const result = JSON.parse(source) as unknown;
  check();
  return result;
}

/** Explicit direct HTTPS agent; the original operation guards each actual native offer. */
function directGet(
  input: GitHubReadRequest,
  check: () => void,
  capture: <T>(work: () => T) => T,
  remaining: () => number,
): Promise<GitHubReadResponse> {
  return new Promise((accept, reject) => {
    let agent: Agent | undefined;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: unknown, value?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error !== undefined) {
        request?.destroy();
        response?.destroy();
      }
      agent?.destroy();
      if (error !== undefined) reject(new Error("invalid-current-host-phase"));
      else if (value) accept(value);
    };
    const guarded = (work: () => void) => {
      if (finished) return;
      try {
        check();
        capture(work);
        check();
      } catch (error) {
        finish(error);
      }
    };
    try {
      check();
      const url = new URL(input.url);
      valid(
        url.origin === api &&
          url.username === "" &&
          url.password === "" &&
          url.hash === "" &&
          (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) &&
          input.method === "GET",
      );
      agent = new Agent({ keepAlive: false });
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
        maxHeaderSize: 16 * 1024,
      };
      // Route, headers and Agent preparation cannot move the original authorization barrier.
      check();
      request = httpsRequest(options, (incoming) => {
        response = incoming;
        if (finished) {
          incoming.destroy();
          return;
        }
        guarded(() => {
          const on = incoming.on.bind(incoming);
          check();
          on("error", () => finish(new Error("invalid-current-host-phase")));
          check();
          on("aborted", () => finish(new Error("invalid-current-host-phase")));
          check();
          on("data", (chunk: Buffer) =>
            guarded(() => {
              const bytes = copyBytes(chunk, input.body_limit - size, check);
              size += bytes.byteLength;
              check();
              chunks.push(Buffer.from(bytes));
            }),
          );
          check();
          on("end", () =>
            guarded(() => {
              const complete = incoming.complete;
              check();
              valid(complete);
              const headers: Record<string, string> = {};
              check();
              const raw = list(snapshot(incoming.rawHeaders, check));
              check();
              valid(raw.length % 2 === 0 && raw.length <= 256);
              let bytes = 0;
              for (let i = 0; i < raw.length; i += 2) {
                check();
                const key = raw[i],
                  value = raw[i + 1];
                valid(typeof key === "string");
                const name = key.toLowerCase();
                valid(
                  typeof name === "string" &&
                    typeof value === "string" &&
                    !Object.hasOwn(headers, name),
                );
                bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
                valid(bytes <= 16_384);
                Object.defineProperty(headers, name, { value, enumerable: true });
              }
              check();
              const body = Buffer.concat(chunks);
              check();
              const status = incoming.statusCode ?? 0;
              check();
              finish(undefined, {
                status,
                url: input.url,
                headers,
                body,
              });
            }),
          );
        });
      });
      check();
      const on = request.on.bind(request);
      check();
      on("error", () => finish(new Error("invalid-current-host-phase")));
      check();
      const end = request.end.bind(request);
      check();
      timer = setTimeout(
        () => finish(new Error("invalid-current-host-phase")),
        Math.min(input.timeout_ms, remaining()),
      );
      end();
      check();
    } catch (error) {
      finish(error);
    }
  });
}

/** Same immutable original window through capture, queued GETs, callbacks and delivery. */
class Operation {
  #started = 0;
  #last = 0;
  #checking = false;
  #fenced = false;
  #physicalEnd: number;
  #bounds = new Set<{ end: number; rearm?: () => void; reject?: () => void }>();
  #captureAnchors: number[] = [];
  constructor(
    readonly physical: number,
    readonly now: () => number,
    readonly denial: (() => void) | undefined,
    readonly capture: <T>(work: () => T) => T,
  ) {
    this.#physicalEnd = physical + 30_000;
  }
  fence(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    for (const bound of this.#bounds) bound.reject?.();
  }
  alive(): void {
    const physical = performance.now();
    valid(!this.#fenced && physical < this.#physicalEnd);
    for (const bound of this.#bounds) valid(physical < bound.end);
  }
  /** Only synchronous owned work retains an anchor; it is removed before any await. */
  captured<T>(work: () => T): T {
    this.alive();
    // TIME/refusal capture is already inside tick's reserved observation cluster. Starting
    // another tick here would recurse into that same clock rather than bound caller work.
    if (this.#checking) return work();
    const anchor = performance.now();
    this.#captureAnchors.push(anchor);
    let value: unknown;
    try {
      value = work();
      if (this.#started !== 0) this.tick();
      this.alive();
      return value as T;
    } catch {
      this.fence();
      // A rejected native Promise may have been returned before the post-hook clock refused.
      // Drain through the captured intrinsic; caller .then access can never resume this work.
      drain(value);
      throw new Error("invalid-current-host-phase");
    } finally {
      this.#captureAnchors.pop();
    }
  }
  tick(): number {
    const beforeHooks = Math.min(performance.now(), ...this.#captureAnchors);
    let owns = false;
    try {
      this.alive();
      valid(!this.#checking);
      this.#checking = true;
      owns = true;
      const refuse = () => {
        if (this.denial === undefined) return;
        valid(typeof this.denial === "function");
        const result: unknown = this.capture(this.denial);
        if (result !== undefined) {
          this.fence();
          drain(result);
        }
        valid(result === undefined && this.#checking);
        this.alive();
      };
      refuse();
      const observe = () => {
        const value: unknown = this.capture(this.now);
        if (typeof value !== "number") {
          this.fence();
          drain(value);
        }
        identifier(value);
        this.alive();
        valid(this.#checking);
        // The FIRST observation, not the final sample, anchors this immutable wall epoch.
        if (this.#started === 0) this.#started = value;
        valid(value >= this.#last && value - this.#started < 30_000);
        this.#last = value;
        // Once an original wall remainder is observed, its physical projection survives
        // every later frozen-wall capture. A later sample can only shorten this same end.
        this.#physicalEnd = Math.min(
          this.#physicalEnd,
          beforeHooks + 30_000 - (value - this.#started),
        );
        this.alive();
        // Response/body callbacks can discover a shorter original end after work returned.
        // Owned timers must shrink immediately, without calling another clock/refusal hook.
        for (const bound of this.#bounds) bound.rearm?.();
        return value;
      };
      observe();
      refuse();
      // This final captured clock is trusted TIME ONLY, never approval. A refusal can cost
      // wall/physical time; no callback follows the final sample or the resulting offer cap.
      return observe();
    } catch {
      this.fence();
      throw new Error("invalid-current-host-phase");
    } finally {
      if (owns) this.#checking = false;
    }
  }
  remaining(): number {
    this.tick();
    return this.available();
  }
  /** No hook follows the LAST observed clock; this accessor can only shrink a native timeout. */
  available(): number {
    this.alive();
    const now = this.#last;
    const result = Math.floor(
      Math.min(
        30_000 - (now - this.#started),
        this.#physicalEnd - performance.now(),
        ...[...this.#bounds].map((bound) => bound.end - performance.now()),
      ),
    );
    valid(Number.isSafeInteger(result) && result > 0);
    return result;
  }
  async within<T>(
    work: () => Promise<unknown>,
    own: (value: unknown) => T,
    limit = 30_000,
    offerWork: <U>(work: () => U) => U = this.capture,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound: { end: number; rearm?: () => void; reject?: () => void } = { end: Infinity };
    this.#bounds.add(bound);
    try {
      bound.end = performance.now() + Math.min(limit, this.remaining());
      let expire: (error: Error) => void = () => {};
      const timeout = new Promise<never>((_, reject) => {
        expire = reject;
      });
      // A synchronous initial refusal can reject this owned timeout before race attachment.
      drain(timeout);
      bound.reject = () => expire(new Error("invalid-current-host-phase"));
      const arm = () => {
        bound.end = Math.min(bound.end, this.#physicalEnd);
        clearTimeout(timer);
        const left = bound.end - performance.now();
        if (left <= 0) {
          this.fence();
          throw new Error("invalid-current-host-phase");
        }
        timer = setTimeout(() => this.fence(), left);
      };
      bound.rearm = arm;
      const schedule = () => {
        bound.end = Math.min(bound.end, performance.now() + this.remaining());
        this.alive();
        arm();
      };
      schedule();
      // The private box, not caller fulfillment, crosses Promise.race/await. In particular a
      // hostile result .then getter cannot execute before its original captured guard.
      const pending = new Promise<{ value: T }>((accept, reject) => {
        queueMicrotask(() => {
          let offered: unknown;
          try {
            this.tick();
            offered = offerWork(work);
            this.tick();
            schedule();
            this.capture(() =>
              Reflect.apply(nativeThen, offered, [
                (value: unknown) => {
                  try {
                    this.tick();
                    const copied = this.capture(() => own(value));
                    this.tick();
                    const box = Object.create(null) as { value: T };
                    Object.defineProperty(box, "value", { value: copied, enumerable: true });
                    accept(Object.freeze(box));
                  } catch {
                    this.fence();
                    reject(new Error("invalid-current-host-phase"));
                  }
                },
                () => {
                  this.fence();
                  reject(new Error("invalid-current-host-phase"));
                },
              ]),
            );
          } catch {
            this.fence();
            drain(offered);
            reject(new Error("invalid-current-host-phase"));
          }
        });
      });
      const box = await Promise.race([pending, timeout]);
      this.tick();
      return box.value;
    } catch {
      this.fence();
      throw new Error("invalid-current-host-phase");
    } finally {
      clearTimeout(timer);
      this.#bounds.delete(bound);
    }
  }
}

export const currentHostPhasePins = Object.freeze({
  repository,
  publication: `${repository}/.github/workflows/publish.yml@refs/heads/main`,
  orchestration: `${repository}/.github/workflows/release.yml@refs/heads/main`,
  host: `${repository}/.github/workflows/host.yml@refs/heads/main`,
  job: "Replacement release orchestration / staging / Host",
  request: "Check the request",
  freshness: "Recheck automatic release freshness",
  preparation: "Prepare private host execution grant",
  execution: "Run protected host controller",
  environment: "staging",
} as const);
export interface CurrentHostPhaseConfiguration {
  target: "staging" | "production";
  owner_id: number;
  repository_id: number;
  workflow_id: number;
  environment_id: number;
  token: string;
}
export interface CurrentHostPhaseRequest {
  release: ReleaseIdentity;
  phase: "preparation" | "execution";
}
declare const phaseBrand: unique symbol;
export type CurrentHostPhaseProof = Readonly<{ [phaseBrand]: true }>;
export interface CurrentHostPhaseVerifier {
  verify(request: CurrentHostPhaseRequest, denial?: () => void): Promise<CurrentHostPhaseProof>;
  assert(proof: CurrentHostPhaseProof, expected: CurrentHostPhaseRequest): void;
  remaining(proof: CurrentHostPhaseProof, expected: CurrentHostPhaseRequest): number;
  /** Work yields bounded owned JSON/bytes; no callable then/getter is delivered. */
  within<T>(
    proof: CurrentHostPhaseProof,
    expected: CurrentHostPhaseRequest,
    work: () => Promise<T>,
  ): Promise<T>;
}
interface State {
  owner: object;
  request: CurrentHostPhaseRequest;
  observation: unknown;
  operation: Operation;
  checking: boolean;
  working: boolean;
  fenced: boolean;
}
const proofs = new WeakMap<CurrentHostPhaseProof, State>();
function fence(saved: State | undefined): void {
  if (saved) {
    saved.fenced = true;
    saved.operation.fence();
  }
}
/** Reviewed UTC-only profile: valid nonzero ISO offsets intentionally remain unsupported. */
function time(value: unknown): number {
  valid(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+00:00)$/u.test(value),
  );
  const result = Date.parse(value);
  identifier(result);
  const utc = value.replace(/\+00:00$/u, "Z");
  valid(new Date(result).toISOString() === (utc.includes(".") ? utc : utc.replace("Z", ".000Z")));
  return result;
}
function request(value: unknown, check: () => void): CurrentHostPhaseRequest {
  const data = exact(snapshot(value, check), ["release", "phase"]);
  valid(data.phase === "preparation" || data.phase === "execution");
  const release = releaseIdentity(data.release);
  valid(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
  identifier(Number(release.publication_run));
  valid(String(Number(release.publication_run)) === release.publication_run);
  return { release: Object.freeze(release), phase: data.phase };
}
function field(value: unknown, name: string, check: () => void): unknown {
  check();
  const d = Object.getOwnPropertyDescriptor(object(value), name);
  check();
  valid(d === undefined || Object.hasOwn(d, "value"));
  return d?.value;
}
function ownResult(value: unknown, check: () => void): unknown {
  check();
  if (value === undefined) return undefined;
  if (types.isUint8Array(value)) return copyBytes(value, maxBody, check);
  return snapshot(value, check);
}

/**
 * Dependencies are trusted factory construction, never approval overrides. A future owned
 * host factory must construct its OWN default verifier and refuse proofs from other factories.
 * Creating this closure establishes no lifetime; every invocation starts before all capture.
 */
export function createCurrentHostPhaseVerifier(
  configuration: CurrentHostPhaseConfiguration,
  dependencies: { get?: GitHubReader; now?: () => number } = {},
): CurrentHostPhaseVerifier {
  const owner = Object.freeze(Object.create(null) as object);
  let currentHook: { operation: Operation; state: State | undefined } | undefined;
  let currentWork: { operation: Operation; state: State } | undefined;
  const entry = (asserted?: State) => {
    if (currentHook) {
      currentHook.operation.fence();
      fence(currentHook.state);
      throw new Error("invalid-current-host-phase");
    }
    // Only the same proof's pure assertions may enter public synchronous work. Factory
    // observations and another within/verify remain reserved and fence the original lease.
    if (currentWork && asserted !== currentWork.state) {
      currentWork.operation.fence();
      fence(currentWork.state);
      throw new Error("invalid-current-host-phase");
    }
  };
  const hook = <T>(operation: Operation, state: State | undefined, work: () => T): T => {
    const previous = currentHook;
    let returned: unknown;
    try {
      valid(previous === undefined || previous.operation === operation);
      currentHook = { operation, state: state ?? previous?.state };
      operation.alive();
      returned = operation.captured(work);
      operation.alive();
      return returned as T;
    } catch {
      operation.fence();
      drain(returned);
      throw new Error("invalid-current-host-phase");
    } finally {
      currentHook = previous;
    }
  };
  const assertion = (proof: CurrentHostPhaseProof, expected: CurrentHostPhaseRequest): State => {
    let saved: State | undefined,
      owns = false;
    try {
      saved = proofs.get(proof);
      entry(saved);
      valid(saved && saved.owner === owner && !saved.fenced && !saved.checking);
      saved.checking = true;
      owns = true;
      const retained = saved;
      const copied = hook(saved.operation, saved, () =>
        request(expected, () => retained.operation.alive()),
      );
      valid(saved.checking && !saved.fenced && isDeepStrictEqual(saved.request, copied));
      saved.operation.tick();
      valid(saved.checking && !saved.fenced);
      return saved;
    } catch {
      fence(saved);
      throw new Error("invalid-current-host-phase");
    } finally {
      if (saved && owns) saved.checking = false;
    }
  };
  return Object.freeze({
    async verify(
      expected: CurrentHostPhaseRequest,
      denial?: () => void,
    ): Promise<CurrentHostPhaseProof> {
      const physical = performance.now();
      entry();
      let saved: State | undefined;
      let clock: () => number = Date.now;
      let operation: Operation;
      const capture = <T>(work: () => T): T => hook(operation, saved, work);
      operation = new Operation(physical, () => clock(), denial, capture);
      try {
        const config = capture(() =>
          exact(
            snapshot(configuration, () => operation.alive()),
            ["target", "owner_id", "repository_id", "workflow_id", "environment_id", "token"],
          ),
        ) as unknown as CurrentHostPhaseConfiguration;
        // The public environment observation cannot establish job-to-environment binding.
        valid(config.target === "staging");
        for (const value of [
          config.owner_id,
          config.repository_id,
          config.workflow_id,
          config.environment_id,
        ])
          identifier(value);
        valid(typeof config.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(config.token));
        const deps = capture(() => {
          const now = field(dependencies, "now", () => operation.alive()) ?? Date.now;
          const get = field(dependencies, "get", () => operation.alive());
          valid(typeof now === "function" && (get === undefined || typeof get === "function"));
          return { now: now as () => number, get: get as GitHubReader | undefined };
        });
        clock = deps.now;
        const wanted = capture(() => request(expected, () => operation.alive()));
        operation.tick();
        const read = async (path: string): Promise<unknown> => {
          const url = `${api}${prefix}${path}`;
          const input: GitHubReadRequest = {
            url,
            method: "GET",
            redirect: "error",
            body_limit: maxBody,
            timeout_ms: Math.min(10_000, operation.remaining()),
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2026-03-10",
              "Accept-Encoding": "identity",
              "Cache-Control": "no-cache",
              "User-Agent": "TaruBot-current-host-phase",
              Authorization: `Bearer ${config.token}`,
            },
          };
          const response = await operation.within(
            () => {
              operation.tick();
              return deps.get
                ? capture(() => deps.get?.(input) as Promise<GitHubReadResponse>)
                : directGet(
                    input,
                    () => {
                      operation.tick();
                    },
                    capture,
                    () => operation.available(),
                  );
            },
            (value) => {
              const status = field(value, "status", () => operation.alive()),
                final = field(value, "url", () => operation.alive()),
                rawHeaders = field(value, "headers", () => operation.alive()),
                rawBody = field(value, "body", () => operation.alive());
              operation.tick();
              valid(status === 200 && final === url);
              const headers: Record<string, string> = {};
              let size = 0;
              for (const [key, data] of Object.entries(
                object(snapshot(rawHeaders, () => operation.alive())),
              )) {
                const name = key.toLowerCase();
                valid(typeof data === "string" && !Object.hasOwn(headers, name));
                size += Buffer.byteLength(name) + Buffer.byteLength(data);
                valid(size <= 16_384 && Object.keys(headers).length < 128);
                Object.defineProperty(headers, name, { value: data, enumerable: true });
              }
              valid(
                typeof headers["content-type"] === "string" &&
                  /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
                    headers["content-type"],
                  ),
              );
              valid(
                headers.location === undefined &&
                  headers.link === undefined &&
                  (headers["content-encoding"] === undefined ||
                    headers["content-encoding"] === "identity"),
              );
              const bytes = copyBytes(rawBody, maxBody, () => operation.alive());
              return json(bytes, () => operation.alive());
            },
            input.timeout_ms,
          );
          operation.tick();
          return response;
        };
        const release = wanted.release;
        const runId = Number(release.publication_run);
        const runPath = `/actions/runs/${release.publication_run}`;
        const ownerCheck = (value: unknown) => ownerIdentity(value, config.owner_id);
        const repo = (value: unknown) => {
          const r = object(value);
          valid(r.id === config.repository_id && r.full_name === repository && r.fork === false);
          ownerCheck(r.owner);
          return r;
        };
        const run = (value: unknown) => {
          const r = object(value);
          valid(
            r.id === runId &&
              r.workflow_id === config.workflow_id &&
              r.head_sha === release.commit &&
              r.head_branch === "main" &&
              r.event === "push" &&
              r.run_attempt === 1 &&
              r.status === "in_progress" &&
              r.conclusion === null &&
              r.url === `${api}${prefix}${runPath}`,
          );
          valid(
            [
              ".github/workflows/publish.yml",
              ".github/workflows/publish.yml@main",
              ".github/workflows/publish.yml@refs/heads/main",
              `${repository}/.github/workflows/publish.yml@main`,
              currentHostPhasePins.publication,
            ].includes(r.path as string),
          );
          repo(r.repository);
          repo(r.head_repository);
          const refs = list(r.referenced_workflows).map(object);
          valid(refs.length <= 50 && new Set(refs.map((ref) => ref.path)).size === refs.length);
          for (const name of ["release", "host"]) {
            const stem = `${repository}/.github/workflows/${name}.yml@`;
            const rows = refs.filter(
              (ref) => typeof ref.path === "string" && ref.path.startsWith(stem),
            );
            valid(rows.length === 1 && rows[0]);
            const ref = rows[0];
            valid(
              [`${stem}main`, `${stem}refs/heads/main`].includes(ref.path as string) &&
                ref.ref === "refs/heads/main" &&
                ref.sha === release.config_commit,
            );
          }
          return r;
        };
        const main = (value: unknown) => {
          const m = object(value);
          valid(
            m.name === "main" &&
              m.protected === true &&
              object(m.commit).sha === release.config_commit,
          );
          return m;
        };
        const gatePath = "/environments/staging";
        const policyPath = `${gatePath}/deployment-branch-policies?per_page=100&page=1`;
        const gate = (value: unknown) => {
          const g = object(value),
            policy = object(g.deployment_branch_policy),
            rules = list(g.protection_rules).map(object);
          valid(
            g.id === config.environment_id &&
              g.name === "staging" &&
              g.url === `${api}${prefix}${gatePath}` &&
              policy.protected_branches === false &&
              policy.custom_branch_policies === true &&
              rules.length <= 100 &&
              !rules.some((rule) => rule.type === "required_reviewers"),
          );
          return g;
        };
        const policy = (value: unknown) => {
          const p = object(value),
            rows = list(p.branch_policies).map(object);
          valid(
            p.total_count === 1 &&
              rows.length === 1 &&
              rows[0]?.name === "main" &&
              rows[0]?.type === "branch",
          );
          identifier(rows[0]?.id);
          return p;
        };
        const jobsPath = `${runPath}/attempts/1/jobs?per_page=100&page=1`;
        const page = (value: unknown) => {
          const p = object(value),
            jobs = list(p.jobs).map(object);
          valid(
            jobs.length <= 100 &&
              p.total_count === jobs.length &&
              new Set(jobs.map((job) => job.id)).size === jobs.length,
          );
          for (const job of jobs) identifier(job.id);
          const selected = jobs.filter((job) => job.name === currentHostPhasePins.job);
          valid(selected.length === 1 && selected[0]);
          return { page: p, job: selected[0] };
        };
        const job = (value: unknown) => {
          const j = object(value);
          identifier(j.id);
          valid(
            j.name === currentHostPhasePins.job &&
              j.url === `${api}${prefix}/actions/jobs/${j.id}` &&
              j.run_id === runId &&
              j.run_attempt === 1 &&
              j.head_sha === release.commit &&
              j.head_branch === "main" &&
              j.run_url === `${api}${prefix}${runPath}` &&
              j.status === "in_progress" &&
              j.conclusion === null &&
              j.completed_at === null,
          );
          const started = time(j.started_at),
            at = operation.tick();
          valid(started <= at && at - started < 2_400_000);
          const checkPrefix = `${api}${prefix}/check-runs/`;
          valid(typeof j.check_run_url === "string" && j.check_run_url.startsWith(checkPrefix));
          const raw = j.check_run_url.slice(checkPrefix.length);
          valid(/^[1-9][0-9]{0,15}$/u.test(raw));
          identifier(Number(raw));
          valid(String(Number(raw)) === raw && j.check_run_url === `${checkPrefix}${Number(raw)}`);
          const steps = list(j.steps).map(object);
          valid(
            steps.length > 0 &&
              steps.length <= 100 &&
              new Set(steps.map((step) => step.number)).size === steps.length,
          );
          for (const step of steps) identifier(step.number);
          const named = (name: string) => {
            const rows = steps.filter((step) => step.name === name);
            valid(rows.length === 1 && rows[0]);
            return rows[0];
          };
          const complete = (step: Value) => {
            valid(step.status === "completed" && step.conclusion === "success");
            const begin = time(step.started_at),
              end = time(step.completed_at);
            valid(started <= begin && begin <= end && end <= at);
            return { begin, end };
          };
          const live = (step: Value) => {
            valid(
              step.status === "in_progress" &&
                step.conclusion === null &&
                step.completed_at === null,
            );
            const begin = time(step.started_at);
            valid(started <= begin && begin <= at);
            return begin;
          };
          const requested = named(currentHostPhasePins.request),
            fresh = named(currentHostPhasePins.freshness),
            prepared = named(currentHostPhasePins.preparation);
          // GitHub need not expose future not-started steps. Their absence says nothing
          // about protected source; a visible contradictory future step still refuses.
          const future = steps.filter((step) => step.name === currentHostPhasePins.execution);
          valid(future.length <= 1);
          const execute = future[0];
          valid(
            Number(requested.number) < Number(fresh.number) &&
              Number(fresh.number) < Number(prepared.number) &&
              (execute === undefined || Number(prepared.number) < Number(execute.number)),
          );
          const requestedTimes = complete(requested),
            freshTimes = complete(fresh);
          valid(requestedTimes.end <= freshTimes.begin);
          if (wanted.phase === "preparation") {
            valid(freshTimes.end <= live(prepared));
            if (execute !== undefined)
              valid(
                execute.status === "queued" &&
                  execute.conclusion === null &&
                  execute.started_at === null &&
                  execute.completed_at === null,
              );
          } else {
            valid(execute !== undefined);
            const preparedTimes = complete(prepared);
            valid(freshTimes.end <= preparedTimes.begin && preparedTimes.end <= live(execute));
          }
          const running = steps.filter((step) => step.status === "in_progress");
          valid(
            running.length === 1 &&
              running[0] === (wanted.phase === "preparation" ? prepared : execute),
          );
          return j;
        };
        const firstRepo = repo(await read("")),
          firstRun = run(await read(runPath)),
          firstMain = main(await read("/branches/main")),
          firstGate = gate(await read(gatePath)),
          firstPolicy = policy(await read(policyPath)),
          firstPage = page(await read(jobsPath));
        const firstJob = job(firstPage.job);
        const checkId = Number(
          String(firstJob.check_run_url).slice(String(firstJob.check_run_url).lastIndexOf("/") + 1),
        );
        const checkPath = `/check-runs/${checkId}`;
        const check = (value: unknown) => {
          const c = object(value);
          valid(
            c.id === checkId &&
              c.url === `${api}${prefix}${checkPath}` &&
              c.name === currentHostPhasePins.job &&
              c.head_sha === release.commit &&
              c.status === "in_progress" &&
              c.conclusion === null &&
              c.completed_at === null &&
              object(c.app).slug === "github-actions",
          );
          identifier(object(c.app).id);
          identifier(object(c.check_suite).id);
          valid(time(c.started_at) === time(firstJob.started_at));
          return c;
        };
        let firstCheck: Value | undefined;
        for (let count = 0; count < 2; count++) {
          valid(isDeepStrictEqual(job(await read(`/actions/jobs/${firstJob.id}`)), firstJob));
          const observed = check(await read(checkPath));
          if (firstCheck === undefined) firstCheck = observed;
          else valid(isDeepStrictEqual(observed, firstCheck));
        }
        valid(isDeepStrictEqual(page(await read(jobsPath)).page, firstPage.page));
        valid(isDeepStrictEqual(gate(await read(gatePath)), firstGate));
        valid(isDeepStrictEqual(policy(await read(policyPath)), firstPolicy));
        valid(isDeepStrictEqual(main(await read("/branches/main")), firstMain));
        valid(isDeepStrictEqual(run(await read(runPath)), firstRun));
        valid(isDeepStrictEqual(repo(await read("")), firstRepo));
        operation.tick();
        const proof = Object.freeze(Object.create(null)) as CurrentHostPhaseProof;
        saved = {
          owner,
          request: Object.freeze(wanted),
          observation: {
            repo: firstRepo,
            run: firstRun,
            main: firstMain,
            gate: firstGate,
            policy: firstPolicy,
            page: firstPage.page,
            job: firstJob,
            check: firstCheck,
          },
          operation,
          checking: false,
          working: false,
          fenced: false,
        };
        proofs.set(proof, saved);
        assertion(proof, wanted);
        return proof;
      } catch {
        operation.fence();
        fence(saved);
        throw new Error("invalid-current-host-phase");
      }
    },
    assert: (proof: CurrentHostPhaseProof, expected: CurrentHostPhaseRequest): void => {
      assertion(proof, expected);
    },
    remaining(proof: CurrentHostPhaseProof, expected: CurrentHostPhaseRequest): number {
      let saved: State | undefined;
      try {
        saved = assertion(proof, expected);
        const result = saved.operation.remaining();
        valid(!saved.fenced && Number.isSafeInteger(result) && result > 0);
        return result;
      } catch {
        fence(saved);
        throw new Error("invalid-current-host-phase");
      }
    },
    async within<T>(
      proof: CurrentHostPhaseProof,
      expected: CurrentHostPhaseRequest,
      work: () => Promise<T>,
    ): Promise<T> {
      let saved: State | undefined,
        owns = false;
      try {
        saved = proofs.get(proof);
        entry();
        valid(saved && saved.owner === owner && !saved.fenced && !saved.working);
        saved.working = true;
        owns = true;
        assertion(proof, expected);
        const retained = saved;
        valid(typeof work === "function");
        const offerWork = <U>(callback: () => U): U => {
          valid(currentWork === undefined && currentHook === undefined);
          currentWork = { operation: retained.operation, state: retained };
          try {
            // The original synchronous anchor also bounds assertions inside this callback.
            // Remove the public work lease immediately at return, before Promise waiting.
            return retained.operation.captured(callback);
          } finally {
            currentWork = undefined;
          }
        };
        const result = await saved.operation.within(
          work,
          (value) => ownResult(value, () => retained.operation.alive()) as T,
          30_000,
          offerWork,
        );
        assertion(proof, expected);
        valid(!saved.fenced && saved.working);
        return result;
      } catch {
        fence(saved);
        throw new Error("invalid-current-host-phase");
      } finally {
        if (saved && owns) saved.working = false;
      }
    },
  });
}
