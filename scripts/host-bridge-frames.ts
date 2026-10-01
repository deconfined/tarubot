/**
 * Private byte framing for one future host-bridge exchange. Frames carry no authorization:
 * the bridge must independently consume authenticated descriptors and obtain fresh guarded
 * journal/local-DNSSEC trust for every SSH invocation. Never turn frame metadata into SSH
 * configuration, keys, a proof, an authority receipt or an arbitrary launcher option.
 */
import { performance } from "node:perf_hooks";
import { posix } from "node:path";

const failure = "host-bridge-frames-failed";
const headerLength = 32;
const metadataLimit = 16_384;
const chunkLimit = 65_536;
const dataLimit = 8 * 1024 * 1024;
const wireLimit = 9 * 1024 * 1024;
const frameLimit = 4096;
const pendingLimit = 8;
const pendingByteLimit = 512 * 1024;
const usedStreams = new WeakSet<object>();
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const setBytes = Uint8Array.prototype.set;
const nativeThen = Promise.prototype.then;

export type HostBridgeOperation = "exec" | "put" | "fetch";
export type HostBridgeFrame =
  | { kind: "exec"; command: string[] }
  | { kind: "put" | "fetch"; path: string }
  | { kind: "response"; operation: HostBridgeOperation }
  | { kind: "stdin" | "file" | "stdout" | "stderr"; bytes: Uint8Array }
  | { kind: "end" }
  | { kind: "result"; code: number }
  | { kind: "uncertain"; error: "host-bridge-uncertain" };
