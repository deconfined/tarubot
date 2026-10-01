/** Owner configuration and ciphertext bytes are invented; no live owner or object store is read. */
import { describe, expect, test } from "bun:test";
import {
  ControlConsumerGuard,
  guardedControlStore,
  createControlJournalOperationController,
  assertControlJournalOperationController,
  assertControlJournalPublicEntry,
  withinControlJournalOperation,
  type ControlJournalOperation,
  type ControlJournalReadOperation,
  prepareControlJournalDelivery,
  sealControlJournalDelivery,
  assertControlJournalDelivery,
  remainingControlJournalDelivery,
  stopControlJournalDelivery,
  type ControlConsumerBoundary,
  type ControlConsumerScope,
  type ControlConsumerTicket,
  type OwnerControlAnchor,
} from "../../scripts/control-consumer.js";
import { GitHubControlOwnerBoundary } from "../../scripts/control-owner-boundary.js";
import type { ControlStore } from "../../scripts/infra-control.js";
import { LocalDnssecValidator } from "../../scripts/dnssec-validator.js";

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

/** Native parsing remains real; only the three read-only GitHub replies and raw bytes are invented. */
function nativeJournalFixture() {
  const scope: ControlConsumerScope = {
    target: "infra",
    backend: "a".repeat(64),
    namespace: "tarubot/control/v1/infra/",
  };
  const clock = { now: instant };
  const calls: string[] = [],
    offers: string[] = [];
  const values = new Map<string, Uint8Array>();
  const fences: (() => void)[] = [];
  let beforeRead = (_path: string) => {},
    beforeWrite = () => {};
  const raw = {
    async read(path: string, refusal?: () => void) {
      beforeRead(path);
      refusal?.();
      if (refusal) fences.push(refusal);
      offers.push(`read:${path}`);
      return values.get(path) ?? null;
    },
    async write(path: string, bytes: Uint8Array, refusal?: () => void) {
      beforeWrite();
      refusal?.();
      if (refusal) fences.push(refusal);
      offers.push(`write:${path}`);
      values.set(path, Uint8Array.from(bytes));
    },
    async readVersion(): Promise<never> {
      throw new Error("invented version capability refused");
    },
  };
  const config = {
    ...scope,
    target: "infra" as const,
    passphrase: "invented native journal control passphrase",
    owner_id: 123,
    repository_id: 234,
    environment_id: 345,
    token: "invented_native_read_token",
  };
  const api = "https://api.github.com/repos/deconfined/tarubot";
  const record = { schema: 1, ...scope, revision, repair: { mode: "never-repaired" } };
  const replies: Record<string, unknown> = {
    [api]: {
      id: 234,
      full_name: "deconfined/tarubot",
      fork: false,
      owner: { id: 123, login: "deconfined" },
    },
    [`${api}/environments/control-infra`]: {
      id: 345,
      name: "control-infra",
      url: `${api}/environments/control-infra`,
    },
    [`${api}/environments/control-infra/variables/CONTROL_OWNER_ANCHOR`]: {
      name: "CONTROL_OWNER_ANCHOR",
      value: JSON.stringify(record),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
  const owner = new GitHubControlOwnerBoundary(config, {
    store: raw,
    now: () => clock.now,
    get: async (request) => {
      calls.push(request.url);
      if (!Object.hasOwn(replies, request.url)) throw new Error("invented unexpected GET");
      return {
        status: 200,
        url: request.url,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(replies[request.url])),
      };
    },
  });
  const guard = new ControlConsumerGuard(scope, { store: raw, owner, now: () => clock.now });
  const legacy = guardedControlStore(raw, guard);
  const controller = createControlJournalOperationController(legacy, raw, guard, owner);
  return {
    scope,
    config,
    clock,
    calls,
    offers,
    values,
    fences,
    raw,
    owner,
    guard,
    legacy,
    controller,
    beforeRead: (work: (path: string) => void) => {
      beforeRead = work;
    },
    beforeWrite: (work: () => void) => {
      beforeWrite = work;
    },
  };
}

describe("lexical native whole journal authority", () => {
  test("read volume is per public operation and every PUT receives its own fresh checkpoint", async () => {
    const f = nativeJournalFixture();
    f.values.set("current", Uint8Array.from([1, 2, 3]));
    const result = await withinControlJournalOperation(
      f.controller,
      f.legacy,
      async (operation) => {
        if (!operation) throw new Error("missing native operation");
        await operation.store.read("current");
        await operation.store.read("current");
        await operation.store.write("current", Uint8Array.from([4, 5, 6]));
        await operation.store.read("current");
        return { received: [4, 5, 6] };
      },
    );
    expect(f.calls).toHaveLength(36); // Initial + pre-PUT + final, each12 actual owner GETs.
    expect(f.offers.filter((offer) => !offer.includes("recovery/"))).toEqual([
      "read:current",
      "read:current",
      "write:current",
      "read:current",
    ]);
    expect(result).toEqual({ received: [4, 5, 6] });
    expect(Object.isFrozen(result.received)).toBe(true);
  });
  test("controllers cannot cross owner, scope, raw store, copied origin or later method windows", async () => {
    const a = nativeJournalFixture(),
      b = nativeJournalFixture();
    expect(() =>
      createControlJournalOperationController(a.legacy, a.raw, a.guard, b.owner),
    ).toThrow("invalid-control-consumer");
    expect(() =>
      createControlJournalOperationController(a.legacy, b.raw, a.guard, a.owner),
    ).toThrow("invalid-control-consumer");
    await expect(
      withinControlJournalOperation({ ...a.controller }, a.legacy, async () => 1),
    ).rejects.toThrow("invalid-control-consumer");
    let escaped: ControlJournalOperation | undefined;
    await withinControlJournalOperation(a.controller, a.legacy, async (operation) => {
      escaped = operation;
      await operation?.store.read("current");
    });
    const count = a.calls.length;
    await expect(escaped?.store.read("current")).rejects.toThrow("control-consumer-read-failed");
    expect(a.calls).toHaveLength(count);
    await withinControlJournalOperation(a.controller, a.legacy, async (operation) => {
      await operation?.store.read("current");
    });
    expect(() => escaped?.assert()).toThrow("control-journal-operation-failed");
  });
  test("initial and post-I/O refusal hooks cannot swallow nested matching or wrong-context entry", async () => {
    for (const late of [false, true])
      for (const wrong of [false, true]) {
        const f = nativeJournalFixture();
        let entered = false,
          delivered = false;
        f.beforeRead((path) => {
          if (path === "current")
            queueMicrotask(() => {
              entered = true;
            });
        });
        await expect(
          withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
            if (!operation) throw new Error("missing native operation");
            await operation.store.read("current", () => {
              if (late !== entered) return;
              void withinControlJournalOperation(
                wrong ? { ...f.controller } : f.controller,
                f.legacy,
                async () => {},
              ).catch(() => {});
            });
            delivered = true;
          }),
        ).rejects.toThrow();
        expect(delivered).toBe(false);
        expect(f.offers.filter((offer) => !offer.includes("recovery/"))).toHaveLength(late ? 1 : 0);
        if (!late) expect(f.calls).toHaveLength(0);
      }
  });
  test("same-pair controller aliases cannot replace an active synchronous origin reservation", async () => {
    const f = nativeJournalFixture();
    await expect(
      withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
        await operation?.store.read("current", () => {
          const alias = createControlJournalOperationController(f.legacy, f.raw, f.guard, f.owner);
          void withinControlJournalOperation(alias, f.legacy, async () => {}).catch(() => {});
        });
      }),
    ).rejects.toThrow("control-consumer-read-failed");
    expect(f.calls).toHaveLength(0);
    expect(f.offers).toHaveLength(0);
  });
  test("known controllers fence their original hook even when a nested caller passes the wrong store", async () => {
    for (const directAssertion of [false, true]) {
      const f = nativeJournalFixture();
      const wrong = nativeJournalFixture();
      await expect(
        withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
          await operation?.store.read("current", () => {
            if (directAssertion) {
              try {
                assertControlJournalOperationController(f.controller, wrong.legacy);
              } catch {
                /* Swallowing a wrong-context refusal must still fence its original operation. */
              }
            } else {
              void withinControlJournalOperation(f.controller, wrong.legacy, async () => {
                await wrong.legacy.read("current");
              }).catch(() => {});
            }
          });
        }),
      ).rejects.toThrow("control-consumer-read-failed");
      expect(f.calls).toHaveLength(0);
      expect(f.offers).toHaveLength(0);
      expect(wrong.calls).toHaveLength(0);
      expect(wrong.offers).toHaveLength(0);
    }
  });
  test("rewrapped stores and fresh guards cannot evade the same native owner's synchronous reservation", async () => {
    for (const freshGuard of [false, true])
      for (const precreated of [false, true]) {
        const f = nativeJournalFixture();
        const makeAlias = () => {
          const guard = freshGuard
            ? new ControlConsumerGuard(f.scope, {
                store: f.raw,
                owner: f.owner,
                now: () => f.clock.now,
              })
            : f.guard;
          const legacy = guardedControlStore(f.raw, guard);
          return {
            legacy,
            controller: createControlJournalOperationController(legacy, f.raw, guard, f.owner),
          };
        };
        const ready = precreated ? makeAlias() : undefined;
        let nestedDelivered = false;
        await expect(
          withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
            await operation?.store.read("current", () => {
              try {
                const alias = ready ?? makeAlias();
                void withinControlJournalOperation(
                  alias.controller,
                  alias.legacy,
                  async (nested) => {
                    await nested?.store.read("current");
                    nestedDelivered = true;
                  },
                ).catch(() => {});
              } catch {
                /* Creation denial is permanent even when this caller catches it. */
              }
            });
          }),
        ).rejects.toThrow("control-consumer-read-failed");
        expect(nestedDelivered).toBe(false);
        expect(f.calls).toHaveLength(0);
        expect(f.offers).toHaveLength(0);
        // The reservation carries no ticket across awaits or into a later public operation.
        const alias = ready ?? makeAlias();
        await withinControlJournalOperation(alias.controller, alias.legacy, async (operation) => {
          await operation?.store.read("current");
        });
        expect(f.calls).toHaveLength(24);
      }
  });
  test("wrong-owner admission and unbound excluded aliases still deny an active known owner", async () => {
    for (const excluded of [false, true]) {
      const f = nativeJournalFixture();
      const other = nativeJournalFixture();
      const fresh = new ControlConsumerGuard(f.scope, {
        store: f.raw,
        owner: f.owner,
        now: () => f.clock.now,
      });
      const alias = guardedControlStore(f.raw, fresh);
      await expect(
        withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
          await operation?.store.read("current", () => {
            try {
              if (excluded) assertControlJournalPublicEntry(undefined, alias);
              else createControlJournalOperationController(f.legacy, f.raw, f.guard, other.owner);
            } catch {
              /* Neither a forged admission nor a legacy alias can erase known active denial. */
            }
          });
        }),
      ).rejects.toThrow("control-consumer-read-failed");
      expect(f.calls).toHaveLength(0);
      expect(f.offers).toHaveLength(0);
      expect(other.calls).toHaveLength(0);
    }
  });
  test("native callback promises bypass .then getters and thenable echoes cannot enter", async () => {
    const f = nativeJournalFixture();
    let getterCalls = 0;
    await withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
      const native = Promise.resolve({ received: true });
      // biome-ignore lint/suspicious/noThenProperty: invented getter must never be invoked by the native bridge.
      Object.defineProperty(native, "then", {
        get() {
          getterCalls++;
          throw new Error("invented-private-then");
        },
      });
      const result = await operation?.wait(() => native);
      expect(result).toEqual({ received: true });
    });
    expect(getterCalls).toBe(0);
    const g = nativeJournalFixture();
    await expect(
      withinControlJournalOperation(g.controller, g.legacy, async (operation) => {
        await operation?.wait(
          () =>
            ({
              // biome-ignore lint/suspicious/noThenProperty: invented thenable echo must be refused without property access.
              get then() {
                getterCalls++;
                throw new Error("invented-private-thenable");
              },
            }) as unknown as Promise<never>,
        );
      }),
    ).rejects.toThrow("control-journal-operation-failed");
    expect(getterCalls).toBe(0);
    expect(g.calls).toHaveLength(0);
  });
  test("fulfilled values are copied before wait or top-level async resolution can read a then getter", async () => {
    for (const throughWait of [false, true])
      for (const retained of [false, true]) {
        const f = nativeJournalFixture();
        let reads = 0,
          nestedDelivered = false,
          delivered = false;
        const value = { received: true };
        // Promise.resolve reads this once; a second async assimilation used to escape the hook.
        // biome-ignore lint/suspicious/noThenProperty: invented fulfilled-value accessor probes extra assimilation.
        Object.defineProperty(value, "then", {
          enumerable: true,
          get() {
            if (++reads > 1)
              void withinControlJournalOperation(f.controller, f.legacy, async (nested) => {
                await nested?.store.read("current");
                nestedDelivered = true;
              }).catch(() => {});
            return undefined;
          },
        });
        await expect(
          withinControlJournalOperation(f.controller, f.legacy, (operation) => {
            if (!operation) throw new Error("missing native operation");
            if (retained) operation.retain(value);
            const pending = Promise.resolve(value);
            if (throughWait)
              return operation
                .wait(() => pending)
                .then(() => {
                  delivered = true;
                  return value;
                });
            return pending;
          }),
        ).rejects.toThrow("control-journal-operation-failed");
        expect(reads).toBe(1);
        expect(delivered).toBe(false);
        expect(nestedDelivered).toBe(false);
        expect(f.calls).toHaveLength(0);
        expect(f.offers).toHaveLength(0);
      }
  });
  test("diagnostic Proxy traps and arbitrary callback messages remain fixed private refusals", async () => {
    for (const descriptor of [false, true]) {
      const f = nativeJournalFixture();
      const hostile = new Proxy(
        new Error("invalid-ssh-trust"),
        descriptor
          ? {
              getOwnPropertyDescriptor() {
                throw new Error("invented-private-descriptor");
              },
            }
          : {
              getPrototypeOf() {
                throw new Error("invented-private-prototype");
              },
            },
      );
      await expect(
        withinControlJournalOperation(f.controller, f.legacy, async () => {
          throw hostile;
        }),
      ).rejects.toThrow("control-journal-operation-failed");
      expect(f.calls).toHaveLength(0);
      expect(f.offers).toHaveLength(0);
    }
  });
  test("old SDK callbacks stay fenced after timeout, a fresh operation and failed final result hooks", async () => {
    const f = nativeJournalFixture();
    let saved: ControlJournalOperation | undefined;
    await expect(
      withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
        if (!operation) throw new Error("missing native operation");
        saved = operation;
        await operation.store.read("current");
        f.clock.now += 30_000;
        return { stale: true };
      }),
    ).rejects.toThrow("control-journal-operation-failed");
    const old = f.fences.filter((_fence, index) => index === f.fences.length - 1)[0];
    expect(old).toBeDefined();
    await withinControlJournalOperation(f.controller, f.legacy, async (operation) => {
      await operation?.store.read("current");
    });
    expect(() => old?.()).toThrow();
    const count = f.offers.length;
    await expect(saved?.store.read("current")).rejects.toThrow("control-consumer-read-failed");
    expect(f.offers).toHaveLength(count);
    const g = nativeJournalFixture();
    let closing: ControlJournalOperation | undefined,
      stopped = false;
    await expect(
      withinControlJournalOperation(g.controller, g.legacy, async (operation) => {
        closing = operation;
        operation?.onFailure(() => {
          stopped = true;
        });
        await operation?.store.read("current");
        return new Proxy(
          {},
          {
            ownKeys() {
              void closing?.store.read("current").catch(() => {});
              return [];
            },
          },
        );
      }),
    ).rejects.toThrow("control-journal-operation-failed");
    expect(stopped).toBe(true);
    expect(g.offers.filter((offer) => !offer.includes("recovery/"))).toHaveLength(1);
  });
});

