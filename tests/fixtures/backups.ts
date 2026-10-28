/**
 * Stand-ins for the backup module's seams (2.46.0): storage in memory with S3's all-or-nothing
 * contract, a scripted pg_dump/pg_restore, and a recording fetch for the healthchecks.io pings.
 */
import type { BackupStorage, StoredObject } from "../../src/infrastructure/backup/storage.js";
import type { RunTool, ToolProcess } from "../../src/infrastructure/postgres/libpq.js";

/**
 * Storage in memory. Like S3's multipart upload, put() stores an object only once its body has
 * closed: a body that errors, or a put told to fail, leaves nothing.
 */
export class MemoryStorage implements BackupStorage {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Every key a put was started for, in order. */
  readonly attempts: string[] = [];
  /** Make the put for a key fail after reading this many bytes of its body. */
  readonly failures = new Map<string, number>();

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<number> {
    this.attempts.push(key);
    const failAfter = this.failures.get(key);
    const chunks: Uint8Array[] = [];
    let read = 0;
    if (body instanceof Uint8Array) chunks.push(body);
    else {
      const reader = body.getReader();
      for (;;) {
        if (failAfter !== undefined && read >= failAfter) {
          const failure = new Error("Storage fixture refused the upload.");
          await reader.cancel(failure);
          throw failure;
        }
        // An erroring body rejects here, and nothing is stored.
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        read += value.length;
      }
    }
    if (failAfter !== undefined) throw new Error("Storage fixture refused the upload.");
    const bytes = concat(chunks);
    this.objects.set(key, bytes);
    return bytes.length;
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.length }));
  }

  get(key: string): ReadableStream<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes)
      return new ReadableStream({
        start: (controller) => controller.error(new Error("No such object.")),
      });
    return new Blob([bytes]).stream();
  }
}

/** One recorded tool run. */
export interface ToolCall {
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  /** What the tool read on standard input (pg_restore). */
  input: Uint8Array | null;
  killed: string | null;
}

/**
 * A scripted client tool. As pg_dump it writes `output` in 64 KiB chunks and exits with `exit`;
 * with `hang` it writes the first chunk and then waits until it is killed (status 128 + signal).
 * As pg_restore it reads its whole standard input, then exits with `exit`.
 */
export function scriptedTool(script: { output?: Uint8Array; exit?: number; hang?: boolean } = {}): {
  run: RunTool;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const run: RunTool = (command, { env, stdin }) => {
    const call: ToolCall = { command, env, input: null, killed: null };
    calls.push(call);
    const done = Promise.withResolvers<number>();
    let stop: (() => void) | null = null;
    const kill: ToolProcess["kill"] = (signal = "SIGTERM") => {
      if (call.killed) return;
      call.killed = signal;
      stop?.();
      done.resolve(signal === "SIGKILL" ? 137 : 143);
    };
    if (stdin) {
      void new Response(stdin)
        .arrayBuffer()
        .then((buffer) => {
          call.input = new Uint8Array(buffer);
          done.resolve(script.exit ?? 0);
        })
        .catch(() => done.resolve(1));
      return { stdout: null, exited: done.promise, kill };
    }
    const output = script.output ?? new Uint8Array();
    let offset = 0;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = () => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
      },
      async pull(controller) {
        if (call.killed) return;
        if (script.hang && offset > 0) {
          await done.promise;
          return;
        }
        if (offset >= output.length) {
          controller.close();
          done.resolve(script.exit ?? 0);
          return;
        }
        const end = Math.min(offset + 65536, output.length);
        controller.enqueue(output.slice(offset, end));
        offset = end;
      },
      cancel() {
        kill("SIGTERM");
      },
    });
    return { stdout, exited: done.promise, kill };
  };
  return { run, calls };
}

/** A recorded healthchecks.io ping. */
export interface Ping {
  url: string;
  body: string;
}

/** A fetch that records each ping and answers 200, or throws when told to. */
export function recordingFetch(fail = false): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  pings: Ping[];
} {
  const pings: Ping[] = [];
  return {
    pings,
    fetch: async (url, init) => {
      pings.push({ url, body: String(init.body) });
      if (fail) throw new TypeError("fetch failed");
      return new Response("OK");
    },
  };
}

/** Chunks joined into one buffer. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** Deterministic, incompressible-looking bytes of a given length. */
export function fixtureBytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}
