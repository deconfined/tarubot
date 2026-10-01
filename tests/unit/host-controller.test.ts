/** Native lifecycle regressions use the actual private implementation in an isolated realm.
 * They create no image/host authority and make no Docker or network requests. The separately
 * approved local rehearsal covers the complete pinned public software and paused child.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import * as controller from "../../scripts/host-controller.js";
import { controllerBytes } from "../../scripts/host-controller-closure.js";

interface NativeWindow {
  check(): void;
  capture<T>(work: () => T): T;
  remaining(): number;
  wait<T>(task: Promise<T>): Promise<T>;
  watch(stop: () => void): () => void;
  stop(): void;
}
interface Harness {
  Window: new (milliseconds: number, refusal?: () => unknown) => NativeWindow;
  entry(): void;
  method(child: unknown, surface: string, key: string, args: unknown[], window: NativeWindow): void;
  engine(directory: string, args: string[], window: NativeWindow): Promise<unknown>;
  receive(child: unknown, window: NativeWindow, accepted?: () => void): Promise<unknown>;
  stopOwnedHostController(value: object): Promise<void>;
  register(value: object, state: object): void;
  removeOwned(directory: string, kind: string, name: string): Promise<boolean>;
  removePrivatePhaseTree(
    directory: string,
    ownership: readonly { path: string; dev: number; ino: number }[],
  ): void;
  buildOwnedHostController(input: unknown): Promise<unknown>;
  prepareOwnedHostController(artifact: object, input: unknown): Promise<unknown>;
  registerImage(value: object, state?: object): void;
  disposeOwnedHostControllerArtifact(value: object): Promise<void>;
  childDisposer(
    child: object,
    state: object,
    image: object,
    window: NativeWindow,
  ): () => Promise<void>;
  receiveWithheldRequest(
    child: object,
    window: NativeWindow,
  ): Promise<{ value: { header: Record<string, unknown>; request: Buffer; input: Buffer } }>;
  registerExchange(value: object, state: object): void;
  assertOwnedControllerExchange(value: object, context: object): void;
  fenceOwnedControllerExchange(value: object): void;
  nativeGrantAssertion(value: object, state: object, grant: object, consume: boolean): void;
  deliverOwnedControllerDenial(value: object, grant: object): Promise<void>;
}
function harness(
  clock: () => unknown,
  spawn: (...args: unknown[]) => unknown = () => {
    throw new Error("unexpected-native-offer");
  },
  killed: () => void = () => {},
  allocation?: { create(): string; chmod(path: string): void },
  grantHook?: (assert: () => void) => void,
): Harness {
  const source = readFileSync(new URL("../../scripts/host-controller.ts", import.meta.url), "utf8");
  const part = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
  // Extract definitions, not mirrored timing logic. No production constructor/issuer seam
  // is added; the VM can only exercise private windows and invented native-shaped children.
  const definitions = (
    part("function entry(", "function plain(") +
    part("function boxed<", "function tar(") +
    part("function kill(", "async function removeOwned(") +
    part("async function removeOwned(", "/** The public input is verified software bytes") +
    part("function encodeFrame(", "function fixedMounts(") +
    part("async function cleanup(", "export function inspectOwnedHostController(") +
    part("function privateRoot(", "function ownedRead(") +
    part("export async function buildOwnedHostController(", "function materializePhase(") +
    part("export async function prepareOwnedHostController(", "async function cleanup(") +
    part(
      "export async function disposeOwnedHostControllerArtifact(",
      "export async function stopOwnedHostController(",
    ) +
    source.slice(source.indexOf("export async function stopOwnedHostController("))
  ).replaceAll("export ", "");
  const childDisposer = part(
    "  const dispose = (): Promise<void> => {",
    "  image.preparations.set(window, dispose);",
  );
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `${definitions}\nfunction childDisposer(child,state,image,window){let disposal,directory;const launchOffered=false,ownership=[];${childDisposer}return dispose;}`,
  );
  const children = new WeakMap();
  const images = new WeakMap();
  const exchanges = new WeakMap();
  let result: Harness;
  result = runInNewContext(
    `${code}\n({Window,entry,method,engine,receive,stopOwnedHostController,disposeOwnedHostControllerArtifact,childDisposer,removeOwned,removePrivatePhaseTree,buildOwnedHostController,prepareOwnedHostController,receiveWithheldRequest,assertOwnedControllerExchange,fenceOwnedControllerExchange,nativeGrantAssertion,deliverOwnedControllerDenial,register:(cap,state)=>children.set(cap,state),registerImage:(cap,state={})=>images.set(cap,Object.assign({preparations:new Map(),disposed:false},state)),registerExchange:(cap,state)=>exchanges.set(cap,state)})`,
    {
      activeHook: undefined,
      children,
      images,
      exchanges,
      nativeExchangeAssertion: undefined,
      failure: "host-controller-failed",
      nativeWall: clock,
      nativePhysical: () => performance.now(),
      nativeSpawn: spawn,
      nativeKill: killed,
      nativeOn: EventEmitter.prototype.on,
      nativeThen: Promise.prototype.then,
      drain(value: unknown) {
        try {
          void Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]);
        } catch {
          /* No then getter. */
        }
      },
      valid(value: unknown) {
        if (!value) throw new Error("host-controller-failed");
      },
      // Use the actual intrinsic copy and maximum. Ignoring the maximum here would
      // hide legitimate native coalescing refusals in the production frame parser.
      controllerBytes,
      controllerJson: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
      controllerDigest: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
      assertProtectedHostExecutionContextData: () => {},
      assertDeniedHostExecutionPreparation: () => {},
      fenceProtectedHostExecutionContext: () => {},
      fenceDeniedHostExecutionPreparation: () => {},
      assertDeniedHostExecutionGrant: (_grant: object, cap: object, context: object) => {
        const assert = () => result.assertOwnedControllerExchange(cap, context);
        if (grantHook) grantHook(assert);
        else assert();
      },
      consumeDeniedHostExecutionGrant: (_grant: object, cap: object, context: object) => {
        const assert = () => result.assertOwnedControllerExchange(cap, context);
        if (grantHook) grantHook(assert);
        else assert();
      },
      executable: "/invented/native-engine",
      socket: "unix:///invented/socket",
      environment: () => ({}),
      join,
      resolve: (path: string) => path,
      mkdirSync: () => {},
      mkdtempSync: allocation?.create,
      chmodSync: allocation?.chmod,
      tmpdir: () => "/invented/private-parent",
      randomBytes: (size: number) => Buffer.alloc(size),
      publicBytes: () => {
        throw new Error("invalid-invented-software");
      },
      phase: () => {
        throw new Error("invalid-invented-phase");
      },
      openSync,
      fstatSync,
      fchmodSync,
      closeSync,
      constants,
      rmSync,
      Buffer,
      Promise,
      Reflect,
      Object,
      Number,
      Math,
      Set,
      Error,
      setTimeout,
      clearTimeout,
    },
  ) as Harness;
  return result;
}
function spin(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    /* Real physical cost. */
  }
}
function inventedChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end(): void };
} {
  const child = new EventEmitter();
  return Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end() {} }),
  });
}
function protocolFrame(value: object): Buffer {
  const raw = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(8);
  header.write("HCP1");
  header.writeUInt32BE(raw.length, 4);
  return Buffer.concat([header, raw]);
}
function requestFrames(nonce: string, input = Buffer.from("invented-input")): Buffer[] {
  const request = Buffer.from(
    JSON.stringify({ kind: "exec", command: ["/bin/sh", "-c", "printf invented"] }),
  );
  return [
    protocolFrame({
      schema: 1,
      kind: "exchange",
      nonce,
      worker: 2,
      sequence: 0,
      operation: "exec",
      request_b64: request.toString("base64"),
      request_sha256: createHash("sha256").update(request).digest("hex"),
      input_size: input.length,
      input_sha256: createHash("sha256").update(input).digest("hex"),
    }),
    ...Array.from({ length: Math.ceil(input.length / 12288) }, (_, sequence) =>
      protocolFrame({
        schema: 1,
        kind: "input",
        nonce,
        sequence,
        data: input.subarray(sequence * 12288, (sequence + 1) * 12288).toString("base64"),
      }),
    ),
    protocolFrame({
      schema: 1,
      kind: "exchange-end",
      nonce,
      chunks: Math.ceil(input.length / 12288),
    }),
  ];
}

