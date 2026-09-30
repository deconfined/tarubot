/**
 * Mandatory ordinary-journal factory: private scoped storage -> independent current owner
 * boundary -> per-object consumer guard -> encrypted journal. No environment/secret lookup,
 * raw transport, repair capability or caller-supplied approval callback is exposed.
 *
 * This deliberately retains the existing guard: completed-repair access costs 68 GitHub GETs
 * per ordinary object I/O. Remaining host integration, owner-only configuration administration,
 * independent writer fencing and a separately reviewed bounded-operation design remain activation
 * prerequisites. Fresh checks/readbacks are not locks; failed acknowledgements grant no retry.
 */
import { isDeepStrictEqual } from "node:util";
import { ControlConsumerGuard, guardedControlStore } from "./control-consumer.js";
import {
  GitHubControlOwnerBoundary,
  type ControlOwnerBoundaryConfiguration,
} from "./control-owner-boundary.js";
import type { VersionedControlStore } from "./control-recovery.js";
import { createControlStorage, type ControlStorageConfig } from "./control-storage.js";
import { InfrastructureJournal, RecordCodec } from "./infra-control.js";
import { createInfrastructureBaselineRunVerifier } from "./infra-baseline-run.js";
import { TrustJournal, type TargetRole, type ValidatorPin } from "./ssh-trust.js";
import type { GitHubReader } from "./trust-run.js";

type OwnerConfiguration = Pick<
  ControlOwnerBoundaryConfiguration,
  "owner_id" | "repository_id" | "environment_id" | "token"
>;
interface CommonConfiguration {
  /** Exact historical codec identity, never the scoped store's routing-purpose binding. */
  backend: string;
  passphrase: string;
  storage: ControlStorageConfig;
  owner: OwnerConfiguration;
}
export interface InfrastructureJournalConfiguration extends CommonConfiguration {
  target: "infra";
}
export interface TrustJournalConfiguration extends CommonConfiguration {
  target: TargetRole;
  validator: ValidatorPin;
}
export type ControlJournalConfiguration =
  | InfrastructureJournalConfiguration
  | TrustJournalConfiguration;
