/** Invented transport evidence exercises boundaries without resolution or SSH authentication. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDigest } from "../../scripts/infra-control.js";
import {
  canonicalEd25519,
  TrustJournal,
  type DnssecEvidence,
  type TargetDescriptor,
  type ValidatorPin,
} from "../../scripts/ssh-trust.js";
import {
  observeSshHost,
  trustedSsh,
  type ConnectionProof,
  type SshCommand,
  type TrustProcessRequest,
  type TrustProcessResult,
} from "../../scripts/trust-ssh.js";

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const time = 1_800_000_000_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "tarubot-trust-ssh-test-"));
  roots.push(path);
  return path;
}
function descriptor(): TargetDescriptor {
  return {
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
}
function result(
  stdout = "",
  code: number | null = 0,
  signal: string | null = null,
): TrustProcessResult {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from("private diagnostic"), code, signal };
}
/** Scan diagnostics are evidence, unlike arbitrary command stderr returned only to its caller. */
function scanResult(stdout = "", code = 0, signal: string | null = null, stderr = "") {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code, signal };
}
function unavailable(address: string, reason = "Network is unreachable") {
  return scanResult("", 1, null, `connect (\`${address}'): ${reason}\n`);
}
function proof(): ConnectionProof {
  const d = descriptor();
  return {
    generation: "33333333-3333-4333-8333-333333333333",
    descriptor: d,
    key,
    sshfp: canonicalEd25519(key).sshfp,
    enrollment_run: { commit: "c".repeat(40), run: "456" },
    record: {
      id: "d".repeat(32),
      zone_id: d.dns_zone_id,
      name: d.fqdn,
      type: "SSHFP",
      sshfp: canonicalEd25519(key).sshfp,
    },
    expires_at: time + 30_000,
  };
}
function command(): SshCommand {
  const directory = root();
  const identity = join(directory, "invented-identity");
  writeFileSync(identity, "invented non-key fixture", { mode: 0o600 });
  return {
    descriptor: descriptor(),
    address_family: "ipv4",
    user: "runtime",
    identity_file: identity,
    work_root: directory,
    command: ["/bin/printf", "%s", "literal $() `command` ' text"],
    timeout_ms: 10_000,
  };
}

