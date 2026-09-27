/**
 * The "Publish containers" workflow (.github/workflows/publish.yml) and the build provenance it
 * signs since 2.32.0 (#50 part 1).
 *
 * - Every action in every workflow is pinned to a full commit SHA with its version comment. The
 *   repository's Actions settings refuse other pins too; this catches one before a push.
 * - The build hands the index digest it pushed to the attest job through job outputs, and the
 *   matrix stays one image, so that output is the published image's digest.
 * - attest signs exactly that digest for the image the deploy tooling names, with actions/attest,
 *   `contents: read`, `id-token: write` and `attestations: write` only. It pushes nothing to the
 *   registry and reads no tag: any same-repository workflow can repoint a GHCR tag, so a digest
 *   read back from one would let a branch's image receive main's signature.
 * - No other job, in any workflow, may write attestations; in publish.yml only attest holds an OIDC
 *   token, and only the publish and latest jobs may write packages.
 * - latest waits for attest and promotes the digest the build returned, not a tag.
 *
 * Since 2.33.0 the deploy plan verifies the signature with `gh attestation verify` before either
 * deploy job (tests/unit/deploy-workflow.test.ts pins its flags).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

const step = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    env: z.record(z.string(), z.string()).optional(),
    run: z.string().optional(),
  })
  .strict();
/** The jobs this test pins closely; the reusable-workflow `verify` job is only passed through. */
const job = z
  .object({
    name: z.string(),
    needs: z.union([z.string(), z.array(z.string())]),
    if: z.string(),
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }).optional(),
    permissions: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.string()).optional(),
    strategy: z
      .object({
        "fail-fast": z.boolean(),
        matrix: z.object({ include: z.array(z.record(z.string(), z.string())) }).strict(),
      })
      .strict()
      .optional(),
    steps: z.array(step),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Publish containers"),
    on: z.unknown(),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.unknown(),
    jobs: z.object({ verify: z.unknown(), publish: job, attest: job, latest: job }).strict(),
  })
  .strict();

const publish = workflow.parse(YAML.parse(read(".github/workflows/publish.yml")));
const { publish: build, attest, latest } = publish.jobs;
/** A GitHub Actions expression, `${{ inner }}`, built so the source holds no template placeholder. */
const expr = (inner: string) => `\${{ ${inner} }}`;
/** The value build-push-action returned, as the downstream jobs must name it. */
const DIGEST_OUTPUT = expr("needs.publish.outputs.digest");
/** One job's step, by its id or name. */
const stepOf = (j: z.infer<typeof job>, key: string) => {
  const found = j.steps.find((s) => s.id === key || s.name === key);
  if (!found) throw new Error(`no step ${key}`);
  return found;
};
/** The job's `needs`, always as a list. */
const needsOf = (j: z.infer<typeof job>) => (Array.isArray(j.needs) ? j.needs : [j.needs]);

