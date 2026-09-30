/** Actual invented child processes exercise streaming; no SSH, resolver or host key is used. */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalEd25519, type TargetDescriptor } from "../../scripts/ssh-trust.js";
import {
  createTrustedSshStream,
  type TrustedSshStreamConfiguration,
  type TrustedSshStreamRequest,
  type TrustStreamSpawner,
  type TrustStreamSpawnRequest,
} from "../../scripts/trust-ssh-stream.js";
import {
  trustedSsh,
  type ConnectionProof,
  type TrustProcessRunner,
} from "../../scripts/trust-ssh.js";

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const instant = 1_800_000_000_000;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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
    expires_at: instant + 30_000,
  };
}
function configuration(): TrustedSshStreamConfiguration {
  const root = mkdtempSync(join(tmpdir(), "tarubot-ssh-stream-test-"));
  roots.push(root);
  const identity = join(root, "invented-identity");
  writeFileSync(identity, "invented non-key fixture", { mode: 0o600 });
  return {
    descriptor: descriptor(),
    address_family: "ipv4",
    user: "root",
    identity_file: identity,
    work_root: root,
    timeout_ms: 2000,
  };
}
function channel() {
  const bytes: Uint8Array[] = [];
  return {
    bytes,
    stream: new WritableStream<Uint8Array>({
      write(value) {
        bytes.push(Uint8Array.from(value));
      },
    }),
    result: () => Buffer.concat(bytes.map((value) => Buffer.from(value))),
  };
}
function request(input: ReadableStream<Uint8Array> | null = null) {
  const stdout = channel();
  const stderr = channel();
  const value: TrustedSshStreamRequest = {
    command: ["/bin/sh", "-c", "invented literal command"],
    input,
    stdout: stdout.stream,
    stderr: stderr.stream,
  };
  return { value, stdout, stderr };
}
function source(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function subprocess(script: string, observe?: (request: TrustStreamSpawnRequest) => void) {
  const calls: TrustStreamSpawnRequest[] = [];
  const run: TrustStreamSpawner = (value) => {
    calls.push(structuredClone(value));
    observe?.(value);
    // The trusted seam substitutes a harmless local child only after checking the SSH request.
    const child = spawn(process.execPath, ["--no-env-file", "-e", script], {
      cwd: value.directory,
      env: { PATH: "/usr/bin:/bin", HOME: value.directory, LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  return { calls, run };
}
async function refused(action: Promise<unknown>) {
  try {
    await action;
    throw new Error("expected-invented-refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("trusted-ssh-stream-failed");
  }
}

describe("fresh guarded SSH streaming", () => {
  test("streams the sudo success marker before gated binary stdin and preserves stdout/stderr", async () => {
    const config = configuration();
    let marker: (() => void) | undefined;
    const ready = new Promise<void>((accept) => {
      marker = accept;
    });
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    const input = new ReadableStream<Uint8Array>({
      async start(controller) {
        await ready;
        controller.enqueue(binary);
        controller.close();
      },
    });
    const r = request(input);
    const captured: Uint8Array[] = [];
    r.value.stdout = new WritableStream({
      write(bytes) {
        captured.push(Uint8Array.from(bytes));
        marker?.();
      },
    });
    const fake = subprocess(
      'process.stdout.write("BECOME-SUCCESS-invented\\n");process.stdin.on("data",b=>process.stdout.write(b));process.stdin.on("end",()=>process.stderr.write("invented warning\\n"));',
      (prepared) => {
        expect(prepared.executable).toBe("/usr/bin/ssh");
        expect(prepared.args.slice(0, 4)).toEqual(["-F", "/dev/null", "-T", "-4"]);
        expect(prepared.args.at(-2)).toBe("root@192.0.2.10");
        expect(prepared.args.at(-1)).toBe("'/bin/sh' '-c' 'invented literal command'");
        for (const option of [
          "StrictHostKeyChecking=yes",
          "VerifyHostKeyDNS=no",
          "GlobalKnownHostsFile=/dev/null",
          "HostKeyAlgorithms=ssh-ed25519",
          "IdentityAgent=none",
          "IdentitiesOnly=yes",
          "UpdateHostKeys=no",
          "ControlMaster=no",
          "ControlPath=none",
          "ControlPersist=no",
          "ProxyCommand=none",
          "ProxyJump=none",
          "ClearAllForwardings=yes",
          "CertificateFile=none",
          "ConnectionAttempts=1",
        ])
          expect(prepared.args).toContain(option);
        const pin = prepared.args.find((arg) => arg.startsWith("UserKnownHostsFile="));
        expect(readFileSync(pin?.slice("UserKnownHostsFile=".length) ?? "", "utf8")).toBe(
          `tarubot-staging-${proof().generation} ${key}\n`,
        );
      },
    );
    let confirmations = 0;
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      connectionTrust: async (current) => {
        expect(current).toEqual(config.descriptor);
        confirmations++;
        return proof();
      },
      spawn: fake.run,
    });
    const result = await transport.run(r.value);
    const expected = Buffer.concat([Buffer.from("BECOME-SUCCESS-invented\n"), Buffer.from(binary)]);
    expect(Buffer.concat(captured.map((bytes) => Buffer.from(bytes)))).toEqual(expected);
    expect(r.stderr.result().toString()).toBe("invented warning\n");
    expect(result).toEqual({
      code: 0,
      input_bytes: binary.length,
      stdout_bytes: expected.length,
      stderr_bytes: Buffer.byteLength("invented warning\n"),
    });
    expect(confirmations).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
  });
  test("each exchange obtains a fresh proof/pin, including IPv6 and ordinary remote nonzero exits", async () => {
    const config = configuration();
    config.address_family = "ipv6";
    let confirmations = 0;
    const fake = subprocess(
      'process.stdin.on("end",()=>{process.stdout.write("result");process.stderr.write("diagnostic");process.exitCode=23;});process.stdin.resume();',
    );
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      connectionTrust: async () => {
        confirmations++;
        return proof();
      },
      spawn: fake.run,
    });
    for (let index = 0; index < 2; index++) {
      const r = request();
      expect((await transport.run(r.value)).code).toBe(23);
      expect(r.stdout.result().toString()).toBe("result");
      expect(r.stderr.result().toString()).toBe("diagnostic");
    }
    expect(confirmations).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.args[3] === "-6")).toBe(true);
    expect(fake.calls.every((call) => call.args.at(-2) === "root@2001:db8::10")).toBe(true);
    expect(fake.calls[0]?.directory).not.toBe(fake.calls[1]?.directory);
  });
  test("captures private config/capabilities and command/channels before the proof await", async () => {
    const config = configuration();
    const original = structuredClone(config);
    const r = request(source(Uint8Array.from([1, 2, 3])));
    const fake = subprocess('process.stdin.on("data",b=>process.stdout.write(b));');
    const deps = {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => {
        config.descriptor.addresses.ipv4 = "192.0.2.99";
        config.identity_file = "/invented/replacement";
        config.work_root = "/invented/replacement";
        config.address_family = "ipv6";
        r.value.command.fill("replaced");
        r.value.stdout = channel().stream;
        r.value.input = source(Uint8Array.from([9]));
        deps.spawn = () => {
          throw new Error("replacement must not run");
        };
        deps.now = () => instant + 60_001;
        return proof();
      },
    };
    const transport = createTrustedSshStream(config, deps);
    await transport.run(r.value);
    expect(r.stdout.result()).toEqual(Buffer.from([1, 2, 3]));
    expect(fake.calls[0]?.args.at(-2)).toBe("root@192.0.2.10");
    expect(fake.calls[0]?.args.at(-1)).toBe("'/bin/sh' '-c' 'invented literal command'");
    expect(fake.calls[0]?.args).toContain(original.identity_file);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(JSON.stringify(transport)).toBe("{}");
    expect(Bun.inspect(transport)).not.toContain(original.identity_file);
    expect(Reflect.set(transport, "configuration", config)).toBe(false);
    expect(Reflect.get(transport, "spawn")).toBeUndefined();
  });
  test("rejects malformed/accessor configuration and request without calling its getters or trust", async () => {
    const config = configuration();
    let getterCalls = 0;
    Object.defineProperty(config, "descriptor", {
      enumerable: true,
      get() {
        getterCalls++;
        return descriptor();
      },
    });
    expect(() => createTrustedSshStream(config, { connectionTrust: async () => proof() })).toThrow(
      "invalid-trusted-ssh-stream",
    );
    expect(getterCalls).toBe(0);
    let confirmations = 0;
    const transport = createTrustedSshStream(configuration(), {
      connectionTrust: async () => {
        confirmations++;
        return proof();
      },
    });
    const r = request();
    Object.defineProperty(r.value, "command", {
      enumerable: true,
      get() {
        getterCalls++;
        return ["replacement"];
      },
    });
    await refused(transport.run(r.value));
    expect(getterCalls).toBe(0);
    expect(confirmations).toBe(0);
  });
  test("rejects expired/changed/failed proof before any subprocess and never retries", async () => {
    for (const fault of ["expired", "address", "digest", "refused", "permissions"]) {
      const config = configuration();
      const fake = subprocess("process.stdin.resume();");
      let confirmations = 0;
      const transport = createTrustedSshStream(config, {
        now: () => instant,
        spawn: fake.run,
        connectionTrust: async () => {
          confirmations++;
          const p = proof();
          if (fault === "expired") p.expires_at = instant;
          if (fault === "address") p.descriptor.addresses.ipv4 = "192.0.2.99";
          if (fault === "digest") p.sshfp.fingerprint = "f".repeat(64);
          if (fault === "permissions") chmodSync(config.identity_file, 0o644);
          if (fault === "refused") throw new Error("invented private owner diagnostic");
          return p;
        },
      });
      await refused(transport.run(request().value));
      await refused(transport.run(request().value));
      expect(confirmations).toBe(1);
      expect(fake.calls).toHaveLength(0);
      expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
    }
  });
  test("slow proof expires under a frozen wall clock and its late completion cannot spawn", async () => {
    const config = configuration();
    config.preparation_timeout_ms = 20;
    const fake = subprocess("process.stdin.resume();");
    let finished = false;
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => {
        await Bun.sleep(55);
        finished = true;
        return proof();
      },
    });
    await refused(transport.run(request().value));
    await Bun.sleep(65);
    expect(finished).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
  });
  test("CPU-blocking proof cannot evade physical TTL expiry with a frozen wall clock", async () => {
    const config = configuration();
    config.preparation_timeout_ms = 1000;
    const fake = subprocess("process.stdin.resume();");
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => {
        const until = performance.now() + 35;
        while (performance.now() < until) {
          /* An event-loop stall prevents the timeout callback from rescuing expiry validation. */
        }
        return { ...proof(), expires_at: instant + 20 };
      },
    });
    await refused(transport.run(request().value));
    expect(fake.calls).toHaveLength(0);
  });
});