describe("owned local host controller", () => {
  test("complete coalesced native request frames retain bytes privately and reserve withholding", async () => {
    const h = harness(() => 1_000),
      window = new h.Window(500),
      child = inventedChild();
    const state = { process: child, phase: "capturing", nonce: "a".repeat(64) };
    const pending = h.receiveWithheldRequest(state, window);
    child.stdout.emit("data", Buffer.concat(requestFrames(state.nonce)));
    const captured = await pending;
    expect(state.phase).toBe("withheld");
    expect(captured.value.input.toString()).toBe("invented-input");
    expect(captured.value.header.worker).toBe(2);
    expect(captured.value.request.toString()).toContain("printf invented");
  });

  test("native callback coalescing and arbitrary splits preserve one complete bounded body", async () => {
    const input = Buffer.alloc(163963, 65);
    for (const widths of [[Number.MAX_SAFE_INTEGER], [3, 65536], [1, 7, 65536, 13, 90000]]) {
      const h = harness(() => 1_000),
        // This positive byte-copy fixture has a generous local harness margin. It does
        // not alter the production grant's original thirty-second authority window.
        window = new h.Window(2_000),
        child = inventedChild(),
        state = { process: child, phase: "capturing", nonce: "a".repeat(64) },
        wire = Buffer.concat(requestFrames(state.nonce, input));
      expect(wire.length).toBeGreaterThan(65536);
      const pending = h.receiveWithheldRequest(state, window);
      let at = 0,
        callback = 0;
      while (at < wire.length) {
        const end = Math.min(wire.length, at + (widths[callback++ % widths.length] ?? 1));
        child.stdout.emit("data", wire.subarray(at, end));
        at = end;
      }
      const captured = await pending;
      expect(state.phase).toBe("withheld");
      expect(captured.value.input.equals(input)).toBe(true);
      expect(captured.value.header.input_size).toBe(input.length);
      expect(captured.value.header.worker).toBe(2);
    }
  });

  test("coalesced trailing data and original wire or frame overflow never yield an exchange", async () => {
    for (const fault of ["trailing", "wire", "frame"]) {
      const h = harness(() => 1_000),
        window = new h.Window(2_000),
        child = inventedChild(),
        state = { process: child, phase: "capturing", nonce: "a".repeat(64) };
      const pending = h.receiveWithheldRequest(state, window);
      let wire: Buffer;
      if (fault === "trailing")
        wire = Buffer.concat([
          ...requestFrames(state.nonce, Buffer.alloc(163963, 65)),
          Buffer.from([1]),
        ]);
      else if (fault === "wire") wire = Buffer.alloc(12 * 1024 * 1024 + 1);
      else {
        wire = Buffer.alloc(8);
        wire.write("HCP1");
        wire.writeUInt32BE(32769, 4);
      }
      child.stdout.emit("data", wire);
      await expect(pending).rejects.toThrow("host-controller-failed");
      expect(state.phase).toBe("capturing");
      expect(() => window.check()).toThrow("host-controller-failed");
    }
  });

  test("coalesced native parsing retains original reentry and late-callback refusal", async () => {
    for (const fault of ["reentry", "late"]) {
      let wall = 1_000,
        parsing = false,
        clocks = 0,
        nested = 0;
      const h = harness(() => {
          clocks++;
          if (parsing) {
            parsing = false;
            if (fault === "late") wall += 501;
            else {
              nested++;
              try {
                h.entry();
              } catch {
                /* Swallowing this nested public refusal must still fence the parser. */
              }
            }
          }
          return wall;
        }),
        window = new h.Window(500),
        child = inventedChild(),
        state = { process: child, phase: "capturing", nonce: "a".repeat(64) },
        wire = Buffer.concat(requestFrames(state.nonce, Buffer.alloc(163963, 65))),
        pending = h.receiveWithheldRequest(state, window);
      parsing = true;
      child.stdout.emit("data", wire);
      await expect(pending).rejects.toThrow("host-controller-failed");
      expect(state.phase).toBe("capturing");
      expect(nested).toBe(fault === "reentry" ? 1 : 0);
      const prior = clocks;
      child.stdout.emit("data", wire);
      expect(clocks).toBe(prior);
    }
  });

  test("partial, duplicate, wrong-nonce and mismatched native bodies never yield an exchange", async () => {
    for (const fault of ["partial", "duplicate", "nonce", "digest"]) {
      const h = harness(() => 1_000),
        window = new h.Window(300),
        child = inventedChild();
      const state = { process: child, phase: "capturing", nonce: "b".repeat(64) };
      const pending = h.receiveWithheldRequest(state, window);
      const frames = requestFrames(fault === "nonce" ? "c".repeat(64) : state.nonce);
      const first = frames[0],
        input = frames[1],
        end = frames[2];
      if (!first || !input || !end) throw new Error("invalid-invented-frames");
      if (fault === "partial") {
        child.stdout.emit("data", Buffer.concat(frames.slice(0, 2)));
        child.stdout.emit("end");
      } else if (fault === "duplicate")
        child.stdout.emit("data", Buffer.concat([first, input, input, end]));
      else if (fault === "digest") {
        const data = JSON.parse(first.subarray(8).toString());
        data.input_sha256 = "0".repeat(64);
        frames[0] = protocolFrame(data);
        child.stdout.emit("data", Buffer.concat(frames));
      } else child.stdout.emit("data", Buffer.concat(frames));
      await expect(pending).rejects.toThrow("host-controller-failed");
      expect(state.phase).toBe("capturing");
      expect(() => window.check()).toThrow("host-controller-failed");
    }
  });

  test("one native assertion permit allows genuine composition and permanently refuses a caught duplicate", () => {
    for (const duplicate of [false, true]) {
      const h = harness(
        () => 1_000,
        undefined,
        undefined,
        undefined,
        (assert) => {
          assert();
          if (duplicate) {
            try {
              assert();
            } catch {
              /* Swallowed refusal must still fence. */
            }
          }
        },
      );
      const window = new h.Window(500),
        context = {},
        cap = {};
      const state = { window, context, phase: "delivering", child: { window, stopped: false } };
      h.registerExchange(cap, state);
      let offers = 0;
      const invoke = () =>
        window.capture(() => {
          h.nativeGrantAssertion(cap, state, {}, false);
          window.check();
          offers++;
        });
      if (duplicate) {
        expect(invoke).toThrow("host-controller-failed");
        expect(offers).toBe(0);
      } else {
        invoke();
        expect(offers).toBe(1);
      }
    }
  });

  test("wrong or copied assertions caught in the native grant hook cannot borrow its permit", () => {
    let h: Harness,
      conflicting = false;
    h = harness(() => {
      if (conflicting) {
        conflicting = false;
        try {
          h.assertOwnedControllerExchange({}, {});
        } catch {
          /* Never restores the original. */
        }
      }
      return 1_000;
    });
    const window = new h.Window(500),
      context = {},
      cap = {};
    const state = { window, context, phase: "delivering", child: { window, stopped: false } };
    h.registerExchange(cap, state);
    let offers = 0;
    expect(() =>
      window.capture(() => {
        conflicting = true;
        h.nativeGrantAssertion(cap, state, {}, false);
        offers++;
      }),
    ).toThrow("host-controller-failed");
    expect(offers).toBe(0);
  });

  test("a copied exchange fence caught inside an original native clock permanently denies later offers", () => {
    let trigger = false,
      offers = 0,
      h: Harness;
    h = harness(() => {
      if (trigger) {
        trigger = false;
        try {
          h.fenceOwnedControllerExchange({});
        } catch {
          /* Refusal cannot restore the original. */
        }
      }
      return 1_000;
    });
    const window = new h.Window(500);
    expect(() =>
      window.capture(() => {
        trigger = true;
        window.check();
        offers++;
      }),
    ).toThrow("host-controller-failed");
    expect(offers).toBe(0);
    expect(() => window.check()).toThrow("host-controller-failed");
  });

  test("the fixed denial consumer offers one digest-bound frame and retires its original exchange", async () => {
    const h = harness(() => 1_000),
      window = new h.Window(500),
      dataWindow = new h.Window(1_000);
    const process = inventedChild(),
      context = {},
      cap = {},
      nonce = "d".repeat(64);
    let offers = 0,
      disposed = 0;
    const binding = {
      controller_nonce: nonce,
      worker_sequence: 3,
      request_sha256: "e".repeat(64),
      input_sha256: "f".repeat(64),
    };
    const child = {
      window: dataWindow,
      process,
      nonce,
      phase: "withheld",
      stopped: false,
      stoppedPromise: Promise.resolve(),
      dispose: async () => {
        disposed++;
      },
    };
    const state = { window, context, child, phase: "withheld", binding };
    h.registerExchange(cap, state);
    Object.assign(process.stdin, {
      write(raw: Buffer) {
        offers++;
        expect(JSON.parse(raw.subarray(8).toString())).toEqual({
          schema: 1,
          kind: "deny",
          nonce,
          worker: 3,
          sequence: 0,
          request_sha256: binding.request_sha256,
          input_sha256: binding.input_sha256,
        });
        queueMicrotask(() =>
          process.stdout.emit(
            "data",
            protocolFrame({ schema: 1, kind: "denied", nonce, worker: 3, sequence: 0 }),
          ),
        );
      },
    });
    await h.deliverOwnedControllerDenial(cap, {});
    expect(offers).toBe(1);
    expect(disposed).toBe(1);
    expect(state.phase).toBe("denied");
    await expect(h.deliverOwnedControllerDenial(cap, {})).rejects.toThrow("host-controller-failed");
    expect(offers).toBe(1);
  });

  test("a late denial write getter cannot offer after the original proof/window expires", async () => {
    let wall = 1_000;
    const h = harness(() => wall),
      window = new h.Window(200),
      dataWindow = new h.Window(1_000);
    const process = inventedChild(),
      context = {},
      cap = {},
      nonce = "a".repeat(64);
    let offers = 0;
    const child = {
      window: dataWindow,
      process,
      nonce,
      phase: "withheld",
      stopped: false,
      stoppedPromise: Promise.resolve(),
      dispose: async () => {},
    };
    h.registerExchange(cap, {
      window,
      context,
      child,
      phase: "withheld",
      binding: {
        controller_nonce: nonce,
        worker_sequence: 2,
        request_sha256: "b".repeat(64),
        input_sha256: "c".repeat(64),
      },
    });
    Object.defineProperty(process.stdin, "write", {
      get() {
        wall += 200;
        return () => {
          offers++;
        };
      },
    });
    await expect(h.deliverOwnedControllerDenial(cap, {})).rejects.toThrow("host-controller-failed");
    expect(offers).toBe(0);
    expect(() => window.check()).toThrow("host-controller-failed");
  });

  test("abandoned incomplete request timers fence before any later native frame callback", async () => {
    let clocks = 0;
    const h = harness(() => {
        clocks++;
        return 1_000;
      }),
      window = new h.Window(30),
      process = inventedChild();
    const child = { process, phase: "capturing", nonce: "a".repeat(64) };
    const pending = h.receiveWithheldRequest(child, window);
    process.stdout.emit("data", requestFrames(child.nonce)[0]);
    await expect(pending).rejects.toThrow("host-controller-failed");
    const prior = clocks;
    process.stdout.emit("data", Buffer.concat(requestFrames(child.nonce)));
    expect(clocks).toBe(prior);
    expect(child.phase).toBe("capturing");
  });

  test("data-only lifecycle and origin-gated denial bridges never accept copied capabilities", async () => {
    expect(Object.keys(controller).sort()).toEqual([
      "assertOwnedControllerExchange",
      "buildOwnedHostController",
      "deliverOwnedControllerDenial",
      "disposeOwnedHostControllerArtifact",
      "fenceOwnedControllerExchange",
      "inspectOwnedHostController",
      "ownedControllerExchangeBinding",
      "prepareOwnedHostController",
      "releaseOwnedControllerToDenial",
      "remainingOwnedControllerExchange",
      "stopOwnedHostController",
    ]);
    let getters = 0;
    const copied = Object.freeze(Object.create(null));
    const input = Object.defineProperty({}, "declaration", {
      get() {
        getters++;
        throw new Error("invented-private");
      },
    });
    await expect(
      controller.prepareOwnedHostController(copied, input as controller.HostControllerPhaseInput),
    ).rejects.toThrow("host-controller-failed");
    expect(() => controller.inspectOwnedHostController(copied)).toThrow("host-controller-failed");
    await expect(controller.stopOwnedHostController(copied)).rejects.toThrow(
      "host-controller-failed",
    );
    await expect(controller.disposeOwnedHostControllerArtifact(copied)).rejects.toThrow(
      "host-controller-failed",
    );
    await expect(
      controller.releaseOwnedControllerToDenial(
        copied,
        Object.freeze({}) as never,
        Object.freeze({}) as never,
      ),
    ).rejects.toThrow("host-controller-failed");
    expect(getters).toBe(0);
  });

  test("actual kernel credentials reject a fork descendant's inherited socket and close foreign rights", () => {
    // Execute the actual measured helper definitions against only new owned local sockets,
    // processes and pidfds. This is a kernel counterprobe, never controller/job authority.
    const script = `
import ast,array,json,os,selectors,signal,socket,struct,time
from pathlib import Path
source=Path(${JSON.stringify(new URL("../../ops/host-controller/launcher.py", import.meta.url).pathname)}).read_text()
tree=ast.parse(source)
names={'require','pairs','literal_json','Window','live_pidfd','peer_read'}
selected=ast.Module(body=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names],type_ignores=[])
FAILURE='host-controller-launch-failed'
exec(compile(selected,'owned-helper-counterprobe','exec'))
def pair(rights=False):
 parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
 parent.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
 child=os.fork()
 if child==0:
  parent.close()
  if rights:
   fd=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC)
   worker.sendmsg([b'NOPE'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]*8))])
   os.close(fd)
  else:
   worker.sendall(b'GOOD')
   descendant=os.fork()
   if descendant==0:
    worker.sendall(b'BAD!');os._exit(0)
   os.waitpid(descendant,0)
   worker.sendall(b'DONE')
  time.sleep(3);os._exit(0)
 worker.close()
 pidfd=os.pidfd_open(child,0)
 try:
  window=Window(2)
  if not rights:require(peer_read(parent,4,pidfd,child,window)==b'GOOD')
  before=len(os.listdir('/proc/self/fd'))
  try:peer_read(parent,4,pidfd,child,window)
  except RuntimeError as error:require(str(error)==FAILURE)
  else:require(False)
  require(len(os.listdir('/proc/self/fd'))==before)
  if not rights:require(peer_read(parent,4,pidfd,child,window)==b'DONE')
  require(live_pidfd(pidfd)==child)
 finally:
  signal.pidfd_send_signal(pidfd,signal.SIGKILL);os.waitpid(child,0);os.close(pidfd);parent.close()
pair();pair(True)
print(json.dumps({'descendant_refused':True,'foreign_rights_closed':True,'worker_live':True}))
`;
    const result = execFileSync("/usr/bin/python3", ["-I", "-S", "-B", "-c", script], {
      timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(result.toString())).toEqual({
      descendant_refused: true,
      foreign_rights_closed: true,
      worker_live: true,
    });
  });

  test("artifact disposal stops owned preparations before one exact tag removal and coalesces calls", async () => {
    const parent = mkdtempSync(join(tmpdir(), "invented-artifact-disposal-"));
    const offers: string[][] = [];
    let stopped = false,
      childDisposed = false,
      directory: string | undefined;
    try {
      const h = harness(
        () => 1_000,
        (...args: unknown[]) => {
          expect(stopped && childDisposed).toBe(true);
          const argv = args[1] as string[];
          offers.push(argv.slice(4));
          const child = inventedChild();
          child.stdin.end = () => child.emit("close", 0);
          return child;
        },
        undefined,
        {
          create() {
            const path = mkdtempSync(join(parent, "owned-"));
            directory = path;
            return path;
          },
          chmod(path) {
            chmodSync(path, 0o700);
          },
        },
      );
      const window = new h.Window(500),
        cap = {},
        tag = "docker.io/library/tarubot-controller:invented-owned";
      window.watch(() => {
        stopped = true;
      });
      const preparations = new Map([
        [
          window,
          async () => {
            childDisposed = true;
          },
        ],
      ]);
      h.registerImage(cap, { preparations, tag });
      await Promise.all([
        h.disposeOwnedHostControllerArtifact(cap),
        h.disposeOwnedHostControllerArtifact(cap),
      ]);
      expect(offers).toEqual([["image", "rm", tag]]);
      expect(directory).toBeDefined();
      expect(existsSync(directory ?? parent)).toBe(false);
      await expect(h.prepareOwnedHostController(cap, {})).rejects.toThrow("host-controller-failed");
      expect(offers.length).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("unknown owned child removal withholds artifact cleanup permanently without selecting another tag", async () => {
    let nativeOffers = 0,
      childDisposals = 0;
    const h = harness(
      () => 1_000,
      () => {
        nativeOffers++;
        throw new Error("foreign-tag-must-not-be-selected");
      },
    );
    const window = new h.Window(500),
      cap = {};
    h.registerImage(cap, {
      tag: "docker.io/library/tarubot-controller:invented-owned",
      preparations: new Map([
        [
          window,
          async () => {
            childDisposals++;
            throw new Error("invented-unknown-child-ack");
          },
        ],
      ]),
    });
    const first = h.disposeOwnedHostControllerArtifact(cap);
    void first.catch(() => {});
    await expect(first).rejects.toThrow("host-controller-failed");
    await expect(h.disposeOwnedHostControllerArtifact(cap)).rejects.toThrow(
      "host-controller-failed",
    );
    await expect(h.prepareOwnedHostController(cap, {})).rejects.toThrow("host-controller-failed");
    expect(childDisposals).toBe(1);
    expect(nativeOffers).toBe(0);
  });

  test("artifact disposal reserves its shared Promise before synchronous accepted-child stop callbacks", async () => {
    const parent = mkdtempSync(join(tmpdir(), "invented-disposal-reservation-"));
    let offers = 0,
      disposals = 0;
    let nested: Promise<void> | undefined;
    try {
      const h = harness(
        () => 1_000,
        () => {
          offers++;
          const child = inventedChild();
          child.stdin.end = () => child.emit("close", 0);
          return child;
        },
        undefined,
        {
          create: () => mkdtempSync(join(parent, "owned-")),
          chmod: (path) => chmodSync(path, 0o700),
        },
      );
      const window = new h.Window(500),
        cap = {};
      // An accepted native child may emit a synchronous stop notification. It can join
      // the original disposal but cannot run a second body or replace its reservation.
      window.watch(() => {
        nested = h.disposeOwnedHostControllerArtifact(cap);
        void nested.catch(() => {});
      });
      h.registerImage(cap, {
        tag: "docker.io/library/tarubot-controller:invented-owned",
        preparations: new Map([
          [
            window,
            async () => {
              disposals++;
            },
          ],
        ]),
      });
      await h.disposeOwnedHostControllerArtifact(cap);
      expect(nested).toBeDefined();
      await nested;
      expect(disposals).toBe(1);
      expect(offers).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the actual prepared-child disposer reserves once before a synchronous captured kill callback", async () => {
    let dispose: (() => Promise<void>) | undefined, nested: Promise<void> | undefined;
    let kills = 0,
      deletes = 0;
    const h = harness(
      () => 1_000,
      undefined,
      () => {
        kills++;
        if (kills === 1) {
          nested = dispose?.();
          void nested?.catch(() => {});
        }
      },
    );
    const window = new h.Window(500);
    const state = { window, stopped: false, phase: "paused", unwatch() {} };
    // This factory only extracts the actual private disposal closure. It creates no
    // controller capability and exposes no production constructor/transport seam.
    dispose = h.childDisposer(
      inventedChild(),
      state,
      {
        preparations: {
          delete() {
            deletes++;
          },
        },
      },
      window,
    );
    await dispose();
    expect(nested).toBeDefined();
    await nested;
    await dispose();
    expect(kills).toBe(1);
    expect(deletes).toBe(2);
    expect(state.stopped).toBe(true);
  });

  test("retained native worker origins refuse queued registration or another allocation while input is withheld", () => {
    // Real pidfds and private Unix sockets exercise the measured retained-origin guard.
    // The invented forked children carry no measured WorkerProcess or grant authority.
    const script = `
import ast,json,os,selectors,signal,socket,time
from pathlib import Path
source=Path(${JSON.stringify(new URL("../../ops/host-controller/launcher.py", import.meta.url).pathname)}).read_text()
tree=ast.parse(source)
names={'require','live_pidfd','retained_request_origin'}
selected=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
FAILURE='host-controller-launch-failed'
exec(compile(selected,'owned-held-origin-counterprobe','exec'))
pid=os.fork()
if pid==0:time.sleep(3);os._exit(0)
worker=os.pidfd_open(pid,0);driver=os.pidfd_open(os.getpid(),0)
broker,registration=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
control,allocation=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
try:
 retained_request_origin(control,broker,driver,worker,pid)
 for sender,receiver in ((registration,broker),(allocation,control)):
  sender.send(b'queued')
  try:retained_request_origin(control,broker,driver,worker,pid)
  except RuntimeError as error:require(str(error)==FAILURE)
  else:require(False)
  receiver.recv(64)
 retained_request_origin(control,broker,driver,worker,pid)
 print(json.dumps({'live':True,'extra_registration_refused':True,'extra_allocation_refused':True}))
finally:
 signal.pidfd_send_signal(worker,signal.SIGKILL);os.waitpid(pid,0)
 os.close(worker);os.close(driver)
 for channel in (broker,registration,control,allocation):channel.close()
`;
    const result = execFileSync("/usr/bin/python3", ["-I", "-S", "-B", "-c", script], {
      timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(result.toString())).toEqual({
      live: true,
      extra_registration_refused: true,
      extra_allocation_refused: true,
    });
  });

  test("only exact reviewed bot/accept report tasks select local and delegation always refuses", () => {
    // Native-shaped task data exercises the actual policy helper; WorkerProcess.start
    // separately requires the exact captured measured core class before using this policy.
    const script = `
import ast,json
from pathlib import Path
from types import SimpleNamespace as S
source=Path(${JSON.stringify(new URL("../../ops/host-controller/launcher.py", import.meta.url).pathname)}).read_text()
tree=ast.parse(source)
selected=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'require','guarded_worker_connection'}],type_ignores=[])
FAILURE='host-controller-launch-failed'
exec(compile(selected,'owned-policy-counterprobe','exec'))
def worker(phase,host='target',action='ansible.builtin.copy',delegate=None):
 play=S(name='Write the result on the runner' if phase=='bot' else 'Write only the bound public acceptance evidence',hosts=['localhost'],connection='local')
 task=S(delegate_to=delegate,name='Write the result' if phase=='bot' else 'Write the public release result',action=action,get_play=lambda:play,get_path=lambda:'/phase/release/ops/ansible/'+phase+'.yml:1')
 return S(_host=S(name=host),_task=task,_task_vars={})
for phase in ('site','bot','accept'):require(guarded_worker_connection(worker(phase),phase)=='tarubot_guarded')
for phase in ('bot','accept'):require(guarded_worker_connection(worker(phase,'localhost'),phase)=='local')
bad=[(worker('site','localhost'),'site'),(worker('bot','localhost','ansible.builtin.command'),'bot'),(worker('accept','localhost','ansible.builtin.shell'),'accept'),(worker('bot',delegate='localhost'),'bot')]
delegated=worker('site');delegated._task_vars['ansible_delegated_vars']={'localhost':{}}
bad.append((delegated,'site'))
wrong=worker('bot','localhost');wrong._task.get_path=lambda:'/phase/config/ops/ansible/site.yml:1';bad.append((wrong,'bot'))
for task,phase in bad:
 try:guarded_worker_connection(task,phase)
 except RuntimeError as error:require(str(error)==FAILURE)
 else:require(False)
print(json.dumps({'target_phases':3,'local_reports':2,'refusals':len(bad)}))
`;
    const result = execFileSync("/usr/bin/python3", ["-I", "-S", "-B", "-c", script], {
      timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(result.toString())).toEqual({
      target_phases: 3,
      local_reports: 2,
      refusals: 6,
    });
    expect(readFileSync(new URL("../../ops/ansible/bot.yml", import.meta.url), "utf8")).toContain(
      "- name: Write the result on the runner\n  hosts: localhost\n  connection: local",
    );
    expect(
      readFileSync(new URL("../../ops/ansible/accept.yml", import.meta.url), "utf8"),
    ).toContain(
      "- name: Write only the bound public acceptance evidence\n  hosts: localhost\n  connection: local",
    );
  });

  test("owned hook costs consume the first short wall projection before a later native offer", () => {
    let wall = 1_000;
    const h = harness(() => wall),
      window = new h.Window(200);
    let offers = 0;
    expect(() =>
      window.capture(() => {
        wall += 190;
        spin(30);
        window.check();
        offers++;
      }),
    ).toThrow("host-controller-failed");
    expect(offers).toBe(0);
    expect(() => window.check()).toThrow("host-controller-failed");
  });

  test("last native method getter is captured before the original guard", () => {
    let wall = 1_000,
      offers = 0;
    const h = harness(() => wall),
      window = new h.Window(200);
    const child = {
      stdin: Object.defineProperty({}, "end", {
        get() {
          wall += 200;
          return () => offers++;
        },
      }),
    };
    expect(() => h.method(child, "stdin", "end", [], window)).toThrow("host-controller-failed");
    expect(offers).toBe(0);
  });

  test("caught nested entry from a native clock permanently fences the original window", () => {
    let active = false;
    let h: Harness;
    h = harness(() => {
      if (active) {
        try {
          h.entry();
        } catch {
          /* Swallowed hostile nested denial. */
        }
      }
      return 1_000;
    });
    const window = new h.Window(500);
    active = true;
    expect(() => window.check()).toThrow("host-controller-failed");
    active = false;
    expect(() => window.capture(() => 1)).toThrow("host-controller-failed");
  });

  test("a later short observation rearms held and idle cleanup without renewing the window", async () => {
    let wall = 1_000,
      cleaned = 0;
    const h = harness(() => wall),
      window = new h.Window(500);
    window.watch(() => {
      cleaned++;
    });
    const held = window.wait(new Promise<never>(() => {}));
    const outcome = held.then(
      () => "accepted",
      () => "refused",
    );
    wall += 470;
    window.check();
    expect(
      await Promise.race([
        outcome,
        new Promise((resolve) => setTimeout(() => resolve("late"), 150)),
      ]),
    ).toBe("refused");
    expect(cleaned).toBe(1);
    expect(() => window.remaining()).toThrow("host-controller-failed");
  });

  test("silent accepted native engine children are killed on original timeout", async () => {
    const child = inventedChild();
    let kills = 0;
    const h = harness(
      () => 1_000,
      () => child,
      () => {
        kills++;
      },
    );
    const window = new h.Window(40),
      directory = mkdtempSync(join(tmpdir(), "invented-controller-test-"));
    try {
      await expect(h.engine(directory, ["invented-held"], window)).rejects.toThrow(
        "host-controller-failed",
      );
      expect(kills).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("native stdin error is caught, fences and cleans up the accepted child", async () => {
    const child = inventedChild();
    let kills = 0;
    child.stdin.end = () => {
      child.stdin.emit("error", new Error("invented-private-epipe"));
    };
    const h = harness(
      () => 1_000,
      () => child,
      () => {
        kills++;
      },
    );
    const window = new h.Window(500);
    await expect(h.engine("/invented/private", ["invented"], window)).rejects.toThrow(
      "host-controller-failed",
    );
    expect(kills).toBeGreaterThan(0);
  });

  test("native stdin getter expiry prevents the final end offer and kills the accepted child", async () => {
    const child = inventedChild();
    let wall = 1_000,
      kills = 0,
      ends = 0;
    Object.defineProperty(child.stdin, "end", {
      get() {
        wall += 500;
        return () => {
          ends++;
        };
      },
    });
    const h = harness(
        () => wall,
        () => child,
        () => {
          kills++;
        },
      ),
      window = new h.Window(500);
    await expect(h.engine("/invented/private", ["invented"], window)).rejects.toThrow(
      "host-controller-failed",
    );
    expect(ends).toBe(0);
    expect(kills).toBeGreaterThan(0);
  });

  test("withheld post-spawn resources already own passive stream error sinks", async () => {
    const child = inventedChild();
    let wall = 1_000,
      kills = 0;
    const h = harness(
      () => wall,
      () => {
        wall += 500;
        return child;
      },
      () => {
        kills++;
        child.stdin.emit("error", new Error("invented-close-race"));
      },
    );
    await expect(h.engine("/invented/private", ["invented"], new h.Window(500))).rejects.toThrow(
      "host-controller-failed",
    );
    expect(kills).toBeGreaterThan(0);
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
  });

  test("prepared reply reserves validation before returning to an awaited engine inspection", async () => {
    const child = inventedChild(),
      h = harness(() => 1_000),
      window = new h.Window(500);
    let phase = "preparing";
    child.stdout.on("data", () => {
      if (phase === "validating") window.stop();
    });
    const received = h.receive(child, window, () => {
      phase = "validating";
    });
    const outcome = received.then(
      () => "accepted",
      () => "refused",
    );
    const json = Buffer.from('{"kind":"prepared"}'),
      header = Buffer.alloc(8);
    header.write("HCP1");
    header.writeUInt32BE(json.length, 4);
    child.stdout.emit("data", Buffer.concat([header, json]));
    expect(phase).toBe("validating");
    child.stdout.emit("data", Buffer.from("invented-unsolicited"));
    expect(await outcome).toBe("refused");
    expect(() => window.check()).toThrow("host-controller-failed");
  });

  test("concurrent stops share one native frame and already stopped calls await disposal", async () => {
    const child = inventedChild(),
      h = harness(() => 1_000),
      window = new h.Window(500),
      cap = {};
    let offers = 0,
      completeDisposal: (() => void) | undefined;
    const disposal = new Promise<void>((resolve) => {
      completeDisposal = resolve;
    });
    const state = {
      window,
      process: child,
      nonce: "invented",
      phase: "paused",
      stopped: false,
      stopOperation: undefined,
      stoppedPromise: Promise.resolve(),
      dispose: () => disposal,
    };
    h.register(cap, state);
    Object.assign(child.stdin, {
      write() {
        offers++;
        queueMicrotask(() => {
          const json = Buffer.from('{"schema":1,"kind":"stopped","nonce":"invented"}'),
            header = Buffer.alloc(8);
          header.write("HCP1");
          header.writeUInt32BE(json.length, 4);
          child.stdout.emit("data", Buffer.concat([header, json]));
        });
      },
    });
    const first = h.stopOwnedHostController(cap),
      second = h.stopOwnedHostController(cap);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(offers).toBe(1);
    state.stopped = true;
    let laterSettled = false;
    const third = h.stopOwnedHostController(cap).then(() => {
      laterSettled = true;
    });
    await Promise.resolve();
    expect(laterSettled).toBe(false);
    completeDisposal?.();
    await Promise.all([first, second, third]);
    expect(laterSettled).toBe(true);
    expect(offers).toBe(1);
  });

  test("an already removed owned container is confirmed absent under the same cleanup window", async () => {
    const offers: string[] = [];
    const h = harness(
      () => 1_000,
      (...args: unknown[]) => {
        const argv = args[1] as string[];
        offers.push(argv[5] ?? "unknown");
        const child = inventedChild();
        child.stdin.end = () => {
          child.emit("close", argv[5] === "rm" ? 1 : 0);
        };
        return child;
      },
    );
    expect(await h.removeOwned("/invented/private", "container", "invented-owned")).toBe(true);
    expect(offers).toEqual(["rm", "ls"]);
  });

  test("cleanup restores only retained directory inodes and never follows replacement symlinks", () => {
    const h = harness(() => 1_000),
      directory = mkdtempSync(join(tmpdir(), "invented-controller-tree-"));
    const outside = mkdtempSync(join(tmpdir(), "invented-controller-outside-"));
    const nested = join(directory, "configuration");
    mkdirSync(nested, { mode: 0o700 });
    const info = statSync(nested),
      ownership = [{ path: nested, dev: info.dev, ino: info.ino }];
    writeFileSync(join(nested, "invented"), "inactive", { mode: 0o444 });
    chmodSync(nested, 0o555);
    h.removePrivatePhaseTree(directory, ownership);
    expect(existsSync(directory)).toBe(false);
    // A separately owned target is only a counterprobe fixture, never a cleanup input.
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(nested, { mode: 0o700 });
    const prior = statSync(nested);
    renameSync(nested, join(directory, "retired"));
    symlinkSync(outside, nested);
    chmodSync(outside, 0o555);
    try {
      h.removePrivatePhaseTree(directory, [{ path: nested, dev: prior.dev, ino: prior.ino }]);
      expect(statSync(outside).mode & 0o777).toBe(0o555);
      expect(existsSync(directory)).toBe(false);
    } finally {
      chmodSync(outside, 0o700);
      rmSync(outside, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("build and preparation own real roots before post-capture refusal or chmod failure", async () => {
    const parent = mkdtempSync(join(tmpdir(), "invented-controller-allocation-"));
    try {
      for (const kind of ["build", "prepare"])
        for (const fault of ["post-capture", "chmod"]) {
          let wall = 1_000,
            created: string | undefined,
            engineOffers = 0;
          const h = harness(
            () => wall,
            () => {
              engineOffers++;
              throw new Error("unexpected-engine");
            },
            () => {},
            {
              create() {
                const path = mkdtempSync(join(parent, "owned-"));
                created = path;
                if (fault === "post-capture") wall += (kind === "build" ? 600_000 : 60_000) + 1;
                return path;
              },
              chmod(path) {
                if (fault === "chmod") throw new Error("invented-native-chmod-failure");
                chmodSync(path, 0o700);
              },
            },
          );
          const cap = {};
          h.registerImage(cap);
          await expect(
            kind === "build"
              ? h.buildOwnedHostController({})
              : h.prepareOwnedHostController(cap, {}),
          ).rejects.toThrow("host-controller-failed");
          expect(created).toBeDefined();
          expect(existsSync(created ?? parent)).toBe(false);
          expect(engineOffers).toBe(0);
        }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("post-hook rejection withholding drains native and cross-realm Promises", async () => {
    const unhandled: unknown[] = [];
    const listener = (value: unknown) => {
      unhandled.push(value);
    };
    process.on("unhandledRejection", listener);
    try {
      for (const rejected of [
        () => Promise.reject(new Error("invented-private")),
        () => runInNewContext("Promise.reject(new Error('invented-private'))") as Promise<never>,
      ]) {
        let wall = 1_000;
        const h = harness(() => wall),
          window = new h.Window(200);
        expect(() =>
          window.capture(() => {
            wall += 200;
            return rejected();
          }),
        ).toThrow("host-controller-failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("first and later native clocks drain rejected local/cross-realm Promises without then getters", async () => {
    const unhandled: unknown[] = [];
    const listener = (value: unknown) => {
      unhandled.push(value);
    };
    process.on("unhandledRejection", listener);
    try {
      for (const realm of ["local", "other"])
        for (const first of [true, false]) {
          let rejected = first,
            getterReads = 0;
          const h = harness(() => {
            if (!rejected) return 1_000;
            const promise =
              realm === "local"
                ? Promise.reject(new Error("invented-private-clock"))
                : (runInNewContext(
                    "Promise.reject(new Error('invented-private-clock'))",
                  ) as Promise<never>);
            // biome-ignore lint/suspicious/noThenProperty: hostile accessor proves intrinsic draining never reads it.
            Object.defineProperty(promise, "then", {
              get() {
                getterReads++;
                throw new Error("invented-private-getter");
              },
            });
            return promise;
          });
          if (first) expect(() => new h.Window(500)).toThrow("host-controller-failed");
          else {
            const window = new h.Window(500);
            rejected = true;
            expect(() => window.check()).toThrow("host-controller-failed");
            rejected = false;
            expect(() => window.check()).toThrow("host-controller-failed");
          }
          expect(getterReads).toBe(0);
        }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
