/**
 * Historical attribution of a NEW v2 content receipt. This neither accepts v1 receipts nor
 * extends OAuth/v1 authorization. Public job/iat evidence relies on the reviewed projection
 * and issuer origin; it cannot identify the requesting process or attest private authorship.
 * No mint HTTP, environment lookup, storage, provider or workflow operation occurs here.
 */
import { constants, createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import type { AppliedTargetProducer } from "./target-descriptor.js";
import type { GitHubReader, GitHubReadResponse } from "./trust-run.js";
import {
  assertTargetIssuanceRunProof,
  createTargetIssuanceRunReader,
  type TargetIssuanceRunProof,
} from "./target-issuance-run.js";

type Value = Record<string, unknown>;
export const targetIssuancePins = Object.freeze({
  repository: "deconfined/tarubot",
  publication: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
  infrastructure: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
  plan: "Replacement release orchestration / infrastructure / Plan infrastructure",
  apply: "Replacement release orchestration / infrastructure / Apply infrastructure",
  issuer: "Replacement release orchestration / infrastructure / Seal target descriptors",
  projection: "Project applied target descriptors",
  sealing: "Seal applied target descriptors",
  environment: "target-seal",
} as const);
const day = 86_400_000;
const mintBudget = 30_000;
const proofAge = 30_000;
const issuerUrl = "https://token.actions.githubusercontent.com";
const jwksUrl = `${issuerUrl}/.well-known/jwks`;
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeSet = Uint8Array.prototype.set;

/** Intrinsic length/set ignore own length, iterator and subarray hooks before allocation. */
function byteSnapshot(value: Uint8Array): Uint8Array {
  requireIssuance(value instanceof Uint8Array && nativeByteLength !== undefined);
  const length = nativeByteLength.call(value) as number;
  requireIssuance(length > 0 && length <= maxBody);
  const copy = new Uint8Array(length);
  nativeSet.call(copy, value);
  return copy;
}

function requireIssuance(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-issuance");
}
function object(value: unknown): Value {
  requireIssuance(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireIssuance(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  requireIssuance(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function digest(value: unknown): asserts value is string {
  requireIssuance(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Shared new-module parser utilities are fixed, bounded and do not retain caller references. */
function captureTargetIssuanceRaw(value: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    requireIssuance(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      requireIssuance(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireIssuance(bytes <= 65_536);
      return input;
    }
    requireIssuance(input !== null && typeof input === "object" && !ancestors.has(input));
    requireIssuance(Object.getOwnPropertySymbols(input).length === 0);
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      requireIssuance(input.length <= 1024 && Object.keys(descriptors).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireIssuance(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireIssuance(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const data: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireIssuance(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireIssuance(bytes <= 65_536);
        Object.defineProperty(data, key, { value: copy(item.value, depth + 1), enumerable: true });
      }
      result = data;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
export function captureTargetIssuance(value: unknown): unknown {
  try {
    return captureTargetIssuanceRaw(value);
  } catch {
    throw new Error("invalid-target-issuance");
  }
}
/** Complete UTF-8 JSON, including duplicate decoded-key refusal before JSON.parse. */
function parseTargetIssuanceJsonRaw(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    byteSnapshot(bytes),
  );
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[at] ?? "")) at++;
  };
  const string = (): string => {
    requireIssuance(source[at] === '"');
    const start = at++;
    while (at < source.length) {
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
      if (source[at - 1] === "\\") at++;
    }
    throw new Error("invalid-target-issuance");
  };
  const value = (depth: number): void => {
    requireIssuance(++nodes <= 65_536 && depth <= 32);
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
          requireIssuance(!keys.has(key));
          keys.add(key);
          whitespace();
          requireIssuance(source[at++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[at++];
        if (next === end) return;
        requireIssuance(next === ",");
      }
    }
    const start = at;
    while (at < source.length && !/^[,}\] \t\r\n]$/u.test(source[at] ?? "")) at++;
    requireIssuance(at > start);
    const result = JSON.parse(source.slice(start, at)) as unknown;
    requireIssuance(typeof result !== "number" || Number.isFinite(result));
  };
  value(0);
  whitespace();
  requireIssuance(at === source.length);
  return JSON.parse(source) as unknown;
}
export function parseTargetIssuanceJson(bytes: Uint8Array): unknown {
  try {
    return parseTargetIssuanceJsonRaw(bytes);
  } catch {
    throw new Error("invalid-target-issuance");
  }
}
/**
 * v2 declaration only. Future transport must use this new domain and purpose/target/backend
 * codec binding with a dedicated per-target passphrase, never a state/trust encryption key.
 * This declaration supplies no storage permission or v1 receipt/lifetime compatibility.
 */
export const targetContentDomain = "tarubot-applied-target-content-v2" as const;
export interface ContentReceiptV2 {
  schema: 2;
  purpose: "tarubot-applied-target-content-v2";
  target: "staging" | "production";
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
interface StepIdentity<Name extends string> {
  name: Name;
  number: number;
}
export interface TargetIssuanceSourceJob<Name extends string> {
  job_id: number;
  check_run_id: number;
  critical_step: StepIdentity<Name>;
  projection_step: StepIdentity<typeof targetIssuancePins.projection>;
}
export interface TargetIssuanceStatementV2 {
  schema: 2;
  purpose: "tarubot-applied-target-issuance-v2";
  content_receipt: ContentReceiptV2;
  source: {
    plan: TargetIssuanceSourceJob<"Plan and require automatic policy">;
    apply: TargetIssuanceSourceJob<"Recheck policy and apply exact saved plan"> | null;
  };
  issuer: {
    repository_owner_id: number;
    repository_id: number;
    job_path: typeof targetIssuancePins.issuer;
    job_id: number;
    check_run_id: number;
    critical_step: StepIdentity<typeof targetIssuancePins.sealing>;
  };
  issued_at: number;
  valid_until: number;
}
export interface TargetIssuanceContext {
  target: "staging" | "production";
  backend: string;
  release: ReleaseIdentity;
}
function stepIdentity(value: unknown, name: string): void {
  const s = exact(value, ["name", "number"]);
  requireIssuance(s.name === name);
  integer(s.number);
  requireIssuance(s.number <= 1000);
}
function sourceJob(value: unknown, name: string): void {
  const s = exact(value, ["job_id", "check_run_id", "critical_step", "projection_step"]);
  integer(s.job_id);
  integer(s.check_run_id);
  stepIdentity(s.critical_step, name);
  stepIdentity(s.projection_step, targetIssuancePins.projection);
  requireIssuance(
    Number(object(s.critical_step).number) < Number(object(s.projection_step).number),
  );
}
/** Pure validation returns declarations, never authenticated producer or consumer authority. */
function targetIssuanceStatementRaw(value: unknown): TargetIssuanceStatementV2 {
  const s = exact(captureTargetIssuance(value), [
    "schema",
    "purpose",
    "content_receipt",
    "source",
    "issuer",
    "issued_at",
    "valid_until",
  ]);
  requireIssuance(s.schema === 2 && s.purpose === "tarubot-applied-target-issuance-v2");
  const r = exact(s.content_receipt, [
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
  requireIssuance(
    r.schema === 2 &&
      r.purpose === "tarubot-applied-target-content-v2" &&
      (r.target === "staging" || r.target === "production") &&
      (r.mode === "apply" || r.mode === "no-changes"),
  );
  for (const key of ["backend", "payload_digest", "ciphertext_digest"]) digest(r[key]);
  const release = releaseIdentity(r.release);
  requireIssuance(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
  integer(Number(release.publication_run));
  requireIssuance(String(Number(release.publication_run)) === release.publication_run);
  const producer = exact(r.producer, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  requireIssuance(
    isDeepStrictEqual(producer, {
      repository: targetIssuancePins.repository,
      workflow_ref: targetIssuancePins.publication,
      ref: "refs/heads/main",
      event: "push",
      attempt: 1,
      commit: release.commit,
      run: release.publication_run,
    }),
  );
  requireIssuance(
    r.path ===
      `applied-target-content-v2/${r.target}/${release.publication_run}/${release.commit}/${r.payload_digest}`,
  );
  for (const key of ["issued_at", "expires_at"]) integer(r[key]);
  integer(s.issued_at);
  integer(s.valid_until);
  requireIssuance(
    Number(r.expires_at) > Number(r.issued_at) &&
      Number(r.expires_at) - Number(r.issued_at) <= day &&
      Number(r.issued_at) <= s.issued_at &&
      s.valid_until > s.issued_at &&
      s.valid_until <= Number(r.expires_at) &&
      s.valid_until - s.issued_at <= day,
  );
  const sources = exact(s.source, ["plan", "apply"]);
  sourceJob(sources.plan, "Plan and require automatic policy");
  if (r.mode === "apply") sourceJob(sources.apply, "Recheck policy and apply exact saved plan");
  else requireIssuance(sources.apply === null);
  const i = exact(s.issuer, [
    "repository_owner_id",
    "repository_id",
    "job_path",
    "job_id",
    "check_run_id",
    "critical_step",
  ]);
  for (const key of ["repository_owner_id", "repository_id", "job_id", "check_run_id"])
    integer(i[key]);
  requireIssuance(i.job_path === targetIssuancePins.issuer);
  stepIdentity(i.critical_step, targetIssuancePins.sealing);
  const jobs = [object(sources.plan).job_id, i.job_id],
    checks = [object(sources.plan).check_run_id, i.check_run_id];
  if (sources.apply !== null) {
    jobs.push(object(sources.apply).job_id);
    checks.push(object(sources.apply).check_run_id);
  }
  requireIssuance(new Set(jobs).size === jobs.length && new Set(checks).size === checks.length);
  return freeze(s as unknown as TargetIssuanceStatementV2);
}
export function targetIssuanceStatement(value: unknown): TargetIssuanceStatementV2 {
  try {
    return targetIssuanceStatementRaw(value);
  } catch {
    throw new Error("invalid-target-issuance");
  }
}
function context(value: unknown, statement: TargetIssuanceStatementV2): TargetIssuanceContext {
  const c = exact(captureTargetIssuance(value), ["target", "backend", "release"]);
  digest(c.backend);
  const release = releaseIdentity(c.release);
  requireIssuance(
    c.target === statement.content_receipt.target &&
      c.backend === statement.content_receipt.backend &&
      isDeepStrictEqual(release, statement.content_receipt.release),
  );
  return freeze(c as unknown as TargetIssuanceContext);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function targetIssuanceAudience(value: TargetIssuanceStatementV2): string {
  const statement = targetIssuanceStatement(value);
  const hash = createHash("sha256")
    .update(canonical({ domain: "tarubot-applied-target-issuance-statement-v2", statement }))
    .digest("hex");
  return `urn:tarubot:applied-target-issuance:v2:${hash}`;
}

declare const mintBrand: unique symbol;
export type TargetIssuanceMintWindow = Readonly<{ [mintBrand]: true }>;
interface MintState {
  clock: () => number;
  last: number;
  wall: number;
  physical: number;
  attempt: number;
  phase: "prepared" | "started" | "fenced";
}
const mintWindows = new WeakMap<TargetIssuanceMintWindow, MintState>();
/** A local denial timer is not a consumer proof or evidence of historical monotonic time. */
export function prepareTargetIssuance(
  input: Omit<TargetIssuanceStatementV2, "schema" | "purpose" | "issued_at" | "valid_until"> & {
    valid_until?: number;
  },
  dependencies: { now?: () => number } = {},
): { statement: TargetIssuanceStatementV2; audience: string; window: TargetIssuanceMintWindow } {
  try {
    const data = object(captureTargetIssuance(input));
    requireIssuance(
      Object.keys(data).every((key) =>
        ["content_receipt", "source", "issuer", "valid_until"].includes(key),
      ),
    );
    const clock = dependencies.now ?? Date.now;
    requireIssuance(typeof clock === "function");
    const physical = performance.now(),
      at = clock();
    integer(at);
    const receipt = object(data.content_receipt);
    integer(receipt.expires_at);
    const statement = targetIssuanceStatement({
      schema: 2,
      purpose: "tarubot-applied-target-issuance-v2",
      content_receipt: data.content_receipt,
      source: data.source,
      issuer: data.issuer,
      issued_at: at,
      valid_until: data.valid_until ?? Math.min(receipt.expires_at, at + day - 1000),
    });
    const window = Object.freeze({}) as TargetIssuanceMintWindow;
    const budget = Math.min(mintBudget, statement.valid_until - at);
    mintWindows.set(window, {
      clock,
      last: at,
      wall: at + budget,
      physical: physical + budget,
      attempt: 0,
      phase: "prepared",
    });
    return Object.freeze({ statement, audience: targetIssuanceAudience(statement), window });
  } catch {
    throw new Error("invalid-target-issuance-window");
  }
}
function mintTransition(value: TargetIssuanceMintWindow, from: "prepared" | "started"): void {
  try {
    const state = mintWindows.get(value);
    requireIssuance(state);
    const phase = state.phase;
    // Reserve/fence before invoking even the clock. A failed check never permits a retry.
    const attempt = ++state.attempt;
    state.phase = "fenced";
    requireIssuance(phase === from);
    const at = state.clock();
    integer(at);
    // A clock that catches its nested denial cannot restore the outer reservation.
    requireIssuance(state.attempt === attempt);
    requireIssuance(at >= state.last && at < state.wall && performance.now() < state.physical);
    state.last = at;
    if (from === "prepared") state.phase = "started";
  } catch {
    throw new Error("invalid-target-issuance-window");
  }
}
export function startTargetIssuanceMint(window: TargetIssuanceMintWindow): void {
  mintTransition(window, "prepared");
}
export function finishTargetIssuanceMint(window: TargetIssuanceMintWindow): void {
  mintTransition(window, "started");
}

/** Fixed official current JWKS transport. No packet key, inherited proxy, redirect or retry. */
const jwksGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    if (input.method !== "GET" || input.url !== jwksUrl) {
      reject(new Error("invalid-target-issuance"));
      return;
    }
    const agent = new Agent({ keepAlive: false }),
      chunks: Buffer[] = [];
    let size = 0,
      ended = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      agent.destroy();
      if (response) accept(response);
      else reject(new Error("invalid-target-issuance"));
    };
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: "token.actions.githubusercontent.com",
        servername: "token.actions.githubusercontent.com",
        port: 443,
        method: "GET",
        path: "/.well-known/jwks",
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: maxHeaders,
      },
      (response) => {
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.body_limit) {
            finish();
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.complete) {
            finish();
            return;
          }
          const headers: Record<string, string> = Object.create(null);
          for (let n = 0; n < response.rawHeaders.length; n += 2) {
            const name = response.rawHeaders[n]?.toLowerCase(),
              value = response.rawHeaders[n + 1];
            if (name === undefined || value === undefined) {
              finish();
              return;
            }
            headers[name] = Object.hasOwn(headers, name) ? `${headers[name]},${value}` : value;
          }
          finish({
            status: response.statusCode ?? 0,
            url: input.url,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", () => finish());
    timer = setTimeout(() => {
      finish();
      req.destroy();
    }, input.timeout_ms);
    req.end();
  });
function targetIssuanceResponseRaw(response: GitHubReadResponse, url: string): unknown {
  const bytes = byteSnapshot(response.body);
  requireIssuance(response.status === 200 && response.url === url && bytes.length > 0);
  const headers: Record<string, string> = Object.create(null);
  let size = 0;
  for (const [name, value] of Object.entries(object(response.headers))) {
    const key = name.toLowerCase();
    requireIssuance(
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(key) &&
        typeof value === "string" &&
        !/[\r\n\0]/u.test(value) &&
        !Object.hasOwn(headers, key),
    );
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    requireIssuance(size <= maxHeaders);
    headers[key] = value;
  }
  requireIssuance(
    typeof headers["content-type"] === "string" &&
      /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
        headers["content-type"],
      ),
  );
  requireIssuance(
    headers.location === undefined &&
      headers.link === undefined &&
      (headers["content-encoding"] === undefined || headers["content-encoding"] === "identity"),
  );
  if (headers["content-length"] !== undefined)
    requireIssuance(
      /^(0|[1-9][0-9]*)$/u.test(headers["content-length"]) &&
        Number(headers["content-length"]) === bytes.length,
    );
  return parseTargetIssuanceJson(bytes);
}
export function targetIssuanceResponse(response: GitHubReadResponse, url: string): unknown {
  try {
    return targetIssuanceResponseRaw(response, url);
  } catch {
    throw new Error("invalid-target-issuance");
  }
}
function base64url(value: unknown, limit: number): Buffer {
  requireIssuance(
    typeof value === "string" &&
      /^[A-Za-z0-9_-]+$/u.test(value) &&
      value.length <= Math.ceil((limit * 4) / 3),
  );
  const bytes = Buffer.from(value, "base64url");
  requireIssuance(
    bytes.length > 0 && bytes.length <= limit && bytes.toString("base64url") === value,
  );
  return bytes;
}
function signingKey(value: unknown, kid: string, x5t: unknown) {
  const data = exact(value, ["keys"]);
  requireIssuance(Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 100);
  const keys = data.keys.map(object);
  requireIssuance(new Set(keys.map((key) => key.kid)).size === keys.length);
  for (const key of keys) {
    requireIssuance(
      Object.keys(key).every((name) =>
        ["kty", "kid", "use", "alg", "n", "e", "x5t", "x5c"].includes(name),
      ) &&
        key.kty === "RSA" &&
        key.use === "sig" &&
        key.alg === "RS256" &&
        typeof key.kid === "string" &&
        /^[A-Za-z0-9._-]{1,256}$/u.test(key.kid),
    );
    const n = base64url(key.n, 1024),
      e = base64url(key.e, 8);
    requireIssuance(
      n.length >= 256 && n[0] !== 0 && e.length === 3 && e.toString("hex") === "010001",
    );
    if (key.x5t !== undefined) base64url(key.x5t, 64);
    if (key.x5c !== undefined)
      requireIssuance(
        Array.isArray(key.x5c) &&
          key.x5c.length > 0 &&
          key.x5c.length <= 10 &&
          key.x5c.every(
            (cert) =>
              typeof cert === "string" &&
              /^[A-Za-z0-9+/]+={0,2}$/u.test(cert) &&
              cert.length <= 16_384,
          ),
      );
  }
  const key = keys.find((key) => key.kid === kid);
  requireIssuance(key && (x5t === undefined || key.x5t === x5t));
  const publicKey = createPublicKey({
    key: { kty: "RSA", n: String(key.n), e: String(key.e) },
    format: "jwk",
  });
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  requireIssuance(bits !== undefined && bits >= 2048 && bits <= 8192);
  return publicKey;
}
export interface TargetIssuanceConfiguration {
  owner_id: number;
  repository_id: number;
  environment_id: number;
  subject: string;
  token: string;
}
declare const historicalBrand: unique symbol;
export type HistoricalTargetIssuanceProof = Readonly<{ [historicalBrand]: true }>;
interface HistoricalState {
  statement: TargetIssuanceStatementV2;
  context: TargetIssuanceContext;
  run: TargetIssuanceRunProof;
  iat: number;
  clock: () => number;
  last: number;
  wall: number;
  physical: number;
  fenced: boolean;
  checking: boolean;
}
const historicalProofs = new WeakMap<HistoricalTargetIssuanceProof, HistoricalState>();
/** Separate short-lived attribution capability. A v1 receipt, Boolean or serialized echo fails. */
export function assertHistoricalTargetIssuanceProof(
  value: unknown,
  expected: { statement: TargetIssuanceStatementV2; context: TargetIssuanceContext },
): void {
  let saved: HistoricalState | undefined;
  let reserved = false;
  try {
    requireIssuance(value !== null && typeof value === "object");
    saved = historicalProofs.get(value as HistoricalTargetIssuanceProof);
    requireIssuance(saved && !saved.fenced && !saved.checking);
    // Reserve before caller snapshots or clocks can reenter. A nested denial fences this
    // outer assertion; only its owning finally may release the active reservation.
    saved.checking = true;
    reserved = true;
    const data = exact(captureTargetIssuance(expected), ["statement", "context"]);
    const statement = targetIssuanceStatement(data.statement),
      c = context(data.context, statement);
    requireIssuance(
      !saved.fenced &&
        saved.checking &&
        isDeepStrictEqual(statement, saved.statement) &&
        isDeepStrictEqual(c, saved.context),
    );
    const at = saved.clock();
    integer(at);
    requireIssuance(
      !saved.fenced &&
        saved.checking &&
        at >= saved.last &&
        at < saved.wall &&
        performance.now() < saved.physical,
    );
    assertTargetIssuanceRunProof(saved.run, saved.statement, saved.iat);
    requireIssuance(!saved.fenced && saved.checking);
    saved.last = at;
  } catch {
    if (saved) saved.fenced = true;
    throw new Error("invalid-target-issuance");
  } finally {
    if (reserved && saved) saved.checking = false;
  }
}
/** Original expiry bounds result delivery; arbitrary in-flight work cannot be cancelled here. */
export async function withinHistoricalTargetIssuanceProof<T>(
  proof: HistoricalTargetIssuanceProof,
  expected: { statement: TargetIssuanceStatementV2; context: TargetIssuanceContext },
  work: () => Promise<T>,
): Promise<T> {
  const captured = captureTargetIssuance(expected) as typeof expected;
  assertHistoricalTargetIssuanceProof(proof, captured);
  const state = historicalProofs.get(proof);
  requireIssuance(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = Math.min(state.wall - state.last, state.physical - performance.now());
    requireIssuance(remaining > 0);
    const result = await Promise.race([
      Promise.resolve().then(() => {
        assertHistoricalTargetIssuanceProof(proof, captured);
        return work();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("invalid-target-issuance")), remaining);
      }),
    ]);
    assertHistoricalTargetIssuanceProof(proof, captured);
    return result;
  } catch {
    state.fenced = true;
    throw new Error("invalid-target-issuance");
  } finally {
    clearTimeout(timer);
  }
}
export class HistoricalTargetIssuanceVerifier {
  readonly #config: TargetIssuanceConfiguration;
  readonly #get: GitHubReader;
  readonly #clock: () => number;
  readonly #reader: (clock: () => number) => ReturnType<typeof createTargetIssuanceRunReader>;
  constructor(
    configuration: TargetIssuanceConfiguration,
    dependencies: { get?: GitHubReader; now?: () => number } = {},
  ) {
    try {
      const c = exact(captureTargetIssuance(configuration), [
        "owner_id",
        "repository_id",
        "environment_id",
        "subject",
        "token",
      ]);
      for (const key of ["owner_id", "repository_id", "environment_id"]) integer(c[key]);
      requireIssuance(
        typeof c.subject === "string" &&
          /^[!-~]{1,2048}$/u.test(c.subject) &&
          typeof c.token === "string" &&
          /^[A-Za-z0-9._-]{20,2048}$/u.test(c.token),
      );
      this.#config = c as unknown as TargetIssuanceConfiguration;
      const get = dependencies.get,
        clock = dependencies.now ?? Date.now;
      requireIssuance(
        (get === undefined || typeof get === "function") && typeof clock === "function",
      );
      this.#get = get ?? jwksGet;
      this.#clock = clock;
      // Each operation captures its ORIGINAL denial clock. No shared proof/window can rebind
      // an abandoned reader; the standalone native reader also retains its own short budget.
      this.#reader = (originalClock) =>
        createTargetIssuanceRunReader(
          {
            owner_id: this.#config.owner_id,
            repository_id: this.#config.repository_id,
            environment_id: this.#config.environment_id,
            token: this.#config.token,
          },
          { ...(get === undefined ? {} : { get }), now: originalClock },
        );
      Object.freeze(this);
    } catch {
      throw new Error("invalid-target-issuance");
    }
  }
  async verify(input: {
    statement: TargetIssuanceStatementV2;
    context: TargetIssuanceContext;
    jwt: string;
  }): Promise<HistoricalTargetIssuanceProof> {
    try {
      const data = exact(captureTargetIssuance(input), ["statement", "context", "jwt"]),
        statement = targetIssuanceStatement(data.statement),
        c = context(data.context, statement);
      requireIssuance(
        statement.issuer.repository_owner_id === this.#config.owner_id &&
          statement.issuer.repository_id === this.#config.repository_id,
      );
      const physical = performance.now(),
        started = this.#clock();
      integer(started);
      let last = started;
      let fenced = false;
      const wall = Math.min(started + proofAge, statement.valid_until),
        physicalExpiry = physical + wall - started;
      const tick = () => {
        try {
          requireIssuance(!fenced);
          const at = this.#clock();
          integer(at);
          requireIssuance(
            at >= last &&
              at >= statement.issued_at &&
              at < wall &&
              performance.now() < physicalExpiry,
          );
          last = at;
          return at;
        } catch (error) {
          fenced = true;
          throw error;
        }
      };
      const bounded = async <T>(work: () => Promise<T>, callLimit = 10_000): Promise<T> => {
        const remaining = Math.min(callLimit, wall - tick(), physicalExpiry - performance.now());
        requireIssuance(remaining > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              tick();
              return work();
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("invalid-target-issuance")), remaining);
            }),
          ]);
          tick();
          return result;
        } catch (error) {
          fenced = true;
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };
      tick();
      requireIssuance(typeof data.jwt === "string" && data.jwt.length <= 32_768);
      const segments = data.jwt.split(".");
      requireIssuance(segments.length === 3);
      const header = object(parseTargetIssuanceJson(base64url(segments[0], 4096))),
        claims = object(parseTargetIssuanceJson(base64url(segments[1], 24_576))),
        signature = base64url(segments[2], 1024);
      requireIssuance(
        Object.keys(header).every((name) => ["alg", "kid", "typ", "x5t"].includes(name)) &&
          header.alg === "RS256" &&
          header.typ === "JWT" &&
          typeof header.kid === "string" &&
          /^[A-Za-z0-9._-]{1,256}$/u.test(header.kid),
      );
      if (header.x5t !== undefined) base64url(header.x5t, 64);
      for (const name of ["iat", "nbf", "exp"]) integer(claims[name]);
      const iat = Number(claims.iat) * 1000,
        nbf = Number(claims.nbf) * 1000,
        exp = Number(claims.exp) * 1000;
      integer(iat);
      integer(nbf);
      integer(exp);
      // exp is original issuance evidence ONLY; no expired bearer token becomes live authority.
      requireIssuance(
        nbf <= iat &&
          iat - nbf <= 60_000 &&
          exp > iat &&
          exp - iat <= 900_000 &&
          iat <= tick() &&
          iat >= statement.issued_at - 1000 &&
          iat < statement.issued_at + mintBudget &&
          statement.valid_until <= iat + day,
      );
      const response = await bounded(() =>
        this.#get({
          url: jwksUrl,
          method: "GET",
          redirect: "error",
          timeout_ms: Math.min(10_000, wall - tick(), physicalExpiry - performance.now()),
          body_limit: maxBody,
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "Cache-Control": "no-cache",
            "User-Agent": "TaruBot-target-issuance-v2",
          },
        }),
      );
      const key = signingKey(targetIssuanceResponse(response, jwksUrl), header.kid, header.x5t);
      requireIssuance(
        key.asymmetricKeyType === "rsa" &&
          verifySignature(
            "RSA-SHA256",
            Buffer.from(`${segments[0]}.${segments[1]}`),
            { key, padding: constants.RSA_PKCS1_PADDING },
            signature,
          ),
      );
      const r = statement.content_receipt;
      requireIssuance(
        claims.iss === issuerUrl &&
          claims.aud === targetIssuanceAudience(statement) &&
          claims.sub === this.#config.subject &&
          claims.repository === targetIssuancePins.repository &&
          claims.repository_owner === "deconfined" &&
          claims.repository_id === String(this.#config.repository_id) &&
          claims.repository_owner_id === String(this.#config.owner_id) &&
          claims.ref === "refs/heads/main" &&
          claims.ref_type === "branch" &&
          claims.ref_protected === "true" &&
          claims.event_name === "push" &&
          claims.sha === r.release.commit &&
          claims.run_id === r.release.publication_run &&
          claims.run_attempt === "1" &&
          claims.workflow_ref === targetIssuancePins.publication &&
          claims.workflow_sha === r.release.commit &&
          claims.job_workflow_ref === targetIssuancePins.infrastructure &&
          claims.job_workflow_sha === r.release.config_commit &&
          claims.environment === targetIssuancePins.environment &&
          claims.check_run_id === String(statement.issuer.check_run_id) &&
          claims.head_ref === "" &&
          claims.base_ref === "" &&
          typeof claims.jti === "string" &&
          /^[!-~]{1,256}$/u.test(claims.jti),
      );
      const run = await bounded(() => this.#reader(tick)(statement), 30_000);
      assertTargetIssuanceRunProof(run, statement, iat);
      tick();
      const proof = Object.freeze({}) as HistoricalTargetIssuanceProof;
      historicalProofs.set(proof, {
        statement,
        context: c,
        run,
        iat,
        clock: this.#clock,
        last,
        wall,
        physical: physicalExpiry,
        fenced: false,
        checking: false,
      });
      assertHistoricalTargetIssuanceProof(proof, { statement, context: c });
      return proof;
    } catch {
      throw new Error("invalid-target-issuance");
    }
  }
}
