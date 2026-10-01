/** Invented private streams only: these tests confer no descriptor, key or host authority. */
import { describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import {
  createHostBridgeCoordinator,
  type HostBridgeHandlerIO,
  type HostBridgeHandlers,
} from "../../scripts/host-bridge-adapter.js";
import { createHostFrameSession, type HostBridgeFrame } from "../../scripts/host-bridge-frames.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function input(io: HostBridgeHandlerIO): Promise<Buffer> {
  const parts: Buffer[] = [];
  const reader = io.input.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts);
      parts.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}
function handlers(overrides: Partial<HostBridgeHandlers> = {}): HostBridgeHandlers {
  return {
    exec: async (io) => {
      await input(io);
      return 0;
    },
    put: async (io) => {
      await input(io);
      return 0;
    },
    fetch: async (io) => {
      await input(io);
      return 0;
    },
    ...overrides,
  };
}
function exchange(
  capabilities = handlers(),
  operation: "exec" | "put" | "fetch" = "exec",
  config: { operation_timeout_ms: number; now?: () => number } = { operation_timeout_ms: 1500 },
) {
  const coordinator = createHostBridgeCoordinator(capabilities, config);
  const allocation = coordinator.allocate(operation);
  const request = new TransformStream<Uint8Array, Uint8Array>();
  const response = new TransformStream<Uint8Array, Uint8Array>();
  const client = createHostFrameSession(
    { role: "client", nonce: allocation.nonce, operation, timeout_ms: config.operation_timeout_ms },
    { input: response.readable, output: request.writable },
  );
  const serving = coordinator.serve(allocation, {
    input: request.readable,
    output: response.writable,
  });
  void serving.catch(() => {});
  return {
    coordinator,
    allocation,
    client,
    serving,
    channels: { input: request.readable, output: response.writable },
  };
}
async function refused(work: Promise<unknown>) {
  await expect(work).rejects.toThrow("host-bridge-adapter-failed");
}
async function run(
  client: ReturnType<typeof createHostFrameSession>,
  metadata: HostBridgeFrame,
  bytes?: Uint8Array,
) {
  const sending = (async () => {
    await client.send(metadata);
    if (bytes?.length)
      await client.send({ kind: metadata.kind === "put" ? "file" : "stdin", bytes });
    await client.send({ kind: "end" });
  })();
  const frames: HostBridgeFrame[] = [];
  for (;;) {
    const next = await client.receive();
    frames.push(next);
    if (next.kind === "result") break;
  }
  await sending;
  client.finish();
  return frames;
}
describe("private host framing coordinator", () => {
  test("duplex exec preserves ordinary remote code and private binary stdout/stderr", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const e = exchange(
      handlers({
        exec: async (io) => {
          expect(io.command).toEqual(["/bin/sh", "-c", "invented command"]);
          await io.stderr(Buffer.from("before-input"));
          expect(await input(io)).toEqual(Buffer.from(bytes));
          await io.stdout(bytes);
          return 42;
        },
      }),
    );
    const frames = await run(
      e.client,
      { kind: "exec", command: ["/bin/sh", "-c", "invented command"] },
      bytes,
    );
    expect(frames.map((frame) => frame.kind)).toEqual(["response", "stderr", "stdout", "result"]);
    expect(frames.at(-1)).toEqual({ kind: "result", code: 42 });
    expect(e.coordinator.fenced).toBe(false);
    await e.serving;
    expect(e.coordinator.allocate("put").operation).toBe("put");
    e.coordinator.fence();
  });
  test("put and fetch use distinct binary channels and canonical literal paths", async () => {
    const fixture = Buffer.from([0, 255, 10, 13]);
    const put = exchange(
      handlers({
        put: async (io) => {
          expect(io.path).toBe("/tmp/invented.bin");
          expect(await input(io)).toEqual(fixture);
          return 0;
        },
      }),
      "put",
    );
    expect(
      (await run(put.client, { kind: "put", path: "/tmp/invented.bin" }, fixture)).at(-1),
    ).toEqual({ kind: "result", code: 0 });
    await put.serving;
    put.coordinator.fence();
    const fetch = exchange(
      handlers({
        fetch: async (io) => {
          expect(io.path).toBe("/tmp/invented.bin");
          await input(io);
          await io.file(fixture);
          return 0;
        },
      }),
      "fetch",
    );
    const result = await run(fetch.client, { kind: "fetch", path: "/tmp/invented.bin" });
    expect(result[1]).toEqual({ kind: "file", bytes: fixture });
    await fetch.serving;
    fetch.coordinator.fence();
  });
  test("known handler return waits for complete request and terminal close acknowledgement", async () => {
    const coordinator = createHostBridgeCoordinator(handlers(), { operation_timeout_ms: 1000 });
    const allocation = coordinator.allocate("exec");
    const req = new TransformStream<Uint8Array, Uint8Array>();
    const res = new TransformStream<Uint8Array, Uint8Array>();
    const writer = res.writable.getWriter();
    const closing = deferred<void>();
    let offeredClose = false;
    const client = createHostFrameSession(
      { role: "client", nonce: allocation.nonce, operation: "exec", timeout_ms: 1000 },
      { input: res.readable, output: req.writable },
    );
    const serving = coordinator.serve(allocation, {
      input: req.readable,
      output: new WritableStream({
        write: (bytes) => writer.write(bytes),
        async close() {
          offeredClose = true;
          await closing.promise;
          await writer.close();
        },
      }),
    });
    await client.send({ kind: "exec", command: ["invented"] });
    expect((await client.receive()).kind).toBe("response");
    expect(coordinator.remaining(allocation)).toBeGreaterThan(0);
    const ending = client.send({ kind: "end" });
    const terminal = client.receive();
    await Bun.sleep(10);
    expect(offeredClose).toBe(true);
    expect(coordinator.remaining(allocation)).toBeGreaterThan(0);
    expect(coordinator.fenced).toBe(false);
    closing.resolve();
    await ending;
    expect(await terminal).toEqual({ kind: "result", code: 0 });
    client.finish();
    await serving;
    coordinator.fence();
  });
  test("allocation abandonment and frozen wall clock expire physically without accepting another worker", async () => {
    const coordinator = createHostBridgeCoordinator(handlers(), {
      operation_timeout_ms: 20,
      now: () => 1_800_000_000_000,
    });
    const allocation = coordinator.allocate("exec");
    await Bun.sleep(35);
    expect(coordinator.fenced).toBe(true);
    expect(() => coordinator.remaining(allocation)).toThrow("host-bridge-adapter-failed");
    expect(() => coordinator.allocate("exec")).toThrow("host-bridge-adapter-failed");
  });
  test("slow first clock, backward clock and invented ticket identities permanently refuse", () => {
    const slow = createHostBridgeCoordinator(handlers(), {
      operation_timeout_ms: 5,
      now() {
        const start = performance.now();
        while (performance.now() - start < 8) {}
        return 1_800_000_000_000;
      },
    });
    expect(() => slow.allocate("exec")).toThrow("host-bridge-adapter-failed");
    expect(slow.fenced).toBe(true);
    let clock = 1_800_000_000_000;
    const coordinator = createHostBridgeCoordinator(handlers(), {
      operation_timeout_ms: 1000,
      now: () => clock,
    });
    const allocation = coordinator.allocate("exec");
    clock--;
    expect(() => coordinator.remaining(allocation)).toThrow("host-bridge-adapter-failed");
    const other = createHostBridgeCoordinator(handlers(), { operation_timeout_ms: 1000 });
    const original = other.allocate("exec");
    expect(() => other.remaining({ ...original })).toThrow("host-bridge-adapter-failed");
    expect(other.fenced).toBe(true);
  });
  test("captures handlers, clocks and original stream references before await; getters refuse", async () => {
    let calls = 0;
    const capabilities = handlers({
      exec: async (io) => {
        calls++;
        await input(io);
        return 0;
      },
    });
    const e = exchange(capabilities);
    capabilities.exec = async () => {
      throw new Error("invented replacement");
    };
    await run(e.client, { kind: "exec", command: ["invented"] });
    await e.serving;
    expect(calls).toBe(1);
    e.coordinator.fence();
    const trapped = handlers();
    Object.defineProperty(trapped, "exec", {
      get() {
        throw new Error("getter must not run");
      },
    });
    expect(() => createHostBridgeCoordinator(trapped, { operation_timeout_ms: 1000 })).toThrow(
      "host-bridge-adapter-failed",
    );
  });
  test("public method shadowing cannot bypass permanent invalid-allocation refusal", () => {
    const coordinator = createHostBridgeCoordinator(handlers(), { operation_timeout_ms: 1000 });
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(() => Object.defineProperty(coordinator, "fence", { value: () => {} })).toThrow();
    expect(() => Object.setPrototypeOf(coordinator, {})).toThrow();
    expect(() =>
      Object.defineProperty(Object.getPrototypeOf(coordinator), "fence", { value: () => {} }),
    ).toThrow();
    expect(() => coordinator.allocate("invalid" as "exec")).toThrow("host-bridge-adapter-failed");
    expect(coordinator.fenced).toBe(true);
    expect(() => coordinator.allocate("exec")).toThrow("host-bridge-adapter-failed");
  });
  test("raw stream objects remain single-use after a successful exchange", async () => {
    let calls = 0;
    const e = exchange(
      handlers({
        exec: async (io) => {
          calls++;
          await input(io);
          return 0;
        },
      }),
    );
    await run(e.client, { kind: "exec", command: ["invented"] });
    await e.serving;
    const next = e.coordinator.allocate("exec");
    await refused(e.coordinator.serve(next, e.channels));
    expect(calls).toBe(1);
    expect(e.coordinator.fenced).toBe(true);
  });
  test("channel accessors are captured exactly once before any asynchronous work", async () => {
    const coordinator = createHostBridgeCoordinator(handlers(), { operation_timeout_ms: 1000 });
    const allocation = coordinator.allocate("exec");
    const req = new TransformStream<Uint8Array, Uint8Array>();
    const res = new TransformStream<Uint8Array, Uint8Array>();
    let reads = 0;
    let writes = 0;
    const serving = coordinator.serve(allocation, {
      get input() {
        reads++;
        if (reads !== 1) throw new Error("invented accessor changed");
        return req.readable;
      },
      get output() {
        writes++;
        if (writes !== 1) throw new Error("invented accessor changed");
        return res.writable;
      },
    });
    const client = createHostFrameSession(
      { role: "client", nonce: allocation.nonce, operation: "exec", timeout_ms: 1000 },
      { input: res.readable, output: req.writable },
    );
    await run(client, { kind: "exec", command: ["invented"] });
    await serving;
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    coordinator.fence();
  });
  test("original boundary refuses queued output before any late underlying sink offer", async () => {
    let clock = 1_800_000_000_000;
    const writes: number[] = [];
    const request = new TransformStream<Uint8Array, Uint8Array>();
    const response = new TransformStream<Uint8Array, Uint8Array>();
    const writer = response.writable.getWriter();
    const coordinator = createHostBridgeCoordinator(
      handlers({
        exec: async (io) => {
          await input(io);
          const pending = io.stdout(Buffer.from("late"));
          void pending.catch(() => {});
          clock += 1000;
          await pending;
          return 0;
        },
      }),
      { operation_timeout_ms: 500, now: () => clock },
    );
    const allocation = coordinator.allocate("exec");
    const serving = coordinator.serve(allocation, {
      input: request.readable,
      output: new WritableStream({
        async write(bytes) {
          writes.push(bytes[4] as number);
          await writer.write(bytes);
        },
        abort() {
          void writer.abort().catch(() => {});
        },
      }),
    });
    void serving.catch(() => {});
    const client = createHostFrameSession(
      { role: "client", nonce: allocation.nonce, operation: "exec", timeout_ms: 1000 },
      { input: response.readable, output: request.writable },
    );
    await client.send({ kind: "exec", command: ["invented"] });
    expect((await client.receive()).kind).toBe("response");
    await client.send({ kind: "end" });
    await refused(serving);
    expect(writes).toEqual([4]);
    expect(coordinator.fenced).toBe(true);
    client.abort();
  });
  test("handler signal/255/error permanently fences late callbacks and every future allocation", async () => {
    let emit: HostBridgeHandlerIO["stdout"] | undefined;
    const e = exchange(
      handlers({
        exec: async (io) => {
          emit = io.stdout;
          await input(io);
          return 255;
        },
      }),
    );
    await e.client.send({ kind: "exec", command: ["invented"] });
    await e.client.receive();
    await e.client.send({ kind: "end" });
    await refused(e.serving);
    e.client.abort();
    expect(e.coordinator.fenced).toBe(true);
    expect(() => e.coordinator.allocate("exec")).toThrow("host-bridge-adapter-failed");
    await refused((emit as HostBridgeHandlerIO["stdout"])(Buffer.from("late")));
  });
});
