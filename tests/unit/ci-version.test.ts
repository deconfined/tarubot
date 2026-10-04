/** Maintenance remains validated; publication requires an explicit, consistent version increase. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, checkStartupPlan, validateVersion } from "../../scripts/ci-version.js";

// Hosted CI and image builds run these real Git fixtures, including emulated ARM64.
const hasGit = Bun.which("git") !== null;

test("release validation accepts SemVer and rejects invalid numeric prerelease identifiers", () => {
  for (const version of ["2.8.0", "2.8.0-rc.1", "2.8.0+build.5"])
    expect(validateVersion(version)).toBe(version);
  for (const version of ["2.8", "02.8.0", "2.8.0-01", "2.8.0-", "2.8.0+", "latest"])
    expect(() => validateVersion(version)).toThrow("SemVer");
});

test("maintenance accepts an unchanged version without a fresh changelog entry", () => {
  expect(checkRelease("2.8.0", "2.8.0", "refs/heads/main", "## 2.7.1\n")).toBe("2.8.0");
  expect(checkRelease("2.8.0", "2.8.0", "", "")).toBe("2.8.0");
});

test("a release must advance the version and include its matching changelog entry", () => {
  expect(checkRelease("2.8.0", "2.7.1", "refs/heads/main", "## 2.8.0 — CI/CD\n")).toBe("2.8.0");
  expect(() => checkRelease("2.8.0", "2.7.1", "", "## 2.7.1\n")).toThrow("CHANGELOG");
  expect(() => checkRelease("2.8.0", "2.7.1", "", "## 2.8.01\n")).toThrow("CHANGELOG");
});

test("version decreases fail even when the lower version has a changelog entry", () => {
  expect(() => checkRelease("2.8.0", "2.9.0", "", "## 2.8.0\n")).toThrow("decrease");
  expect(() => checkRelease("2.8.0-rc.1", "2.8.0", "", "## 2.8.0-rc.1\n")).toThrow("decrease");
});

test("unknown bases validate the version without demanding release metadata", () => {
  expect(checkRelease("2.8.0", null, "refs/heads/main", "")).toBe("2.8.0");
});

test("tag publication requires the exact manifest version", () => {
  expect(checkRelease("2.8.0", null, "refs/tags/v2.8.0", "## 2.8.0\n")).toBe("2.8.0");
  expect(() => checkRelease("2.8.0", null, "refs/tags/v2.7.1", "## 2.8.0\n")).toThrow(
    "Release tag",
  );
});

test("publishable SemVer maps exactly to an unambiguous Docker tag", () => {
  expect(() => checkRelease("2.8.1+build.5", null, "", "## 2.8.1+build.5\n")).toThrow(
    "build metadata",
  );
  const long = `2.8.1-${"a".repeat(128)}`;
  expect(() => checkRelease(long, null, "", `## ${long}\n`)).toThrow("128-character");
  expect(checkRelease("2.8.1-build.5", null, "", "## 2.8.1-build.5\n")).toBe("2.8.1-build.5");
});

function startupPlan(version: string): Record<string, unknown> {
  return {
    title: `Session: ${version} release checks`,
    objective: "Check the invented release.",
    user: ["Review the result."],
    assistant: ["Run local checks."],
    bot: ["Post the plan on an authorized restart."],
  };
}

test("release startup plans match the exact version and keep existing structural bounds", () => {
  expect(() => checkStartupPlan("2.8.0", startupPlan("2.8.0"))).not.toThrow();
  for (const title of ["Session: 2.7.1 release", "Session: 2.8.01 release"])
    expect(() => checkStartupPlan("2.8.0", { ...startupPlan("2.8.0"), title })).toThrow(
      "release version",
    );
  expect(() => checkStartupPlan("2.8.0", { ...startupPlan("2.8.0"), user: [] })).toThrow();
});

/** Real local Git objects exercise the CLI's base reader without using repository history. */
async function versionFixture(options: {
  version: string;
  previous?: string;
  base?: string;
  changelog?: string;
  plan?: unknown;
}): Promise<{ code: number; output: string; error: string }> {
  const directory = await mkdtemp(join(tmpdir(), "tarubot-version-test-"));
  const environment = {
    PATH: process.env.PATH,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.org",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.org",
  };
  try {
    const git = async (args: string[], input?: string): Promise<string> => {
      const child = Bun.spawn(["git", ...args], {
        cwd: directory,
        env: environment,
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`Invented Git fixture failed: ${error}`);
      return output.trim();
    };
    let base = options.base ?? "";
    if (options.previous !== undefined) {
      await git(["init", "--quiet"]);
      const blob = await git(
        ["hash-object", "-w", "--stdin"],
        JSON.stringify({ version: options.previous }),
      );
      const tree = await git(["mktree"], `100644 blob ${blob}\tpackage.json\n`);
      base = await git(["commit-tree", tree], "Invented CI base\n");
    }
    await Bun.write(join(directory, "package.json"), JSON.stringify({ version: options.version }));
    await Bun.write(join(directory, "CHANGELOG.md"), options.changelog ?? "");
    if (options.plan !== undefined)
      await Bun.write(join(directory, "test-plans/current.json"), JSON.stringify(options.plan));
    const outputPath = join(directory, "outputs");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        new URL("../../scripts/ci-version.ts", import.meta.url).pathname,
      ],
      {
        cwd: directory,
        env: {
          ...environment,
          CI_BASE_SHA: base,
          GITHUB_REF: "refs/heads/main",
          GITHUB_OUTPUT: outputPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, , error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      code,
      output: (await Bun.file(outputPath).exists()) ? await Bun.file(outputPath).text() : "",
      error,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// QEMU slows nested Git/Bun startup; keep its budget on the CLI tests, not pure validation.

test.skipIf(!hasGit)(
  "the CLI exposes a release only for a known increase with consistent metadata",
  async () => {
    const maintenance = await versionFixture({ version: "2.8.0", previous: "2.8.0" });
    expect(maintenance.code, maintenance.error).toBe(0);
    expect(maintenance.output).toBe("version=2.8.0\nrelease=false\n");
    const release = await versionFixture({
      version: "2.8.0",
      previous: "2.7.1",
      changelog: "## 2.8.0 — Release\n",
      plan: startupPlan("2.8.0"),
    });
    expect(release.code, release.error).toBe(0);
    expect(release.output).toBe("version=2.8.0\nrelease=true\n");
    const stalePlan = await versionFixture({
      version: "2.8.0",
      previous: "2.7.1",
      changelog: "## 2.8.0\n",
      plan: startupPlan("2.7.1"),
    });
    expect(stalePlan.code).not.toBe(0);
    expect(stalePlan.output).toBe("");
  },
  60_000,
);

test.skipIf(!hasGit)(
  "the CLI never treats missing bases as releases and refuses an unreadable declared base",
  async () => {
    for (const base of ["", "0".repeat(40)]) {
      const result = await versionFixture({ version: "2.8.0", base });
      expect(result.code, result.error).toBe(0);
      expect(result.output).toBe("version=2.8.0\nrelease=false\n");
    }
    const missing = await versionFixture({ version: "2.8.0", base: "a".repeat(40) });
    expect(missing.code).not.toBe(0);
    expect(missing.output).toBe("");
    const decreased = await versionFixture({ version: "2.7.1", previous: "2.8.0" });
    expect(decreased.code).not.toBe(0);
    expect(decreased.output).toBe("");
  },
  60_000,
);
