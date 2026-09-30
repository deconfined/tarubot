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
import { isDeepStrictEqual } from "node:util";
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
export type ValidatorExecutor = (request: ValidatorExecution) => {
  exitCode: number;
  signalCode: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
};
const execute: ValidatorExecutor = (request) => {
  const result = Bun.spawnSync(request.argv, {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeout,
    maxBuffer: request.maxBuffer,
  });
  return { ...result, signalCode: result.signalCode ?? null };
};

function regular(path: string, maximum: number, executable = false): Buffer {
  const stat = lstatSync(path);
  requireDns(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  requireDns(stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0);
  requireDns(stat.size > 0 && stat.size <= maximum);
  if (executable) requireDns((stat.mode & 0o100) !== 0);
  return readFileSync(path);
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
  readonly #run: ValidatorExecutor;
  constructor(
    options: {
      helper: string;
      anchors: string;
      pin: ValidatorPin;
      runtime: { directory: string; manifest_sha256: string };
      now?: () => number;
    },
    run: ValidatorExecutor = execute,
  ) {
    try {
      const { now, ...configuration } = options;
      this.#options = { ...structuredClone(configuration), now: now ?? Date.now };
      this.#run = run;
    } catch {
      throw new Error("invalid-local-dnssec");
    }
  }
  /** Every invocation copies and rehashes the entire reviewed closure into a private fresh cwd. */
  async validate(descriptor: TargetDescriptor, expected: Sshfp): Promise<DnssecEvidence> {
    let working: string | undefined;
    try {
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
      requireDns(realpathSync(directory) === directory);
      const dirStat = lstatSync(directory);
      requireDns(
        dirStat.isDirectory() &&
          !dirStat.isSymbolicLink() &&
          dirStat.uid === process.getuid?.() &&
          (dirStat.mode & 0o077) === 0,
      );
      const libraryDirectory = join(directory, "lib");
      requireDns(realpathSync(libraryDirectory) === libraryDirectory);
      const libStat = lstatSync(libraryDirectory);
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
      const manifestBytes = regular(join(directory, "runtime-manifest.json"), 32768);
      requireDns(hash(manifestBytes) === o.runtime.manifest_sha256);
      const raw = exact(JSON.parse(manifestBytes.toString("utf8")), [
        "schema",
        "unbound_version",
        "source_sha256",
        "helper_sha256",
        "anchor_sha256",
        "loader",
        "libraries",
      ]);
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
      const helper = regular(o.helper, 32 * 1024 * 1024, true);
      const anchors = regular(o.anchors, 4096);
      const closure = new Set(names);
      verifyElfClosure(helper, closure);
      requireDns(hash(helper) === o.pin.binary_sha256 && hash(anchors) === o.pin.anchor_sha256);
      working = mkdtempSync(join(tmpdir(), "tarubot-local-dnssec-"));
      chmodSync(working, 0o700);
      mkdirSync(join(working, "lib"), { mode: 0o700 });
      writeFileSync(join(working, "validator"), helper, { mode: 0o700 });
      writeFileSync(join(working, "root.ds"), anchors, { mode: 0o600 });
      let total = helper.length;
      for (const lib of libraries) {
        const bytes = regular(join(directory, "lib", lib.file), 32 * 1024 * 1024);
        verifyElfClosure(bytes, closure);
        total += bytes.length;
        requireDns(total <= 128 * 1024 * 1024 && hash(bytes) === lib.sha256);
        const destination = join(working, "lib", lib.file);
        writeFileSync(destination, bytes, { mode: 0o700 });
        requireDns(hash(readFileSync(destination)) === lib.sha256);
      }
      requireDns(
        hash(readFileSync(join(working, "validator"))) === o.pin.binary_sha256 &&
          hash(readFileSync(join(working, "root.ds"))) === o.pin.anchor_sha256,
      );
      const started = o.now();
      time(started);
      rejectAmbientLoaderPreload();
      const result = this.#run({
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
        timeout: 22000,
        maxBuffer: 32768,
      });
      requireDns(
        result.exitCode === 0 &&
          result.signalCode === null &&
          result.stderr.length === 0 &&
          result.stdout.length > 0 &&
          result.stdout.length <= 32768,
      );
      return localDnssecEvidence(
        JSON.parse(Buffer.from(result.stdout).toString("utf8")),
        d,
        expected,
        o.pin,
        started,
        o.now(),
      );
    } catch {
      throw new Error("invalid-local-dnssec");
    } finally {
      cleanup(working);
    }
  }
}
