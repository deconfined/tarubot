/** Immutable image-index boundaries shared by the release scanner. */
import { expect, test } from "bun:test";
import { platformImages } from "../../scripts/release-policy.js";
import { boundIndex } from "../../scripts/release-scan.js";

const platform = (architecture: string, digit: string) => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  size: 1000,
  digest: `sha256:${digit.repeat(64)}`,
  platform: { os: "linux", architecture },
});
const index = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [platform("amd64", "b"), platform("arm64", "c")],
};

test("index bytes must match the immutable build digest", () => {
  const bytes = Buffer.from(JSON.stringify(index));
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  expect(boundIndex(bytes, digest)).toEqual(index);
  expect(() => boundIndex(Buffer.concat([bytes, Buffer.from("\n")]), digest)).toThrow(
    "invalid-release-index",
  );
});

test("BuildKit attestation manifests never substitute for either runtime platform", () => {
  const attestation = {
    ...platform("unknown", "d"),
    platform: { os: "unknown", architecture: "unknown" },
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": index.manifests[0]?.digest,
    },
  };
  expect(platformImages({ ...index, manifests: [...index.manifests, attestation] })).toEqual([
    { platform: "linux/amd64", digest: `sha256:${"b".repeat(64)}` },
    { platform: "linux/arm64", digest: `sha256:${"c".repeat(64)}` },
  ]);
  expect(() =>
    platformImages({ ...index, manifests: [index.manifests[0], attestation] }),
  ).toThrow();
});

test("missing, duplicate or unknown runtime platforms and invalid attestations fail closed", () => {
  for (const manifests of [
    [],
    [platform("amd64", "b")],
    [platform("amd64", "b"), platform("amd64", "c")],
    [platform("amd64", "b"), platform("arm64", "b")],
    [platform("amd64", "b"), platform("arm", "c")],
    [platform("amd64", "b"), { ...platform("arm64", "c"), digest: "image:latest" }],
    [
      ...index.manifests,
      { ...platform("unknown", "d"), platform: { os: "unknown", architecture: "unknown" } },
    ],
  ])
    expect(() => platformImages({ ...index, manifests })).toThrow("invalid-release-evidence");
  expect(() => platformImages({ ...index, mediaType: "unrecognized" })).toThrow();
});
