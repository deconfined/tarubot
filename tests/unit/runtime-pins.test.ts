/** Keep version pins that Dependabot updates separately, or cannot see, in lockstep. */
import { expect, test } from "bun:test";
import manifest from "../../package.json" with { type: "json" };

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

test("the Bun runtime pin agrees across package.json, its types, and every image stage", async () => {
  const version = manifest.engines.bun;
  // setup-bun reads packageManager first, so CI and the images must name the same release.
  expect(manifest.packageManager).toBe(`bun@${version}`);
  expect(manifest.devDependencies["@types/bun"]).toBe(version);
  const stages = [...(await read("Dockerfile")).matchAll(/^FROM\s+oven\/bun:([^\s@]+)/gm)];
  expect(stages.length).toBeGreaterThan(0);
  // The official Alpine variant supplies Bun's musl binary on both supported architectures.
  for (const [, tag] of stages) expect(tag).toBe(`${version}-alpine`);
});