type StorageDependencies = NonNullable<Parameters<typeof createControlStorage>[1]>;
interface Dependencies {
  /** Trusted internal invented-test seams only; never CLI/environment-selected transports. */
  createClient?: StorageDependencies["createClient"];
  get?: GitHubReader;
  now?: () => number;
}
type Value = Record<string, unknown>;
function requireFactory(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-journal-factory");
}
function exact(value: unknown, keys: string[]): Value {
  requireFactory(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Value;
  requireFactory(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
/** Capture plain bounded configuration before any native constructor or awaited authority I/O. */
function snapshot(input: unknown): unknown {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    requireFactory(depth <= 16 && ++nodes <= 4096);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      requireFactory(Number.isFinite(value));
      return value;
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      requireFactory(bytes <= 65_536);
      return value;
    }
    requireFactory(
      value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !ancestors.has(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
          Object.getPrototypeOf(value) === null),
    );
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireFactory(Reflect.ownKeys(value).length === Object.keys(descriptors).length);
    const result: Value = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      requireFactory(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"));
      bytes += Buffer.byteLength(key);
      requireFactory(bytes <= 65_536);
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}
function configuration(value: unknown): ControlJournalConfiguration {
  const copied = snapshot(value) as Value;
  const c = exact(
    copied,
    copied?.target === "infra"
      ? ["target", "backend", "passphrase", "storage", "owner"]
      : ["target", "backend", "passphrase", "storage", "owner", "validator"],
  );
  requireFactory(c.target === "infra" || c.target === "staging" || c.target === "production");
  requireFactory(typeof c.backend === "string" && /^[a-f0-9]{64}$/u.test(c.backend));
  requireFactory(typeof c.passphrase === "string" && c.passphrase.length >= 32);
  const owner = exact(c.owner, ["owner_id", "repository_id", "environment_id", "token"]);
  for (const name of ["owner_id", "repository_id", "environment_id"])
    requireFactory(
      typeof owner[name] === "number" && Number.isSafeInteger(owner[name]) && owner[name] > 0,
    );
  requireFactory(typeof owner.token === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(owner.token));
  const storage = exact(c.storage, ["scope", "bucket", "endpoint", "region", "credentials"]);
  requireFactory(storage.scope === (c.target === "infra" ? "infra" : `trust-${c.target}`));
  exact(storage.credentials, ["accessKeyId", "secretAccessKey", "sessionToken"]);
  if (c.target !== "infra") {
    const pin = exact(c.validator, [
      "name",
      "version",
      "mode",
      "binary_sha256",
      "anchor_sha256",
      "runtime_manifest_sha256",
    ]);
    requireFactory(
      pin.name === "unbound" && pin.version === "1.26.1" && pin.mode === "local-validating",
    );
    for (const name of ["binary_sha256", "anchor_sha256", "runtime_manifest_sha256"])
      requireFactory(typeof pin[name] === "string" && /^[a-f0-9]{64}$/u.test(pin[name]));
  }
  return c as unknown as ControlJournalConfiguration;
}

export function createControlJournal(
  value: InfrastructureJournalConfiguration,
  dependencies?: Dependencies,
): InfrastructureJournal;
export function createControlJournal(
  value: TrustJournalConfiguration,
  dependencies?: Dependencies,
): TrustJournal;
export function createControlJournal(
  value: ControlJournalConfiguration,
  dependencies?: Dependencies,
): InfrastructureJournal | TrustJournal;
export function createControlJournal(
  value: ControlJournalConfiguration,
  dependencies: Dependencies = {},
): InfrastructureJournal | TrustJournal {
  try {
    const c = configuration(value);
    const createClient = dependencies.createClient,
      get = dependencies.get,
      now = dependencies.now;
    requireFactory(createClient === undefined || typeof createClient === "function");
    requireFactory(get === undefined || typeof get === "function");
    requireFactory(now === undefined || typeof now === "function");
    const raw = createControlStorage(c.storage, createClient === undefined ? {} : { createClient });
    const scope = { target: c.target, backend: c.backend, namespace: raw.namespace };
    const rawRead = raw.read.bind(raw);
    const denied = async (): Promise<never> => {
      throw new Error("control-journal-recovery-refused");
    };
    // The completed-repair reader requires only latest raw metadata. It cannot restore, discover
    // versions or write: a real owner-fenced recovery adapter must be provisioned separately.
    const metadata: VersionedControlStore = Object.freeze({
      read: rawRead,
      write: denied,
      readVersion: denied,
    });
    const common = { ...scope, passphrase: c.passphrase, ...c.owner };
    const ownerConfiguration: ControlOwnerBoundaryConfiguration =
      c.target === "infra"
        ? { ...common, target: c.target }
        : { ...common, target: c.target, validator: c.validator };
    const owner = new GitHubControlOwnerBoundary(ownerConfiguration, {
      store: metadata,
      ...(get === undefined ? {} : { get }),
      ...(now === undefined ? {} : { now }),
    });
    const guard = new ControlConsumerGuard(scope, {
      store: raw,
      owner,
      ...(now === undefined ? {} : { now }),
    });
    const store = guardedControlStore(raw, guard);
    const journal =
      c.target === "infra"
        ? new InfrastructureJournal(store, new RecordCodec(c.passphrase, c.backend), {
            // Capture actual native evidence, never a caller-selected approval/receipt callback.
            verifyBaselineRun: createInfrastructureBaselineRunVerifier(
              {
                owner_id: c.owner.owner_id,
                repository_id: c.owner.repository_id,
                token: c.owner.token,
              },
              { ...(get === undefined ? {} : { get }), ...(now === undefined ? {} : { now }) },
            ),
          })
        : new TrustJournal(store, {
            target: c.target,
            backend: c.backend,
            passphrase: c.passphrase,
            validator: c.validator,
            ...(now === undefined ? {} : { now }),
          });
    Object.freeze(journal);
    return journal;
  } catch {
    throw new Error("invalid-control-journal-factory");
  }
}
