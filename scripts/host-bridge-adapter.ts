/**
 * Private framing adapter, with explicitly supplied handlers only. This is not a host
 * authorization factory: operational callers must independently consume a descriptor and
 * obtain fresh guarded journal/local-validator trust for each eventual SSH invocation.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createHostFrameSession,
  type HostBridgeFrames,
  type HostBridgeOperation,
} from "./host-bridge-frames.js";

const failure = "host-bridge-adapter-failed";
const usedChannels = new WeakSet<object>();
export interface HostBridgeHandlerIO {
  readonly input: ReadableStream<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => Promise<void>;
  readonly stderr: (bytes: Uint8Array) => Promise<void>;
}
export interface HostBridgeHandlers {
  exec: (request: HostBridgeHandlerIO & { readonly command: readonly string[] }) => Promise<number>;
  put: (request: HostBridgeHandlerIO & { readonly path: string }) => Promise<number>;
  fetch: (
    request: HostBridgeHandlerIO & {
      readonly path: string;
      readonly file: (bytes: Uint8Array) => Promise<void>;
    },
  ) => Promise<number>;
}
/** The object identity, not these public transport parameters, binds an allocation. */
export interface HostBridgeAllocation {
  readonly nonce: string;
  readonly operation: HostBridgeOperation;
}
export interface HostBridgeCoordinator {
  allocate(operation: HostBridgeOperation): HostBridgeAllocation;
  remaining(allocation: HostBridgeAllocation): number;
  serve(
    allocation: HostBridgeAllocation,
    channels: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> },
  ): Promise<void>;
  /** Death/reset/abandonment is permanent for this coordinator, including future workers. */
  fence(): void;
  readonly fenced: boolean;
}
interface Pending {
  readonly allocation: HostBridgeAllocation;
  readonly wall: number;
  readonly physical: number;
  last: number;
  served: boolean;
  readonly rejected: Promise<never>;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  frames?: HostBridgeFrames;
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error(failure);
}
function capturedFunction<T>(value: object, key: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireValue(
    descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function",
  );
  return descriptor.value as T;
}
class Coordinator implements HostBridgeCoordinator {
  readonly #handlers: HostBridgeHandlers;
  readonly #now: () => number;
  readonly #timeout: number;
  #pending: Pending | undefined;
  #failed = false;
  constructor(
    handlers: HostBridgeHandlers,
    configuration: { operation_timeout_ms: number; now?: () => number },
  ) {
    requireValue(handlers !== null && typeof handlers === "object");
    this.#handlers = Object.freeze({
      exec: capturedFunction<HostBridgeHandlers["exec"]>(handlers, "exec"),
      put: capturedFunction<HostBridgeHandlers["put"]>(handlers, "put"),
      fetch: capturedFunction<HostBridgeHandlers["fetch"]>(handlers, "fetch"),
    });
    const fields = Object.getOwnPropertyDescriptors(configuration);
    requireValue(
      Object.keys(fields).every((key) => key === "operation_timeout_ms" || key === "now") &&
        fields.operation_timeout_ms &&
        Object.hasOwn(fields.operation_timeout_ms, "value"),
    );
    this.#timeout = fields.operation_timeout_ms.value as number;
    requireValue(Number.isInteger(this.#timeout) && this.#timeout >= 1 && this.#timeout <= 60_000);
    this.#now = fields.now ? capturedFunction(configuration, "now") : Date.now;
  }
  get fenced(): boolean {
    return this.#failed;
  }
  fence(): void {
    this.#fence();
  }
  #fence(): void {
    if (this.#failed) return;
    this.#failed = true;
    const pending = this.#pending;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(failure));
      // Accepted side effects cannot be undone. Late callbacks retain only this exchange's
      // private streams and reject before offering more bytes; no later allocation is allowed.
      pending.frames?.abort();
    }
  }
  allocate(operation: HostBridgeOperation): HostBridgeAllocation {
    try {
      requireValue(!this.#failed && !this.#pending);
      requireValue(operation === "exec" || operation === "put" || operation === "fetch");
      const physical = performance.now();
      const wall = this.#now();
      requireValue(
        Number.isSafeInteger(wall) && wall > 0 && performance.now() - physical < this.#timeout,
      );
      const allocation = Object.freeze({ operation, nonce: randomBytes(16).toString("hex") });
      let reject!: (reason: Error) => void;
      const rejected = new Promise<never>((_, refusal) => {
        reject = refusal;
      });
      void rejected.catch(() => {});
      const timer = setTimeout(
        () => this.#fence(),
        Math.max(1, this.#timeout - (performance.now() - physical)),
      );
      this.#pending = {
        allocation,
        physical,
        wall,
        last: wall,
        served: false,
        rejected,
        reject,
        timer,
      };
      return allocation;
    } catch {
      this.#fence();
      throw new Error(failure);
    }
  }
  #check(allocation: HostBridgeAllocation): Pending {
    requireValue(!this.#failed && this.#pending?.allocation === allocation);
    const pending = this.#pending;
    const wall = this.#now();
    requireValue(Number.isSafeInteger(wall) && wall >= pending.last);
    pending.last = wall;
    requireValue(
      wall - pending.wall < this.#timeout && performance.now() - pending.physical < this.#timeout,
    );
    return pending;
  }
  remaining(allocation: HostBridgeAllocation): number {
    try {
      const pending = this.#check(allocation);
      const remaining = Math.floor(
        Math.min(
          this.#timeout - (pending.last - pending.wall),
          this.#timeout - (performance.now() - pending.physical),
        ),
      );
      requireValue(remaining >= 1);
      return remaining;
    } catch {
      this.#fence();
      throw new Error(failure);
    }
  }
  async serve(
    allocation: HostBridgeAllocation,
    channels: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> },
  ): Promise<void> {
    let frames: HostBridgeFrames | undefined;
    let accepting = true;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      // Capture channels once before the first await. The ticket's original budget includes
      // private IPC acceptance; creating the frame parser never grants a new deadline.
      const input = channels.input;
      const output = channels.output;
      const pending = this.#check(allocation);
      requireValue(!pending.served);
      pending.served = true;
      requireValue(
        input instanceof ReadableStream &&
          output instanceof WritableStream &&
          !input.locked &&
          !output.locked &&
          !usedChannels.has(input) &&
          !usedChannels.has(output),
      );
      usedChannels.add(input);
      usedChannels.add(output);
      reader = input.getReader();
      writer = output.getWriter();
      const capturedReader = reader;
      const capturedWriter = writer;
      // The parser's rounded timeout is secondary. These wrappers retain the EXACT original
      // allocation boundary at each underlying I/O offer and acknowledgement, including a
      // synchronous clock advance between frame preparation and actual sink invocation.
      const guardedInput = new ReadableStream<Uint8Array>(
        {
          pull: async (sink) => {
            this.#check(allocation);
            const next = await capturedReader.read();
            this.#check(allocation);
            if (next.done) sink.close();
            else sink.enqueue(next.value);
          },
          cancel: () => capturedReader.cancel(),
        },
        { highWaterMark: 0 },
      );
      const guardedOutput = new WritableStream<Uint8Array>({
        write: async (bytes) => {
          this.#check(allocation);
          await capturedWriter.write(bytes);
          this.#check(allocation);
        },
        close: async () => {
          this.#check(allocation);
          await capturedWriter.close();
          this.#check(allocation);
        },
        abort: () => capturedWriter.abort(),
      });
      frames = createHostFrameSession(
        {
          role: "bridge",
          nonce: allocation.nonce,
          operation: allocation.operation,
          timeout_ms: this.remaining(allocation),
        },
        { input: guardedInput, output: guardedOutput, now: this.#now },
      );
      pending.frames = frames;
      const exchange = frames;
      const within = async <T>(work: Promise<T>): Promise<T> => {
        const result = await Promise.race([work, pending.rejected]);
        this.#check(allocation);
        return result;
      };
      const first = await within(exchange.receive());
      requireValue(first.kind === allocation.operation);
      await within(exchange.send({ kind: "response", operation: allocation.operation }));
      let resolveInput!: () => void;
      let rejectInput!: (reason: Error) => void;
      const inputComplete = new Promise<void>((resolve, reject) => {
        resolveInput = resolve;
        rejectInput = reject;
      });
      void inputComplete.catch(() => {});
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull: async (sink) => {
            try {
              this.#check(allocation);
              const next = await within(exchange.receive());
              if (next.kind === "end") {
                sink.close();
                resolveInput();
              } else {
                requireValue(
                  next.kind === (allocation.operation === "exec" ? "stdin" : "file") &&
                    "bytes" in next,
                );
                sink.enqueue(next.bytes);
              }
            } catch {
              rejectInput(new Error(failure));
              this.#fence();
              sink.error(new Error(failure));
            }
          },
          cancel: () => {
            rejectInput(new Error(failure));
            this.#fence();
          },
        },
        { highWaterMark: 1 },
      );
      const writes = new Set<Promise<void>>();
      const emit = (kind: "stdout" | "stderr" | "file", bytes: Uint8Array): Promise<void> => {
        try {
          requireValue(accepting);
          this.#check(allocation);
          const writing = within(exchange.send({ kind, bytes }));
          writes.add(writing);
          // Retain rejections until final settlement, even when a handler does not await.
          void writing.catch(() => this.#fence());
          return writing;
        } catch {
          this.#fence();
          return Promise.reject(new Error(failure));
        }
      };
      const io = Object.freeze({
        input: body,
        stdout: (bytes: Uint8Array) => emit("stdout", bytes),
        stderr: (bytes: Uint8Array) => emit("stderr", bytes),
      });
      let work: Promise<number>;
      if (first.kind === "exec")
        work = this.#handlers.exec(
          Object.freeze({ ...io, command: Object.freeze([...first.command]) }),
        );
      else if (first.kind === "put")
        work = this.#handlers.put(Object.freeze({ ...io, path: first.path }));
      else {
        requireValue(first.kind === "fetch");
        work = this.#handlers.fetch(
          Object.freeze({
            ...io,
            path: first.path,
            file: (bytes: Uint8Array) => emit("file", bytes),
          }),
        );
      }
      const code = await within(Promise.resolve(work));
      accepting = false;
      requireValue(Number.isInteger(code) && code >= 0 && code <= 254);
      // Known completion requires clean request EOF and every offered output acknowledgement.
      // A successful handler alone never frees the ticket or authorizes another worker.
      await within(inputComplete);
      await within(Promise.all([...writes]));
      await within(exchange.send({ kind: "result", code }));
      exchange.finish();
      this.#check(allocation);
      reader.releaseLock();
      writer.releaseLock();
      reader = undefined;
      writer = undefined;
      clearTimeout(pending.timer);
      this.#pending = undefined;
    } catch {
      accepting = false;
      // Reserve uncertainty before fencing the framing session; no diagnostic payload is sent.
      const uncertain = frames?.send({ kind: "uncertain", error: "host-bridge-uncertain" });
      this.#fence();
      void uncertain?.catch(() => {});
      try {
        controller?.error(new Error(failure));
      } catch {
        /* Keep fixed refusal. */
      }
      throw new Error(failure);
    } finally {
      for (const release of [() => reader?.releaseLock(), () => writer?.releaseLock()]) {
        try {
          release();
        } catch {
          /* Pending teardown cannot replace the fixed failure. */
        }
      }
    }
  }
}
// Keep public dispatch stable too; callers cannot patch a shared prototype to reopen denial.
Object.freeze(Coordinator.prototype);
export function createHostBridgeCoordinator(
  handlers: HostBridgeHandlers,
  configuration: { operation_timeout_ms: number; now?: () => number },
): HostBridgeCoordinator {
  try {
    return Object.freeze(new Coordinator(handlers, configuration));
  } catch {
    throw new Error(failure);
  }
}
