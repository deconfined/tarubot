/**
 * Runtime transports for a future serialized trust adapter. Credentials are explicit private
 * constructor inputs; no environment, CLI, token-file, dispatch or provider state access exists.
 * Readbacks are checks under that writer boundary, never locks, CAS or permission to retry.
 */
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  targetDescriptor,
  type DnsWriter,
  type PublicationRequest,
  type Sshfp,
  type SshfpRecord,
  type TargetDescriptor,
  type TargetRole,
} from "./ssh-trust.js";

type Value = Record<string, unknown>;
const linodeOrigin = "https://api.linode.com";
const cloudflareOrigin = "https://api.cloudflare.com";
const maxBody = 1_048_576;
const maxPages = 20;
const perPage = 50;
const idPattern = /^[a-f0-9]{32}$/u;
const generationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const namePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
function requireProvider(value: unknown): asserts value {
  if (!value) throw new Error("invalid-trust-provider");
}
function object(value: unknown): Value {
  requireProvider(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireProvider(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  requireProvider(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
  );
}
function recordId(value: unknown): asserts value is string {
  requireProvider(typeof value === "string" && idPattern.test(value));
}
function dnsName(value: unknown): asserts value is string {
  requireProvider(
    typeof value === "string" &&
      value.length <= 253 &&
      namePattern.test(value) &&
      isIP(value) === 0,
  );
}
function token(value: unknown): asserts value is string {
  requireProvider(typeof value === "string" && /^[A-Za-z0-9._-]{20,2048}$/u.test(value));
}
function sshfp(value: unknown): Sshfp {
  const data = exact(value, ["algorithm", "digest_type", "fingerprint"]);
  requireProvider(
    data.algorithm === 4 &&
      data.digest_type === 2 &&
      typeof data.fingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(data.fingerprint),
  );
  return structuredClone(data) as unknown as Sshfp;
}

export interface ProviderRequest {
  url: string;
  method: "GET" | "POST" | "PATCH";
  headers: Record<string, string>;
  body: string | null;
  timeout_ms: number;
  body_limit: 1048576;
  redirect: "error";
}
export interface ProviderResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
/** Internal test seam only. Future adapters must not let a CLI supply a transport or URL. */
export type ProviderTransport = (request: ProviderRequest) => Promise<ProviderResponse>;
type Dependencies = { request?: ProviderTransport; now?: () => number };

/** Native direct HTTPS never follows a redirect or retries an uncertain mutation. */
const directRequest: ProviderTransport = (input) =>
  new Promise((accept, reject) => {
    const url = new URL(input.url);
    requireProvider(
      (url.origin === linodeOrigin || url.origin === cloudflareOrigin) &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "",
    );
    requireProvider(input.method === "GET" || input.method === "POST" || input.method === "PATCH");
    requireProvider(url.origin !== linodeOrigin || input.method === "GET");
    integer(input.timeout_ms, 1, 10000);
    requireProvider(input.body === null || Buffer.byteLength(input.body) <= 4096);
    const agent = new Agent({ keepAlive: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: ProviderResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (value) accept(value);
      else reject(new Error("invalid-trust-provider"));
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
      },
      (response) => {
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.body_limit) {
            finish();
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          // Raw headers retain duplicates so an ambiguous content-type/encoding cannot disappear.
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase();
            const value = response.rawHeaders[i + 1];
            if (name !== undefined && value !== undefined)
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
    request.end(input.body ?? undefined);
  });

/** Each operation has a fresh bounded session; credentials cannot cross the fixed provider origin. */
class ApiSession {
  readonly #started: number;
  #lastObserved: number;
  readonly #origin: string;
  readonly #credential: string;
  readonly #dependencies: Required<Dependencies>;
  constructor(origin: string, credential: string, dependencies: Required<Dependencies>) {
    this.#origin = origin;
    this.#credential = credential;
    this.#dependencies = dependencies;
    this.#started = this.#time();
    this.#lastObserved = this.#started;
  }
  #time(): number {
    const value = this.#dependencies.now();
    integer(value, 1, Number.MAX_SAFE_INTEGER);
    return value;
  }
  checkedTime(): number {
    const value = this.#time();
    requireProvider(value >= this.#lastObserved && value - this.#started <= 60_000);
    this.#lastObserved = value;
    return value;
  }
  async call(
    path: string,
    method: ProviderRequest["method"] = "GET",
    value?: unknown,
  ): Promise<unknown> {
    requireProvider(path.startsWith("/") && !path.startsWith("//") && !path.includes("#"));
    const remaining = 60_000 - (this.checkedTime() - this.#started);
    requireProvider(remaining > 0);
    const url = `${this.#origin}${path}`;
    const body = value === undefined ? null : JSON.stringify(value);
    requireProvider((method === "GET") === (body === null));
    requireProvider(body === null || Buffer.byteLength(body) <= 4096);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "TaruBot-trust-provider",
      Authorization: `Bearer ${this.#credential}`,
    };
    if (body !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const response = await this.#dependencies.request({
      url,
      method,
      headers,
      body,
      timeout_ms: Math.min(10_000, remaining),
      body_limit: maxBody,
      redirect: "error",
    });
    requireProvider(
      response.status === 200 &&
        response.url === url &&
        response.body instanceof Uint8Array &&
        response.body.length > 0 &&
        response.body.length <= maxBody,
    );
    const h: Record<string, string> = {};
    let headerBytes = 0;
    for (const [name, value] of Object.entries(object(response.headers))) {
      const lower = name.toLowerCase();
      requireProvider(typeof value === "string" && !Object.hasOwn(h, lower));
      headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      requireProvider(headerBytes <= 16384);
      h[lower] = value;
    }
    // This field is not a list: joined duplicates and unrecognized charset/parameters fail.
    requireProvider(
      typeof h["content-type"] === "string" &&
        /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
          h["content-type"],
        ),
    );
    requireProvider(
      h.location === undefined &&
        h.link === undefined &&
        (h["content-encoding"] === undefined || h["content-encoding"] === "identity"),
    );
    this.checkedTime();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown;
  }
}

/**
 * GET only; owner supplies a linodes:read_only token scoped to the bound existing instance.
 * Primary schema: https://techdocs.akamai.com/linode-api/reference/get-linode-instance
 * https://github.com/linode/linodego/blob/main/instances.go (ID/status/IPv4/IPv6 fields).
 * The current reviewed module models exactly one IPv4; extra private/secondary addresses refuse.
 * Provider identity confirms the applied descriptor, never invents a baseline or enrollment grant.
 */
export class LinodeInstanceReader {
  // Runtime-private fields keep constructor secrets and mutable authority out of diagnostics.
  readonly #descriptor: TargetDescriptor;
  readonly #credential: string;
  readonly #dependencies: Required<Dependencies>;
  constructor(
    options: { token: string; descriptor: TargetDescriptor },
    dependencies: Dependencies = {},
  ) {
    try {
      const input = exact(structuredClone(options), ["token", "descriptor"]);
      token(input.token);
      this.#credential = input.token;
      this.#descriptor = targetDescriptor(input.descriptor);
      requireProvider(Number.isSafeInteger(Number(this.#descriptor.instance_id)));
      this.#dependencies = {
        request: dependencies.request ?? directRequest,
        now: dependencies.now ?? Date.now,
      };
    } catch {
      throw new Error("invalid-trust-provider");
    }
  }
  async verify(): Promise<TargetDescriptor> {
    try {
      const d = this.#descriptor;
      const session = new ApiSession(linodeOrigin, this.#credential, this.#dependencies);
      const result = object(await session.call(`/v4/linode/instances/${d.instance_id}`));
      requireProvider(result.id === Number(d.instance_id) && result.status === "running");
      requireProvider(isDeepStrictEqual(result.ipv4, [d.addresses.ipv4]));
      requireProvider(typeof result.ipv6 === "string" && result.ipv6.endsWith("/128"));
      const address = result.ipv6.slice(0, -4);
      requireProvider(
        isIP(address) === 6 &&
          new URL(`http://[${address}]/`).hostname.slice(1, -1) === d.addresses.ipv6,
      );
      session.checkedTime();
      return structuredClone(d);
    } catch {
      throw new Error("invalid-trust-provider");
    }
  }
}

interface DnsScope {
  target: TargetRole;
  zone_id: string;
  name: string;
}
function publication(value: unknown, scope: DnsScope): PublicationRequest {
  const r = exact(value, [
    "target",
    "generation",
    "zone_id",
    "name",
    "type",
    "record_id",
    "previous",
    "sshfp",
  ]);
  requireProvider(
    r.target === scope.target &&
      r.zone_id === scope.zone_id &&
      r.name === scope.name &&
      r.type === "SSHFP",
  );
  requireProvider(typeof r.generation === "string" && generationPattern.test(r.generation));
  sshfp(r.sshfp);
  if (r.previous === null) requireProvider(r.record_id === null);
  else {
    const prior = exact(r.previous, ["id", "zone_id", "name", "type", "sshfp"]);
    recordId(prior.id);
    requireProvider(
      r.record_id === prior.id &&
        prior.zone_id === scope.zone_id &&
        prior.name === scope.name &&
        prior.type === "SSHFP",
    );
    sshfp(prior.sshfp);
  }
  return structuredClone(r) as unknown as PublicationRequest;
}
interface ParsedRecord {
  record: SshfpRecord | null;
  id: string;
  ttl: number;
}
/** Provider `data.type` is the SSHFP digest type; optional formatted content must agree. */
function parseRecord(value: unknown, scope: DnsScope): ParsedRecord {
  const r = object(value);
  recordId(r.id);
  requireProvider(
    r.type === "SSHFP" &&
      typeof r.name === "string" &&
      r.name.toLowerCase().replace(/\.$/u, "") === scope.name,
  );
  requireProvider(r.zone_id === undefined || r.zone_id === scope.zone_id);
  integer(r.ttl, 1, 86400);
  requireProvider(r.ttl === 1 || r.ttl >= 30);
  requireProvider(r.proxied === undefined || r.proxied === false);
  const data = exact(r.data, ["algorithm", "type", "fingerprint"]);
  integer(data.algorithm, 1, 255);
  integer(data.type, 1, 255);
  requireProvider(
    typeof data.fingerprint === "string" && /^(?:[A-Fa-f0-9]{2}){1,64}$/u.test(data.fingerprint),
  );
  const fingerprint = data.fingerprint.toLowerCase();
  if (data.type === 1) requireProvider(fingerprint.length === 40);
  if (data.type === 2) requireProvider(fingerprint.length === 64);
  if (r.content !== undefined) {
    requireProvider(typeof r.content === "string");
    const content = /^([1-9][0-9]{0,2})[ \t]+([1-9][0-9]{0,2})[ \t]+([A-Fa-f0-9]+)$/u.exec(
      r.content,
    );
    requireProvider(
      content &&
        Number(content[1]) === data.algorithm &&
        Number(content[2]) === data.type &&
        content[3]?.toLowerCase() === fingerprint,
    );
  }
  return {
    id: r.id,
    ttl: r.ttl,
    record:
      data.algorithm === 4 && data.type === 2
        ? {
            id: r.id,
            zone_id: scope.zone_id,
            name: scope.name,
            type: "SSHFP",
            sshfp: { algorithm: 4, digest_type: 2, fingerprint },
          }
        : null,
  };
}
function envelope(value: unknown): Value {
  const e = object(value);
  requireProvider(
    e.success === true &&
      Array.isArray(e.errors) &&
      e.errors.length === 0 &&
      Array.isArray(e.messages) &&
      e.messages.length <= 100,
  );
  return e;
}

/**
 * Cloudflare's owner-created token must be restricted to this zone's DNS read/write only.
 * Primary contracts: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
 * and /get/, /create/, /edit/. Exact-name filters use name.exact, matching the official SDK's
 * allowDots serializer: https://github.com/cloudflare/cloudflare-typescript/blob/main/src/internal/utils/query.ts
 * Current edit schema requires name/ttl/type; patch replays those freshly read unchanged values
 * and omits comment/tags/settings/proxied. No API call can delete or alter another record type.
 */
export class CloudflareSshfpWriter implements DnsWriter {
  // TypeScript-only privacy would expose tokens and the write fence as ordinary properties.
  readonly #scope: DnsScope;
  readonly #credential: string;
  readonly #dependencies: Required<Dependencies>;
  readonly #beforeWrite: (request: PublicationRequest) => Promise<void>;
  constructor(
    options: DnsScope & {
      token: string;
      beforeWrite: (request: PublicationRequest) => Promise<void>;
    },
    dependencies: Dependencies = {},
  ) {
    try {
      // Capture the trusted callback separately: only plain constructor authority is cloned.
      const { beforeWrite, ...configuration } = options;
      const o = exact(structuredClone(configuration), ["token", "target", "zone_id", "name"]);
      token(o.token);
      recordId(o.zone_id);
      dnsName(o.name);
      requireProvider(
        (o.target === "staging" || o.target === "production") && typeof beforeWrite === "function",
      );
      this.#credential = o.token;
      this.#scope = { target: o.target, zone_id: o.zone_id, name: o.name };
      this.#beforeWrite = beforeWrite;
      this.#dependencies = {
        request: dependencies.request ?? directRequest,
        now: dependencies.now ?? Date.now,
      };
    } catch {
      throw new Error("invalid-trust-provider");
    }
  }
  #path(id?: string): string {
    return `/client/v4/zones/${this.#scope.zone_id}/dns_records${id ? `/${id}` : ""}`;
  }
  async #records(session: ApiSession): Promise<SshfpRecord[]> {
    const found: SshfpRecord[] = [];
    const ids = new Set<string>();
    let total = -1;
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const query = new URLSearchParams({
        type: "SSHFP",
        "name.exact": this.#scope.name,
        match: "all",
        page: String(page),
        per_page: String(perPage),
      });
      const e = envelope(await session.call(`${this.#path()}?${query}`));
      requireProvider(Array.isArray(e.result) && e.result.length <= perPage);
      const info = exact(e.result_info, [
        "page",
        "per_page",
        "count",
        "total_count",
        "total_pages",
      ]);
      integer(info.total_count, 0, maxPages * perPage);
      integer(info.total_pages, 0, maxPages);
      requireProvider(
        info.page === page && info.per_page === perPage && info.count === e.result.length,
      );
      const reportedPages = Math.max(1, info.total_pages);
      requireProvider(reportedPages === Math.max(1, Math.ceil(info.total_count / perPage)));
      if (page === 1) {
        total = info.total_count;
        pages = reportedPages;
      }
      requireProvider(info.total_count === total && reportedPages === pages);
      requireProvider(e.result.length === Math.min(perPage, total - (page - 1) * perPage));
      for (const raw of e.result) {
        const parsed = parseRecord(raw, this.#scope);
        requireProvider(!ids.has(parsed.id));
        ids.add(parsed.id);
        if (parsed.record) found.push(parsed.record);
      }
    }
    requireProvider(ids.size === total);
    return found;
  }
  async read(value: PublicationRequest): Promise<SshfpRecord[]> {
    try {
      publication(value, this.#scope);
      const session = new ApiSession(cloudflareOrigin, this.#credential, this.#dependencies);
      const records = await this.#records(session);
      session.checkedTime();
      return records;
    } catch {
      throw new Error("invalid-trust-provider");
    }
  }
  async write(value: PublicationRequest): Promise<SshfpRecord> {
    try {
      const request = publication(value, this.#scope);
      const session = new ApiSession(cloudflareOrigin, this.#credential, this.#dependencies);
      const before = await this.#records(session);
      let priorTtl = 300;
      if (request.previous === null) requireProvider(before.length === 0);
      else {
        requireProvider(before.length === 1 && isDeepStrictEqual(before[0], request.previous));
        const prior = parseRecord(
          envelope(await session.call(this.#path(request.previous.id))).result,
          this.#scope,
        );
        requireProvider(isDeepStrictEqual(prior.record, request.previous));
        priorTtl = prior.ttl;
      }
      // REQUIRED trusted boundary: recheck durable intent, serialized writer and live owner grant
      // after API reads. Returning a CLI Boolean or echoing request shape is not an implementation.
      const boundary = await this.#beforeWrite(structuredClone(request));
      // This is an assertion boundary that throws on refusal, never a Boolean approval input.
      requireProvider(boundary === undefined);
      session.checkedTime();
      const payload = {
        name: request.name,
        type: "SSHFP",
        ttl: priorTtl,
        data: { algorithm: 4, type: 2, fingerprint: request.sshfp.fingerprint },
      };
      const result = parseRecord(
        envelope(
          await session.call(
            this.#path(request.record_id ?? undefined),
            request.previous === null ? "POST" : "PATCH",
            payload,
          ),
        ).result,
        this.#scope,
      );
      const record = result.record;
      requireProvider(
        record && result.ttl === priorTtl && isDeepStrictEqual(record.sshfp, request.sshfp),
      );
      requireProvider(request.previous === null || record.id === request.record_id);
      const reopened = parseRecord(
        envelope(await session.call(this.#path(record.id))).result,
        this.#scope,
      );
      requireProvider(isDeepStrictEqual(reopened.record, record) && reopened.ttl === priorTtl);
      const after = await this.#records(session);
      requireProvider(after.length === 1 && isDeepStrictEqual(after[0], record));
      session.checkedTime();
      return structuredClone(record);
    } catch {
      throw new Error("invalid-trust-provider");
    }
  }
}