export interface HostBridgeFrameConfiguration {
  role: "client" | "bridge";
  /** An independently chosen per-exchange nonce; never learn the expected nonce from input. */
  nonce: string;
  operation: HostBridgeOperation;
  timeout_ms: number;
}
export interface HostBridgeFrames {
  /** Concurrent sends reserve bounded capacity synchronously, then write in FIFO order. */
  send(frame: HostBridgeFrame): Promise<void>;
  /** Known result waits for EOF/request completion; uncertainty fences without waiting for EOF. */
  receive(): Promise<HostBridgeFrame>;
  /** Both directions must have completed; finishing never renews the original deadline. */
  finish(): void;
  /** Permanent local fence. Cancellation acknowledgements are deliberately not awaited. */
  abort(): void;
}
type Plain = Record<string, unknown>;
function valid(value: unknown): asserts value {
  if (!value) throw new Error(failure);
}
/** Native size/copy ignores caller byteLength shadows and arbitrary iteration hooks. */
function copyBytes(value: unknown, limit: number): Uint8Array {
  valid(value instanceof Uint8Array && typeof byteLength === "function");
  const size: unknown = byteLength.call(value);
  valid(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= limit);
  const output = new Uint8Array(size);
  setBytes.call(output, value);
  return output;
}
/** Bounded plain data only: no getters, symbols, prototypes, sparse arrays or toJSON calls. */
function snapshot(value: unknown, check: () => void = () => {}): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    check();
    valid(++nodes <= 256 && depth <= 8);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      valid(Number.isFinite(input));
      return input;
    }
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      valid(bytes <= metadataLimit);
      return input;
    }
    valid(input !== null && typeof input === "object" && !ancestors.has(input));
    const symbols = Object.getOwnPropertySymbols(input);
    check();
    valid(symbols.length === 0);
    ancestors.add(input);
    const fields = Object.getOwnPropertyDescriptors(input);
    check();
    let output: unknown;
    if (Array.isArray(input)) {
      const length: unknown = fields.length?.value;
      valid(typeof length === "number" && Number.isSafeInteger(length) && length <= 32);
      valid(Object.keys(fields).length === length + 1);
      output = Array.from({ length }, (_, index) => {
        const field = fields[String(index)];
        valid(field?.enumerable && Object.hasOwn(field, "value"));
        return copy(field.value, depth + 1);
      });
    } else {
      const prototype = Object.getPrototypeOf(input);
      check();
      valid(prototype === Object.prototype || prototype === null);
      valid(Object.keys(fields).length <= 32);
      const result: Plain = {};
      for (const [key, field] of Object.entries(fields)) {
        valid(field.enumerable && Object.hasOwn(field, "value"));
        bytes += Buffer.byteLength(key);
        valid(bytes <= metadataLimit);
        Object.defineProperty(result, key, {
          value: copy(field.value, depth + 1),
          enumerable: true,
        });
      }
      output = result;
    }
    ancestors.delete(input);
    return output;
  };
  return copy(value, 0);
}
function object(value: unknown): Plain {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Plain;
}
function exact(value: Plain, keys: string[]): void {
  valid(Object.keys(value).sort().join("\0") === keys.sort().join("\0"));
}
function literal(value: unknown, limit: number, empty = false): asserts value is string {
  valid(
    typeof value === "string" &&
      (empty || value.length > 0) &&
      Buffer.byteLength(value) <= limit &&
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
}
function operation(value: unknown): asserts value is HostBridgeOperation {
  valid(value === "exec" || value === "put" || value === "fetch");
}
const codes = {
  exec: 1,
  put: 2,
  fetch: 3,
  response: 4,
  stdin: 5,
  file: 6,
  stdout: 7,
  stderr: 8,
  end: 9,
  result: 10,
  uncertain: 11,
} as const;
const kinds = Object.keys(codes) as HostBridgeFrame["kind"][];
const dataKinds = new Set(["stdin", "file", "stdout", "stderr"]);
function frame(value: unknown): HostBridgeFrame {
  const input = object(value);
  valid(typeof input.kind === "string" && Object.hasOwn(codes, input.kind));
  if (dataKinds.has(input.kind)) {
    exact(input, ["kind", "bytes"]);
    const bytes = copyBytes(input.bytes, chunkLimit);
    valid(bytes.length > 0);
    return { kind: input.kind, bytes } as HostBridgeFrame;
  }
  switch (input.kind) {
    case "exec": {
      exact(input, ["kind", "command"]);
      valid(Array.isArray(input.command) && input.command.length > 0 && input.command.length <= 32);
      let length = 0;
      for (const token of input.command) {
        literal(token, 4096, true);
        length += Buffer.byteLength(token);
      }
      valid(length <= metadataLimit && input.command[0] !== "");
      break;
    }
    case "put":
    case "fetch":
      exact(input, ["kind", "path"]);
      literal(input.path, 4096);
      valid(
        /^\/[A-Za-z0-9_./-]+$/u.test(input.path) &&
          input.path !== "/" &&
          !input.path.endsWith("/") &&
          posix.normalize(input.path) === input.path,
      );
      break;
    case "response":
      exact(input, ["kind", "operation"]);
      operation(input.operation);
      break;
    case "end":
      exact(input, ["kind"]);
      break;
    case "result":
      exact(input, ["kind", "code"]);
      valid(
        typeof input.code === "number" &&
          Number.isInteger(input.code) &&
          input.code >= 0 &&
          input.code <= 254,
      );
      break;
    case "uncertain":
      exact(input, ["kind", "error"]);
      valid(input.error === "host-bridge-uncertain");
      break;
    default:
      throw new Error(failure);
  }
  return input as unknown as HostBridgeFrame;
}
/** Copy data without reading getters; metadata is copied separately before the first await. */
function offeredFrame(value: unknown, check: () => void): HostBridgeFrame {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  check();
  valid(prototype === Object.prototype || prototype === null);
  const symbols = Object.getOwnPropertySymbols(value);
  check();
  valid(symbols.length === 0);
  const fields = Object.getOwnPropertyDescriptors(value);
  check();
  valid(Object.keys(fields).length <= 3);
  for (const field of Object.values(fields))
    valid(field.enumerable && Object.hasOwn(field, "value"));
  const kind: unknown = fields.kind?.value;
  if (typeof kind === "string" && dataKinds.has(kind)) {
    valid(Object.keys(fields).sort().join("\0") === "bytes\0kind");
    return frame({ kind, bytes: fields.bytes?.value });
  }
  return frame(snapshot(value, check));
}
/** Duplicate decoded keys and bounded JSON syntax are checked before JSON.parse builds data. */
function metadata(bytes: Uint8Array): HostBridgeFrame {
  valid(bytes.length > 0 && bytes.length <= metadataLimit);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[at] ?? "")) at++;
  };
  const string = (): string => {
    valid(source[at++] === '"');
    const start = at - 1;
    while (at < source.length) {
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
      if (source[at - 1] === "\\") at++;
    }
    throw new Error(failure);
  };
  const value = (depth: number): void => {
    valid(++nodes <= 256 && depth <= 8);
    whitespace();
    const first = source[at];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      at++;
      whitespace();
      const close = first === "{" ? "}" : "]";
      const seen = new Set<string>();
      if (source[at] === close) {
        at++;
        return;
      }
      while (true) {
        if (first === "{") {
          const key = string();
          valid(!seen.has(key));
          seen.add(key);
          whitespace();
          valid(source[at++] === ":");
        }
        value(depth + 1);
        whitespace();
        if (source[at] === close) {
          at++;
          return;
        }
        valid(source[at++] === ",");
        whitespace();
      }
    }
    const start = at;
    while (at < source.length && !/[\s,}\]]/u.test(source[at] ?? "")) at++;
    const parsed: unknown = JSON.parse(source.slice(start, at));
    valid(typeof parsed !== "number" || Number.isFinite(parsed));
  };
  value(0);
  whitespace();
  valid(at === source.length);
  const result = frame(JSON.parse(source));
  valid(!dataKinds.has(result.kind));
  return result;
}
interface Direction {
  started: boolean;
  ended: boolean;
  done: boolean;
  sequence: number;
  bytes: number;
  frames: number;
}
function direction(): Direction {
  return { started: false, ended: false, done: false, sequence: 0, bytes: 0, frames: 0 };
}

