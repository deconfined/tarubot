/**
 * GitHub-signed, private authentication of the exact applied-target sealing receipt.
 * No environment/token lookup, token minting, workflow, provider, host or storage operation.
 * The caller supplies a trusted private token reader; signature verification prevents that
 * reader from replacing authentication with a request echo. Public GET job success remains
 * independently mandatory in target-producer-run, including REST check_run_url attribution.
 */
import { constants, createPublicKey, verify as verifySignature } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { privateDigest } from "./infra-control.js";
import { releaseIdentity } from "./release-policy.js";
import type {
  AppliedTargetSealingRequest,
  AppliedTargetWriterIdentity,
  AuthenticatedAppliedTargetSealing,
} from "./target-producer-run.js";
import type { GitHubReader, GitHubReadResponse } from "./trust-run.js";

type Value = Record<string, unknown>;
const issuer = "https://token.actions.githubusercontent.com";
const jwksUrl = `${issuer}/.well-known/jwks`;
const repository = "deconfined/tarubot";
const publication = `${repository}/.github/workflows/publish.yml@refs/heads/main`;
const infrastructure = `${repository}/.github/workflows/release-infra.yml@refs/heads/main`;
const maxBody = 1_048_576;
const maxHeaders = 16_384;
const maxOperation = 60_000;
const maxProofAge = 30_000;
const maxJwtAge = 900_000;

