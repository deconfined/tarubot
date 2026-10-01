/**
 * SSH transport for the replacement pipeline. These adapters confer no enrollment authority:
 * observation is called only after the trust journal's durable intent, and authentication needs
 * that journal's independently confirmed completed enrollment plus fresh local DNSSEC evidence.
 */
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, types } from "node:util";
import {
  canonicalEd25519,
  targetDescriptor,
  type Observation,
  type ScanEvidence,
  type TargetDescriptor,
  type TrustSnapshot,
} from "./ssh-trust.js";

function requireTransport(value: unknown): asserts value {
  if (!value) throw new Error("invalid-trust-ssh-transport");
}
const nativeThen = Promise.prototype.then;
const nativeSet = Uint8Array.prototype.set;
const nativeLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
/** Refused callback promises never leak their private rejection or extend preparation. */
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* A non-native thenable or ordinary value remains a refusal. */
  }
}
function bytes(value: unknown, limit: number, check: () => void = () => {}): Uint8Array {
  check();
  requireTransport(types.isUint8Array(value) && typeof nativeLength === "function");
  const length: unknown = Reflect.apply(nativeLength, value, []);
  requireTransport(typeof length === "number" && length <= limit);
  const result = new Uint8Array(length);
  Reflect.apply(nativeSet, result, [value]);
  check();
  requireTransport(Reflect.apply(nativeLength, value, []) === length);
  return result;
}
/** Plain command/proof snapshots cannot execute accessors or replace binary bytes by iteration. */
function snapshot(value: unknown, check: (before?: number) => void): unknown {
  let nodes = 0,
    size = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    check();
    requireTransport(++nodes <= 4096 && depth <= 16);
    if (input === undefined || input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      requireTransport(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      size += Buffer.byteLength(input);
      requireTransport(size <= 65_536);
      return input;
    }
    if (types.isUint8Array(input)) return bytes(input, 8 * 1024 * 1024, check);
    requireTransport(input !== null && typeof input === "object" && !ancestors.has(input));
    requireTransport(Object.getOwnPropertySymbols(input).length === 0);
    check();
    const beforeProperties = performance.now();
    const properties = Object.getOwnPropertyDescriptors(input);
    check(beforeProperties);
    ancestors.add(input);
    let result: unknown;
    if (Array.isArray(input)) {
      const length: unknown = properties.length?.value;
      requireTransport(
        typeof length === "number" &&
          Number.isInteger(length) &&
          length >= 0 &&
          length <= 64 &&
          Object.keys(properties).length === length + 1,
      );
      result = Array.from({ length }, (_, index) => {
        const item = properties[String(index)];
        requireTransport(item?.enumerable && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      check();
      requireTransport(prototype === Object.prototype || prototype === null);
      const object: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(properties)) {
        requireTransport(item.enumerable && Object.hasOwn(item, "value"));
        size += Buffer.byteLength(key);
        requireTransport(size <= 65_536);
        Object.defineProperty(object, key, {
          enumerable: true,
          value: copy(item.value, depth + 1),
        });
      }
      result = object;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
/** Only denial is transferable. This local preparation window creates no enrollment authority. */
class Preparation {
  #fenced = false;
  #offered = false;
  #checking = false;
  #started = 0;
  #last = 0;
  #expires = Number.POSITIVE_INFINITY;
  #physicalEnd: number;
  #bounds = new Set<{ end: number; rearm?: () => void; reject?: () => void }>();
  #anchors: number[] = [];
  constructor(
    readonly physical: number,
    readonly budget: number,
    readonly now: () => number,
    readonly denial?: () => void,
  ) {
    this.#physicalEnd = physical + budget;
  }
  fence(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    for (const bound of this.#bounds) {
      try {
        bound.reject?.();
      } catch {
        /* A failed accepted-I/O cleanup cannot spare another original held scope. */
      }
    }
  }
  offered(): void {
    this.#offered = true;
  }
  assertNotFenced(): void {
    requireTransport(!this.#fenced);
  }
  initial(): void {
    const physical = performance.now();
    requireTransport(!this.#fenced && !this.#offered && physical < this.#physicalEnd);
    for (const bound of this.#bounds) requireTransport(physical < bound.end);
  }
  tick(anchor = performance.now()): number {
    // Retired preparation refuses without truncating an already accepted command.
    requireTransport(!this.#offered);
    let owned = false;
    const beforeHooks = Math.min(anchor, performance.now(), ...this.#anchors);
    try {
      requireTransport(Number.isFinite(beforeHooks) && beforeHooks >= 0);
      this.initial();
      requireTransport(!this.#checking);
      this.#checking = true;
      owned = true;
      const refuse = () => {
        this.initial();
        if (this.denial !== undefined) {
          requireTransport(typeof this.denial === "function");
          const result = this.denial();
          if (result !== undefined) {
            this.fence();
            drain(result);
          }
          requireTransport(result === undefined);
        }
        this.initial();
        requireTransport(this.#checking);
      };
      const observe = () => {
        this.initial();
        const value: unknown = this.now();
        if (typeof value !== "number") {
          this.fence();
          drain(value);
        }
        requireTransport(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
        this.initial();
        requireTransport(this.#checking);
        // The FIRST sample owns the epoch. Each sample projects its short remainder before
        // another caller hook, from the physical instant preceding the entire hook cluster.
        if (this.#started === 0) this.#started = value;
        requireTransport(
          value >= this.#last && value - this.#started < this.budget && value < this.#expires,
        );
        this.#last = value;
        this.#physicalEnd = Math.min(
          this.#physicalEnd,
          beforeHooks + this.budget - (value - this.#started),
          beforeHooks + this.#expires - value,
          this.physical + this.#expires - this.#started,
        );
        this.initial();
        for (const bound of this.#bounds) bound.rearm?.();
        return value;
      };
      refuse();
      observe();
      refuse();
      // TIME ONLY after the final refusal; no caller hook follows the final offer cap.
      return observe();
    } catch {
      this.fence();
      throw new Error("trusted-ssh-failed");
    } finally {
      if (owned) this.#checking = false;
    }
  }
  bind(expiry: number): void {
    requireTransport(Number.isSafeInteger(expiry));
    this.#expires = Math.min(this.#expires, expiry);
    this.tick();
  }
  available(): number {
    this.initial();
    const physical = performance.now();
    const remaining = Math.floor(
      Math.min(
        this.budget - (this.#last - this.#started),
        this.#expires - this.#last,
        this.#physicalEnd - physical,
        ...[...this.#bounds].map((bound) => bound.end - physical),
      ),
    );
    requireTransport(remaining > 0);
    return remaining;
  }
  remaining(): number {
    this.tick();
    return this.available();
  }
  scope<T>(work: () => T): T {
    const before = performance.now();
    this.#anchors.push(before);
    try {
      this.initial();
      return work();
    } finally {
      this.#anchors.pop();
    }
  }
  capture<T>(work: () => T): T {
    const before = performance.now();
    this.#anchors.push(before);
    let value: T | undefined;
    try {
      this.initial();
      value = work();
      this.tick(before);
      return value;
    } catch (error) {
      drain(value);
      throw error;
    } finally {
      this.#anchors.pop();
    }
  }
  async read<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound: { end: number; rearm?: () => void; reject?: () => void } = { end: Infinity };
    this.#bounds.add(bound);
    try {
      bound.end = performance.now() + this.remaining();
      let rejectDeadline: (error: Error) => void = () => {};
      const timeout = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      drain(timeout);
      bound.reject = () => rejectDeadline(new Error("trusted-ssh-failed"));
      const arm = () => {
        bound.end = Math.min(bound.end, this.#physicalEnd);
        clearTimeout(timer);
        const left = bound.end - performance.now();
        if (left <= 0) {
          this.fence();
          throw new Error("trusted-ssh-failed");
        }
        timer = setTimeout(() => this.fence(), left);
      };
      bound.rearm = arm;
      arm();
      // An owned box crosses the race, keeping native fulfillment under the SAME bounds.
      const pending = new Promise<{ value: T }>((accept, reject) => {
        queueMicrotask(() => {
          let offered: unknown;
          try {
            this.tick();
            offered = this.capture(work);
            this.tick();
            arm();
            Reflect.apply(nativeThen, offered, [
              (value: T) => {
                try {
                  this.tick();
                  const box = Object.create(null) as { value: T };
                  Object.defineProperty(box, "value", { value, enumerable: true });
                  this.initial();
                  accept(Object.freeze(box));
                } catch {
                  this.fence();
                  reject(new Error("trusted-ssh-failed"));
                }
              },
              () => {
                this.fence();
                reject(new Error("trusted-ssh-failed"));
              },
            ]);
          } catch {
            this.fence();
            drain(offered);
            reject(new Error("trusted-ssh-failed"));
          }
        });
      });
      const result = await Promise.race([pending, timeout]);
      this.tick();
      this.initial();
      return result.value;
    } catch {
      this.fence();
      throw new Error("trusted-ssh-failed");
    } finally {
      clearTimeout(timer);
      this.#bounds.delete(bound);
    }
  }
}
/** Cleanup failure must use the same public-safe refusal as an earlier transport failure. */
function removePrivate(directory: string | undefined, failure: string): void {
  try {
    if (directory) rmSync(directory, { recursive: true, force: true });
  } catch {
    throw new Error(failure);
  }
}
export interface TrustProcessRequest {
  executable: "/usr/bin/ssh" | "/usr/bin/ssh-keyscan";
  args: string[];
  directory: string;
  timeout_ms: number;
  output_limit: number;
  input: Uint8Array | null;
}
export interface TrustProcessResult {
  code: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export type TrustProcessRunner = (
  request: TrustProcessRequest,
  beforeSpawn?: () => void,
) => Promise<TrustProcessResult>;

/** Bounded private subprocesses never inherit Actions tokens, SSH agents, proxies or tool config. */
function execute(
  request: TrustProcessRequest,
  beforeSpawn?: () => void,
  accepted?: () => void,
): Promise<TrustProcessResult> {
  return new Promise((accept, reject) => {
    let child: ReturnType<typeof spawn> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false,
      refused = false,
      size = 0;
    const output: Buffer[] = [],
      diagnostic: Buffer[] = [];
    const stop = () => {
      refused = true;
      for (const cancel of [
        () => child?.stdin?.destroy(),
        () => child?.stdout?.destroy(),
        () => child?.stderr?.destroy(),
        () => child?.kill("SIGKILL"),
      ]) {
        try {
          cancel();
        } catch {
          /* An unknown process outcome never authorizes a retry. */
        }
      }
    };
    const finish = (value?: TrustProcessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (value && !refused) accept(value);
      else {
        stop();
        reject(new Error("trust-ssh-process-failed"));
      }
    };
    try {
      const beforeCapture = performance.now();
      const executable = request.executable,
        args = [...request.args],
        directory = request.directory;
      const options = {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      };
      const offer = spawn;
      // Captured argv/environment/native binding precede the ORIGINAL last preparation guard.
      if (beforeSpawn) Reflect.apply(beforeSpawn, undefined, [beforeCapture]);
      child = offer(executable, args, options);
      const commandPhysical = performance.now();
      accepted?.();
      const check = () =>
        requireTransport(
          !finished && !refused && performance.now() - commandPhysical < request.timeout_ms,
        );
      timer = setTimeout(
        () => finish(),
        Math.max(0, request.timeout_ms - (performance.now() - commandPhysical)),
      );
      const collect = (buffers: Buffer[], chunk: Buffer) => {
        if (finished) return;
        try {
          check();
          const copied = bytes(chunk, request.output_limit - size, check);
          size += copied.byteLength;
          buffers.push(Buffer.from(copied));
          check();
        } catch {
          finish();
        }
      };
      check();
      requireTransport(child.stdout && child.stderr && child.stdin);
      child.stdout.on("data", (value: Buffer) => collect(output, value));
      check();
      child.stderr.on("data", (value: Buffer) => collect(diagnostic, value));
      check();
      child.stdin.on("error", () => finish());
      check();
      child.on("error", () => finish());
      check();
      child.on("close", (code, signal) => {
        if (finished) return;
        try {
          check();
          const stdout = Buffer.concat(output);
          check();
          const stderr = Buffer.concat(diagnostic);
          check();
          finish({
            code,
            signal,
            stdout,
            stderr,
          });
        } catch {
          finish();
        }
      });
      const end = child.stdin.end.bind(child.stdin);
      check();
      end(request.input);
      check();
    } catch {
      finish();
    }
  });
}

/** Paths are literal OpenSSH option values; disallow tokens/quoting and private-file symlinks. */
function privatePath(
  value: string,
  directory: boolean,
  check: (before?: number) => void = () => {},
): string {
  check();
  requireTransport(/^\/[A-Za-z0-9_./-]+$/u.test(value) && resolve(value) === value);
  const components = value.split("/").filter(Boolean);
  let current = "";
  for (const part of components) {
    current += `/${part}`;
    check();
    const beforeComponent = performance.now();
    const component = lstatSync(current);
    check(beforeComponent);
    requireTransport(!component.isSymbolicLink());
    check();
  }
  check();
  const beforeStat = performance.now();
  const stat = lstatSync(value);
  check(beforeStat);
  requireTransport(
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
  );
  check();
  return value;
}
function instant(now: () => number): number {
  const value = now();
  requireTransport(Number.isSafeInteger(value) && value > 0);
  return value;
}
function processResult(value: TrustProcessResult, limit: number): TrustProcessResult {
  requireTransport(value !== null && typeof value === "object");
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of ["code", "signal", "stdout", "stderr"])
    requireTransport(properties[key] && Object.hasOwn(properties[key], "value"));
  const code: unknown = properties.code?.value,
    signal: unknown = properties.signal?.value;
  requireTransport(
    (code === null || (typeof code === "number" && Number.isInteger(code) && code >= 0)) &&
      (signal === null || typeof signal === "string"),
  );
  const stdout = bytes(properties.stdout?.value, limit);
  const stderr = bytes(properties.stderr?.value, limit - stdout.byteLength);
  return { code: code as number | null, signal: signal as string | null, stdout, stderr };
}
function scanResult(result: TrustProcessResult, address: string): Observation {
  processResult(result, 8192);
  requireTransport(result.signal === null);
  // OpenSSH status 1 means no key found, including silent protocol failures. Only an exact
  // initial-connect errno proves this literal family unavailable before any SSH exchange.
  if (result.code === 1 && result.stdout.length === 0) {
    const diagnostic = Buffer.from(result.stderr).toString("utf8");
    requireTransport(
      ["Network is unreachable", "No route to host", "Connection refused"].some(
        (reason) => diagnostic === `connect (\`${address}'): ${reason}\n`,
      ),
    );
    return { address, key: null };
  }
  requireTransport(result.code === 0 && result.stdout.length > 0);
  // No aliases, certificates, extra lines or non-ASCII spelling can become a known_hosts entry.
  const asciiLines = (value: Uint8Array): string[] => {
    if (value.length === 0) return [];
    const bytes = Buffer.from(value);
    requireTransport(bytes.every((byte) => byte === 10 || (byte >= 32 && byte <= 126)));
    requireTransport(bytes.at(-1) === 10);
    return bytes.toString("ascii").slice(0, -1).split("\n");
  };
  const lines = asciiLines(result.stdout);
  const diagnostic = asciiLines(result.stderr);
  const banner = (line: string): void => {
    const prefix = `# ${address}:22 `;
    requireTransport(
      line.startsWith(prefix) &&
        /^SSH-(?:2\.0|1\.99)-[!-~][ -~]{0,253}$/u.test(line.slice(prefix.length)),
    );
  };
  // OpenSSH 9.6 (the Ubuntu runner) emits the banner on stderr; 9.9+ uses stdout. Accept
  // exactly one endpoint-bound banner across either stream, never arbitrary diagnostics.
  let banners = 0;
  if (lines[0]?.startsWith("# ")) {
    banner(lines[0]);
    lines.shift();
    banners++;
  }
  if (diagnostic.length > 0) {
    requireTransport(diagnostic.length === 1);
    banner(diagnostic[0] as string);
    banners++;
  }
  requireTransport(lines.length === 1 && banners <= 1);
  const fields = (lines[0] as string).split(" ");
  requireTransport(fields.length === 3 && fields[0] === address);
  return { address, key: canonicalEd25519(fields.slice(1).join(" ")).key };
}

/** Two separate rounds account for both literal families. An uncertain/changed family blocks. */
export async function observeSshHost(
  value: unknown,
  workRoot: string,
  dependencies: {
    run?: TrustProcessRunner;
    now?: () => number;
    pause?: () => Promise<void>;
  } = {},
): Promise<ScanEvidence> {
  let directory: string | undefined;
  try {
    const descriptor = targetDescriptor(value);
    privatePath(workRoot, true);
    directory = mkdtempSync(join(workRoot, "ssh-observe-"));
    const run = dependencies.run ?? execute;
    const now = dependencies.now ?? Date.now;
    const started = instant(now);
    const addresses = [descriptor.addresses.ipv4, descriptor.addresses.ipv6];
    const round = async (): Promise<Observation[]> => {
      // Independent address scans can overlap; no authenticated request occurs during observation.
      const settled = await Promise.allSettled(
        addresses.map(async (address, index) =>
          scanResult(
            await run({
              executable: "/usr/bin/ssh-keyscan",
              args: [
                index === 0 ? "-4" : "-6",
                "-T",
                "5",
                "-p",
                "22",
                "-t",
                "ed25519",
                "--",
                address,
              ],
              directory: directory as string,
              timeout_ms: 10_000,
              output_limit: 8192,
              input: null,
            }),
            address,
          ),
        ),
      );
      requireTransport(settled.every((item) => item.status === "fulfilled"));
      return settled.map((item) => (item as PromiseFulfilledResult<Observation>).value);
    };
    const first = await round();
    await (dependencies.pause ?? (() => Bun.sleep(1000)))();
    const second = await round();
    const completed = instant(now);
    requireTransport(completed >= started && completed - started <= 60_000);
    requireTransport(isDeepStrictEqual(first, second));
    requireTransport(
      new Set(first.flatMap((item) => (item.key === null ? [] : [item.key]))).size === 1,
    );
    return { schema: 1, observed_at: started, rounds: [first, second] };
  } catch {
    throw new Error("trust-ssh-observation-failed");
  } finally {
    removePrivate(directory, "trust-ssh-observation-failed");
  }
}

export type ConnectionProof = TrustSnapshot & { expires_at: number };
/** A guard can only refuse; the future operational factory must separately retain native authority. */
export type TrustConnectionReader = (
  descriptor: TargetDescriptor,
  denial?: () => void,
) => Promise<ConnectionProof>;
export interface SshCommand {
  descriptor: TargetDescriptor;
  address_family: "ipv4" | "ipv6";
  user: string;
  identity_file: string;
  work_root: string;
  command: string[];
  input?: Uint8Array;
  timeout_ms: number;
}
const shellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The caller supplies TrustJournal.connectionTrust, including repair-reader and workflow-success
 * guards, rather than a CLI Boolean or a supplied key. Every invocation obtains its own proof;
 * there is no pooled connection or automatic retry with an older key/address.
 */
export async function trustedSsh(
  request: SshCommand,
  connectionTrust: TrustConnectionReader,
  dependencies: {
    run?: TrustProcessRunner;
    now?: () => number;
    /** A stricter preparation budget is allowed; this cannot extend the sixty-second bound. */
    preparation_timeout_ms?: number;
    denial?: () => void;
  } = {},
): Promise<Uint8Array> {
  let directory: string | undefined;
  const physicalStarted = performance.now();
  let preparation: Preparation | undefined;
  try {
    // The physical origin precedes request reflection and every dependency/clock hook.
    const initial = () => requireTransport(performance.now() - physicalStarted < 60_000);
    request = snapshot(request, initial) as SshCommand;
    initial();
    const customRun = dependencies.run;
    initial();
    const now = dependencies.now ?? Date.now;
    initial();
    const preparationBudget = dependencies.preparation_timeout_ms ?? 60_000;
    initial();
    const denial = dependencies.denial;
    initial();
    requireTransport(
      (customRun === undefined || typeof customRun === "function") &&
        typeof now === "function" &&
        typeof connectionTrust === "function" &&
        Number.isInteger(preparationBudget) &&
        preparationBudget > 0 &&
        preparationBudget <= 60_000 &&
        (denial === undefined || typeof denial === "function"),
    );
    preparation = new Preparation(physicalStarted, preparationBudget, now, denial);
    const original = preparation;
    const check = (before?: number) => {
      original.tick(before);
    };
    check();
    const descriptor = targetDescriptor(request.descriptor);
    requireTransport(request.address_family === "ipv4" || request.address_family === "ipv6");
    requireTransport(/^[a-z_][a-z0-9_-]{0,31}$/u.test(request.user));
    requireTransport(
      Array.isArray(request.command) &&
        request.command.length > 0 &&
        request.command.length <= 32 &&
        request.command.every(
          (part) =>
            typeof part === "string" &&
            part.length <= 4096 &&
            [...part].every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ),
        ),
    );
    requireTransport(
      Number.isInteger(request.timeout_ms) &&
        request.timeout_ms >= 1000 &&
        request.timeout_ms <= 3_600_000,
    );
    requireTransport(
      request.input === undefined ||
        (request.input instanceof Uint8Array && request.input.length <= 8 * 1024 * 1024),
    );
    // Binary stdin was copied intrinsically before the first callback could mutate it.
    privatePath(request.work_root, true, check);
    const identity = privatePath(request.identity_file, false, check);
    privatePath(resolve(identity, ".."), true, check);
    const rawProof = await original.read(() =>
      connectionTrust(snapshot(descriptor, check) as TargetDescriptor, check),
    );
    check();
    const expiry = original.capture(() => {
      const expiry = Object.getOwnPropertyDescriptor(rawProof, "expires_at");
      requireTransport(
        expiry && Object.hasOwn(expiry, "value") && typeof expiry.value === "number",
      );
      // Bind the newly learned expiry inside the SAME pre-descriptor capture. Its shorter
      // original proof cap cannot receive a fresh physical remainder after a slow trap.
      original.bind(expiry.value);
      return expiry;
    });
    const proof = original.capture(() => snapshot(rawProof, check)) as ConnectionProof;
    requireTransport(proof.expires_at === expiry.value);
    const enrolled = targetDescriptor(proof.descriptor);
    const {
      applied_generation: _currentGeneration,
      state: _currentState,
      ...currentInstance
    } = descriptor;
    const {
      applied_generation: _enrolledGeneration,
      state: _enrolledState,
      ...enrolledInstance
    } = enrolled;
    // connectionTrust has verified the requested applied baseline. A safe TTL/label update may
    // advance it without reenrollment, while every physical host/address/DNS identity stays exact.
    requireTransport(isDeepStrictEqual(enrolledInstance, currentInstance));
    requireTransport(Number.isSafeInteger(proof.expires_at));
    // Revalidate durable key framing even at this integration boundary, before writing a pin.
    const key = canonicalEd25519(proof.key);
    requireTransport(isDeepStrictEqual(key.sshfp, proof.sshfp));
    requireTransport(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(proof.generation));
    check();
    privatePath(request.work_root, true, check);
    check();
    const beforeMkdir = performance.now();
    directory = mkdtempSync(join(request.work_root, "ssh-connect-"));
    check(beforeMkdir);
    const alias = `tarubot-${descriptor.target}-${proof.generation}`;
    const hosts = join(directory, "known_hosts");
    const pin = `${alias} ${key.key}\n`;
    check();
    const beforePin = performance.now();
    writeFileSync(hosts, pin, { mode: 0o600, flag: "wx" });
    check(beforePin);
    const beforeReadback = performance.now();
    requireTransport(readFileSync(hosts, "utf8") === pin);
    check(beforeReadback);
    const options = [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "VerifyHostKeyDNS=no",
      `UserKnownHostsFile=${hosts}`,
      "GlobalKnownHostsFile=/dev/null",
      `HostKeyAlias=${alias}`,
      "HostKeyAlgorithms=ssh-ed25519",
      "UpdateHostKeys=no",
      "CheckHostIP=no",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "AddKeysToAgent=no",
      "CertificateFile=none",
      "PreferredAuthentications=publickey",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "HostbasedAuthentication=no",
      "GSSAPIAuthentication=no",
      "PubkeyAuthentication=yes",
      "ForwardAgent=no",
      "ForwardX11=no",
      "ClearAllForwardings=yes",
      "PermitLocalCommand=no",
      "ProxyCommand=none",
      "ProxyJump=none",
      "CanonicalizeHostname=no",
      "RemoteCommand=none",
      "RequestTTY=no",
      "ControlMaster=no",
      "ControlPath=none",
      "ControlPersist=no",
      "ConnectionAttempts=1",
      "ConnectTimeout=10",
      "ServerAliveInterval=5",
      "ServerAliveCountMax=2",
    ];
    const args = [
      "-F",
      "/dev/null",
      "-T",
      request.address_family === "ipv4" ? "-4" : "-6",
      "-p",
      "22",
      "-i",
      identity,
      ...options.flatMap((option) => ["-o", option]),
      "--",
      `${request.user}@${descriptor.addresses[request.address_family]}`,
      request.command.map(shellArgument).join(" "),
    ];
    // Only synchronous pin/path/argv work follows the final authority await.
    privatePath(request.work_root, true, check);
    privatePath(identity, false, check);
    privatePath(resolve(identity, ".."), true, check);
    privatePath(directory, true, check);
    privatePath(hosts, false, check);
    check();
    const beforeFinalReadback = performance.now();
    requireTransport(readFileSync(hosts, "utf8") === pin);
    check(beforeFinalReadback);
    const offered: TrustProcessRequest = {
      executable: "/usr/bin/ssh",
      args,
      directory,
      timeout_ms: request.timeout_ms,
      output_limit: 1024 * 1024,
      input: request.input ?? null,
    };
    check();
    const pending = customRun
      ? original.scope(() => customRun(offered, check))
      : execute(offered, check, () => original.offered());
    try {
      original.assertNotFenced();
    } catch (error) {
      drain(pending);
      throw error;
    }
    // A trusted one-argument seam accepts the request when invoked. Guard-aware/native seams
    // must make their actual synchronous offer before returning; no later authority refresh.
    original.offered();
    const result = processResult(await pending, 1024 * 1024);
    requireTransport(result.code === 0 && result.signal === null);
    return bytes(result.stdout, 1024 * 1024);
  } catch {
    // No host names, addresses, key material, remote text, private paths or process diagnostics.
    throw new Error("trusted-ssh-failed");
  } finally {
    preparation?.fence();
    removePrivate(directory, "trusted-ssh-failed");
  }
}
