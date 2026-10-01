/** Separate ordinary validated changes from explicit versioned releases. */
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { testSessionSchema } from "../src/application/test-session.js";

/** SemVer syntax includes prereleases/build metadata and rejects numeric leading zeroes. */
export function validateVersion(value: string): string {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    throw new Error("package.json must contain a valid SemVer version.");
  return value;
}

/** Equal versions are maintenance; only an increase requires a matching release note. */
export function checkRelease(
  version: string,
  previous: string | null,
  ref: string,
  changelog: string,
): string {
  validateVersion(version);
  // Docker tags cannot contain SemVer build metadata, and silently sanitizing it creates collisions.
  if (version.includes("+") || version.length > 128)
    throw new Error(
      "Published versions must omit build metadata and fit Docker's 128-character tag limit.",
    );
  const order = previous === null ? 0 : Bun.semver.order(version, validateVersion(previous));
  if (order < 0) throw new Error("package.json must not decrease below its base version.");
  if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`)
    throw new Error("Release tag must match package.json as vMAJOR.MINOR.PATCH.");
  if (
    order > 0 &&
    !changelog
      .split(/\r?\n/)
      .some((line) => line === `## ${version}` || line.startsWith(`## ${version} `))
  )
    throw new Error("CHANGELOG.md needs an entry for the current version.");
  return version;
}

/** Release metadata uses the same bounded startup-plan schema as the bot. */
export function checkStartupPlan(version: string, value: unknown): void {
  const plan = testSessionSchema.parse(value);
  if (!plan.title.split(/\s+/).includes(version))
    throw new Error("test-plans/current.json title must name the release version.");
}

if (import.meta.main) {
  const manifest = z.object({ version: z.string() }).parse(await Bun.file("package.json").json());
  const base = process.env.CI_BASE_SHA ?? "";
  let previous: string | null = null;
  if (base && !/^0+$/.test(base)) {
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error("Invalid CI base revision.");
    const child = Bun.spawn(["git", "show", `${base}:package.json`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    if ((await child.exited) !== 0)
      throw new Error("CI could not read its base manifest; fetch complete history.");
    previous = z.object({ version: z.string() }).parse(JSON.parse(text)).version;
  }
  const version = checkRelease(
    manifest.version,
    previous,
    process.env.GITHUB_REF ?? "",
    await Bun.file("CHANGELOG.md").text(),
  );
  // No base (including an initial push or manual dispatch) cannot establish a release.
  const release = previous !== null && Bun.semver.order(version, previous) > 0;
  if (release) checkStartupPlan(version, await Bun.file("test-plans/current.json").json());
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nrelease=${release}\n`);
  console.log(`Validated version ${version}: ${release ? "release" : "no release"}.`);
}
