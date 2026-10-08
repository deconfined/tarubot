/** Keep current guide navigation usable without Git metadata, site dependencies or live credentials. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const files = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "REQUIREMENTS.md",
  ...[...new Bun.Glob("**/*.md").scanSync({ cwd: resolve(root, "docs") })].map(
    (path) => `docs/${path}`,
  ),
  ...[...new Bun.Glob("**/*.md").scanSync({ cwd: resolve(root, "site/src/content/docs") })].map(
    (path) => `site/src/content/docs/${path}`,
  ),
];

/** Examples are not navigation; skip fenced blocks before examining links or headings. */
const prose = (text: string) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "");

/** GFM heading IDs, including the suffix for repeated headings in these hand-written guides. */
function anchors(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    // Parse inline HTML as DOM text; headings become comparison slugs, never rendered markup.
    const heading = parseHTML(`<html><body>${match[1] ?? ""}</body></html>`).document.body
      .textContent;
    const base = (heading ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/gu, "-");
    let slug = base;
    for (let suffix = 1; found.has(slug); suffix++) slug = `${base}-${suffix}`;
    found.add(slug);
  }
  return found;
}

test("current guides link to existing files and Markdown headings", () => {
  const problems: string[] = [];
  for (const file of files) {
    for (const match of prose(read(file)).matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/gu)) {
      let target = match[1] ?? "";
      const repositoryLink =
        /^https:\/\/github\.com\/deconfined\/tarubot\/(?:blob|tree)\/main\/(.+)$/u.exec(target);
      if (repositoryLink) target = repositoryLink[1] ?? "";
      else if (/^(?:[a-z]+:|\/\/)/iu.test(target)) continue;
      const [path = "", fragment] = target.split("#");
      let destination: string;
      if (path.startsWith("/tarubot/")) {
        const slug = path.slice("/tarubot/".length).replace(/\/$/u, "") || "index";
        // A name with an extension is a file the site publishes from site/public, not a page.
        destination = /\.[a-z0-9]+$/iu.test(slug)
          ? resolve(root, "site/public", decodeURI(slug))
          : resolve(root, "site/src/content/docs", `${decodeURI(slug)}.md`);
      } else {
        destination = path
          ? resolve(root, repositoryLink ? "." : dirname(file), decodeURI(path))
          : resolve(root, file);
      }
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
