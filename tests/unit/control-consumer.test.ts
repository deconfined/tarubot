/** Owner configuration and ciphertext bytes are invented; no live owner or object store is read. */
import { describe, expect, test } from "bun:test";
import {
  ControlConsumerGuard,
  guardedControlStore,
  type ControlConsumerBoundary,
  type ControlConsumerScope,
  type ControlConsumerTicket,
  type OwnerControlAnchor,
} from "../../scripts/control-consumer.js";
import type { ControlStore } from "../../scripts/infra-control.js";

const revision = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const otherGeneration = "00000000-0000-4000-8000-000000000003";
const instant = 1_800_000_000_000;
function fixture(target: ControlConsumerScope["target"] = "infra") {
  const configuration: ControlConsumerScope = {
    target,
    backend: "a".repeat(64),
    namespace: `tarubot/control/v1/${target === "infra" ? "infra" : `trust-${target}`}/`,
  };
  let now = instant;
  const state = {
    anchor: {
      ...configuration,
      schema: 1,
      revision,
      repair: { mode: "never-repaired" },
      observed_at: instant,
      expires_at: instant + 60_000,
    } as OwnerControlAnchor,
    values: new Map<string, Uint8Array>(),
    reads: [] as string[],
    readGuards: [] as { path: string; refusal: (() => void) | undefined }[],
    writes: [] as string[],
    anchors: 0,
    confirmed: [] as (ControlConsumerScope & { generation: string })[],
    beforeAnchor: async (_count: number) => {},
    beforeConfirm: async () => {},
    beforeRead: async (_path: string) => {},
    beforeWrite: async (_path: string) => {},
  };
  const store: ControlStore = {
    async read(path, refusal) {
      refusal?.();
      state.reads.push(path);
      state.readGuards.push({ path, refusal });
      await state.beforeRead(path);
      refusal?.();
      return state.values.get(path) ?? null;
    },
    async write(path, bytes) {
      state.writes.push(path);
      await state.beforeWrite(path);
      state.values.set(path, Uint8Array.from(bytes));
    },
  };
  const owner: ControlConsumerBoundary = {
    async readOwnerAnchor(request, refusal) {
      refusal?.();
      expect(request).toEqual(configuration);
      state.anchors++;
      await state.beforeAnchor(state.anchors);
      refusal?.();
      return state.anchor;
    },
    async confirmCompletedRepair(request, refusal) {
      refusal?.();
      state.confirmed.push(structuredClone(request));
      await state.beforeConfirm();
      refusal?.();
    },
  };
  const guard = new ControlConsumerGuard(configuration, { store, owner, now: () => now });
  function complete() {
    state.anchor.repair = { mode: "completed-repair", generation };
    state.values.set(`recovery/${target}/registration`, Uint8Array.from([1, 2, 3]));
    state.values.set(`recovery/${target}/current`, Uint8Array.from([4, 5, 6]));
  }
  return {
    configuration,
    state,
    store,
    owner,
    guard,
    complete,
    setTime: (value: number) => {
      now = value;
    },
  };
}

