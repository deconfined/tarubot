/** Public release evidence is untrusted input. Only fixed errors/validated identities leave here. */
import { isDeepStrictEqual } from "node:util";

type ObjectValue = Record<string, unknown>;
function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error("invalid-release-evidence");
}
function object(value: unknown): ObjectValue {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
export interface ReleaseIdentity {
  version: string;
  commit: string;
  digest: string;
  config_commit: string;
  publication_run: string;
  schema_head: string;
}
/** Configuration and release are explicit, immutable commits; this automatic lane uses one head. */
export function releaseIdentity(value: unknown): ReleaseIdentity {
  const r = object(value);
  requireEvidence(
    isDeepStrictEqual(
      Object.keys(r).sort(),
      ["version", "commit", "digest", "config_commit", "publication_run", "schema_head"].sort(),
    ),
  );
  requireEvidence(
    typeof r.version === "string" &&
      /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/u.test(r.version),
  );
  requireEvidence(
    typeof r.commit === "string" &&
      /^[a-f0-9]{40}$/u.test(r.commit) &&
      r.config_commit === r.commit,
  );
  requireEvidence(typeof r.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(r.digest));
  requireEvidence(
    typeof r.publication_run === "string" && /^[1-9][0-9]*$/u.test(r.publication_run),
  );
  requireEvidence(
    typeof r.schema_head === "string" && /^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(r.schema_head),
  );
  return r as unknown as ReleaseIdentity;
}
export interface PlatformImage {
  platform: "linux/amd64" | "linux/arm64";
  digest: string;
}
/** Scan each runtime child digest; never let attestations, duplicates or a tag substitute for it. */
export function platformImages(value: unknown): PlatformImage[] {
  const index = object(value);
  requireEvidence(
    index.schemaVersion === 2 &&
      [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].includes(String(index.mediaType)),
  );
  requireEvidence(
    Array.isArray(index.manifests) && index.manifests.length >= 2 && index.manifests.length <= 4,
  );
  const result: PlatformImage[] = [];
  const attestations: ObjectValue[] = [];
  for (const value of index.manifests) {
    const m = object(value);
    const p = object(m.platform);
    requireEvidence(typeof m.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(m.digest));
    requireEvidence(
      Number.isSafeInteger(m.size) && Number(m.size) > 0 && Number(m.size) <= 16 * 1024 * 1024,
    );
    requireEvidence(
      [
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(String(m.mediaType)),
    );
    if (p.os === "unknown" && p.architecture === "unknown") {
      attestations.push(m);
      continue;
    }
    requireEvidence(p.os === "linux" && (p.architecture === "amd64" || p.architecture === "arm64"));
    requireEvidence(p.variant === undefined || (p.architecture === "arm64" && p.variant === "v8"));
    result.push({ platform: `linux/${p.architecture}`, digest: m.digest });
  }
  requireEvidence(
    isDeepStrictEqual(result.map((r) => r.platform).sort(), ["linux/amd64", "linux/arm64"]),
  );
  requireEvidence(new Set(result.map((r) => r.digest)).size === 2);
  const references = new Set<string>();
  for (const m of attestations) {
    const a = object(m.annotations);
    const ref = a["vnd.docker.reference.digest"];
    requireEvidence(
      a["vnd.docker.reference.type"] === "attestation-manifest" &&
        typeof ref === "string" &&
        result.some((r) => r.digest === ref) &&
        !references.has(ref),
    );
    references.add(ref);
  }
  return result.sort((a, b) => a.platform.localeCompare(b.platform));
}
/** gh verifies certificate/ref/source/runner first; this also binds the signed invocation and subject. */
export function verifyReleaseProvenance(
  value: unknown,
  release: ReleaseIdentity,
  repository: string,
): void {
  requireEvidence(Array.isArray(value) && value.length > 0);
  const invocation = `https://github.com/${repository}/actions/runs/${release.publication_run}/attempts/1`;
  requireEvidence(
    value.some((entry) => {
      const statement = object(object(object(entry).verificationResult).statement);
      const predicate = object(statement.predicate);
      const metadata = object(object(predicate.runDetails).metadata);
      requireEvidence(Array.isArray(statement.subject));
      return (
        metadata.invocationId === invocation &&
        statement.subject.some((entry: unknown) => {
          const subject = object(entry);
          return (
            subject.name === `ghcr.io/${repository.toLowerCase()}` &&
            object(subject.digest).sha256 === release.digest.slice(7)
          );
        })
      );
    }),
  );
}
/** A successful job is not acceptance; this evidence comes only from the actual target checks. */
export function requireStagingAcceptance(value: unknown, release: ReleaseIdentity): void {
  const result = object(value);
  requireEvidence(
    result.schema === 1 && result.target === "staging" && result.outcome === "accepted",
  );
  requireEvidence(isDeepStrictEqual(releaseIdentity(result.release), release));
  const checks = object(result.checks);
  requireEvidence(
    isDeepStrictEqual(
      Object.keys(checks).sort(),
      [
        "backup",
        "commands",
        "database",
        "discord",
        "image",
        "schema",
        "stability",
        "timer",
        "writer_lease",
      ].sort(),
    ),
  );
  requireEvidence(Object.values(checks).every((v) => v === true));
}
