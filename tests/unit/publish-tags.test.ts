/**
 * Execute publish.yml's real version-publication and tagging scripts against a fake registry.
 * A release version is tagged once, never over another commit's release; a re-run of this
 * commit's own run resumes with its own index; an unreadable registry asks for a re-run.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nested CLI fixtures need a bounded allowance under slow or emulated runners.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "publish-tags-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Job = { steps?: { id?: string; run?: string }[] };
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const step = (job: string, id: string) =>
  workflow.jobs[job]?.steps?.find((candidate) => candidate.id === id)?.run ?? "";
const prepare = step("prepare", "publication");
const merge = step("publish", "merge");
if (!prepare || !merge) throw new Error("missing-publication-scripts");

const SHA = "c".repeat(40);
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
const AMD64 = digest("amd64");
const ARM64 = digest("arm64");
const OTHER = digest("another commit's release");

type Registry = {
  /** Tag -> index digest. */
  tags: Record<string, string>;
  /** Tags whose reads fail with a server error. */
  failing: string[];
};

function fixture(registry: Registry) {
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const state = join(directory, "registry.json");
  const calls = join(directory, "calls");
  const output = join(directory, "github-output");
  writeFileSync(state, JSON.stringify(registry));
  writeFileSync(calls, "");
  // Answers like GHCR and curl do, so a script that drops a flag fails here too: credentials come
  // only from --config - on stdin; manifests need the bearer token and the index media type;
  // --fail turns >= 400 into exit 22; output goes only to --write-out and to --dump-header -.
  writeFileSync(
    join(bin, "curl"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const config = await new Response(Bun.stdin.stream()).text();
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["curl", ...args]) + "\\n");
const url = args.find((arg) => arg.startsWith("https://"));
const flag = (name) => args.includes(name);
const after = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const answer = (code, headers = "") => {
  if (flag("--fail") && code >= 400) {
    if (flag("--write-out")) process.stdout.write(String(code));
    process.exit(22);
  }
  if (after("--dump-header") === "-") process.stdout.write("HTTP/2 " + code + "\\r\\n" + headers + "\\r\\n");
  if (flag("--write-out")) process.stdout.write(String(code));
  process.exit(0);
};
if (!args.includes("--config") || after("--config") !== "-") process.exit(70);
if (url?.startsWith("https://ghcr.io/token?")) {
  if (!config.includes('user = "invented-user:invented-github-token"')) answer(401);
  process.stdout.write(JSON.stringify({ token: "invented-token" }));
  process.exit(0);
}
const match = url?.match(/^https:\\/\\/ghcr\\.io\\/v2\\/deconfined\\/tarubot\\/manifests\\/([A-Za-z0-9._-]+)$/);
if (!match || !flag("--head")) process.exit(70);
if (!config.includes('header = "Authorization: Bearer invented-token"')) answer(401);
if (!(after("--header") ?? "").includes("application/vnd.oci.image.index.v1+json")) answer(404);
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const tag = match[1];
if (registry.failing.includes(tag)) answer(500);
if (!registry.tags[tag]) answer(404);
answer(200, "docker-content-digest: " + registry.tags[tag] + "\\r\\n");
`,
    { mode: 0o700 },
  );
  // imagetools create: one index source is re-tagged byte for byte; several are merged into a
  // new index whose digest depends on its sources.
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["docker", ...args]) + "\\n");
if (args[0] !== "buildx" || args[1] !== "imagetools" || args[2] !== "create") process.exit(70);
const tags = [], sources = [];
for (let i = 3; i < args.length; i++) {
  if (args[i] === "--tag") tags.push(args[++i].split(":").at(-1));
  else sources.push(args[i].split("@").at(-1));
}
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const merged = sources.length === 1 ? sources[0] : "sha256:" + createHash("sha256").update(sources.join(",")).digest("hex");
for (const tag of tags) registry.tags[tag] = merged;
writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
`,
    { mode: 0o700 },
  );
  const run = (script: string, changes: Record<string, string> = {}) => {
    writeFileSync(output, "");
    const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], {
      cwd: directory,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "deconfined/tarubot",
        GITHUB_SHA: SHA,
        GHCR_USER: "invented-user",
        GHCR_TOKEN: "invented-github-token",
        VERSION: "2.38.0",
        RELEASE_REQUESTED: "true",
        AMD64,
        ARM64,
        ...changes,
      },
      stdin: "ignore",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
    });
    const stdout = result.stdout.toString();
    expect(stdout + result.stderr.toString()).not.toContain("invented-github-token");
    return {
      code: result.exitCode,
      stdout,
      output: readFileSync(output, "utf8").split("\n").filter(Boolean),
      registry: () => JSON.parse(readFileSync(state, "utf8")) as Registry,
      creates: () =>
        readFileSync(calls, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args[0] === "docker"),
    };
  };
  return { run };
}

const commitTag = `sha-${SHA}`;
const mergedIndex = digest("both");

