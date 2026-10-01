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
  test("invalid native Promise clocks are drained without a then getter or handler offer", () => {
    const modulePath = new URL("../../scripts/host-bridge-adapter.ts", import.meta.url).pathname;
    const program = `
      import {runInNewContext} from "node:vm";
      const {createHostBridgeCoordinator}=await import(${JSON.stringify(modulePath)});
      let unhandled=0,thenReads=0,offers=0;
      process.on("unhandledRejection",()=>unhandled++);
      const codes=[];
      for(const mode of ["first","later"])for(const foreign of [false,true]){
        let armed=mode==="first";
        const now=()=>{
          if(!armed)return 1_800_000_000_000;
          const value=foreign?runInNewContext('Promise.reject(Error("invented"))'):Promise.reject(Error("invented"));
          Object.defineProperty(value,"then",{get(){thenReads++;throw Error("invented then");}});
          return value;
        };
        const handle=async()=>{offers++;return 0;};
        const c=createHostBridgeCoordinator({exec:handle,put:handle,fetch:handle},{operation_timeout_ms:30_000,now});
        try{const a=c.allocate("exec");armed=true;c.remaining(a);codes.push("accepted");}
        catch(e){codes.push(e.message);}
        c.fence();
      }
      await Bun.sleep(20);console.log(JSON.stringify({unhandled,thenReads,offers,codes}));
    `;
    // A separate runtime observes genuine unhandled events; only invented callbacks exist.
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(Buffer.from(child.stderr).toString()).toBe("");
    expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
      unhandled: 0,
      thenReads: 0,
      offers: 0,
      codes: Array(4).fill("host-bridge-adapter-failed"),
    });
  });
  test("an observed shortened allocation expires before another clock or handler offer", () => {
    let wall = 1_800_000_000_000,
      clocks = 0;
    const coordinator = createHostBridgeCoordinator(handlers(), {
      operation_timeout_ms: 30_000,
      now: () => {
        clocks++;
        return wall;
      },
    });
    const allocation = coordinator.allocate("exec");
    wall += 29_980;
    expect(coordinator.remaining(allocation)).toBeLessThanOrEqual(20);
    const before = clocks,
      end = performance.now() + 60;
    while (performance.now() < end) {
      /* Consume the original short cap while its wall clock stays frozen. */
    }
    expect(() => coordinator.remaining(allocation)).toThrow("host-bridge-adapter-failed");
    expect(clocks).toBe(before);
    expect(coordinator.fenced).toBe(true);
    expect(() => coordinator.allocate("exec")).toThrow("host-bridge-adapter-failed");
  });
  test("channel capture that shortens time and consumes it cannot offer the next getter or lock", async () => {
    let wall = 1_800_000_000_000,
      outputGets = 0,
      calls = 0;
    const coordinator = createHostBridgeCoordinator(
      handlers({
        exec: async () => {
          calls++;
          return 0;
        },
      }),
      { operation_timeout_ms: 30_000, now: () => wall },
    );
    const allocation = coordinator.allocate("exec");
    const source = new ReadableStream<Uint8Array>();
    const output = new WritableStream<Uint8Array>();
    await refused(
      coordinator.serve(allocation, {
        get input() {
          wall += 29_980;
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* One owned getter consumes its own shortened allowance. */
          }
          return source;
        },
        get output() {
          outputGets++;
          return output;
        },
      }),
    );
    expect(outputGets).toBe(0);
    expect(calls).toBe(0);
    expect(source.locked).toBe(false);
    expect(output.locked).toBe(false);
    expect(coordinator.fenced).toBe(true);
  });
  test("returned native stream locks remain owned for cleanup when post-method capture expires", async () => {
    for (const mode of ["reader", "writer"] as const) {
      let wall = 1_800_000_000_000,
        cancels = 0,
        aborts = 0,
        offers = 0;
      const handle = async () => {
        offers++;
        return 0;
      };
      const coordinator = createHostBridgeCoordinator(
        { exec: handle, put: handle, fetch: handle },
        { operation_timeout_ms: 30_000, now: () => wall },
      );
      const allocation = coordinator.allocate("exec");
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          cancels++;
        },
      });
      const output = new WritableStream<Uint8Array>({
        abort() {
          aborts++;
        },
      });
      const shorten = () => {
        wall += 29_980;
        const end = performance.now() + 60;
        while (performance.now() < end) {
          /* Cleanup owns the accepted handle before the post-method observation refuses. */
        }
      };
      const read = source.getReader.bind(source),
        write = output.getWriter.bind(output);
      if (mode === "reader")
        Object.defineProperty(source, "getReader", {
          value: () => {
            const reader = read();
            shorten();
            return reader;
          },
        });
      else
        Object.defineProperty(output, "getWriter", {
          value: () => {
            const writer = write();
            shorten();
            return writer;
          },
        });
      await refused(coordinator.serve(allocation, { input: source, output }));
      await Bun.sleep(0);
      expect(offers).toBe(0);
      expect(cancels).toBe(1);
      expect(aborts).toBe(mode === "writer" ? 1 : 0);
      expect(source.locked).toBe(false);
      expect(output.locked).toBe(false);
      expect(coordinator.fenced).toBe(true);
    }
  });
  test("later allocation observations shorten an already held handler wait", async () => {
    const held = deferred<number>(),
      ready = deferred<void>();
    let wall = 1_800_000_000_000,
      settled = false;
    const e = exchange(
      handlers({
        exec: async (io) => {
          await input(io);
          ready.resolve();
          return held.promise;
        },
      }),
      "exec",
      { operation_timeout_ms: 30_000, now: () => wall },
    );
    const running = run(e.client, { kind: "exec", command: ["invented"] });
    void running.catch(() => {});
    void e.serving.catch(() => {
      settled = true;
    });
    await ready.promise;
    wall += 29_980;
    expect(e.coordinator.remaining(e.allocation)).toBeLessThanOrEqual(20);
    await Bun.sleep(80);
    expect(settled).toBe(true);
    await refused(e.serving);
    held.resolve(0);
    await running.catch(() => {});
    e.client.abort();
    expect(e.coordinator.fenced).toBe(true);
    expect(() => e.coordinator.allocate("exec")).toThrow("host-bridge-adapter-failed");
  });
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
