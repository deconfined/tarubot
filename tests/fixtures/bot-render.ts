/**
 * A test renderer for ops/ansible/templates/bot/ (#62): the bot's Quadlet unit and its settings
 * file, as ops/ansible/bot.yml renders them with Ansible's template module, without Ansible. The
 * unit tests read its output (quadlet.test.ts, container-hardening.test.ts, bot-play.test.ts), CI
 * runs Podman's generator over it, and CI's Playbook job renders both templates with Ansible's own
 * template module and diffs the two, so the renderer can't drift from Ansible unnoticed.
 *
 * It supports only the subset the templates use, and throws on anything else:
 * - `{{ name }}` or `{{ name.field }}`, one space inside each brace pair, naming a string;
 * - `{% for x in list %}` ... `{% endfor %}` and `{% if name %}` ... `{% endif %}`, each tag alone
 *   on its line at column 0. Ansible's template module sets trim_blocks, so such a line leaves
 *   nothing behind, not even its newline (and without lstrip_blocks, indentation before a tag
 *   would stay, which is why none is allowed).
 *
 * It imports only from bun, node: and a relative fixture, nothing from node_modules, so CI's
 * Playbook job runs it without `bun install`:
 *
 *   bun tests/fixtures/bot-render.ts OUTDIR
 *
 * writes OUTDIR/staging/tarubot.container, tarubot.env and vars.json (exactly the variables the
 * two templates receive), for a sample digest and placeholder identity values.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { root } from "./quadlet.js";

/** The variables the two templates receive: strings, and lists of string records. */
export type TemplateVars = Record<string, unknown>;

/** What bot.yml reads from the release image: the application and the registration scope. */
export interface Identity {
  applicationId: string;
  registrationScope: string;
}

/** A sample digest for the CLI's output; any sha256 value renders the same way. */
export const SAMPLE_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
/** Placeholders for the CLI's output, which never carries a Discord ID. */
export const PLACEHOLDER_IDENTITY: Identity = {
  applicationId: "APPLICATION_ID_FROM_THE_IMAGE",
  registrationScope: "TEST_GUILD_ID_FROM_THE_IMAGE",
};

/** A parsed template: text lines with substitutions, and the two block forms. */
type Node =
  | { kind: "text"; line: string; at: number }
  | { kind: "for"; variable: string; list: string; body: Node[]; at: number }
  | { kind: "if"; test: string; body: Node[]; at: number };

const NAME = "[a-z_][a-z0-9_]*";
const PATH = `${NAME}(?:\\.${NAME})*`;
const FOR = new RegExp(`^\\{% for (${NAME}) in (${PATH}) %\\}$`, "u");
const IF = new RegExp(`^\\{% if (${PATH}) %\\}$`, "u");
const SUBSTITUTION = new RegExp(`\\{\\{ (${PATH}) \\}\\}`, "gu");
/** Any Jinja delimiter left once the supported forms are taken out. */
const DELIMITER = /\{\{|\}\}|\{%|%\}|\{#|#\}/u;

/** Parse lines into nodes up to the closing tag `until` (none at the top level). */
function parse(lines: string[], start: number, until: string | null): [Node[], number] {
  const nodes: Node[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const at = index + 1;
    const loop = FOR.exec(line);
    const test = IF.exec(line);
    if (line === "{% endfor %}" || line === "{% endif %}") {
      if (line !== until) throw new Error(`line ${at}: ${line} closes nothing open`);
      return [nodes, index + 1];
    }
    if (loop?.[1] && loop[2]) {
      const [body, next] = parse(lines, index + 1, "{% endfor %}");
      nodes.push({ kind: "for", variable: loop[1], list: loop[2], body, at });
      index = next;
    } else if (test?.[1]) {
      const [body, next] = parse(lines, index + 1, "{% endif %}");
      nodes.push({ kind: "if", test: test[1], body, at });
      index = next;
    } else {
      if (DELIMITER.test(line.replace(SUBSTITUTION, "")))
        throw new Error(`line ${at}: a template form the test renderer doesn't support`);
      nodes.push({ kind: "text", line, at });
      index += 1;
    }
  }
  if (until !== null) throw new Error(`${until} is missing`);
  return [nodes, index];
}

/** A dotted name's value in the scope, failing on anything undefined. */
function lookup(scope: Record<string, unknown>, path: string, at: number): unknown {
  let value: unknown = scope;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value))
      throw new Error(`line ${at}: ${path} is undefined`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Jinja's truth: empty strings and lists, false, null and zero are false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** Render nodes into lines. Substitutions take strings only, which Ansible writes as they are. */
function evaluate(nodes: Node[], scope: Record<string, unknown>): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "text")
      return [
        node.line.replace(SUBSTITUTION, (_match, path: string) => {
          const value = lookup(scope, path, node.at);
          if (typeof value !== "string")
            throw new Error(`line ${node.at}: ${path} is not a string`);
          return value;
        }),
      ];
    if (node.kind === "if")
      return truthy(lookup(scope, node.test, node.at)) ? evaluate(node.body, scope) : [];
    const list = lookup(scope, node.list, node.at);
    if (!Array.isArray(list)) throw new Error(`line ${node.at}: ${node.list} is not a list`);
    return list.flatMap((item) => evaluate(node.body, { ...scope, [node.variable]: item }));
  });
}

