/** Native lifecycle regressions use the actual private implementation in an isolated realm.
 * They create no image/host authority and make no Docker or network requests. The separately
 * approved local rehearsal covers the complete pinned public software and paused child.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
  registerImage(value: object): void;
}
function harness(
  clock: () => unknown,
  spawn: (...args: unknown[]) => unknown = () => {
    throw new Error("unexpected-native-offer");
  },
  killed: () => void = () => {},
  allocation?: { create(): string; chmod(path: string): void },
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
    source.slice(source.indexOf("export async function stopOwnedHostController("))
  ).replaceAll("export ", "");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(definitions);
  const children = new WeakMap();
  const images = new WeakMap();
  return runInNewContext(
    `${code}\n({Window,entry,method,engine,receive,stopOwnedHostController,removeOwned,removePrivatePhaseTree,buildOwnedHostController,prepareOwnedHostController,register:(cap,state)=>children.set(cap,state),registerImage:cap=>images.set(cap,{})})`,
    {
      activeHook: undefined,
      children,
      images,
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
      controllerBytes(value: unknown) {
        if (!(value instanceof Uint8Array)) throw new Error("host-controller-failed");
        return Buffer.from(value);
      },
      controllerJson: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
      executable: "/invented/native-engine",
      socket: "unix:///invented/socket",
      environment: () => ({}),
      join,
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

describe("owned local host controller", () => {
  test("exports only build/prepare/inspect/stop and copied capabilities cannot inspect phase inputs", async () => {
    expect(Object.keys(controller).sort()).toEqual([
      "buildOwnedHostController",
      "inspectOwnedHostController",
      "prepareOwnedHostController",
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
    expect(getters).toBe(0);
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
