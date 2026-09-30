/**
 * Private streaming transport for a future first-party Ansible bridge. Every exchange obtains
 * fresh journal/DNSSEC authority through trustedSsh; no prepared pin, process or SSH argv escapes
 * the returned capability. Operational factories and the pinned Ansible launcher remain separate.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { targetDescriptor, type TargetDescriptor } from "./ssh-trust.js";
import {
  trustedSsh,
  type ConnectionProof,
  type SshCommand,
  type TrustProcessRequest,
} from "./trust-ssh.js";

const inputLimit = 8 * 1024 * 1024;
const outputLimit = 8 * 1024 * 1024;
const usedChannels = new WeakSet<object>();
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const setBytes = Uint8Array.prototype.set;
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-trusted-ssh-stream");
}
/** Caller chunks cannot shadow their size or turn detachment into an unbounded iterator. */
function copyChunk(value: unknown, remaining: number): Uint8Array {
  valid(value instanceof Uint8Array && typeof typedArrayByteLength === "function");
  const size: unknown = typedArrayByteLength.call(value);
  valid(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= remaining);
  const bytes = new Uint8Array(size);
  setBytes.call(bytes, value);
  return bytes;
}
/** Snapshot only plain command/configuration data; streams and dependency functions are capabilities. */
function snapshot(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    valid(++nodes <= 4096 && depth <= 8);
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      valid(input.length <= 4096 && bytes <= 65_536);
      return input;
    }
    valid(input !== null && typeof input === "object");
    valid(Object.getOwnPropertySymbols(input).length === 0);
    const properties = Object.getOwnPropertyDescriptors(input);
    if (Array.isArray(input)) {
      valid(input.length <= 32 && Object.keys(properties).length === input.length + 1);
      return Array.from({ length: input.length }, (_, index) => {
        const property = properties[String(index)];
        valid(property?.enumerable && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    }
    valid(
      Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
    );
    valid(Object.keys(properties).length <= 32);
    const result: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties)) {
      valid(property.enumerable && Object.hasOwn(property, "value"));
      bytes += Buffer.byteLength(key);
      valid(bytes <= 65_536);
      Object.defineProperty(result, key, {
        enumerable: true,
        value: copy(property.value, depth + 1),
      });
    }
    return result;
  };
  return copy(value, 0);
}
export interface TrustedSshStreamConfiguration {
  descriptor: TargetDescriptor;
  address_family: "ipv4" | "ipv6";
  /** This replacement adapter supports root login and the playbooks' passwordless sudo only. */
  user: "root";
  identity_file: string;
  work_root: string;
  timeout_ms: number;
  preparation_timeout_ms?: number;
}
export interface TrustedSshStreamRequest {
  /** Argument tokens, not caller-selected SSH options or a supplied trust proof. */
  command: string[];
  /** Each channel belongs to one exchange; input/output bytes remain private to its bridge. */
  input: ReadableStream<Uint8Array> | null;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}