describe("SSH first observation", () => {
  test("scans both literal families twice with bounded key-only subprocesses and cleans up", async () => {
    const directory = root();
    const seen: TrustProcessRequest[] = [];
    let pauses = 0;
    const scan = await observeSshHost(descriptor(), directory, {
      now: () => time,
      pause: async () => {
        pauses++;
      },
      run: async (request) => {
        seen.push(request);
        expect(request.executable).toBe("/usr/bin/ssh-keyscan");
        expect(request.args).toContain("ed25519");
        expect(request.args).not.toContain("-q");
        expect(request.input).toBeNull();
        expect(request.timeout_ms).toBe(10_000);
        expect(request.output_limit).toBe(8192);
        const address = request.args.at(-1);
        return scanResult(`# ${address}:22 SSH-2.0-OpenSSH_9.9\n${address} ${key}\n`);
      },
    });
    expect(scan.rounds).toEqual([
      [
        { address: "192.0.2.10", key },
        { address: "2001:db8::10", key },
      ],
      [
        { address: "192.0.2.10", key },
        { address: "2001:db8::10", key },
      ],
    ]);
    expect(seen.map((request) => request.args.at(-1))).toEqual([
      "192.0.2.10",
      "2001:db8::10",
      "192.0.2.10",
      "2001:db8::10",
    ]);
    expect(pauses).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
  });
  test("accounts for a consistently unreachable family without a hostname fallback", async () => {
    const scan = await observeSshHost(descriptor(), root(), {
      now: () => time,
      pause: async () => {},
      run: async (request) =>
        request.args[0] === "-6" ? unavailable("2001:db8::10") : scanResult(`192.0.2.10 ${key}\n`),
    });
    expect(scan.rounds[0][1]).toEqual({ address: "2001:db8::10", key: null });
  });
  test("accepts the older runner's exact stderr banner without accepting other diagnostics", async () => {
    const evidence = await observeSshHost(descriptor(), root(), {
      now: () => time,
      pause: async () => {},
      run: async (request) => {
        const address = request.args.at(-1);
        return scanResult(`${address} ${key}\n`, 0, null, `# ${address}:22 SSH-2.0-OpenSSH_9.6\n`);
      },
    });
    expect(evidence.rounds[0].every((item) => item.key === key)).toBe(true);
  });
  for (const [name, output] of [
    ["alias", `host.example.org ${key}\n`],
    ["extra key", `192.0.2.10 ${key}\n192.0.2.10 ${key}\n`],
    ["comment", `# banner\n192.0.2.10 ${key}\n`],
    ["non-ASCII", `192.0.2.10 ${key}é\n`],
    ["certificate", `192.0.2.10 ssh-ed25519-cert-v01@openssh.com AAAA\n`],
  ])
    test(`refuses ${name} and removes its private directory`, async () => {
      const directory = root();
      await expect(
        observeSshHost(descriptor(), directory, {
          now: () => time,
          pause: async () => {},
          run: async () => scanResult(output),
        }),
      ).rejects.toThrow("trust-ssh-observation-failed");
      expect(readdirSync(directory)).toEqual([]);
    });
  test("rejects changing reachability, different family keys and both families unreachable", async () => {
    for (const fault of ["changed", "mismatch", "absent"]) {
      let calls = 0;
      const directory = root();
      await expect(
        observeSshHost(descriptor(), directory, {
          now: () => time,
          pause: async () => {},
          run: async (request) => {
            const index = calls++;
            if (fault === "absent" || (fault === "changed" && index === 3))
              return unavailable(request.args.at(-1) as string);
            let candidate = key;
            if (fault === "mismatch" && request.args[0] === "-6") {
              const blob = Buffer.from(key.split(" ")[1] as string, "base64");
              blob[50] = (blob[50] as number) ^ 1;
              candidate = `ssh-ed25519 ${blob.toString("base64")}`;
            }
            return scanResult(`${request.args.at(-1)} ${candidate}\n`);
          },
        }),
      ).rejects.toThrow("trust-ssh-observation-failed");
      expect(readdirSync(directory)).toEqual([]);
    }
  });
  test("signals, large diagnostics and a stale observation are failures, never unavailable keys", async () => {
    for (const fault of ["signal", "output", "stale"]) {
      let now = time;
      await expect(
        observeSshHost(descriptor(), root(), {
          now: () => now,
          pause: async () => {
            if (fault === "stale") now += 60_001;
          },
          run: async (request) =>
            fault === "signal"
              ? scanResult("", 1, "SIGTERM")
              : fault === "output"
                ? scanResult("x".repeat(8193))
                : scanResult(`${request.args.at(-1)} ${key}\n`),
        }),
      ).rejects.toThrow("trust-ssh-observation-failed");
    }
  });
  test("refuses ambiguous no-key results and diagnostics outside the initial literal connect", async () => {
    for (const candidate of [
      scanResult("", 1),
      scanResult("", 1, null, "private diagnostic"),
      scanResult("", 1, null, "read (2001:db8::10): Connection refused\n"),
      unavailable("2001:db8::11"),
      unavailable("2001:db8::10", "Connection timed out"),
      scanResult("# 2001:db8::10:22 SSH-2.0-OpenSSH_9.9\n", 1),
      scanResult(`2001:db8::10 ${key}\n`, 0, null, "protocol failure\n"),
      scanResult(`# host.example.org:22 SSH-2.0-OpenSSH_9.9\n2001:db8::10 ${key}\n`),
      scanResult(
        `# 2001:db8::10:22 SSH-2.0-OpenSSH_9.9\n2001:db8::10 ${key}\n`,
        0,
        null,
        "# 2001:db8::10:22 SSH-2.0-OpenSSH_9.6\n",
      ),
    ]) {
      await expect(
        observeSshHost(descriptor(), root(), {
          now: () => time,
          pause: async () => {},
          run: async (request) =>
            request.args[0] === "-6" ? candidate : scanResult(`192.0.2.10 ${key}\n`),
        }),
      ).rejects.toThrow("trust-ssh-observation-failed");
    }
  });
});