describe("private channel and uncertain-process fencing", () => {
  test("255 and signals are fixed failures with one process and a permanently fenced capability", async () => {
    for (const script of [
      'process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("host.example.org 192.0.2.10 private-key private-path");process.exitCode=255;});',
      'process.kill(process.pid,"SIGTERM");',
    ]) {
      const config = configuration();
      const fake = subprocess(script);
      let confirmations = 0;
      const transport = createTrustedSshStream(config, {
        now: () => instant,
        spawn: fake.run,
        connectionTrust: async () => {
          confirmations++;
          return proof();
        },
      });
      await refused(transport.run(request().value));
      await refused(transport.run(request().value));
      expect(fake.calls).toHaveLength(1);
      expect(confirmations).toBe(1);
      expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
    }
  });
  test("a stalled input/process is killed at physical timeout; cancellation acknowledgement need not settle", async () => {
    const config = configuration();
    config.timeout_ms = 1000;
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const r = request(input);
    const fake = subprocess('setInterval(()=>process.stdout.write("tick"),100);');
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => proof(),
    });
    await refused(transport.run(r.value));
    const output = r.stdout.result();
    await Bun.sleep(130);
    expect(r.stdout.result()).toEqual(output);
    expect(cancelled).toBe(true);
    expect(children.at(-1)?.signalCode).toBe("SIGKILL");
    expect(fake.calls).toHaveLength(1);
    expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
  });
  test("sink failure aborts every pipe without relaying further bytes or retrying", async () => {
    const config = configuration();
    const r = request();
    let writes = 0;
    r.value.stdout = new WritableStream({
      write() {
        writes++;
        throw new Error("invented private sink failure");
      },
    });
    const fake = subprocess('setInterval(()=>process.stdout.write("private bytes"),5);');
    const transport = createTrustedSshStream(config, {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => proof(),
    });
    await refused(transport.run(r.value));
    await Bun.sleep(30);
    expect(writes).toBe(1);
    expect(children.at(-1)?.signalCode).toBe("SIGKILL");
    expect(fake.calls).toHaveLength(1);
  });
  test("input/output size bounds fail once and cannot leak diagnostics as an error", async () => {
    for (const direction of ["input", "output"]) {
      const config = configuration();
      const fake = subprocess(
        direction === "input"
          ? "process.stdin.resume();"
          : "process.stdin.resume();process.stdout.write(Buffer.alloc(8*1024*1024+1));",
      );
      let iteratorCalls = 0;
      const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
      Object.defineProperty(oversized, "byteLength", { value: 0 });
      Object.defineProperty(oversized, Symbol.iterator, {
        value() {
          iteratorCalls++;
          throw new Error("caller iterator must not run before the intrinsic size refusal");
        },
      });
      const r = request(direction === "input" ? source(oversized) : null);
      const transport = createTrustedSshStream(config, {
        now: () => instant,
        spawn: fake.run,
        connectionTrust: async () => proof(),
      });
      await refused(transport.run(r.value));
      expect(iteratorCalls).toBe(0);
      expect(fake.calls).toHaveLength(1);
      expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
    }
  });
  test("channels cannot be reused even through another factory, and concurrent calls do not reroute the first", async () => {
    const config = configuration();
    const fake = subprocess(
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("ok"));',
    );
    let release: (() => void) | undefined;
    const wait = new Promise<void>((accept) => {
      release = accept;
    });
    let confirmations = 0;
    const deps = {
      now: () => instant,
      spawn: fake.run,
      connectionTrust: async () => {
        confirmations++;
        await wait;
        return proof();
      },
    };
    const transport = createTrustedSshStream(config, deps);
    const r = request();
    const first = transport.run(r.value);
    await refused(transport.run(request().value));
    release?.();
    expect((await first).code).toBe(0);
    await refused(createTrustedSshStream(config, deps).run(r.value));
    expect(fake.calls).toHaveLength(1);
    expect(confirmations).toBe(1);
  });
  test("wall-clock rollback during I/O stops a running exchange", async () => {
    const config = configuration();
    let now = instant;
    const r = request();
    r.value.stdout = new WritableStream({
      write() {
        now = instant - 1;
      },
    });
    const fake = subprocess('setInterval(()=>process.stdout.write("private"),5);');
    const transport = createTrustedSshStream(config, {
      now: () => now,
      spawn: fake.run,
      connectionTrust: async () => proof(),
    });
    await refused(transport.run(r.value));
    expect(fake.calls).toHaveLength(1);
  });
});

