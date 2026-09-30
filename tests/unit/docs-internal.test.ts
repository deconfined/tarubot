/** Keep contributor navigation usable without Git metadata, site dependencies or live credentials. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const files = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "REQUIREMENTS.md",
  "ops/tofu/README.md",
  ...[...new Bun.Glob("**/*.md").scanSync({ cwd: resolve(root, "docs") })].map(
    (path) => `docs/${path}`,
  ),
];

/** Examples are not navigation; skip fenced blocks before examining links or headings. */
const prose = (text: string) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "");

/** GFM heading IDs, including the suffix for repeated headings in these hand-written guides. */
function anchors(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    const base = (match[1] ?? "")
      .toLowerCase()
      .replace(/<[^>]*>/gu, "")
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/gu, "-");
    let slug = base;
    for (let suffix = 1; found.has(slug); suffix++) slug = `${base}-${suffix}`;
    found.add(slug);
  }
  return found;
}

test("internal guides link to existing files and Markdown headings", () => {
  const problems: string[] = [];
  for (const file of files) {
    for (const match of prose(read(file)).matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/gu)) {
      const target = match[1] ?? "";
      if (/^(?:[a-z]+:|\/\/)/iu.test(target)) continue;
      const [path = "", fragment] = target.split("#");
      const destination = path
        ? resolve(root, dirname(file), decodeURI(path))
        : resolve(root, file);
      if (!existsSync(destination)) {
        problems.push(`${file}: missing ${target}`);
      } else if (fragment && /\.mdx?$/u.test(destination)) {
        if (!anchors(readFileSync(destination, "utf8")).has(decodeURIComponent(fragment)))
          problems.push(`${file}: missing heading ${target}`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test("the archive retains permanent pointers rather than another copy of session diaries", () => {
  const archive = read("docs/archive/README.md");
  const revision = "b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8";
  // These record names are deliberately historical: the current tree must not recreate their backlog.
  for (const path of [
    "REQUIREMENTS.md",
    ...[
      "REPLIES",
      "VERIFICATION",
      "DEV_GUILD",
      "OPEN_ITEMS",
      "SESSION_HANDOFF",
      "HOSTING",
      "DEPLOYMENT",
      "CI_CD",
      "MIGRATION",
      "APP_PLATFORM",
    ].map((name) => `docs/${name}.md`),
    "docs/proposals/app-platform-deploy-workflow.md",
  ])
    expect(archive).toContain(`https://github.com/deconfined/tarubot/blob/${revision}/${path}`);
  expect(archive).not.toContain("/blob/main/");
  for (const name of ["SESSION_HANDOFF", "OPEN_ITEMS", "VERIFICATION", "MIGRATION", "APP_PLATFORM"])
    expect(existsSync(resolve(root, `docs/${name}.md`))).toBe(false);
});

test("the widened deployment restriction is also preserved verbatim", () => {
  const requirements = read("REQUIREMENTS.md");
  const rule = /\n> (Agents, Claude sessions included, [^\n]+)\n/u.exec(requirements)?.[1];
  expect(rule).toBeDefined();
  expect(read("AGENTS.md")).toContain(`- ${rule}\n`);
  for (const clause of [
    "never hold `ANSIBLE_SSH_KEY` or any other environment secret",
    "never approve, reject or re-run a deployment or an Infrastructure run",
    "never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments",
    "dispatch Deploy or Infrastructure only when the owner asks in that session",
  ])
    expect(rule).toContain(clause);
});