class Session implements HostBridgeFrames {
  readonly #configuration: HostBridgeFrameConfiguration;
  readonly #nonce: Uint8Array;
  #reader!: ReadableStreamDefaultReader<Uint8Array>;
  #writer!: WritableStreamDefaultWriter<Uint8Array>;
  readonly #now: () => number;
  readonly #started: number;
  readonly #physicalStarted: number;
  #physicalEnd: number;
  #checking = false;
  #capturing = false;
  #captureAnchor: number | undefined;
  #last: number;
  #failed = false;
  #uncertain = false;
  #finished = false;
  #reading = false;
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;
  #pendingBytes = 0;
  #incoming = direction();
  #outgoing = direction();
  #wireRead = 0;
  #wireWritten = 0;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerEnd: number | undefined;
  readonly #rejection: Promise<never>;
  #reject!: (error: Error) => void;
  readonly #ordinaryRejection: Promise<never>;
  #rejectOrdinary!: (error: Error) => void;
  constructor(
    configuration: HostBridgeFrameConfiguration,
    channels: {
      input: ReadableStream<Uint8Array>;
      output: WritableStream<Uint8Array>;
      now?: () => number;
    },
  ) {
    // The first clock call's physical duration belongs to the budget too.
    this.#physicalStarted = performance.now();
    const source = channels.input;
    const output = channels.output;
    const input = object(snapshot(configuration));
    exact(input, ["role", "nonce", "operation", "timeout_ms"]);
    valid(input.role === "client" || input.role === "bridge");
    valid(typeof input.nonce === "string" && /^[a-f0-9]{32}$/u.test(input.nonce));
    operation(input.operation);
    valid(
      typeof input.timeout_ms === "number" &&
        Number.isInteger(input.timeout_ms) &&
        input.timeout_ms > 0 &&
        input.timeout_ms <= 3_600_000,
    );
    this.#configuration = Object.freeze(input) as unknown as HostBridgeFrameConfiguration;
    this.#physicalEnd = this.#physicalStarted + this.#configuration.timeout_ms;
    this.#nonce = Buffer.from(this.#configuration.nonce, "hex");
    this.#now = channels.now ?? Date.now;
    valid(typeof this.#now === "function");
    const first: unknown = this.#now();
    if (typeof first !== "number") {
      try {
        void Reflect.apply(nativeThen, first, [undefined, () => {}]);
      } catch {}
    }
    valid(typeof first === "number");
    this.#started = first;
    this.#last = this.#started;
    valid(
      Number.isSafeInteger(this.#started) &&
        this.#started > 0 &&
        performance.now() - this.#physicalStarted < this.#configuration.timeout_ms,
    );
    this.#rejection = new Promise<never>((_, reject) => {
      this.#reject = reject;
    });
    void this.#rejection.catch(() => {});
    this.#ordinaryRejection = new Promise<never>((_, reject) => {
      this.#rejectOrdinary = reject;
    });
    void this.#ordinaryRejection.catch(() => {});
    try {
      valid(source instanceof ReadableStream && output instanceof WritableStream);
      valid(!usedStreams.has(source) && !usedStreams.has(output));
      valid(!this.#capture(() => source.locked));
      valid(!this.#capture(() => output.locked));
      usedStreams.add(source);
      usedStreams.add(output);
      // Bind methods under the FIRST clock's original window, before either native lock.
      const getReader = this.#capture(
        () => source.getReader.bind(source) as () => ReadableStreamDefaultReader<Uint8Array>,
      );
      // Retain each returned native handle before post-hook refusal. Teardown must still own
      // an accepted lock when the method's synchronous cost consumed the original deadline.
      this.#capture(() => {
        this.#reader = getReader();
      });
      const getWriter = this.#capture(() => output.getWriter.bind(output));
      this.#capture(() => {
        this.#writer = getWriter();
      });
    } catch {
      this.#stop();
      throw new Error(failure);
    }
    this.#rearm();
  }
  #check(terminalFlush = false): void {
    valid(!this.#failed && !this.#finished && (!this.#uncertain || terminalFlush));
    this.#checkTime();
  }
  #checkTime(): void {
    const before = Math.min(performance.now(), this.#captureAnchor ?? Infinity);
    valid(!this.#checking && performance.now() < this.#physicalEnd);
    const alreadyFailed = this.#failed;
    this.#checking = true;
    try {
      const at: unknown = this.#now();
      if (typeof at !== "number") {
        try {
          void Reflect.apply(nativeThen, at, [undefined, () => {}]);
        } catch {}
      }
      valid(
        typeof at === "number" &&
          this.#failed === alreadyFailed &&
          Number.isSafeInteger(at) &&
          at >= this.#last &&
          at - this.#started < this.#configuration.timeout_ms,
      );
      this.#last = at;
      // Retain every observed shorter wall allowance from BEFORE the current owned hook.
      // This end only shrinks, including while a sink or source acknowledgement is held.
      this.#physicalEnd = Math.min(
        this.#physicalEnd,
        before + this.#configuration.timeout_ms - (at - this.#started),
      );
      valid(performance.now() < this.#physicalEnd);
      this.#rearm();
    } finally {
      this.#checking = false;
    }
  }
  #rearm(): void {
    if (this.#failed || this.#finished) return;
    valid(performance.now() < this.#physicalEnd);
    if (this.#timer !== undefined && this.#timerEnd === this.#physicalEnd) return;
    clearTimeout(this.#timer);
    this.#timerEnd = this.#physicalEnd;
    this.#timer = setTimeout(() => this.#stop(), this.#physicalEnd - performance.now());
  }
  #capture<T>(work: () => T, terminalFlush = false): T {
    valid(!this.#capturing);
    this.#check(terminalFlush);
    this.#capturing = true;
    this.#captureAnchor = performance.now();
    let value: unknown;
    try {
      value = work();
      this.#check(terminalFlush);
      return value as T;
    } catch {
      this.#stop();
      try {
        void Reflect.apply(nativeThen, value, [undefined, () => {}]);
      } catch {}
      throw new Error(failure);
    } finally {
      // A returned native Promise may remain held; the original end survives, its sync
      // callback anchor does not. A resumed callback owns its own preparation cost.
      this.#captureAnchor = undefined;
      this.#capturing = false;
    }
  }
  #release(): void {
    let refused = false;
    for (const release of [() => this.#reader?.releaseLock(), () => this.#writer?.releaseLock()]) {
      try {
        release();
      } catch {
        refused = true;
      }
    }
    valid(!refused);
  }
  #stop(): void {
    if (this.#failed || this.#finished) return;
    this.#failed = true;
    clearTimeout(this.#timer);
    this.#reject(new Error(failure));
    this.#rejectOrdinary(new Error(failure));
    // A sink may already have accepted bytes; cancellation cannot undo such side effects.
    // The future bridge owns private per-exchange sinks. Single-use channels and the fence
    // prevent any late acknowledgement/callback from being used by a subsequent exchange.
    for (const stop of [() => this.#reader?.cancel(), () => this.#writer?.abort()]) {
      try {
        void Promise.resolve(stop()).catch(() => {});
      } catch {
        /* Keep the fixed failure. */
      }
    }
    try {
      this.#release();
    } catch {
      /* Locked teardown cannot replace the failure. */
    }
  }
  /** Only the privately reserved uncertain terminal can flush after this synchronous fence. */
  #fenceUncertain(): void {
    this.#uncertain = true;
    this.#rejectOrdinary(new Error(failure));
    try {
      void this.#reader.cancel().catch(() => {});
    } catch {
      /* Terminal delivery never depends on cancellation acknowledgement. */
    }
  }
  #refuse(terminalFlush = false): Error {
    // Refused ordinary calls must not abort the sole bounded private uncertainty flush.
    if (!this.#uncertain || terminalFlush) this.#stop();
    return new Error(failure);
  }
  async #within<T>(work: Promise<T>, terminalFlush = false): Promise<T> {
    const result = await Promise.race(
      terminalFlush ? [work, this.#rejection] : [work, this.#rejection, this.#ordinaryRejection],
    );
    this.#check(terminalFlush);
    return result;
  }
  #transition(state: Direction, frame: HostBridgeFrame, request: boolean): void {
    valid(!state.ended && ++state.frames <= frameLimit);
    if (!state.started) {
      valid(
        request
          ? frame.kind === this.#configuration.operation
          : frame.kind === "response" && frame.operation === this.#configuration.operation,
      );
      if (!request)
        valid(
          this.#configuration.role === "client" ? this.#outgoing.started : this.#incoming.started,
        );
      state.started = true;
      return;
    }
    if (request && frame.kind === "end") {
      state.ended = true;
      return;
    }
    if (!request && (frame.kind === "result" || frame.kind === "uncertain")) {
      state.ended = true;
      return;
    }
    valid(dataKinds.has(frame.kind));
    if (request)
      valid(
        this.#configuration.operation === "exec"
          ? frame.kind === "stdin"
          : this.#configuration.operation === "put" && frame.kind === "file",
      );
    else
      valid(
        frame.kind === "stdout" ||
          frame.kind === "stderr" ||
          (this.#configuration.operation === "fetch" && frame.kind === "file"),
      );
    valid("bytes" in frame);
    state.bytes += frame.bytes.length;
    valid(state.bytes <= dataLimit);
  }
  send(value: HostBridgeFrame): Promise<void> {
    try {
      valid(!this.#capturing);
      this.#check();
      const offered = this.#capture(() => offeredFrame(value, () => this.#check()));
      const payload =
        "bytes" in offered
          ? offered.bytes
          : offered.kind === "end"
            ? new Uint8Array(0)
            : Buffer.from(JSON.stringify(offered));
      valid(payload.length <= ("bytes" in offered ? chunkLimit : metadataLimit));
      const length = headerLength + payload.length;
      valid(
        this.#pending < pendingLimit &&
          this.#pendingBytes + length <= pendingByteLimit &&
          this.#wireWritten + length <= wireLimit,
      );
      if (offered.kind === "result") valid(this.#incoming.done);
      this.#transition(this.#outgoing, offered, this.#configuration.role === "client");
      const terminalFlush = offered.kind === "uncertain";
      if (terminalFlush) this.#fenceUncertain();
      const wire = new Uint8Array(length);
      wire.set([84, 66, 72, 49, codes[offered.kind]], 0);
      const view = new DataView(wire.buffer);
      view.setUint32(12, payload.length);
      wire.set(this.#nonce, 16);
      wire.set(payload, headerLength);
      this.#wireWritten += length;
      this.#pending++;
      this.#pendingBytes += length;
      const task = this.#queue
        .then(async () => {
          this.#check(terminalFlush);
          // Fenced queued ordinary frames are skipped. Only frames actually offered to the
          // private sink consume sequence numbers, allowing a terminal flush without gaps.
          view.setUint32(8, this.#outgoing.sequence++);
          const write = this.#capture(() => this.#writer.write.bind(this.#writer), terminalFlush);
          await this.#within(
            this.#capture(() => write(wire), terminalFlush),
            terminalFlush,
          );
          if (offered.kind === "end" || offered.kind === "result" || offered.kind === "uncertain") {
            const close = this.#capture(() => this.#writer.close.bind(this.#writer), terminalFlush);
            await this.#within(this.#capture(close, terminalFlush), terminalFlush);
            this.#outgoing.done = true;
            if (offered.kind === "uncertain") this.#stop();
          }
        })
        .catch(() => {
          throw this.#refuse(terminalFlush);
        })
        .finally(() => {
          this.#pending--;
          this.#pendingBytes -= length;
        });
      this.#queue = task.catch(() => {});
      return task;
    } catch {
      return Promise.reject(this.#refuse());
    }
  }
  async #take(length: number, eof = false): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      this.#check();
      if (this.#offset === this.#chunk.length) {
        const read = this.#capture(() => this.#reader.read.bind(this.#reader));
        const input = await this.#within(this.#capture(read));
        if (this.#capture(() => input.done)) {
          valid(eof && offset === 0);
          return null;
        }
        const chunk = this.#capture(() => copyBytes(input.value, wireLimit - this.#wireRead));
        valid(chunk.length > 0);
        this.#wireRead += chunk.length;
        this.#chunk = chunk;
        this.#offset = 0;
      }
      const size = Math.min(length - offset, this.#chunk.length - this.#offset);
      bytes.set(this.#chunk.subarray(this.#offset, this.#offset + size), offset);
      offset += size;
      this.#offset += size;
    }
    return bytes;
  }
  async receive(): Promise<HostBridgeFrame> {
    try {
      valid(!this.#capturing);
      this.#check();
      valid(!this.#reading && !this.#incoming.done);
      this.#reading = true;
      const header = await this.#take(headerLength);
      valid(header !== null);
      valid(
        header.slice(0, 4).every((value, index) => value === [84, 66, 72, 49][index]) &&
          header.slice(5, 8).every((value) => value === 0),
      );
      const view = new DataView(header.buffer);
      valid(
        view.getUint32(8) === this.#incoming.sequence++ &&
          header.slice(16).every((value, index) => value === this.#nonce[index]),
      );
      const kind = kinds.find((kind) => codes[kind] === header[4]);
      valid(kind !== undefined);
      const length = view.getUint32(12);
      valid(
        length <= (dataKinds.has(kind) ? chunkLimit : metadataLimit) &&
          (kind === "end" ? length === 0 : length > 0),
      );
      const payload = await this.#take(length);
      valid(payload !== null);
      const offered = dataKinds.has(kind)
        ? frame({ kind, bytes: payload })
        : kind === "end"
          ? frame({ kind })
          : metadata(payload);
      valid(offered.kind === kind);
      this.#transition(this.#incoming, offered, this.#configuration.role === "bridge");
      if (offered.kind === "uncertain") {
        // Known uncertainty is already a permanent failure, not an EOF/success claim.
        // Fence before even the captured clock callback, let alone another await/EOF.
        this.#stop();
        this.#checkTime();
        return offered;
      }
      // Parsing/copying is part of this original deadline, not just stream waits.
      this.#check();
      if (offered.kind === "end" || offered.kind === "result") {
        // No result escapes while a late frame or a partial trailing byte remains possible.
        valid((await this.#take(1, true)) === null);
        if (offered.kind === "result") {
          valid(this.#outgoing.ended);
          await this.#within(this.#queue);
          valid(this.#outgoing.done);
        }
        this.#incoming.done = true;
      }
      this.#check();
      return offered;
    } catch {
      throw this.#refuse();
    } finally {
      this.#reading = false;
    }
  }
  finish(): void {
    try {
      valid(!this.#capturing);
      this.#check();
      valid(this.#incoming.done && this.#outgoing.done && !this.#reading && this.#pending === 0);
      this.#release();
      this.#finished = true;
      clearTimeout(this.#timer);
    } catch {
      throw this.#refuse();
    }
  }
  abort(): void {
    this.#stop();
  }
}
/** Stream objects are single-use even across factories; no raw reader/writer is exposed. */
export function createHostFrameSession(
  configuration: HostBridgeFrameConfiguration,
  channels: {
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
    now?: () => number;
  },
): HostBridgeFrames {
  try {
    return new Session(configuration, channels);
  } catch {
    throw new Error(failure);
  }
}
