/** Pinned native local validation boundary; no resolver config, remote AD result or ambient library is trusted. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, types } from "node:util";
import pins from "../ops/dnssec/pins.json" with { type: "json" };
import { verifyElfClosure } from "../ops/dnssec/elf.js";
import {
  dnssecEvidence,
  targetDescriptor,
  type DnssecEvidence,
  type Sshfp,
  type TargetDescriptor,
  type ValidatorPin,
} from "./ssh-trust.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[0-9a-f]{64}$/u;
const allowedLibraries = new Set([
  "ld-linux-x86-64.so.2",
  "libc.so.6",
  "libssl.so.3",
  "libcrypto.so.3",
  "libdl.so.2",
  "libpthread.so.0",
  "librt.so.1",
  "libm.so.6",
  "libgcc_s.so.1",
  "libz.so.1",
]);
function requireDns(value: unknown): asserts value {
  if (!value) throw new Error("invalid-local-dnssec");
}
const nativeThen = Promise.prototype.then;
const nativeSet = Uint8Array.prototype.set;
const nativeLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
/** Refused native promises are drained without consulting a caller's then getter. */
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* An ordinary value or non-native thenable is still a refusal. */
  }
}
function copyBytes(value: unknown, maximum: number, check: () => void): Buffer {
  check();
  requireDns(types.isUint8Array(value) && typeof nativeLength === "function");
  const length: unknown = Reflect.apply(nativeLength, value, []);
  requireDns(typeof length === "number" && length >= 0 && length <= maximum);
  const bytes = new Uint8Array(length);
  Reflect.apply(nativeSet, bytes, [value]);
  check();
  requireDns(Reflect.apply(nativeLength, value, []) === length);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
/** Plain bounded snapshots reserve their original operation before any reflection hook. */
function snapshot(value: unknown, check: (before?: number) => void): unknown {
  let nodes = 0,
    size = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    check();
    requireDns(++nodes <= 2048 && depth <= 16);
    if (input === undefined || input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      requireDns(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      size += Buffer.byteLength(input);
      requireDns(size <= 65_536);
      return input;
    }
    requireDns(input !== null && typeof input === "object" && !ancestors.has(input));
    requireDns(Object.getOwnPropertySymbols(input).length === 0);
    check();
    const beforeProperties = performance.now();
    const properties = Object.getOwnPropertyDescriptors(input);
    check(beforeProperties);
    ancestors.add(input);
    let result: unknown;
    if (Array.isArray(input)) {
      const length: unknown = properties.length?.value;
      requireDns(
        typeof length === "number" &&
          Number.isInteger(length) &&
          length >= 0 &&
          length <= 64 &&
          Object.keys(properties).length === length + 1,
      );
      result = Array.from({ length }, (_, index) => {
        const property = properties[String(index)];
        requireDns(property?.enumerable && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      check();
      requireDns(prototype === Object.prototype || prototype === null);
      const resultObject: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties)) {
        requireDns(property.enumerable && Object.hasOwn(property, "value"));
        size += Buffer.byteLength(key);
        requireDns(size <= 65_536);
        Object.defineProperty(resultObject, key, {
          enumerable: true,
          value: copy(property.value, depth + 1),
        });
      }
      result = resultObject;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
/** This window can only refuse. No deadline, plain DNS evidence or callback mints authority. */
class ValidationWindow {
  #fenced = false;
  #checking = false;
  #started = 0;
  #previous = 0;
  #physicalEnd: number;
  #wallEnd = Number.POSITIVE_INFINITY;
  #remainingCaptured = false;
  #queryPhysicalEnd = Number.POSITIVE_INFINITY;
  #queryWallEnd = Number.POSITIVE_INFINITY;
  #anchors: number[] = [];
  constructor(
    readonly physical: number,
    readonly now: () => number,
    readonly denial?: () => void,
    readonly remainingMs?: () => number,
  ) {
    this.#physicalEnd = physical + 60_000;
  }
  fence(): void {
    this.#fenced = true;
  }
  #live(): void {
    requireDns(
      !this.#fenced && performance.now() < Math.min(this.#physicalEnd, this.#queryPhysicalEnd),
    );
  }
  tick(anchor = performance.now()): number {
    let owns = false;
    const beforeHooks = Math.min(anchor, performance.now(), ...this.#anchors);
    try {
      requireDns(Number.isFinite(beforeHooks) && beforeHooks >= 0);
      this.#live();
      requireDns(!this.#checking);
      this.#checking = true;
      owns = true;
      const refuse = () => {
        this.#live();
        if (this.denial !== undefined) {
          requireDns(typeof this.denial === "function");
          const value = this.denial();
          if (value !== undefined) {
            this.fence();
            drain(value);
          }
          requireDns(value === undefined);
        }
        this.#live();
        requireDns(this.#checking);
      };
      const observe = () => {
        this.#live();
        const value: unknown = this.now();
        if (typeof value !== "number") {
          this.fence();
          drain(value);
        }
        requireDns(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
        this.#live();
        requireDns(this.#checking);
        if (this.#started === 0) {
          this.#started = value;
          this.#wallEnd = Math.min(this.#wallEnd, value + 60_000);
        }
        requireDns(value >= this.#previous && value < Math.min(this.#wallEnd, this.#queryWallEnd));
        this.#previous = value;
        // Project every observation before another hook. All total/caller/query caps retain
        // this cluster's earliest physical instant when the trusted wall clock later freezes.
        this.#physicalEnd = Math.min(this.#physicalEnd, beforeHooks + this.#wallEnd - value);
        this.#queryPhysicalEnd = Math.min(
          this.#queryPhysicalEnd,
          beforeHooks + this.#queryWallEnd - value,
        );
        this.#live();
        return value;
      };
      refuse();
      let value = observe();
      if (this.remainingMs !== undefined) {
        this.#live();
        requireDns(typeof this.remainingMs === "function");
        const remaining: unknown = this.remainingMs();
        if (typeof remaining !== "number") {
          this.fence();
          drain(remaining);
        }
        requireDns(
          typeof remaining === "number" && Number.isSafeInteger(remaining) && remaining > 0,
        );
        // First external cap includes all earlier capture; subsequent captures only shrink.
        this.#physicalEnd = Math.min(
          this.#physicalEnd,
          (this.#remainingCaptured ? beforeHooks : this.physical) + remaining,
        );
        this.#wallEnd = Math.min(this.#wallEnd, value + remaining);
        this.#remainingCaptured = true;
        this.#live();
        requireDns(this.#checking);
      }
      refuse();
      // The final trusted time-only sample follows both refusal and remaining hooks.
      value = observe();
      this.#live();
      return value;
    } catch {
      this.fence();
      throw new Error("invalid-local-dnssec");
    } finally {
      if (owns) this.#checking = false;
    }
  }
  remaining(before?: number): number {
    const value = this.tick(before);
    const remaining = Math.floor(
      Math.min(
        22_000,
        this.#physicalEnd - performance.now(),
        this.#wallEnd - value,
        this.#queryPhysicalEnd - performance.now(),
        this.#queryWallEnd - value,
      ),
    );
    requireDns(remaining > 0);
    return remaining;
  }
  query(): number {
    requireDns(this.#queryPhysicalEnd === Number.POSITIVE_INFINITY && this.#previous > 0);
    this.#queryPhysicalEnd = Math.min(this.#queryPhysicalEnd, performance.now() + 22_000);
    const value = this.#previous;
    this.#queryWallEnd = value + 22_000;
    this.tick();
    return value;
  }
  offer<T>(work: () => T): T {
    this.tick();
    const beforeWork = performance.now();
    this.#anchors.push(beforeWork);
    let value: T | undefined;
    try {
      value = work();
      this.tick(beforeWork);
      return value;
    } catch (error) {
      drain(value);
      throw error;
    } finally {
      this.#anchors.pop();
    }
  }
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  requireDns(value !== null && typeof value === "object" && !Array.isArray(value));
  const data = value as Record<string, unknown>;
  requireDns(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  requireDns(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
  );
}
function time(value: unknown): asserts value is number {
  integer(value, 0, Number.MAX_SAFE_INTEGER);
}

/** Exact A/AAAA membership is checked before SSHFP evidence reaches the trust journal. */
export function localDnssecEvidence(
  value: unknown,
  descriptor: TargetDescriptor,
  sshfp: Sshfp,
  pin: ValidatorPin,
  started: number,
  finished: number,
): DnssecEvidence {
  try {
    const d = targetDescriptor(descriptor);
    time(started);
    time(finished);
    requireDns(finished >= started && finished - started <= 22_000);
    const result = exact(value, ["schema", "version", "mode", "name", "elapsed_ms", "answers"]);
    requireDns(
      result.schema === 1 &&
        result.version === pins.unbound_version &&
        result.mode === "local-validating" &&
        result.name === d.fqdn,
    );
    integer(result.elapsed_ms, 0, 19_999);
    requireDns(Array.isArray(result.answers) && result.answers.length === 3);
    const answers = result.answers.map((entry) => {
      const rr = exact(entry, [
        "type",
        "class",
        "secure",
        "bogus",
        "havedata",
        "nxdomain",
        "rcode",
        "ttl",
        "rdata",
      ]);
      requireDns(
        rr.class === 1 &&
          rr.secure === true &&
          rr.bogus === false &&
          rr.havedata === true &&
          rr.nxdomain === false &&
          rr.rcode === 0,
      );
      integer(rr.ttl, 1, 86400);
      requireDns(Array.isArray(rr.rdata) && rr.rdata.length > 0 && rr.rdata.length <= 32);
      requireDns(
        rr.rdata.every((data) => typeof data === "string" && /^(?:[0-9a-f]{2}){1,66}$/u.test(data)),
      );
      requireDns(new Set(rr.rdata).size === rr.rdata.length);
      return rr;
    });
    requireDns(
      isDeepStrictEqual(
        answers.map((rr) => rr.type),
        [44, 1, 28],
      ),
    );
    const fp = answers[0];
    const a = answers[1];
    const aaaa = answers[2];
    requireDns(fp && a && aaaa);
    const v4 = a.rdata as string[];
    const v6 = aaaa.rdata as string[];
    requireDns(v4.length === 1 && /^[a-f0-9]{8}$/u.test(v4[0] ?? ""));
    requireDns(v6.length === 1 && /^[a-f0-9]{32}$/u.test(v6[0] ?? ""));
    const ipv4 = [...Buffer.from(v4[0] as string, "hex")].join(".");
    const rawV6 = (v6[0] as string).match(/.{4}/gu)?.join(":");
    const ipv6 = new URL(`http://[${rawV6}]/`).hostname.slice(1, -1);
    requireDns(ipv4 === d.addresses.ipv4 && ipv6 === d.addresses.ipv6);
    const records = (fp.rdata as string[]).map((data) => {
      const bytes = Buffer.from(data, "hex");
      requireDns(bytes.length >= 3);
      return {
        algorithm: bytes[0],
        digest_type: bytes[1],
        fingerprint: bytes.subarray(2).toString("hex"),
      };
    });
    const elapsed = Math.ceil(Math.max(result.elapsed_ms, finished - started) / 1000);
    const ttl = Math.min(...answers.map((rr) => rr.ttl as number)) - elapsed;
    requireDns(ttl > 0);
    return dnssecEvidence(
      {
        schema: 1,
        validator: pin,
        name: d.fqdn,
        type: "SSHFP",
        secure: true,
        bogus: false,
        havedata: true,
        nxdomain: false,
        rcode: 0,
        observed_at: finished,
        ttl,
        expires_at: finished + ttl * 1000,
        records,
      },
      d.fqdn,
      sshfp,
      pin,
      finished,
    );
  } catch {
    throw new Error("invalid-local-dnssec");
  }
}

export interface RuntimeManifest {
  schema: 1;
  unbound_version: "1.26.1";
  source_sha256: string;
  helper_sha256: string;
  anchor_sha256: string;
  loader: "ld-linux-x86-64.so.2";
  libraries: { file: string; sha256: string }[];
}

export interface ValidatorExecution {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
}
/** Injection is an internal invented-test seam, never an environment variable or CLI override. */
export type ValidatorExecutor = (
  request: ValidatorExecution,
  beforeExecute?: () => void,
) => {
  exitCode: number;
  signalCode: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
};
/** The final native guard follows every argv/environment/method capture, with no resolver retry. */
function execute(
  request: ValidatorExecution,
  beforeExecute: () => void,
  remaining: (before?: number) => number,
): ReturnType<ValidatorExecutor> {
  const beforeCapture = performance.now();
  const argv = [...request.argv],
    cwd = request.cwd,
    env = { ...request.env };
  const options = {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeout,
    maxBuffer: request.maxBuffer,
  } as const;
  const offer = Bun.spawnSync.bind(Bun);
  Reflect.apply(beforeExecute, undefined, [beforeCapture]);
  const timeout = Math.min(request.timeout, remaining(beforeCapture));
  const result = offer(argv, { ...options, timeout });
  beforeExecute();
  const beforeProperties = performance.now();
  const properties = Object.getOwnPropertyDescriptors(result);
  Reflect.apply(beforeExecute, undefined, [beforeProperties]);
  for (const key of ["exitCode", "stdout", "stderr"])
    requireDns(properties[key] && Object.hasOwn(properties[key], "value"));
  requireDns(properties.signalCode === undefined || Object.hasOwn(properties.signalCode, "value"));
  const exitCode = properties.exitCode?.value;
  const signalCode = properties.signalCode?.value ?? null;
  requireDns(
    typeof exitCode === "number" && (signalCode === null || typeof signalCode === "string"),
  );
  return {
    exitCode,
    signalCode,
    stdout: copyBytes(properties.stdout?.value, 32768, beforeExecute),
    stderr: copyBytes(properties.stderr?.value, 0, beforeExecute),
  };
}

function regular(
  path: string,
  maximum: number,
  window: ValidationWindow,
  executable = false,
): Buffer {
  const stat = window.offer(() => lstatSync(path));
  requireDns(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  requireDns(stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0);
  requireDns(stat.size > 0 && stat.size <= maximum);
  if (executable) requireDns((stat.mode & 0o100) !== 0);
  return copyBytes(
    window.offer(() => readFileSync(path)),
    maximum,
    () => {
      window.tick();
    },
  );
}
function cleanup(working: string | undefined): void {
  try {
    if (working) rmSync(working, { recursive: true, force: true });
  } catch {
    throw new Error("invalid-local-dnssec");
  }
}

/** The runtime host is trusted and stable. glibc reads this file even with an empty environment. */
export function rejectAmbientLoaderPreload(inspect: (path: string) => unknown = lstatSync): void {
  try {
    inspect("/etc/ld.so.preload");
  } catch (error) {
    requireDns(
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
    );
    return;
  }
  throw new Error("invalid-local-dnssec");
}

export class LocalDnssecValidator {
  // Paths, durable pins and the trusted executor remain runtime-private authority inputs.
  readonly #options: {
    helper: string;
    anchors: string;
    pin: ValidatorPin;
    runtime: { directory: string; manifest_sha256: string };
    now: () => number;
  };
  readonly #run: ValidatorExecutor | undefined;
  #active: ValidationWindow | undefined;
  constructor(
    options: {
      helper: string;
      anchors: string;
      pin: ValidatorPin;
      runtime: { directory: string; manifest_sha256: string };
      now?: () => number;
    },
    run?: ValidatorExecutor,
  ) {
    try {
      // Factory construction captures reviewed configuration only, never a lasting authority window.
      const properties = Object.getOwnPropertyDescriptors(options);
      requireDns(Object.getOwnPropertySymbols(options).length === 0);
      const configuration: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties)) {
        requireDns(property.enumerable && Object.hasOwn(property, "value"));
        if (key !== "now")
          Object.defineProperty(configuration, key, { enumerable: true, value: property.value });
      }
      const now = properties.now?.value ?? Date.now;
      requireDns(typeof now === "function" && (run === undefined || typeof run === "function"));
      this.#options = {
        ...(snapshot(configuration, () => {}) as {
          helper: string;
          anchors: string;
          pin: ValidatorPin;
          runtime: { directory: string; manifest_sha256: string };
        }),
        now,
      };
      this.#run = run;
    } catch {
      throw new Error("invalid-local-dnssec");
    }
  }
  /** Every invocation copies and rehashes the entire reviewed closure into a private fresh cwd. */
  async validate(
    descriptor: TargetDescriptor,
    expected: Sshfp,
    denial?: () => void,
    remainingMs?: () => number,
  ): Promise<DnssecEvidence> {
    const physical = performance.now();
    let working: string | undefined;
    let window: ValidationWindow | undefined;
    let owns = false,
      failed = false;
    let evidence: DnssecEvidence | undefined;
    try {
      if (this.#active) {
        this.#active.fence();
        throw new Error("invalid-local-dnssec");
      }
      window = new ValidationWindow(physical, this.#options.now, denial, remainingMs);
      this.#active = window;
      owns = true;
      const original = window;
      const check = (before?: number) => {
        original.tick(before);
      };
      check();
      descriptor = original.offer(() => snapshot(descriptor, check)) as TargetDescriptor;
      expected = original.offer(() => snapshot(expected, check)) as Sshfp;
      const d = targetDescriptor(descriptor);
      const o = this.#options;
      const p = exact(o.pin, [
        "name",
        "version",
        "mode",
        "binary_sha256",
        "anchor_sha256",
        "runtime_manifest_sha256",
      ]);
      requireDns(
        p.name === "unbound" &&
          p.version === pins.unbound_version &&
          p.mode === "local-validating" &&
          typeof p.binary_sha256 === "string" &&
          digest.test(p.binary_sha256) &&
          typeof p.anchor_sha256 === "string" &&
          digest.test(p.anchor_sha256) &&
          typeof p.runtime_manifest_sha256 === "string" &&
          digest.test(p.runtime_manifest_sha256) &&
          p.runtime_manifest_sha256 === o.runtime.manifest_sha256,
      );
      const fp = exact(expected, ["algorithm", "digest_type", "fingerprint"]);
      requireDns(
        fp.algorithm === 4 &&
          fp.digest_type === 2 &&
          typeof fp.fingerprint === "string" &&
          digest.test(fp.fingerprint),
      );
      requireDns(digest.test(o.runtime.manifest_sha256));
      const directory = resolve(o.runtime.directory);
      requireDns(original.offer(() => realpathSync(directory)) === directory);
      const dirStat = original.offer(() => lstatSync(directory));
      requireDns(
        dirStat.isDirectory() &&
          !dirStat.isSymbolicLink() &&
          dirStat.uid === process.getuid?.() &&
          (dirStat.mode & 0o077) === 0,
      );
      const libraryDirectory = join(directory, "lib");
      requireDns(original.offer(() => realpathSync(libraryDirectory)) === libraryDirectory);
      const libStat = original.offer(() => lstatSync(libraryDirectory));
      requireDns(
        libStat.isDirectory() &&
          !libStat.isSymbolicLink() &&
          libStat.uid === process.getuid?.() &&
          (libStat.mode & 0o077) === 0,
      );
      requireDns(
        resolve(o.helper) === join(directory, "validator") &&
          resolve(o.anchors) === join(directory, "root.ds"),
      );
      const manifestBytes = regular(join(directory, "runtime-manifest.json"), 32768, original);
      requireDns(original.offer(() => hash(manifestBytes)) === o.runtime.manifest_sha256);
      const raw = exact(
        original.offer(() =>
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
        ),
        [
          "schema",
          "unbound_version",
          "source_sha256",
          "helper_sha256",
          "anchor_sha256",
          "loader",
          "libraries",
        ],
      );
      requireDns(
        raw.schema === 1 &&
          raw.unbound_version === pins.unbound_version &&
          raw.source_sha256 === pins.source_sha256 &&
          raw.loader === "ld-linux-x86-64.so.2" &&
          raw.helper_sha256 === o.pin.binary_sha256 &&
          raw.anchor_sha256 === o.pin.anchor_sha256,
      );
      requireDns(
        Array.isArray(raw.libraries) && raw.libraries.length >= 4 && raw.libraries.length <= 10,
      );
      const libraries = raw.libraries.map((value) => {
        const lib = exact(value, ["file", "sha256"]);
        requireDns(
          typeof lib.file === "string" &&
            allowedLibraries.has(lib.file) &&
            typeof lib.sha256 === "string" &&
            digest.test(lib.sha256),
        );
        return lib as unknown as RuntimeManifest["libraries"][number];
      });
      const names = libraries.map((lib) => lib.file);
      requireDns(
        new Set(names).size === names.length &&
          ["ld-linux-x86-64.so.2", "libssl.so.3", "libcrypto.so.3", "libc.so.6"].every((name) =>
            names.includes(name),
          ),
      );
      const helper = regular(o.helper, 32 * 1024 * 1024, original, true);
      const anchors = regular(o.anchors, 4096, original);
      const closure = new Set(names);
      original.offer(() => verifyElfClosure(helper, closure));
      requireDns(
        original.offer(() => hash(helper)) === o.pin.binary_sha256 &&
          original.offer(() => hash(anchors)) === o.pin.anchor_sha256,
      );
      // Assign accepted temp ownership before the post-offer check, so late acknowledgement still cleans up.
      check();
      working = mkdtempSync(join(tmpdir(), "tarubot-local-dnssec-"));
      check();
      const privateDirectory = working;
      original.offer(() => chmodSync(privateDirectory, 0o700));
      original.offer(() => mkdirSync(join(privateDirectory, "lib"), { mode: 0o700 }));
      original.offer(() =>
        writeFileSync(join(privateDirectory, "validator"), helper, { mode: 0o700 }),
      );
      original.offer(() =>
        writeFileSync(join(privateDirectory, "root.ds"), anchors, { mode: 0o600 }),
      );
      let total = helper.length;
      for (const lib of libraries) {
        const bytes = regular(join(directory, "lib", lib.file), 32 * 1024 * 1024, original);
        original.offer(() => verifyElfClosure(bytes, closure));
        total += bytes.length;
        requireDns(total <= 128 * 1024 * 1024 && original.offer(() => hash(bytes)) === lib.sha256);
        const destination = join(privateDirectory, "lib", lib.file);
        original.offer(() => writeFileSync(destination, bytes, { mode: 0o700 }));
        const reopened = regular(destination, 32 * 1024 * 1024, original, true);
        requireDns(original.offer(() => hash(reopened)) === lib.sha256);
      }
      requireDns(
        original.offer(() =>
          hash(regular(join(privateDirectory, "validator"), 32 * 1024 * 1024, original, true)),
        ) === o.pin.binary_sha256 &&
          original.offer(() => hash(regular(join(privateDirectory, "root.ds"), 4096, original))) ===
            o.pin.anchor_sha256,
      );
      original.offer(() => rejectAmbientLoaderPreload());
      const started = original.query();
      const request: ValidatorExecution = {
        argv: [
          join(working, "lib", raw.loader as string),
          "--inhibit-cache",
          "--library-path",
          join(working, "lib"),
          "--inhibit-rpath",
          "",
          join(working, "validator"),
          join(working, "root.ds"),
          d.fqdn,
        ],
        cwd: working,
        env: {
          HOME: working,
          PATH: "/usr/bin:/bin",
          TMPDIR: working,
          LANG: "C",
          LC_ALL: "C",
          OPENSSL_CONF: "/dev/null",
          OPENSSL_MODULES: join(working, "no-provider-modules"),
        },
        timeout: original.remaining(),
        maxBuffer: 32768,
      };
      check();
      const result =
        this.#run === undefined
          ? execute(request, check, (before) => original.remaining(before))
          : (original.offer(() => this.#run?.(request, check)) as ReturnType<ValidatorExecutor>);
      if (types.isPromise(result)) {
        original.fence();
        drain(result);
        throw new Error("invalid-local-dnssec");
      }
      check();
      const properties = original.offer(() => Object.getOwnPropertyDescriptors(result));
      for (const key of ["exitCode", "signalCode", "stdout", "stderr"])
        requireDns(properties[key] && Object.hasOwn(properties[key], "value"));
      const stdout = copyBytes(properties.stdout?.value, 32768, check);
      const stderr = copyBytes(properties.stderr?.value, 0, check);
      requireDns(
        properties.exitCode?.value === 0 &&
          properties.signalCode?.value === null &&
          stderr.length === 0 &&
          stdout.length > 0,
      );
      const parsed = original.offer(() =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)),
      );
      evidence = localDnssecEvidence(parsed, d, expected, o.pin, started, original.tick());
      check();
    } catch {
      window?.fence();
      failed = true;
    } finally {
      // Always remove only the already-owned private cwd, even after denial/unknown outcomes.
      try {
        cleanup(working);
        if (owns && !failed) window?.tick();
      } catch {
        failed = true;
        window?.fence();
      }
      if (owns) {
        window?.fence();
        this.#active = undefined;
      }
    }
    if (failed || evidence === undefined) throw new Error("invalid-local-dnssec");
    return evidence;
  }
}
