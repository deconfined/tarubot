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
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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
    jobs: z
      .object({
        verify: z.unknown(),
        publish: job,
        scan: z.unknown(),
        attest: job,
        release: z.unknown(),
        latest: job,
      })
      .strict(),
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

describe("explicit release publication", () => {
  test("only the first main push checks publication, and absent versions alone receive a build digest", () => {
    // An unchanged version can finish an unpublished release; existing versions skip the build.
    expect(build.if.replace(/\s+/gu, " ").trim()).toBe(
      "github.ref == 'refs/heads/main' && github.event_name == 'push' && github.run_attempt == '1'",
    );
    expect(build.concurrency).toEqual({
      group: `publish-${expr("github.repository")}-${expr("needs.verify.outputs.version")}`,
      "cancel-in-progress": false,
    });
    const jobs = publish.jobs as typeof publish.jobs & {
      scan: { needs: string; if: string };
      release: { needs: string[] };
    };
    expect(jobs.scan.needs).toBe("publish");
    expect(jobs.scan.if).toBe("needs.publish.outputs.digest != ''");
    const push = stepOf(build, "build");
    expect(push.if).toBe("steps.publication.outputs.publish == 'true'");
    for (const [decision, expected] of [
      ["true", true],
      ["false", false],
      ["", false],
    ] as const)
      expect(
        runInNewContext(push.if ?? "", {
          steps: { publication: { outputs: { publish: decision } } },
        }),
      ).toBe(expected);
    for (const [digest, expected] of [
      [`sha256:${"a".repeat(64)}`, true],
      ["", false],
    ] as const)
      expect(runInNewContext(jobs.scan.if, { needs: { publish: { outputs: { digest } } } })).toBe(
        expected,
      );
    expect(needsOf(attest)).toContain("publish");
    expect(jobs.release.needs).toContain("publish");
    expect(latest.if).toContain("needs.publish.result == 'success'");
    // Deploy uses this existing nonmatrix job's success/skipped conclusion as admission.
    expect(latest.name).toBe("Promote latest");
  });

  test("reruns cannot write or orchestrate a release using retained upstream successes", () => {
    const replacement = z.object({ if: z.string() }).parse(publish.jobs.release);
    // These workflow conditions use ordinary comparisons/booleans, so evaluate their actual
    // text against fixed contexts. Earlier successful jobs deliberately remain successful.
    for (const [github, expected] of [
      [{ ref: "refs/heads/main", event_name: "push", run_attempt: "1" }, true],
      [{ ref: "refs/heads/main", event_name: "push", run_attempt: "2" }, false],
      [{ ref: "refs/heads/main", event_name: "workflow_dispatch", run_attempt: "1" }, false],
      [{ ref: "refs/heads/fixture", event_name: "push", run_attempt: "1" }, false],
    ] as const) {
      for (const target of [build, attest, replacement, latest]) {
        const result = runInNewContext(target.if, {
          github,
          vars: { RELEASE_PIPELINE_ENABLED: "true" },
          needs: {
            verify: { outputs: { release: "true" } },
            publish: { result: "success" },
            attest: { result: "success" },
            release: { result: "success", outputs: { accepted: "true" } },
          },
          always: () => true,
        });
        expect(result).toBe(expected);
      }
    }
  });

  test("the registry guard finishes unpublished releases, skips published maintenance and refuses conflicts", () => {
    const guard = stepOf(build, "Check version publication");
    expect(guard.id).toBe("publication");
    expect(build.steps.indexOf(guard)).toBeLessThan(build.steps.indexOf(stepOf(build, "build")));
    expect(guard.env).toEqual({
      VERSION: expr("needs.verify.outputs.version"),
      GHCR_USER: expr("github.actor"),
      GHCR_TOKEN: expr("secrets.GITHUB_TOKEN"),
      RELEASE_REQUESTED: expr("needs.verify.outputs.release"),
    });

    // Exercise the actual shell guard with a fixed local curl replacement. Unknown routes fail
    // immediately, so none of these cases can reach a registry or read real credentials.
    const directory = mkdtempSync(join(tmpdir(), "tarubot-publish-guard-"));
    try {
      const calls = join(directory, "calls");
      const tokenFilter = String.raw`(.token // .access_token) | strings | select(test("\\A[A-Za-z0-9._~+/-]+=*\\z"))`;
      expect(guard.run).toContain(`jq -er '${tokenFilter}'`);
      // The Bun build image need not contain jq; only its fixed token extraction is simulated.
      writeFileSync(
        join(directory, "jq"),
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== "-er" || args[1] !== process.env.TOKEN_FILTER) process.exit(99);
try {
  const response = JSON.parse(await Bun.stdin.text());
  const token = response.token ?? response.access_token;
  if (typeof token !== "string" || !new RegExp("^[A-Za-z0-9._~+/-]+=*$").test(token)
      || token.includes(String.fromCharCode(10)) || token.includes(String.fromCharCode(13))) process.exit(4);
  process.stdout.write(token + "\\n");
} catch {
  process.exit(4);
}
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(directory, "curl"),
        `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.at(-1);
if (!args.includes("--connect-timeout") || !args.includes("--max-time")) process.exit(99);
if (args[args.indexOf("--config") + 1] !== "-" || args.includes("--user")) process.exit(99);
if (args.some((arg) => arg.includes("invented-workflow-token") || arg.includes("invented-registry-bearer"))) process.exit(99);
const config = await Bun.stdin.text();
if (url === "https://ghcr.io/token?service=ghcr.io&scope=repository:example/tarubot:pull") {
  appendFileSync(process.env.CALLS, "token\\n");
  if (config !== 'user = "invented-user:invented-workflow-token"\\n') process.exit(99);
  if (process.env.TOKEN_CASE === "error") process.exit(7);
  const tokens = { newline: "invented\\nbearer", quote: 'invented"bearer', space: "invented bearer", backslash: "invented\\\\bearer", object: {} };
  process.stdout.write(process.env.TOKEN_CASE === "empty" ? "{}" : JSON.stringify({token: tokens[process.env.TOKEN_CASE] ?? "invented-registry-bearer"}));
} else if (url === "https://ghcr.io/v2/example/tarubot/manifests/2.40.0") {
  appendFileSync(process.env.CALLS, "manifest\\n");
  if (!args.includes("--head")) process.exit(99);
  if (config !== 'header = "Authorization: Bearer invented-registry-bearer"\\n') process.exit(99);
  if (process.env.STATUS === "error") process.exit(7);
  process.stdout.write(process.env.STATUS);
} else {
  process.exit(99);
}
`,
        { mode: 0o700 },
      );
      const outputs = join(directory, "outputs");
      const outcome = (status: string, tokenCase = "valid", releaseRequested = "true") => {
        writeFileSync(calls, "");
        writeFileSync(outputs, "");
        const result = Bun.spawnSync(["bash", "-e", "-c", guard.run ?? ""], {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "Example/TaruBot",
            VERSION: "2.40.0",
            GHCR_USER: "invented-user",
            GHCR_TOKEN: "invented-workflow-token",
            GITHUB_OUTPUT: outputs,
            RELEASE_REQUESTED: releaseRequested,
            CALLS: calls,
            STATUS: status,
            TOKEN_CASE: tokenCase,
            TOKEN_FILTER: tokenFilter,
          },
        });
        const rawOutput = `${result.stdout.toString()}${result.stderr.toString()}`;
        // The standard add-mask command is the only permitted appearance of the derived token.
        const mask = "::add-mask::invented-registry-bearer\n";
        const output = rawOutput.replace(mask, "");
        expect(output).not.toContain("invented-workflow-token");
        expect(output).not.toContain("invented-registry-bearer");
        return {
          exit: result.exitCode,
          calls: readFileSync(calls, "utf8"),
          output,
          outputs: readFileSync(outputs, "utf8"),
          masked: rawOutput.includes(mask),
        };
      };
      for (const releaseRequested of ["true", "false"])
        expect(outcome("404", "valid", releaseRequested)).toMatchObject({
          exit: 0,
          calls: "token\nmanifest\n",
          outputs: "publish=true\n",
          masked: true,
        });
      expect(outcome("200", "valid", "false")).toMatchObject({
        exit: 0,
        calls: "token\nmanifest\n",
        outputs: "publish=false\n",
        output: expect.stringContaining("::notice::"),
      });
      expect(outcome("200")).toMatchObject({
        exit: 1,
        calls: "token\nmanifest\n",
        outputs: "",
        output: expect.stringContaining("already exists"),
      });
      for (const status of ["301", "307", "401", "403", "429", "500", "000", "error"])
        expect(outcome(status)).toMatchObject({
          exit: 1,
          calls: "token\nmanifest\n",
          outputs: "",
        });
      for (const tokenCase of [
        "empty",
        "error",
        "newline",
        "quote",
        "space",
        "backslash",
        "object",
      ])
        expect(outcome("404", tokenCase)).toMatchObject({
          exit: 1,
          calls: "token\n",
          outputs: "",
          masked: false,
        });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the attest job", () => {
  test("runs after publish, from main, with only the permissions signing needs", () => {
    expect(needsOf(attest)).toEqual(["publish", "scan"]);
    expect(attest.if.replace(/\s+/gu, " ").trim()).toBe(
      "github.ref == 'refs/heads/main' && github.event_name == 'push' && github.run_attempt == '1'",
    );
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

  test("reads no tag: expressions bind only the release checkout and build's digest", () => {
    const expressions = [...JSON.stringify(attest).matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/gu)].map(
      (m) => m[1],
    );
    expect(new Set(expressions)).toEqual(new Set(["github.sha", "needs.publish.outputs.digest"]));
    // No step pulls, inspects or retags an image, and none uses a registry action.
    for (const s of attest.steps) {
      expect(s.run ?? "").not.toMatch(/docker|imagetools|crane|oras|skopeo|gh api/u);
      if (s.uses) expect(s.uses).toMatch(/^(?:actions\/(?:attest|checkout)|oven-sh\/setup-bun)@/u);
    }
  });

  test("checks the digest before signing, since an empty one would sign discovered subjects", () => {
    const names = attest.steps.map((s) => s.name);
    expect(names.filter(Boolean)).toEqual([
      "Check the digest the build returned",
      "Recheck reviewed scanner exceptions before signing",
      "Attest build provenance",
    ]);
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

describe("reviewed exception expiry before registry/signature writes", () => {
  test("both bounded jobs use their own release source and cannot install runtime policy overrides", () => {
    // A successful earlier scan cannot authorize an expired exception after another job waits.
    for (const j of [attest, latest]) {
      expect(j["timeout-minutes"]).toBe(10);
      const checkout = j.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with).toEqual({ ref: expr("github.sha"), "persist-credentials": false });
      const setup = j.steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
      expect(setup?.with).toEqual({ "bun-version-file": "package.json" });
      expect(j.steps.map((s) => s.run ?? "").join("\n")).not.toMatch(/bun install|--policy/u);
    }
    const signIndex = attest.steps.indexOf(stepOf(attest, "Attest build provenance"));
    expect(attest.steps[signIndex - 1]?.run).toBe(
      "bun --no-env-file scripts/release-scan-exceptions.ts sign",
    );
    const promote = stepOf(latest, "Advance the latest tag after successful publication").run ?? "";
    const check = "bun --no-env-file scripts/release-scan-exceptions.ts promote";
    expect(promote.indexOf(check)).toBeGreaterThan(
      promote.indexOf('if [ "$current" != "$GITHUB_SHA" ]'),
    );
    expect(promote.slice(promote.indexOf(check)).trim().split("\n")).toEqual([
      check,
      `docker buildx imagetools create --tag "$image:latest" "$image@\${DIGEST}"`,
    ]);
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
    expect(needsOf(latest).sort()).toEqual(["attest", "publish", "release"]);
    expect(latest.if).toContain("needs.release.outputs.accepted == 'true'");
    expect(latest.if).toContain("needs.attest.result == 'success'");
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