describe("legacy transport shares the stricter preparation boundary", () => {
  test("captures the original runner and still rejects known remote nonzero results", async () => {
    const config = configuration();
    let runs = 0;
    const deps: { now: () => number; run: TrustProcessRunner } = {
      now: () => instant,
      run: async () => {
        runs++;
        return { code: 1, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
    };
    await expect(
      trustedSsh(
        { ...config, command: ["/bin/true"] },
        async () => {
          deps.run = async () => {
            throw new Error("replacement must not run");
          };
          return proof();
        },
        deps,
      ),
    ).rejects.toThrow("trusted-ssh-failed");
    expect(runs).toBe(1);
  });
  test("a late proof or expired physical TTL cannot invoke the legacy runner", async () => {
    for (const fault of ["late", "physical-ttl"]) {
      const config = configuration();
      let runs = 0;
      await expect(
        trustedSsh(
          { ...config, command: ["/bin/true"] },
          async () => {
            await Bun.sleep(35);
            return { ...proof(), expires_at: instant + (fault === "late" ? 30_000 : 20) };
          },
          {
            now: () => instant,
            preparation_timeout_ms: fault === "late" ? 20 : 1000,
            run: async () => {
              runs++;
              return { code: 0, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array() };
            },
          },
        ),
      ).rejects.toThrow("trusted-ssh-failed");
      await Bun.sleep(40);
      expect(runs).toBe(0);
      expect(readdirSync(config.work_root)).toEqual(["invented-identity"]);
    }
  });
});
