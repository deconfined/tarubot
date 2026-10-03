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