describe("durable-trust SSH connection", () => {
  test("actual journal reuses enrollment after a safe applied-baseline update", async () => {
    const objects = new Map<string, Uint8Array>();
    const pin: ValidatorPin = {
      name: "unbound",
      version: "1.26.1",
      mode: "local-validating",
      binary_sha256: "e".repeat(64),
      anchor_sha256: "f".repeat(64),
      runtime_manifest_sha256: "d".repeat(64),
    };
    const journal = new TrustJournal(
      {
        read: async (path) => objects.get(path) ?? null,
        write: async (path, bytes) => {
          objects.set(path, Uint8Array.from(bytes));
        },
      },
      {
        target: "staging",
        backend: "a".repeat(64),
        passphrase: "invented dedicated test trust passphrase",
        validator: pin,
        now: () => time,
      },
    );
    const d = descriptor();
    const authorization = {
      schema: 1,
      target: "staging",
      generation: proof().generation,
      previous: null,
      kind: "initial",
      descriptor_digest: privateDigest(d),
      run: { commit: "c".repeat(40), run: "123" },
      approved_at: time - 1000,
      expires_at: time + 60_000,
    };
    await journal.recordAuthorization(authorization);
    const ticket = await journal.begin(authorization, d, proof().enrollment_run, async () => ({
      schema: 1,
      observed_at: time,
      rounds: [
        [
          { address: d.addresses.ipv4, key },
          { address: d.addresses.ipv6, key },
        ],
        [
          { address: d.addresses.ipv4, key },
          { address: d.addresses.ipv6, key },
        ],
      ],
    }));
    const dns = (): DnssecEvidence => ({
      schema: 1,
      validator: pin,
      name: d.fqdn,
      type: "SSHFP",
      secure: true,
      bogus: false,
      havedata: true,
      nxdomain: false,
      rcode: 0,
      observed_at: time,
      ttl: 30,
      expires_at: time + 30_000,
      records: [canonicalEd25519(key).sshfp],
    });
    let published = false;
    await journal.publish(
      ticket,
      {
        read: async () => (published ? [proof().record] : []),
        write: async () => {
          published = true;
          return proof().record;
        },
      },
      async () => dns(),
    );
    await journal.finish(ticket);
    const request = command();
    request.descriptor.applied_generation = "44444444-4444-4444-8444-444444444444";
    request.descriptor.state.serial++;
    request.descriptor.state.digest = "9".repeat(64);
    let invocations = 0;
    await trustedSsh(
      request,
      (current) =>
        journal.connectionTrust(
          current,
          async () => true,
          async () => dns(),
        ),
      {
        now: () => time,
        run: async () => {
          invocations++;
          return result();
        },
      },
    );
    expect(invocations).toBe(1);
  });
  test("uses the exact durable key, private known_hosts, literal address and isolated options", async () => {
    const request = command();
    let confirmations = 0;
    const output = await trustedSsh(
      request,
      async (d) => {
        expect(d).toEqual(request.descriptor);
        confirmations++;
        return proof();
      },
      {
        now: () => time,
        run: async (process) => {
          expect(process.executable).toBe("/usr/bin/ssh");
          expect(process.args.slice(0, 4)).toEqual(["-F", "/dev/null", "-T", "-4"]);
          for (const option of [
            "StrictHostKeyChecking=yes",
            "VerifyHostKeyDNS=no",
            "GlobalKnownHostsFile=/dev/null",
            "HostKeyAlgorithms=ssh-ed25519",
            "UpdateHostKeys=no",
            "IdentityAgent=none",
            "IdentitiesOnly=yes",
            "ProxyCommand=none",
            "ProxyJump=none",
            "ControlMaster=no",
            "ClearAllForwardings=yes",
            "PasswordAuthentication=no",
          ])
            expect(process.args).toContain(option);
          const hosts = process.args
            .find((arg) => arg.startsWith("UserKnownHostsFile="))
            ?.slice("UserKnownHostsFile=".length) as string;
          expect(readFileSync(hosts, "utf8")).toBe(
            `tarubot-staging-${proof().generation} ${key}\n`,
          );
          expect(process.args.at(-2)).toBe("runtime@192.0.2.10");
          expect(process.args.at(-1)).toBe("'/bin/printf' '%s' 'literal $() `command` '\\'' text'");
          expect(process.input).toBeNull();
          return result("invented command output");
        },
      },
    );
    expect(Buffer.from(output).toString()).toBe("invented command output");
    expect(confirmations).toBe(1);
    expect(readdirSync(request.work_root)).toEqual(["invented-identity"]);
  });
  test("obtains a fresh proof on each invocation and can select the validated IPv6 literal", async () => {
    const request = command();
    request.address_family = "ipv6";
    let calls = 0;
    const confirm = async () => {
      calls++;
      return proof();
    };
    for (let i = 0; i < 2; i++)
      await trustedSsh(request, confirm, {
        now: () => time,
        run: async (process) => {
          expect(process.args[3]).toBe("-6");
          expect(process.args.at(-2)).toBe("runtime@2001:db8::10");
          return result();
        },
      });
    expect(calls).toBe(2);
  });
  test("expires after the asynchronous confirmation boundary before any SSH starts", async () => {
    const request = command();
    let now = time;
    let runs = 0;
    await expect(
      trustedSsh(
        request,
        async () => {
          now += 30_000;
          return proof();
        },
        {
          now: () => now,
          run: async () => {
            runs++;
            return result();
          },
        },
      ),
    ).rejects.toThrow("trusted-ssh-failed");
    expect(runs).toBe(0);
    expect(readdirSync(request.work_root)).toEqual(["invented-identity"]);
  });
  test("shared-buffer mutation during proof verification cannot rewrite snapshotted stdin", async () => {
    const request = command();
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([1, 2, 3]);
    request.input = shared;
    await trustedSsh(
      request,
      async () => {
        shared.fill(9);
        return proof();
      },
      {
        now: () => time,
        run: async (process) => {
          expect(process.input).toEqual(Uint8Array.from([1, 2, 3]));
          expect(process.input?.buffer instanceof SharedArrayBuffer).toBe(false);
          return result();
        },
      },
    );
  });
  test("caller mutation during proof verification cannot change validated command or input", async () => {
    const request = command();
    request.input = Uint8Array.from([1, 2, 3]);
    const expectedCommand = request.command
      .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
      .join(" ");
    await trustedSsh(
      request,
      async () => {
        request.command = ["/bin/echo", "changed"];
        request.timeout_ms = -1;
        request.user = "changed";
        request.address_family = "ipv6";
        request.input?.fill(0);
        return proof();
      },
      {
        now: () => time,
        run: async (process) => {
          expect(process.args.at(-1)).toBe(expectedCommand);
          expect(process.args.at(-2)).toBe("runtime@192.0.2.10");
          expect(process.timeout_ms).toBe(10_000);
          expect(process.input).toEqual(Uint8Array.from([1, 2, 3]));
          return result();
        },
      },
    );
  });
  test("refuses different descriptor, key digest or malformed generation before SSH", async () => {
    for (const fault of ["descriptor", "digest", "generation"]) {
      let runs = 0;
      await expect(
        trustedSsh(
          command(),
          async () => {
            const value = proof();
            if (fault === "descriptor") value.descriptor.addresses.ipv4 = "192.0.2.11";
            if (fault === "digest") value.sshfp.fingerprint = "0".repeat(64);
            if (fault === "generation") value.generation = "../../untrusted";
            return value;
          },
          {
            now: () => time,
            run: async () => {
              runs++;
              return result();
            },
          },
        ),
      ).rejects.toThrow("trusted-ssh-failed");
      expect(runs).toBe(0);
    }
  });
  test("refuses unsafe identity permissions, symlinks and hardlinks without touching them", async () => {
    for (const fault of ["permissions", "symlink", "hardlink", "parent"]) {
      const request = command();
      if (fault === "permissions") chmodSync(request.identity_file, 0o644);
      if (fault === "parent") chmodSync(request.work_root, 0o755);
      if (fault === "symlink" || fault === "hardlink") {
        const path = join(request.work_root, "alternate");
        (fault === "symlink" ? symlinkSync : linkSync)(request.identity_file, path);
        request.identity_file = path;
      }
      let confirmations = 0;
      await expect(
        trustedSsh(request, async () => {
          confirmations++;
          return proof();
        }),
      ).rejects.toThrow("trusted-ssh-failed");
      expect(confirmations).toBe(0);
      expect(existsSync(request.identity_file)).toBe(true);
    }
  });
  test("uncertain or failed commands stop once and redact diagnostics while cleaning up", async () => {
    for (const fault of ["exit", "signal", "output", "throw"]) {
      const request = command();
      let runs = 0;
      await expect(
        trustedSsh(request, async () => proof(), {
          now: () => time,
          run: async () => {
            runs++;
            if (fault === "throw") throw new Error("private host/path/key diagnostic");
            if (fault === "signal") return result("", null, "SIGTERM");
            if (fault === "output") return result("x".repeat(1024 * 1024));
            return result("private remote text", 255);
          },
        }),
      ).rejects.toThrow("trusted-ssh-failed");
      expect(runs).toBe(1);
      expect(readdirSync(request.work_root)).toEqual(["invented-identity"]);
    }
  });
});

