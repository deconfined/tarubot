/**
 * Normal control records need an independent owner anchor, not an inference from missing repair
 * objects. The owner advances/fences that anchor before restoration and resumes it only after
 * successful repair. This module checks the boundary; it neither approves nor performs repairs.
 * Factory/workflow integration is mandatory before recovery activation and remains separate.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryTarget } from "./control-recovery.js";
import type { ControlStore } from "./infra-control.js";

type Value = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const maxOperation = 60_000;
const freshAge = 30_000;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeSet = Uint8Array.prototype.set;
const nativeThen = Promise.prototype.then;
function requireConsumer(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-consumer");
}
function synchronousRefusal(callback: (() => void) | undefined): void {
  requireConsumer(callback === undefined || typeof callback === "function");
  const result: unknown = callback?.();
  try {
    // Drain real native promises across realms without reading an arbitrary .then getter.
    void Reflect.apply(nativeThen, result, [undefined, () => {}]);
  } catch {
    // Non-promise returns still refuse; no thenable callback is invoked or awaited.
  }
  requireConsumer(result === undefined);
}

/** A private wrapper cap counts intrinsic caller-byte copying before the first owner check. */
function originalRefusal(callback: (() => void) | undefined): { check(): void; stop(): void } {
  const physicalStarted = performance.now();
  let fenced = false,
    checking = false;
  const check = () => {
    let owns = false;
    try {
      requireConsumer(!fenced && !checking && performance.now() - physicalStarted < maxOperation);
      checking = true;
      owns = true;
      synchronousRefusal(callback);
      requireConsumer(!fenced && checking && performance.now() - physicalStarted < maxOperation);
    } catch {
      fenced = true;
      throw new Error("invalid-control-consumer");
    } finally {
      if (owns) checking = false;
    }
  };
  return {
    check,
    stop: () => {
      fenced = true;
    },
  };
}
function exact(value: unknown, keys: string[]): Value {
  requireConsumer(value !== null && typeof value === "object" && !Array.isArray(value));
  const object = value as Value;
  requireConsumer(isDeepStrictEqual(Object.keys(object).sort(), [...keys].sort()));
  return object;
}
function time(value: unknown): asserts value is number {
  requireConsumer(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
export interface ControlConsumerScope {
  target: RecoveryTarget;
  backend: string;
  namespace: string;
}
function scope(value: unknown): ControlConsumerScope {
  const s = exact(value, ["target", "backend", "namespace"]);
  requireConsumer(s.target === "infra" || s.target === "staging" || s.target === "production");
  requireConsumer(typeof s.backend === "string" && sha.test(s.backend));
  const expected = s.target === "infra" ? "infra" : `trust-${s.target}`;
  requireConsumer(s.namespace === `tarubot/control/v1/${expected}/`);
  return structuredClone(s) as unknown as ControlConsumerScope;
}
export interface OwnerControlAnchor extends ControlConsumerScope {
  schema: 1;
  /** Independently retained owner revision; never read this from the ordinary record store. */
  revision: string;
  repair:
    | { mode: "never-repaired" }
    | { mode: "completed-repair"; generation: string }
    | { mode: "repairing"; generation: string };
  observed_at: number;
  expires_at: number;
}
export interface ControlConsumerBoundary {
  /** Read current protected owner configuration, independently of the repair object history. */
  readOwnerAnchor(scope: ControlConsumerScope, refusal?: () => void): Promise<unknown>;
  /** Invoke the bound ControlRecovery.guardConsumer and independently confirm its final run. */
  confirmCompletedRepair(
    request: ControlConsumerScope & { generation: string },
    refusal?: () => void,
  ): Promise<void>;
}
function anchor(value: unknown, expected: ControlConsumerScope, now: number): OwnerControlAnchor {
  const a = exact(value, [
    "schema",
    "target",
    "backend",
    "namespace",
    "revision",
    "repair",
    "observed_at",
    "expires_at",
  ]);
  requireConsumer(a.schema === 1);
  requireConsumer(
    isDeepStrictEqual(
      scope({ target: a.target, backend: a.backend, namespace: a.namespace }),
      expected,
    ),
  );
  requireConsumer(typeof a.revision === "string" && uuid.test(a.revision));
  const r = exact(
    a.repair,
    a.repair !== null &&
      typeof a.repair === "object" &&
      "mode" in a.repair &&
      a.repair.mode === "never-repaired"
      ? ["mode"]
      : ["mode", "generation"],
  );
  requireConsumer(
    r.mode === "never-repaired" || r.mode === "completed-repair" || r.mode === "repairing",
  );
  if (r.mode !== "never-repaired")
    requireConsumer(typeof r.generation === "string" && uuid.test(r.generation));
  time(a.observed_at);
  time(a.expires_at);
  requireConsumer(
    a.observed_at <= now &&
      now - a.observed_at <= freshAge &&
      a.expires_at > now &&
      a.expires_at - a.observed_at <= maxOperation,
  );
  return structuredClone(a) as unknown as OwnerControlAnchor;
}
function identity(value: OwnerControlAnchor): unknown {
  const { observed_at: _observed, expires_at: _expires, ...binding } = value;
  return binding;
}
function byteHash(value: Uint8Array | null): string | null {
  if (value === null) return null;
  return createHash("sha256").update(copyBytes(value)).digest("hex");
}
function copyBytes(value: Uint8Array): Uint8Array {
  requireConsumer(value instanceof Uint8Array && byteLength !== undefined);
  const length = byteLength.call(value) as number;
  requireConsumer(length > 0 && length <= 64 * 1024 * 1024);
  const copy = new Uint8Array(length);
  nativeSet.call(copy, value);
  return copy;
}

declare const ticketBrand: unique symbol;
/** Opaque operation binding; only its originating guard can authenticate it. */
export type ControlConsumerTicket = Readonly<{ [ticketBrand]: true }>;
interface TicketState {
  identity: unknown;
  metadata: (string | null)[];
  issued: number;
  last: number;
  deadline: number;
  physicalDeadline: number;
  refusal: (() => void) | undefined;
  fenced: boolean;
  checking: boolean;
}
interface CapturedStore {
  source: ControlStore;
  read: ControlStore["read"];
  write: ControlStore["write"];
  allowed: RegExp;
  within<T>(ticket: ControlConsumerTicket, operation: () => Promise<T>): Promise<T>;
  assert(ticket: ControlConsumerTicket): void;
}
// Module-private capabilities prevent a guard for one backend from wrapping another backend.
const capturedStores = new WeakMap<ControlConsumerGuard, CapturedStore>();

export class ControlConsumerGuard {
  readonly #scope: ControlConsumerScope;
  readonly #read: ControlStore["read"];
  readonly #anchor: ControlConsumerBoundary["readOwnerAnchor"];
  readonly #confirm: ControlConsumerBoundary["confirmCompletedRepair"];
  readonly #now: () => number;
  readonly #tickets = new WeakMap<ControlConsumerTicket, TicketState>();
  // Only synchronous caller hooks use this reservation. Awaited work always closes over its
  // own window/ticket; a later invocation cannot replace an abandoned operation's authority.
  #hook: { fence(): void } | undefined;
  constructor(
    configuration: ControlConsumerScope,
    dependencies: {
      store: ControlStore;
      owner: ControlConsumerBoundary;
      now?: () => number;
    },
  ) {
    try {
      this.#scope = scope(structuredClone(configuration));
      const store = dependencies.store;
      const owner = dependencies.owner;
      const read = store.read;
      const write = store.write;
      const getAnchor = owner.readOwnerAnchor;
      const confirm = owner.confirmCompletedRepair;
      const now = dependencies.now;
      requireConsumer(
        typeof read === "function" &&
          typeof write === "function" &&
          typeof getAnchor === "function" &&
          typeof confirm === "function",
      );
      requireConsumer(now === undefined || typeof now === "function");
      this.#read = read.bind(store);
      this.#anchor = getAnchor.bind(owner);
      this.#confirm = confirm.bind(owner);
      this.#now = now ?? Date.now;
      const id = uuid.source.slice(1, -1);
      const target = this.#scope.target;
      const ordinary =
        target === "infra"
          ? `(?:current|(?:intents|baselines|completed)/${id})`
          : `trust/${target}/(?:registration|authorization-current|current|(?:authorizations|attempts|consumed|intents|references|records|publication-intents|publications|completed)/${id})`;
      capturedStores.set(this, {
        source: store,
        read: this.#read,
        write: write.bind(store),
        allowed: new RegExp(`^${ordinary}$`, "u"),
        within: (ticket, operation) => this.#within(ticket, operation),
        assert: (ticket) => {
          this.#ticket(ticket);
        },
      });
      Object.freeze(this);
    } catch {
      throw new Error("invalid-control-consumer");
    }
  }
  #ticket(ticket: ControlConsumerTicket): TicketState {
    const saved = this.#tickets.get(ticket);
    let owns = false;
    try {
      requireConsumer(saved && !saved.fenced && !saved.checking);
      saved.checking = true;
      owns = true;
      return this.#hooks(
        () => {
          saved.fenced = true;
        },
        () => {
          synchronousRefusal(saved.refusal);
          const now = this.#now();
          time(now);
          synchronousRefusal(saved.refusal);
          requireConsumer(
            !saved.fenced &&
              saved.checking &&
              now >= saved.last &&
              now >= saved.issued &&
              now < saved.deadline &&
              performance.now() < saved.physicalDeadline,
          );
          saved.last = now;
          return saved;
        },
      );
    } catch {
      if (saved) saved.fenced = true;
      throw new Error("invalid-control-consumer");
    } finally {
      if (saved && owns) saved.checking = false;
    }
  }
  #hooks<T>(fence: () => void, work: () => T): T {
    if (this.#hook) {
      this.#hook.fence();
      fence();
      throw new Error("invalid-control-consumer");
    }
    const reservation = { fence };
    this.#hook = reservation;
    try {
      return work();
    } finally {
      if (this.#hook === reservation) this.#hook = undefined;
    }
  }
  async #within<T>(ticket: ControlConsumerTicket, operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = this.#tickets.get(ticket);
    try {
      const saved = this.#ticket(ticket);
      const result = await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              saved.fenced = true;
              reject(new Error("control-consumer-operation-expired"));
            },
            Math.min(saved.deadline - saved.last, saved.physicalDeadline - performance.now()),
          );
        }),
        Promise.resolve().then(() => {
          this.#ticket(ticket);
          return operation();
        }),
      ]);
      this.#ticket(ticket);
      return result;
    } catch (error) {
      if (state) state.fenced = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Reader-only checks; no absent marker or echo of a supplied generation grants authority. */
  async check(
    expected?: ControlConsumerTicket,
    refusal?: () => void,
  ): Promise<ControlConsumerTicket> {
    const physicalStarted = performance.now();
    let prior: TicketState | undefined;
    let fenced = false,
      checking = false;
    const fence = () => {
      fenced = true;
      if (prior) prior.fenced = true;
    };
    try {
      if (this.#hook) {
        this.#hook.fence();
        fence();
        throw new Error("invalid-control-consumer");
      }
      prior = expected === undefined ? undefined : this.#ticket(expected);
      // Rechecking keeps its ORIGINAL callback. An optional new callback cannot replace it.
      requireConsumer(refusal === undefined || typeof refusal === "function");
      requireConsumer(!prior || refusal === undefined || refusal === prior.refusal);
      const capturedRefusal = prior ? prior.refusal : refusal;
      let started: number | undefined, previous: number | undefined;
      const physicalDeadline = Math.min(
        physicalStarted + maxOperation,
        prior?.physicalDeadline ?? Infinity,
      );
      const tick = () => {
        let owns = false;
        try {
          requireConsumer(!fenced && !checking);
          if (expected !== undefined) this.#ticket(expected);
          checking = true;
          owns = true;
          return this.#hooks(fence, () => {
            synchronousRefusal(capturedRefusal);
            const at = this.#now();
            time(at);
            synchronousRefusal(capturedRefusal);
            if (started === undefined) started = at;
            const deadline = Math.min(started + maxOperation, prior?.deadline ?? Infinity);
            requireConsumer(
              !fenced &&
                checking &&
                !prior?.fenced &&
                at >= (previous ?? started) &&
                at < deadline &&
                performance.now() < physicalDeadline,
            );
            previous = at;
            return at;
          });
        } catch {
          fence();
          throw new Error("invalid-control-consumer");
        } finally {
          if (owns) checking = false;
        }
      };
      const origin = tick();
      const deadline = Math.min(origin + maxOperation, prior?.deadline ?? Infinity);
      const capture = <T>(work: () => T): T => {
        tick();
        let owns = false;
        try {
          requireConsumer(!fenced && !checking);
          checking = true;
          owns = true;
          const value = this.#hooks(fence, work);
          requireConsumer(!fenced && checking);
          return value;
        } catch {
          fence();
          throw new Error("invalid-control-consumer");
        } finally {
          if (owns) checking = false;
          tick();
        }
      };
      const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const remaining = Math.min(deadline - tick(), physicalDeadline - performance.now());
          requireConsumer(remaining > 0);
          const result = await Promise.race([
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                fence();
                reject(new Error("invalid-control-consumer"));
              }, remaining);
            }),
            Promise.resolve().then(() => {
              tick();
              return operation();
            }),
          ]);
          tick();
          return result;
        } catch (error) {
          fence();
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };
      const readAnchor = async () => {
        const value = await wait(() =>
          this.#anchor(structuredClone(this.#scope), () => {
            tick();
          }),
        );
        const at = tick();
        return capture(() => anchor(structuredClone(value), this.#scope, at));
      };
      const first = await readAnchor();
      requireConsumer(first.repair.mode !== "repairing");
      const prefix = `recovery/${this.#scope.target}/`;
      const metadata = async () => {
        const registration = await wait(() =>
          this.#read(`${prefix}registration`, () => {
            tick();
          }),
        );
        const current = await wait(() =>
          this.#read(`${prefix}current`, () => {
            tick();
          }),
        );
        return capture(() => [byteHash(registration), byteHash(current)]);
      };
      const original = await metadata();
      if (first.repair.mode === "never-repaired")
        requireConsumer(original.every((hash) => hash === null));
      else {
        requireConsumer(original.every((hash) => hash !== null));
        const generation = first.repair.generation;
        // This trusted callback must perform the whole linked-history + final-run guard.
        // A Boolean is not a completion receipt; the bound method resolves void or throws.
        requireConsumer(
          (await wait(() =>
            this.#confirm({ ...structuredClone(this.#scope), generation }, () => {
              tick();
            }),
          )) === undefined,
        );
      }
      const final = await readAnchor();
      requireConsumer(isDeepStrictEqual(identity(first), identity(final)));
      requireConsumer(isDeepStrictEqual(await metadata(), original));
      anchor(first, this.#scope, tick());
      anchor(final, this.#scope, tick());
      if (prior)
        requireConsumer(
          isDeepStrictEqual(identity(first), prior.identity) &&
            isDeepStrictEqual(original, prior.metadata),
        );
      const ticket = Object.freeze({}) as ControlConsumerTicket;
      const ticketDeadline = Math.min(
        deadline,
        first.expires_at,
        final.expires_at,
        first.observed_at + freshAge,
        final.observed_at + freshAge,
      );
      this.#tickets.set(ticket, {
        identity: identity(first),
        metadata: original,
        issued: prior?.issued ?? origin,
        last: tick(),
        deadline: ticketDeadline,
        // A frozen injected wall clock cannot renew real elapsed-time authority.
        physicalDeadline: Math.min(physicalDeadline, physicalStarted + ticketDeadline - origin),
        refusal: capturedRefusal,
        fenced: false,
        checking: false,
      });
      this.#ticket(ticket);
      return ticket;
    } catch {
      fence();
      throw new Error("control-consumer-guard-failed");
    }
  }
}

