/** Protected Host DATA producer and closed native runtime. Public entrypoints accept no
 * caller origin, command, JWT, transport or policy. GitHub/runtime provenance still requires
 * the separately reviewed complete protected producer/job and native parent/process origin.
 * The current graph deliberately refuses before mint/release. */
import { createHash, createPublicKey, constants, randomBytes, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants as fsFlags,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { Agent, request as nativeRequest } from "node:https";
import { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  controllerBytes,
  controllerDigest,
  controllerJson,
  reviewedControllerCatalogue,
  type ControllerPublicBytes,
} from "./host-controller-closure.js";
import {
  buildOwnedHostController,
  prepareOwnedHostController,
  inspectOwnedHostController,
  stopOwnedHostController,
  disposeOwnedHostControllerArtifact,
  type BuiltHostController,
  type PausedHostController,
  type HostControllerInspection,
  type HostControllerPhaseInput,
  type HostControllerPhaseDeclaration,
} from "./host-controller.js";
import {
  createCurrentHostPhaseVerifier,
  currentHostPhasePins,
  type CurrentHostPhaseProof,
  type CurrentHostPhaseVerifier,
  type CurrentHostPhaseConfiguration,
} from "./host-execution-run.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import { driveOwnedHostDenial } from "./host-execution-driver.js";
import {
  assertDeniedHostExecutionPreparation,
  remainingDeniedHostExecutionPreparation,
  fenceDeniedHostExecutionPreparation,
  type DeniedHostExecutionPreparation,
} from "./host-execution-grant.js";
import {
  assertOwnedControllerExchange,
  ownedControllerExchangeBinding,
  fenceOwnedControllerExchange,
  type OwnedControllerExchange,
} from "./host-controller.js";

const error = "invalid-protected-host-execution";
const nativeWall = Date.now.bind(Date),
  nativePhysical = performance.now.bind(performance);
const nativeThen = Promise.prototype.then,
  nativeSpawn = spawnSync;
const nativeOn = EventEmitter.prototype.on,
  nativeRequestDestroy = ClientRequest.prototype.destroy,
  nativeAgentDestroy = Agent.prototype.destroy,
  nativeResponseDestroy = IncomingMessage.prototype.destroy;
const sourceRoot = resolve(import.meta.dir, "..");
const catalogue = reviewedControllerCatalogue();
const issuer = "https://token.actions.githubusercontent.com";
const jwks = `${issuer}/.well-known/jwks`;
// Owner confirmed the immutable ID-based profile. No environment value, constructor argument
// or old Seal subject rule can select another profile or provide a legacy fallback.
const reviewedSubjectProfile: "legacy" | "immutable" | undefined = "immutable";
const contexts = new WeakMap<object, ContextState>();
let activeNativeHook: HostExecutionWindow | undefined;
let activeNativeClock = false;
function requireNative(condition: unknown): asserts condition {
  if (!condition) {
    activeNativeHook?.stop();
    throw new Error(error);
  }
}
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* No then getter. */
  }
}
function entry(): void {
  if (activeNativeHook) {
    activeNativeHook.stop();
    throw new Error(error);
  }
}
/** Denial-only bridge reservation: native clock callbacks cannot enter any capability API. */
export function rejectProtectedHostExecutionClockReentry(): void {
  if (activeNativeClock) {
    activeNativeHook?.stop();
    throw new Error(error);
  }
}
export function fenceActiveProtectedHostExecutionAttempt(): void {
  activeNativeHook?.stop();
}

/** Refusal-only mechanics, never a runtime/grant constructor. Every sticky bound is anchored
 * before the SAME synchronous hook and every held timer shrinks with the original end. */
