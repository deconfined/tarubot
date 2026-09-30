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
 * - Once, on merge (2.37.0, REQUIREMENTS.md "Approved unified-pipeline amendments (2026-09-29)",
 *   decision 3): the workflow runs on a push to main alone, with no dispatch, and the publish job's
 *   first step, before anything is built, refuses a version or sha- tag that already exists. Only
 *   a registry 404 counts as absent. The step runs here against a simulated GHCR
 *   (tests/fixtures/publish-workflow/curl) for 404, 200, 401 and 500, and its anonymous token never
 *   reaches an argument.
 *
 * Since 2.33.0 the deploy plan verifies the signature with `gh attestation verify` before any
 * deploy job (tests/unit/deploy-workflow.test.ts pins its flags).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

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

/** The refusal step reads GHCR's token answer with jq, as a runner has it; the image build has none. */
const hasJq = Bun.which("jq") !== null;

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

describe("once, on merge", () => {
  test("runs on a push to main alone: no dispatch, no tag, no other trigger", () => {
    const { on } = YAML.parse(read(".github/workflows/publish.yml")) as { on: unknown };
    expect(on).toEqual({ push: { branches: ["main"] } });
    for (const j of [build, attest, latest])
      expect({ job: j.name, if: j.if }).toEqual({
        job: j.name,
        if: "github.ref == 'refs/heads/main'",
      });
    // The header says what a failure after the push costs, and what may still be re-run.
    const header = read(".github/workflows/publish.yml").split("\nname:")[0] ?? "";
    expect(header.replace(/\n# ?/gu, " ")).toContain(
      "A publish job that fails after its push therefore needs a version bump; the attest and latest jobs can be re-run alone.",
    );
  });

  test("the publish job's first step refuses an existing version or sha- tag, before anything is built", () => {
    const [first, ...rest] = build.steps;
    expect(first?.name).toBe("Refuse a release that is already published");
    expect(first?.env).toEqual({ VERSION: expr("needs.verify.outputs.version") });
    expect(first?.uses).toBeUndefined();
    // Checkout, the builders, the login and the build all come after it.
    expect(rest.map((s) => s.uses?.split("@")[0] ?? s.id)).toEqual([
      "actions/checkout",
      "docker/setup-qemu-action",
      "docker/setup-buildx-action",
      "docker/login-action",
      "docker/metadata-action",
      "docker/build-push-action",
    ]);
    // No expression inside the script, no tracing.
    expect(first?.run ?? "").not.toContain("${{");
    expect(first?.run ?? "").not.toMatch(/set -[a-zA-Z]*x/u);
  });

  describe.skipIf(!hasJq)("against a simulated GHCR", () => {
    const script = stepOf(build, "Refuse a release that is already published").run ?? "";
    const STUB_DIR = fileURLToPath(new URL("../fixtures/publish-workflow", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "publish-workflow-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));
    let boxes = 0;
    const VERSION = "2.37.1";
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const TOKEN = "anonymous-pull-token-for-tests";

    /** Run the step with GHCR answering `manifests` per tag, and the token endpoint `token`. */
    function refuse(
      manifests: Record<string, string> = {},
      options: { token?: string; tokenBody?: string; env?: Record<string, string> } = {},
    ) {
      const dir = join(scratch, `b${++boxes}`);
      const bin = join(dir, "bin");
      mkdirSync(join(dir, "manifests"), { recursive: true });
      mkdirSync(bin);
      cpSync(join(STUB_DIR, "curl"), join(bin, "curl"));
      chmodSync(join(bin, "curl"), 0o755);
      writeFileSync(join(dir, "token-body"), options.tokenBody ?? JSON.stringify({ token: TOKEN }));
      if (options.token) writeFileSync(join(dir, "token-status"), options.token);
      for (const [tag, status] of Object.entries(manifests))
        writeFileSync(join(dir, "manifests", tag), status);
      const r = Bun.spawnSync(["bash", "-e", "-c", script], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          TMPDIR: dir,
          STUB: dir,
          VERSION,
          GITHUB_SHA: SHA,
          ...options.env,
        },
        stdin: "ignore",
      });
      const file = (name: string) =>
        existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
      return {
        code: r.exitCode,
        stdout: r.stdout.toString(),
        log: r.stdout.toString() + r.stderr.toString(),
        events: file("events").trim().split("\n").filter(Boolean),
        argv: file("argv"),
        configs: readdirSync(dir)
          .filter((f) => f.startsWith("curl-config."))
          .map((f) => file(f)),
      };
    }

    test("goes on only when the registry answers 404 for both tags", () => {
      const r = refuse();
      expect(r.code).toBe(0);
      expect(r.events).toEqual(["token", `HEAD ${VERSION}`, `HEAD sha-${SHA}`]);
      expect(r.stdout).toContain(`ghcr.io/deconfined/tarubot:${VERSION} isn't published yet.`);
      expect(r.stdout).toContain(`ghcr.io/deconfined/tarubot:sha-${SHA} isn't published yet.`);
      // The anonymous token is masked, and reaches curl only in its config on stdin.
      expect(r.stdout).toContain(`::add-mask::${TOKEN}`);
      expect(r.argv).not.toContain(TOKEN);
      expect(
        r.configs.filter((c) => c.includes(`header = "Authorization: Bearer ${TOKEN}"`)),
      ).toHaveLength(2);
      // It asks for any of the four manifest types a release can be.
      expect(r.argv).toContain(
        "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      );
      expect(r.argv).toContain("--head");
      expect(r.argv).toContain("https://ghcr.io/token?scope=repository:deconfined/tarubot:pull");
    });

    test("refuses a tag that exists: a release is never pushed twice", () => {
      for (const tag of [VERSION, `sha-${SHA}`]) {
        const r = refuse({ [tag]: "200" });
        expect({ tag, code: r.code }).toEqual({ tag, code: 1 });
        expect(r.stdout).toContain(
          `::error::ghcr.io/deconfined/tarubot:${tag} already exists, and a release is never pushed twice: bump the version.`,
        );
      }
      // The version first: an existing version stops before the sha- tag is asked.
      expect(refuse({ [VERSION]: "200" }).events).toEqual(["token", `HEAD ${VERSION}`]);
    });

    test("refuses any other answer, since it can't tell whether the tag exists", () => {
      for (const status of ["401", "403", "429", "500", "503"]) {
        const r = refuse({ [VERSION]: status });
        expect({ status, code: r.code }).toEqual({ status, code: 1 });
        expect(r.stdout).toContain(
          `::error::GHCR answered HTTP ${status} for ghcr.io/deconfined/tarubot:${VERSION}, so whether it exists is unknown; nothing was pushed.`,
        );
      }
      // A token answer without a token stops before any manifest is asked.
      const unauthorized = refuse({}, { tokenBody: JSON.stringify({}) });
      expect(unauthorized.code).toBe(1);
      expect(unauthorized.stdout).toContain(
        "::error::GHCR's token answer holds no token; nothing was pushed.",
      );
      for (const token of ["401", "500"]) {
        const r = refuse({}, { token });
        expect({ token, code: r.code, events: r.events }).toEqual({
          token,
          code: 1,
          events: ["token"],
        });
        expect(r.stdout).toContain(
          `::error::GHCR handed out no anonymous pull token (HTTP ${token}); nothing was pushed.`,
        );
      }
      const lost = refuse({}, { env: { FAKE_CURL_EXIT: "7" } });
      expect(lost.code).toBe(1);
      expect(lost.stdout).toContain("(HTTP 000)");
    });

    test("refuses a version or commit that isn't one, before it asks anything", () => {
      for (const env of [{ VERSION: "2.37" }, { VERSION: "2.37.1; id" }, { GITHUB_SHA: "main" }]) {
        const r = refuse({}, { env });
        expect({ env, code: r.code, events: r.events }).toEqual({ env, code: 1, events: [] });
      }
    });
  });
});
