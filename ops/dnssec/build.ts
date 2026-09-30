/** Local-only authenticated build. Caller supplies public archives; no downloads or system installs. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import pins from "./pins.json" with { type: "json" };
import type { RuntimeManifest } from "../../scripts/dnssec-validator.js";
import { verifyElfClosure } from "./elf.js";

const material = import.meta.dir;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function requireBuild(value: unknown): asserts value {
  if (!value) throw new Error("invalid-dnssec-build");
}
function bytes(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  requireBuild(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum);
  return readFileSync(path);
}
function execute(argv: string[], cwd: string, timeout = 30000): Buffer {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GNUPGHOME: cwd,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: cwd,
      CONFIG_SHELL: "/bin/sh",
      SHELL: "/bin/sh",
      OPENSSL_CONF: "/dev/null",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.signalCode) {
    writeFileSync(join(cwd, "failed-command.stdout"), result.stdout, { mode: 0o600 });
    writeFileSync(join(cwd, "failed-command.stderr"), result.stderr, { mode: 0o600 });
    throw new Error("invalid-dnssec-build");
  }
  return result.stdout;
}

function cleanup(working: string | undefined): void {
  try {
    if (working) rmSync(working, { recursive: true, force: true });
  } catch {
    throw new Error("invalid-dnssec-build");
  }
}
function preserveFailure(working: string | undefined, output: string | undefined): void {
  try {
    if (working && output)
      for (const directory of [working, join(working, `unbound-${pins.unbound_version}`)])
        for (const stream of ["stdout", "stderr"]) {
          const path = join(directory, `failed-command.${stream}`);
          if (existsSync(path)) {
            const stat = lstatSync(path);
            requireBuild(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
            writeFileSync(join(output, `private-build-failure.${stream}`), readFileSync(path), {
              mode: 0o600,
            });
          }
        }
  } catch {
    // Diagnostic preservation is best effort and must never expose a filesystem error or path.
  }
}

/** Pinned CMS content, ICANN CA only and the designated signer authenticate both current root keys. */
export function verifyRootAnchors(working: string, directory = material): Buffer {
  try {
    const xml = bytes(join(directory, "root-anchors.xml"), 32768);
    const signature = bytes(join(directory, "root-anchors.p7s"), 32768);
    const ca = bytes(join(directory, "icannbundle.pem"), 32768);
    requireBuild(
      sha(xml) === pins.iana_xml_sha256 &&
        sha(signature) === pins.iana_signature_sha256 &&
        sha(ca) === pins.icann_ca_sha256,
    );
    const verified = join(working, "verified-root-anchors.xml");
    execute(
      [
        "/usr/bin/openssl",
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        join(directory, "root-anchors.p7s"),
        "-content",
        join(directory, "root-anchors.xml"),
        "-CAfile",
        join(directory, "icannbundle.pem"),
        "-no-CApath",
        "-no-CAstore",
        "-purpose",
        "any",
        "-verify_email",
        pins.iana_signer,
        "-out",
        verified,
      ],
      working,
    );
    requireBuild(readFileSync(verified).equals(xml));
    const text = xml.toString("utf8");
    requireBuild(!/<!DOCTYPE|<!ENTITY/u.test(text) && /<Zone>[.]<\/Zone>/u.test(text));
    const matches = [...text.matchAll(/<KeyDigest\s+([^>]+)>([\s\S]*?)<\/KeyDigest>/gu)];
    const records: string[] = [];
    for (const match of matches) {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      const tag = Number(/<KeyTag>([0-9]+)<\/KeyTag>/u.exec(body)?.[1]);
      if (!pins.root_key_tags.includes(tag)) continue;
      requireBuild(
        !/\bvalidUntil=/u.test(attrs) &&
          /<Algorithm>8<\/Algorithm>/u.test(body) &&
          /<DigestType>2<\/DigestType>/u.test(body),
      );
      const digest = /<Digest>([0-9A-F]{64})<\/Digest>/u.exec(body)?.[1];
      requireBuild(digest);
      records.push(`. IN DS ${tag} 8 2 ${digest}`);
    }
    requireBuild(
      records.length === 2 &&
        records[0]?.startsWith(". IN DS 20326 ") &&
        records[1]?.startsWith(". IN DS 38696 "),
    );
    const result = Buffer.from(
      "; Authenticated IANA root-anchors.xml: active KSK-2017 and successor KSK-2024.\n" +
        records.join("\n") +
        "\n",
    );
    requireBuild(result.equals(bytes(join(directory, "root.ds"), 4096)));
    return result;
  } catch {
    throw new Error("invalid-dnssec-build");
  }
}