export class HostExecutionWindow {
  #physicalEnd: number;
  #wallEnd = 0;
  #last = 0;
  #fenced = false;
  #checking = false;
  #anchors: number[] = [];
  #waits = new Set<{ timer: ReturnType<typeof setTimeout> | undefined; reject: () => void }>();
  #stops = new Set<() => unknown>();
  constructor(
    milliseconds: number,
    private readonly refusal?: () => unknown,
  ) {
    const physical = nativePhysical();
    requireNative(
      Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 240_000,
    );
    this.#physicalEnd = physical + milliseconds;
    const now = this.#time();
    this.#last = now;
    this.#wallEnd = now + milliseconds;
    this.#physicalEnd = Math.min(this.#physicalEnd, physical + milliseconds);
    this.check();
  }
  alive(): void {
    requireNative(!this.#fenced && nativePhysical() < this.#physicalEnd);
  }
  #time(): number {
    this.alive();
    const prior = activeNativeHook;
    activeNativeHook = this;
    let value: unknown;
    const priorClock = activeNativeClock;
    activeNativeClock = true;
    try {
      value = nativeWall();
      this.alive();
      if (typeof value !== "number") {
        drain(value);
        throw new Error(error);
      }
      requireNative(Number.isSafeInteger(value) && value > 0);
      return value;
    } catch {
      drain(value);
      this.stop();
      throw new Error(error);
    } finally {
      activeNativeClock = priorClock;
      activeNativeHook = prior;
    }
  }
  #observe(anchor: number): void {
    this.alive();
    const at = this.#time();
    requireNative(at >= this.#last && at < this.#wallEnd);
    this.#last = at;
    this.#physicalEnd = Math.min(
      this.#physicalEnd,
      anchor + this.#wallEnd - at,
      ...this.#anchors.map((a) => a + this.#wallEnd - at),
    );
    this.alive();
    this.#rearm();
  }
  #rearm(): void {
    for (const wait of this.#waits) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.timer = setTimeout(
        () => this.stop(),
        Math.max(1, Math.ceil(this.#physicalEnd - nativePhysical())),
      );
    }
  }
  check(): void {
    let owns = false;
    try {
      this.alive();
      requireNative(!this.#checking);
      this.#checking = true;
      owns = true;
      const before = nativePhysical();
      this.#observe(before);
      if (this.refusal) {
        const prior = activeNativeHook;
        activeNativeHook = this;
        this.#anchors.push(before);
        let result: unknown;
        try {
          result = this.refusal();
          if (result !== undefined) {
            this.stop();
            drain(result);
            throw new Error(error);
          }
          this.#observe(before);
        } finally {
          this.#anchors.pop();
          activeNativeHook = prior;
        }
      }
      this.#observe(before);
    } catch {
      this.stop();
      throw new Error(error);
    } finally {
      if (owns) this.#checking = false;
    }
  }
  capture<T>(work: () => T): T {
    this.check();
    const before = nativePhysical(),
      prior = activeNativeHook;
    this.#anchors.push(before);
    activeNativeHook = this;
    let value: T | undefined,
      returned = false;
    try {
      value = work();
      returned = true;
      this.check();
      return value;
    } catch {
      if (returned) drain(value);
      this.stop();
      throw new Error(error);
    } finally {
      this.#anchors.pop();
      activeNativeHook = prior;
    }
  }
  now(): number {
    this.check();
    return this.#last;
  }
  remaining(): number {
    this.check();
    const value = Math.floor(this.#physicalEnd - nativePhysical());
    requireNative(value > 0);
    return value;
  }
  restrict(expiry: number): void {
    this.check();
    requireNative(Number.isSafeInteger(expiry) && expiry > this.#last);
    this.#wallEnd = Math.min(this.#wallEnd, expiry);
    this.#physicalEnd = Math.min(this.#physicalEnd, nativePhysical() + this.#wallEnd - this.#last);
    this.check();
  }
  stop(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    for (const wait of this.#waits) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.reject();
    }
    this.#waits.clear();
    for (const stop of this.#stops) {
      try {
        drain(stop());
      } catch {
        /* Accepted resource cleanup. */
      }
    }
    this.#stops.clear();
  }
  onStop(stop: () => unknown): () => void {
    if (this.#fenced) {
      drain(stop());
      return () => {};
    }
    this.#stops.add(stop);
    return () => {
      this.#stops.delete(stop);
    };
  }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let bound: { timer: ReturnType<typeof setTimeout> | undefined; reject: () => void } | undefined;
    const result = new Promise<{ value: T }>((resolveOwned, rejectOwned) => {
      bound = { timer: undefined, reject: () => rejectOwned(new Error(error)) };
      this.#waits.add(bound);
      this.#rearm();
      try {
        const task = this.capture(work);
        this.alive();
        Reflect.apply(nativeThen, task, [
          (value: T) => {
            try {
              this.check();
              const box = Object.create(null) as { value: T };
              Object.defineProperty(box, "value", { value });
              resolveOwned(box);
            } catch {
              this.stop();
              drain(value);
              rejectOwned(new Error(error));
            }
          },
          () => {
            this.stop();
            rejectOwned(new Error(error));
          },
        ]);
      } catch {
        this.stop();
        rejectOwned(new Error(error));
      }
    });
    try {
      const box = await result;
      this.check();
      return box.value;
    } catch {
      this.stop();
      throw new Error(error);
    } finally {
      if (bound) {
        this.#waits.delete(bound);
        if (bound.timer !== undefined) clearTimeout(bound.timer);
      }
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  requireNative(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  requireNative(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}
function text(value: unknown): string {
  requireNative(typeof value === "string");
  return value;
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export interface ProtectedHostExecutionBinding {
  // Release version/digest/schema and evaluated inputs are committed source declarations.
  // This prerequisite does not independently verify published image or database artifacts.
  declaration: Readonly<HostControllerPhaseDeclaration>;
  rootfs_sha256: string;
  recipe_sha256: string;
  configuration_sha256: string;
  release_sha256: string;
  event_sha256: string;
  evaluated_inputs_sha256: string;
  record_sha256: string;
  job_started_at: number;
  data_valid_until: number;
  context_nonce: string;
  scope: Readonly<HostExecutionScope>;
  producer_sha256: string;
}
interface HostExecutionScope {
  owner_id: number;
  repository_id: number;
  workflow_id: number;
  environment_id: number;
  run_id: string;
  run_attempt: 1;
  root_workflow_ref: string;
  root_workflow_sha: string;
  reusable_workflow_ref: string;
  reusable_workflow_sha: string;
  gate_policy_sha256: string;
}
function executionScope(capture: RuntimeCapture, origin: Origin): Readonly<HostExecutionScope> {
  return immutable({
    owner_id: capture.configuration.owner_id,
    repository_id: capture.configuration.repository_id,
    workflow_id: capture.configuration.workflow_id,
    environment_id: capture.configuration.environment_id,
    run_id: capture.declaration.release.publication_run,
    run_attempt: 1,
    root_workflow_ref: currentHostPhasePins.publication,
    root_workflow_sha: capture.declaration.release.commit,
    reusable_workflow_ref: currentHostPhasePins.host,
    reusable_workflow_sha: capture.declaration.release.config_commit,
    gate_policy_sha256: origin.gate_policy_sha256,
  });
}
declare const contextBrand: unique symbol;
export type ProtectedHostExecutionContext = Readonly<{ [contextBrand]: true }>;
interface Observation {
  url: string;
  body: Buffer;
}
interface Origin {
  job_id: number;
  check_run_id: number;
  job_started_at: number;
  critical_started_at: number;
  preparation_started_at: number;
  preparation_completed_at: number;
  observations: readonly Observation[];
  gate_policy_sha256: string;
}
interface ContextState {
  phase: "accepted" | "releasing" | "released" | "fenced";
  window: HostExecutionWindow;
  paused: PausedHostController;
  binding: ProtectedHostExecutionBinding;
  configuration: CurrentHostPhaseConfiguration;
  release: ReleaseIdentity;
  request_url: string;
  request_token: string;
  verifier: CurrentHostPhaseVerifier;
  proof: CurrentHostPhaseProof;
  origin: Origin;
  producer_files: Readonly<Record<string, Buffer>>;
  checking: boolean;
  record: {
    path: string;
    dev: number;
    ino: number;
    bytes: Buffer;
    mtime_ns: bigint;
    ctime_ns: bigint;
  };
}
function context(value: ProtectedHostExecutionContext): ContextState {
  rejectProtectedHostExecutionClockReentry();
  const saved = contexts.get(value);
  requireNative(saved && saved.phase !== "fenced");
  return saved;
}
export function fenceProtectedHostExecutionContext(value: ProtectedHostExecutionContext): void {
  // Stop paths are denial-only, including an unknown cap supplied from a swallowed hook.
  fenceActiveProtectedHostExecutionAttempt();
  const saved = contexts.get(value);
  if (saved) {
    saved.phase = "fenced";
    saved.window.stop();
  }
}
function checkContextData(saved: ContextState): void {
  saved.window.check();
  requireNative(saved.window.now() < saved.binding.data_valid_until);
  const read = ownedRead(saved.record.path, saved.window, true);
  requireNative(
    read.dev === saved.record.dev &&
      read.ino === saved.record.ino &&
      read.mtime_ns === saved.record.mtime_ns &&
      read.ctime_ns === saved.record.ctime_ns &&
      read.bytes.equals(saved.record.bytes),
  );
  saved.window.check();
}
function withinContextCheck(
  value: ProtectedHostExecutionContext,
  work: (saved: ContextState) => void,
): void {
  let saved: ContextState | undefined,
    owns = false;
  try {
    saved = context(value);
    requireNative(!saved.checking);
    saved.checking = true;
    owns = true;
    work(saved);
    requireNative(saved.phase !== "fenced");
  } catch {
    fenceProtectedHostExecutionContext(value);
    throw new Error(error);
  } finally {
    if (owns && saved) saved.checking = false;
  }
}
function checkContextProof(saved: ContextState): void {
  checkContextData(saved);
  saved.verifier.assert(saved.proof, { release: saved.release, phase: "execution" });
  checkContextData(saved);
}
/** DATA/window only: retained verifier clocks must never recurse through proof assertion. */
export function assertProtectedHostExecutionContextData(
  value: ProtectedHostExecutionContext,
): void {
  withinContextCheck(value, checkContextData);
}
export function assertProtectedHostExecutionContext(value: ProtectedHostExecutionContext): void {
  withinContextCheck(value, checkContextProof);
}
export function remainingProtectedHostExecutionContext(
  value: ProtectedHostExecutionContext,
): number {
  let result = 0;
  withinContextCheck(value, (saved) => {
    checkContextProof(saved);
    result = saved.window.remaining();
  });
  return result;
}
export function protectedHostExecutionBinding(
  value: ProtectedHostExecutionContext,
): Readonly<ProtectedHostExecutionBinding> {
  let result: ProtectedHostExecutionBinding | undefined;
  withinContextCheck(value, (saved) => {
    checkContextProof(saved);
    result = saved.binding;
  });
  requireNative(result);
  return result;
}
export function reserveProtectedHostControllerRelease(
  value: ProtectedHostExecutionContext,
  paused: PausedHostController,
  inspection: HostControllerInspection,
): void {
  withinContextCheck(value, (saved) => {
    requireNative(saved.phase === "accepted");
    saved.phase = "releasing";
    checkContextProof(saved);
    requireNative(saved.paused === paused);
    saved.window.capture(() => {
      requireNative(
        inspection.kind === "paused" &&
          inspection.rootfs_sha256 === saved.binding.rootfs_sha256 &&
          inspection.recipe_sha256 === saved.binding.recipe_sha256 &&
          inspection.configuration_sha256 === saved.binding.configuration_sha256 &&
          inspection.release_sha256 === saved.binding.release_sha256 &&
          JSON.stringify(inspection.declaration) === JSON.stringify(saved.binding.declaration),
      );
    });
    checkContextProof(saved);
  });
}
export function completeProtectedHostControllerRelease(
  value: ProtectedHostExecutionContext,
  paused: PausedHostController,
): void {
  withinContextCheck(value, (saved) => {
    requireNative(saved.phase === "releasing" && saved.paused === paused);
    checkContextProof(saved);
    saved.phase = "released";
  });
}

interface NativeResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  url: string;
}
/** Closed direct HTTPS: no ambient proxy/credentials, retry, toolkit, redirect or diagnostic URL. */
async function nativeRead(
  url: string,
  window: HostExecutionWindow,
  maximum: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<NativeResponse> {
  return window.wait(
    () =>
      new Promise<NativeResponse>((resolveOwned, rejectOwned) => {
        let finished = false,
          agent: Agent | undefined,
          request: ClientRequest | undefined,
          incoming: IncomingMessage | undefined;
        let unwatch: (() => void) | undefined;
        // Ownership is installed at the actual native return, before its post-hook barrier.
        // Cleanup never depends on a later public method getter or a successful capture.
        const dispose = () => {
          const ownedRequest = request,
            ownedIncoming = incoming,
            ownedAgent = agent;
          request = undefined;
          incoming = undefined;
          agent = undefined;
          if (ownedRequest) {
            try {
              Reflect.apply(nativeRequestDestroy, ownedRequest, []);
            } catch {
              /* Accepted request cleanup. */
            }
          }
          if (ownedIncoming) {
            try {
              Reflect.apply(nativeResponseDestroy, ownedIncoming, []);
            } catch {
              /* Accepted response cleanup. */
            }
          }
          if (ownedAgent) {
            try {
              Reflect.apply(nativeAgentDestroy, ownedAgent, []);
            } catch {
              /* Accepted agent cleanup. */
            }
          }
        };
        const finish = (value?: NativeResponse) => {
          if (finished) return;
          finished = true;
          unwatch?.();
          dispose();
          if (value) resolveOwned(value);
          else {
            window.stop();
            rejectOwned(new Error(error));
          }
        };
        try {
          unwatch = window.onStop(() => finish());
          const address = window.capture(() => new URL(url));
          requireNative(
            address.protocol === "https:" &&
              !address.username &&
              !address.password &&
              !address.hash &&
              (!address.port || address.port === "443"),
          );
          window.capture(() => {
            agent = new Agent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true });
            Reflect.apply(nativeOn, agent, ["error", () => {}]);
          });
          const options = window.capture(() => ({
            method: "GET",
            agent,
            rejectUnauthorized: true,
            maxHeaderSize: 16_384,
            headers: {
              "Accept-Encoding": "identity",
              "Cache-Control": "no-cache",
              "User-Agent": "TaruBot-protected-host-denial-v1",
              ...headers,
            },
          }));
          const responseOwned = (response: import("node:http").IncomingMessage) => {
            try {
              incoming = response;
              Reflect.apply(nativeOn, response, ["error", () => {}]);
              Reflect.apply(nativeOn, response, ["aborted", () => {}]);
              if (finished) {
                dispose();
                return;
              }
              window.check();
              const status = window.capture(() => response.statusCode);
              requireNative(
                typeof status === "number" &&
                  Number.isSafeInteger(status) &&
                  status >= 100 &&
                  status <= 599,
              );
              const raw = window.capture(() => response.rawHeaders);
              const headerCount = window.capture(() => raw.length);
              requireNative(Array.isArray(raw) && headerCount % 2 === 0 && headerCount <= 200);
              const output: Record<string, string> = Object.create(null);
              let size = 0;
              for (let index = 0; index < headerCount; index += 2) {
                const name = window.capture(() => raw[index]),
                  value = window.capture(() => raw[index + 1]);
                requireNative(
                  typeof name === "string" &&
                    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) &&
                    typeof value === "string" &&
                    !/[\0\r\n]/u.test(value),
                );
                const lower = name.toLowerCase();
                requireNative(!Object.hasOwn(output, lower));
                size += Buffer.byteLength(name) + Buffer.byteLength(value);
                requireNative(size <= 16_384);
                output[lower] = value;
              }
              const received = Object.freeze(output);
              const on = window.capture(() => response.on.bind(response));
              requireNative(
                Number.isSafeInteger(status) &&
                  status >= 100 &&
                  status <= 599 &&
                  received["content-encoding"] === undefined,
              );
              let length = 0;
              const chunks: Buffer[] = [];
              window.capture(() =>
                on("data", (chunk) => {
                  try {
                    window.capture(() => {
                      const bytes = controllerBytes(chunk, maximum);
                      length += bytes.length;
                      requireNative(length <= maximum);
                      chunks.push(bytes);
                    });
                  } catch {
                    finish();
                  }
                }),
              );
              window.capture(() =>
                on("end", () => {
                  try {
                    const body = window.capture(() => Buffer.concat(chunks, length));
                    if (received["content-length"] !== undefined)
                      requireNative(
                        /^(0|[1-9][0-9]{0,9})$/u.test(received["content-length"]) &&
                          Number(received["content-length"]) === length,
                      );
                    window.check();
                    finish({ status: status as number, headers: received, body, url });
                  } catch {
                    finish();
                  }
                }),
              );
              window.capture(() => on("error", () => finish()));
              window.capture(() => on("aborted", () => finish()));
            } catch {
              finish();
            }
          };
          window.capture(() => {
            window.check();
            request = nativeRequest(address, options, responseOwned);
            Reflect.apply(nativeOn, request, ["error", () => {}]);
            if (finished) dispose();
          });
          requireNative(request && !finished);
          const acceptedRequest = request;
          const on = window.capture(() => acceptedRequest.on.bind(acceptedRequest));
          const end = window.capture(() => acceptedRequest.end.bind(acceptedRequest));
          window.capture(() => on("error", () => finish()));
          window.capture(() => {
            window.check();
            end();
          });
        } catch {
          finish();
          dispose();
        }
      }),
  );
}

const publicCdnHosts = new Set([
  "production.cloudfront.docker.com",
  "production.cloudflare.docker.com",
  "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
]);
/** Routing DATA only. CloudFront is currently published; the other exact hosts have reviewed
 * historical official Docker documentation. This is not a promise of current availability. */
export function hostControllerPublicBlobRedirectData(raw: string, digest: string): string {
  requireNative(/^[a-f0-9]{64}$/u.test(digest) && typeof raw === "string" && raw.length <= 8192);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(error);
  }
  requireNative(
    url.protocol === "https:" &&
      publicCdnHosts.has(url.hostname) &&
      (!url.port || url.port === "443") &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === raw,
  );
  requireNative(
    url.pathname ===
      `/registry-v2/docker/registry/v2/blobs/sha256/${digest.slice(0, 2)}/${digest}/data`,
  );
  requireNative(
    !/\\|%(?:00|0a|0d|2f|5c)/iu.test(url.pathname) &&
      url.search.length > 1 &&
      url.search.length <= 4096,
  );
  const keys = [...url.searchParams.keys()];
  requireNative(
    new Set(keys).size === keys.length && keys.every((key) => /^[A-Za-z0-9_-]{1,64}$/u.test(key)),
  );
  return raw;
}
async function acquirePublicControllerBytes(): Promise<ControllerPublicBytes> {
  const window = new HostExecutionWindow(240_000);
  try {
    const tokenResponse = await nativeRead(
      "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fpython%3Apull",
      window,
      16_384,
    );
    requireNative(tokenResponse.status === 200);
    const token = text(object(controllerJson(tokenResponse.body)).token);
    requireNative(token.length <= 8192 && /^[!-~]+$/u.test(token));
    const registryHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.oci.image.manifest.v1+json",
    };
    const manifestResponse = await nativeRead(
      `https://registry-1.docker.io/v2/library/python/manifests/sha256:${catalogue.base.manifest_sha256}`,
      window,
      2 * 1024 * 1024,
      registryHeaders,
    );
    requireNative(
      manifestResponse.status === 200 &&
        controllerDigest(manifestResponse.body) === catalogue.base.manifest_sha256,
    );
    const manifest = object(controllerJson(manifestResponse.body));
    const configDescriptor = object(manifest.config),
      layerDescriptors = manifest.layers;
    requireNative(
      Array.isArray(layerDescriptors) &&
        layerDescriptors.length === 4 &&
        configDescriptor.digest === `sha256:${catalogue.base.config_sha256}`,
    );
    const blob = async (digest: string, size: number): Promise<Buffer> => {
      integer(size);
      requireNative(size <= 64 * 1024 * 1024);
      let response = await nativeRead(
        `https://registry-1.docker.io/v2/library/python/blobs/sha256:${digest}`,
        window,
        size,
        registryHeaders,
      );
      if (response.status === 307) {
        const redirect = window.capture(() =>
          hostControllerPublicBlobRedirectData(text(response.headers.location), digest),
        );
        // New request: never forward the anonymous registry bearer, cookies or headers.
        response = await nativeRead(redirect, window, size);
      }
      requireNative(
        response.status === 200 &&
          response.headers.location === undefined &&
          response.body.length === size &&
          controllerDigest(response.body) === digest,
      );
      window.check();
      return response.body;
    };
    const config = await blob(catalogue.base.config_sha256, integer(configDescriptor.size));
    const layers: Buffer[] = [];
    for (const [index, pin] of catalogue.base.layers.entries()) {
      const descriptor = object(layerDescriptors[index]);
      requireNative(
        descriptor.digest === `sha256:${pin.sha256}` &&
          descriptor.mediaType === "application/vnd.oci.image.layer.v1.tar+gzip",
      );
      layers.push(await blob(pin.sha256, integer(descriptor.size)));
    }
    const wheels: Record<string, Buffer> = {};
    for (const pin of catalogue.wheels) {
      requireNative(new URL(pin.url).origin === "https://files.pythonhosted.org");
      const response = await nativeRead(pin.url, window, pin.size);
      requireNative(
        response.status === 200 &&
          response.headers.location === undefined &&
          response.body.length === pin.size &&
          controllerDigest(response.body) === pin.sha256,
      );
      wheels[pin.filename] = response.body;
    }
    window.check();
    return { manifest: manifestResponse.body, config, layers, wheels };
  } catch {
    window.stop();
    throw new Error(error);
  }
}

/** Pure authenticated object DATA, not a native Git/phase/context constructor. */
export function hostGitObjectData(
  raw: Uint8Array,
  expected: string,
  kind: "commit" | "tree" | "blob",
): Buffer {
  const bytes = controllerBytes(raw, 16 * 1024 * 1024);
  requireNative(/^[a-f0-9]{40}$/u.test(expected));
  const newline = bytes.indexOf(10);
  requireNative(newline > 0 && newline < 100);
  const header = bytes.subarray(0, newline).toString("ascii");
  const match = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]{0,8})$/u.exec(header);
  requireNative(match && match[1] === expected && match[2] === kind);
  const size = Number(match[3]);
  requireNative(bytes.length === newline + 1 + size + 1 && bytes[bytes.length - 1] === 10);
  const body = Buffer.from(bytes.subarray(newline + 1, newline + 1 + size));
  requireNative(
    createHash("sha1").update(`${kind} ${size}\0`).update(body).digest("hex") === expected,
  );
  return body;
}
function gitObject(
  sha: string,
  kind: "commit" | "tree" | "blob",
  window: HostExecutionWindow,
): Buffer {
  requireNative(/^[a-f0-9]{40}$/u.test(sha));
  const arguments_ = window.capture(() => [
    "--no-lazy-fetch",
    "--no-replace-objects",
    "-C",
    sourceRoot,
    "cat-file",
    "--batch",
  ]);
  const options = window.capture(() => ({
    cwd: sourceRoot,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
    input: Buffer.from(`${sha}\n`),
    timeout: window.remaining(),
    maxBuffer: 16 * 1024 * 1024,
  }));
  const result = window.capture(() => {
    window.check();
    return nativeSpawn("/usr/bin/git", arguments_, options);
  });
  const bytes = window.capture(() => {
    requireNative(result.status === 0 && !result.error);
    return controllerBytes(result.stdout, 16 * 1024 * 1024);
  });
  return window.capture(() => hostGitObjectData(bytes, sha, kind));
}
function treeEntries(bytes: Buffer): Map<string, { mode: string; sha: string }> {
  const rows = new Map<string, { mode: string; sha: string }>();
  let at = 0,
    prior = "";
  while (at < bytes.length) {
    const nul = bytes.indexOf(0, at);
    requireNative(nul > at && nul - at <= 300 && nul + 21 <= bytes.length);
    const entry = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, nul));
    const matched = /^(40000|100644|100755|120000|160000) ([^/\0]+)$/u.exec(entry);
    requireNative(matched?.[2]);
    const name = matched[2];
    requireNative(name !== "." && name !== ".." && !rows.has(name));
    const ordering = `${name}${matched[1] === "40000" ? "/" : ""}`;
    requireNative(prior === "" || Buffer.compare(Buffer.from(prior), Buffer.from(ordering)) < 0);
    prior = ordering;
    rows.set(name, {
      mode: matched[1] as string,
      sha: bytes.subarray(nul + 1, nul + 21).toString("hex"),
    });
    at = nul + 21;
  }
  requireNative(at === bytes.length);
  return rows;
}
const configurationPaths = [
  "ops/ansible/site.yml",
  "ops/ansible/vars/layout.yml",
  "ops/ansible/templates/dnf-automatic.conf.j2",
  "ops/ansible/files/dnf-automatic-timer-production.conf",
  "ops/ansible/files/sysctl-tarubot.conf",
  "ops/ansible/files/journald-tarubot.conf",
  "ops/ansible/files/multi-user-network-online.conf",
  "ops/ansible/files/tarubot-ipv6-online",
  "ops/ansible/files/tarubot-ipv6-online.service",
  "ops/ansible/files/sshd-00-tarubot.conf",
  "ops/ansible/files/polkit-10-tarubot.rules",
];
const releasePaths = [
  "ops/ansible/bot.yml",
  "ops/ansible/accept.yml",
  "ops/ansible/vars/bot.yml",
  "ops/ansible/vars/targets/staging.yml",
  "ops/ansible/templates/bot/tarubot.env.j2",
  "ops/ansible/templates/bot/tarubot.container.j2",
  "ops/ansible/files/bot/tarubot-tool",
  "ops/ansible/files/bot/tarubot-backup",
  "ops/ansible/files/bot/tarubot-backup.service",
  "ops/ansible/files/bot/tarubot-backup.timer",
  "ops/age-recipients.txt",
];
const producerPaths = [
  ".github/workflows/publish.yml",
  ".github/workflows/release.yml",
  ".github/workflows/release-infra.yml",
  ".github/workflows/host.yml",
  "scripts/host-execution-runtime.ts",
  "scripts/host-execution-grant.ts",
  "scripts/host-execution-driver.ts",
  "scripts/host-execution-run.ts",
  "scripts/release-policy.ts",
  "scripts/host-controller.ts",
  "scripts/host-controller-closure.ts",
  "ops/host-controller/Containerfile",
  "ops/host-controller/assemble.py",
  "ops/host-controller/launcher.py",
  "ops/host-controller/pins.json",
  "ops/ansible/connection_plugins/tarubot_guarded.py",
  "ops/ansible/connection_plugins/_tarubot_frames.py",
  "package.json",
  "bun.lock",
  "tsconfig.json",
];
function gitClosure(
  commit: string,
  paths: readonly string[],
  window: HostExecutionWindow,
): Record<string, Buffer> {
  const raw = gitObject(commit, "commit", window);
  const header = raw.subarray(0, raw.indexOf(10)).toString("ascii");
  const matched = /^tree ([a-f0-9]{40})$/u.exec(header);
  requireNative(matched?.[1]);
  const cache = new Map<string, Map<string, { mode: string; sha: string }>>();
  const tree = (sha: string) => {
    let rows = cache.get(sha);
    if (!rows) {
      rows = window.capture(() => treeEntries(gitObject(sha, "tree", window)));
      cache.set(sha, rows);
    }
    return rows;
  };
  const result: Record<string, Buffer> = {};
  for (const path of paths) {
    let sha = matched[1];
    const parts = path.split("/");
    const mode = [
      "ops/ansible/files/bot/tarubot-tool",
      "ops/ansible/files/bot/tarubot-backup",
    ].includes(path)
      ? "100755"
      : "100644";
    for (const [index, part] of parts.entries()) {
      const row = tree(sha).get(part);
      requireNative(row && row.mode === (index === parts.length - 1 ? mode : "40000"));
      sha = row.sha;
    }
    const bytes = gitObject(sha, "blob", window);
    requireNative(bytes.length <= 2 * 1024 * 1024);
    const current = ownedRead(join(sourceRoot, path), window, false).bytes;
    requireNative(bytes.equals(current));
    result[path] = bytes;
  }
  return result;
}
function fileCommitment(files: Readonly<Record<string, Uint8Array>>): string {
  return controllerDigest(
    Buffer.from(
      JSON.stringify(
        Object.entries(files)
          .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map(([path, bytes]) => [path, controllerDigest(bytes), bytes.byteLength]),
      ),
    ),
  );
}