/**
 * Render a template the way Ansible's template module does for the supported subset: block-tag
 * lines vanish (trim_blocks), and the file's final newline stays.
 */
export function render(template: string, vars: TemplateVars): string {
  const lines = template.split("\n");
  const [nodes] = parse(lines, 0, null);
  return evaluate(nodes, vars).join("\n");
}

/** A YAML mapping from a repository file. */
async function mapping(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = YAML.parse(await Bun.file(root(path)).text());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${path} is not a mapping`);
  return parsed as Record<string, unknown>;
}

/** A list of names from a vars file. */
function names(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
    throw new Error(`${what} is not a list of names`);
  return value;
}

/** A settings mapping's entries, whose values must be strings, as bot.yml's dict2items gives them. */
function entries(value: unknown, what: string): { name: string; value: string }[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${what} is not a mapping`);
  return Object.entries(value).map(([name, setting]) => {
    if (typeof setting !== "string") throw new Error(`${what}.${name} is not a quoted string`);
    return { name, value: setting };
  });
}

/**
 * The variables bot.yml gives the two templates on staging for a deploy or bot action, computed the
 * way its "Assemble the container's settings and mounts" task does from vars/bot.yml and
 * vars/targets/staging.yml: the fixed settings, the target's, then the identity (TEST_GUILD_ID
 * empty for a global registration); one NAME_FILE line and one mount per declared secret.
 */
export async function stagingVars(digest: string, identity: Identity): Promise<TemplateVars> {
  const bot = await mapping("ops/ansible/vars/bot.yml");
  const target = await mapping("ops/ansible/vars/targets/staging.yml");
  const secrets = names(target.tarubot_secrets, "tarubot_secrets");
  return {
    tb_image_repository: bot.tb_image_repository,
    tarubot_digest: digest,
    tb_mounts: secrets.map((name) => ({
      secret: `tarubot-${name.toLowerCase().replaceAll("_", "-")}`,
      target: name.toLowerCase(),
    })),
    tb_env: [
      ...entries(bot.tb_base_settings, "tb_base_settings"),
      ...entries(target.tarubot_settings, "tarubot_settings"),
      { name: "DISCORD_APPLICATION_ID", value: identity.applicationId },
      {
        name: "TEST_GUILD_ID",
        value: identity.registrationScope === "global" ? "" : identity.registrationScope,
      },
    ],
    tb_files: secrets.map((name) => ({ name, path: name.toLowerCase() })),
  };
}

/** The rendered staging unit and settings file, and the variables they came from. */
export async function renderStaging(digest: string, identity: Identity) {
  const vars = await stagingVars(digest, identity);
  const template = (name: string) => Bun.file(root(`ops/ansible/templates/bot/${name}`)).text();
  return {
    vars,
    container: render(await template("tarubot.container.j2"), vars),
    env: render(await template("tarubot.env.j2"), vars),
  };
}

// The CLI: bun tests/fixtures/bot-render.ts OUTDIR
if (import.meta.main) {
  const out = process.argv[2];
  if (!out || process.argv.length !== 3) {
    console.error("usage: bun tests/fixtures/bot-render.ts OUTDIR");
    process.exit(64);
  }
  const rendered = await renderStaging(SAMPLE_DIGEST, PLACEHOLDER_IDENTITY);
  const directory = join(out, "staging");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "tarubot.container"), rendered.container);
  writeFileSync(join(directory, "tarubot.env"), rendered.env);
  writeFileSync(join(directory, "vars.json"), `${JSON.stringify(rendered.vars, null, 2)}\n`);
}