export interface TrustedSshStreamResult {
  /** Remote 1..254 is an ordinary result; 255 cannot be distinguished from transport failure. */
  code: number;
  input_bytes: number;
  stdout_bytes: number;
  stderr_bytes: number;
}
export interface TrustedSshStream {
  run(request: TrustedSshStreamRequest): Promise<TrustedSshStreamResult>;
}
export interface TrustStreamSpawnRequest {
  executable: "/usr/bin/ssh";
  args: string[];
  directory: string;
}
/** Trusted offline subprocess seam, captured once; never accepted in an exchange/frame. */
export type TrustStreamSpawner = (
  request: TrustStreamSpawnRequest,
) => ChildProcessWithoutNullStreams;
const nativeSpawn: TrustStreamSpawner = (request) =>
  spawn(request.executable, request.args, {
    cwd: request.directory,
    env: { PATH: "/usr/bin:/bin", HOME: request.directory, LANG: "C", LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
  });

function configuration(value: TrustedSshStreamConfiguration): TrustedSshStreamConfiguration {
  const data = snapshot(value) as Record<string, unknown>;
  valid(
    Object.keys(data).every((key) =>
      [
        "descriptor",
        "address_family",
        "user",
        "identity_file",
        "work_root",
        "timeout_ms",
        "preparation_timeout_ms",
      ].includes(key),
    ),
  );
  const descriptor = targetDescriptor(data.descriptor);
  valid(data.address_family === "ipv4" || data.address_family === "ipv6");
  valid(data.user === "root");
  for (const field of ["identity_file", "work_root"] as const)
    valid(
      typeof data[field] === "string" &&
        /^\/[A-Za-z0-9_./-]+$/u.test(data[field]) &&
        resolve(data[field]) === data[field],
    );
  valid(
    typeof data.timeout_ms === "number" &&
      Number.isInteger(data.timeout_ms) &&
      data.timeout_ms >= 1000 &&
      data.timeout_ms <= 3_600_000,
  );
  valid(
    data.preparation_timeout_ms === undefined ||
      (typeof data.preparation_timeout_ms === "number" &&
        Number.isInteger(data.preparation_timeout_ms) &&
        data.preparation_timeout_ms > 0 &&
        data.preparation_timeout_ms <= 60_000),
  );
  return { ...data, descriptor } as unknown as TrustedSshStreamConfiguration;
}
interface Channels {
  input: ReadableStreamDefaultReader<Uint8Array> | null;
  stdout: WritableStreamDefaultWriter<Uint8Array>;
  stderr: WritableStreamDefaultWriter<Uint8Array>;
}
function clock(now: () => number, timeout: number): () => void {
  const started = now();
  valid(Number.isSafeInteger(started) && started > 0);
  const deadline = performance.now() + timeout;
  let previous = started;
  return () => {
    const current = now();
    valid(
      Number.isSafeInteger(current) &&
        current >= previous &&
        current - started < timeout &&
        performance.now() < deadline,
    );
    previous = current;
  };
}

/** No process handle is returned. Failure destroys every pipe before settling an uncertain result. */
async function exchange(
  prepared: TrustProcessRequest,
  channels: Channels,
  spawnProcess: TrustStreamSpawner,
  now: () => number,
): Promise<TrustedSshStreamResult> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const counts = { input_bytes: 0, stdout_bytes: 0, stderr_bytes: 0 };
  const checkTime = clock(now, prepared.timeout_ms);
  const check = () => {
    valid(active);
    checkTime();
  };
  const stop = () => {
    active = false;
    // Detaching all local pipes prevents later process output from entering another invocation.
    for (const cancel of [
      () => child?.stdin.destroy(),
      () => child?.stdout.destroy(),
      () => child?.stderr.destroy(),
      () => child?.kill("SIGKILL"),
    ]) {
      try {
        cancel();
      } catch {
        /* Every remaining pipe is still detached; uncertainty stays a fixed failure. */
      }
    }
  };
  try {
    check();
    valid(prepared.executable === "/usr/bin/ssh");
    child = spawnProcess({
      executable: "/usr/bin/ssh",
      args: [...prepared.args],
      directory: prepared.directory,
    });
    const process = child;
    // Streams/errors are observed immediately; an input error is never permission to retry.
    const closed = new Promise<number>((accept, reject) => {
      process.on("error", () => reject(new Error("trusted-ssh-stream-failed")));
      process.on("close", (code, signal) => {
        if (Number.isInteger(code) && code !== null && code >= 0 && code <= 254 && signal === null)
          accept(code);
        else reject(new Error("trusted-ssh-stream-failed"));
      });
    });
    const stdinError = new Promise<never>((_, reject) => {
      process.stdin.on("error", () => reject(new Error("trusted-ssh-stream-failed")));
    });
    const input = async () => {
      if (channels.input) {
        for (;;) {
          check();
          const next = await channels.input.read();
          check();
          if (next.done) break;
          const bytes = copyChunk(next.value, inputLimit - counts.input_bytes);
          counts.input_bytes += bytes.byteLength;
          valid(counts.input_bytes <= inputLimit);
          // The write callback includes backpressure; caller-shared bytes are already detached.
          await new Promise<void>((accept, reject) => {
            process.stdin.write(bytes, (error) => {
              if (error) reject(new Error("trusted-ssh-stream-failed"));
              else accept();
            });
          });
          check();
        }
      }
      check();
      process.stdin.end();
    };
    const output = async (
      source: typeof process.stdout,
      destination: WritableStreamDefaultWriter<Uint8Array>,
      counter: "stdout_bytes" | "stderr_bytes",
    ) => {
      for await (const chunk of source) {
        check();
        const bytes = copyChunk(chunk, outputLimit - counts.stdout_bytes - counts.stderr_bytes);
        counts[counter] += bytes.byteLength;
        valid(counts.stdout_bytes + counts.stderr_bytes <= outputLimit);
        await destination.write(bytes);
        check();
      }
      check();
    };
    const completed = Promise.all([
      closed,
      input(),
      output(process.stdout, channels.stdout, "stdout_bytes"),
      output(process.stderr, channels.stderr, "stderr_bytes"),
    ]);
    const [code] = await Promise.race([
      completed,
      stdinError,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error("trusted-ssh-stream-failed"));
        }, prepared.timeout_ms);
      }),
    ]);
    check();
    return { code, ...counts };
  } catch {
    stop();
    throw new Error("trusted-ssh-stream-failed");
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

class Transport implements TrustedSshStream {
  readonly #configuration: TrustedSshStreamConfiguration;
  readonly #trust: (descriptor: TargetDescriptor) => Promise<ConnectionProof>;
  readonly #spawn: TrustStreamSpawner;
  readonly #now: () => number;
  #busy = false;
  #fenced = false;
  constructor(
    value: TrustedSshStreamConfiguration,
    dependencies: {
      connectionTrust: (descriptor: TargetDescriptor) => Promise<ConnectionProof>;
      spawn?: TrustStreamSpawner;
      now?: () => number;
    },
  ) {
    this.#configuration = configuration(value);
    this.#trust = dependencies.connectionTrust;
    this.#spawn = dependencies.spawn ?? nativeSpawn;
    this.#now = dependencies.now ?? Date.now;
    valid(
      typeof this.#trust === "function" &&
        typeof this.#spawn === "function" &&
        typeof this.#now === "function",
    );
    Object.freeze(this);
  }
  async run(value: TrustedSshStreamRequest): Promise<TrustedSshStreamResult> {
    let owns = false;
    const channels: Partial<Channels> = {};
    let success = false;
    let outcome: TrustedSshStreamResult | undefined;
    try {
      valid(!this.#busy && !this.#fenced);
      this.#busy = true;
      owns = true;
      const properties = Object.getOwnPropertyDescriptors(value);
      valid(
        Object.getOwnPropertySymbols(value).length === 0 &&
          Object.keys(properties).sort().join("\0") === "command\0input\0stderr\0stdout",
      );
      for (const property of Object.values(properties))
        valid(property.enumerable && Object.hasOwn(property, "value"));
      const command = snapshot(properties.command?.value) as string[];
      const input = properties.input?.value as ReadableStream<Uint8Array> | null;
      const stdout = properties.stdout?.value as WritableStream<Uint8Array>;
      const stderr = properties.stderr?.value as WritableStream<Uint8Array>;
      valid(
        (input === null || input instanceof ReadableStream) &&
          stdout instanceof WritableStream &&
          stderr instanceof WritableStream &&
          stdout !== stderr,
      );
      const all = input === null ? [stdout, stderr] : [input, stdout, stderr];
      valid(all.every((stream) => !stream.locked && !usedChannels.has(stream)));
      for (const stream of all) usedChannels.add(stream);
      channels.input = input?.getReader() ?? null;
      channels.stdout = stdout.getWriter();
      channels.stderr = stderr.getWriter();
      const capturedChannels = channels as Channels;
      const config = this.#configuration;
      const request: SshCommand = { ...config, command };
      await trustedSsh(request, this.#trust, {
        now: this.#now,
        preparation_timeout_ms: config.preparation_timeout_ms ?? 60_000,
        run: async (prepared) => {
          outcome = await exchange(prepared, capturedChannels, this.#spawn, this.#now);
          // The shared guarded lifetime must clean its pin after any known remote exit status.
          // Legacy trustedSsh still rejects nonzero results from its own public runner.
          return { code: 0, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array() };
        },
      });
      valid(outcome);
      success = true;
    } catch {
      if (owns) this.#fenced = true;
    } finally {
      if (!success) {
        // Cancellation/abort acknowledgements may never settle; private channels are never reused.
        for (const cancel of [
          () => channels.input?.cancel(),
          () => channels.stdout?.abort(),
          () => channels.stderr?.abort(),
        ]) {
          try {
            void cancel()?.catch(() => {});
          } catch {
            /* Attempt the other independent cancellations; public refusal stays fixed. */
          }
        }
      }
      if (owns) this.#busy = false;
      let releaseFailed = false;
      for (const channel of [channels.input, channels.stdout, channels.stderr]) {
        try {
          channel?.releaseLock();
        } catch {
          releaseFailed = true;
        }
      }
      if (releaseFailed) {
        if (owns) this.#fenced = true;
        success = false;
      }
    }
    if (!success || outcome === undefined) throw new Error("trusted-ssh-stream-failed");
    return outcome;
  }
}

/** Every invocation freshly calls the captured journal capability; no host action occurs at creation. */
export function createTrustedSshStream(
  configuration: TrustedSshStreamConfiguration,
  dependencies: {
    connectionTrust: (descriptor: TargetDescriptor) => Promise<ConnectionProof>;
    spawn?: TrustStreamSpawner;
    now?: () => number;
  },
): TrustedSshStream {
  try {
    return new Transport(configuration, dependencies);
  } catch {
    throw new Error("invalid-trusted-ssh-stream");
  }
}
