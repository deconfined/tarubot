/**
 * Independent current GitHub owner configuration for ordinary control-record consumers.
 * No environment mutation, secret/env lookup, repair, provider, host or state operation.
 * The owner must provision configuration administration and reader credentials separately:
 * reviewer gates do NOT prove who can edit a variable. Normal workflow/S3 writers must have
 * no configuration write permission, and the owner must independently fence active writers.
 * Fresh GETs/readbacks are checks, never a storage lock, CAS or atomic writer fence.
 */
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type {
  ControlConsumerBoundary,
  ControlConsumerScope,
  OwnerControlAnchor,
} from "./control-consumer.js";
import {
  ControlRecovery,
  type OwnerRecoveryBoundary,
  type VersionedControlStore,
} from "./control-recovery.js";
import { privateDigest } from "./infra-control.js";
import {
  readTrustRun,
  type GitHubReader,
  type GitHubReadRequest,
  type GitHubReadResponse,
} from "./trust-run.js";

type Value = Record<string, unknown>;
const api = "https://api.github.com";
const prefix = "/repos/deconfined/tarubot";
const variableName = "CONTROL_OWNER_ANCHOR";
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const maxOperation = 60_000;
const maxFreshAge = 30_000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;

/** Future owner-created configuration environments; this module creates/changes none. */
export const controlOwnerEnvironments = Object.freeze({
  infra: "control-infra",
  staging: "control-staging",
  production: "control-production",
});

