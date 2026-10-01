/** Invented private byte streams only. Framing acceptance supplies no SSH/descriptor authority. */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createHostFrameSession,
  type HostBridgeFrame,
  type HostBridgeFrameConfiguration,
  type HostBridgeFrames,
  type HostBridgeOperation,
} from "../../scripts/host-bridge-frames.js";

const sessions: HostBridgeFrames[] = [];
const instant = 1_800_000_000_000;
const fixed = "host-bridge-frames-failed";
afterEach(() => {
  for (const session of sessions.splice(0)) session.abort();
});
function configuration(
  role: "client" | "bridge",
  nonce = randomBytes(16).toString("hex"),
  operation: HostBridgeOperation = "exec",
  timeout_ms = 2000,
): HostBridgeFrameConfiguration {
  return { role, nonce, operation, timeout_ms };
}
function bytes(values: Uint8Array[], open = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      if (!open) controller.close();
    },
  });
}
function sink() {
  const values: Uint8Array[] = [];
  return {
    values,
    output: new WritableStream<Uint8Array>({
      write(value) {
        values.push(Uint8Array.from(value));
      },
    }),
  };
}
function create(
  config: HostBridgeFrameConfiguration,
  input: ReadableStream<Uint8Array> = bytes([], true),
  output = sink().output,
  now = () => instant,
): HostBridgeFrames {
  const session = createHostFrameSession(config, { input, output, now });
  sessions.push(session);
  return session;
}
function pair(operation: HostBridgeOperation = "exec", timeout_ms = 2000) {
  const request = new TransformStream<Uint8Array, Uint8Array>();
  const response = new TransformStream<Uint8Array, Uint8Array>();
  const config = configuration("client", undefined, operation, timeout_ms);
  return {
    client: create(config, response.readable, request.writable),
    bridge: create({ ...config, role: "bridge" }, request.readable, response.writable),
    nonce: config.nonce,
  };
}
function first(operation: HostBridgeOperation): HostBridgeFrame {
  return operation === "exec"
    ? { kind: "exec", command: ["/bin/sh", "-c", "invented literal module"] }
    : { kind: operation, path: "/tmp/invented-module" };
}
async function exchange(
  sender: HostBridgeFrames,
  receiver: HostBridgeFrames,
  frame: HostBridgeFrame,
): Promise<HostBridgeFrame> {
  const [received] = await Promise.all([receiver.receive(), sender.send(frame)]);
  return received;
}
async function refused(value: Promise<unknown>): Promise<void> {
  await expect(value).rejects.toThrow(new RegExp(`^${fixed}$`, "u"));
}
const kinds = {
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
/** Independent fixture encoder exercises actual wire validation, not a round-trip-only parser. */
function wire(
  nonce: string,
  sequence: number,
  kind: keyof typeof kinds,
  payload: unknown = undefined,
): Uint8Array {
  const data =
    payload instanceof Uint8Array
      ? payload
      : kind === "end"
        ? new Uint8Array(0)
        : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const value = new Uint8Array(32 + data.length);
  value.set([84, 66, 72, 49, kinds[kind]]);
  const view = new DataView(value.buffer);
  view.setUint32(8, sequence);
  view.setUint32(12, data.length);
  value.set(Buffer.from(nonce, "hex"), 16);
  value.set(data, 32);
  return value;
}
function concat(values: Uint8Array[]): Uint8Array {
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

describe("single-exchange private host bridge framing", () => {
  test("invalid initial and later Promise clocks drain without then getters or private bytes", () => {
    const modulePath = new URL("../../scripts/host-bridge-frames.ts", import.meta.url).pathname;
    const program = `
      import {runInNewContext} from "node:vm";
      const {createHostFrameSession}=await import(${JSON.stringify(modulePath)});
      let unhandled=0,thenReads=0,writes=0;
      process.on("unhandledRejection",()=>unhandled++);
      const codes=[];
      for(const mode of ["first","later"])for(const foreign of [false,true]){
        let armed=mode==="first",session;
        const now=()=>{
          if(!armed)return 1_800_000_000_000;
          const value=foreign?runInNewContext('Promise.reject(Error("invented"))'):Promise.reject(Error("invented"));
          Object.defineProperty(value,"then",{get(){thenReads++;throw Error("invented then");}});
          return value;
        };
        try{
          session=createHostFrameSession({role:"client",nonce:"ab".repeat(16),operation:"exec",timeout_ms:30_000},
            {input:new ReadableStream(),output:new WritableStream({write(){writes++;}}),now});
          armed=true;await session.send({kind:"exec",command:["/bin/true"]});codes.push("accepted");
        }catch(e){codes.push(e.message);}finally{session?.abort();}
      }
      await Bun.sleep(20);console.log(JSON.stringify({unhandled,thenReads,writes,codes}));
    `;
    // No external IPC exists; the child checks the runtime's actual rejected-Promise events.
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
      writes: 0,
      codes: Array(4).fill(fixed),
    });
  });
  test("an observed short wall remainder cannot offer another private byte after synchronous cost", async () => {
    const output = sink();
    let wall = instant,
      clocks = 0;
    const session = create(
      configuration("client", undefined, "exec", 30_000),
      bytes([], true),
      output.output,
      () => {
        clocks++;
        return wall;
      },
    );
    await session.send(first("exec"));
    wall += 29_980;
    await session.send({ kind: "stdin", bytes: Uint8Array.of(1) });
    const writes = output.values.length,
      before = clocks,
      end = performance.now() + 60;
    while (performance.now() < end) {
      /* A queued timer cannot grant another copy of the frozen wall remainder. */
    }
    await refused(session.send({ kind: "stdin", bytes: Uint8Array.of(2) }));
    expect(output.values).toHaveLength(writes);
    expect(clocks).toBe(before);
  });
  test("owned metadata reflection cannot shorten time and consume it before the next sink offer", async () => {
    const output = sink();
    let wall = instant,
      traps = 0;
    const session = create(
      configuration("client", undefined, "exec", 30_000),
      bytes([], true),
      output.output,
      () => wall,
    );
    const offered = new Proxy(first("exec"), {
      ownKeys(target) {
        if (++traps === 1) {
          wall += 29_980;
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* The immediate post-hook observation uses this capture's original anchor. */
          }
        }
        return Reflect.ownKeys(target);
      },
    });
    await refused(session.send(offered));
    expect(output.values).toHaveLength(0);
    expect(traps).toBe(1);
  });
  test("construction counts locked and method getter cost after its FIRST wall observation", () => {
    for (const mode of ["locked", "getReader", "getWriter"] as const) {
      const source = bytes([], true),
        output = sink();
      let wall = instant;
      const target = mode === "getWriter" ? output.output : source;
      const native =
        mode === "getWriter"
          ? output.output.getWriter.bind(output.output)
          : source.getReader.bind(source);
      Object.defineProperty(target, mode, {
        configurable: true,
        get() {
          wall += 29_980;
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* The original constructor cap includes binding before the actual native lock. */
          }
          return mode === "locked" ? false : native;
        },
      });
      expect(() =>
        create(
          configuration("client", undefined, "exec", 30_000),
          source,
          output.output,
          () => wall,
        ),
      ).toThrow(fixed);
      Reflect.deleteProperty(target, mode);
      expect(source.locked).toBe(false);
      expect(output.output.locked).toBe(false);
      expect(output.values).toHaveLength(0);
    }
  });
  test("a native lock returned at expiry is retained for independent cancellation and release", async () => {
    for (const mode of ["reader", "writer"] as const) {
      let wall = instant,
        cancels = 0,
        aborts = 0,
        locks = 0;
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
          /* The real returned lock must survive the capture's subsequent refusal. */
        }
        locks++;
      };
      const read = source.getReader.bind(source),
        write = output.getWriter.bind(output);
      if (mode === "reader")
        Object.defineProperty(source, "getReader", {
          value: () => {
            const handle = read();
            shorten();
            return handle;
          },
        });
      else
        Object.defineProperty(output, "getWriter", {
          value: () => {
            const handle = write();
            shorten();
            return handle;
          },
        });
      expect(() =>
        create(configuration("client", undefined, "exec", 30_000), source, output, () => wall),
      ).toThrow(fixed);
      await Bun.sleep(0);
      expect(locks).toBe(1);
      expect(cancels).toBe(1);
      expect(aborts).toBe(mode === "writer" ? 1 : 0);
      expect(source.locked).toBe(false);
      expect(output.locked).toBe(false);
    }
  });
  test("later observations shorten held native sink acknowledgements without a late queued write", async () => {
    let release!: () => void,
      entered!: () => void,
      settled = false,
      writes = 0,
      wall = instant;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const output = new WritableStream<Uint8Array>({
      write() {
        writes++;
        entered();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const session = create(
      configuration("client", undefined, "exec", 30_000),
      bytes([], true),
      output,
      () => wall,
    );
    const firstSend = session.send(first("exec"));
    void firstSend.catch(() => {
      settled = true;
    });
    await ready;
    wall += 29_980;
    const queued = session.send({ kind: "stdin", bytes: Uint8Array.of(1) });
    void queued.catch(() => {});
    await Bun.sleep(80);
    expect(settled).toBe(true);
    await refused(firstSend);
    await refused(queued);
    release();
    await Bun.sleep(10);
    expect(writes).toBe(1);
  });
  test("exec pipelines a become marker before binary stdin and preserves interleaved stdout/stderr and nonzero remote status", async () => {
    const { client, bridge } = pair();
    expect(await exchange(client, bridge, first("exec"))).toEqual(first("exec"));
    expect(await exchange(bridge, client, { kind: "response", operation: "exec" })).toEqual({
      kind: "response",
      operation: "exec",
    });
    expect(
      await exchange(bridge, client, {
        kind: "stderr",
        bytes: Buffer.from("BECOME-SUCCESS-invented"),
      }),
    ).toEqual({ kind: "stderr", bytes: Buffer.from("BECOME-SUCCESS-invented") });
    const binary = Uint8Array.from([0, 255, 128, 10, 13, 0]);
    expect(await exchange(client, bridge, { kind: "stdin", bytes: binary })).toEqual({
      kind: "stdin",
      bytes: binary,
    });
    for (const kind of ["stdout", "stderr", "stdout"] as const)
      expect(await exchange(bridge, client, { kind, bytes: binary })).toEqual({
        kind,
        bytes: binary,
      });
    expect(await exchange(client, bridge, { kind: "end" })).toEqual({ kind: "end" });
    expect(await exchange(bridge, client, { kind: "result", code: 23 })).toEqual({
      kind: "result",
      code: 23,
    });
    client.finish();
    bridge.finish();
    expect(() => client.finish()).toThrow(fixed);
    await refused(client.send({ kind: "end" }));
    await refused(bridge.receive());
  });

  test("put and fetch carry file bytes only in their exact direction, with complete request and clean result", async () => {
    for (const operation of ["put", "fetch"] as const) {
      const { client, bridge } = pair(operation);
      expect(await exchange(client, bridge, first(operation))).toEqual(first(operation));
      const binary = Uint8Array.from([0, 1, 254, 255]);
      if (operation === "put")
        expect(await exchange(client, bridge, { kind: "file", bytes: binary })).toEqual({
          kind: "file",
          bytes: binary,
        });
      await exchange(client, bridge, { kind: "end" });
      await exchange(bridge, client, { kind: "response", operation });
      if (operation === "fetch")
        expect(await exchange(bridge, client, { kind: "file", bytes: binary })).toEqual({
          kind: "file",
          bytes: binary,
        });
      await exchange(bridge, client, { kind: "result", code: 0 });
      client.finish();
      bridge.finish();
    }
  });

  test("writer reserves concurrent sends in exact FIFO order and honours sink backpressure", async () => {
    const config = configuration("client");
    const values: Uint8Array[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      config,
      bytes([], true),
      new WritableStream({
        async write(value) {
          values.push(Uint8Array.from(value));
          if (values.length === 1) await waiting;
        },
      }),
    );
    const pending = [
      session.send(first("exec")),
      session.send({ kind: "stdin", bytes: Uint8Array.from([1]) }),
      session.send({ kind: "stdin", bytes: Uint8Array.from([2]) }),
      session.send({ kind: "end" }),
    ];
    await Bun.sleep(10);
    expect(values.length).toBe(1);
    release?.();
    await Promise.all(pending);
    expect(
      values.map((value) => new DataView(value.buffer, value.byteOffset).getUint32(8)),
    ).toEqual([0, 1, 2, 3]);
    const bridge = create({ ...config, role: "bridge" }, bytes(values));
    expect(await bridge.receive()).toEqual(first("exec"));
    expect(await bridge.receive()).toEqual({ kind: "stdin", bytes: Uint8Array.from([1]) });
    expect(await bridge.receive()).toEqual({ kind: "stdin", bytes: Uint8Array.from([2]) });
    expect(await bridge.receive()).toEqual({ kind: "end" });
  });

  test("reader accepts arbitrary fragmentation/coalescing and snapshots caller bytes before awaiting writes", async () => {
    const config = configuration("client");
    const output = sink();
    const client = create(config, bytes([], true), output.output);
    const command = { kind: "exec" as const, command: ["/bin/echo", "invented"] };
    const initial = client.send(command);
    command.command[0] = "mutated";
    await initial;
    const binary = Uint8Array.from([0, 255, 127]);
    const sent = client.send({ kind: "stdin", bytes: binary });
    binary.fill(42);
    await sent;
    await client.send({ kind: "end" });
    const all = concat(output.values);
    const fragments = [
      all.slice(0, 1),
      all.slice(1, 7),
      all.slice(7, 41),
      all.slice(41, 47),
      all.slice(47),
    ];
    const bridge = create({ ...config, role: "bridge" }, bytes(fragments));
    expect(await bridge.receive()).toEqual({ kind: "exec", command: ["/bin/echo", "invented"] });
    expect(await bridge.receive()).toEqual({
      kind: "stdin",
      bytes: Uint8Array.from([0, 255, 127]),
    });
    expect(await bridge.receive()).toEqual({ kind: "end" });
  });

  test("headers reject magic/version/reserved/kind/sequence/replay/mixed nonce/oversized length before payload acceptance", async () => {
    for (const change of [
      (value: Uint8Array) => {
        value[0] = 0;
      },
      (value: Uint8Array) => {
        value[3] = 50;
      },
      (value: Uint8Array) => {
        value[6] = 1;
      },
      (value: Uint8Array) => {
        value[4] = 255;
      },
      (value: Uint8Array) => {
        new DataView(value.buffer).setUint32(8, 1);
      },
      (value: Uint8Array) => {
        value[16] = (value[16] ?? 0) ^ 1;
      },
      (value: Uint8Array) => {
        new DataView(value.buffer).setUint32(12, 16_385);
      },
    ]) {
      const config = configuration("bridge");
      const value = wire(config.nonce, 0, "exec", first("exec"));
      change(value);
      const session = create(config, bytes([value]));
      await refused(session.receive());
      await refused(session.receive());
    }
    for (const sequence of [0, 2]) {
      const config = configuration("bridge");
      const session = create(
        config,
        bytes([wire(config.nonce, 0, "exec", first("exec")), wire(config.nonce, sequence, "end")]),
      );
      await session.receive();
      await refused(session.receive());
    }
  });

  test("partial headers/payloads, missing terminals and trailing bytes never produce a completed exchange", async () => {
    for (const mode of ["header", "payload", "missing", "late", "partial-late"] as const) {
      const config = configuration("bridge");
      const initial = wire(config.nonce, 0, "exec", first("exec"));
      const values =
        mode === "header"
          ? [initial.slice(0, 12)]
          : mode === "payload"
            ? [initial.slice(0, -1)]
            : mode === "missing"
              ? [initial]
              : [
                  initial,
                  wire(config.nonce, 1, "end"),
                  mode === "late" ? wire(config.nonce, 2, "end") : Uint8Array.from([1]),
                ];
      const session = create(config, bytes(values));
      if (mode !== "header" && mode !== "payload") await session.receive();
      await refused(session.receive());
      expect(() => session.finish()).toThrow(fixed);
    }
  });

  test("exact schemas and JSON bounds reject duplicate escaped keys, malformed UTF-8, BOM, unknown fields and kind conflicts", async () => {
    for (const payload of [
      '{"kind":"exec","k\\u0069nd":"exec","command":["/bin/true"]}',
      '{"kind":"exec","command":["/bin/true"],"options":["-oProxyCommand=trap"]}',
      '{"kind":"exec","command":["/bin/true"],"descriptor":{}}',
      '{"kind":"exec","command":["/bin/true"],"proof":{}}',
      '{"kind":"exec","command":["/bin/true"],"n":1e999}',
      '{"kind":"exec","command":["/bin/true"]}garbage',
      '{"kind":"exec","command":null}',
      '{"kind":"exec","command":["/bin/true"',
      '\ufeff{"kind":"exec","command":["/bin/true"]}',
      '{"kind":"put","path":"/tmp/invented"}',
      `${"[".repeat(10)}0${"]".repeat(10)}`,
      JSON.stringify({ kind: "exec", command: Array.from({ length: 257 }, () => "x") }),
      Uint8Array.from([0xc0, 0xaf]),
    ]) {
      const config = configuration("bridge");
      await refused(create(config, bytes([wire(config.nonce, 0, "exec", payload)])).receive());
    }
  });

  test("strict command/path/operation/channel validation rejects options, traversal and input supplied in the wrong direction", async () => {
    for (const offered of [
      { kind: "exec", command: [] },
      { kind: "exec", command: [""] },
      { kind: "exec", command: ["/bin/true\ntrap"] },
      { kind: "exec", command: ["x".repeat(4097)] },
      { kind: "exec", command: Array.from({ length: 33 }, () => "x") },
      {
        kind: "exec",
        command: ["x".repeat(4096), "x".repeat(4096), "x".repeat(4096), "x".repeat(4096), "x"],
      },
      { kind: "exec", command: ["/bin/true"], ssh_options: ["-F", "trap"] },
    ])
      await refused(create(configuration("client")).send(offered as HostBridgeFrame));
    for (const path of [
      "-oProxyCommand=trap",
      "relative",
      "/",
      "/tmp/../etc/file",
      "/tmp//file",
      "/tmp/file/",
      "/tmp/file\0",
      "/tmp/file with space",
    ])
      await refused(create(configuration("client", undefined, "put")).send({ kind: "put", path }));
    for (const operation of ["exec", "put", "fetch"] as const) {
      const session = create(configuration("client", undefined, operation));
      await session.send(first(operation));
      const wrong = operation === "exec" ? "file" : "stdin";
      await refused(session.send({ kind: wrong, bytes: Uint8Array.from([1]) }));
    }
    const bridge = create(configuration("bridge"));
    await refused(bridge.send({ kind: "response", operation: "exec" }));
    const { client, bridge: peer } = pair();
    await exchange(client, peer, first("exec"));
    await refused(peer.send({ kind: "response", operation: "fetch" }));
    await refused(client.receive());
  });

  test("plain snapshots never execute getters/toJSON and capture configuration, clocks and metadata", async () => {
    let reads = 0;
    const config = configuration("client");
    const channels = { input: bytes([], true), output: sink().output, now: () => instant };
    const session = createHostFrameSession(config, channels);
    sessions.push(session);
    config.nonce = "f".repeat(32);
    config.operation = "fetch";
    config.timeout_ms = 1;
    channels.now = () => instant - 1;
    expect(Object.keys(session)).toEqual([]);
    expect(JSON.stringify(session)).toBe("{}");
    await session.send(first("exec"));
    const getter = { kind: "stdin" };
    Object.defineProperty(getter, "bytes", {
      enumerable: true,
      get() {
        reads++;
        return Uint8Array.from([1]);
      },
    });
    await refused(session.send(getter as HostBridgeFrame));
    expect(reads).toBe(0);
    const malicious = {
      kind: "exec",
      command: ["/bin/true"],
      toJSON() {
        reads++;
        return first("exec");
      },
    };
    await refused(create(configuration("client")).send(malicious as HostBridgeFrame));
    expect(reads).toBe(0);
    const badConfig = configuration("client");
    Object.defineProperty(badConfig, "nonce", {
      enumerable: true,
      get() {
        reads++;
        return "a".repeat(32);
      },
    });
    expect(() => create(badConfig)).toThrow(fixed);
    expect(reads).toBe(0);
  });

  test("intrinsic chunk size/copy rejects oversized shadowed chunks without consulting iteration", async () => {
    let iterations = 0;
    const data = new Uint8Array(65_537);
    Object.defineProperty(data, "byteLength", { value: 1 });
    Object.defineProperty(data, Symbol.iterator, {
      value() {
        iterations++;
        throw new Error("invented iterator trap");
      },
    });
    const session = create(configuration("client"));
    await session.send(first("exec"));
    await refused(session.send({ kind: "stdin", bytes: data }));
    expect(iterations).toBe(0);
    const small = Uint8Array.from([4, 255]);
    Object.defineProperty(small, "byteLength", { value: 9_999_999 });
    Object.defineProperty(small, Symbol.iterator, {
      value() {
        iterations++;
        throw new Error("invented iterator trap");
      },
    });
    const output = sink();
    const accepted = create(configuration("client"), bytes([], true), output.output);
    await accepted.send(first("exec"));
    await accepted.send({ kind: "stdin", bytes: small });
    expect(output.values[1]?.slice(32)).toEqual(Uint8Array.from([4, 255]));
    expect(iterations).toBe(0);
    const config = configuration("bridge");
    const input = new Uint8Array(9 * 1024 * 1024 + 1);
    Object.defineProperty(input, "byteLength", { value: 1 });
    Object.defineProperty(input, Symbol.iterator, {
      value() {
        iterations++;
        throw new Error("invented iterator trap");
      },
    });
    await refused(create(config, bytes([input])).receive());
    expect(iterations).toBe(0);
  });

  test("directional data/frame totals and empty/oversized chunks refuse rather than silently truncate", async () => {
    const session = create(configuration("client"));
    await session.send(first("exec"));
    for (let i = 0; i < 128; i++)
      await session.send({ kind: "stdin", bytes: new Uint8Array(65_536) });
    await refused(session.send({ kind: "stdin", bytes: Uint8Array.from([1]) }));
    const frames = create(configuration("client"));
    await frames.send(first("exec"));
    for (let i = 0; i < 4095; i++)
      await frames.send({ kind: "stdin", bytes: Uint8Array.from([1]) });
    await refused(frames.send({ kind: "end" }));
    for (const chunk of [new Uint8Array(0), new Uint8Array(65_537)]) {
      const offered = create(configuration("client"));
      await offered.send(first("exec"));
      await refused(offered.send({ kind: "stdin", bytes: chunk }));
    }
  });

  test("bounded pending reservations permanently fence a stalled writer and prevent queued late writes", async () => {
    const values: Uint8Array[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      configuration("client"),
      bytes([], true),
      new WritableStream({
        async write(value) {
          values.push(Uint8Array.from(value));
          await waiting;
        },
      }),
    );
    const pending = [session.send(first("exec"))];
    for (let i = 0; i < 7; i++)
      pending.push(session.send({ kind: "stdin", bytes: Uint8Array.from([i]) }));
    await Bun.sleep(5);
    await refused(session.send({ kind: "stdin", bytes: Uint8Array.from([9]) }));
    await Promise.all(pending.map(refused));
    release?.();
    await Bun.sleep(5);
    expect(values.length).toBe(1);
    await refused(session.send({ kind: "end" }));
  });

  test("pending wire-byte reservations include every header and refuse before the eight-frame count is reached", async () => {
    let writes = 0;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      configuration("client"),
      bytes([], true),
      new WritableStream({
        async write() {
          writes++;
          if (writes > 1) await waiting;
        },
      }),
    );
    await session.send(first("exec"));
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 7; i++)
      pending.push(session.send({ kind: "stdin", bytes: new Uint8Array(65_536) }));
    await Bun.sleep(5);
    // Eight full payloads fit 512KiB, but their headers do not. Capacity includes wire bytes.
    await refused(session.send({ kind: "stdin", bytes: new Uint8Array(65_536) }));
    await Promise.all(pending.map(refused));
    release?.();
    await Bun.sleep(5);
    expect(writes).toBe(2);
  });

  test("receive-side caps reject oversized data headers, directional totals and excess frame counts independently", async () => {
    const config = configuration("bridge");
    const oversized = wire(config.nonce, 1, "stdin", Uint8Array.from([1])).slice(0, 32);
    new DataView(oversized.buffer).setUint32(12, 65_537);
    const rejected = create(
      config,
      bytes([wire(config.nonce, 0, "exec", first("exec")), oversized], true),
    );
    await rejected.receive();
    // No payload is offered: header rejection must settle without waiting for any more bytes.
    await refused(rejected.receive());
    const totalsConfig = configuration("bridge");
    const totalFrames = [wire(totalsConfig.nonce, 0, "exec", first("exec"))];
    for (let i = 0; i < 128; i++)
      totalFrames.push(wire(totalsConfig.nonce, i + 1, "stdin", new Uint8Array(65_536)));
    totalFrames.push(wire(totalsConfig.nonce, 129, "stdin", Uint8Array.from([1])));
    const totals = create(totalsConfig, bytes(totalFrames));
    for (let i = 0; i < 129; i++) await totals.receive();
    await refused(totals.receive());
    const countConfig = configuration("bridge");
    const countFrames = [wire(countConfig.nonce, 0, "exec", first("exec"))];
    for (let i = 1; i <= 4096; i++)
      countFrames.push(wire(countConfig.nonce, i, "stdin", Uint8Array.from([1])));
    const count = create(countConfig, bytes(countFrames));
    for (let i = 0; i < 4096; i++) await count.receive();
    await refused(count.receive());
  });

  test("known result is withheld until clean EOF and complete request; remote 255/signal-like schemas never classify as ordinary result", async () => {
    for (const code of [-1, 255, 256, 1.5, null]) {
      const { client, bridge } = pair();
      await exchange(client, bridge, first("exec"));
      await exchange(client, bridge, { kind: "end" });
      await exchange(bridge, client, { kind: "response", operation: "exec" });
      await refused(bridge.send({ kind: "result", code } as HostBridgeFrame));
      await refused(client.receive());
    }
    const { client, bridge } = pair();
    await exchange(client, bridge, first("exec"));
    await exchange(bridge, client, { kind: "response", operation: "exec" });
    await refused(bridge.send({ kind: "result", code: 0 }));
    const config = configuration("client");
    const response = [
      wire(config.nonce, 0, "response", { kind: "response", operation: "exec" }),
      wire(config.nonce, 1, "result", { kind: "result", code: 0 }),
    ];
    const raw = create(config, bytes(response));
    await raw.send(first("exec"));
    await raw.receive();
    await refused(raw.receive());
    const pending = create({ ...configuration("client"), timeout_ms: 40 }, bytes([], true));
    await pending.send(first("exec"));
    await refused(pending.receive());
  });

  test("result terminal remains private until EOF, while a valid uncertain terminal fences both directions immediately", async () => {
    const config = configuration("client");
    let close: (() => void) | undefined;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          wire(config.nonce, 0, "response", { kind: "response", operation: "exec" }),
        );
        controller.enqueue(wire(config.nonce, 1, "result", { kind: "result", code: 254 }));
        close = () => controller.close();
      },
    });
    const session = create(config, input);
    await session.send(first("exec"));
    await session.send({ kind: "end" });
    await session.receive();
    let exposed = false;
    const terminal = session.receive().then((value) => {
      exposed = true;
      return value;
    });
    await Bun.sleep(10);
    expect(exposed).toBe(false);
    close?.();
    expect(await terminal).toEqual({ kind: "result", code: 254 });
    session.finish();
    const { client, bridge } = pair();
    await exchange(client, bridge, first("exec"));
    await exchange(bridge, client, { kind: "response", operation: "exec" });
    const uncertain = { kind: "uncertain" as const, error: "host-bridge-uncertain" as const };
    expect(await exchange(bridge, client, uncertain)).toEqual(uncertain);
    expect(() => client.finish()).toThrow(fixed);
    await refused(client.send({ kind: "stdin", bytes: Uint8Array.from([1]) }));
    await refused(bridge.receive());
  });

  test("received uncertainty fences pending/queued writes immediately despite held EOF and cancellation acknowledgement", async () => {
    const config = configuration("client");
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          wire(config.nonce, 0, "response", { kind: "response", operation: "exec" }),
        );
        controller.enqueue(
          wire(config.nonce, 1, "uncertain", { kind: "uncertain", error: "host-bridge-uncertain" }),
        );
        // The adversarial peer never supplies EOF, including after its valid uncertainty.
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const writes: Uint8Array[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      config,
      input,
      new WritableStream({
        async write(value) {
          writes.push(Uint8Array.from(value));
          if (writes.length > 1) await waiting;
        },
        abort: () => new Promise<void>(() => {}),
      }),
    );
    await session.send(first("exec"));
    await session.receive();
    const offered = [
      session.send({ kind: "stdin", bytes: Uint8Array.from([1]) }),
      session.send({ kind: "stdin", bytes: Uint8Array.from([2]) }),
    ];
    await Bun.sleep(5);
    const terminal = await Promise.race([
      session.receive(),
      Bun.sleep(200).then(() => {
        throw new Error("invented held-EOF regression");
      }),
    ]);
    expect(terminal).toEqual({ kind: "uncertain", error: "host-bridge-uncertain" });
    expect(cancelled).toBe(true);
    await Promise.all(offered.map(refused));
    await refused(session.send({ kind: "stdin", bytes: Uint8Array.from([3]) }));
    expect(writes.length).toBe(2);
    release?.();
    await Bun.sleep(5);
    expect(writes.length).toBe(2);
    await refused(session.receive());
    expect(() => session.finish()).toThrow(fixed);
  });

  test("offering uncertainty immediately fences opposite reads and new sends while its close acknowledgement is held", async () => {
    const config = configuration("bridge");
    const input = bytes(
      [
        wire(config.nonce, 0, "exec", first("exec")),
        wire(config.nonce, 1, "stdin", Uint8Array.from([1])),
      ],
      true,
    );
    let closing = false;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: Uint8Array[] = [];
    const session = create(
      config,
      input,
      new WritableStream({
        write(value) {
          writes.push(Uint8Array.from(value));
        },
        close() {
          closing = true;
          return waiting;
        },
      }),
    );
    await session.receive();
    await session.send({ kind: "response", operation: "exec" });
    const reading = session.receive();
    const terminal = session.send({ kind: "uncertain", error: "host-bridge-uncertain" });
    await refused(reading);
    await refused(session.receive());
    await refused(session.send({ kind: "stdout", bytes: Uint8Array.from([1]) }));
    await Bun.sleep(5);
    expect(closing).toBe(true);
    expect(writes.length).toBe(2);
    expect(() => session.finish()).toThrow(fixed);
    release?.();
    await terminal;
    expect(writes.map((value) => value[4])).toEqual([4, 11]);
  });

  test("uncertainty skips queued ordinary frames, preserves actual wire sequence and bounds its sole flush behind a held write acknowledgement", async () => {
    const config = configuration("bridge");
    const input = bytes([wire(config.nonce, 0, "exec", first("exec"))], true);
    const writes: Uint8Array[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      config,
      input,
      new WritableStream({
        async write(value) {
          writes.push(Uint8Array.from(value));
          if (writes.length === 2) await waiting;
        },
      }),
    );
    await session.receive();
    await session.send({ kind: "response", operation: "exec" });
    const ordinary = [
      session.send({ kind: "stdout", bytes: Uint8Array.from([1]) }),
      session.send({ kind: "stderr", bytes: Uint8Array.from([2]) }),
    ];
    await Bun.sleep(5);
    // Capture rejection immediately, but do not start a Bun assertion until after the fence.
    const reading = session.receive().then(
      () => new Error("invented unexpected read success"),
      (error: unknown) => error,
    );
    const terminal = session.send({ kind: "uncertain", error: "host-bridge-uncertain" });
    await Promise.all(ordinary.map(refused));
    expect(await reading).toBeInstanceOf(Error);
    expect(((await reading) as Error).message).toBe(fixed);
    await refused(session.send({ kind: "stdout", bytes: Uint8Array.from([3]) }));
    expect(writes.length).toBe(2);
    release?.();
    await terminal;
    expect(writes.map((value) => value[4])).toEqual([4, 7, 11]);
    expect(
      writes.map((value) => new DataView(value.buffer, value.byteOffset).getUint32(8)),
    ).toEqual([0, 1, 2]);
    await refused(session.receive());
    expect(() => session.finish()).toThrow(fixed);
  });

  test("uncertain terminal flush retains the original physical deadline and turns private write/close failures into one fixed error", async () => {
    for (const mode of ["timeout", "write", "close"] as const) {
      const config = configuration("bridge", undefined, "exec", mode === "timeout" ? 40 : 2000);
      const input = bytes([wire(config.nonce, 0, "exec", first("exec"))], true);
      let writes = 0;
      const session = create(
        config,
        input,
        new WritableStream({
          write() {
            if (++writes === 1) return;
            if (mode === "timeout") return new Promise<void>(() => {});
            if (mode === "write") throw new Error("invented private terminal write error");
          },
          close() {
            if (mode === "close") throw new Error("invented private terminal close error");
          },
          abort: () => new Promise<void>(() => {}),
        }),
      );
      await session.receive();
      await session.send({ kind: "response", operation: "exec" });
      const started = performance.now();
      const terminal = session.send({ kind: "uncertain", error: "host-bridge-uncertain" });
      await refused(session.receive());
      await refused(terminal);
      expect(performance.now() - started).toBeLessThan(1000);
      await refused(session.send({ kind: "stdout", bytes: Uint8Array.from([1]) }));
    }
  });

  test("a late inflight acknowledgement cannot flush the reserved uncertainty after the original deadline", async () => {
    const config = configuration("bridge", undefined, "exec", 100);
    const input = bytes([wire(config.nonce, 0, "exec", first("exec"))], true);
    const writes: Uint8Array[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = create(
      config,
      input,
      new WritableStream({
        async write(value) {
          writes.push(Uint8Array.from(value));
          if (writes.length === 2) await waiting;
        },
      }),
    );
    await session.receive();
    await session.send({ kind: "response", operation: "exec" });
    const offered = session.send({ kind: "stdout", bytes: Uint8Array.from([1]) });
    await Bun.sleep(5);
    const terminal = session.send({ kind: "uncertain", error: "host-bridge-uncertain" });
    await refused(offered);
    await refused(terminal);
    expect(writes.length).toBe(2);
    release?.();
    await Bun.sleep(10);
    expect(writes.map((value) => value[4])).toEqual([4, 7]);
    await refused(session.send({ kind: "uncertain", error: "host-bridge-uncertain" }));
  });

  test("constructor captures each exact stream capability once before single-use bookkeeping", () => {
    const priorInput = bytes([], true);
    const priorOutput = sink().output;
    create(configuration("client"), priorInput, priorOutput).abort();
    const input = bytes([], true);
    const output = sink().output;
    let inputReads = 0;
    let outputReads = 0;
    const session = createHostFrameSession(configuration("client"), {
      get input() {
        return ++inputReads <= 4 ? input : priorInput;
      },
      get output() {
        return ++outputReads <= 4 ? output : priorOutput;
      },
      now: () => instant,
    });
    sessions.push(session);
    expect(inputReads).toBe(1);
    expect(outputReads).toBe(1);
    session.abort();
    expect(() => create(configuration("client"), input, sink().output)).toThrow(fixed);
    expect(() => create(configuration("client"), bytes([], true), output)).toThrow(fixed);
  });

  test("receiving a result waits for the original request close acknowledgement and rejects private diagnostic terminal schemas", async () => {
    const config = configuration("client");
    let close: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      close = resolve;
    });
    const input = bytes([
      wire(config.nonce, 0, "response", { kind: "response", operation: "exec" }),
      wire(config.nonce, 1, "result", { kind: "result", code: 0 }),
    ]);
    const client = create(config, input, new WritableStream({ close: () => waiting }));
    await client.send(first("exec"));
    const sentEnd = client.send({ kind: "end" });
    await client.receive();
    let exposed = false;
    const received = client.receive().then((value) => {
      exposed = true;
      return value;
    });
    await Bun.sleep(5);
    expect(exposed).toBe(false);
    close?.();
    await sentEnd;
    expect(await received).toEqual({ kind: "result", code: 0 });
    client.finish();
    for (const terminal of [
      { kind: "result", code: 255 },
      { kind: "result", code: 0, signal: "SIGTERM" },
      { kind: "uncertain", error: "invented private process diagnostic" },
      { kind: "uncertain", error: "host-bridge-uncertain", message: "invented private path" },
    ]) {
      const own = configuration("client");
      const session = create(
        own,
        bytes([
          wire(own.nonce, 0, "response", { kind: "response", operation: "exec" }),
          wire(own.nonce, 1, terminal.kind === "result" ? "result" : "uncertain", terminal),
        ]),
      );
      await session.send(first("exec"));
      await session.send({ kind: "end" });
      await session.receive();
      await refused(session.receive());
    }
  });

  test("frozen/backward wall clocks and the first clock call cannot renew the initial physical deadline", async () => {
    const config = configuration("client", undefined, "exec", 25);
    let wall = instant;
    const stalled = create(
      config,
      bytes([], true),
      new WritableStream({
        write: () => new Promise<void>(() => {}),
        abort: () => new Promise<void>(() => {}),
      }),
      () => wall,
    );
    const start = performance.now();
    await refused(stalled.send(first("exec")));
    expect(performance.now() - start).toBeLessThan(1000);
    await refused(stalled.send(first("exec")));
    const backward = create(configuration("client"), bytes([], true), sink().output, () => wall);
    await backward.send(first("exec"));
    wall--;
    await refused(backward.send({ kind: "end" }));
    expect(() =>
      createHostFrameSession(configuration("client", undefined, "exec", 5), {
        input: bytes([], true),
        output: sink().output,
        now: () => {
          const end = performance.now() + 10;
          while (performance.now() < end) {
            /* Deliberately slow trusted test clock. */
          }
          return instant;
        },
      }),
    ).toThrow(fixed);
  });

  test("source/sink/close/cancel/abort failures preserve one fixed failure and never permit channel reuse", async () => {
    const input = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("invented private cancel diagnostic");
      },
    });
    const output = new WritableStream<Uint8Array>({
      write() {
        throw new Error("invented private write diagnostic");
      },
      abort() {
        throw new Error("invented private abort diagnostic");
      },
    });
    const config = configuration("client");
    const session = create(config, input, output);
    await refused(session.send(first("exec")));
    expect(() =>
      create({ ...config, nonce: randomBytes(16).toString("hex") }, input, output),
    ).toThrow(fixed);
    const closing = create(
      configuration("client"),
      bytes([], true),
      new WritableStream({
        close() {
          throw new Error("invented private close diagnostic");
        },
      }),
    );
    await closing.send(first("exec"));
    await refused(closing.send({ kind: "end" }));
    const failing = create(
      configuration("bridge"),
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("invented private source diagnostic"));
        },
      }),
    );
    await refused(failing.receive());
    const once = create(configuration("bridge"));
    const reading = once.receive();
    await refused(once.receive());
    await refused(reading);
  });

  test("a blocked read abandons unacknowledged cancellation and success also consumes both stream objects permanently", async () => {
    const input = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
    const output = new WritableStream<Uint8Array>({ abort: () => new Promise<void>(() => {}) });
    const session = create(configuration("bridge", undefined, "exec", 20), input, output);
    const started = performance.now();
    await refused(session.receive());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => create(configuration("bridge"), input, sink().output)).toThrow(fixed);
    expect(() => create(configuration("bridge"), bytes([], true), output)).toThrow(fixed);
    const config = configuration("client");
    const response = bytes([
      wire(config.nonce, 0, "response", { kind: "response", operation: "exec" }),
      wire(config.nonce, 1, "result", { kind: "result", code: 0 }),
    ]);
    const sinkOutput = sink().output;
    const completed = create(config, response, sinkOutput);
    await completed.send(first("exec"));
    await completed.send({ kind: "end" });
    await completed.receive();
    await completed.receive();
    completed.finish();
    expect(() => create(configuration("client"), response, sinkOutput)).toThrow(fixed);
  });
});
