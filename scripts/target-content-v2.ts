/**
 * Exact v2 private content/bootstrap declarations. These pure parsers confer no producer,
 * storage, owner or host authority; the native consumer separately verifies issuance.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonical } from "./infra-control.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import {
  appliedTargetEnvelope,
  type AppliedTargetEnvelope,
  type AppliedTargetProducer,
} from "./target-descriptor.js";
import {
  captureTargetIssuance,
  parseTargetIssuanceJson,
  targetIssuanceStatement,
  type ContentReceiptV2,
  type TargetIssuanceContext,
  type TargetIssuanceStatementV2,
} from "./target-issuance.js";

type Value = Record<string, unknown>;
const day = 86_400_000;
const maximum = 65_536;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, "byteLength")?.get;
const nativeSet = Uint8Array.prototype.set;
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-content-v2");
}
function exact(value: unknown, keys: string[]): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Value;
  valid(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function digest(value: unknown): asserts value is string {
  valid(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function producer(value: unknown, release: ReleaseIdentity): AppliedTargetProducer {
  const p = exact(value, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  valid(
    isDeepStrictEqual(p, {
      repository: "deconfined/tarubot",
      workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
      ref: "refs/heads/main",
      event: "push",
      attempt: 1,
      commit: release.commit,
      run: release.publication_run,
    }),
  );
  valid(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
  integer(Number(release.publication_run));
  valid(String(Number(release.publication_run)) === release.publication_run);
  return p as unknown as AppliedTargetProducer;
}

export interface TargetContentV2 {
  schema: 2;
  purpose: "tarubot-applied-target-content-v2";
  target: "staging" | "production";
  backend: string;
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
  mode: "apply" | "no-changes";
  envelope: AppliedTargetEnvelope;
  issued_at: number;
  expires_at: number;
}
export interface TargetBootstrapV2 {
  schema: 2;
  purpose: "tarubot-applied-target-bootstrap-v2";
  statement: TargetIssuanceStatementV2;
  jwt: string;
}
/** Logical locations are constructed from independently expected identity, never packet paths. */
export function targetBootstrapV2Path(
  target: "staging" | "production",
  value: ReleaseIdentity,
): string {
  try {
    valid(target === "staging" || target === "production");
    const release = releaseIdentity(captureTargetIssuance(value));
    valid(/^[1-9][0-9]{0,15}$/u.test(release.publication_run));
    integer(Number(release.publication_run));
    valid(String(Number(release.publication_run)) === release.publication_run);
    return `applied-target-bootstrap-v2/${target}/${release.publication_run}/${release.commit}`;
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
export function targetContentV2Path(
  target: "staging" | "production",
  release: ReleaseIdentity,
  hash: string,
): string {
  try {
    digest(hash);
    return `${targetBootstrapV2Path(target, release).replace("bootstrap", "content")}/${hash}`;
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
/** The whole exact canonical content, including lifetime and minimized projection, is hashed. */
export function targetContentV2Bytes(value: TargetContentV2 | TargetBootstrapV2): Uint8Array {
  try {
    const bytes = Buffer.from(canonical(captureTargetIssuance(value)));
    valid(bytes.length > 0 && bytes.length <= maximum);
    return bytes;
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
export function targetContentV2Digest(value: Uint8Array): string {
  try {
    valid(value instanceof Uint8Array && byteLength);
    const length = byteLength.call(value) as number;
    valid(length > 0 && length <= maximum + 32);
    const bytes = new Uint8Array(length);
    nativeSet.call(bytes, value);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
/** Complete duplicate-key-aware JSON; byte limits and copies use intrinsic typed-array access. */
export function parseTargetContentV2Bytes(value: Uint8Array): unknown {
  try {
    valid(value instanceof Uint8Array && byteLength);
    const length = byteLength.call(value) as number;
    valid(length > 0 && length <= maximum);
    const bytes = new Uint8Array(length);
    nativeSet.call(bytes, value);
    return parseTargetIssuanceJson(bytes);
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
export function targetContentV2(value: unknown, expected: TargetIssuanceContext): TargetContentV2 {
  try {
    const e = exact(captureTargetIssuance(expected), ["target", "backend", "release"]);
    valid(e.target === "staging" || e.target === "production");
    digest(e.backend);
    const release = releaseIdentity(e.release);
    const c = exact(captureTargetIssuance(value), [
      "schema",
      "purpose",
      "target",
      "backend",
      "release",
      "producer",
      "mode",
      "envelope",
      "issued_at",
      "expires_at",
    ]);
    valid(c.schema === 2 && c.purpose === "tarubot-applied-target-content-v2");
    valid(
      c.target === e.target &&
        c.backend === e.backend &&
        isDeepStrictEqual(releaseIdentity(c.release), release),
    );
    const identity = producer(c.producer, release);
    valid(c.mode === "apply" || c.mode === "no-changes");
    integer(c.issued_at);
    integer(c.expires_at);
    valid(c.expires_at > c.issued_at && c.expires_at - c.issued_at <= day);
    const envelope = appliedTargetEnvelope(c.envelope, {
      target: e.target,
      release,
      producer: identity,
    });
    valid(envelope.verification.mode === c.mode);
    const result = { ...c, envelope } as unknown as TargetContentV2;
    // Enforce the same complete wire budget even for direct object callers.
    targetContentV2Bytes(result);
    return freeze(result);
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
export function contentReceiptV2(
  value: unknown,
  expected: TargetIssuanceContext,
): ContentReceiptV2 {
  try {
    const e = exact(captureTargetIssuance(expected), ["target", "backend", "release"]);
    valid(e.target === "staging" || e.target === "production");
    digest(e.backend);
    const release = releaseIdentity(e.release);
    const r = exact(captureTargetIssuance(value), [
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
    valid(
      r.schema === 2 &&
        r.purpose === "tarubot-applied-target-content-v2" &&
        r.target === e.target &&
        r.backend === e.backend,
    );
    valid(isDeepStrictEqual(releaseIdentity(r.release), release));
    producer(r.producer, release);
    valid(r.mode === "apply" || r.mode === "no-changes");
    digest(r.payload_digest);
    digest(r.ciphertext_digest);
    valid(r.path === targetContentV2Path(e.target, release, r.payload_digest));
    integer(r.issued_at);
    integer(r.expires_at);
    valid(r.expires_at > r.issued_at && r.expires_at - r.issued_at <= day);
    return freeze(r as unknown as ContentReceiptV2);
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
export function targetBootstrapV2(
  value: unknown,
  expected: TargetIssuanceContext,
): TargetBootstrapV2 {
  try {
    const b = exact(captureTargetIssuance(value), ["schema", "purpose", "statement", "jwt"]);
    valid(b.schema === 2 && b.purpose === "tarubot-applied-target-bootstrap-v2");
    const statement = targetIssuanceStatement(b.statement);
    contentReceiptV2(statement.content_receipt, expected);
    valid(
      typeof b.jwt === "string" &&
        b.jwt.length > 0 &&
        b.jwt.length <= 32_768 &&
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(b.jwt),
    );
    const result = { ...b, statement } as unknown as TargetBootstrapV2;
    targetContentV2Bytes(result);
    return freeze(result);
  } catch {
    throw new Error("invalid-target-content-v2");
  }
}