describe("version publication check", () => {
  test("an absent version publishes", () => {
    const run = fixture({ tags: {}, failing: [] }).run(prepare);
    expect(run.code).toBe(0);
    expect(run.output).toEqual(["publish=true"]);
  });

  test("a present version on a maintenance commit publishes nothing", () => {
    const run = fixture({ tags: { "2.38.0": OTHER }, failing: [] }).run(prepare, {
      RELEASE_REQUESTED: "false",
    });
    expect(run.code).toBe(0);
    expect(run.output).toEqual(["publish=false"]);
  });

  test("this commit's own published release resumes after Re-run all jobs", () => {
    const run = fixture({
      tags: { "2.38.0": mergedIndex, [commitTag]: mergedIndex },
      failing: [],
    }).run(prepare);
    expect(run.code).toBe(0);
    expect(run.output).toEqual(["publish=true"]);
    expect(run.stdout).toContain("resuming with its own index");
  });

  test("a maintenance commit that finished an unpublished release resumes it after Re-run all jobs", () => {
    const run = fixture({
      tags: { "2.38.0": mergedIndex, [commitTag]: mergedIndex },
      failing: [],
    }).run(prepare, { RELEASE_REQUESTED: "false" });
    expect(run.code).toBe(0);
    expect(run.output).toEqual(["publish=true"]);
    expect(run.stdout).toContain("resuming with its own index");
  });

  test("another commit's release is refused", () => {
    for (const tags of [{ "2.38.0": OTHER }, { "2.38.0": OTHER, [commitTag]: mergedIndex }]) {
      const run = fixture({ tags, failing: [] }).run(prepare);
      expect(run.code).toBe(1);
      expect(run.output).toEqual([]);
      expect(run.stdout).toContain("already published from another commit");
    }
  });

  test("an unreadable registry asks for a re-run instead of blaming another commit", () => {
    for (const failing of [["2.38.0"], [commitTag]]) {
      const run = fixture({
        tags: { "2.38.0": mergedIndex, [commitTag]: mergedIndex },
        failing,
      }).run(prepare);
      expect(run.code).toBe(1);
      expect(run.output).toEqual([]);
      expect(run.stdout).not.toContain("another commit");
    }
  });
});

describe("tagging one index of both platforms", () => {
  test("tags this commit first, then the version from that exact index", () => {
    const run = fixture({ tags: {}, failing: [] }).run(merge);
    expect(run.code).toBe(0);
    const creates = run.creates();
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      `ghcr.io/deconfined/tarubot:${commitTag}`,
      `ghcr.io/deconfined/tarubot@${AMD64}`,
      `ghcr.io/deconfined/tarubot@${ARM64}`,
    ]);
    const tags = run.registry().tags;
    expect(creates[1]).toEqual([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      "ghcr.io/deconfined/tarubot:2.38.0",
      `ghcr.io/deconfined/tarubot@${tags[commitTag]}`,
    ]);
    expect(tags["2.38.0"]).toBe(tags[commitTag]);
    expect(run.output).toEqual([`digest=${tags["2.38.0"]}`]);
  });

  test("a commit tag left by a partial earlier attempt is retagged, never trusted alone", () => {
    const run = fixture({ tags: { [commitTag]: OTHER }, failing: [] }).run(merge);
    expect(run.code).toBe(0);
    const tags = run.registry().tags;
    expect(tags[commitTag]).not.toBe(OTHER);
    expect(tags["2.38.0"]).toBe(tags[commitTag]);
  });

  test("a re-run resumes with this commit's own tagged index and creates nothing", () => {
    const run = fixture({
      tags: { "2.38.0": mergedIndex, [commitTag]: mergedIndex },
      failing: [],
    }).run(merge);
    expect(run.code).toBe(0);
    expect(run.creates()).toEqual([]);
    expect(run.output).toEqual([`digest=${mergedIndex}`]);
  });

  test("a maintenance commit that lost the race to its release finishes without a digest", () => {
    const run = fixture({ tags: { "2.38.0": OTHER }, failing: [] }).run(merge, {
      RELEASE_REQUESTED: "false",
    });
    expect(run.code).toBe(0);
    expect(run.creates()).toEqual([]);
    expect(run.output).toEqual([]);
    expect(run.registry().tags["2.38.0"]).toBe(OTHER);
    expect(run.stdout).toContain("Published maintenance version retained");
  });

  test("never overwrites another commit's release, and says when GHCR can't be read", () => {
    const foreign = fixture({ tags: { "2.38.0": OTHER }, failing: [] }).run(merge);
    expect(foreign.code).toBe(1);
    expect(foreign.creates()).toEqual([]);
    expect(foreign.registry().tags["2.38.0"]).toBe(OTHER);
    expect(foreign.stdout).toContain("already published from another commit");
    const unreadable = fixture({
      tags: { "2.38.0": mergedIndex, [commitTag]: mergedIndex },
      failing: [commitTag],
    }).run(merge);
    expect(unreadable.code).toBe(1);
    expect(unreadable.creates()).toEqual([]);
    expect(unreadable.stdout).toContain("re-run once GHCR answers");
  });
});