/** Build into a new private owner directory; never replace an existing runtime or use make install. */
export function buildDnssec(archive: string, signature: string, destination: string): void {
  let working: string | undefined;
  let output: string | undefined;
  try {
    requireBuild(process.platform === "linux" && process.arch === "x64");
    const sourceBytes = bytes(archive, 32 * 1024 * 1024);
    const signatureBytes = bytes(signature, 32768);
    requireBuild(
      sha(sourceBytes) === pins.source_sha256 && sha(signatureBytes) === pins.signature_sha256,
    );
    output = resolve(destination);
    requireBuild(!existsSync(output));
    mkdirSync(output, { mode: 0o700 });
    requireBuild(realpathSync(output) === output);
    chmodSync(output, 0o700);
    working = mkdtempSync(join(output, ".build-"));
    chmodSync(working, 0o700);
    const releaseKey = bytes(join(material, "releases-g2.asc"), 16384);
    requireBuild(sha(releaseKey) === pins.release_key_sha256);
    const source = join(working, "source.tar.gz");
    const sig = join(working, "source.asc");
    writeFileSync(source, sourceBytes, { mode: 0o600 });
    writeFileSync(sig, signatureBytes, { mode: 0o600 });
    const keyring = join(working, "release.gpg");
    execute(
      [
        "/usr/bin/gpg",
        "--no-options",
        "--batch",
        "--homedir",
        working,
        "--dearmor",
        "--output",
        keyring,
        join(material, "releases-g2.asc"),
      ],
      working,
    );
    const status = execute(
      [
        "/usr/bin/gpgv",
        "--homedir",
        working,
        "--keyring",
        keyring,
        "--status-fd",
        "1",
        sig,
        source,
      ],
      working,
    ).toString("utf8");
    const valid = status.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
    requireBuild(
      valid.length === 1 &&
        valid[0]?.split(" ")[2] === pins.release_fingerprint &&
        valid[0]?.split(" ").at(-1) === pins.release_fingerprint,
    );
    const anchors = verifyRootAnchors(working);
    // Extraction happens only after the exact archive's detached signature and checksum pass.
    execute(
      [
        "/usr/bin/tar",
        "--extract",
        "--gzip",
        "--file",
        source,
        "--directory",
        working,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      working,
    );
    const tree = join(working, `unbound-${pins.unbound_version}`);
    execute(
      [
        "/bin/sh",
        join(tree, "configure"),
        "--with-libunbound-only",
        "--with-libevent=no",
        "--disable-shared",
        "--enable-static",
        "--without-pyunbound",
        "--without-pythonmodule",
        `--prefix=${join(working, "unused-install-prefix")}`,
      ],
      tree,
      120000,
    );
    execute(["/usr/bin/make", "-j2", "lib"], tree, 300000);
    const helper = join(output, "validator");
    execute(
      [
        "/usr/bin/cc",
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fstack-protector-strong",
        "-D_FORTIFY_SOURCE=3",
        "-fPIE",
        "-pie",
        "-Wl,-z,relro,-z,now",
        "-I",
        tree,
        join(material, "validator.c"),
        join(tree, ".libs", "libunbound.a"),
        "-lssl",
        "-lcrypto",
        "-lpthread",
        "-ldl",
        "-lm",
        "-o",
        helper,
      ],
      working,
      30000,
    );
    // Retain only verified public compile inputs for a separately measured localhost-only lab binary.
    mkdirSync(join(output, "lab-build"), { mode: 0o700 });
    const staticLibrary = bytes(join(tree, ".libs", "libunbound.a"), 32 * 1024 * 1024);
    const generatedHeader = bytes(join(tree, "unbound.h"), 65536);
    writeFileSync(join(output, "lab-build", "libunbound.a"), staticLibrary, { mode: 0o600 });
    writeFileSync(join(output, "lab-build", "unbound.h"), generatedHeader, { mode: 0o600 });
    chmodSync(helper, 0o700);
    writeFileSync(join(output, "root.ds"), anchors, { mode: 0o600 });
    const deps = execute(["/usr/bin/ldd", helper], working).toString("utf8").trim().split("\n");
    const allowed = new Set([
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
    const libraries: RuntimeManifest["libraries"] = [];
    mkdirSync(join(output, "lib"), { mode: 0o700 });
    for (const line of deps) {
      if (/^\s*linux-vdso[.]so[.]1 \(0x[a-f0-9]+\)$/u.test(line)) continue;
      const ordinary = /^\s*([a-zA-Z0-9_.-]+) => (\/[a-zA-Z0-9_./+-]+) \(0x[a-f0-9]+\)$/u.exec(
        line,
      );
      const loader = /^\s*(\/[a-zA-Z0-9_./+-]+\/ld-linux-x86-64[.]so[.]2) \(0x[a-f0-9]+\)$/u.exec(
        line,
      );
      const file = ordinary?.[1] ?? (loader?.[1] ? basename(loader[1]) : null);
      const path = ordinary?.[2] ?? loader?.[1];
      requireBuild(
        file && path && allowed.has(file) && !libraries.some((lib) => lib.file === file),
      );
      const physical = realpathSync(path);
      const stat = lstatSync(physical);
      requireBuild(stat.uid === 0 && (stat.mode & 0o022) === 0);
      const binary = bytes(physical, 32 * 1024 * 1024);
      const target = join(output, "lib", file);
      writeFileSync(target, binary, { mode: 0o700 });
      requireBuild(readFileSync(target).equals(binary));
      libraries.push({ file, sha256: sha(binary) });
    }
    requireBuild(
      ["ld-linux-x86-64.so.2", "libc.so.6", "libssl.so.3", "libcrypto.so.3"].every((name) =>
        libraries.some((lib) => lib.file === name),
      ),
    );
    const closure = new Set(libraries.map((lib) => lib.file));
    verifyElfClosure(bytes(helper, 32 * 1024 * 1024), closure);
    for (const lib of libraries)
      verifyElfClosure(bytes(join(output, "lib", lib.file), 32 * 1024 * 1024), closure);
    const manifest: RuntimeManifest = {
      schema: 1,
      unbound_version: "1.26.1",
      source_sha256: pins.source_sha256,
      helper_sha256: sha(readFileSync(helper)),
      anchor_sha256: sha(anchors),
      loader: "ld-linux-x86-64.so.2",
      libraries: libraries.sort((a, b) => a.file.localeCompare(b.file)),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(output, "runtime-manifest.json"), manifestBytes, { mode: 0o600 });
    writeFileSync(
      join(output, "build-receipt.json"),
      JSON.stringify({
        schema: 1,
        release_fingerprint: pins.release_fingerprint,
        source_sha256: pins.source_sha256,
        runtime_manifest_sha256: sha(manifestBytes),
        helper_sha256: manifest.helper_sha256,
        anchor_sha256: manifest.anchor_sha256,
        helper_source_sha256: sha(bytes(join(material, "validator.c"), 32768)),
        lab_static_library_sha256: sha(staticLibrary),
        lab_header_sha256: sha(generatedHeader),
      }),
      { mode: 0o600 },
    );
  } catch {
    // A partial artifact is retained for owner inspection; it has no complete reviewed receipt.
    preserveFailure(working, output);
    throw new Error("invalid-dnssec-build");
  } finally {
    cleanup(working);
  }
}

/** Disposable fixtures only: a separate binary with a compile-time fixed localhost root stub. */
export function buildLabDnssec(production: string, destination: string): void {
  try {
    const source = resolve(production);
    const output = resolve(destination);
    requireBuild(realpathSync(source) === source && !existsSync(output));
    const receipt = JSON.parse(bytes(join(source, "build-receipt.json"), 32768).toString("utf8"));
    const manifestBytes = bytes(join(source, "runtime-manifest.json"), 32768);
    requireBuild(
      receipt.source_sha256 === pins.source_sha256 &&
        receipt.release_fingerprint === pins.release_fingerprint &&
        receipt.runtime_manifest_sha256 === sha(manifestBytes) &&
        receipt.helper_source_sha256 === sha(bytes(join(material, "validator.c"), 32768)),
    );
    const archive = bytes(join(source, "lab-build", "libunbound.a"), 32 * 1024 * 1024);
    const header = bytes(join(source, "lab-build", "unbound.h"), 65536);
    requireBuild(
      sha(archive) === receipt.lab_static_library_sha256 &&
        sha(header) === receipt.lab_header_sha256,
    );
    const anchors = bytes(join(source, "root.ds"), 4096);
    requireBuild(sha(anchors) === receipt.anchor_sha256);
    mkdirSync(output, { mode: 0o700 });
    requireBuild(realpathSync(output) === output);
    const helper = join(output, "validator");
    execute(
      [
        "/usr/bin/cc",
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fstack-protector-strong",
        "-D_FORTIFY_SOURCE=3",
        "-fPIE",
        "-pie",
        "-DTARUBOT_DNSSEC_LAB",
        "-I",
        join(source, "lab-build"),
        join(material, "validator.c"),
        join(source, "lab-build", "libunbound.a"),
        "-lssl",
        "-lcrypto",
        "-lpthread",
        "-ldl",
        "-lm",
        "-Wl,-z,relro,-z,now",
        "-o",
        helper,
      ],
      output,
    );
    chmodSync(helper, 0o700);
    writeFileSync(join(output, "root.ds"), anchors, { mode: 0o600 });
    mkdirSync(join(output, "lib"), { mode: 0o700 });
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as RuntimeManifest;
    for (const lib of manifest.libraries) {
      requireBuild(/^[a-zA-Z0-9_.-]+$/u.test(lib.file));
      const binary = bytes(join(source, "lib", lib.file), 32 * 1024 * 1024);
      requireBuild(sha(binary) === lib.sha256);
      writeFileSync(join(output, "lib", lib.file), binary, { mode: 0o700 });
    }
    manifest.helper_sha256 = sha(bytes(helper, 32 * 1024 * 1024));
    const closure = new Set(manifest.libraries.map((lib) => lib.file));
    verifyElfClosure(bytes(helper, 32 * 1024 * 1024), closure);
    for (const lib of manifest.libraries)
      verifyElfClosure(bytes(join(output, "lib", lib.file), 32 * 1024 * 1024), closure);
    writeFileSync(join(output, "runtime-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    writeFileSync(
      join(output, "lab-receipt.json"),
      JSON.stringify({
        schema: 1,
        lab_only: true,
        source_sha256: pins.source_sha256,
        helper_sha256: sha(bytes(helper, 32 * 1024 * 1024)),
        production_helper_sha256: receipt.helper_sha256,
        anchor_sha256: sha(anchors),
        root_stub: "127.0.0.1@15353",
        libraries: manifest.libraries,
      }),
      { mode: 0o600 },
    );
  } catch {
    throw new Error("invalid-dnssec-build");
  }
}

if (import.meta.main) {
  try {
    const [archive, signature, directory] = process.argv.slice(2);
    requireBuild(process.argv.length === 5 && archive && signature && directory);
    buildDnssec(archive, signature, directory);
    console.log(
      "Pinned local DNSSEC validator built; private receipt requires independent review.",
    );
  } catch {
    console.log("::error::Pinned DNSSEC source verification or private build failed.");
    process.exitCode = 1;
  }
}
