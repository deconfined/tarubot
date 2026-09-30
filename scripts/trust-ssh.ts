/**
 * SSH transport for the replacement pipeline. These adapters confer no enrollment authority:
 * observation is called only after the trust journal's durable intent, and authentication needs
 * that journal's independently confirmed completed enrollment plus fresh local DNSSEC evidence.
 */
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
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
export type TrustProcessRunner = (request: TrustProcessRequest) => Promise<TrustProcessResult>;

/** Bounded private subprocesses never inherit Actions tokens, SSH agents, proxies or tool config. */
const execute: TrustProcessRunner = (request) =>
  new Promise((accept, reject) => {
    const output: Buffer[] = [];
    const diagnostic: Buffer[] = [];
    let size = 0;
    let refused = false;
    const child = spawn(request.executable, request.args, {
      cwd: request.directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: request.directory,
        LANG: "C",
        LC_ALL: "C",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => {
      refused = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, request.timeout_ms);
    const collect = (buffers: Buffer[], value: Buffer) => {
      size += value.length;
      if (size > request.output_limit) stop();
      else buffers.push(value);
    };
    child.stdout.on("data", (value: Buffer) => collect(output, value));
    child.stderr.on("data", (value: Buffer) => collect(diagnostic, value));
    child.stdin.on("error", () => {
      // A closed input pipe is evidence of a failed transport, never a reason to retry it.
      stop();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("trust-ssh-process-failed"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (refused) reject(new Error("trust-ssh-process-failed"));
      else
        accept({ code, signal, stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostic) });
    });
    child.stdin.end(request.input);
  });

/** Paths are literal OpenSSH option values; disallow tokens/quoting and private-file symlinks. */
function privatePath(value: string, directory: boolean): string {
  requireTransport(/^\/[A-Za-z0-9_./-]+$/u.test(value) && resolve(value) === value);
  const components = value.split("/").filter(Boolean);
  let current = "";
  for (const part of components) {
    current += `/${part}`;
    requireTransport(!lstatSync(current).isSymbolicLink());
  }
  const stat = lstatSync(value);
  requireTransport(
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
  );
  return value;
}
function instant(now: () => number): number {
  const value = now();
  requireTransport(Number.isSafeInteger(value) && value > 0);
  return value;
}
function processResult(value: TrustProcessResult, limit: number): TrustProcessResult {
  requireTransport(
    value &&
      (value.code === null || (Number.isInteger(value.code) && value.code >= 0)) &&
      (value.signal === null || typeof value.signal === "string") &&
      value.stdout instanceof Uint8Array &&
      value.stderr instanceof Uint8Array &&
      value.stdout.length + value.stderr.length <= limit,
  );
  return value;
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
  connectionTrust: (descriptor: TargetDescriptor) => Promise<ConnectionProof>,
  dependencies: {
    run?: TrustProcessRunner;
    now?: () => number;
    /** A stricter preparation budget is allowed; this cannot extend the sixty-second bound. */
    preparation_timeout_ms?: number;
  } = {},
): Promise<Uint8Array> {
  let directory: string | undefined;
  let preparationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Capture trusted capabilities before any await; replacing a dependency must not reroute SSH.
    const run = dependencies.run ?? execute;
    const now = dependencies.now ?? Date.now;
    const preparationBudget = dependencies.preparation_timeout_ms ?? 60_000;
    requireTransport(
      typeof run === "function" &&
        typeof now === "function" &&
        typeof connectionTrust === "function" &&
        Number.isInteger(preparationBudget) &&
        preparationBudget > 0 &&
        preparationBudget <= 60_000,
    );
    // Callback awaits may run arbitrary asynchronous work; never reread mutable caller inputs.
    request = structuredClone(request);
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
    // structuredClone retains SharedArrayBuffer storage. Copy bytes into an ordinary private
    // buffer so a caller cannot rewrite validated stdin while the trust proof is awaited.
    if (request.input !== undefined) request.input = Uint8Array.from(request.input);
    privatePath(request.work_root, true);
    const identity = privatePath(request.identity_file, false);
    privatePath(resolve(identity, ".."), true);
    directory = mkdtempSync(join(request.work_root, "ssh-connect-"));
    const started = instant(now);
    const physicalStarted = performance.now();
    const physicalDeadline = physicalStarted + preparationBudget;
    const proof = structuredClone(
      await Promise.race([
        Promise.resolve().then(() => connectionTrust(structuredClone(descriptor))),
        new Promise<never>((_, reject) => {
          preparationTimer = setTimeout(
            () => reject(new Error("trusted-ssh-failed")),
            preparationBudget,
          );
        }),
      ]),
    );
    clearTimeout(preparationTimer);
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
    const alias = `tarubot-${descriptor.target}-${proof.generation}`;
    const hosts = join(directory, "known_hosts");
    const pin = `${alias} ${key.key}\n`;
    writeFileSync(hosts, pin, { mode: 0o600, flag: "wx" });
    requireTransport(readFileSync(hosts, "utf8") === pin);
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
    // A proof callback cannot replace the originally validated private paths while it is awaited.
    privatePath(request.work_root, true);
    privatePath(identity, false);
    privatePath(resolve(identity, ".."), true);
    privatePath(directory, true);
    privatePath(hosts, false);
    requireTransport(readFileSync(hosts, "utf8") === pin);
    const preparedAt = instant(now);
    requireTransport(
      preparedAt >= started &&
        preparedAt - started < preparationBudget &&
        performance.now() < physicalDeadline &&
        performance.now() < physicalStarted + proof.expires_at - started &&
        preparedAt < proof.expires_at,
    );
    // This is the last synchronous check before spawning SSH. DNS's AD bit is deliberately never
    // delegated to OpenSSH: it must compare the one durable known_hosts key even for secure SSHFP.
    const result = processResult(
      await run({
        executable: "/usr/bin/ssh",
        args,
        directory,
        timeout_ms: request.timeout_ms,
        output_limit: 1024 * 1024,
        input: request.input ?? null,
      }),
      1024 * 1024,
    );
    requireTransport(result.code === 0 && result.signal === null);
    return Uint8Array.from(result.stdout);
  } catch {
    // No host names, addresses, key material, remote text, private paths or process diagnostics.
    throw new Error("trusted-ssh-failed");
  } finally {
    clearTimeout(preparationTimer);
    removePrivate(directory, "trusted-ssh-failed");
  }
}
