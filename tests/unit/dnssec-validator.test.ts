/** Invented wire RDATA and isolated executable closure only; unit tests perform no DNS queries. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRootAnchors } from "../../ops/dnssec/build.js";
import { verifyElfClosure } from "../../ops/dnssec/elf.js";
import pins from "../../ops/dnssec/pins.json" with { type: "json" };
import {
  LocalDnssecValidator,
  localDnssecEvidence,
  rejectAmbientLoaderPreload,
  type RuntimeManifest,
  type ValidatorExecution,
  type ValidatorExecutor,
} from "../../scripts/dnssec-validator.js";
import {
  canonicalEd25519,
  type TargetDescriptor,
  type ValidatorPin,
} from "../../scripts/ssh-trust.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const now = 1_800_000_000_000;
const root = mkdtempSync(join(tmpdir(), "dnssec-validator-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const target: TargetDescriptor = {
  schema: 1,
  target: "staging",
  provider: "linode",
  instance_id: "1234",
  fqdn: "host.example.org",
  addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
  dns_zone_id: "a".repeat(32),
  applied_generation: "11111111-1111-4111-8111-111111111111",
  state: { lineage: "22222222-2222-4222-8222-222222222222", serial: 3, digest: "b".repeat(64) },
};
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const sshfp = canonicalEd25519(key).sshfp;
const pin: ValidatorPin = {
  name: "unbound",
  version: "1.26.1",
  mode: "local-validating",
  binary_sha256: "c".repeat(64),
  anchor_sha256: "d".repeat(64),
  runtime_manifest_sha256: "e".repeat(64),
};
function answer(type: number, data: string[], ttl = 300) {
  return {
    type,
    class: 1,
    secure: true,
    bogus: false,
    havedata: true,
    nxdomain: false,
    rcode: 0,
    ttl,
    rdata: data,
  };
}
function result() {
  return {
    schema: 1,
    version: "1.26.1",
    mode: "local-validating",
    name: target.fqdn,
    elapsed_ms: 1,
    answers: [
      answer(44, [`0402${sshfp.fingerprint}`]),
      answer(1, ["c000020a"], 180),
      answer(28, ["20010db8000000000000000000000010"], 120),
    ],
  };
}
function elf(seed: number, needed: string[] = []): Buffer {
  // A minimal valid ELF64 program/dynamic table makes closure checks independent of host libraries.
  const bytes = Buffer.alloc(1024);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(1, 64);
  bytes.writeBigUInt64LE(1024n, 64 + 32);
  bytes.writeBigUInt64LE(1024n, 64 + 40);
  bytes.writeUInt32LE(2, 120);
  bytes.writeBigUInt64LE(256n, 120 + 8);
  bytes.writeBigUInt64LE(256n, 120 + 16);
  const dynamicSize = (needed.length + 3) * 16;
  bytes.writeBigUInt64LE(BigInt(dynamicSize), 120 + 32);
  bytes.writeBigUInt64LE(BigInt(dynamicSize), 120 + 40);
  const strings = Buffer.from(`\0${needed.join("\0")}\0`);
  strings.copy(bytes, 640);
  bytes.writeBigUInt64LE(5n, 256);
  bytes.writeBigUInt64LE(640n, 264);
  bytes.writeBigUInt64LE(10n, 272);
  bytes.writeBigUInt64LE(BigInt(strings.length), 280);
  let stringOffset = 1;
  for (const [i, name] of needed.entries()) {
    bytes.writeBigUInt64LE(1n, 288 + i * 16);
    bytes.writeBigUInt64LE(BigInt(stringOffset), 296 + i * 16);
    stringOffset += name.length + 1;
  }
  bytes[1023] = seed;
  return bytes;
}
function fixture() {
  const directory = mkdtempSync(join(root, "runtime-"));
  chmodSync(directory, 0o700);
  mkdirSync(join(directory, "lib"), { mode: 0o700 });
  const helper = elf(1, ["libssl.so.3", "libcrypto.so.3", "libc.so.6"]);
  const anchors = readFileSync(new URL("../../ops/dnssec/root.ds", import.meta.url));
  writeFileSync(join(directory, "validator"), helper, { mode: 0o700 });
  writeFileSync(join(directory, "root.ds"), anchors, { mode: 0o600 });
  const libraries = ["ld-linux-x86-64.so.2", "libc.so.6", "libssl.so.3", "libcrypto.so.3"].map(
    (file, i) => {
      const bytes = elf(i + 2, file === "libssl.so.3" ? ["libcrypto.so.3", "libc.so.6"] : []);
      writeFileSync(join(directory, "lib", file), bytes, { mode: 0o700 });
      return { file, sha256: hash(bytes) };
    },
  );
  const manifest: RuntimeManifest = {
    schema: 1,
    unbound_version: "1.26.1",
    source_sha256: pins.source_sha256,
    helper_sha256: hash(helper),
    anchor_sha256: hash(anchors),
    loader: "ld-linux-x86-64.so.2",
    libraries,
  };
  let measured = "";
  const rewrite = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(directory, "runtime-manifest.json"), bytes, { mode: 0o600 });
    measured = hash(bytes);
  };
  rewrite();
  const calls: ValidatorExecution[] = [];
  const executor: ValidatorExecutor = (request) => {
    calls.push(request);
    expect([...readFileSync(join(request.cwd, "validator"))]).toEqual([...helper]);
    expect([...readFileSync(join(request.cwd, "root.ds"))]).toEqual([...anchors]);
    for (const lib of libraries)
      expect(hash(readFileSync(join(request.cwd, "lib", lib.file)))).toBe(lib.sha256);
    return {
      exitCode: 0,
      signalCode: null,
      stdout: Buffer.from(JSON.stringify(result())),
      stderr: new Uint8Array(),
    };
  };
  const validator = (run = executor, alteredPin?: ValidatorPin) =>
    new LocalDnssecValidator(
      {
        helper: join(directory, "validator"),
        anchors: join(directory, "root.ds"),
        pin: alteredPin ?? {
          ...pin,
          binary_sha256: manifest.helper_sha256,
          anchor_sha256: manifest.anchor_sha256,
          runtime_manifest_sha256: measured,
        },
        runtime: { directory, manifest_sha256: measured },
        now: () => now,
      },
      run,
    );
  return { directory, manifest, calls, executor, validator, rewrite };
}
async function refusal(action: Promise<unknown>) {
  try {
    await action;
    throw new Error("expected refusal");
  } catch (error) {
    expect((error as Error).message).toBe("invalid-local-dnssec");
  }
}

describe("locally verified wire evidence", () => {
  test("secure SSHFP plus exact A/AAAA sets yield conservative TTL evidence", () => {
    const evidence = localDnssecEvidence(result(), target, sshfp, pin, now, now + 1001);
    expect(evidence.name).toBe(target.fqdn);
    expect(evidence.records).toEqual([sshfp]);
    expect(evidence.ttl).toBe(118);
    expect(evidence.observed_at).toBe(now + 1001);
    expect(evidence.expires_at).toBe(now + 119001);
    expect(evidence.validator).toEqual(pin);
  });
  test("AD-only, insecure, bogus, absent, mismatched and ambiguous answers cannot establish evidence", () => {
    const bad = [
      { ad: true },
      { version: "1.26.0" },
      { mode: "remote-ad" },
      { name: "other.example.org" },
      { schema: 2 },
      { elapsed_ms: -1 },
      { elapsed_ms: 20000 },
      { elapsed_ms: 0.5 },
    ];
    for (const delta of bad)
      expect(() =>
        localDnssecEvidence({ ...result(), ...delta }, target, sshfp, pin, now, now),
      ).toThrow("invalid-local-dnssec");
    for (let i = 0; i < 3; i++)
      for (const delta of [
        { secure: false },
        { secure: 1 },
        { bogus: true },
        { havedata: false },
        { nxdomain: true },
        { rcode: 2 },
        { class: 2 },
        { ttl: 0 },
        { ttl: 86401 },
        { ttl: 0.5 },
        { rdata: [] },
        { ad: true },
        { canonname: "other.example.org" },
      ]) {
        const value = result();
        const prior = value.answers[i];
        if (!prior) throw new Error("missing invented answer");
        Object.assign(prior, delta);
        expect(() => localDnssecEvidence(value, target, sshfp, pin, now, now)).toThrow(
          "invalid-local-dnssec",
        );
      }
    for (const [i, data] of [
      [0, [`0402${"0".repeat(64)}`]],
      [0, [`0401${"a".repeat(40)}`]],
      [0, [`0402${sshfp.fingerprint}`, `0402${sshfp.fingerprint}`]],
      [0, [`0402${sshfp.fingerprint.toUpperCase()}`]],
      [1, ["c000020b"]],
      [1, ["c000020a", "c000020b"]],
      [1, ["c00002"]],
      [2, ["20010db8000000000000000000000011"]],
      [2, ["20010db8000000000000000000000010", "20010db8000000000000000000000011"]],
    ] as const) {
      const value = result();
      const rr = value.answers[i];
      if (!rr) throw new Error("missing invented answer");
      rr.rdata = [...data];
      expect(() => localDnssecEvidence(value, target, sshfp, pin, now, now)).toThrow(
        "invalid-local-dnssec",
      );
    }
  });
  test("clock rollback, over-budget lookup, exhausted TTL and unrelated DNS types fail", () => {
    for (const finish of [now - 1, now + 22001, Number.NaN])
      expect(() => localDnssecEvidence(result(), target, sshfp, pin, now, finish)).toThrow(
        "invalid-local-dnssec",
      );
    const value = result();
    const rr = value.answers[0];
    if (!rr) throw new Error("missing invented answer");
    rr.ttl = 1;
    expect(() => localDnssecEvidence(value, target, sshfp, pin, now, now + 1000)).toThrow(
      "invalid-local-dnssec",
    );
    const order = result();
    order.answers.reverse();
    expect(() => localDnssecEvidence(order, target, sshfp, pin, now, now)).toThrow(
      "invalid-local-dnssec",
    );
  });
});

describe("measured private native execution", () => {
  test("the durable pin binds the runtime manifest before native execution", async () => {
    const f = fixture();
    await refusal(
      f
        .validator(f.executor, {
          ...pin,
          binary_sha256: f.manifest.helper_sha256,
          anchor_sha256: f.manifest.anchor_sha256,
        })
        .validate(target, sshfp),
    );
    expect(f.calls.length).toBe(0);
  });
  test("every direct and transitive ELF dependency must occur in the measured closure", async () => {
    for (const [file, dependency] of [
      ["validator", "libm.so.6"],
      ["validator", "/lib/libc.so.6"],
      ["lib/libcrypto.so.3", "libm.so.6"],
      ["lib/libcrypto.so.3", "libunknown.so.1"],
    ]) {
      const f = fixture();
      if (!file || !dependency) throw new Error("missing invented dependency");
      const replacement = elf(1, [dependency]);
      writeFileSync(join(f.directory, file), replacement, { mode: 0o700 });
      if (file === "validator") f.manifest.helper_sha256 = hash(replacement);
      else {
        const lib = f.manifest.libraries.find((entry) => `lib/${entry.file}` === file);
        if (!lib) throw new Error("missing invented dependency");
        lib.sha256 = hash(replacement);
      }
      f.rewrite();
      await refusal(f.validator().validate(target, sshfp));
      expect(f.calls.length).toBe(0);
    }
  });
  test("ELF search paths, audit hooks, filters and malformed dynamic tables fail closed", () => {
    const closure = new Set(["libc.so.6"]);
    verifyElfClosure(elf(1, ["libc.so.6"]), closure);
    for (const tag of [15, 29, 0x6ffffefb, 0x6ffffefc, 0x7ffffffd, 0x7fffffff]) {
      const binary = elf(1, ["libc.so.6"]);
      binary.writeBigUInt64LE(BigInt(tag), 288);
      expect(() => verifyElfClosure(binary, closure)).toThrow("invalid-local-dnssec");
    }
    for (const mutate of [
      (b: Buffer) => b.writeUInt16LE(0, 56),
      (b: Buffer) => b.writeBigUInt64LE(2048n, 32),
      (b: Buffer) => b.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 32),
      (b: Buffer) => b.writeBigUInt64LE(1024n, 264),
      (b: Buffer) => b.writeBigUInt64LE(1024n, 280),
      (b: Buffer) => b.writeBigUInt64LE(16n, 120 + 32),
      (b: Buffer) => b.writeBigUInt64LE(1n, 304),
      (b: Buffer) => b.fill(1, 640, 1024),
    ]) {
      const binary = elf(1, ["libc.so.6"]);
      mutate(binary);
      expect(() => verifyElfClosure(binary, closure)).toThrow("invalid-local-dnssec");
    }
  });
  test("glibc preload inspection accepts only proven absence", () => {
    const calls: string[] = [];
    expect(() =>
      rejectAmbientLoaderPreload((path) => {
        calls.push(path);
        throw Object.assign(new Error("invented absent path"), { code: "ENOENT" });
      }),
    ).not.toThrow();
    expect(calls).toEqual(["/etc/ld.so.preload"]);
    for (const result of [undefined, {}, { isFile: () => true }, { isSymbolicLink: () => true }])
      expect(() => rejectAmbientLoaderPreload(() => result)).toThrow("invalid-local-dnssec");
    for (const code of ["EACCES", "ELOOP", "EPERM"])
      expect(() =>
        rejectAmbientLoaderPreload(() => {
          throw Object.assign(new Error("invented private filesystem diagnostic"), { code });
        }),
      ).toThrow("invalid-local-dnssec");
  });
  test("copies every pinned byte and invokes only the measured private loader with isolated configuration", async () => {
    const f = fixture();
    const evidence = await f.validator().validate(target, sshfp);
    expect(evidence.records).toEqual([sshfp]);
    expect(f.calls.length).toBe(1);
    const request = f.calls[0];
    if (!request) throw new Error("missing invented invocation");
    expect(request.argv).toEqual([
      join(request.cwd, "lib", "ld-linux-x86-64.so.2"),
      "--inhibit-cache",
      "--library-path",
      join(request.cwd, "lib"),
      "--inhibit-rpath",
      "",
      join(request.cwd, "validator"),
      join(request.cwd, "root.ds"),
      target.fqdn,
    ]);
    expect(request.timeout).toBe(22000);
    expect(request.maxBuffer).toBe(32768);
    expect(request.env).toEqual({
      HOME: request.cwd,
      PATH: "/usr/bin:/bin",
      TMPDIR: request.cwd,
      LANG: "C",
      LC_ALL: "C",
      OPENSSL_CONF: "/dev/null",
      OPENSSL_MODULES: join(request.cwd, "no-provider-modules"),
    });
    expect(existsSync(request.cwd)).toBe(false);
    expect(lstatSync(f.directory).isDirectory()).toBe(true);
  });
  test("a changed helper, anchor or crypto dependency fails before any lookup", async () => {
    for (const file of ["validator", "root.ds", "lib/libcrypto.so.3", "lib/ld-linux-x86-64.so.2"]) {
      const f = fixture();
      writeFileSync(join(f.directory, file), Buffer.from("invented hostile replacement"));
      await refusal(f.validator().validate(target, sshfp));
      expect(f.calls.length).toBe(0);
    }
  });
  test("manifest replacement, unexpected library and missing dependency fail before execution", async () => {
    const stale = fixture();
    writeFileSync(join(stale.directory, "runtime-manifest.json"), "{}");
    await refusal(stale.validator().validate(target, sshfp));
    for (const mode of ["unknown", "missing", "duplicate", "source", "version"] as const) {
      const f = fixture();
      if (mode === "unknown")
        f.manifest.libraries.push({ file: "libunbound.so.8", sha256: "a".repeat(64) });
      if (mode === "missing") f.manifest.libraries.pop();
      if (mode === "duplicate") {
        const lib = f.manifest.libraries[0];
        if (!lib) throw new Error("missing invented library");
        f.manifest.libraries.push(lib);
      }
      if (mode === "source") f.manifest.source_sha256 = "0".repeat(64);
      if (mode === "version")
        (f.manifest as unknown as Record<string, unknown>).unbound_version = "1.26.0";
      f.rewrite();
      await refusal(f.validator().validate(target, sshfp));
      expect(f.calls.length).toBe(0);
    }
  });
  test("symlinks, hardlinks, shared writable files and nonprivate directories are refused", async () => {
    for (const mode of [
      "symlink",
      "hardlink",
      "writable",
      "directory",
      "library-directory",
    ] as const) {
      const f = fixture();
      const path = join(f.directory, "validator");
      if (mode === "symlink" || mode === "hardlink") {
        const saved = join(f.directory, "saved");
        copyFileSync(path, saved);
        rmSync(path);
        if (mode === "symlink") symlinkSync(saved, path);
        else linkSync(saved, path);
      }
      if (mode === "writable") chmodSync(path, 0o722);
      if (mode === "directory") chmodSync(f.directory, 0o755);
      if (mode === "library-directory") {
        const lib = join(f.directory, "lib");
        const saved = join(f.directory, "saved-lib");
        mkdirSync(saved, { mode: 0o700 });
        for (const entry of f.manifest.libraries)
          copyFileSync(join(lib, entry.file), join(saved, entry.file));
        rmSync(lib, { recursive: true });
        symlinkSync(saved, lib);
      }
      await refusal(f.validator().validate(target, sshfp));
      expect(f.calls.length).toBe(0);
    }
  });
  test("invalid pin or expected key and native errors always emit fixed redacted failures", async () => {
    const f = fixture();
    await refusal(
      f
        .validator(f.executor, { ...pin, version: "1.26.0" } as unknown as ValidatorPin)
        .validate(target, sshfp),
    );
    await refusal(f.validator().validate(target, { ...sshfp, fingerprint: "private diagnostic" }));
    expect(f.calls.length).toBe(0);
    for (const broken of ["exit", "signal", "stderr", "json", "overflow", "throw"] as const) {
      const g = fixture();
      const run: ValidatorExecutor = () => {
        if (broken === "throw") throw new Error("invented private subprocess diagnostic");
        return {
          exitCode: broken === "exit" ? 1 : 0,
          signalCode: broken === "signal" ? "SIGTERM" : null,
          stderr: Buffer.from(broken === "stderr" ? "invented private stderr diagnostic" : ""),
          stdout: Buffer.from(
            broken === "json"
              ? "invented private malformed JSON"
              : broken === "overflow"
                ? "a".repeat(32769)
                : JSON.stringify(result()),
          ),
        };
      };
      await refusal(g.validator(run).validate(target, sshfp));
    }
  });
});

describe("authenticated public root anchor material", () => {
  test("actual CMS verification derives exactly current and successor DS anchors", () => {
    const work = mkdtempSync(join(root, "cms-"));
    const verified = verifyRootAnchors(work);
    const text = verified.toString("utf8");
    expect(text).toContain(". IN DS 20326 8 2");
    expect(text).toContain(". IN DS 38696 8 2");
    expect(text).not.toContain("19036");
    expect(verified).toEqual(readFileSync(new URL("../../ops/dnssec/root.ds", import.meta.url)));
  });
  test("a replaced authenticated XML, signature or CA is never accepted from another material directory", () => {
    for (const name of ["root-anchors.xml", "root-anchors.p7s", "icannbundle.pem"]) {
      const directory = mkdtempSync(join(root, "material-"));
      for (const file of ["root-anchors.xml", "root-anchors.p7s", "icannbundle.pem", "root.ds"])
        copyFileSync(new URL(`../../ops/dnssec/${file}`, import.meta.url), join(directory, file));
      writeFileSync(join(directory, name), "invented replaced trust material");
      expect(() => verifyRootAnchors(directory, directory)).toThrow("invalid-dnssec-build");
    }
  });
});
