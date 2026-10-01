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
const nativeThen = Promise.prototype.then;
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
  end: number;
  last: number;
  served: boolean;
  readonly rejected: Promise<never>;
  readonly reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  timerEnd?: number;
  frames?: HostBridgeFrames;
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error(failure);
}
function clockSample(clock: () => number): number {
  const value: unknown = clock();
  if (typeof value !== "number") {
    try {
      void Reflect.apply(nativeThen, value, [undefined, () => {}]);
    } catch {}
  }
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
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
  #checking = false;
  #captureAnchors: number[] = [];
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
    let owns = false;
    try {
      requireValue(!this.#failed && !this.#pending && !this.#checking);
      requireValue(operation === "exec" || operation === "put" || operation === "fetch");
      const physical = performance.now();
      this.#checking = true;
      owns = true;
      const wall = clockSample(this.#now);
      requireValue(
        !this.#failed &&
          Number.isSafeInteger(wall) &&
          wall > 0 &&
          performance.now() - physical < this.#timeout,
      );
      const allocation = Object.freeze({ operation, nonce: randomBytes(16).toString("hex") });
      let reject!: (reason: Error) => void;
      const rejected = new Promise<never>((_, refusal) => {
        reject = refusal;
      });
      void rejected.catch(() => {});
      this.#pending = {
        allocation,
        physical,
        end: physical + this.#timeout,
        wall,
        last: wall,
        served: false,
        rejected,
        reject,
      };
      this.#rearm(this.#pending);
      return allocation;
    } catch {
      this.#fence();
      throw new Error(failure);
    } finally {
      if (owns) this.#checking = false;
    }
  }
  /** Timer updates and expiry use only the privately retained end, without another hook. */
  #rearm(pending: Pending): void {
    requireValue(!this.#failed && performance.now() < pending.end);
    if (pending.timer !== undefined && pending.timerEnd === pending.end) return;
    clearTimeout(pending.timer);
    pending.timerEnd = pending.end;
    pending.timer = setTimeout(() => this.#fence(), pending.end - performance.now());
  }
  #check(allocation: HostBridgeAllocation): Pending {
    requireValue(!this.#failed && !this.#checking && this.#pending?.allocation === allocation);
    const pending = this.#pending;
    const before = Math.min(performance.now(), ...this.#captureAnchors);
    requireValue(before < pending.end && performance.now() < pending.end);
    this.#checking = true;
    try {
      const wall = clockSample(this.#now);
      requireValue(!this.#failed && Number.isSafeInteger(wall) && wall >= pending.last);
      pending.last = wall;
      // A frozen wall clock cannot issue this same residual again after owned work consumes it.
      pending.end = Math.min(pending.end, before + this.#timeout - (wall - pending.wall));
      requireValue(wall - pending.wall < this.#timeout && performance.now() < pending.end);
      this.#rearm(pending);
      return pending;
    } finally {
      this.#checking = false;
    }
  }
  #capture<T>(allocation: HostBridgeAllocation, work: () => T): T {
    this.#check(allocation);
    this.#captureAnchors.push(performance.now());
    let value: unknown;
    try {
      value = work();
      this.#check(allocation);
      return value as T;
    } catch {
      this.#fence();
      try {
        // Post-hook refusal may withhold an already rejected native Promise.
        void Reflect.apply(nativeThen, value, [undefined, () => {}]);
      } catch {}
      throw new Error(failure);
    } finally {
      // An asynchronous handler/read resumes with a fresh callback anchor, never this one.
      this.#captureAnchors.pop();
    }
  }
  remaining(allocation: HostBridgeAllocation): number {
    try {
      const pending = this.#check(allocation);
      const remaining = Math.floor(
        Math.min(this.#timeout - (pending.last - pending.wall), pending.end - performance.now()),
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
      const input = this.#capture(allocation, () => channels.input);
      const output = this.#capture(allocation, () => channels.output);
      const pending = this.#check(allocation);
      requireValue(!pending.served);
      pending.served = true;
      requireValue(
        input instanceof ReadableStream &&
          output instanceof WritableStream &&
          !this.#capture(allocation, () => input.locked) &&
          !this.#capture(allocation, () => output.locked) &&
          !usedChannels.has(input) &&
          !usedChannels.has(output),
      );
      usedChannels.add(input);
      usedChannels.add(output);
      // This fixed no-argument invocation selects the native default reader, never BYOB.
      const getReader = this.#capture(
        allocation,
        () => input.getReader.bind(input) as () => ReadableStreamDefaultReader<Uint8Array>,
      );
      // An accepted lock is privately retained before the post-method deadline check, so
      // expiry cannot discard the only handle that can cancel and release it.
      this.#capture(allocation, () => {
        reader = getReader();
      });
      const getWriter = this.#capture(allocation, () => output.getWriter.bind(output));
      this.#capture(allocation, () => {
        writer = getWriter();
      });
      requireValue(reader && writer);
      const capturedReader = reader;
      const capturedWriter = writer;
      // The parser's rounded timeout is secondary. These wrappers retain the EXACT original
      // allocation boundary at each underlying I/O offer and acknowledgement, including a
      // synchronous clock advance between frame preparation and actual sink invocation.
      const guardedInput = new ReadableStream<Uint8Array>(
        {
          pull: async (sink) => {
            this.#check(allocation);
            const read = this.#capture(allocation, () => capturedReader.read.bind(capturedReader));
            const next = await this.#capture(allocation, read);
            this.#check(allocation);
            if (this.#capture(allocation, () => next.done)) sink.close();
            else {
              const bytes = this.#capture(allocation, () => next.value);
              requireValue(bytes instanceof Uint8Array);
              this.#check(allocation);
              sink.enqueue(bytes);
            }
          },
          cancel: () => capturedReader.cancel(),
        },
        { highWaterMark: 0 },
      );
      const guardedOutput = new WritableStream<Uint8Array>({
        write: async (bytes) => {
          this.#check(allocation);
          const write = this.#capture(allocation, () => capturedWriter.write.bind(capturedWriter));
          await this.#capture(allocation, () => write(bytes));
          this.#check(allocation);
        },
        close: async () => {
          this.#check(allocation);
          const close = this.#capture(allocation, () => capturedWriter.close.bind(capturedWriter));
          await this.#capture(allocation, close);
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
        work = this.#capture(allocation, () =>
          this.#handlers.exec(Object.freeze({ ...io, command: Object.freeze([...first.command]) })),
        );
      else if (first.kind === "put")
        work = this.#capture(allocation, () =>
          this.#handlers.put(Object.freeze({ ...io, path: first.path })),
        );
      else {
        requireValue(first.kind === "fetch");
        work = this.#capture(allocation, () =>
          this.#handlers.fetch(
            Object.freeze({
              ...io,
              path: first.path,
              file: (bytes: Uint8Array) => emit("file", bytes),
            }),
          ),
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
      if (!frames && this.#failed) {
        // Construction may refuse before the framing session owns these handles. Cleanup is
        // denial-only, independent of the expired offer window and independent per handle.
        for (const stop of [() => reader?.cancel(), () => writer?.abort()]) {
          try {
            void Promise.resolve(stop()).catch(() => {});
          } catch {
            /* Cleanup cannot replace the original fixed refusal. */
          }
        }
      }
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