interface RuntimeCapture {
  declaration: HostControllerPhaseDeclaration;
  configuration: CurrentHostPhaseConfiguration;
  event: Buffer;
  event_sha256: string;
  evaluated_inputs_sha256: string;
  request_url: string;
  request_token: string;
  private_directory: string;
  files: HostControllerPhaseInput;
  producer_sha256: string;
  producer_files: Readonly<Record<string, Buffer>>;
}
function subject(configuration: CurrentHostPhaseConfiguration): string {
  const selected: unknown = reviewedSubjectProfile;
  requireNative(selected === "legacy" || selected === "immutable");
  return selected === "legacy"
    ? "repo:deconfined/tarubot:environment:staging"
    : `repo:deconfined@${configuration.owner_id}/tarubot@${configuration.repository_id}:environment:staging`;
}
function profileConfigured(): void {
  const selected: unknown = reviewedSubjectProfile;
  requireNative(selected === "legacy" || selected === "immutable");
}
function stageDiscriminator(): void {
  const window = new HostExecutionWindow(30000);
  try {
    const selected = window.capture(() => ({
      target: window.capture(() => process.env.TB_HOST_TARGET),
      action: window.capture(() => process.env.TB_HOST_ACTION),
      accept: window.capture(() => process.env.TB_HOST_ACCEPT_RELEASE),
    }));
    requireNative(
      selected.target === "staging" && selected.action === "deploy" && selected.accept === "true",
    );
  } finally {
    window.stop();
  }
}
function safePrivateRoot(path: string, window: HostExecutionWindow): void {
  requireNative(path.startsWith("/") && resolve(path) === path);
  for (let current = path; current !== "/"; current = dirname(current)) {
    const stat = window.capture(() => lstatSync(current));
    requireNative(!stat.isSymbolicLink() && stat.isDirectory());
  }
  const stat = window.capture(() => lstatSync(path));
  requireNative(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
}
function ownedRead(
  path: string,
  window: HostExecutionWindow,
  privateMode: boolean,
): { bytes: Buffer; dev: number; ino: number; size: number; mtime_ns: bigint; ctime_ns: bigint } {
  for (let current = dirname(path); current !== "/"; current = dirname(current)) {
    const stat = window.capture(() => lstatSync(current));
    requireNative(!stat.isSymbolicLink() && stat.isDirectory());
  }
  let fd: number | undefined;
  try {
    // Linux O_CLOEXEC is not exposed by Node's constants typings. The native runtime is Linux.
    window.capture(() => {
      window.check();
      fd = openSync(path, fsFlags.O_RDONLY | fsFlags.O_NOFOLLOW | 0x80000);
    });
    requireNative(fd !== undefined);
    const ownedFd = fd;
    const stat = window.capture(() => fstatSync(ownedFd));
    requireNative(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        stat.nlink === 1 &&
        stat.size <= 2 * 1024 * 1024 &&
        (privateMode ? (stat.mode & 0o777) === 0o600 : (stat.mode & 0o022) === 0),
    );
    const exactTime = window.capture(() => fstatSync(ownedFd, { bigint: true }));
    requireNative(
      exactTime.dev === BigInt(stat.dev) &&
        exactTime.ino === BigInt(stat.ino) &&
        exactTime.size === BigInt(stat.size),
    );
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const count = window.capture(() => {
        window.check();
        return readSync(ownedFd, bytes, at, bytes.length - at, at);
      });
      requireNative(count > 0);
      at += count;
    }
    const extra = window.capture(() => {
      window.check();
      return readSync(ownedFd, Buffer.alloc(1), 0, 1, at);
    });
    requireNative(extra === 0);
    const after = window.capture(() => fstatSync(ownedFd));
    requireNative(
      after.dev === stat.dev &&
        after.ino === stat.ino &&
        after.size === stat.size &&
        after.nlink === 1 &&
        after.mode === stat.mode &&
        after.uid === stat.uid,
    );
    const afterTime = window.capture(() => fstatSync(ownedFd, { bigint: true }));
    requireNative(
      afterTime.mtimeNs === exactTime.mtimeNs &&
        afterTime.ctimeNs === exactTime.ctimeNs &&
        afterTime.dev === exactTime.dev &&
        afterTime.ino === exactTime.ino &&
        afterTime.size === exactTime.size,
    );
    return {
      bytes,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtime_ns: exactTime.mtimeNs,
      ctime_ns: exactTime.ctimeNs,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function runtimeCapture(window: HostExecutionWindow): RuntimeCapture {
  const names = [
    "GITHUB_EVENT_PATH",
    "RUNNER_TEMP",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_REF_TYPE",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_JOB",
    "TB_HOST_WORKFLOW_ID",
    "TB_HOST_ENVIRONMENT_ID",
    "TB_HOST_TARGET",
    "TB_HOST_ACTION",
    "TB_HOST_ACCEPT_RELEASE",
    "TB_HOST_PHASE",
    "TB_RELEASE_VERSION",
    "TB_RELEASE_COMMIT",
    "TB_RELEASE_DIGEST",
    "TB_RELEASE_CONFIG_COMMIT",
    "TB_RELEASE_PUBLICATION_RUN",
    "TB_RELEASE_SCHEMA_HEAD",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ];
  const env = window.capture(() => {
    const result: Record<string, string> = {};
    for (const name of names) {
      // A shortened bound observed by one native-shaped getter must stop later fields,
      // particularly the runner's read and mint bearers, before their getters are offered.
      const value = window.capture(() => process.env[name]);
      requireNative(
        typeof value === "string" &&
          value.length > 0 &&
          value.length <= 16_384 &&
          !/[\0\r\n]/u.test(value),
      );
      // Repeat the fixed discriminators during the protected capture. Software acquisition
      // occurs after preflight, so a changed input must stop before later bearer getters.
      if (name === "TB_HOST_TARGET") requireNative(value === "staging");
      if (name === "TB_HOST_ACTION") requireNative(value === "deploy");
      if (name === "TB_HOST_ACCEPT_RELEASE") requireNative(value === "true");
      result[name] = value;
    }
    return result;
  });
  requireNative(
    env.GITHUB_REPOSITORY === "deconfined/tarubot" &&
      env.GITHUB_REPOSITORY_OWNER === "deconfined" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_REF_TYPE === "branch" &&
      env.GITHUB_EVENT_NAME === "push" &&
      env.GITHUB_RUN_ATTEMPT === "1" &&
      env.GITHUB_JOB === "host",
  );
  requireNative(
    env.TB_HOST_TARGET === "staging" &&
      env.TB_HOST_ACTION === "deploy" &&
      env.TB_HOST_ACCEPT_RELEASE === "true",
  );
  const release = window.capture(() =>
    releaseIdentity({
      version: env.TB_RELEASE_VERSION,
      commit: env.TB_RELEASE_COMMIT,
      digest: env.TB_RELEASE_DIGEST,
      config_commit: env.TB_RELEASE_CONFIG_COMMIT,
      publication_run: env.TB_RELEASE_PUBLICATION_RUN,
      schema_head: env.TB_RELEASE_SCHEMA_HEAD,
    }),
  );
  requireNative(
    env.GITHUB_SHA === release.commit &&
      env.GITHUB_WORKFLOW_SHA === release.commit &&
      env.GITHUB_RUN_ID === release.publication_run &&
      env.GITHUB_WORKFLOW_REF === currentHostPhasePins.publication,
  );
  const numeric = (name: string) => {
    const value = env[name];
    requireNative(value && /^[1-9][0-9]{0,15}$/u.test(value));
    const id = Number(value);
    integer(id);
    requireNative(String(id) === value);
    return id;
  };
  const configuration: CurrentHostPhaseConfiguration = {
    target: "staging",
    owner_id: numeric("GITHUB_REPOSITORY_OWNER_ID"),
    repository_id: numeric("GITHUB_REPOSITORY_ID"),
    workflow_id: numeric("TB_HOST_WORKFLOW_ID"),
    environment_id: numeric("TB_HOST_ENVIRONMENT_ID"),
    token: text(env.GITHUB_TOKEN),
  };
  subject(configuration);
  const phase = env.TB_HOST_PHASE;
  requireNative(phase === "site" || phase === "bot" || phase === "accept");
  const declaration: HostControllerPhaseDeclaration = {
    schema: 1,
    purpose: "tarubot-host-controller-phase-v1",
    target: "staging",
    action: "deploy",
    phase,
    phase_number: ["site", "bot", "accept"].indexOf(phase) as 0 | 1 | 2,
    accept_release: true,
    configuration: { commit: release.config_commit },
    release,
  };
  const eventPath = text(env.GITHUB_EVENT_PATH);
  requireNative(resolve(eventPath) === eventPath);
  const eventSnapshot = ownedRead(eventPath, window, false);
  const event = object(controllerJson(eventSnapshot.bytes));
  const repository = object(event.repository),
    owner = object(repository.owner),
    commit = object(event.head_commit);
  requireNative(
    event.ref === "refs/heads/main" &&
      event.after === release.commit &&
      event.deleted === false &&
      event.forced === false &&
      commit.id === release.commit &&
      repository.full_name === "deconfined/tarubot" &&
      repository.id === configuration.repository_id &&
      owner.id === configuration.owner_id &&
      owner.login === "deconfined",
  );
  const producer = gitClosure(release.config_commit, producerPaths, window);
  const configurationFiles = gitClosure(release.config_commit, configurationPaths, window),
    releaseFiles = gitClosure(release.commit, releasePaths, window);
  const reread = ownedRead(eventPath, window, false);
  requireNative(
    reread.dev === eventSnapshot.dev &&
      reread.ino === eventSnapshot.ino &&
      reread.mtime_ns === eventSnapshot.mtime_ns &&
      reread.ctime_ns === eventSnapshot.ctime_ns &&
      reread.bytes.equals(eventSnapshot.bytes),
  );
  const temporary = text(env.RUNNER_TEMP);
  requireNative(resolve(temporary) === temporary);
  const rootStat = window.capture(() => lstatSync(temporary));
  requireNative(
    rootStat.isDirectory() &&
      !rootStat.isSymbolicLink() &&
      rootStat.uid === process.getuid?.() &&
      (rootStat.mode & 0o022) === 0,
  );
  const privateDirectory = join(
    temporary,
    `tarubot-host-denial-${release.publication_run}-${declaration.phase_number}`,
  );
  return {
    declaration: immutable(declaration),
    configuration,
    event: eventSnapshot.bytes,
    event_sha256: controllerDigest(eventSnapshot.bytes),
    evaluated_inputs_sha256: controllerDigest(
      Buffer.from(
        JSON.stringify({
          declaration,
          workflow_id: configuration.workflow_id,
          environment_id: configuration.environment_id,
        }),
      ),
    ),
    request_url: text(env.ACTIONS_ID_TOKEN_REQUEST_URL),
    request_token: text(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
    private_directory: privateDirectory,
    files: { declaration, configuration_files: configurationFiles, release_files: releaseFiles },
    producer_sha256: fileCommitment(producer),
    producer_files: producer,
  };
}
async function phaseObservation(
  capture: RuntimeCapture,
  phase: "preparation" | "execution",
  window: HostExecutionWindow,
): Promise<{ verifier: CurrentHostPhaseVerifier; proof: CurrentHostPhaseProof; origin: Origin }> {
  const saved: Observation[] = [];
  const verifier = window.capture(() =>
    createCurrentHostPhaseVerifier(capture.configuration, {
      now: () => window.now(),
      get: async (request) => {
        const input = window.capture(() => ({ url: request.url, headers: { ...request.headers } }));
        requireNative(input.url.startsWith("https://api.github.com/repos/deconfined/tarubot"));
        const response = await nativeRead(input.url, window, 1_048_576, input.headers);
        const bytes = window.capture(() => controllerBytes(response.body, 1_048_576));
        saved.push({ url: input.url, body: Buffer.from(bytes) });
        // Both snapshots derive from precisely the same owned response bytes. No public evidence
        // or reconstruction bridge can substitute caller JSON after the verifier succeeds.
        return {
          status: response.status,
          url: response.url,
          headers: response.headers,
          body: bytes,
        };
      },
    }),
  );
  const proof = await window.wait(() =>
    verifier.verify({ release: capture.declaration.release, phase }, () => {
      window.check();
    }),
  );
  requireNative(saved.length === 16);
  const row = saved.find((read) => read.url.includes("/attempts/1/jobs?"));
  requireNative(row);
  const page = object(controllerJson(row.body));
  requireNative(Array.isArray(page.jobs));
  const jobs = page.jobs.map(object).filter((job) => job.name === currentHostPhasePins.job);
  requireNative(jobs.length === 1 && jobs[0]);
  const job = jobs[0];
  requireNative(Array.isArray(job.steps));
  const steps = job.steps.map(object);
  const step = (name: string) => {
    const rows = steps.filter((row) => row.name === name);
    requireNative(rows.length === 1 && rows[0]);
    return rows[0];
  };
  const prep = step(currentHostPhasePins.preparation),
    critical = phase === "execution" ? step(currentHostPhasePins.execution) : prep;
  const time = (value: unknown) => {
    const at = Date.parse(text(value));
    requireNative(Number.isSafeInteger(at) && at > 0);
    return at;
  };
  const origin: Origin = {
    job_id: integer(job.id),
    check_run_id: integer(Number(text(job.check_run_url).split("/").at(-1))),
    job_started_at: time(job.started_at),
    critical_started_at: time(critical.started_at),
    preparation_started_at: time(prep.started_at),
    preparation_completed_at: phase === "execution" ? time(prep.completed_at) : 0,
    observations: saved,
    gate_policy_sha256: controllerDigest(
      Buffer.from(
        JSON.stringify(
          saved
            .filter(
              (read) =>
                read.url === "https://api.github.com/repos/deconfined/tarubot" ||
                read.url === "https://api.github.com/repos/deconfined/tarubot/branches/main" ||
                read.url ===
                  "https://api.github.com/repos/deconfined/tarubot/environments/staging" ||
                read.url.includes("/environments/staging/deployment-branch-policies?"),
            )
            .map((read) => [read.url, controllerDigest(read.body)]),
        ),
      ),
    ),
  };
  verifier.assert(proof, { release: capture.declaration.release, phase });
  window.check();
  return { verifier, proof, origin };
}

const prepPurpose = "tarubot-host-preparation-data-v1",
  prepAudience = "urn:tarubot:host-preparation-data:v1:";
const denialPurpose = "tarubot-host-execution-denial-v1",
  denialAudience = "urn:tarubot:host-execution-denial:v1:";
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  const data = object(value);
  requireNative(
    Object.keys(data).length === names.length && names.every((name) => Object.hasOwn(data, name)),
  );
  return data;
}
function base64url(value: unknown, maximum: number): Buffer {
  requireNative(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= Math.ceil(maximum / 3) * 4 &&
      /^[A-Za-z0-9_-]+$/u.test(value),
  );
  const bytes = Buffer.from(value, "base64url");
  requireNative(bytes.length <= maximum && bytes.toString("base64url") === value);
  return bytes;
}
/** Pure routing DATA. This fixed hosted-runner policy is not a promise of a stable mint path. */
export function hostExecutionAudienceUrlData(input: string, audience: string): string {
  try {
    requireNative(
      typeof input === "string" &&
        input.length <= 8192 &&
        /^[!-~]+$/u.test(input) &&
        !input.endsWith("?"),
    );
    requireNative(
      /^(?:urn:tarubot:host-preparation-data:v1:|urn:tarubot:host-execution-denial:v1:)[a-f0-9]{64}$/u.test(
        audience,
      ),
    );
    const url = new URL(input),
      labels = url.hostname.split(".");
    requireNative(
      url.protocol === "https:" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.hash &&
        (url.href === input || input === url.href.replace(`//${url.host}/`, `//${url.host}:443/`)),
    );
    requireNative(
      labels.length >= 4 &&
        labels.slice(-3).join(".") === "actions.githubusercontent.com" &&
        labels.every(
          (label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) && !label.startsWith("xn--"),
        ),
    );
    requireNative(
      url.pathname !== "/" && !/\\|%2f|%5c|%00|%25|(?:^|\/)\.{1,2}(?:\/|$)/iu.test(url.pathname),
    );
    const decoded = decodeURIComponent(url.pathname);
    requireNative(
      /^[!-~]+$/u.test(decoded) &&
        !/[\\?#%]/u.test(decoded) &&
        !/%(?![A-F0-9]{2})/u.test(url.pathname),
    );
    for (const octet of url.pathname.match(/%[A-F0-9]{2}/gu) ?? [])
      requireNative(!/^[A-Za-z0-9._~-]$/u.test(decodeURIComponent(octet)));
    const names = new Set<string>();
    for (const pair of url.search.slice(1).split("&").filter(Boolean)) {
      const parts = pair.split("=");
      requireNative(parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined);
      const name = decodeURIComponent(parts[0]),
        value = decodeURIComponent(parts[1]);
      requireNative(
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) &&
          name.toLowerCase() !== "audience" &&
          !names.has(name.toLowerCase()) &&
          parts[0] === encodeURIComponent(name) &&
          parts[1] === encodeURIComponent(value) &&
          /^[ -~]*$/u.test(value),
      );
      names.add(name.toLowerCase());
      requireNative(names.size <= 32);
    }
    requireNative(!url.search.endsWith("&") && !url.search.includes("&&"));
    return `${input}${url.search ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  } catch {
    throw new Error(error);
  }
}
function statementAudience(
  statement: Readonly<Record<string, unknown>>,
  purpose: typeof prepPurpose | typeof denialPurpose,
): string {
  requireNative(statement.purpose === purpose);
  return `${purpose === prepPurpose ? prepAudience : denialAudience}${controllerDigest(Buffer.from(JSON.stringify(statement)))}`;
}
function signingKey(bytes: Buffer, kid: string): ReturnType<typeof createPublicKey> {
  const document = exact(controllerJson(bytes), ["keys"]);
  requireNative(
    Array.isArray(document.keys) && document.keys.length > 0 && document.keys.length <= 20,
  );
  const selected = document.keys.map(object).filter((key) => key.kid === kid);
  const key = selected[0];
  requireNative(selected.length === 1 && key);
  requireNative(
    Object.keys(key).every((name) =>
      ["kid", "kty", "use", "alg", "n", "e", "x5c", "x5t"].includes(name),
    ) &&
      key.kty === "RSA" &&
      key.use === "sig" &&
      (key.alg === undefined || key.alg === "RS256"),
  );
  const modulus = base64url(key.n, 1024),
    exponent = base64url(key.e, 8);
  requireNative(
    modulus.length >= 256 &&
      modulus.length <= 1024 &&
      modulus[0] !== 0 &&
      exponent.toString("hex") === "010001",
  );
  return createPublicKey({ key: { kty: "RSA", n: text(key.n), e: text(key.e) }, format: "jwk" });
}
interface TokenFacts {
  issued_at: number;
  expires_at: number;
}
async function authenticateToken(
  jwt: string,
  statement: Readonly<Record<string, unknown>>,
  purpose: typeof prepPurpose | typeof denialPurpose,
  capture: RuntimeCapture,
  origin: Origin,
  window: HostExecutionWindow,
  preparation: boolean,
): Promise<TokenFacts> {
  const parsed = window.capture(() => {
    requireNative(typeof jwt === "string" && jwt.length <= 32768);
    const parts = jwt.split(".");
    requireNative(parts.length === 3);
    const header = object(controllerJson(base64url(parts[0], 4096))),
      claims = object(controllerJson(base64url(parts[1], 24576))),
      signature = base64url(parts[2], 1024);
    requireNative(
      Object.keys(header).every((name) => ["alg", "kid", "typ", "x5t"].includes(name)) &&
        header.alg === "RS256" &&
        header.typ === "JWT" &&
        typeof header.kid === "string" &&
        /^[A-Za-z0-9._-]{1,256}$/u.test(header.kid),
    );
    if (header.x5t !== undefined) base64url(header.x5t, 64);
    return { parts, header, claims, signature };
  });
  const { claims } = parsed,
    release = capture.declaration.release;
  const iat = integer(claims.iat) * 1000,
    nbf = integer(claims.nbf) * 1000,
    exp = integer(claims.exp) * 1000,
    at = window.now();
  requireNative(
    Number.isSafeInteger(iat) &&
      Number.isSafeInteger(nbf) &&
      Number.isSafeInteger(exp) &&
      nbf <= iat &&
      iat - nbf <= 60000 &&
      exp > iat &&
      exp - iat <= 900000 &&
      iat <= at &&
      nbf <= at &&
      at < exp,
  );
  requireNative(
    claims.iss === issuer &&
      claims.aud === statementAudience(statement, purpose) &&
      claims.sub === subject(capture.configuration) &&
      claims.repository === "deconfined/tarubot" &&
      claims.repository_owner === "deconfined" &&
      claims.repository_id === String(capture.configuration.repository_id) &&
      claims.repository_owner_id === String(capture.configuration.owner_id),
  );
  requireNative(
    claims.ref === "refs/heads/main" &&
      claims.ref_type === "branch" &&
      claims.ref_protected === "true" &&
      claims.event_name === "push" &&
      claims.sha === release.commit &&
      claims.run_id === release.publication_run &&
      claims.run_attempt === "1" &&
      claims.workflow_ref === currentHostPhasePins.publication &&
      claims.workflow_sha === release.commit &&
      claims.job_workflow_ref === currentHostPhasePins.host &&
      claims.job_workflow_sha === release.config_commit &&
      claims.environment === "staging" &&
      claims.check_run_id === String(origin.check_run_id) &&
      claims.head_ref === "" &&
      claims.base_ref === "" &&
      claims.runner_environment === "github-hosted" &&
      typeof claims.jti === "string" &&
      /^[!-~]{1,256}$/u.test(claims.jti),
  );
  requireNative(
    statement.job_id === origin.job_id &&
      statement.check_run_id === origin.check_run_id &&
      iat >= integer(statement.issued_at) - 1000 &&
      iat < integer(statement.issued_at) + 30000,
  );
  if (preparation)
    requireNative(
      iat >= origin.preparation_started_at - 1000 &&
        (origin.preparation_completed_at === 0 || iat <= origin.preparation_completed_at),
    );
  else requireNative(iat >= origin.critical_started_at - 1000);
  const response = await nativeRead(jwks, window, 131072, { Accept: "application/json" });
  requireNative(response.status === 200 && response.headers.location === undefined);
  const key = window.capture(() => signingKey(response.body, text(parsed.header.kid)));
  window.capture(() => {
    requireNative(
      key.asymmetricKeyType === "rsa" &&
        verify(
          "RSA-SHA256",
          Buffer.from(`${parsed.parts[0]}.${parsed.parts[1]}`),
          { key, padding: constants.RSA_PKCS1_PADDING },
          parsed.signature,
        ),
    );
  });
  requireNative(window.now() < exp);
  return { issued_at: iat, expires_at: exp };
}
async function mintToken(
  statement: Readonly<Record<string, unknown>>,
  purpose: typeof prepPurpose | typeof denialPurpose,
  capture: RuntimeCapture,
  origin: Origin,
  window: HostExecutionWindow,
  preparation: boolean,
): Promise<{ jwt: string; facts: TokenFacts }> {
  const url = window.capture(() =>
    hostExecutionAudienceUrlData(capture.request_url, statementAudience(statement, purpose)),
  );
  // The runner bearer is opaque header-safe data, not a PAT/JWT-shaped token.
  requireNative(
    capture.request_token.length <= 16384 && /^[\x21-\x7e]+$/u.test(capture.request_token),
  );
  const response = await nativeRead(url, window, 49152, {
    Authorization: `Bearer ${capture.request_token}`,
    Accept: "application/json",
  });
  requireNative(response.status === 200 && response.headers.location === undefined);
  const jwt = text(exact(controllerJson(response.body), ["value"]).value);
  const facts = await authenticateToken(
    jwt,
    statement,
    purpose,
    capture,
    origin,
    window,
    preparation,
  );
  window.check();
  return { jwt, facts };
}
interface PreparationRecord {
  schema: 1;
  statement: Readonly<Record<string, unknown>>;
  jwt: string;
}
function writePreparationRecord(
  capture: RuntimeCapture,
  record: PreparationRecord,
  window: HostExecutionWindow,
): void {
  let fd: number | undefined, directory: { dev: number; ino: number } | undefined;
  let file: { dev: number; ino: number } | undefined,
    delivered = false;
  const path = join(capture.private_directory, "preparation.json");
  try {
    window.capture(() => {
      mkdirSync(capture.private_directory, { mode: 0o700 });
      const stat = lstatSync(capture.private_directory);
      directory = { dev: stat.dev, ino: stat.ino };
    });
    safePrivateRoot(capture.private_directory, window);
    const bytes = window.capture(() => Buffer.from(JSON.stringify(record)));
    requireNative(bytes.length <= 131072);
    window.capture(() => {
      window.check();
      fd = openSync(
        path,
        fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL | fsFlags.O_NOFOLLOW | 0x80000,
        0o600,
      );
      const stat = fstatSync(fd);
      file = { dev: stat.dev, ino: stat.ino };
    });
    requireNative(fd !== undefined);
    const ownedFd = fd;
    let offset = 0;
    while (offset < bytes.length) {
      const count = window.capture(() => {
        window.check();
        return writeSync(ownedFd, bytes, offset, bytes.length - offset);
      });
      requireNative(count > 0);
      offset += count;
    }
    window.capture(() => fsyncSync(ownedFd));
    const stat = window.capture(() => fstatSync(ownedFd));
    requireNative(
      stat.uid === process.getuid?.() &&
        stat.nlink === 1 &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size === bytes.length,
    );
    closeSync(ownedFd);
    fd = undefined;
    const reopened = ownedRead(path, window, true);
    requireNative(
      reopened.dev === stat.dev && reopened.ino === stat.ino && reopened.bytes.equals(bytes),
    );
    window.check();
    delivered = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!delivered && directory) {
      // Cleanup only accepted original objects. EEXIST never establishes ownership and a
      // changed path/inode or an unexpected child is preserved rather than recursively removed.
      try {
        const stat = lstatSync(capture.private_directory);
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.dev === directory.dev &&
          stat.ino === directory.ino
        ) {
          if (file) {
            const saved = lstatSync(path);
            if (
              saved.isFile() &&
              !saved.isSymbolicLink() &&
              saved.dev === file.dev &&
              saved.ino === file.ino &&
              saved.nlink === 1
            )
              unlinkSync(path);
          }
          rmdirSync(capture.private_directory);
        }
      } catch {
        /* Unknown cleanup outcome grants nothing. */
      }
    }
  }
}
function preparationStatement(
  capture: RuntimeCapture,
  origin: Origin,
  artifact: HostControllerInspection,
  window: HostExecutionWindow,
): Readonly<Record<string, unknown>> {
  const issued = window.now(),
    expiry = origin.job_started_at + 40 * 60000;
  requireNative(issued < expiry);
  return immutable({
    schema: 1,
    purpose: prepPurpose,
    scope: executionScope(capture, origin),
    producer_sha256: capture.producer_sha256,
    declaration: capture.declaration,
    rootfs_sha256: artifact.rootfs_sha256,
    recipe_sha256: artifact.recipe_sha256,
    event_sha256: capture.event_sha256,
    evaluated_inputs_sha256: capture.evaluated_inputs_sha256,
    configuration_sha256: fileCommitment(capture.files.configuration_files),
    release_sha256: fileCommitment(capture.files.release_files),
    job_id: origin.job_id,
    check_run_id: origin.check_run_id,
    job_started_at: origin.job_started_at,
    issued_at: issued,
    data_valid_until: expiry,
  });
}
/** Native entry: unsupported context/profile refuses before mint/controller release. */
export async function prepareProtectedHostExecution(): Promise<void> {
  entry();
  let window: HostExecutionWindow | undefined,
    artifact: BuiltHostController | undefined,
    failed = false;
  try {
    // biome-ignore lint/complexity/noArguments: the public native API accepts exactly zero arguments.
    requireNative(arguments.length === 0);
    profileConfigured();
    stageDiscriminator();
    // Public acquisition/build has no phase authority. The protected thirty-second epoch
    // starts afterwards, before its first runtime/event/evaluated-input capture.
    const publicBytes = await acquirePublicControllerBytes();
    artifact = await buildOwnedHostController(publicBytes);
    window = new HostExecutionWindow(30000);
    const ownedWindow = window;
    const capture = ownedWindow.capture(() => runtimeCapture(ownedWindow));
    const phase = await phaseObservation(capture, "preparation", window);
    const statement = preparationStatement(
      capture,
      phase.origin,
      inspectOwnedHostController(artifact),
      window,
    );
    const { jwt, facts } = await mintToken(
      statement,
      prepPurpose,
      capture,
      phase.origin,
      window,
      true,
    );
    window.restrict(facts.expires_at);
    phase.verifier.assert(phase.proof, {
      release: capture.declaration.release,
      phase: "preparation",
    });
    writePreparationRecord(capture, { schema: 1, statement, jwt }, window);
    window.check();
  } catch {
    failed = true;
  } finally {
    window?.stop();
    if (artifact) {
      try {
        await disposeOwnedHostControllerArtifact(artifact);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new Error(error);
}
/** Native first acceptance authenticates a CURRENT-valid preparation token and real prep
 * success. Its forty-minute data retention can never renew preparation/exchange authority. */
export async function runProtectedHostExecutionDenial(): Promise<void> {
  entry();
  let window: HostExecutionWindow | undefined,
    paused: PausedHostController | undefined,
    artifact: BuiltHostController | undefined;
  try {
    // biome-ignore lint/complexity/noArguments: the public native API accepts exactly zero arguments.
    requireNative(arguments.length === 0);
    profileConfigured();
    stageDiscriminator();
    artifact = await buildOwnedHostController(await acquirePublicControllerBytes());
    window = new HostExecutionWindow(30000);
    const ownedWindow = window;
    const capture = ownedWindow.capture(() => runtimeCapture(ownedWindow));
    const phase = await phaseObservation(capture, "execution", window);
    safePrivateRoot(capture.private_directory, window);
    const path = join(capture.private_directory, "preparation.json"),
      saved = ownedRead(path, window, true);
    const record = exact(controllerJson(saved.bytes), ["schema", "statement", "jwt"]);
    requireNative(record.schema === 1);
    const statement = exact(record.statement, [
      "schema",
      "purpose",
      "scope",
      "producer_sha256",
      "declaration",
      "rootfs_sha256",
      "recipe_sha256",
      "event_sha256",
      "evaluated_inputs_sha256",
      "configuration_sha256",
      "release_sha256",
      "job_id",
      "check_run_id",
      "job_started_at",
      "issued_at",
      "data_valid_until",
    ]);
    const ownedArtifact = artifact;
    const built = window.capture(() => inspectOwnedHostController(ownedArtifact));
    requireNative(
      statement.schema === 1 &&
        statement.purpose === prepPurpose &&
        JSON.stringify(statement.scope) === JSON.stringify(executionScope(capture, phase.origin)) &&
        statement.producer_sha256 === capture.producer_sha256 &&
        statement.rootfs_sha256 === built.rootfs_sha256 &&
        statement.recipe_sha256 === built.recipe_sha256 &&
        JSON.stringify(statement.declaration) === JSON.stringify(capture.declaration) &&
        statement.event_sha256 === capture.event_sha256 &&
        statement.evaluated_inputs_sha256 === capture.evaluated_inputs_sha256 &&
        statement.configuration_sha256 === fileCommitment(capture.files.configuration_files) &&
        statement.release_sha256 === fileCommitment(capture.files.release_files) &&
        statement.job_started_at === phase.origin.job_started_at &&
        statement.data_valid_until === phase.origin.job_started_at + 40 * 60000 &&
        window.now() < integer(statement.data_valid_until),
    );
    const prepFacts = await authenticateToken(
      text(record.jwt),
      statement,
      prepPurpose,
      capture,
      phase.origin,
      window,
      true,
    );
    // FIRST acceptance includes native paused construction and branded context delivery.
    // This original min-only cap remains conservative and is never removed afterwards.
    window.restrict(prepFacts.expires_at);
    const reopened = ownedRead(path, window, true);
    requireNative(
      reopened.dev === saved.dev &&
        reopened.ino === saved.ino &&
        reopened.mtime_ns === saved.mtime_ns &&
        reopened.ctime_ns === saved.ctime_ns &&
        reopened.bytes.equals(saved.bytes),
    );
    window.restrict(integer(statement.data_valid_until));
    paused = await window.wait(() =>
      prepareOwnedHostController(ownedArtifact, capture.files, () => {
        ownedWindow.check();
      }),
    );
    const ownedPaused = paused;
    const inspection = window.capture(() => inspectOwnedHostController(ownedPaused));
    requireNative(
      inspection.kind === "paused" && inspection.configuration_sha256 && inspection.release_sha256,
    );
    const contextValue = Object.freeze(Object.create(null)) as ProtectedHostExecutionContext;
    const binding: ProtectedHostExecutionBinding = immutable({
      declaration: capture.declaration,
      rootfs_sha256: inspection.rootfs_sha256,
      recipe_sha256: inspection.recipe_sha256,
      configuration_sha256: inspection.configuration_sha256,
      release_sha256: inspection.release_sha256,
      event_sha256: capture.event_sha256,
      evaluated_inputs_sha256: capture.evaluated_inputs_sha256,
      record_sha256: controllerDigest(saved.bytes),
      job_started_at: phase.origin.job_started_at,
      data_valid_until: integer(statement.data_valid_until),
      context_nonce: randomBytes(32).toString("hex"),
      scope: executionScope(capture, phase.origin),
      producer_sha256: capture.producer_sha256,
    });
    contexts.set(contextValue, {
      phase: "accepted",
      window,
      paused,
      binding,
      configuration: capture.configuration,
      release: capture.declaration.release,
      request_url: capture.request_url,
      request_token: capture.request_token,
      verifier: phase.verifier,
      proof: phase.proof,
      origin: phase.origin,
      producer_files: capture.producer_files,
      checking: false,
      record: {
        path,
        dev: saved.dev,
        ino: saved.ino,
        bytes: saved.bytes,
        mtime_ns: saved.mtime_ns,
        ctime_ns: saved.ctime_ns,
      },
    });
    assertProtectedHostExecutionContext(contextValue);
    await driveOwnedHostDenial(contextValue, paused);
    window.check();
  } catch {
    // Every run is terminally denied, including successful fixed DENY delivery.
  } finally {
    window?.stop();
    if (paused) {
      try {
        await stopOwnedHostController(paused);
      } catch {
        /* Unknown cleanup still cannot produce a successful task outcome. */
      }
    }
    if (artifact) {
      try {
        await disposeOwnedHostControllerArtifact(artifact);
      } catch {
        /* Unknown cleanup still cannot produce a successful task outcome. */
      }
    }
  }
  throw new Error(error);
}

declare const authenticationBrand: unique symbol;
export type HostDenialAuthentication = Readonly<{ [authenticationBrand]: true }>;
interface AuthenticationState {
  context: ProtectedHostExecutionContext;
  preparation: DeniedHostExecutionPreparation;
  exchange: OwnedControllerExchange;
  window: HostExecutionWindow;
  verifier: CurrentHostPhaseVerifier;
  proof: CurrentHostPhaseProof;
  statement: Readonly<Record<string, unknown>>;
  checking: boolean;
}
const authentications = new WeakMap<object, AuthenticationState>();
interface AuthenticationAttempt {
  context: ProtectedHostExecutionContext;
  preparation: DeniedHostExecutionPreparation;
  window: HostExecutionWindow | undefined;
  phase: "reserved" | "issued" | "fenced";
}
// The reservation belongs to the actual private exchange, rather than a factory or a
// returned authentication. A failed/unknown mint is permanently spent, with no retry.
const authenticationAttempts = new WeakMap<object, AuthenticationAttempt>();
function fenceAuthenticationAttempt(
  exchange: OwnedControllerExchange,
  saved: AuthenticationAttempt,
): void {
  saved.phase = "fenced";
  saved.window?.stop();
  fenceDeniedHostExecutionPreparation(saved.preparation);
  fenceProtectedHostExecutionContext(saved.context);
  try {
    fenceOwnedControllerExchange(exchange);
  } catch {
    /* Unknown origin cannot approve. */
  }
}
/** Closed bridge requires all THREE genuine private origins. Caller JSON/a JWT cannot mint it. */
export async function authenticateOwnedHostExecutionDenial(
  contextValue: ProtectedHostExecutionContext,
  preparation: DeniedHostExecutionPreparation,
  exchange: OwnedControllerExchange,
): Promise<HostDenialAuthentication> {
  let window: HostExecutionWindow | undefined;
  let attempt: AuthenticationAttempt | undefined;
  try {
    rejectProtectedHostExecutionClockReentry();
    requireNative(exchange !== null && typeof exchange === "object");
    const old = authenticationAttempts.get(exchange);
    if (old) {
      fenceAuthenticationAttempt(exchange, old);
      throw new Error(error);
    }
    attempt = { context: contextValue, preparation, window: undefined, phase: "reserved" };
    authenticationAttempts.set(exchange, attempt);
    assertDeniedHostExecutionPreparation(preparation, contextValue);
    assertProtectedHostExecutionContext(contextValue);
    assertOwnedControllerExchange(exchange, contextValue);
    const saved = context(contextValue);
    window = new HostExecutionWindow(30000, () => {
      assertDeniedHostExecutionPreparation(preparation, contextValue);
      assertProtectedHostExecutionContextData(contextValue);
    });
    attempt.window = window;
    window.restrict(
      window.now() + remainingDeniedHostExecutionPreparation(preparation, contextValue),
    );
    const binding = window.capture(() => ownedControllerExchangeBinding(exchange, contextValue));
    const capture: RuntimeCapture = {
      declaration: saved.binding.declaration as HostControllerPhaseDeclaration,
      configuration: saved.configuration,
      event: Buffer.alloc(0),
      event_sha256: saved.binding.event_sha256,
      evaluated_inputs_sha256: saved.binding.evaluated_inputs_sha256,
      producer_sha256: saved.binding.producer_sha256,
      producer_files: saved.producer_files,
      request_url: saved.request_url,
      request_token: saved.request_token,
      private_directory: "",
      files: {
        declaration: saved.binding.declaration as HostControllerPhaseDeclaration,
        configuration_files: {},
        release_files: {},
      },
    };
    const phase = await phaseObservation(capture, "execution", window);
    requireNative(
      phase.origin.job_id === saved.origin.job_id &&
        phase.origin.check_run_id === saved.origin.check_run_id &&
        phase.origin.job_started_at === saved.origin.job_started_at &&
        phase.origin.critical_started_at === saved.origin.critical_started_at &&
        phase.origin.preparation_started_at === saved.origin.preparation_started_at &&
        phase.origin.preparation_completed_at === saved.origin.preparation_completed_at &&
        phase.origin.gate_policy_sha256 === saved.origin.gate_policy_sha256,
    );
    const issued = window.now(),
      expires = Math.min(saved.binding.data_valid_until, issued + window.remaining());
    const statement = immutable({
      schema: 1,
      purpose: denialPurpose,
      grant_nonce: window.capture(() => randomBytes(32).toString("hex")),
      context: saved.binding,
      exchange: binding,
      job_id: phase.origin.job_id,
      check_run_id: phase.origin.check_run_id,
      issued_at: issued,
      expires_at: expires,
    });
    const minted = await mintToken(statement, denialPurpose, capture, phase.origin, window, false);
    window.restrict(minted.facts.expires_at);
    phase.verifier.assert(phase.proof, { release: saved.release, phase: "execution" });
    assertProtectedHostExecutionContext(contextValue);
    assertOwnedControllerExchange(exchange, contextValue);
    window.check();
    requireNative(attempt.phase === "reserved");
    const value = Object.freeze(Object.create(null)) as HostDenialAuthentication;
    authentications.set(value, {
      context: contextValue,
      preparation,
      exchange,
      window,
      verifier: phase.verifier,
      proof: phase.proof,
      statement,
      checking: false,
    });
    attempt.phase = "issued";
    return value;
  } catch {
    window?.stop();
    if (attempt) fenceAuthenticationAttempt(exchange, attempt);
    else {
      fenceDeniedHostExecutionPreparation(preparation);
      try {
        fenceOwnedControllerExchange(exchange);
      } catch {
        /* Fixed refusal. */
      }
    }
    fenceProtectedHostExecutionContext(contextValue);
    throw new Error(error);
  }
}
/** Retained proof assertion intentionally never calls controller assertion: its consumer owns
 * that independent check and a recursive native LAST-clock assertion would be unsafe. */
export function assertHostDenialAuthentication(
  value: HostDenialAuthentication,
  contextValue: ProtectedHostExecutionContext,
  preparation: DeniedHostExecutionPreparation,
  exchange: OwnedControllerExchange,
): void {
  rejectProtectedHostExecutionClockReentry();
  const saved = authentications.get(value);
  let owns = false;
  try {
    requireNative(
      saved &&
        saved.context === contextValue &&
        saved.preparation === preparation &&
        saved.exchange === exchange,
    );
    requireNative(!saved.checking);
    saved.checking = true;
    owns = true;
    saved.window.check();
    assertProtectedHostExecutionContext(contextValue);
    saved.verifier.assert(saved.proof, {
      release: context(contextValue).release,
      phase: "execution",
    });
    saved.window.check();
    requireNative(saved.window.now() < integer(saved.statement.expires_at));
  } catch {
    saved?.window.stop();
    fenceProtectedHostExecutionContext(contextValue);
    throw new Error(error);
  } finally {
    if (owns && saved) saved.checking = false;
  }
}
export function remainingHostDenialAuthentication(
  value: HostDenialAuthentication,
  contextValue: ProtectedHostExecutionContext,
  preparation: DeniedHostExecutionPreparation,
  exchange: OwnedControllerExchange,
): number {
  assertHostDenialAuthentication(value, contextValue, preparation, exchange);
  const saved = authentications.get(value);
  requireNative(saved);
  return saved.window.remaining();
}