/** The image package.json's repository publishes to (GHCR paths are lowercase). */
const image = (() => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(manifest.repository.url);
  if (!match?.[1] || !match[2]) throw new Error("package.json repository.url is not a GitHub URL");
  return `ghcr.io/${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
})();

const workflowFiles = readdirSync(root(".github/workflows")).filter((f) => /\.ya?ml$/u.test(f));

describe("action pins", () => {
  test("every action in every workflow is pinned to a full commit SHA with its version", () => {
    for (const file of workflowFiles) {
      const source = read(`.github/workflows/${file}`);
      for (const [, reference = "", rest = ""] of source.matchAll(
        /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gmu,
      )) {
        // A reusable workflow in this repository is the one exception.
        if (reference.startsWith("./")) continue;
        const pinned =
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/u.test(reference) &&
          /^\s+#\s+v\d+(?:\.\d+)*$/u.test(rest);
        expect({ file, reference, pinned }).toEqual({ file, reference, pinned: true });
      }
    }
  });
});

describe("the build's digest", () => {
  test("reaches the downstream jobs as a job output taken from build-push-action", () => {
    expect(build.outputs).toEqual({ digest: expr("steps.build.outputs.digest") });
    const push = stepOf(build, "build");
    expect(push.uses).toMatch(/^docker\/build-push-action@[0-9a-f]{40}$/u);
    expect(push.with?.push).toBe(true);
  });

  test("the matrix stays one image, so the job output is that image's digest", () => {
    // A matrix job's outputs keep one entry's value, whichever finished last.
    expect(build.strategy?.matrix.include).toEqual([{ target: "tarubot", suffix: "" }]);
    expect(stepOf(build, "metadata").with?.images).toBe(
      `ghcr.io/${expr("github.repository")}${expr("matrix.suffix")}`,
    );
  });
});

describe("the attest job", () => {
  test("runs after publish, from main, with only the permissions signing needs", () => {
    expect(needsOf(attest)).toEqual(["publish"]);
    expect(attest.if).toBe("github.ref == 'refs/heads/main'");
    expect(attest["runs-on"]).toBe("ubuntu-24.04");
    // No packages: write and no registry login: the attestation stays with the repository.
    expect(attest.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
  });

  test("signs the build's digest for the image the deploy tooling names, pushing nothing", () => {
    const sign = stepOf(attest, "Attest build provenance");
    expect(sign.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/u);
    // Provenance mode: no predicate or SBOM inputs, one subject by name and digest, no tag.
    expect(sign.with).toEqual({
      "subject-name": image,
      "subject-digest": DIGEST_OUTPUT,
      "push-to-registry": false,
    });
    // 2.33.0 verifies oci://<IMAGE>@<digest>; both copies of IMAGE must name the signed subject.
    expect(read(".github/workflows/deploy.yml")).toContain(`IMAGE=${image}\n`);
    expect(read("ops/deploy.sh")).toContain(`readonly IMAGE=${image}\n`);
  });

  test("reads no tag: its only expression is the build's digest", () => {
    const expressions = [...JSON.stringify(attest).matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/gu)].map(
      (m) => m[1],
    );
    expect(new Set(expressions)).toEqual(new Set(["needs.publish.outputs.digest"]));
    // No step pulls, inspects or retags an image, and none uses a registry action.
    for (const s of attest.steps) {
      expect(s.run ?? "").not.toMatch(/docker|imagetools|crane|oras|skopeo|gh api/u);
      if (s.uses) expect(s.uses).toMatch(/^actions\/attest@/u);
    }
  });

  test("checks the digest before signing, since an empty one would sign discovered subjects", () => {
    const names = attest.steps.map((s) => s.name);
    expect(names).toEqual(["Check the digest the build returned", "Attest build provenance"]);
    const check = stepOf(attest, "Check the digest the build returned");
    expect(check.env).toEqual({ DIGEST: DIGEST_OUTPUT });
    const run = check.run ?? "";
    /** Run the check the way GitHub's default Linux shell does. */
    const outcome = (digest: string) =>
      Bun.spawnSync(["bash", "-e", "-c", run], { env: { PATH: process.env.PATH, DIGEST: digest } })
        .exitCode;
    expect(outcome(`sha256:${"a1".repeat(32)}`)).toBe(0);
    for (const digest of [
      "",
      "sha256:",
      `sha256:${"A1".repeat(32)}`,
      `sha256:${"a1".repeat(31)}`,
      `sha512:${"a1".repeat(64)}`,
      `${image}:latest`,
      `sha256:${"a1".repeat(32)}\nsha256:${"b2".repeat(32)}`,
    ])
      expect({ digest, exit: outcome(digest) }).toEqual({ digest, exit: 1 });
  });
});

describe("who may sign or write", () => {
  test("only publish.yml's attest job may write attestations, in any workflow", () => {
    for (const file of workflowFiles) {
      const source = read(`.github/workflows/${file}`);
      const grants = [...source.matchAll(/^\s*attestations:\s*write\b/gmu)].length;
      expect({ file, grants }).toEqual({ file, grants: file === "publish.yml" ? 1 : 0 });
    }
  });

  test("in publish.yml only attest holds an OIDC token, and it can't write packages", () => {
    expect(publish.permissions).toEqual({ contents: "read" });
    for (const [name, j] of Object.entries({ publish: build, attest, latest })) {
      expect({ name, oidc: j.permissions["id-token"] ?? "none" }).toEqual({
        name,
        oidc: name === "attest" ? "write" : "none",
      });
      expect({ name, packages: j.permissions.packages ?? "none" }).toEqual({
        name,
        packages: name === "attest" ? "none" : "write",
      });
    }
  });
});

describe("the latest tag", () => {
  test("waits for attest and promotes the signed digest, never the sha- tag", () => {
    expect(needsOf(latest).sort()).toEqual(["attest", "publish"]);
    expect(latest.if).toBe("github.ref == 'refs/heads/main'");
    const promote = stepOf(latest, "Advance the latest tag after successful publication");
    expect(promote.env?.DIGEST).toBe(DIGEST_OUTPUT);
    const run = promote.run ?? "";
    expect(run).toContain("^sha256:[0-9a-f]{64}$");
    expect(run).toContain(
      `docker buildx imagetools create --tag "$image:latest" "$image@\${DIGEST}"`,
    );
    expect(run).not.toContain("sha-");
    // Re-running an older publish still leaves a newer main's latest alone.
    expect(run).toContain('if [ "$current" != "$GITHUB_SHA" ]; then');
  });
});