const processModule = new URL("../../scripts/trust-ssh.ts", import.meta.url).href;
function isolatedProcess(source: string): void {
  // Installing the fake native transport is verified before importing or invoking SSH code.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
    env: { TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: child.exitCode, diagnostic: Buffer.from(child.stderr).toString() }).toEqual({
    code: 0,
    diagnostic: "",
  });
  expect(child.stdout.byteLength).toBe(0);
}
describe("SSH original preparation window", () => {
  test("first clock, dependency and input reflection costs precede every trust/native offer", () => {
    const request = command();
    isolatedProcess(`
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      const input=${JSON.stringify({ request, proof: proof() })};
      for(const phase of ["clock","dependency","input"]){
        elapsed=0;let trust=0,offers=0,first=true;
        const request=phase==="input"?new Proxy(input.request,{ownKeys(value){elapsed=60;return Reflect.ownKeys(value);}}):input.request;
        const deps={preparation_timeout_ms:50,now:()=>{if(phase==="clock"&&first){first=false;elapsed=60;}return ${time};},run:async()=>{offers++;throw Error("private");}};
        if(phase==="dependency")Object.defineProperty(deps,"run",{get(){elapsed=60;return async()=>{offers++;throw Error("private");};}});
        try{await trustedSsh(request,async()=>{trust++;return input.proof;},deps);process.exit(1);}
        catch(error){if(error.message!=="trusted-ssh-failed")process.exit(2);}
        if(trust||offers)process.exit(3);
      }
    `);
  });
  test("the same guard reaches the actual reader and stops its late next read after timeout", async () => {
    const request = command();
    let offers = 0,
      processOffers = 0,
      resume!: () => void;
    const held = new Promise<void>((r) => {
      resume = r;
    });
    await expect(
      trustedSsh(
        request,
        async (_descriptor, refusal) => {
          expect(typeof refusal).toBe("function");
          refusal?.();
          offers++;
          await held;
          refusal?.();
          offers++;
          return proof();
        },
        {
          now: () => time,
          preparation_timeout_ms: 20,
          run: async () => {
            processOffers++;
            return result();
          },
        },
      ),
    ).rejects.toThrow("trusted-ssh-failed");
    expect(offers).toBe(1);
    resume();
    await Bun.sleep(5);
    expect(offers).toBe(1);
    expect(processOffers).toBe(0);
    expect(readdirSync(request.work_root)).toEqual(["invented-identity"]);
  });
  test("clock callbacks cannot swallow a nested original-guard denial", async () => {
    const request = command();
    let original: (() => void) | undefined,
      reenter = false,
      offers = 0;
    await expect(
      trustedSsh(
        request,
        async (_descriptor, refusal) => {
          original = refusal;
          reenter = true;
          return proof();
        },
        {
          now: () => {
            if (reenter) {
              reenter = false;
              try {
                original?.();
              } catch {
                /* Permanent outer denial. */
              }
            }
            return time;
          },
          run: async () => {
            offers++;
            return result();
          },
        },
      ),
    ).rejects.toThrow("trusted-ssh-failed");
    expect(offers).toBe(0);
  });
  test("the refusal is checked after a clock callback and rejects Boolean approval values", async () => {
    for (const fault of ["clock", "false", "true"] as const) {
      const request = command();
      let denied = false,
        trustOffers = 0;
      await expect(
        trustedSsh(
          request,
          async () => {
            trustOffers++;
            return proof();
          },
          {
            now: () => {
              denied = true;
              return time;
            },
            denial: (() => {
              if (fault === "clock" && denied) throw Error("private");
              return fault === "clock" ? undefined : fault === "true";
            }) as () => void,
          },
        ),
      ).rejects.toThrow("trusted-ssh-failed");
      expect(trustOffers).toBe(0);
    }
  });
  test("rejected cross-realm clock/refusal promises drain without evaluating a caller then", () => {
    const request = command();
    isolatedProcess(`
      import vm from "node:vm";
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      const input=${JSON.stringify({ request, proof: proof() })};let unhandled=0;
      process.on("unhandledRejection",()=>unhandled++);
      for(const phase of ["clock","denial"]){
        let trust=0,offers=0,thenReads=0;
        const value=vm.runInNewContext('Promise.reject(Error("private"))');
        Object.defineProperty(value,"then",{get(){thenReads++;throw Error("private");}});
        try{await trustedSsh(input.request,async()=>{trust++;return input.proof;},{now:()=>phase==="clock"?value:${time},denial:()=>phase==="denial"?value:undefined,run:async()=>{offers++;}});process.exit(1);}
        catch(error){if(error.message!=="trusted-ssh-failed")process.exit(2);}
        if(trust||offers||thenReads)process.exit(3);
      }
      await new Promise(r=>setTimeout(r,5));if(unhandled)process.exit(4);
    `);
  });
  test("a late metadata return cannot offer another path read, pin write or native process", () => {
    const request = command();
    isolatedProcess(`
      import {spyOn} from "bun:test";
      import * as fs from "node:fs";
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const input=${JSON.stringify({ request, proof: proof() })};let metadata=0,writes=0,trust=0,offers=0;
      const original=fs.lstatSync;
      const patched=spyOn(fs,"lstatSync").mockImplementation((...args)=>{metadata++;const stat=original(...args);elapsed=50;return stat;});
      const write=spyOn(fs,"writeFileSync").mockImplementation(()=>{writes++;throw Error("unexpected-write");});
      const transport=await import("node:fs");if(transport.lstatSync!==patched||transport.writeFileSync!==write)throw Error("fake filesystem not installed");
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      try{await trustedSsh(input.request,async()=>{trust++;return input.proof;},{now:()=>${time},preparation_timeout_ms:50,run:async()=>{offers++;}});process.exit(1);}
      catch(error){if(error.message!=="trusted-ssh-failed")process.exit(2);}
      if(metadata!==1||writes||trust||offers)process.exit(3);
    `);
  });
  test("the default native spawn sees the last guard and valid commands outlive observation expiry", () => {
    const request = command();
    isolatedProcess(`
      import {spyOn} from "bun:test";
      import * as cp from "node:child_process";
      import {EventEmitter} from "node:events";
      import {PassThrough} from "node:stream";
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const input=${JSON.stringify({ request, proof: proof() })};let wall=${time},offers=0;
      input.proof.expires_at=wall+20;input.request.timeout_ms=1000;
      const fake=spyOn(cp,"spawn").mockImplementation((executable,args,options)=>{
        offers++;if(executable!=="/usr/bin/ssh"||options.env.PATH!=="/usr/bin:/bin"||Object.keys(options.env).sort().join(",")!=="HOME,LANG,LC_ALL,PATH")throw Error("invalid-native-request");
        const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
        queueMicrotask(()=>{elapsed=100;wall+=100;child.stdout.write(Buffer.from("ok"));child.stdout.end();child.stderr.end();child.emit("close",0,null);});
        return child;
      });
      const transport=await import("node:child_process");if(transport.spawn!==fake||cp.spawn!==fake)throw Error("fake native spawn not installed");
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      const output=await trustedSsh(input.request,async()=>input.proof,{now:()=>wall,preparation_timeout_ms:50});
      if(offers!==1||Buffer.from(output).toString()!=="ok")process.exit(1);
    `);
  });
  test("actual byte limits ignore iterators/shadowed lengths while copying private input/output", async () => {
    const request = command();
    const original = new Uint8Array([1, 2, 3]);
    let iteratorCalls = 0;
    Object.defineProperty(original, Symbol.iterator, {
      value: function* () {
        iteratorCalls++;
        yield 99;
      },
    });
    request.input = original;
    const output = await trustedSsh(request, async () => proof(), {
      now: () => time,
      run: async (prepared) => {
        expect(prepared.input).toEqual(new Uint8Array([1, 2, 3]));
        const stdout = new Uint8Array([4, 5]);
        Object.defineProperty(stdout, Symbol.iterator, {
          value: function* () {
            iteratorCalls++;
            yield 99;
          },
        });
        return { code: 0, signal: null, stdout, stderr: new Uint8Array() };
      },
    });
    expect(output).toEqual(new Uint8Array([4, 5]));
    expect(iteratorCalls).toBe(0);
    const oversized = new Uint8Array(1_048_577);
    Object.defineProperty(oversized, "length", { value: 1 });
    await expect(
      trustedSsh(command(), async () => proof(), {
        now: () => time,
        run: async () => ({ code: 0, signal: null, stdout: oversized, stderr: new Uint8Array() }),
      }),
    ).rejects.toThrow("trusted-ssh-failed");
  });
});

