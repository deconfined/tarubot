/**
 * Disposable native DNSSEC rehearsal, never an enrollment workflow dependency. A separate
 * LAB-ONLY helper uses a fixed localhost stub and an ephemeral synthetic root DS. The production
 * helper has neither that stub nor a runtime override. No real zone or resolver is modified.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import {
  chmodSync,
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalDnssecValidator, type RuntimeManifest } from "../../scripts/dnssec-validator.js";
import {
  canonicalEd25519,
  type TargetDescriptor,
  type ValidatorPin,
} from "../../scripts/ssh-trust.js";

const port = 15353;
const host = "host.example.org";
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const fingerprint = canonicalEd25519(key).sshfp;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const modes = ["secure", "bogus", "unsigned-ad", "missing", "wrong-address"] as const;
type Mode = (typeof modes)[number];
function requireFixture(value: unknown): asserts value {
  if (!value) throw new Error("invalid-disposable-dnssec-fixture");
}
const u16 = (value: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
};
const u32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
function name(value: string): Buffer {
  if (value === ".") return Buffer.from([0]);
  return Buffer.concat([
    ...value
      .split(".")
      .flatMap((label) => [Buffer.from([label.length]), Buffer.from(label, "ascii")]),
    Buffer.from([0]),
  ]);
}
function question(packet: Buffer): { name: string; type: number; bytes: Buffer } {
  requireFixture(packet.length >= 17 && packet.length <= 4096 && packet.readUInt16BE(4) === 1);
  requireFixture((packet.readUInt16BE(2) & 0x8000) === 0);
  const labels: string[] = [];
  let offset = 12;
  while (true) {
    const size = packet[offset++];
    requireFixture(size !== undefined && size <= 63);
    if (size === 0) break;
    requireFixture(offset + size <= packet.length);
    const label = packet.subarray(offset, offset + size);
    requireFixture(label.every((byte) => byte >= 32 && byte <= 126));
    labels.push(label.toString("ascii").toLowerCase());
    offset += size;
    requireFixture(offset - 12 <= 254);
  }
  requireFixture(offset + 4 <= packet.length && packet.readUInt16BE(offset + 2) === 1);
  return {
    name: labels.join(".") || ".",
    type: packet.readUInt16BE(offset),
    bytes: packet.subarray(12, offset + 4),
  };
}

/** RFC 4034 canonical RRsets and RSA/SHA-256 signatures exercise libunbound's real validator. */
async function serve(directory: string): Promise<void> {
  const trace = join(directory, "fixture-queries.jsonl");
  writeFileSync(trace, "", { mode: 0o600, flag: "wx" });
  let queries = 0;
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  requireFixture(jwk.e && jwk.n);
  const exponent = Buffer.from(jwk.e, "base64url");
  const modulus = Buffer.from(jwk.n, "base64url");
  requireFixture(exponent.length < 256);
  const dnskey = Buffer.concat([u16(257), Buffer.from([3, 8, exponent.length]), exponent, modulus]);
  let sum = 0;
  for (let i = 0; i < dnskey.length; i++) sum += (dnskey[i] as number) << (i % 2 === 0 ? 8 : 0);
  const tag = (sum + ((sum >>> 16) & 0xffff)) & 0xffff;
  const ds = hash(Buffer.concat([name("."), dnskey])).toUpperCase();
  writeFileSync(join(directory, "fixture-root.ds"), `. IN DS ${tag} 8 2 ${ds}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const ttl = 30;
  const rr = (owner: string, type: number, data: Buffer): Buffer =>
    Buffer.concat([name(owner), u16(type), u16(1), u32(ttl), u16(data.length), data]);
  const signed = (owner: string, type: number, data: Buffer, unsigned = false): Buffer[] => {
    const original = rr(owner, type, data);
    if (unsigned) return [original];
    const seconds = Math.floor(Date.now() / 1000);
    const rrsig = Buffer.concat([
      u16(type),
      Buffer.from([8, owner === "." ? 0 : owner.split(".").length]),
      u32(ttl),
      u32(seconds + 3600),
      u32(seconds - 300),
      u16(tag),
      name("."),
    ]);
    const signature = sign("RSA-SHA256", Buffer.concat([rrsig, original]), pair.privateKey);
    return [original, rr(owner, 46, Buffer.concat([rrsig, signature]))];
  };
  const respond = (packet: Buffer): Buffer => {
    const q = question(packet);
    const raw = readFileSync(join(directory, "fixture-mode"), "utf8").trim();
    requireFixture(modes.includes(raw as Mode));
    const mode = raw as Mode;
    const unsigned = mode === "unsigned-ad";
    let answers: Buffer[] = [];
    let authority: Buffer[] = [];
    if (q.name === "." && q.type === 48) answers = signed(".", 48, dnskey, unsigned);
    else if (q.name === "." && q.type === 2)
      answers = signed(".", 2, name("ns.example.org"), unsigned);
    else if (q.name === host && q.type === 44 && mode !== "missing") {
      const data = Buffer.concat([
        Buffer.from([4, 2]),
        Buffer.from(fingerprint.fingerprint, "hex"),
      ]);
      answers = signed(host, 44, data, unsigned);
      if (mode === "bogus") {
        // Keep the original signature and change exactly one SSHFP RDATA byte.
        const bad = Buffer.from(answers[0] as Buffer);
        bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
        answers[0] = bad;
      }
    } else if (q.name === host && q.type === 1)
      answers = signed(
        host,
        1,
        Buffer.from([192, 0, 2, mode === "wrong-address" ? 11 : 10]),
        unsigned,
      );
    else if (q.name === host && q.type === 28)
      answers = signed(host, 28, Buffer.from("20010db8000000000000000000000010", "hex"), unsigned);
    else {
      // A signed NODATA proof for missing SSHFP checks havedata independently from crypto.
      const soa = Buffer.concat([
        name("ns.example.org"),
        name("hostmaster.example.org"),
        ...[1, 3600, 600, 86400, ttl].map(u32),
      ]);
      // QNAME minimisation asks NS at ancestor names. Bind each denial to that actual owner;
      // reusing the host's NSEC can poison iterator/cache behavior despite valid signatures.
      const bitmap =
        q.name === host
          ? Buffer.from([0, 6, 0x40, 0, 0, 0x08, 0, 0x03]) // A, AAAA, RRSIG, NSEC; SSHFP absent.
          : Buffer.from([0, 6, 0, 0, 0, 0, 0, 0x03]); // Empty ancestor: RRSIG and NSEC only.
      authority = [
        ...signed(".", 6, soa, unsigned),
        ...signed(q.name, 47, Buffer.concat([name(`next.${q.name}`), bitmap]), unsigned),
      ];
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(packet.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8400 | (packet.readUInt16BE(2) & 0x0100) | (unsigned ? 0x0020 : 0), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(authority.length, 8);
    // Bounded private query evidence survives a failed disposable rehearsal; it is never
    // emitted in workflow output and contains only this synthetic fixture's DNS questions.
    requireFixture(++queries <= 2000);
    appendFileSync(
      trace,
      JSON.stringify({
        mode,
        name: q.name,
        type: q.type,
        answers: answers.length,
        authority: authority.length,
      }) + "\n",
    );
    return Buffer.concat([header, q.bytes, ...answers, ...authority]);
  };
  const udp = createSocket("udp4");
  const tcp = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk) => {
      try {
        requireFixture(Buffer.isBuffer(chunk));
        buffered = Buffer.concat([buffered, chunk]);
        requireFixture(buffered.length <= 8192);
        while (buffered.length >= 2) {
          const size = buffered.readUInt16BE(0);
          requireFixture(size >= 17 && size <= 4096);
          if (buffered.length < size + 2) break;
          const answer = respond(buffered.subarray(2, size + 2));
          socket.write(Buffer.concat([u16(answer.length), answer]));
          buffered = buffered.subarray(size + 2);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
  });
  udp.on("message", (packet, remote) => {
    if (remote.address !== "127.0.0.1") return;
    try {
      udp.send(respond(packet), remote.port, remote.address);
    } catch {
      /* Refuse malformed fixture questions. */
    }
  });
  udp.on("error", () => process.exit(1));
  tcp.on("error", () => process.exit(1));
  await Promise.all([
    new Promise<void>((accept) => udp.bind(port, "127.0.0.1", accept)),
    new Promise<void>((accept) => tcp.listen(port, "127.0.0.1", accept)),
  ]);
  writeFileSync(join(directory, "fixture-ready"), "loopback-only\n", { mode: 0o600, flag: "wx" });
  const stop = () => {
    udp.close();
    tcp.close();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setTimeout(() => process.exit(1), 180_000).unref();
}

/** Caller supplies a separately built LAB-ONLY runtime; never replace an enrolled runtime. */
export async function dnssecFixture(labRuntime: string): Promise<void> {
  requireFixture(process.platform === "linux" && process.arch === "x64");
  const source = resolve(labRuntime);
  requireFixture(lstatSync(source).isDirectory() && !lstatSync(source).isSymbolicLink());
  const receipt = JSON.parse(readFileSync(join(source, "lab-receipt.json"), "utf8"));
  requireFixture(receipt.lab_only === true && receipt.root_stub === "127.0.0.1@15353");
  requireFixture(receipt.helper_sha256 === hash(readFileSync(join(source, "validator"))));
  requireFixture(receipt.helper_sha256 !== receipt.production_helper_sha256);
  const working = mkdtempSync(join(tmpdir(), "tarubot-dnssec-fixture-"));
  chmodSync(working, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let completed = false;
  let stage = "fixture-start";
  let currentMode: Mode = "secure";
  try {
    writeFileSync(join(working, "fixture-mode"), "secure\n", { mode: 0o600, flag: "wx" });
    const command = Bun.isStandaloneExecutable
      ? [process.execPath, "serve", working]
      : [process.execPath, import.meta.path, "serve", working];
    child = Bun.spawn(command, {
      cwd: working,
      env: { PATH: "/usr/bin:/bin", HOME: working, TMPDIR: working, LANG: "C", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let attempt = 0; attempt < 100 && !existsSync(join(working, "fixture-ready")); attempt++) {
      requireFixture(child.exitCode === null);
      await Bun.sleep(50);
    }
    requireFixture(existsSync(join(working, "fixture-ready")));
    stage = "runtime-copy";
    const runtime = join(working, "runtime");
    cpSync(source, runtime, { recursive: true, dereference: false });
    chmodSync(runtime, 0o700);
    const anchors = readFileSync(join(working, "fixture-root.ds"));
    writeFileSync(join(runtime, "root.ds"), anchors, { mode: 0o600 });
    const manifest: RuntimeManifest = JSON.parse(
      readFileSync(join(runtime, "runtime-manifest.json"), "utf8"),
    );
    manifest.anchor_sha256 = hash(anchors);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(runtime, "runtime-manifest.json"), manifestBytes, { mode: 0o600 });
    const pin: ValidatorPin = {
      name: "unbound",
      version: "1.26.1",
      mode: "local-validating",
      binary_sha256: manifest.helper_sha256,
      anchor_sha256: manifest.anchor_sha256,
      runtime_manifest_sha256: hash(manifestBytes),
    };
    const validator = new LocalDnssecValidator(
      {
        helper: join(runtime, "validator"),
        anchors: join(runtime, "root.ds"),
        pin,
        runtime: { directory: runtime, manifest_sha256: hash(manifestBytes) },
      },
      (request) => {
        // Only this disposable fixture retains bounded private native diagnostics. Production
        // validation keeps its fixed public refusal and always removes its private working copy.
        const result = Bun.spawnSync(request.argv, {
          cwd: request.cwd,
          env: request.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: request.timeout,
          maxBuffer: request.maxBuffer,
        });
        writeFileSync(
          join(working, `native-${currentMode}.json`),
          JSON.stringify({
            exit_code: result.exitCode,
            signal: result.signalCode ?? null,
            stdout: Buffer.from(result.stdout).toString("base64"),
            stderr: Buffer.from(result.stderr).toString("base64"),
          }),
          { mode: 0o600, flag: "wx" },
        );
        return { ...result, signalCode: result.signalCode ?? null };
      },
    );
    const descriptor: TargetDescriptor = {
      schema: 1,
      target: "staging",
      provider: "linode",
      instance_id: "1234",
      fqdn: host,
      addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
      dns_zone_id: "a".repeat(32),
      applied_generation: "11111111-1111-4111-8111-111111111111",
      state: { lineage: "22222222-2222-4222-8222-222222222222", serial: 1, digest: "b".repeat(64) },
    };
    stage = "native-validation";
    const evidence = await validator.validate(descriptor, fingerprint);
    requireFixture(
      evidence.secure && !evidence.bogus && evidence.ttl > 0 && evidence.expires_at > Date.now(),
    );
    for (const mode of modes.slice(1)) {
      currentMode = mode;
      writeFileSync(join(working, "fixture-mode"), `${mode}\n`, { mode: 0o600 });
      let refused = false;
      try {
        await validator.validate(descriptor, fingerprint);
      } catch {
        refused = true;
      }
      requireFixture(refused);
    }
    completed = true;
    console.log(
      JSON.stringify({
        native_local_dnssec: true,
        secure_without_ad: true,
        changed_signature_refused: true,
        unsigned_ad_refused: true,
        missing_sshfp_refused: true,
        different_signed_address_refused: true,
        localhost_only: true,
        production_helper_unmodified: true,
      }),
    );
  } catch {
    // Preserve a failed rehearsal's exact mode/runtime for read-only reconciliation. The RSA
    // private key exists only in the child process and is destroyed when that process exits.
    writeFileSync(
      join(source, "private-fixture-failure.json"),
      JSON.stringify({ schema: 1, stage, mode: currentMode, working }),
      { mode: 0o600, flag: "wx" },
    );
    throw new Error("invalid-disposable-dnssec-fixture");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    if (completed) rmSync(working, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const [command, directory] = process.argv.slice(2);
    requireFixture(
      process.argv.length === 4 && directory && (command === "serve" || command === "run"),
    );
    if (command === "serve") await serve(directory);
    else await dnssecFixture(directory);
  } catch {
    console.log("Disposable local DNSSEC rehearsal refused or failed.");
    process.exitCode = 1;
  }
}
