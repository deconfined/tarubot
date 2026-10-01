/**
 * Private pending projection transport. A preparation is only an original denial timer;
 * native candidates are minted inside InfrastructureJournal after its exact private reads.
 * Decryption supplies declarations, never ordinary baseline, issuer or host authority.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import {
  appliedTargetEnvelope,
  type AppliedTargetEnvelope,
  type AppliedTargetProducer,
} from "./target-descriptor.js";
import {
  consumePendingTargetCandidateForSeal,
  type PendingTargetCandidate,
} from "./infra-control.js";
import {
  captureTargetIssuance,
  parseTargetIssuanceJson,
  targetIssuancePins,
} from "./target-issuance.js";
import type { TargetRole } from "./ssh-trust.js";

type Value = Record<string, unknown>;
const domain = "tarubot-applied-target-candidate-v2";
const day = 86_400_000;
const budget = 60_000;
const maximum = 65_536;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, "byteLength")?.get;
const nativeSet = Uint8Array.prototype.set;
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-candidate");
}
function exact(value: unknown, keys: string[]): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const data = value as Value;
  valid(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
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
function role(value: unknown): asserts value is TargetRole {
  valid(value === "staging" || value === "production");
}
function producer(value: unknown, release: ReleaseIdentity): AppliedTargetProducer {
  const data = exact(value, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  valid(
    isDeepStrictEqual(data, {
      repository: targetIssuancePins.repository,
      workflow_ref: targetIssuancePins.publication,
      ref: "refs/heads/main",
      event: "push",
      attempt: 1,
      commit: release.commit,
      run: release.publication_run,
    }),
  );
  valid(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
  integer(Number(release.publication_run));
  valid(String(Number(release.publication_run)) === release.publication_run);
  return data as unknown as AppliedTargetProducer;
}
export interface TargetCandidateContext {
  target: TargetRole;
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
  mode: "apply" | "no-changes";
}
export interface TargetCandidateDeclaration extends TargetCandidateContext {
  schema: 2;
  purpose: "tarubot-applied-target-candidate-v2";
  source_job_path: typeof targetIssuancePins.plan | typeof targetIssuancePins.apply;
  baseline_writer: { kind: "baseline" | "apply"; run: { commit: string; run: string } };
  envelope: AppliedTargetEnvelope;
  issued_at: number;
  expires_at: number;
}
export interface TargetCandidatePreparationData {
  targets: readonly TargetRole[];
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
  issued_at: number;
  expires_at: number;
}
declare const preparationBrand: unique symbol;
export type TargetCandidatePreparation = Readonly<{ [preparationBrand]: true }>;
interface PreparationState {
  data: TargetCandidatePreparationData;
  clock: () => number;
  last: number;
  wall: number;
  physical: number;
  stamp: number;
  phase: "prepared" | "working" | "fenced";
}
const preparations = new WeakMap<TargetCandidatePreparation, PreparationState>();
function check(state: PreparationState): void {
  try {
    valid(state.phase !== "fenced" && performance.now() < state.physical);
    const stamp = ++state.stamp;
    const at = state.clock();
    integer(at);
    valid(
      state.stamp === stamp &&
        (state.phase as PreparationState["phase"]) !== "fenced" &&
        at >= state.last &&
        at < state.wall &&
        performance.now() < state.physical,
    );
    state.last = at;
  } catch {
    state.phase = "fenced";
    throw new Error("invalid-target-candidate");
  }
}
function saved(value: TargetCandidatePreparation): PreparationState {
  const state = preparations.get(value);
  valid(state);
  return state;
}
/** Start before evidence snapshots and the first read; neither a clock nor a later call renews it. */
export function prepareTargetCandidates(
  input: {
    targets: readonly TargetRole[];
    release: ReleaseIdentity;
    producer: AppliedTargetProducer;
    expires_at?: number;
  },
  dependencies: { now?: () => number } = {},
): TargetCandidatePreparation {
  try {
    const physical = performance.now();
    const clock = dependencies.now ?? Date.now;
    valid(typeof clock === "function");
    const at = clock();
    integer(at);
    const snapshot = captureTargetIssuance(input) as Value;
    const data = exact(
      snapshot,
      Object.hasOwn(snapshot, "expires_at")
        ? ["targets", "release", "producer", "expires_at"]
        : ["targets", "release", "producer"],
    );
    valid(Array.isArray(data.targets) && data.targets.length > 0 && data.targets.length <= 2);
    for (const target of data.targets) role(target);
    valid(new Set(data.targets).size === data.targets.length);
    const release = releaseIdentity(data.release);
    const identity = producer(data.producer, release);
    const expires = data.expires_at ?? at + day;
    integer(expires);
    valid(expires > at && expires - at <= day);
    const state: PreparationState = {
      data: freeze({
        targets: [...data.targets].sort() as TargetRole[],
        release,
        producer: identity,
        issued_at: at,
        expires_at: expires,
      }),
      clock,
      last: at,
      wall: Math.min(expires, at + budget),
      physical: physical + Math.min(expires - at, budget),
      stamp: 0,
      phase: "prepared",
    };
    check(state);
    const value = Object.freeze({}) as TargetCandidatePreparation;
    preparations.set(value, state);
    return value;
  } catch {
    throw new Error("invalid-target-candidate");
  }
}
/** Preparation is denial-only and cannot create the separate native pending-candidate brand. */
export function targetCandidatePreparation(
  value: TargetCandidatePreparation,
): TargetCandidatePreparationData {
  const state = saved(value);
  check(state);
  return state.data;
}
export function reserveTargetCandidatePreparation(
  value: TargetCandidatePreparation,
): TargetCandidatePreparationData {
  const state = saved(value),
    phase = state.phase;
  state.phase = "fenced";
  valid(phase === "prepared");
  state.phase = "working";
  check(state);
  return state.data;
}
export function assertTargetCandidatePreparation(value: TargetCandidatePreparation): void {
  check(saved(value));
}
/** Remaining time is refusal-only; it cannot start, reserve or extend a preparation. */
export function remainingTargetCandidatePreparation(value: TargetCandidatePreparation): number {
  const state = saved(value);
  check(state);
  const remaining = Math.floor(
    Math.min(state.wall - state.last, state.physical - performance.now()),
  );
  if (remaining < 1) {
    state.phase = "fenced";
    throw new Error("invalid-target-candidate");
  }
  return remaining;
}
export function fenceTargetCandidatePreparation(value: TargetCandidatePreparation): void {
  const state = preparations.get(value);
  if (state) state.phase = "fenced";
}
/** The original timeout also wraps unresolved journal/file work; late continuations remain denied. */
export async function withinTargetCandidatePreparation<T>(
  value: TargetCandidatePreparation,
  work: () => Promise<T>,
): Promise<T> {
  const state = saved(value);
  check(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = Math.min(state.wall - state.last, state.physical - performance.now());
    valid(remaining >= 1);
    const result = await Promise.race([
      Promise.resolve().then(() => {
        check(state);
        return work();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("invalid-target-candidate")), remaining);
      }),
    ]);
    check(state);
    return result;
  } catch {
    state.phase = "fenced";
    throw new Error("invalid-target-candidate");
  } finally {
    clearTimeout(timer);
  }
}
function context(value: unknown): TargetCandidateContext {
  const data = exact(captureTargetIssuance(value), ["target", "release", "producer", "mode"]);
  role(data.target);
  valid(data.mode === "apply" || data.mode === "no-changes");
  const release = releaseIdentity(data.release);
  return freeze({
    target: data.target,
    release,
    producer: producer(data.producer, release),
    mode: data.mode,
  });
}
/** Strict pure parsing supplies a declaration, not a native candidate or final execution proof. */
export function targetCandidateDeclaration(
  value: unknown,
  expected: TargetCandidateContext,
): TargetCandidateDeclaration {
  try {
    const e = context(expected);
    const data = exact(captureTargetIssuance(value), [
      "schema",
      "purpose",
      "target",
      "release",
      "producer",
      "mode",
      "source_job_path",
      "baseline_writer",
      "envelope",
      "issued_at",
      "expires_at",
    ]);
    valid(data.schema === 2 && data.purpose === domain);
    valid(
      isDeepStrictEqual(
        context({
          target: data.target,
          release: data.release,
          producer: data.producer,
          mode: data.mode,
        }),
        e,
      ),
    );
    valid(
      data.source_job_path ===
        (e.mode === "apply" ? targetIssuancePins.apply : targetIssuancePins.plan),
    );
    const envelope = appliedTargetEnvelope(data.envelope, e);
    valid(envelope.verification.mode === e.mode);
    const writer = exact(data.baseline_writer, ["kind", "run"]);
    valid(writer.kind === "baseline" || writer.kind === "apply");
    const run = exact(writer.run, ["commit", "run"]);
    valid(isDeepStrictEqual(run, envelope.baseline.run));
    valid(e.mode !== "apply" || writer.kind === "apply");
    integer(data.issued_at);
    integer(data.expires_at);
    valid(data.expires_at > data.issued_at && data.expires_at - data.issued_at <= day);
    valid(Buffer.byteLength(canonical(data)) <= maximum);
    return freeze(data as unknown as TargetCandidateDeclaration);
  } catch {
    throw new Error("invalid-target-candidate");
  }
}
function secret(value: unknown): asserts value is string {
  valid(typeof value === "string" && value.length >= 32 && value.length <= 4096);
}
function key(passphrase: string, expected: TargetCandidateContext): Buffer {
  const binding = createHash("sha256")
    .update(canonical({ domain, context: expected }))
    .digest("hex");
  return scryptSync(passphrase, `${domain}:${binding}`, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
function encrypt(value: TargetCandidateDeclaration, passphrase: string): Uint8Array {
  const expected = context({
    target: value.target,
    release: value.release,
    producer: value.producer,
    mode: value.mode,
  });
  const plaintext = Buffer.from(canonical(targetCandidateDeclaration(value, expected)));
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(passphrase, expected), nonce);
  cipher.setAAD(Buffer.from(canonical({ domain, context: expected })));
  return Buffer.concat([
    Buffer.from("TTC2"),
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
/** Decryption preserves original timestamps and cannot reconstruct a native pending capability. */
export function openEncryptedTargetCandidate(input: {
  bytes: Uint8Array;
  candidate_passphrase: string;
  expected: TargetCandidateContext;
}): TargetCandidateDeclaration {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    valid(Reflect.ownKeys(input).length === 3 && Object.keys(descriptors).length === 3);
    for (const name of ["bytes", "candidate_passphrase", "expected"])
      valid(descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value"));
    const source = descriptors.bytes?.value;
    valid(source instanceof Uint8Array && byteLength !== undefined);
    const length = byteLength.call(source) as number;
    valid(length > 32 && length <= maximum + 32);
    const bytes = new Uint8Array(length);
    nativeSet.call(bytes, source);
    const data = Buffer.from(bytes),
      passphrase = descriptors.candidate_passphrase?.value;
    secret(passphrase);
    const expected = context(descriptors.expected?.value);
    valid(data.subarray(0, 4).toString() === "TTC2");
    const cipher = createDecipheriv("aes-256-gcm", key(passphrase, expected), data.subarray(4, 16));
    cipher.setAAD(Buffer.from(canonical({ domain, context: expected })));
    cipher.setAuthTag(data.subarray(-16));
    return targetCandidateDeclaration(
      parseTargetIssuanceJson(
        Buffer.concat([cipher.update(data.subarray(16, -16)), cipher.final()]),
      ),
      expected,
    );
  } catch {
    throw new Error("invalid-target-candidate");
  }
}
export function targetCandidateFileName(target: TargetRole): string {
  role(target);
  return `target-candidate-${target}.enc`;
}
/** Reject symlinks throughout the route; the leaf is an already-owned private directory. */
function directory(path: unknown, check: () => void) {
  valid(
    typeof path === "string" &&
      path.startsWith("/") &&
      path.length <= 4096 &&
      resolve(path) === path &&
      [...path].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
  let at = path;
  for (;;) {
    check();
    const value = lstatSync(at);
    check();
    valid(value.isDirectory() && !value.isSymbolicLink());
    if (at === path) valid(value.uid === process.getuid?.() && (value.mode & 0o777) === 0o700);
    if (at === "/") break;
    at = dirname(at);
  }
  check();
  const stat = lstatSync(path);
  check();
  return { path, dev: stat.dev, ino: stat.ino };
}
function sameDirectory(expected: ReturnType<typeof directory>, check: () => void): void {
  const observed = directory(expected.path, check);
  valid(observed.dev === expected.dev && observed.ino === expected.ino);
}
function ownedFile(fd: number, check: () => void, size?: number): void {
  check();
  const stat = fstatSync(fd);
  check();
  valid(
    stat.isFile() &&
      stat.uid === process.getuid?.() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 &&
      (size === undefined || stat.size === size),
  );
}
function readExact(fd: number, length: number, check: () => void): Uint8Array {
  const output = new Uint8Array(length);
  let at = 0;
  while (at < length) {
    check();
    const count = readSync(fd, output, at, length - at, at);
    check();
    valid(count > 0);
    at += count;
  }
  return output;
}
/**
 * One-use native seal only. No public JSON encryptor/issuer exists. Accepted local I/O cannot
 * be undone: unknown acknowledgement leaves encrypted evidence and permanently stops this cap.
 */
export async function sealPendingTargetCandidate(
  candidate: PendingTargetCandidate,
  configuration: { directory: string; candidate_passphrase: string },
  dependencies: { afterPersist?: () => void | Promise<void> } = {},
): Promise<void> {
  let access: ReturnType<typeof consumePendingTargetCandidateForSeal> | undefined;
  try {
    // Consume before inspecting even configuration/dependency getters or invoking a clock.
    access = consumePendingTargetCandidateForSeal(candidate);
    const captured = access;
    captured.check();
    const config = exact(captureTargetIssuance(configuration), [
      "directory",
      "candidate_passphrase",
    ]);
    secret(config.candidate_passphrase);
    const afterPersist = dependencies.afterPersist ?? (() => {});
    valid(typeof afterPersist === "function");
    await captured.within(async () => {
      await captured.beforeSeal();
      captured.check();
      const dir = directory(config.directory, captured.check),
        file = join(dir.path, targetCandidateFileName(captured.declaration.target));
      const bytes = encrypt(captured.declaration, config.candidate_passphrase as string);
      captured.check();
      sameDirectory(dir, captured.check);
      captured.check();
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        ownedFile(fd, captured.check);
        let at = 0;
        while (at < bytes.length) {
          captured.check();
          const count = writeSync(fd, bytes, at, bytes.length - at);
          valid(count > 0);
          at += count;
          captured.check();
        }
        captured.check();
        fsyncSync(fd);
        captured.check();
        ownedFile(fd, captured.check, bytes.length);
      } finally {
        closeSync(fd);
      }
      captured.check();
      await Promise.resolve().then(() => {
        captured.check();
        return afterPersist();
      });
      captured.check();
      sameDirectory(dir, captured.check);
      captured.check();
      const read = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        ownedFile(read, captured.check, bytes.length);
        captured.check();
        valid(
          Buffer.from(readExact(read, bytes.length, captured.check)).equals(Buffer.from(bytes)),
        );
        captured.check();
      } finally {
        closeSync(read);
      }
      sameDirectory(dir, captured.check);
      captured.check();
    });
    captured.complete();
  } catch {
    access?.fence();
    throw new Error("invalid-target-candidate");
  }
}