describe("default SSH native offer", () => {
  test("argv capture cannot move the final native spawn past original proof expiry", () => {
    const request = command();
    isolatedProcess(`
      import {spyOn} from "bun:test";
      import * as cp from "node:child_process";
      import {performance} from "node:perf_hooks";
      let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const input=${JSON.stringify({ request, proof: proof() })};input.proof.expires_at=${time}+20;
      let wall=${time},offers=0,captures=0;
      const fake=spyOn(cp,"spawn").mockImplementation(()=>{offers++;throw Error("unexpected-native-offer");});
      const transport=await import("node:child_process");if(transport.spawn!==fake||cp.spawn!==fake)throw Error("fake native spawn not installed");
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      const iterator=Array.prototype[Symbol.iterator];
      try{
        await trustedSsh(input.request,async()=>{
          Array.prototype[Symbol.iterator]=function(){if(this[0]==="-F"&&this.includes("StrictHostKeyChecking=yes")){captures++;elapsed=20;wall+=20;}return iterator.call(this);};
          return input.proof;
        },{now:()=>wall,preparation_timeout_ms:50});process.exit(1);
      }catch(error){if(error.message!=="trusted-ssh-failed")process.exit(2);}
      finally{Array.prototype[Symbol.iterator]=iterator;}
      if(captures!==1||offers!==0)process.exit(3);
    `);
  });
});