function requireOidc(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-sealing-oidc");
}
function object(value: unknown): Value {
  requireOidc(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  requireOidc(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  requireOidc(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Copy authority data without invoking accessors, retaining shared bytes or following cycles. */
function snapshot(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    requireOidc(++nodes <= 4096 && depth <= 16);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireOidc(bytes <= 65_536);
      return input;
    }
    if (typeof input === "number") {
      requireOidc(Number.isFinite(input));
      return input;
    }
    requireOidc(input !== null && typeof input === "object" && !ancestors.has(input));
    ancestors.add(input);
    requireOidc(Object.getOwnPropertySymbols(input).length === 0);
    const properties = Object.getOwnPropertyDescriptors(input);
    let result: unknown;
    if (Array.isArray(input)) {
      requireOidc(input.length <= 1024 && Object.keys(properties).length === input.length + 1);
      result = Array.from({ length: input.length }, (_, index) => {
        const property = properties[String(index)];
        requireOidc(property?.enumerable === true && Object.hasOwn(property, "value"));
        return copy(property.value, depth + 1);
      });
    } else {
      requireOidc(
        Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null,
      );
      const output: Value = {};
      for (const [key, property] of Object.entries(properties)) {
        requireOidc(property.enumerable === true && Object.hasOwn(property, "value"));
        bytes += Buffer.byteLength(key);
        requireOidc(bytes <= 65_536);
        Object.defineProperty(output, key, {
          value: copy(property.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = output;
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}

/** Reject duplicate decoded keys before JSON.parse can silently replace a signed authority. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[ \t\r\n]$/u.test(source[index] ?? "")) index++;
  };
  const string = () => {
    requireOidc(source[index] === '"');
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("invalid-target-sealing-oidc");
  };
  const value = (depth: number): void => {
    requireOidc(++nodes <= 65_536 && depth <= 64);
    whitespace();
    const first = source[index];
    if (first === '"') {
      string();
      return;
    }
    if (first === "{" || first === "[") {
      index++;
      whitespace();
      const end = first === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (first === "{") {
          const key = string();
          requireOidc(!keys.has(key));
          keys.add(key);
          whitespace();
          requireOidc(source[index++] === ":");
        }
        value(depth + 1);
        whitespace();
        const next = source[index++];
        if (next === end) return;
        requireOidc(next === ",");
      }
    }
    const start = index;
    while (index < source.length && !/^[,}\] \t\r\n]$/u.test(source[index] ?? "")) index++;
    requireOidc(index > start);
    JSON.parse(source.slice(start, index));
  };
  value(0);
  whitespace();
  requireOidc(index === source.length);
  return JSON.parse(source) as unknown;
}

export interface AppliedTargetOidcWriter extends AppliedTargetWriterIdentity {
  /** Explicit configured ID must also match independently fetched run/head repository IDs. */
  repository_id: number;
  /** Parse the exact REST job.check_run_url; the Actions job ID is not an equivalent claim. */
  check_run_id: number;
}
export interface AppliedTargetOidcRequest extends AppliedTargetSealingRequest {
  writer: AppliedTargetOidcWriter;
}
/** Structurally compatible with the existing producer callback, retaining authenticated IDs. */
export interface AuthenticatedAppliedTargetOidc extends AuthenticatedAppliedTargetSealing {
  writer: AppliedTargetOidcWriter;
}
/** Minting happens during the sealing step; terminal status is supplied by later REST evidence. */
export interface AppliedTargetOidcAudienceRequest extends Omit<AppliedTargetOidcRequest, "writer"> {
  writer: Omit<AppliedTargetOidcWriter, "critical_step"> & {
    critical_step: {
      name: "Seal applied target descriptor";
      number: number;
      status: "in_progress" | "completed";
      conclusion: null | "success";
    };
  };
}
export interface AppliedTargetOidcConfiguration {
  owner_id: number;
  repository_id: number;
  /** Owner-reviewed literal subjects. Never select a default or copy a token's own subject. */
  subjects: { apply: string; "no-changes": string };
}
export type ReadAppliedTargetOidcToken = (request: AppliedTargetOidcRequest) => Promise<string>;

function contract(value: unknown, completed = true): AppliedTargetOidcRequest {
  const data = exact(value, ["request", "writer"]);
  const request = exact(data.request, ["receipt", "job", "requested_at"]);
  integer(request.requested_at);
  const receipt = exact(request.receipt, [
    "schema",
    "purpose",
    "target",
    "backend",
    "release",
    "producer",
    "mode",
    "path",
    "payload_digest",
    "ciphertext_digest",
    "issued_at",
    "expires_at",
  ]);
  const release = releaseIdentity(receipt.release);
  requireOidc(
    receipt.schema === 1 &&
      receipt.purpose === "tarubot-applied-target-handoff-v1" &&
      (receipt.target === "staging" || receipt.target === "production") &&
      (receipt.mode === "apply" || receipt.mode === "no-changes"),
  );
  for (const key of ["backend", "payload_digest", "ciphertext_digest"])
    requireOidc(typeof receipt[key] === "string" && /^[a-f0-9]{64}$/u.test(receipt[key]));
  integer(receipt.issued_at);
  integer(receipt.expires_at);
  requireOidc(
    receipt.expires_at > receipt.issued_at && receipt.expires_at - receipt.issued_at <= 3_600_000,
  );
  const producer = exact(receipt.producer, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  requireOidc(
    isDeepStrictEqual(producer, {
      repository,
      workflow_ref: publication,
      ref: "refs/heads/main",
      event: "push",
      attempt: 1,
      commit: release.commit,
      run: release.publication_run,
    }),
  );
  requireOidc(
    receipt.path ===
      `applied-target/${receipt.target}/${producer.run}/${producer.commit}/${receipt.payload_digest}`,
  );
  const job = exact(request.job, ["workflow_ref", "workflow_commit", "job_name", "critical_step"]);
  requireOidc(
    isDeepStrictEqual(job, {
      workflow_ref: infrastructure,
      workflow_commit: release.config_commit,
      job_name: receipt.mode === "apply" ? "Apply infrastructure" : "Plan infrastructure",
      critical_step: "Seal applied target descriptor",
    }),
  );
  const writer = exact(data.writer, [
    "repository",
    "repository_owner_id",
    "repository_id",
    "publication_workflow_ref",
    "ref",
    "event",
    "run",
    "attempt",
    "head_commit",
    "reusable_workflow_ref",
    "reusable_workflow_commit",
    "job_path",
    "job_id",
    "check_run_id",
    "critical_step",
  ]);
  for (const key of ["repository_owner_id", "repository_id", "job_id", "check_run_id"])
    integer(writer[key]);
  const step = exact(writer.critical_step, ["name", "number", "status", "conclusion"]);
  integer(step.number);
  requireOidc(
    step.name === job.critical_step &&
      ((step.status === "completed" && step.conclusion === "success") ||
        (!completed && step.status === "in_progress" && step.conclusion === null)) &&
      writer.repository === repository &&
      writer.publication_workflow_ref === publication &&
      writer.ref === "refs/heads/main" &&
      writer.event === "push" &&
      writer.attempt === 1 &&
      writer.run === producer.run &&
      writer.head_commit === release.commit &&
      writer.reusable_workflow_ref === infrastructure &&
      writer.reusable_workflow_commit === job.workflow_commit &&
      writer.job_path === `Replacement release orchestration / infrastructure / ${job.job_name}`,
  );
  return data as unknown as AppliedTargetOidcRequest;
}

/**
 * Producer-computable audience: consumer time and terminal statuses cannot be known at minting.
 * All receipt fields, expected job pins and stable writer IDs/critical-step name+number remain.
 * This digest and token stay private; do not emit them in an Actions output or public artifact.
 */
export function appliedTargetOidcAudience(input: AppliedTargetOidcAudienceRequest): string {
  try {
    const data = contract(snapshot(input), false);
    const { critical_step, ...writer } = data.writer;
    return `urn:tarubot:applied-target-sealing:v1:${privateDigest({
      purpose: "tarubot-github-oidc-applied-target-sealing-v1",
      receipt: data.request.receipt,
      job: data.request.job,
      writer: {
        ...writer,
        critical_step: { name: critical_step.name, number: critical_step.number },
      },
    })}`;
  } catch {
    throw new Error("invalid-target-sealing-oidc");
  }
}

/** Native fixed public JWKS GET has no credentials, proxy configuration or redirects. */
const directGet: GitHubReader = (input) =>
  new Promise((accept, reject) => {
    if (input.method !== "GET" || input.url !== jwksUrl) {
      reject(new Error("invalid-target-sealing-oidc"));
      return;
    }
    const agent = new Agent({ keepAlive: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: GitHubReadResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      agent.destroy();
      if (response) accept(response);
      else reject(new Error("invalid-target-sealing-oidc"));
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: "token.actions.githubusercontent.com",
        servername: "token.actions.githubusercontent.com",
        port: 443,
        path: "/.well-known/jwks",
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
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase();
            const value = response.rawHeaders[i + 1];
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

function base64url(value: unknown, limit: number): Buffer {
  requireOidc(typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value));
  const bytes = Buffer.from(value, "base64url");
  requireOidc(bytes.length > 0 && bytes.length <= limit && bytes.toString("base64url") === value);
  return bytes;
}
function jwksResponse(response: GitHubReadResponse): Value[] {
  requireOidc(
    response.status === 200 &&
      response.url === jwksUrl &&
      response.body instanceof Uint8Array &&
      response.body.length > 0 &&
      response.body.length <= maxBody,
  );
  const headers: Record<string, string> = Object.create(null);
  let size = 0;
  for (const [name, value] of Object.entries(object(response.headers))) {
    const lower = name.toLowerCase();
    requireOidc(
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(lower) &&
        typeof value === "string" &&
        !/[\r\n\0]/u.test(value) &&
        !Object.hasOwn(headers, lower),
    );
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    requireOidc(size <= maxHeaders);
    headers[lower] = value;
  }
  requireOidc(
    typeof headers["content-type"] === "string" &&
      /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/iu.test(
        headers["content-type"],
      ),
  );
  requireOidc(
    !Object.hasOwn(headers, "location") &&
      !Object.hasOwn(headers, "link") &&
      !Object.hasOwn(headers, "content-range") &&
      (!Object.hasOwn(headers, "content-encoding") || headers["content-encoding"] === "identity"),
  );
  if (headers["content-length"] !== undefined)
    requireOidc(
      /^(0|[1-9][0-9]*)$/u.test(headers["content-length"]) &&
        Number(headers["content-length"]) === response.body.length,
    );
  const data = exact(json(response.body), ["keys"]);
  requireOidc(Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 32);
  const keys = data.keys.map(object);
  const identifiers = new Set<string>();
  for (const key of keys) {
    requireOidc(
      typeof key.kid === "string" &&
        /^[A-Za-z0-9._-]{1,256}$/u.test(key.kid) &&
        !identifiers.has(key.kid),
    );
    identifiers.add(key.kid);
    requireOidc(
      Object.keys(key).every((name) =>
        ["kty", "kid", "use", "n", "e", "alg", "key_ops", "x5t", "x5t#S256", "x5c"].includes(name),
      ),
    );
    requireOidc(
      key.kty === "RSA" && key.use === "sig" && (key.alg === undefined || key.alg === "RS256"),
    );
    if (key.key_ops !== undefined) requireOidc(isDeepStrictEqual(key.key_ops, ["verify"]));
    const modulus = base64url(key.n, 1024);
    requireOidc(modulus.length >= 256 && (modulus[0] ?? 0) >= 128 && key.e === "AQAB");
    for (const name of ["x5t", "x5t#S256"]) if (key[name] !== undefined) base64url(key[name], 64);
    if (key.x5c !== undefined)
      requireOidc(
        Array.isArray(key.x5c) &&
          key.x5c.length > 0 &&
          key.x5c.length <= 8 &&
          key.x5c.every(
            (value) =>
              typeof value === "string" &&
              /^[A-Za-z0-9+/]+=*$/u.test(value) &&
              value.length <= 16_384,
          ),
      );
  }
  return keys;
}

/**
 * Primary claims/permissions and fixed discovery/JWKS metadata:
 * https://docs.github.com/en/actions/reference/security/oidc
 * https://docs.github.com/en/actions/concepts/security/openid-connect (optional header x5t)
 * https://token.actions.githubusercontent.com/.well-known/openid-configuration
 * check_run_id identifies the job; GitHub signs a caller-chosen audience, not job completion.
 * This verifier never grants final job success, approval or an owner recovery fence.
 */
export class AppliedTargetOidcAuthenticator {
  readonly #configuration: AppliedTargetOidcConfiguration;
  readonly #readToken: ReadAppliedTargetOidcToken;
  readonly #get: GitHubReader;
  readonly #now: () => number;
  constructor(
    configuration: AppliedTargetOidcConfiguration,
    dependencies: {
      readToken: ReadAppliedTargetOidcToken;
      /** Internal invented-test transport seam, never CLI/config URL or alternate issuer keys. */
      get?: GitHubReader;
      now?: () => number;
    },
  ) {
    try {
      const config = exact(snapshot(configuration), ["owner_id", "repository_id", "subjects"]);
      integer(config.owner_id);
      integer(config.repository_id);
      const subjects = exact(config.subjects, ["apply", "no-changes"]);
      for (const subject of Object.values(subjects))
        requireOidc(typeof subject === "string" && /^[!-~]{1,2048}$/u.test(subject));
      requireOidc(subjects.apply !== subjects["no-changes"]);
      this.#configuration = config as unknown as AppliedTargetOidcConfiguration;
      const readToken = dependencies.readToken;
      const get = dependencies.get ?? directGet;
      const now = dependencies.now ?? Date.now;
      requireOidc(
        typeof readToken === "function" && typeof get === "function" && typeof now === "function",
      );
      this.#readToken = readToken;
      this.#get = get;
      this.#now = now;
      Object.freeze(this);
    } catch {
      throw new Error("invalid-target-sealing-oidc");
    }
  }

  /** All token/key/expiry evidence is independently verified before returning any receipt. */
  async verify(input: AppliedTargetSealingRequest): Promise<AuthenticatedAppliedTargetOidc> {
    try {
      const data = contract(snapshot(input));
      requireOidc(
        data.writer.repository_owner_id === this.#configuration.owner_id &&
          data.writer.repository_id === this.#configuration.repository_id,
      );
      const started = this.#now();
      integer(started);
      const physicalStarted = performance.now();
      let last = started;
      let signedExpiry = Infinity;
      let physicalSignedExpiry = Infinity;
      const physicalReceiptExpiry = physicalStarted + (data.request.receipt.expires_at - started);
      const current = () => {
        const at = this.#now();
        integer(at);
        requireOidc(
          at >= last &&
            at - started < maxOperation &&
            performance.now() - physicalStarted < maxOperation &&
            at >= data.request.requested_at &&
            at - data.request.requested_at < maxOperation &&
            at >= data.request.receipt.issued_at &&
            at < data.request.receipt.expires_at &&
            performance.now() < physicalReceiptExpiry &&
            at < signedExpiry &&
            performance.now() < physicalSignedExpiry,
        );
        last = at;
        return at;
      };
      const remaining = () =>
        Math.min(
          10_000,
          maxOperation - (current() - started),
          maxOperation - (performance.now() - physicalStarted),
          data.request.receipt.expires_at - last,
          physicalReceiptExpiry - performance.now(),
          signedExpiry - last,
          physicalSignedExpiry - performance.now(),
        );
      const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
        const limit = remaining();
        requireOidc(limit > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve().then(work),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("invalid-target-sealing-oidc")), limit);
            }),
          ]);
          current();
          return result;
        } finally {
          clearTimeout(timer);
        }
      };
      current();
      const token = await bounded(() => this.#readToken(freeze(structuredClone(data))));
      requireOidc(typeof token === "string" && token.length <= 32_768);
      const segments = token.split(".");
      requireOidc(segments.length === 3);
      const header = object(json(base64url(segments[0], 4096)));
      requireOidc(
        Object.keys(header).every((name) => ["alg", "kid", "typ", "x5t"].includes(name)) &&
          header.alg === "RS256" &&
          header.typ === "JWT" &&
          typeof header.kid === "string" &&
          /^[A-Za-z0-9._-]{1,256}$/u.test(header.kid),
      );
      if (header.x5t !== undefined) base64url(header.x5t, 64);
      const claims = object(json(base64url(segments[1], 24_576)));
      const signature = base64url(segments[2], 1024);
      for (const name of ["iat", "nbf", "exp"]) integer(claims[name]);
      const iat = Number(claims.iat) * 1000;
      const nbf = Number(claims.nbf) * 1000;
      const exp = Number(claims.exp) * 1000;
      integer(iat);
      integer(nbf);
      integer(exp);
      requireOidc(
        iat <= current() &&
          nbf <= last &&
          exp > last &&
          exp > iat &&
          exp > nbf &&
          exp - iat <= maxJwtAge,
      );
      // Pin the original signed lifetime before a possibly delayed JWKS read. A frozen wall
      // clock cannot allow a late acknowledgement to renew or outlive the JWT's deadline.
      signedExpiry = exp;
      physicalSignedExpiry = physicalStarted + (exp - started);
      current();
      const response = await bounded(() =>
        this.#get({
          url: jwksUrl,
          method: "GET",
          redirect: "error",
          timeout_ms: remaining(),
          body_limit: maxBody,
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "TaruBot-private-sealing-oidc",
          },
        }),
      );
      const keys = jwksResponse(response);
      const key = keys.find((candidate) => candidate.kid === header.kid);
      requireOidc(key !== undefined && (header.x5t === undefined || header.x5t === key.x5t));
      const publicKey = createPublicKey({
        key: { kty: "RSA", n: String(key.n), e: String(key.e) },
        format: "jwk",
      });
      requireOidc(
        publicKey.asymmetricKeyType === "rsa" &&
          verifySignature(
            "RSA-SHA256",
            Buffer.from(`${segments[0]}.${segments[1]}`),
            { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
            signature,
          ),
      );
      // Automatic publication uses its separate proposed gate. Owner dispatch's infra gate
      // cannot acquire push/publication authority through a signed environment claim.
      const expectedEnvironment =
        data.request.receipt.mode === "apply" ? "infra-auto" : "infra-plan";
      requireOidc(
        claims.iss === issuer &&
          claims.aud === appliedTargetOidcAudience(data) &&
          claims.sub === this.#configuration.subjects[data.request.receipt.mode] &&
          claims.repository === repository &&
          claims.repository_owner === "deconfined" &&
          claims.repository_id === String(this.#configuration.repository_id) &&
          claims.repository_owner_id === String(this.#configuration.owner_id) &&
          claims.ref === "refs/heads/main" &&
          claims.ref_type === "branch" &&
          claims.ref_protected === "true" &&
          claims.event_name === "push" &&
          claims.sha === data.writer.head_commit &&
          claims.run_id === data.writer.run &&
          claims.run_attempt === "1" &&
          claims.workflow_ref === publication &&
          claims.workflow_sha === data.request.receipt.release.commit &&
          claims.job_workflow_ref === infrastructure &&
          claims.job_workflow_sha === data.writer.reusable_workflow_commit &&
          claims.environment === expectedEnvironment &&
          claims.check_run_id === String(data.writer.check_run_id) &&
          claims.head_ref === "" &&
          claims.base_ref === "" &&
          typeof claims.jti === "string" &&
          /^[!-~]{1,256}$/u.test(claims.jti),
      );
      const authenticatedAt = current();
      const physicalRemaining = Math.floor(
        Math.min(physicalSignedExpiry, physicalReceiptExpiry) - performance.now(),
      );
      requireOidc(physicalRemaining > 0);
      return freeze({
        schema: 1,
        purpose: "tarubot-authenticated-applied-target-sealing-v1",
        ...data,
        authenticated_at: authenticatedAt,
        expires_at: Math.min(
          exp,
          data.request.receipt.expires_at,
          authenticatedAt + maxProofAge,
          authenticatedAt + physicalRemaining,
        ),
      });
    } catch {
      throw new Error("invalid-target-sealing-oidc");
    }
  }
}