describe("native read-only terminal journal delivery", () => {
  test("remaining subtracts time spent by the final clock hook in preparation and prepared phases", async () => {
    for (const prepared of [false, true]) {
      const f = nativeJournalFixture();
      let wall = instant,
        reads = 0,
        advanceAt = Number.POSITIVE_INFINITY;
      Object.defineProperty(f.clock, "now", {
        get() {
          if (++reads === advanceAt) wall += 10_000;
          return wall;
        },
      });
      let saved!: ControlJournalReadOperation;
      const measure = (remaining: () => number) => {
        reads = 0;
        remaining();
        const hooks = reads;
        expect(hooks).toBeGreaterThan(0);
        reads = 0;
        advanceAt = hooks; // Consume wall time in the LAST caller-controlled hook.
        expect(remaining()).toBeLessThanOrEqual(20_000);
        expect(reads).toBe(hooks);
        advanceAt = Number.POSITIVE_INFINITY;
      };
      const cap = await prepareControlJournalDelivery(f.controller, f.legacy, async (operation) => {
        saved = operation;
        if (!prepared) measure(operation.remaining);
        return { received: true };
      });
      if (prepared) measure(() => remainingControlJournalDelivery(cap, f.controller, f.legacy));
      expect(saved.remaining()).toBeLessThanOrEqual(20_000);
      expect(await sealControlJournalDelivery(cap, f.controller, f.legacy)).toEqual({
        received: true,
      });
      stopControlJournalDelivery(cap);
      expect(f.calls).toHaveLength(24);
    }
  });
  test("withholds inspection until one checkpoint and retains only the original pure window", async () => {
    const f = nativeJournalFixture();
    let saved!: ControlJournalReadOperation;
    f.values.set("current", Uint8Array.from([7]));
    // The read path must not inspect even a replacement raw write getter.
    Object.defineProperty(f.raw, "write", {
      get() {
        throw new Error("invented write getter");
      },
    });
    const cap = await prepareControlJournalDelivery(f.controller, f.legacy, async (operation) => {
      saved = operation;
      expect(Object.keys(operation.store)).toEqual(["read"]);
      expect(Object.keys(operation)).toEqual(["store", "assert", "remaining", "capture", "wait"]);
      expect(Number.isSafeInteger(operation.remaining())).toBe(true);
      expect(await operation.store.read("current")).toEqual(Uint8Array.from([7]));
      return { snapshot: { generation, values: [7] } };
    });
    expect(Object.keys(cap)).toEqual([]);
    expect(Object.isFrozen(cap)).toBe(true);
    expect(f.calls).toHaveLength(12);
    f.clock.now += 100;
    const remaining = saved.remaining();
    expect(Number.isSafeInteger(remaining)).toBe(true);
    expect(remaining).toBeLessThanOrEqual(29_900);
    // Like native enrollment verification, a dependency retains this original refusal only.
    const retainedDenial = saved.assert;
    retainedDenial();
    const inspection = await sealControlJournalDelivery(cap, f.controller, f.legacy);
    expect(f.calls).toHaveLength(24);
    expect(inspection).toEqual({ snapshot: { generation, values: [7] } });
    expect(Object.isFrozen(inspection.snapshot.values)).toBe(true);
    retainedDenial();
    assertControlJournalDelivery(cap, f.controller, f.legacy);
    expect(remainingControlJournalDelivery(cap, f.controller, f.legacy)).toBeLessThanOrEqual(
      remaining,
    );
    stopControlJournalDelivery(cap);
    expect(() => retainedDenial()).toThrow("control-journal-delivery-failed");
    expect(() => remainingControlJournalDelivery(cap, f.controller, f.legacy)).toThrow(
      "control-journal-delivery-failed",
    );
    expect(f.calls).toHaveLength(24);
  });
  test("prepared reads, captures, waits and their original SDK callbacks cannot escape", async () => {
    for (const method of ["read", "capture", "wait", "sdk"] as const) {
      const f = nativeJournalFixture();
      let saved!: ControlJournalReadOperation;
      const cap = await prepareControlJournalDelivery(f.controller, f.legacy, async (operation) => {
        saved = operation;
        await operation.store.read("current");
        return { received: true };
      });
      const count = f.offers.length;
      if (method === "read") await expect(saved.store.read("current")).rejects.toThrow();
      else if (method === "capture") expect(() => saved.capture(() => 1)).toThrow();
      else if (method === "wait") await expect(saved.wait(async () => 1)).rejects.toThrow();
      else expect(() => f.fences.at(-1)?.()).toThrow();
      await expect(sealControlJournalDelivery(cap, f.controller, f.legacy)).rejects.toThrow(
        "control-journal-delivery-failed",
      );
      expect(f.offers).toHaveLength(count);
      expect(f.calls).toHaveLength(12);
    }
  });
  test("idle and held expiry permanently stop original callbacks before any later offer", async () => {
    const idle = nativeJournalFixture();
    let retained!: ControlJournalReadOperation;
    const cap = await prepareControlJournalDelivery(
      idle.controller,
      idle.legacy,
      async (operation) => {
        retained = operation;
        idle.clock.now += 29_980;
        return { received: true };
      },
    );
    await Bun.sleep(60);
    await expect(sealControlJournalDelivery(cap, idle.controller, idle.legacy)).rejects.toThrow(
      "control-journal-delivery-failed",
    );
    expect(() => retained.assert()).toThrow("control-journal-delivery-failed");
    expect(idle.calls).toHaveLength(12);
    const held = nativeJournalFixture();
    let release!: () => void;
    const pending = prepareControlJournalDelivery(
      held.controller,
      held.legacy,
      async (operation) => {
        held.clock.now += 29_980;
        await operation.wait(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        await operation.store.read("current");
        return { late: true };
      },
    );
    const settled = pending.catch(() => "refused");
    await Bun.sleep(60);
    expect(await settled).toBe("refused");
    release();
    await Bun.sleep(10);
    expect(held.calls).toHaveLength(12);
    expect(held.offers.filter((offer) => !offer.includes("recovery/"))).toHaveLength(0);
  });
  test("a synchronous owned result copy cannot starve a shortened timer and trigger later checks", async () => {
    const f = nativeJournalFixture();
    await expect(
      prepareControlJournalDelivery(f.controller, f.legacy, () => {
        f.clock.now += 29_980;
        let spent = false;
        return Promise.resolve(
          new Proxy(
            { received: true },
            {
              ownKeys(value) {
                if (!spent) {
                  spent = true;
                  const until = performance.now() + 60;
                  while (performance.now() < until) {
                    /* Invented synchronous copying cost. */
                  }
                }
                return Reflect.ownKeys(value);
              },
            },
          ),
        );
      }),
    ).rejects.toThrow("control-journal-delivery-failed");
    expect(f.calls).toHaveLength(12);
    expect(f.offers.filter((offer) => !offer.includes("recovery/"))).toHaveLength(0);
  });
  test("copied, cross-origin and repeated seal inputs fence the actual original capability", async () => {
    for (const wrong of ["copy", "controller", "store", "alias", "repeat"] as const) {
      const f = nativeJournalFixture(),
        other = nativeJournalFixture();
      const cap = await prepareControlJournalDelivery(f.controller, f.legacy, async () => ({
        received: true,
      }));
      const alias = createControlJournalOperationController(f.legacy, f.raw, f.guard, f.owner);
      if (wrong === "copy") {
        await expect(
          sealControlJournalDelivery({ ...cap }, f.controller, f.legacy),
        ).rejects.toThrow("control-journal-delivery-failed");
        // An unrecognized clone grants nothing and cannot identify a genuine unrelated cap.
        stopControlJournalDelivery(cap);
      } else {
        if (wrong === "repeat") await sealControlJournalDelivery(cap, f.controller, f.legacy);
        await expect(
          sealControlJournalDelivery(
            cap,
            wrong === "controller" ? other.controller : wrong === "alias" ? alias : f.controller,
            wrong === "store" ? other.legacy : f.legacy,
          ),
        ).rejects.toThrow("control-journal-delivery-failed");
      }
      expect(() => assertControlJournalDelivery(cap, f.controller, f.legacy)).toThrow(
        "control-journal-delivery-failed",
      );
      expect(f.calls).toHaveLength(wrong === "repeat" ? 24 : 12);
      expect(other.calls).toHaveLength(0);
    }
  });
  test("nested seal and wrong-context first clocks cannot swallow the original denial", async () => {
    for (const wrong of [false, true]) {
      const f = nativeJournalFixture();
      let nested = false;
      Object.defineProperty(f.clock, "now", {
        get() {
          if (!nested) {
            nested = true;
            void prepareControlJournalDelivery(
              wrong ? { ...f.controller } : f.controller,
              f.legacy,
              async () => 1,
            ).catch(() => {});
          }
          return instant;
        },
      });
      await expect(
        prepareControlJournalDelivery(f.controller, f.legacy, async () => 1),
      ).rejects.toThrow("control-journal-delivery-failed");
      expect(f.calls).toHaveLength(0);
      expect(f.offers).toHaveLength(0);
    }
    const f = nativeJournalFixture();
    const cap = await prepareControlJournalDelivery(f.controller, f.legacy, async () => ({
      received: true,
    }));
    f.beforeRead(() => {
      void sealControlJournalDelivery(cap, f.controller, f.legacy).catch(() => {});
    });
    await expect(sealControlJournalDelivery(cap, f.controller, f.legacy)).rejects.toThrow(
      "control-journal-delivery-failed",
    );
    expect(() => assertControlJournalDelivery(cap, f.controller, f.legacy)).toThrow(
      "control-journal-delivery-failed",
    );
  });
  test("native resolver timeout parsing accepts the retained integer minimum before any fixture effect", async () => {
    const f = nativeJournalFixture();
    let accepted = 0,
      measured = 0,
      executorOffers = 0;
    await expect(
      prepareControlJournalDelivery(f.controller, f.legacy, async (operation) => {
        const validator = new LocalDnssecValidator(
          {
            helper: "/invented/validator",
            anchors: "/invented/root.ds",
            runtime: { directory: "/invented", manifest_sha256: "e".repeat(64) },
            pin: {
              name: "unbound",
              version: "1.26.1",
              mode: "local-validating",
              binary_sha256: "c".repeat(64),
              anchor_sha256: "d".repeat(64),
              runtime_manifest_sha256: "e".repeat(64),
            },
            now: () => f.clock.now,
          },
          () => {
            executorOffers++;
            throw new Error("invented executor must not run");
          },
        );
        await validator.validate(
          {} as never,
          {} as never,
          () => {
            operation.assert();
            if (measured) {
              accepted++;
              throw new Error("invented stop before filesystem offer");
            }
          },
          () => {
            measured = operation.remaining();
            return measured;
          },
        );
        return {};
      }),
    ).rejects.toThrow("control-journal-delivery-failed");
    // The real32 integer check accepted the closure, reached its next refusal, and stopped
    // before paths, loader-preload inspection, DNS, native executor or any host read.
    expect(accepted).toBeGreaterThan(0);
    expect(Number.isSafeInteger(measured)).toBe(true);
    expect(measured).toBeGreaterThan(0);
    expect(executorOffers).toBe(0);
    expect(f.calls).toHaveLength(12);
  });
});