describe("sticky SSH preparation caps", () => {
  test("final refusal and simultaneous short-clock work stop every next reader/process offer", () => {
    const request = command();
    isolatedProcess(`
      import {performance} from "node:perf_hooks";let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const {trustedSsh}=await import(${JSON.stringify(processModule)});
      const input=${JSON.stringify({ request, proof: proof() })};input.proof.expires_at=${time}+120000;
      for(const phase of ["final-denial","seen-short","slow-short"]){
        elapsed=0;let wall=${time},calls=0,trust=0,next=0,spawn=0;
        const denial=()=>{if(phase==="final-denial"&&++calls===2)wall+=60000;};
        const now=()=>wall;
        const reader=async(_descriptor,guard)=>{
          trust++;wall+=59980;
          if(phase==="slow-short")elapsed+=60;
          guard();
          if(phase==="seen-short"){elapsed+=60;guard();}
          next++;return input.proof;
        };
        let failed=false;try{await trustedSsh(input.request,reader,{now,denial,run:async()=>{spawn++;return {code:0,signal:null,stdout:new Uint8Array(),stderr:new Uint8Array()};}});}catch(error){failed=error.message==="trusted-ssh-failed";}
        if(!failed||next||spawn||trust!==(phase==="final-denial"?0:1))throw Error("late preparation offer");
      }
    `);
  });
  test("a short observation inside a held reader rearms the original timer", async () => {
    const request = command();
    let wall = time,
      offers = 0;
    const start = performance.now();
    await expect(
      trustedSsh(
        request,
        async (_descriptor, guard) => {
          wall += 59_980;
          guard?.();
          offers++;
          return await new Promise<ConnectionProof>(() => {});
        },
        {
          now: () => wall,
          run: async () => {
            throw Error("unexpected-native-offer");
          },
        },
      ),
    ).rejects.toThrow("trusted-ssh-failed");
    expect(offers).toBe(1);
    expect(performance.now() - start).toBeLessThan(250);
    expect(readdirSync(request.work_root)).toEqual(["invented-identity"]);
  });
  test("owned native argv capture counts simultaneous wall shortening and physical cost", () => {
    const request = command();
    isolatedProcess(`
      import {spyOn} from "bun:test";import * as cp from "node:child_process";import {performance} from "node:perf_hooks";
      let elapsed=0,wall=${time},offers=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
      const patched=spyOn(cp,"spawn").mockImplementation(()=>{offers++;throw Error("unexpected-native-offer");});
      const imported=await import("node:child_process");if(imported.spawn!==patched)throw Error("mock not installed");
      const {trustedSsh}=await import(${JSON.stringify(processModule)});const input=${JSON.stringify({ request, proof: proof() })};input.proof.expires_at=${time}+120000;
      const iterator=Array.prototype[Symbol.iterator];let enabled=false;
      Array.prototype[Symbol.iterator]=function(){if(enabled&&this[0]==="-F"&&this.includes("StrictHostKeyChecking=yes")){enabled=false;wall+=59980;elapsed+=60;}return iterator.call(this);};
      let failed=false;try{await trustedSsh(input.request,async()=>{enabled=true;return input.proof;},{now:()=>wall});}catch(error){failed=error.message==="trusted-ssh-failed";}finally{Array.prototype[Symbol.iterator]=iterator;}
      if(!failed||offers!==0)throw Error("expired native SSH offered");
    `);
  });
});

