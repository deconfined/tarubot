/** One owned live mint, with no retries, redirects, logging, ambient environment lookup or
 * caller-paired statement/audience/window. The returned value is always void; a native private
 * publication destination receives the verified bearer internally under the same proofs. */
import { constants, createPublicKey, verify as verifySignature } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  assertCurrentTargetIssuerProof,
  fenceCurrentTargetIssuerProof,
  finishCurrentTargetIssuerMint,
  reserveCurrentTargetIssuerMint,
  type CurrentTargetIssuerProof,
} from "./target-issuer-run.js";
import {
  contentReceiptV2,
  targetContentV2,
  targetContentV2Bytes,
  targetContentV2Digest,
} from "./target-content-v2.js";
import {
  assertTargetPublicationMintDestination,
  sealTargetPublicationBootstrap,
  type TargetPublicationMintDestination,
} from "./target-publication-v2.js";
import {
  captureTargetIssuance,
  finishTargetIssuanceMint,
  parseTargetIssuanceJson,
  prepareTargetIssuance,
  startTargetIssuanceMint,
  targetIssuanceAudience,
  targetIssuancePins,
  targetIssuanceResponse,
  type ContentReceiptV2,
} from "./target-issuance.js";
import type { GitHubReadRequest, GitHubReadResponse } from "./trust-run.js";
const nativeThen = Promise.prototype.then;
/** Drain native rejected promises solely to keep refusal diagnostics private; never await them. */
function drainRejectedPromise(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Non-native promises and ordinary values grant no authority. */
  }
}
type Value = Record<string, unknown>;
const issuerUrl = "https://token.actions.githubusercontent.com",
  jwksUrl = `${issuerUrl}/.well-known/jwks`,
  budget = 30_000;
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-issuance-mint");
}
function object(value: unknown): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const data = object(value);
  valid(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
export type TargetMintReader = (
  request: GitHubReadRequest & { beforeRead: () => void },
) => Promise<GitHubReadResponse>;
export interface TargetIssuanceMintConfiguration {
  request_url: string;
  request_token: string;
  subject: string;
}
/** The documented runtime URL is opaque. This deliberately narrow hosted GitHub policy has no
 * invented fixed path contract; compatibility with a selected supported runner remains a gate.
 * https://docs.github.com/en/actions/reference/runners/github-hosted-runners */
export function targetIssuanceRequestUrl(input: string, audience: string): string {
  try {
    valid(typeof input === "string" && input.length <= 8192 && /^[!-~]+$/u.test(input));
    valid(
      typeof audience === "string" &&
        /^urn:tarubot:applied-target-issuance:v2:[a-f0-9]{64}$/u.test(audience),
    );
    const url = new URL(input);
    valid(
      url.protocol === "https:" &&
        url.port === "" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        (url.href === input ||
          input === url.href.replace(`//${url.host}/`, `//${url.host}:443/`)) &&
        !input.endsWith("?"),
    );
    const labels = url.hostname.split(".");
    valid(
      url.hostname.length <= 253 &&
        labels.length >= 4 &&
        labels.slice(-3).join(".") === "actions.githubusercontent.com" &&
        labels.every(
          (label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) && !label.startsWith("xn--"),
        ),
    );
    valid(
      url.pathname.startsWith("/") &&
        url.pathname !== "/" &&
        !/\\|%2f|%5c|%00|%25|(?:^|\/)\.{1,2}(?:\/|$)/iu.test(url.pathname),
    );
    const decodedPath = decodeURIComponent(url.pathname);
    valid(/^[!-~]+$/u.test(decodedPath) && !/[\\?#%]/u.test(decodedPath));
    valid(!/%(?![A-F0-9]{2})/u.test(url.pathname));
    for (const encodedOctet of url.pathname.match(/%[A-F0-9]{2}/gu) ?? [])
      valid(!/^[A-Za-z0-9._~-]$/u.test(decodeURIComponent(encodedOctet)));
    const names = new Set<string>();
    for (const entry of url.search.slice(1).split("&").filter(Boolean)) {
      valid(entry.includes("="));
      const parts = entry.split("=");
      valid(parts.length === 2);
      const name = decodeURIComponent(parts[0] ?? ""),
        value = decodeURIComponent(parts[1] ?? "");
      valid(
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) &&
          name.toLowerCase() !== "audience" &&
          !names.has(name.toLowerCase()),
      );
      valid(
        parts[0] === encodeURIComponent(name) &&
          parts[1] === encodeURIComponent(value) &&
          /^[ -~]*$/u.test(value),
      );
      names.add(name.toLowerCase());
      valid(names.size <= 32);
    }
    valid(!url.search.endsWith("&") && !url.search.includes("&&"));
    return `${input}${url.search ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  } catch {
    throw new Error("invalid-target-issuance-mint");
  }
}
/** Closed native request preparation is checked again immediately before each actual offer. */
const directGet: TargetMintReader = (input) =>
  new Promise((accept, reject) => {
    let agent: Agent | undefined,
      req: ReturnType<typeof httpsRequest> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      ended = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (response?: GitHubReadResponse) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      agent?.destroy();
      if (response) accept(response);
      else {
        req?.destroy();
        reject(new Error("invalid-target-issuance-mint"));
      }
    };
    const guard = () => {
      try {
        input.beforeRead();
        valid(!ended);
      } catch {
        finish();
        throw new Error("invalid-target-issuance-mint");
      }
    };
    try {
      guard();
      const url = new URL(input.url);
      valid(
        input.method === "GET" &&
          (input.url === jwksUrl || url.hostname.endsWith(".actions.githubusercontent.com")) &&
          url.protocol === "https:" &&
          !url.port &&
          !url.username &&
          !url.password &&
          !url.hash,
      );
      agent = new Agent({ keepAlive: false });
      const options = {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: input.headers,
        agent,
        rejectUnauthorized: true,
        maxHeaderSize: 16_384,
      };
      guard();
      req = httpsRequest(options, (response) => {
        try {
          guard();
        } catch {
          response.destroy();
          return;
        }
        response.on("error", () => finish());
        response.on("aborted", () => finish());
        response.on("data", (chunk: Buffer) => {
          try {
            guard();
            size += chunk.length;
            valid(size <= input.body_limit);
            guard();
            chunks.push(Buffer.from(chunk));
            guard();
          } catch {
            finish();
            response.destroy();
          }
        });
        response.on("end", () => {
          try {
            guard();
            valid(response.complete);
            const headers: Record<string, string> = Object.create(null);
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              guard();
              const key = response.rawHeaders[index]?.toLowerCase(),
                value = response.rawHeaders[index + 1];
              valid(key !== undefined && value !== undefined);
              headers[key] = Object.hasOwn(headers, key) ? `${headers[key]},${value}` : value;
            }
            guard();
            const body = Buffer.concat(chunks);
            guard();
            finish({ status: response.statusCode ?? 0, url: input.url, headers, body });
          } catch {
            finish();
          }
        });
      });
      req.on("error", () => finish());
      timer = setTimeout(() => finish(), input.timeout_ms);
      guard();
      req.end();
    } catch {
      finish();
    }
  });
function base64url(value: unknown, limit: number): Buffer {
  valid(
    typeof value === "string" &&
      /^[A-Za-z0-9_-]+$/u.test(value) &&
      value.length <= Math.ceil((limit * 4) / 3),
  );
  const bytes = Buffer.from(value, "base64url");
  valid(bytes.length > 0 && bytes.length <= limit && bytes.toString("base64url") === value);
  return bytes;
}
function signingKey(value: unknown, kid: string, x5t: unknown) {
  const data = exact(value, ["keys"]);
  valid(Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 100);
  const keys = data.keys.map(object);
  valid(new Set(keys.map((key) => key.kid)).size === keys.length);
  for (const key of keys) {
    valid(
      Object.keys(key).every((name) =>
        ["kty", "kid", "use", "alg", "n", "e", "x5t", "x5c"].includes(name),
      ) &&
        key.kty === "RSA" &&
        key.use === "sig" &&
        key.alg === "RS256" &&
        typeof key.kid === "string" &&
        /^[A-Za-z0-9._-]{1,256}$/u.test(key.kid),
    );
    const n = base64url(key.n, 1024),
      e = base64url(key.e, 8);
    valid(n.length >= 256 && n[0] !== 0 && e.length === 3 && e.toString("hex") === "010001");
    if (key.x5t !== undefined) base64url(key.x5t, 64);
    if (key.x5c !== undefined)
      valid(
        Array.isArray(key.x5c) &&
          key.x5c.length > 0 &&
          key.x5c.length <= 10 &&
          key.x5c.every(
            (cert) =>
              typeof cert === "string" &&
              /^[A-Za-z0-9+/]+={0,2}$/u.test(cert) &&
              cert.length <= 16_384,
          ),
      );
  }
  const key = keys.find((key) => key.kid === kid);
  valid(key && (x5t === undefined || key.x5t === x5t));
  const publicKey = createPublicKey({
    key: { kty: "RSA", n: String(key.n), e: String(key.e) },
    format: "jwk",
  });
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  valid(bits !== undefined && bits >= 2048 && bits <= 8192);
  return publicKey;
}
export interface TargetIssuanceMinter {
  mint(
    proof: CurrentTargetIssuerProof,
    receipt: ContentReceiptV2,
    destination: TargetPublicationMintDestination,
  ): Promise<void>;
}
export function createTargetIssuanceMinter(
  configuration: TargetIssuanceMintConfiguration,
  dependencies: { get?: TargetMintReader; now?: () => number } = {},
): TargetIssuanceMinter {
  // No input/dependency hooks run until the one invocation has reserved its phase and physical anchor.
  let phase: "ready" | "minting" | "finished" | "fenced" = "ready";
  let activeProof: CurrentTargetIssuerProof | undefined;
  const deny = () => {
    phase = "fenced";
    if (activeProof) fenceCurrentTargetIssuerProof(activeProof);
  };
  const mint = async (
    proof: CurrentTargetIssuerProof,
    offeredReceipt: ContentReceiptV2,
    destination: TargetPublicationMintDestination,
  ): Promise<void> => {
    const physicalStart = performance.now();
    try {
      valid(phase === "ready");
      phase = "minting";
      activeProof = proof;
      // The proof reservation is global across factories, before caller/config/clock hooks.
      const evidence = reserveCurrentTargetIssuerMint(proof);
      const captureGuard = () => {
        valid(phase === "minting" && performance.now() < physicalStart + budget);
        assertCurrentTargetIssuerProof(proof);
        valid(phase === "minting" && performance.now() < physicalStart + budget);
      };
      captureGuard();
      const config = exact(captureTargetIssuance(configuration), [
        "request_url",
        "request_token",
        "subject",
      ]);
      captureGuard();
      valid(
        typeof config.request_url === "string" &&
          typeof config.request_token === "string" &&
          /^[!-~]{1,32768}$/u.test(config.request_token),
      );
      valid(typeof config.subject === "string" && /^[!-~]{1,1024}$/u.test(config.subject));
      captureGuard();
      const suppliedGet = dependencies.get;
      captureGuard();
      const get = suppliedGet ?? directGet,
        clock = dependencies.now ?? Date.now;
      captureGuard();
      valid(typeof get === "function" && typeof clock === "function");
      let checking = false,
        last = 0,
        wall = Infinity,
        physicalEnd = physicalStart + budget;
      const check = () => {
        let owned = false;
        try {
          valid(phase === "minting" && !checking);
          checking = true;
          owned = true;
          assertCurrentTargetIssuerProof(proof);
          valid(phase === "minting");
          const at = clock();
          if (typeof at !== "number") {
            deny();
            drainRejectedPromise(at);
          }
          integer(at);
          assertCurrentTargetIssuerProof(proof);
          valid(phase === "minting" && at >= last && at < wall && performance.now() < physicalEnd);
          last = at;
          return at;
        } catch {
          deny();
          throw new Error("invalid-target-issuance-mint");
        } finally {
          if (owned) checking = false;
        }
      };
      const started = check();
      wall = Math.min(started + budget, evidence.candidate.expires_at);
      physicalEnd = physicalStart + Math.min(budget, evidence.candidate.expires_at - started);
      const candidate = evidence.candidate;
      const raw = object(captureTargetIssuance(offeredReceipt));
      const receipt = contentReceiptV2(raw, {
        target: candidate.target,
        release: candidate.release,
        backend: String(raw.backend),
      });
      valid(
        receipt.mode === candidate.mode &&
          isDeepStrictEqual(receipt.producer, candidate.producer) &&
          receipt.expires_at <= candidate.expires_at &&
          receipt.issued_at >= evidence.seal_started_at - 1000 &&
          receipt.issued_at <= started,
      );
      const content = targetContentV2(
        {
          schema: 2,
          purpose: "tarubot-applied-target-content-v2",
          target: candidate.target,
          backend: receipt.backend,
          release: candidate.release,
          producer: candidate.producer,
          mode: candidate.mode,
          envelope: candidate.envelope,
          issued_at: receipt.issued_at,
          expires_at: receipt.expires_at,
        },
        { target: candidate.target, backend: receipt.backend, release: candidate.release },
      );
      valid(targetContentV2Digest(targetContentV2Bytes(content)) === receipt.payload_digest);
      check();
      assertTargetPublicationMintDestination(destination, proof, receipt);
      check();
      const prepared = prepareTargetIssuance(
        {
          content_receipt: receipt,
          source: evidence.source,
          issuer: evidence.issuer,
          valid_until: Math.min(candidate.expires_at, started + 86_400_000 - 1000),
        },
        { now: check },
      );
      const url = targetIssuanceRequestUrl(config.request_url, prepared.audience);
      check();
      const read = async (requestUrl: string, bearer?: string): Promise<unknown> => {
        const remaining = Math.min(10_000, wall - check(), physicalEnd - performance.now());
        valid(remaining > 0);
        const request = {
          url: requestUrl,
          method: "GET" as const,
          redirect: "error" as const,
          timeout_ms: remaining,
          body_limit: 1048576 as const,
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "Cache-Control": "no-cache",
            "User-Agent": "TaruBot-target-issuance-mint-v2",
            ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
          },
          beforeRead: () => {
            check();
          },
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            Promise.resolve().then(() => {
              check();
              return get(request);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                deny();
                reject(new Error("invalid-target-issuance-mint"));
              }, remaining);
            }),
          ]);
          check();
          const value = targetIssuanceResponse(response, requestUrl);
          check();
          return value;
        } catch {
          deny();
          throw new Error("invalid-target-issuance-mint");
        } finally {
          clearTimeout(timer);
        }
      };
      check();
      startTargetIssuanceMint(prepared.window);
      check();
      // This is the only runtime mint request; malformed/unknown outcomes are never retried.
      const response = exact(await read(url, config.request_token), ["value"]);
      valid(typeof response.value === "string" && response.value.length <= 32_768);
      const jwt = response.value,
        segments = jwt.split(".");
      valid(segments.length === 3);
      check();
      const header = object(parseTargetIssuanceJson(base64url(segments[0], 4096))),
        claims = object(parseTargetIssuanceJson(base64url(segments[1], 24_576))),
        signature = base64url(segments[2], 1024);
      valid(
        Object.keys(header).every((name) => ["alg", "kid", "typ", "x5t"].includes(name)) &&
          header.alg === "RS256" &&
          header.typ === "JWT" &&
          typeof header.kid === "string" &&
          /^[A-Za-z0-9._-]{1,256}$/u.test(header.kid),
      );
      if (header.x5t !== undefined) base64url(header.x5t, 64);
      for (const name of ["iat", "nbf", "exp"]) integer(claims[name]);
      const iat = Number(claims.iat) * 1000,
        nbf = Number(claims.nbf) * 1000,
        exp = Number(claims.exp) * 1000;
      integer(iat);
      integer(nbf);
      integer(exp);
      const at = check();
      valid(
        nbf <= iat &&
          iat - nbf <= 60_000 &&
          exp > iat &&
          exp - iat <= 900_000 &&
          iat <= at &&
          nbf <= at &&
          at < exp &&
          iat >= prepared.statement.issued_at - 1000 &&
          iat < prepared.statement.issued_at + budget &&
          prepared.statement.valid_until <= iat + 86_400_000,
      );
      const keys = await read(jwksUrl);
      check();
      const key = signingKey(keys, header.kid, header.x5t);
      check();
      valid(
        key.asymmetricKeyType === "rsa" &&
          verifySignature(
            "RSA-SHA256",
            Buffer.from(`${segments[0]}.${segments[1]}`),
            { key, padding: constants.RSA_PKCS1_PADDING },
            signature,
          ),
      );
      check();
      const statement = prepared.statement,
        r = statement.content_receipt;
      valid(
        claims.iss === issuerUrl &&
          claims.aud === targetIssuanceAudience(statement) &&
          claims.sub === config.subject &&
          claims.repository === targetIssuancePins.repository &&
          claims.repository_owner === "deconfined" &&
          claims.repository_id === String(statement.issuer.repository_id) &&
          claims.repository_owner_id === String(statement.issuer.repository_owner_id) &&
          claims.ref === "refs/heads/main" &&
          claims.ref_type === "branch" &&
          claims.ref_protected === "true" &&
          claims.event_name === "push" &&
          claims.sha === r.release.commit &&
          claims.run_id === r.release.publication_run &&
          claims.run_attempt === "1" &&
          claims.workflow_ref === targetIssuancePins.publication &&
          claims.workflow_sha === r.release.commit &&
          claims.job_workflow_ref === targetIssuancePins.infrastructure &&
          claims.job_workflow_sha === r.release.config_commit &&
          claims.environment === targetIssuancePins.environment &&
          claims.check_run_id === String(statement.issuer.check_run_id) &&
          claims.head_ref === "" &&
          claims.base_ref === "" &&
          claims.runner_environment === "github-hosted" &&
          typeof claims.jti === "string" &&
          /^[!-~]{1,256}$/u.test(claims.jti),
      );
      valid(check() < exp);
      finishTargetIssuanceMint(prepared.window);
      check();
      finishCurrentTargetIssuerMint(proof);
      check();
      const bootstrapRemaining = Math.min(wall - check(), physicalEnd - performance.now());
      valid(bootstrapRemaining > 0);
      let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => {
            check();
            return sealTargetPublicationBootstrap(destination, proof, statement, jwt, () => {
              valid(check() < exp);
            });
          }),
          new Promise<never>((_, reject) => {
            bootstrapTimer = setTimeout(() => {
              deny();
              reject(new Error("invalid-target-issuance-mint"));
            }, bootstrapRemaining);
          }),
        ]);
      } finally {
        clearTimeout(bootstrapTimer);
      }
      check();
      phase = "finished";
    } catch {
      deny();
      throw new Error("invalid-target-issuance-mint");
    }
  };
  return Object.freeze({ mint });
}