/**
 * Expose only guarded normal record access; recovery itself must retain a separate raw store.
 * Guards/readback are not mutual exclusion. The enclosing workflow/owner fence is still required.
 */
export function guardedControlStore(
  store: ControlStore,
  guard: ControlConsumerGuard,
): ControlStore {
  const captured = capturedStores.get(guard);
  if (!captured || captured.source !== store) throw new Error("invalid-control-consumer-store");
  const { read, write, allowed, within, assert } = captured;
  const check = guard.check.bind(guard);
  return Object.freeze({
    async read(path: string, beforeRead?: () => void): Promise<Uint8Array | null> {
      const original = originalRefusal(beforeRead);
      try {
        const refusal = beforeRead;
        requireConsumer(refusal === undefined || typeof refusal === "function");
        // Recovery metadata belongs only to the repair writer, before any owner/backend I/O.
        requireConsumer(typeof path === "string" && allowed.test(path));
        const ticket = await check(undefined, original.check);
        const fence = () => {
          assert(ticket);
        };
        const value = await within(ticket, () => read(path, fence));
        assert(ticket);
        const snapshot = value === null ? null : copyBytes(value);
        assert(ticket);
        await check(ticket, original.check);
        assert(ticket);
        return snapshot;
      } catch {
        original.stop();
        throw new Error("control-consumer-read-failed");
      }
    },
    async write(path: string, value: Uint8Array, beforeWrite?: () => void): Promise<void> {
      const original = originalRefusal(beforeWrite);
      try {
        const fence = beforeWrite;
        requireConsumer(
          (fence === undefined || typeof fence === "function") &&
            typeof path === "string" &&
            allowed.test(path) &&
            value instanceof Uint8Array,
        );
        const snapshot = copyBytes(value);
        requireConsumer(snapshot.length > 0);
        const ticket = await check(undefined, original.check);
        await within(ticket, () => {
          // A journal execution capability must still be live AFTER the awaited owner check.
          // This is an internal denial fence, never caller-supplied approval or a storage lock.
          const mutationFence = () => {
            assert(ticket);
          };
          mutationFence();
          return write(path, snapshot, mutationFence);
        });
        await check(ticket, original.check);
        assert(ticket);
      } catch {
        original.stop();
        // A late guard/ack failure may follow persistence; this never grants retry authority.
        // The deadline bounds this result, not an already in-flight remote write's outcome.
        throw new Error("control-consumer-write-failed");
      }
    },
  });
}