test("proof reflection and guard-aware runner hooks retain their actual pre-hook anchor", () => {
  const request = command();
  isolatedProcess(`
    import {performance} from "node:perf_hooks";let elapsed=0;Object.defineProperty(performance,"now",{value:()=>elapsed});
    const {trustedSsh}=await import(${JSON.stringify(processModule)});
    const input=${JSON.stringify({ request, proof: proof() })};
    for(const phase of ["expiry","ownKeys","prototype","runner"]){
      elapsed=0;let wall=${time},offers=0,trapped=false;
      const expire=()=>{if(!trapped){trapped=true;wall+=29980;elapsed+=60;}};
      const proxy=new Proxy(input.proof,{
        getOwnPropertyDescriptor(value,key){if(phase==="expiry"&&key==="expires_at")expire();return Reflect.getOwnPropertyDescriptor(value,key);},
        ownKeys(value){if(phase==="ownKeys")expire();return Reflect.ownKeys(value);},
        getPrototypeOf(value){if(phase==="prototype")expire();return Reflect.getPrototypeOf(value);},
      });
      let refused=false;try{await trustedSsh(input.request,async()=>proxy,{now:()=>wall,run:async(_request,guard)=>{if(phase==="runner")expire();guard();offers++;throw Error("invented-stop");}});}catch(error){refused=error.message==="trusted-ssh-failed";}
      if(!refused||offers!==0||!trapped)throw Error("late reflection/runner native offer");
    }
  `);
});