function requireOwner(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-owner-boundary");
}
function object(value: unknown): Value {
  requireOwner(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireOwner(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  requireOwner(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Bound plain authority snapshots never execute an accessor or retain caller-owned objects. */
function snapshot(input: unknown): unknown {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    requireOwner(++nodes <= 4096 && depth <= 16);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      requireOwner(Number.isFinite(value));
      return value;
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      requireOwner(bytes <= 65_536);
      return value;
    }
    requireOwner(value !== null && typeof value === "object" && !ancestors.has(value));
    ancestors.add(value);
    requireOwner(Object.getOwnPropertySymbols(value).length === 0);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let result: unknown;
    if (Array.isArray(value)) {
      requireOwner(value.length <= 1024 && Object.keys(descriptors).length === value.length + 1);
      result = Array.from({ length: value.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireOwner(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireOwner(
        Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      );
      const output: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireOwner(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireOwner(bytes <= 65_536);
        Object.defineProperty(output, key, {
          value: copy(item.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}
/** Reject duplicate decoded authority keys, including escaped equivalents and nested records. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  let index = 0,
    nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[index] ?? "")) index++;
  };
  const string = () => {
    requireOwner(source[index] === '"');
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("invalid-control-owner-boundary");
  };
  const value = (depth: number): void => {
    requireOwner(++nodes <= 65_536 && depth <= 64);
    whitespace();
    const first = source[index];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      index++;
      whitespace();
      const end = first === "{" ? "}" : "]",
        keys = new Set<string>();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          requireOwner(!keys.has(key));
          keys.add(key);
          whitespace();
          requireOwner(source[index++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[index++];
        if (next === end) return;
        requireOwner(next === ",");
      }
    }
    const start = index;
    while (index < source.length && !/^[,}\] \t\r\n]$/u.test(source[index] ?? "")) index++;
    requireOwner(index > start);
    JSON.parse(source.slice(start, index));
  };
  value(0);
  whitespace();
  requireOwner(index === source.length);
  return JSON.parse(source) as unknown;
}

type WithoutClock<T> = T extends unknown ? Omit<T, "now"> : never;
type RecoveryOptions = WithoutClock<ConstructorParameters<typeof ControlRecovery>[1]>;
export type ControlOwnerBoundaryConfiguration = RecoveryOptions & {
  owner_id: number;
  repository_id: number;
  environment_id: number;
  /** Explicit GET-only credential provisioned by the owner; never the S3 credential. */
  token: string;
};
interface OwnerRecord extends ControlConsumerScope {
  schema: 1;
  revision: string;
  repair:
    | { mode: "never-repaired" }
    | { mode: "repairing"; generation: string }
    | {
        mode: "completed-repair";
        generation: string;
        intent_digest: string;
        commit: string;
        run: string;
      };
}
interface CurrentRecord {
  record: OwnerRecord;
  identity: string;
  observed: number;
  physicalObserved: number;
}
interface Budget {
  now(): number;
  wait<T>(work: () => Promise<T>, whole?: boolean): Promise<T>;
  remaining(whole?: boolean): number;
}
function budget(clock: () => number): Budget {
  const started = clock();
  integer(started);
  const physicalStarted = performance.now();
  let last = started;
  const now = () => {
    const at = clock();
    integer(at);
    requireOwner(
      at >= last &&
        at - started < maxOperation &&
        performance.now() - physicalStarted < maxOperation,
    );
    last = at;
    return at;
  };
  const remaining = (whole = false) =>
    Math.min(
      whole ? maxOperation : 10_000,
      maxOperation - (now() - started),
      maxOperation - (performance.now() - physicalStarted),
    );
  return {
    now,
    remaining,
    async wait<T>(work: () => Promise<T>, whole = false): Promise<T> {
      const limit = remaining(whole);
      requireOwner(limit > 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("invalid-control-owner-boundary")), limit);
          }),
        ]);
        now();
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Isolated HTTPS, fixed GitHub API origin/repository, no ambient proxy/token or redirects. */
const directGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    if (
      input.method !== "GET" ||
      url.origin !== api ||
      url.username ||
      url.password ||
      url.hash ||
      !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
    ) {
      reject(new Error("invalid-control-owner-boundary"));
      return;
    }
    const agent = new Agent({ keepAlive: false });
    const chunks: Buffer[] = [];
    let size = 0,
      finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (response) accept(response);
      else reject(new Error("invalid-control-owner-boundary"));
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.github.com",
        servername: "api.github.com",
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: maxHeaders,
      },
      (response) => {
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.body_limit) {
            finish();
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.complete) {
            finish();
            return;
          }
          const headers: Record<string, string> = Object.create(null);
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const name = response.rawHeaders[index]?.toLowerCase(),
              value = response.rawHeaders[index + 1];
            if (name === undefined || value === undefined) {
              finish();
              return;
            }
            headers[name] = Object.hasOwn(headers, name) ? `${headers[name]},${value}` : value;
          }
          finish({
            status: response.statusCode ?? 0,
            url: input.url,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", () => finish());
    timer = setTimeout(() => {
      finish();
      request.destroy();
    }, input.timeout_ms);
    request.end();
  });

/** Read-only implementation of current ControlConsumerBoundary; no raw/key/restore capability. */
export class GitHubControlOwnerBoundary implements ControlConsumerBoundary {
  readonly #configuration: ControlOwnerBoundaryConfiguration;
  readonly #scope: ControlConsumerScope;
  readonly #rawRead: VersionedControlStore["read"];
  readonly #get: GitHubReader;
  readonly #clock: () => number;
  readonly #revisions = new Map<string, string>();
  #lastRevision: string | undefined;
  constructor(
    configuration: ControlOwnerBoundaryConfiguration,
    dependencies: {
      store: VersionedControlStore;
      get?: GitHubReader;
      now?: () => number;
    },
  ) {
    try {
      const c = object(snapshot(configuration));
      requireOwner(c.target === "infra" || c.target === "staging" || c.target === "production");
      exact(
        c,
        c.target === "infra"
          ? [
              "target",
              "backend",
              "namespace",
              "passphrase",
              "owner_id",
              "repository_id",
              "environment_id",
              "token",
            ]
          : [
              "target",
              "backend",
              "namespace",
              "passphrase",
              "validator",
              "owner_id",
              "repository_id",
              "environment_id",
              "token",
            ],
      );
      for (const field of ["owner_id", "repository_id", "environment_id"]) integer(c[field]);
      requireOwner(
        typeof c.backend === "string" &&
          sha.test(c.backend) &&
          typeof c.passphrase === "string" &&
          c.passphrase.length >= 32 &&
          typeof c.token === "string" &&
          /^[A-Za-z0-9._-]{20,2048}$/u.test(c.token),
      );
      const namespace = `tarubot/control/v1/${c.target === "infra" ? "infra" : `trust-${c.target}`}/`;
      requireOwner(c.namespace === namespace);
      if (c.target !== "infra") {
        const pin = exact(c.validator, [
          "name",
          "version",
          "mode",
          "binary_sha256",
          "anchor_sha256",
          "runtime_manifest_sha256",
        ]);
        requireOwner(
          pin.name === "unbound" && pin.version === "1.26.1" && pin.mode === "local-validating",
        );
        for (const field of ["binary_sha256", "anchor_sha256", "runtime_manifest_sha256"])
          requireOwner(typeof pin[field] === "string" && sha.test(pin[field]));
      }
      const store = dependencies.store,
        read = store.read,
        readVersion = store.readVersion;
      const get = dependencies.get ?? directGet,
        clock = dependencies.now ?? Date.now;
      requireOwner(
        typeof read === "function" &&
          typeof readVersion === "function" &&
          typeof get === "function" &&
          typeof clock === "function",
      );
      this.#configuration = c as unknown as ControlOwnerBoundaryConfiguration;
      this.#scope = { target: c.target, backend: c.backend, namespace } as ControlConsumerScope;
      this.#rawRead = read.bind(store);
      this.#get = get;
      this.#clock = clock;
      Object.freeze(this);
    } catch {
      throw new Error("invalid-control-owner-boundary");
    }
  }

  #scopeRequest(input: unknown, completed: boolean): void {
    const request = exact(
      snapshot(input),
      completed
        ? ["target", "backend", "namespace", "generation"]
        : ["target", "backend", "namespace"],
    );
    requireOwner(
      isDeepStrictEqual(
        { target: request.target, backend: request.backend, namespace: request.namespace },
        this.#scope,
      ),
    );
    if (completed)
      requireOwner(typeof request.generation === "string" && uuid.test(request.generation));
  }
  #headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      "User-Agent": "TaruBot-control-owner-boundary",
      Authorization: `Bearer ${this.#configuration.token}`,
    };
  }
  async #response(
    input: GitHubReadRequest,
    operation: Budget,
  ): Promise<{ response: GitHubReadResponse; value: unknown }> {
    requireOwner(
      input.method === "GET" &&
        input.redirect === "error" &&
        input.body_limit === maxBody &&
        input.url.startsWith(`${api}${prefix}`),
    );
    const response = await operation.wait(() =>
      this.#get({
        ...input,
        headers: { ...input.headers },
        timeout_ms: Math.min(input.timeout_ms, operation.remaining()),
      }),
    );
    requireOwner(
      response.status === 200 &&
        response.url === input.url &&
        response.body instanceof Uint8Array &&
        response.body.length > 0 &&
        response.body.length <= maxBody,
    );
    const h: Record<string, string> = Object.create(null);
    let size = 0;
    for (const [name, value] of Object.entries(object(response.headers))) {
      const lower = name.toLowerCase();
      requireOwner(
        /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
          typeof value === "string" &&
          !/[\r\n\0]/u.test(value) &&
          !Object.hasOwn(h, lower),
      );
      size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      requireOwner(size <= maxHeaders);
      h[lower] = value;
    }
    requireOwner(
      typeof h["content-type"] === "string" &&
        /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
          h["content-type"],
        ),
    );
    for (const name of ["location", "link", "content-range"]) requireOwner(!Object.hasOwn(h, name));
    requireOwner(
      (h["content-encoding"] === undefined || h["content-encoding"] === "identity") &&
        (h.age === undefined || h.age === "0"),
    );
    if (h["content-length"] !== undefined)
      requireOwner(
        /^(0|[1-9][0-9]*)$/u.test(h["content-length"]) &&
          Number(h["content-length"]) === response.body.length,
      );
    const bytes = Uint8Array.from(response.body);
    const value = json(bytes);
    return { value, response: { status: 200, url: input.url, headers: { ...h }, body: bytes } };
  }
  async #read(path: string, operation: Budget): Promise<unknown> {
    return (
      await this.#response(
        {
          url: `${api}${prefix}${path}`,
          method: "GET",
          headers: this.#headers(),
          timeout_ms: operation.remaining(),
          body_limit: maxBody,
          redirect: "error",
        },
        operation,
      )
    ).value;
  }
  #record(value: unknown): OwnerRecord {
    const record = exact(value, ["schema", "target", "backend", "namespace", "revision", "repair"]);
    requireOwner(
      record.schema === 1 &&
        typeof record.revision === "string" &&
        uuid.test(record.revision) &&
        isDeepStrictEqual(
          { target: record.target, backend: record.backend, namespace: record.namespace },
          this.#scope,
        ),
    );
    const repair = object(record.repair);
    if (repair.mode === "never-repaired") exact(repair, ["mode"]);
    else {
      requireOwner(repair.mode === "repairing" || repair.mode === "completed-repair");
      exact(
        repair,
        repair.mode === "repairing"
          ? ["mode", "generation"]
          : ["mode", "generation", "intent_digest", "commit", "run"],
      );
      requireOwner(typeof repair.generation === "string" && uuid.test(repair.generation));
      if (repair.mode === "completed-repair")
        requireOwner(
          typeof repair.intent_digest === "string" &&
            sha.test(repair.intent_digest) &&
            typeof repair.commit === "string" &&
            /^[a-f0-9]{40}$/u.test(repair.commit) &&
            typeof repair.run === "string" &&
            /^[1-9][0-9]{0,19}$/u.test(repair.run),
        );
    }
    return record as unknown as OwnerRecord;
  }
  async #current(operation: Budget): Promise<CurrentRecord> {
    // Include the first request's whole transport time; a slow repository response must not
    // mint a younger anchor after it arrives, including when an injected wall clock stands still.
    const observed = operation.now(),
      physicalObserved = performance.now();
    const repo = object(await this.#read("", operation));
    const owner = object(repo.owner);
    requireOwner(
      repo.id === this.#configuration.repository_id &&
        repo.full_name === "deconfined/tarubot" &&
        repo.fork === false &&
        owner.login === "deconfined" &&
        owner.id === this.#configuration.owner_id,
    );
    const name = controlOwnerEnvironments[this.#scope.target];
    const environment = object(await this.#read(`/environments/${name}`, operation));
    requireOwner(
      environment.id === this.#configuration.environment_id &&
        environment.name === name &&
        environment.url === `${api}${prefix}/environments/${name}`,
    );
    const variable = exact(
      await this.#read(`/environments/${name}/variables/${variableName}`, operation),
      ["name", "value", "created_at", "updated_at"],
    );
    requireOwner(
      variable.name === variableName &&
        typeof variable.value === "string" &&
        Buffer.byteLength(variable.value) <= 16_384,
    );
    const date = (value: unknown) => {
      requireOwner(
        typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value),
      );
      const result = Date.parse(value);
      requireOwner(Number.isFinite(result) && result > 0 && result <= operation.now());
      return result;
    };
    requireOwner(date(variable.updated_at) >= date(variable.created_at));
    const record = this.#record(json(Buffer.from(variable.value)));
    const identity = privateDigest({
      record,
      variable,
      repository_id: repo.id,
      owner_id: owner.id,
      environment: { id: environment.id, name: environment.name, url: environment.url },
    });
    const prior = this.#revisions.get(record.revision);
    requireOwner(prior === undefined || prior === identity);
    // Track contradictions only, never cached authority. Every successful operation still GETs.
    requireOwner(
      this.#lastRevision === undefined ||
        this.#lastRevision === record.revision ||
        prior === undefined,
    );
    requireOwner(prior !== undefined || this.#revisions.size < 128);
    this.#fresh({ record, identity, observed, physicalObserved }, operation);
    this.#revisions.set(record.revision, identity);
    this.#lastRevision = record.revision;
    return { record, identity, observed, physicalObserved };
  }
  #fresh(record: CurrentRecord, operation: Budget): void {
    requireOwner(
      operation.now() - record.observed < maxFreshAge &&
        performance.now() - record.physicalObserved < maxFreshAge,
    );
  }
  #same(before: CurrentRecord, after: CurrentRecord, operation: Budget): void {
    this.#fresh(before, operation);
    this.#fresh(after, operation);
    requireOwner(before.identity === after.identity);
  }

  /** Current authority comes from two whole independent GET rounds, never missing objects/cache. */
  async readOwnerAnchor(input: ControlConsumerScope): Promise<OwnerControlAnchor> {
    try {
      this.#scopeRequest(input, false);
      const operation = budget(this.#clock);
      const first = await this.#current(operation),
        final = await this.#current(operation);
      this.#same(first, final, operation);
      const r = final.record;
      const repair =
        r.repair.mode === "never-repaired"
          ? { mode: "never-repaired" as const }
          : { mode: r.repair.mode, generation: r.repair.generation };
      const remaining = Math.floor(maxFreshAge - (performance.now() - first.physicalObserved));
      requireOwner(remaining > 0);
      return freeze({
        ...this.#scope,
        schema: 1,
        revision: r.revision,
        repair,
        observed_at: first.observed,
        expires_at: Math.min(first.observed + maxFreshAge, operation.now() + remaining),
      });
    } catch {
      throw new Error("invalid-control-owner-boundary");
    }
  }

  /** Restore-only capabilities refuse; only completed encrypted metadata and final run are read. */
  async confirmCompletedRepair(
    input: ControlConsumerScope & { generation: string },
  ): Promise<void> {
    try {
      const request = snapshot(input) as ControlConsumerScope & { generation: string };
      this.#scopeRequest(request, true);
      const operation = budget(this.#clock);
      const first = await this.#current(operation);
      requireOwner(
        first.record.repair.mode === "completed-repair" &&
          first.record.repair.generation === request.generation,
      );
      const expected = first.record.repair;
      const denied = async (): Promise<never> => {
        throw new Error("invalid-control-owner-boundary");
      };
      const owner: OwnerRecoveryBoundary = {
        assertOwnerFence: denied,
        verifyOutcome: denied,
        confirmEnrollmentRun: denied,
        confirmRecoveryRun: async (runRequest) => {
          const current = await this.#current(operation);
          this.#same(first, current, operation);
          requireOwner(
            isDeepStrictEqual(runRequest, {
              target: this.#scope.target,
              backend: this.#scope.backend,
              generation: expected.generation,
              binding_digest: expected.intent_digest,
              run: { commit: expected.commit, run: expected.run },
            }),
          );
          const gate = `recover-${this.#scope.target}`;
          const allowed = new Set(
            [
              `/actions/runs/${expected.run}`,
              `/actions/runs/${expected.run}/attempts/1/jobs?per_page=100&page=1`,
              `/actions/runs/${expected.run}/approvals`,
              `/environments/${gate}`,
              `/environments/${gate}/deployment-branch-policies?per_page=100&page=1`,
              "/branches/main",
            ].map((path) => `${api}${prefix}${path}`),
          );
          const proof = await operation.wait(
            () =>
              readTrustRun(
                {
                  kind: "recovery",
                  target: this.#scope.target,
                  commit: expected.commit,
                  run: expected.run,
                },
                {
                  owner_id: this.#configuration.owner_id,
                  token: this.#configuration.token,
                  now: () => operation.now(),
                  get: async (readRequest) => {
                    requireOwner(allowed.has(readRequest.url));
                    const result = await this.#response(readRequest, operation);
                    if (readRequest.url === `${api}${prefix}/actions/runs/${expected.run}`) {
                      const run = object(result.value);
                      requireOwner(
                        object(run.repository).id === this.#configuration.repository_id &&
                          object(run.head_repository).id === this.#configuration.repository_id,
                      );
                    }
                    return result.response;
                  },
                },
              ),
            true,
          );
          integer(proof.observed_at);
          requireOwner(
            proof.observed_at <= operation.now() &&
              operation.now() - proof.observed_at < maxFreshAge,
          );
          const final = await this.#current(operation);
          this.#same(first, final, operation);
          return {
            schema: 1,
            target: this.#scope.target,
            backend: this.#scope.backend,
            generation: expected.generation,
            binding_digest: expected.intent_digest,
            commit: expected.commit,
            run: expected.run,
            attempt: 1,
            conclusion: "success",
          };
        },
      };
      const id = uuid.source.slice(1, -1);
      const metadata = new RegExp(
        `^recovery/${this.#scope.target}/(?:registration|current|(?:intents|completed)/${id})$`,
        "u",
      );
      const store: VersionedControlStore = {
        read: async (path) => {
          requireOwner(metadata.test(path));
          const value = await operation.wait(() => this.#rawRead(path));
          requireOwner(
            value === null ||
              (value instanceof Uint8Array && value.length > 0 && value.length <= 64 * 1024 * 1024),
          );
          return value === null ? null : Uint8Array.from(value);
        },
        write: denied,
        readVersion: denied,
      };
      // Historical codec binding is the exact configured backend identity, not physical routing.
      const {
        owner_id: _owner,
        repository_id: _repository,
        environment_id: _environment,
        token: _token,
        ...options
      } = this.#configuration;
      const recovery = new ControlRecovery(
        store,
        { ...options, now: () => operation.now() },
        owner,
      );
      await operation.wait(() => recovery.guardConsumer(expected.generation), true);
      const final = await this.#current(operation);
      this.#same(first, final, operation);
    } catch {
      throw new Error("invalid-control-owner-boundary");
    }
  }
}

/**
 * Primary GET contracts (API2026-03-10), with separate Environments:read provisioning:
 * https://docs.github.com/en/rest/actions/variables#get-an-environment-variable
 * https://docs.github.com/en/rest/deployments/environments#get-an-environment
 * https://docs.github.com/en/rest/repos/repos#get-a-repository
 * The variable API returns current value/timestamps, not editor identity or dispatch inputs.
 */