describe("independently owner-anchored normal control consumers", () => {
  test("original native tickets retain their refusal and a replacement fences the old authority", async () => {
    const f = fixture();
    let live = true;
    const original = () => {
      if (!live) throw new Error("private-original-denial");
    };
    const ticket = await f.guard.check(undefined, original);
    const count = f.state.reads.length;
    await expect(f.guard.check(ticket, () => {})).rejects.toThrow("control-consumer-guard-failed");
    await expect(f.guard.check(ticket, original)).rejects.toThrow("control-consumer-guard-failed");
    expect(f.state.reads).toHaveLength(count);
    const second = await f.guard.check(undefined, original);
    live = false;
    await expect(f.guard.check(second)).rejects.toThrow("control-consumer-guard-failed");
    live = true;
    await expect(f.guard.check(second)).rejects.toThrow("control-consumer-guard-failed");
  });
  test("swallowed nested correct or copied-ticket checks fence the original callback phase", async () => {
    for (const copied of [false, true]) {
      const f = fixture();
      let reenter = false;
      let ticket: Awaited<ReturnType<ControlConsumerGuard["check"]>> | undefined;
      const original = () => {
        if (reenter) {
          reenter = false;
          void f.guard
            .check(copied ? ({ ...ticket } as ControlConsumerTicket) : ticket)
            .catch(() => {});
        }
      };
      ticket = await f.guard.check(undefined, original);
      const count = f.state.reads.length;
      reenter = true;
      await expect(f.guard.check(ticket)).rejects.toThrow("control-consumer-guard-failed");
      await expect(f.guard.check(ticket)).rejects.toThrow("control-consumer-guard-failed");
      expect(f.state.reads).toHaveLength(count);
    }
  });
  test("incoming read and write refusals stop owner metadata offers without extending a shorter window", async () => {
    for (const mutation of [false, true]) {
      const f = fixture();
      let live = true;
      f.state.beforeAnchor = async () => {
        live = false;
      };
      const store = guardedControlStore(f.store, f.guard);
      const refusal = () => {
        if (!live) throw new Error("private-short-window");
      };
      await expect(
        mutation
          ? store.write("current", Uint8Array.from([2]), refusal)
          : store.read("current", refusal),
      ).rejects.toThrow(
        mutation ? "control-consumer-write-failed" : "control-consumer-read-failed",
      );
      expect(f.state.anchors).toBe(1);
      expect(f.state.reads).toEqual([]);
      expect(f.state.writes).toEqual([]);
    }
  });
  test("a timed-out read permanently fences its retained native callback across a fresh check", async () => {
    const f = fixture();
    f.state.anchor.expires_at = instant + 80;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeRead = async (path) => {
      if (path === "current") await pending;
    };
    const store = guardedControlStore(f.store, f.guard);
    await expect(store.read("current")).rejects.toThrow("control-consumer-read-failed");
    const old = f.state.readGuards.find((entry) => entry.path === "current")?.refusal;
    expect(typeof old).toBe("function");
    await f.guard.check();
    expect(() => old?.()).toThrow("invalid-control-consumer");
    const count = f.state.reads.length;
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state.reads).toHaveLength(count);
    expect(() => old?.()).toThrow("invalid-control-consumer");
  });
  test("first clock and snapshot phases cannot swallow nested denial or grant Boolean approval", async () => {
    for (const wrong of [false, true]) {
      const f = fixture();
      let guard: ControlConsumerGuard | undefined;
      let nested = true;
      guard = new ControlConsumerGuard(f.configuration, {
        store: f.store,
        owner: f.owner,
        now: () => {
          if (nested) {
            nested = false;
            void guard?.check(wrong ? ({} as ControlConsumerTicket) : undefined).catch(() => {});
          }
          return instant;
        },
      });
      await expect(guard.check()).rejects.toThrow("control-consumer-guard-failed");
      expect(f.state.anchors).toBe(0);
      expect(f.state.reads).toEqual([]);
    }
    for (const value of [
      true,
      false,
      {},
      Promise.resolve(),
      Promise.reject(new Error("private-refusal")),
    ]) {
      const f = fixture();
      await expect(f.guard.check(undefined, (() => value) as () => void)).rejects.toThrow(
        "control-consumer-guard-failed",
      );
      expect(f.state.anchors).toBe(0);
    }
  });
  test("physical time starts before the first clock and owner snapshot", () => {
    for (const phase of ["clock", "snapshot"]) {
      const f = fixture();
      const modulePath = new URL("../../scripts/control-consumer.ts", import.meta.url).pathname;
      const program = `
        import { performance } from "node:perf_hooks";
        const input = ${JSON.stringify({ configuration: f.configuration, anchor: f.state.anchor, phase })};
        let elapsed = 0, reads = 0, anchors = 0, clocks = 0, code;
        Object.defineProperty(performance, "now", { value: () => elapsed });
        const { ControlConsumerGuard } = await import(${JSON.stringify(modulePath)});
        if (input.phase === "snapshot") Object.defineProperty(input.anchor, "backend", {
          enumerable: true, get() { elapsed = 60000; return input.configuration.backend; },
        });
        const guard = new ControlConsumerGuard(input.configuration, {
          store: { read: async () => { reads++; return null; }, write: async () => {} },
          owner: { readOwnerAnchor: async () => { anchors++; return input.anchor; }, confirmCompletedRepair: async () => {} },
          now: () => { if (input.phase === "clock" && ++clocks === 1) elapsed = 60000; return ${instant}; },
        });
        try { await guard.check(); code = "accepted"; } catch(error) { code = error.message; }
        console.log(JSON.stringify({ reads, anchors, code }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(Buffer.from(child.stderr).toString()).toBe("");
      expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
        reads: 0,
        anchors: phase === "clock" ? 0 : 1,
        code: "control-consumer-guard-failed",
      });
    }
  });
  test("owned write bytes use intrinsic copying before the first await", async () => {
    const f = fixture();
    const bytes = Uint8Array.from([7, 8]);
    let hooks = 0;
    Object.defineProperty(bytes, "length", {
      get() {
        hooks++;
        throw new Error("private-length");
      },
    });
    Object.defineProperty(bytes, Symbol.iterator, {
      get() {
        hooks++;
        throw new Error("private-iterator");
      },
    });
    await guardedControlStore(f.store, f.guard).write("current", bytes);
    expect(f.state.values.get("current")).toEqual(Uint8Array.from([7, 8]));
    expect(hooks).toBe(0);
  });
  test("a late malformed read result permanently fences the callback offered to storage", async () => {
    const f = fixture();
    let retained: (() => void) | undefined;
    const read = f.store.read;
    const store: ControlStore = {
      read: async (path, refusal) => {
        if (path !== "current") return read(path, refusal);
        retained = refusal;
        refusal?.();
        return {} as Uint8Array;
      },
      write: f.store.write,
    };
    const guard = new ControlConsumerGuard(f.configuration, {
      store,
      owner: f.owner,
      now: () => instant,
    });
    await expect(guardedControlStore(store, guard).read("current")).rejects.toThrow(
      "control-consumer-read-failed",
    );
    expect(typeof retained).toBe("function");
    expect(() => retained?.()).toThrow("invalid-control-consumer");
    await guard.check();
    expect(() => retained?.()).toThrow("invalid-control-consumer");
  });
  test("explicit never-repaired mode checks both absent markers twice without guessing", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target);
      await f.guard.check();
      expect(f.state.confirmed).toHaveLength(0);
      expect(f.state.anchors).toBe(2);
      expect(f.state.reads).toEqual([
        `recovery/${target}/registration`,
        `recovery/${target}/current`,
        `recovery/${target}/registration`,
        `recovery/${target}/current`,
      ]);
      expect(JSON.stringify(f.guard)).toBe("{}");
      expect(Bun.inspect(f.guard)).not.toContain(f.configuration.backend);
    }
  });
  test("an expected completed repair requires both markers and its independent whole-history guard", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target);
      f.complete();
      await f.guard.check();
      expect(f.state.confirmed).toEqual([{ ...f.configuration, generation }]);
      expect(f.state.anchors).toBe(2);
    }
  });
  test("missing/erased metadata never converts completed repair into never-repaired", async () => {
    for (const missing of ["registration", "current", "both"]) {
      const f = fixture();
      f.complete();
      if (missing !== "current") f.state.values.delete("recovery/infra/registration");
      if (missing !== "registration") f.state.values.delete("recovery/infra/current");
      await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
      expect(f.state.confirmed).toHaveLength(0);
    }
  });
  test("never-repaired with either marker and repairing owner mode refuse normal work", async () => {
    for (const path of ["registration", "current"]) {
      const f = fixture();
      f.state.values.set(`recovery/infra/${path}`, Uint8Array.from([1]));
      await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
    }
    const f = fixture();
    f.state.anchor.repair = { mode: "repairing", generation };
    const normal = guardedControlStore(f.store, f.guard);
    await expect(normal.write("current", Uint8Array.from([9]))).rejects.toThrow(
      "control-consumer-write-failed",
    );
    expect(f.state.writes).toHaveLength(0);
    expect(f.state.reads).toHaveLength(0);
  });
  test("absent owner configuration, wrong scope and malformed/future/expired proof fail closed", async () => {
    for (const patch of [
      { schema: 2 },
      { target: "production" },
      { backend: "b".repeat(64) },
      { namespace: "tarubot/control/v1/trust-staging/" },
      { revision: "latest" },
      { repair: { mode: "unknown" } },
      { repair: { mode: "completed-repair" } },
      { observed_at: instant + 1 },
      { observed_at: instant - 30_001 },
      { expires_at: instant },
      { expires_at: instant + 60_001 },
      { extra: true },
    ]) {
      const f = fixture();
      Object.assign(f.state.anchor, patch);
      await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
    }
    const f = fixture();
    f.owner.readOwnerAnchor = async () => null;
    const guard = new ControlConsumerGuard(f.configuration, {
      store: f.store,
      owner: f.owner,
      now: () => instant,
    });
    await expect(guard.check()).rejects.toThrow("control-consumer-guard-failed");
  });
  test("owner revision, mode and expected generation cannot change across awaited repair verification", async () => {
    for (const change of [
      (a: OwnerControlAnchor) => {
        a.revision = otherGeneration;
      },
      (a: OwnerControlAnchor) => {
        a.repair = { mode: "repairing", generation };
      },
      (a: OwnerControlAnchor) => {
        a.repair = { mode: "completed-repair", generation: otherGeneration };
      },
    ]) {
      const f = fixture();
      f.complete();
      f.state.beforeConfirm = async () => {
        change(f.state.anchor);
      };
      await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
      expect(f.state.confirmed).toEqual([{ ...f.configuration, generation }]);
    }
  });
  test("changed repair bytes or an ambiguous metadata read cannot satisfy a matching owner revision", async () => {
    const f = fixture();
    f.complete();
    f.state.beforeConfirm = async () => {
      f.state.values.set("recovery/infra/current", Uint8Array.from([7]));
    };
    await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
    const denied = fixture();
    denied.state.beforeRead = async () => {
      throw new Error("invented credential/storage diagnostic");
    };
    await expect(denied.guard.check()).rejects.toThrow("control-consumer-guard-failed");
  });
  test("pending/incomplete/failed independent repair and boolean self-attestation cannot authorize reads", async () => {
    const f = fixture();
    f.complete();
    f.state.beforeConfirm = async () => {
      throw new Error("invented pending or unsuccessful recovery run");
    };
    await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
    const owner = {
      ...f.owner,
      confirmCompletedRepair: async () => true,
    } as unknown as ControlConsumerBoundary;
    const guard = new ControlConsumerGuard(f.configuration, {
      store: f.store,
      owner,
      now: () => instant,
    });
    await expect(guard.check()).rejects.toThrow("control-consumer-guard-failed");
  });
  test("expired/backward time after await refuses a formerly fresh owner anchor", async () => {
    for (const at of [instant - 1, instant + 30_001, instant + 60_000]) {
      const f = fixture();
      f.complete();
      f.state.beforeConfirm = async () => {
        f.setTime(at);
      };
      await expect(f.guard.check()).rejects.toThrow("control-consumer-guard-failed");
    }
  });
  test("reads guard before/after and return a detached private byte snapshot", async () => {
    const f = fixture();
    const bytes = Uint8Array.from([1, 2, 3]);
    f.state.values.set("current", bytes);
    const normal = guardedControlStore(f.store, f.guard);
    const result = await normal.read("current");
    expect(result).toEqual(bytes);
    expect(result).not.toBe(bytes);
    bytes.fill(9);
    expect(result).toEqual(Uint8Array.from([1, 2, 3]));
    expect(f.state.anchors).toBe(4);
    expect(await normal.read(`baselines/${generation}`)).toBeNull();
    expect(Object.isFrozen(normal)).toBe(true);
  });
  test("late owner fencing refuses read results and leaves persisted writes uncertain without retry", async () => {
    const f = fixture();
    f.state.values.set("current", Uint8Array.from([1]));
    f.state.beforeRead = async (path) => {
      if (path === "current") f.state.anchor.repair = { mode: "repairing", generation };
    };
    const normal = guardedControlStore(f.store, f.guard);
    await expect(normal.read("current")).rejects.toThrow("control-consumer-read-failed");
    const write = fixture();
    write.state.beforeWrite = async () => {
      write.state.anchor.repair = { mode: "repairing", generation };
    };
    const writer = guardedControlStore(write.store, write.guard);
    await expect(writer.write("current", Uint8Array.from([2]))).rejects.toThrow(
      "control-consumer-write-failed",
    );
    expect(write.state.writes).toEqual(["current"]);
    expect(write.state.values.get("current")).toEqual(Uint8Array.from([2]));
    await expect(writer.write("current", Uint8Array.from([3]))).rejects.toThrow(
      "control-consumer-write-failed",
    );
    expect(write.state.writes).toEqual(["current"]);
  });
  test("write bytes, scope and captured guard capabilities cannot be changed by external shadows", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeAnchor = async (count) => {
      if (count === 1) await wait;
    };
    const normal = guardedControlStore(f.store, f.guard);
    const bytes = new Uint8Array(new SharedArrayBuffer(3));
    bytes.set([1, 2, 3]);
    const pending = normal.write("current", bytes);
    bytes.fill(9);
    expect(Reflect.set(f.guard, "scope", { target: "production" })).toBe(false);
    expect(Reflect.set(f.guard, "confirm", async () => {})).toBe(false);
    release?.();
    await pending;
    expect(f.state.values.get("current")).toEqual(Uint8Array.from([1, 2, 3]));
    expect(f.state.writes).toEqual(["current"]);
    const fresh = fixture();
    const owner = fresh.owner;
    const captured = new ControlConsumerGuard(fresh.configuration, {
      store: fresh.store,
      owner,
      now: () => instant,
    });
    owner.readOwnerAnchor = async () => null;
    await captured.check();
  });
  test("one normal operation cannot cross a successful owner revision or repair generation", async () => {
    for (const operation of ["read", "write"] as const) {
      for (const change of ["revision", "generation", "metadata"]) {
        const f = fixture();
        f.complete();
        f.state.values.set("current", Uint8Array.from([1]));
        const transition = async (path: string) => {
          if (path !== "current") return;
          if (change === "revision") f.state.anchor.revision = otherGeneration;
          if (change === "generation")
            f.state.anchor.repair = { mode: "completed-repair", generation: otherGeneration };
          if (change === "metadata")
            f.state.values.set("recovery/infra/current", Uint8Array.from([9]));
        };
        if (operation === "read") f.state.beforeRead = transition;
        else f.state.beforeWrite = transition;
        const normal = guardedControlStore(f.store, f.guard);
        const pending =
          operation === "read"
            ? normal.read("current")
            : normal.write("current", Uint8Array.from([2]));
        await expect(pending).rejects.toThrow(`control-consumer-${operation}-failed`);
        // A completed remote write remains uncertain; the wrapper never retries it.
        expect(f.state.writes).toEqual(operation === "write" ? ["current"] : []);
      }
    }
  });
  test("a guard cannot authorize another backend and captures its original storage methods", async () => {
    const a = fixture();
    const b = fixture();
    expect(() => guardedControlStore(b.store, a.guard)).toThrow("invalid-control-consumer-store");
    expect(a.state.anchors).toBe(0);
    expect(b.state.reads).toEqual([]);
    // Capability replacement after guard construction must not reroute normal writes.
    a.store.write = async () => {
      throw new Error("invented replaced backend");
    };
    await guardedControlStore(a.store, a.guard).write("current", Uint8Array.from([3]));
    expect(a.state.writes).toEqual(["current"]);
  });
  test("normal wrappers reject recovery, other scopes and malformed paths before any I/O", async () => {
    for (const target of ["infra", "staging", "production"] as const) {
      const f = fixture(target);
      const normal = guardedControlStore(f.store, f.guard);
      for (const path of [
        `recovery/${target}/registration`,
        `recovery/${target}/current`,
        `recovery/${target}/intents/${generation}`,
        `recovery/${target}/completed/${generation}`,
        "state",
        "../current",
        "current?versionId=invented",
        "trust/other/current",
        target === "infra" ? "trust/staging/current" : "current",
      ]) {
        await expect(normal.read(path)).rejects.toThrow("control-consumer-read-failed");
        await expect(normal.write(path, Uint8Array.from([1]))).rejects.toThrow(
          "control-consumer-write-failed",
        );
      }
      expect(f.state.anchors).toBe(0);
      expect(f.state.reads).toEqual([]);
      expect(f.state.writes).toEqual([]);
      const valid = target === "infra" ? "current" : `trust/${target}/current`;
      await normal.write(valid, Uint8Array.from([2]));
      expect(await normal.read(valid)).toEqual(Uint8Array.from([2]));
    }
  });
  test("operation tickets are opaque, guard-specific and cannot be forged or renewed after expiry", async () => {
    const f = fixture();
    const ticket = await f.guard.check();
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(JSON.stringify(ticket)).toBe("{}");
    await f.guard.check(ticket);
    const other = fixture();
    await expect(other.guard.check(ticket)).rejects.toThrow("control-consumer-guard-failed");
    await expect(f.guard.check({} as typeof ticket)).rejects.toThrow(
      "control-consumer-guard-failed",
    );
    f.setTime(instant + 30_000);
    f.state.anchor.observed_at = instant + 30_000;
    f.state.anchor.expires_at = instant + 90_000;
    await expect(f.guard.check(ticket)).rejects.toThrow("control-consumer-guard-failed");
    await f.guard.check();
  });
  test("refreshing owner timestamps during normal I/O cannot extend the original operation", async () => {
    for (const operation of ["read", "write"] as const) {
      const f = fixture();
      const transition = async (path: string) => {
        if (path !== "current") return;
        f.setTime(instant + 30_000);
        f.state.anchor.observed_at = instant + 30_000;
        f.state.anchor.expires_at = instant + 90_000;
      };
      if (operation === "read") f.state.beforeRead = transition;
      else f.state.beforeWrite = transition;
      const normal = guardedControlStore(f.store, f.guard);
      await expect(
        operation === "read"
          ? normal.read("current")
          : normal.write("current", Uint8Array.from([2])),
      ).rejects.toThrow(`control-consumer-${operation}-failed`);
      expect(f.state.writes).toEqual(operation === "write" ? ["current"] : []);
    }
  });
  test("a stalled backend is bounded by the initial owner expiry without retrying", async () => {
    const f = fixture();
    f.state.anchor.expires_at = instant + 50;
    f.state.beforeWrite = async () => new Promise<void>(() => {});
    const normal = guardedControlStore(f.store, f.guard);
    await expect(normal.write("current", Uint8Array.from([2]))).rejects.toThrow(
      "control-consumer-write-failed",
    );
    expect(f.state.writes).toEqual(["current"]);
    expect(f.state.values.get("current")).toBeUndefined();
  });
});
