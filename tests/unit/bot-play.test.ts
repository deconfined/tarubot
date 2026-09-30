/**
 * The release's bot deploy (#62): ops/ansible/bot.yml, its vars, and the tarubot-tool wrapper it
 * installs. host.yml's Bot step runs the play from the release commit as root over SSH; the bot
 * runs as a rootless Quadlet unit of the tarubot user. These pin, statically and with stand-ins
 * (no Ansible, Podman or network: unit tests run in the image build):
 * - the play's shape: three plays, the phases in order, a rescue, the result written on the runner
 *   by the last play with the final assert, no meta: end_*, no play-level ansible_remote_tmp;
 * - the secrets: lookup('ansible.builtin.env', NAME) only in no_log tasks, only in the set_facts of
 *   names and booleans (and /suggest's checked client ID), in a secret's own stdin and in the
 *   settings check's stdin, never in vars, environment or a template, and only with operations
 *   that can't raise on a value (an exception's text reaches the log's [ERROR] line even under
 *   no_log); the secret task's argv, stdin and label; the refusals as plain asserts, whose names
 *   reach the log, each declaring its outcome and reason for the rescue; no_log on every tool run
 *   and container inspect; no debug and no diff;
 * - the writes: tarubot.env, the unit and the image file only in the preflight and unit phases,
 *   the unit only after Quadlet's dry run, the recovery point only after the restart;
 * - the ports from Codex's ce3ded7 (2.37.0): the in-image settings check after the identity and
 *   before the first write, /suggest's client ID and key on prod, the backup URLs on HTTPS, and
 *   the recovery point kept before the restart is checked;
 * - the settings against the code: the staging and prod lists against src/config/secrets.ts and
 *   deployment.ts, the identity script against src/config/deployment.ts, and the rendered staging
 *   and prod settings through configuration() and the tool guard;
 * - the templar cases (tests/fixtures/bot-asserts.json), which CI evaluates with ansible-core: each
 *   names a task and field bot.yml has, and together they cover the refusals the review named;
 * - tarubot-tool, run against a podman stand-in;
 * - no Discord ID, host or address in the bot's files.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { migrateToolScope } from "../../scripts/migrate.js";
import { registerToolScope } from "../../scripts/register.js";
import {
  assertToolScope,
  deployments,
  type Launch,
  PROD_DATABASES,
  PROD_ROLE,
  resolveDeployment,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import { configuration } from "../../src/config/env.js";
import { FILE_SETTINGS } from "../../src/config/secrets.js";
import { RENDERS, renderStaging, renderTarget } from "../fixtures/bot-render.js";
import {
  filesUnder,
  parseEnvFile,
  parseUnit,
  read,
  root,
  single,
  valuesOf,
} from "../fixtures/quadlet.js";

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

const ANSIBLE = "ops/ansible";
/** Every file the bot's deploy owns under ops/ansible. */
const BOT_FILES = [
  "bot.yml",
  "vars/bot.yml",
  ...filesUnder(`${ANSIBLE}/vars/targets`).map((file) => `vars/targets/${file}`),
  ...filesUnder(`${ANSIBLE}/templates/bot`).map((file) => `templates/bot/${file}`),
  ...filesUnder(`${ANSIBLE}/files/bot`).map((file) => `files/bot/${file}`),
];
/** The backup's settings, which only tarubot-backup reads. */
const BACKUP_SETTINGS = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_REGION",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "HEALTHCHECKS_BACKUP_URL",
];
/**
 * The set_fact keys that may hold an env lookup: names and booleans only, and tb_client_id, the
 * /suggest client ID (a public identifier), kept only once it matched its pattern.
 */
const LOOKUP_FACTS = [
  "tb_backup_endpoint_ok",
  "tb_backup_url_ok",
  "tb_client_id",
  "tb_client_ok",
  "tb_db_ok",
  "tb_malformed",
  "tb_missing",
  "tb_token_absent",
  "tb_token_ok",
];
/** The phases of the second play, in order. */
const PHASES = [
  "Checks",
  "Live",
  "Decide",
  "Image",
  "Migrations",
  "Identity",
  "Settings",
  "Secrets",
  "Files",
  "Preflight",
  "Unit",
  "Restart",
  "Health",
  "Timer",
  "Commands",
  "Tidy",
];

type Mapping = Record<string, unknown>;
/** A value as a YAML mapping, or a failure naming where. */
function mapping(value: unknown, where: string): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} is not a mapping`);
  return value as Mapping;
}
/** A value as a list of mappings. */
function mappings(value: unknown, where: string): Mapping[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not a list`);
  return value.map((item, index) => mapping(item, `${where}[${index}]`));
}
/** A YAML file in ops/ansible. */
const yaml = async (path: string): Promise<unknown> => YAML.parse(await read(`${ANSIBLE}/${path}`));

/** bot.yml's plays. */
const plays = async () => mappings(await yaml("bot.yml"), "bot.yml");
/** vars/bot.yml and staging's vars. */
const botVars = async () => mapping(await yaml("vars/bot.yml"), "vars/bot.yml");
const stagingVars = async () =>
  mapping(await yaml("vars/targets/staging.yml"), "vars/targets/staging.yml");
const prodVars = async () => mapping(await yaml("vars/targets/prod.yml"), "vars/targets/prod.yml");
/** A list of names from a vars file. */
function names(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${where} is not a list of names`);
  return value as string[];
}

/** One task with where it sits: its play, its phase (the second play's block children) and path. */
interface Found {
  task: Mapping;
  play: number;
  phase: string | null;
  section: "block" | "rescue" | "always" | "tasks";
}
/** Every task of every play, blocks included, depth first in file order. */
async function allTasks(): Promise<Found[]> {
  const found: Found[] = [];
  const walk = (
    tasks: Mapping[],
    play: number,
    phase: string | null,
    section: Found["section"],
    depth: number,
  ) => {
    for (const task of tasks) {
      // The second play's one top-level block holds the phases as its direct children.
      const own = play === 1 && depth === 1 && section === "block" ? String(task.name) : phase;
      found.push({ task, play, phase: own, section });
      for (const key of ["block", "rescue", "always"] as const)
        if (task[key] !== undefined)
          walk(mappings(task[key], String(task.name)), play, own, key, depth + 1);
    }
  };
  (await plays()).forEach((play, index) => {
    walk(mappings(play.tasks ?? [], `play ${index}`), index, null, "tasks", 0);
  });
  return found;
}
/** A task's own keys and values as text, without the tasks it contains. */
function ownText(task: Mapping): string {
  const { block: _block, rescue: _rescue, always: _always, ...own } = task;
  return JSON.stringify(own);
}
/** A task's module (its ansible.builtin key), or "block". */
const moduleOf = (task: Mapping) =>
  Object.keys(task).find((key) => key.startsWith("ansible.builtin.")) ??
  (task.block !== undefined ? "block" : "none");
/** A task's module arguments; none for a block. */
const argsOf = (task: Mapping) =>
  moduleOf(task).startsWith("ansible.builtin.")
    ? mapping(task[moduleOf(task)] ?? {}, String(task.name))
    : {};
/** A command task's argv as one string (a list, or a templated expression). */
const argvText = (task: Mapping) => JSON.stringify(argsOf(task).argv ?? "");

const LOOKUP = "lookup('ansible.builtin.env'";
const QUERY = "query('ansible.builtin.env'";
/** The in-image settings check (2.37.0) and its refusal. */
const SETTINGS_CHECK = "Check the settings with the release's own configuration and tool guard";
const SETTINGS_REFUSAL = "Refuse settings the release itself refuses";

describe("bot.yml's shape", () => {
  test("three plays: root finds the account, tarubot deploys, the runner writes the result", async () => {
    const [account, deploy, result, ...more] = await plays();
    expect(more).toEqual([]);
    expect({
      hosts: account?.hosts,
      become: account?.become,
      facts: account?.gather_facts,
    }).toEqual({ hosts: "target", become: false, facts: false });
    expect({
      hosts: deploy?.hosts,
      become: deploy?.become,
      user: deploy?.become_user,
      facts: deploy?.gather_facts,
      files: deploy?.vars_files,
    }).toEqual({
      hosts: "target",
      become: true,
      user: "tarubot",
      facts: false,
      files: ["vars/bot.yml"],
    });
    expect({
      hosts: result?.hosts,
      connection: result?.connection,
      facts: result?.gather_facts,
    }).toEqual({ hosts: "localhost", connection: "local", facts: false });
  });

  test("no play sets ansible_remote_tmp; only the tarubot block does, beside its environment", async () => {
    // A play-level remote tmp would follow the runner-side play's tasks and fail there.
    for (const play of await plays())
      expect(JSON.stringify(play.vars ?? {})).not.toContain("ansible_remote_tmp");
    const [outer, ...rest] = mappings((await plays())[1]?.tasks, "play 1");
    expect(rest).toEqual([]);
    expect(outer?.when).toBe("tb_result is not defined");
    expect(mapping(outer?.vars, "vars").ansible_remote_tmp).toBe("/run/user/{{ tb_uid }}");
    expect(mapping(outer?.environment, "environment")).toEqual({
      XDG_RUNTIME_DIR: "/run/user/{{ tb_uid }}",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/{{ tb_uid }}/bus",
      PYTHONNOUSERSITE: "1",
    });
    // The rescue records the outcome and reason the failed task declares in its own vars (failed
    // and - for any other), and the phase, for the last play.
    const rescue = mappings(outer?.rescue, "rescue");
    expect(rescue).toHaveLength(1);
    expect(mapping(argsOf(rescue[0] ?? {}).tb_result, "tb_result")).toEqual({
      outcome: "{{ (ansible_failed_task.vars | default({})).tb_outcome | default('failed') }}",
      reason: "{{ (ansible_failed_task.vars | default({})).tb_reason | default('-') }}",
      step: "{{ tb_step | default('checks') }}",
    });
  });

  test("the phases run in the design's order, each guarded by tb_result", async () => {
    const outer = mappings((await plays())[1]?.tasks, "play 1")[0] ?? {};
    const phases = mappings(outer.block, "phases");
    expect(phases.map((phase) => phase.name)).toEqual(PHASES);
    for (const phase of phases) {
      const when = [phase.when].flat();
      expect({ phase: phase.name, first: when[0] }).toEqual({
        phase: phase.name,
        first: "tb_result is not defined",
      });
    }
  });

  test("the last play writes the result, then fails the run unless the outcome is a success", async () => {
    const tasks = mappings((await plays())[2]?.tasks, "play 2");
    const copy = tasks.find((task) => moduleOf(task) === "ansible.builtin.copy");
    expect(argsOf(copy ?? {})).toEqual({
      content: "{{ tb_final | to_json }}\n",
      dest: "{{ tarubot_result }}",
      mode: "0600",
    });
    const last = tasks.at(-1) ?? {};
    expect(moduleOf(last)).toBe("ansible.builtin.assert");
    expect(argsOf(last).that).toEqual([
      "tb_final.outcome in ['deployed', 'superseded', 'configured', 'preflight-ok']",
    ]);
    // The result carries exactly the interface's public fields.
    const assemble = tasks.find((task) => moduleOf(task) === "ansible.builtin.set_fact");
    expect(Object.keys(mapping(argsOf(assemble ?? {}).tb_final, "tb_final"))).toEqual([
      "outcome",
      "action",
      "version",
      "previous",
      "restore_point",
      "migrations",
      "schema_head",
      "step",
      "reason",
      "warnings",
    ]);
  });

  test("the result's step list is every phase's own step, in order, so none reads as -", async () => {
    // Each phase's "Start the … step" task records tb_step; Decide reuses checks.
    const recorded = (await allTasks())
      .filter(
        ({ task }) => moduleOf(task) === "ansible.builtin.set_fact" && "tb_step" in argsOf(task),
      )
      .map(({ task }) => String(argsOf(task).tb_step));
    const steps = mapping((await plays())[2]?.vars, "play 2 vars").tb_steps;
    expect(steps).toEqual([...new Set(recorded)]);
    expect(steps).toContain("settings");
  });

  test("no meta: end_*, no debug and no diff anywhere", async () => {
    const text = await read(`${ANSIBLE}/bot.yml`);
    expect(text).not.toMatch(/ansible\.builtin\.meta|end_host|end_play|end_batch/u);
    for (const { task } of await allTasks()) {
      expect({ task: task.name, module: moduleOf(task) }).not.toEqual({
        task: task.name,
        module: "ansible.builtin.debug",
      });
      expect({ task: task.name, diff: task.diff ?? false }).toEqual({
        task: task.name,
        diff: false,
      });
    }
  });

  test("no Jinja expression holds a backslash (ansible-core 2.19+ reads them two ways)", async () => {
    // Templates keep a string literal's backslashes verbatim; conditionals unescape them. The only
    // backslashes are the YAML newlines ending the files it writes.
    const text = (await read(`${ANSIBLE}/bot.yml`))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect([...text.matchAll(/\\(?!n")/gu)]).toEqual([]);
  });

  test("a task that can fail names its outcome and reason in its own vars, and nothing else sets them", async () => {
    const all = await allTasks();
    // No set_fact records an outcome or reason ahead of a task any more.
    for (const { task } of all)
      if (moduleOf(task) === "ansible.builtin.set_fact")
        for (const key of ["tb_outcome", "tb_reason"])
          expect({ task: task.name, key, set: key in argsOf(task) }).toEqual({
            task: task.name,
            key,
            set: false,
          });
    // Every task that declares one: its phase, outcome (failed when absent) and reason.
    const declared = all
      .filter(({ task }) => task.vars !== undefined && moduleOf(task) !== "block")
      .map(({ task, phase }) => {
        const vars = mapping(task.vars, String(task.name));
        return [phase, task.name, vars.tb_outcome ?? "failed", vars.tb_reason];
      });
    expect(declared).toEqual([
      [
        "Decide",
        "Refuse a deploy without DISCORD_TOKEN on a host that runs a bot",
        "refused",
        "missing-secret",
      ],
      ["Decide", "Refuse missing secrets", "refused", "missing-secret"],
      ["Decide", "Refuse secrets with stray whitespace", "refused", "malformed-secret"],
      ["Decide", "Refuse a /suggest client ID that isn't one", "refused", "malformed-secret"],
      ["Decide", "Refuse backup URLs that don't use HTTPS", "refused", "malformed-secret"],
      ["Decide", "Refuse another target's database", "refused", "database-not-this-target"],
      ["Decide", "Refuse a preflight on a host that runs a bot", "refused", "bot-exists"],
      ["Image", "Refuse an image that isn't the release's", "refused", "image-mismatch"],
      [
        "Migrations",
        "Refuse a rollback across a migration while the live bot runs",
        "refused",
        "rollback-across-migration",
      ],
      [
        "Identity",
        "Refuse a Discord token of another application",
        "refused",
        "token-application-mismatch",
      ],
      ["Settings", "Refuse settings the release itself refuses", "refused", "settings-invalid"],
      ["Preflight", "Require Schema ready.", "failed", "schema-not-ready"],
      ["Preflight", "Run one backup", "failed", "backup-failed"],
      ["Unit", "Refuse a unit Quadlet can't turn into tarubot.service", "failed", "unit-invalid"],
      ["Restart", "Require the restart to have succeeded", "failed", "restart-failed"],
      ["Health", "Require healthy", "unhealthy", "not-healthy"],
      ["Health", "Require the same container, still healthy", "unhealthy", "not-healthy"],
      ["Health", "Require the release's own image", "unhealthy", "image-mismatch"],
      ["Commands", "Register the commands in the target's scope", "failed", "register-failed"],
      ["Commands", "Read the registration back", "failed", "register-failed"],
    ]);
    // Those vars are the outcome and the reason only, in the result's own vocabulary.
    for (const { task } of all.filter(
      ({ task }) => task.vars !== undefined && moduleOf(task) !== "block",
    )) {
      const vars = mapping(task.vars, String(task.name));
      expect(Object.keys(vars).every((key) => ["tb_outcome", "tb_reason"].includes(key))).toBe(
        true,
      );
      expect(String(vars.tb_reason)).toMatch(/^[a-z0-9-]{1,40}$/u);
    }
  });
});

describe("the secrets in bot.yml", () => {
  test("an env lookup appears only in no_log set_facts of names and booleans and in two stdins", async () => {
    const holding = new Set<string>();
    const commands: string[] = [];
    for (const { task } of await allTasks()) {
      const own = ownText(task);
      if (!own.includes("lookup(") && !own.includes("query(")) continue;
      const where = String(task.name);
      // Only the env lookup (or query, for several names), spelled in full; no other lookup or
      // query reaches the play.
      expect({
        where,
        other: own
          .replaceAll(LOOKUP, "")
          .replaceAll(QUERY, "")
          .match(/lookup\(|query\(/u),
      }).toEqual({ where, other: null });
      expect({ where, no_log: task.no_log }).toEqual({ where, no_log: true });
      const module = moduleOf(task);
      expect({ where, module }).toEqual({
        where,
        module: expect.stringMatching(/^ansible\.builtin\.(set_fact|command)$/u),
      });
      if (module === "ansible.builtin.set_fact") {
        for (const [key, value] of Object.entries(argsOf(task)))
          if (JSON.stringify(value).includes(LOOKUP)) holding.add(key);
        // A condition may read a value only to add its name to one of the two lists.
        if (JSON.stringify(task.when ?? "").includes(LOOKUP)) {
          const keys = Object.keys(argsOf(task));
          expect(keys).toEqual([expect.stringMatching(/^tb_(missing|malformed)$/u)]);
          expect(argsOf(task)[keys[0] ?? ""]).toBe(`{{ ${keys[0]} + [item] }}`);
          for (const key of keys) holding.add(key);
        }
      } else {
        // The two commands, the Podman secret and the settings check: the values are their stdin,
        // never their arguments. The secret's is one value (a query is the check's alone).
        commands.push(where);
        const { stdin, ...rest } = argsOf(task);
        if (where === SETTINGS_CHECK) expect(String(stdin)).toContain(QUERY);
        else expect(stdin).toBe(`{{ ${LOOKUP}, item) }}`);
        expect(JSON.stringify(rest)).not.toMatch(/lookup\(|query\(/u);
      }
    }
    expect([...holding].sort()).toEqual(LOOKUP_FACTS);
    expect(commands.sort()).toEqual([
      SETTINGS_CHECK,
      "Store each required value in its Podman secret",
    ]);
  });

  test("a secret's value meets only operations that can't raise on any string", async () => {
    // ansible-core 2.19 and later censor a no_log task's result, but not the [ERROR] line of an
    // exception raised while templating, which can quote the value (urlsplit's "Port could not
    // be cast to integer value as '<start of the password>'", for one). So an expression that
    // reads a value may use only these filters and tests, and .split() as its one method.
    const FILTERS = ["b64decode", "first", "join", "length", "map", "regex_escape"];
    // The settings check's stdin builds one JSON object of the values: pairing names with values
    // and serialising strings can't raise on any string either.
    const BUILDERS = ["combine", "items2dict", "to_json", "zip"];
    const TESTS = ["match"];
    /** Every string in a value, depth first. */
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? Object.values(value).flatMap(strings)
          : [];
    for (const { task } of await allTasks()) {
      const { block: _b, rescue: _r, always: _a, ...own } = task;
      const where = String(task.name);
      // Each string that reads a value: a set_fact's expression, a condition or a stdin.
      const reads = (text: string) => text.includes(LOOKUP) || text.includes(QUERY);
      for (const expression of strings(own).filter(reads)) {
        const filters = [...expression.matchAll(/\|\s*([a-z0-9_]+)/gu)].map((m) => m[1] ?? "");
        const tests = [...expression.matchAll(/\bis\s+(?:not\s+)?([a-z_]+)/gu)].map(
          (m) => m[1] ?? "",
        );
        const methods = [...expression.matchAll(/\)\s*\.([a-z_]+)\(/gu)].map((m) => m[1] ?? "");
        const allowed = where === SETTINGS_CHECK ? [...FILTERS, ...BUILDERS] : FILTERS;
        expect({ where, odd: filters.filter((f) => !allowed.includes(f)) }).toEqual({
          where,
          odd: [],
        });
        expect({ where, odd: tests.filter((t) => !TESTS.includes(t)) }).toEqual({ where, odd: [] });
        expect({ where, odd: methods.filter((m) => m !== "split") }).toEqual({ where, odd: [] });
        // The parsers that raise on malformed input, by name, whatever the syntax.
        expect(expression).not.toMatch(
          /urlsplit|from_json|from_yaml|\bint\b|\bfloat\b|to_datetime|ipaddr/u,
        );
      }
    }
    // b64decode only behind its guards: base64url characters, and never a length of 4n+1.
    const token = (await allTasks()).find(({ task }) => "tb_token_ok" in argsOf(task));
    const expression = String(argsOf(token?.task ?? {}).tb_token_ok);
    const guards = [
      expression.indexOf("is match('^[A-Za-z0-9_-]+$')"),
      expression.indexOf("% 4 != 1"),
    ];
    expect(guards.every((at) => at >= 0 && at < expression.indexOf("b64decode"))).toBe(true);
    // DATABASE_URL is checked by one regular expression, not parsed.
    const database = (await allTasks()).find(({ task }) => "tb_db_ok" in argsOf(task));
    expect(String(argsOf(database?.task ?? {}).tb_db_ok)).toContain(
      "lookup('ansible.builtin.env', 'DATABASE_URL')\n   is match('^postgres(ql)?://'",
    );
  });

  test("no play, block, vars file or template reads the environment", async () => {
    const text = (value: unknown) => JSON.stringify(value ?? "");
    const READ = /lookup\(|query\(/u;
    for (const play of await plays())
      for (const key of ["vars", "vars_files", "environment", "vars_prompt"])
        expect(text(play[key])).not.toMatch(READ);
    for (const { task } of await allTasks())
      if (moduleOf(task) === "block")
        for (const key of ["vars", "environment"])
          expect({ block: task.name, key, lookup: READ.test(text(task[key])) }).toEqual({
            block: task.name,
            key,
            lookup: false,
          });
    // Comments may describe the rule; no value may use it.
    const uncommented = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    for (const file of BOT_FILES.filter((path) => path !== "bot.yml"))
      expect({
        file,
        lookup: READ.test(uncommented(await read(`${ANSIBLE}/${file}`))),
      }).toEqual({ file, lookup: false });
  });

  test("each secret goes to Podman over stdin, one command per name, labelled by the name", async () => {
    const secret = (await allTasks()).filter(({ task }) => argvText(task).includes('"secret"'));
    expect(secret).toHaveLength(1);
    const [{ task, phase }] = secret as [Found];
    expect(phase).toBe("Secrets");
    expect(argsOf(task)).toEqual({
      argv: [
        "podman",
        "secret",
        "create",
        "--replace",
        "tarubot-{{ item | lower | replace('_', '-') }}",
        "-",
      ],
      stdin: `{{ ${LOOKUP}, item) }}`,
    });
    expect(task.loop).toBe("{{ tb_required }}");
    expect(task.loop_control).toEqual({ label: "{{ item }}" });
    expect(task.no_log).toBe(true);
    // Never in the background, where a failure would leave the value in a job file.
    expect(task.async).toBeUndefined();
    expect(task.poll).toBeUndefined();
    // Nothing ever deletes a secret.
    expect(await read(`${ANSIBLE}/bot.yml`)).not.toMatch(/secret["', \]]+(rm|remove)\b/u);
  });

  test("the refusals are plain asserts or fails without no_log, so the names reach the log", async () => {
    const checks = (await allTasks()).filter(({ task }) =>
      ["ansible.builtin.assert", "ansible.builtin.fail"].includes(moduleOf(task)),
    );
    expect(checks.length).toBeGreaterThan(10);
    for (const { task } of checks) {
      expect({ task: task.name, no_log: task.no_log ?? false }).toEqual({
        task: task.name,
        no_log: false,
      });
      // They read names, booleans and public inputs, never a value.
      expect(ownText(task)).not.toContain("lookup(");
    }
    // The missing and malformed refusals name the settings, by the environment secrets the owner
    // sets (tb_secret_names: each name's own, or tb_secret_source's).
    const messages = checks.map(({ task }) => String(argsOf(task).fail_msg ?? ""));
    for (const list of ["tb_missing", "tb_malformed"])
      expect({
        list,
        named: messages.some((message) =>
          message.includes(`{{ ${list} | map('extract', tb_secret_names) | join(', ') }}`),
        ),
      }).toEqual({ list, named: true });
  });

  test("every tool run and container inspect is no_log: their output names guilds or holds the environment", async () => {
    const sensitive =
      /"bun"|tarubot-tool|"container","inspect"|"exec"|"logs"|journalctl|registrationScope/u;
    const runs = (await allTasks()).filter(
      ({ task }) => moduleOf(task) === "ansible.builtin.command" && sensitive.test(argvText(task)),
    );
    // The identity run, the settings check, migrate.js, register.js, commands.js list and both
    // health inspects.
    expect(runs.length).toBe(7);
    for (const { task } of runs)
      expect({ task: task.name, no_log: task.no_log }).toEqual({ task: task.name, no_log: true });
    // The identity and the settings built from it hold Discord IDs.
    for (const { task } of await allTasks())
      if (/tb_identity\b|tb_env\b/u.test(Object.keys(argsOf(task)).join(" ")))
        if (moduleOf(task) === "ansible.builtin.set_fact")
          expect({ task: task.name, no_log: task.no_log }).toEqual({
            task: task.name,
            no_log: true,
          });
  });
});

describe("what bot.yml writes, and when", () => {
  test("tarubot.env, the unit and the image file only in the preflight and unit phases", async () => {
    const all = await allTasks();
    const writes = (suffix: string) =>
      all.filter(({ task }) => String(argsOf(task).dest ?? "").endsWith(suffix));
    expect(writes("/.config/tarubot/tarubot.env").map((found) => found.phase)).toEqual([
      "Preflight",
      "Unit",
    ]);
    expect(writes("/.config/tarubot/image").map((found) => found.phase)).toEqual([
      "Preflight",
      "Unit",
    ]);
    expect(writes("/.config/containers/systemd/tarubot.container").map((f) => f.phase)).toEqual([
      "Unit",
    ]);
    // The unit phase: the candidate, Quadlet's dry run and its check, then the three writes and
    // the reload, back to back.
    const unit = all.filter(({ phase, section }) => phase === "Unit" && section === "block");
    const index = (name: string) => unit.findIndex(({ task }) => task.name === name);
    const candidate = unit.find(({ task }) =>
      String(argsOf(task).dest ?? "").endsWith("/candidate/tarubot.container"),
    );
    expect(argsOf(candidate?.task ?? {}).src).toBe("templates/bot/tarubot.container.j2");
    const dryRun = unit.findIndex(
      ({ task }) =>
        argvText(task) === JSON.stringify(["/usr/libexec/podman/quadlet", "-dryrun", "-user"]),
    );
    expect(unit[dryRun]?.task.environment).toEqual({
      QUADLET_UNIT_DIRS: "{{ tb_home }}/.config/tarubot/candidate",
    });
    const check = index("Refuse a unit Quadlet can't turn into tarubot.service");
    expect(dryRun).toBeGreaterThan(unit.indexOf(candidate as Found));
    expect(check).toBeGreaterThan(dryRun);
    for (const suffix of [
      "/.config/tarubot/tarubot.env",
      "/.config/containers/systemd/tarubot.container",
      "/.config/tarubot/image",
    ]) {
      const at = unit.findIndex(({ task }) => String(argsOf(task).dest ?? "").endsWith(suffix));
      expect({ suffix, after: at > check }).toEqual({ suffix, after: true });
    }
    // The installed unit is the checked candidate itself.
    const installed = unit.find(({ task }) =>
      String(argsOf(task).dest ?? "").endsWith("/.config/containers/systemd/tarubot.container"),
    );
    expect(argsOf(installed?.task ?? {})).toMatchObject({
      src: "{{ tb_home }}/.config/tarubot/candidate/tarubot.container",
      remote_src: true,
      mode: "0644",
    });
  });

  test("nothing but image pulls, throwaway containers and one state read runs before the secrets phase", async () => {
    // Pulls, inspects, `image exists`, --rm containers with no network, and the Migrations phase's
    // read of the live unit's ActiveState: no write the host keeps.
    const before = (await allTasks()).filter(({ phase }) =>
      ["Checks", "Live", "Decide", "Image", "Migrations", "Identity", "Settings"].includes(
        phase ?? "",
      ),
    );
    const writers = [
      "ansible.builtin.copy",
      "ansible.builtin.template",
      "ansible.builtin.file",
      "ansible.builtin.systemd_service",
      "ansible.builtin.lineinfile",
    ];
    for (const { task } of before) {
      expect({ task: task.name, writer: writers.includes(moduleOf(task)) }).toEqual({
        task: task.name,
        writer: false,
      });
      if (moduleOf(task) === "ansible.builtin.command") {
        const argv = argsOf(task).argv as string[];
        const stateRead =
          JSON.stringify(argv) ===
          JSON.stringify([
            "systemctl",
            "--user",
            "show",
            "tarubot.service",
            "--property=ActiveState",
          ]);
        const allowed =
          stateRead ||
          (argv[0] === "podman" &&
            ((argv[1] === "image" && ["exists", "inspect"].includes(argv[2] ?? "")) ||
              argv[1] === "pull" ||
              (argv[1] === "run" && argv.includes("--rm") && argv.includes("--network=none"))));
        expect({ task: task.name, allowed }).toEqual({ task: task.name, allowed: true });
      }
    }
  });

  // A rollback across a migration (the review's finding on 2.37.0's lab run): refused while the
  // live bot runs, left to the older release's own migrate.js when it doesn't. The expression's
  // cases (running, a crash loop, stopped, unreadable) are in tests/fixtures/bot-asserts.json.
  test("the rollback check reads the live unit's state, read-only, before it refuses", async () => {
    const migrations = (await allTasks())
      .filter(({ phase, task }) => phase === "Migrations" && task.name !== "Migrations")
      .map(({ task }) => task);
    const names = migrations.map((task) => String(task.name));
    const read = migrations.find((task) => task.name === "Read whether the live bot runs");
    expect(argsOf(read ?? {}).argv).toEqual([
      "systemctl",
      "--user",
      "show",
      "tarubot.service",
      "--property=ActiveState",
    ]);
    expect({
      register: read?.register,
      changed: read?.changed_when,
      failed: read?.failed_when,
      when: read?.when,
    }).toEqual({
      register: "tb_live_state",
      changed: false,
      failed: false,
      when: "tb_live_ref != ''",
    });
    const refuse = names.indexOf("Refuse a rollback across a migration while the live bot runs");
    expect(names.indexOf("Read whether the live bot runs")).toBeGreaterThan(
      names.indexOf("Keep both lists"),
    );
    expect(refuse).toBeGreaterThan(names.indexOf("Read whether the live bot runs"));
    // One condition, reading only the lists and that registered state.
    const that = argsOf(migrations[refuse] ?? {}).that as string[];
    expect(that).toHaveLength(1);
    expect(that[0]).toContain(
      "tb_live_migrations | difference(tb_target_migrations) | length == 0",
    );
    expect(that[0]).toContain("^ActiveState=(inactive|failed|activating|deactivating)$");
  });

  test("the unit runs the one repository by the plan's digest", async () => {
    const vars = await botVars();
    const rendered = await renderStaging(`sha256:${"ab".repeat(32)}`, {
      applicationId: deployments.devbot.applicationId,
      registrationScope: deployments.devbot.registrationScope,
    });
    const unit = parseUnit(rendered.container, "tarubot.container");
    expect(single(unit, "Container", "Image")).toBe(
      `${vars.tb_image_repository}@sha256:${"ab".repeat(32)}`,
    );
    // tarubot-tool accepts only that repository too.
    const tool = await read(`${ANSIBLE}/files/bot/tarubot-tool`);
    expect(tool).toContain(
      `readonly IMAGE_PATTERN='^${String(vars.tb_image_repository).replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$'`,
    );
  });
});

describe("the vars against the code", () => {
  test("vars/bot.yml holds exactly the interface's keys", async () => {
    expect(Object.keys(await botVars())).toEqual([
      "tb_image_repository",
      "tb_inputs",
      "tb_actions",
      "tb_secret_env",
      "tb_secret_source",
      "tb_setting_env",
      "tb_setting_source",
      "tb_multiline_secrets",
      "tb_preflight_secrets",
      "tb_base_settings",
      "tb_health",
      "tb_prune_until",
      "tb_image_source",
      "tb_identity_script",
      "tb_settings_check",
    ]);
    const vars = await botVars();
    expect(vars.tb_inputs).toEqual([
      "tarubot_target",
      "tarubot_action",
      "tarubot_version",
      "tarubot_commit",
      "tarubot_digest",
      "tarubot_result",
    ]);
    expect(vars.tb_actions).toEqual(["deploy", "bot", "preflight"]);
    expect(vars.tb_base_settings).toEqual({ HEALTH_PORT: "3000", ENABLE_EFFECTS: "true" });
    expect(vars.tb_health).toEqual({ retries: 36, delay: 5, settle: 60 });
    expect(vars.tb_prune_until).toBe("168h");
    // The source label publish.yml sets on every release, of the one repository the bot runs.
    expect(vars.tb_image_source).toBe(
      `https://github.com/${String(vars.tb_image_repository).replace(/^ghcr\.io\//u, "")}`,
    );
    expect(await read(".github/workflows/publish.yml")).toContain(
      `org.opencontainers.image.source=https://github.com/\${{ github.repository }}`,
    );
  });

  test("the tidy step prunes only TaruBot's release images, so the backup's PostgreSQL image stays", async () => {
    const tidy = (await allTasks()).filter(({ phase }) => phase === "Tidy");
    const prune = tidy.find(({ task }) => argvText(task).includes('"prune"'));
    expect(argsOf(prune?.task ?? {}).argv).toEqual([
      "podman",
      "image",
      "prune",
      "--all",
      "--force",
      "--filter",
      "until={{ tb_prune_until }}",
      "--filter",
      "label=org.opencontainers.image.source={{ tb_image_source }}",
    ]);
  });

  test("a preflight enables the nightly backup after its one backup, as a healthy deploy does", async () => {
    const preflight = (await allTasks()).filter(
      ({ phase, section }) => phase === "Preflight" && section === "block",
    );
    const names = preflight.map(({ task }) => task.name);
    const timer = preflight.find(({ task }) => argsOf(task).name === "tarubot-backup.timer");
    expect(argsOf(timer?.task ?? {})).toEqual({
      name: "tarubot-backup.timer",
      enabled: true,
      state: "started",
      scope: "user",
    });
    expect(names.indexOf(timer?.task.name as string)).toBeGreaterThan(
      names.indexOf("Run one backup"),
    );
    expect(names.indexOf(timer?.task.name as string)).toBeLessThan(
      names.indexOf("End as preflight-ok"),
    );
  });

  test("tb_secret_env is src/config/secrets.ts's six plus the backup's five", async () => {
    const vars = await botVars();
    expect(names(vars.tb_secret_env, "tb_secret_env")).toEqual(
      [...FILE_SETTINGS, ...BACKUP_SETTINGS].sort(),
    );
    // GitHub refuses a secret name that starts with GITHUB_, so these two come from environment
    // secrets of other names (host.yml's Bot step maps them back; deploy-workflow.test.ts).
    expect(vars.tb_secret_source).toEqual({
      GITHUB_APP_PRIVATE_KEY: "SUGGEST_APP_PRIVATE_KEY",
      GITHUB_REPORTS_TOKEN: "REPORTS_GITHUB_TOKEN",
    });
    // /suggest's client ID (2.37.0): a plain setting, not a secret, from an environment secret of
    // another name for the same reason.
    expect(vars.tb_setting_env).toEqual(["GITHUB_APP_CLIENT_ID"]);
    expect(vars.tb_setting_source).toEqual({ GITHUB_APP_CLIENT_ID: "SUGGEST_APP_CLIENT_ID" });
    expect(FILE_SETTINGS as readonly string[]).not.toContain("GITHUB_APP_CLIENT_ID");
    expect(names(vars.tb_multiline_secrets, "tb_multiline_secrets")).toEqual([
      "DATABASE_CA_CERT",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    expect(names(vars.tb_preflight_secrets, "tb_preflight_secrets")).toEqual([
      "DATABASE_CA_CERT",
      "DATABASE_URL",
    ]);
  });

  test("staging declares five of FILE_SETTINGS (no GitHub App key), the backup's five and its database", async () => {
    const staging = await stagingVars();
    expect(Object.keys(staging)).toEqual([
      "tarubot_secrets",
      "tarubot_backup_settings",
      "tarubot_database",
      "tarubot_settings",
    ]);
    const secrets = names(staging.tarubot_secrets, "tarubot_secrets");
    expect(secrets.every((name) => (FILE_SETTINGS as readonly string[]).includes(name))).toBe(true);
    expect(secrets).toEqual(FILE_SETTINGS.filter((name) => name !== "GITHUB_APP_PRIVATE_KEY"));
    expect(names(staging.tarubot_backup_settings, "backup")).toEqual(BACKUP_SETTINGS);
    expect(staging.tarubot_database).toEqual({
      user: STAGING_DATABASE,
      names: [STAGING_DATABASE],
    });
    // The marker, public test replies, and /suggest off. No Discord ID: the image reports those.
    expect(staging.tarubot_settings).toEqual({
      TARUBOT_ENVIRONMENT: "staging",
      PUBLIC_TEST_RESPONSES: "true",
      GITHUB_APP_CLIENT_ID: "",
    });
  });

  test("the identity script, run by Bun against src/config/deployment.ts, reports staging's identity", async () => {
    const script = String((await botVars()).tb_identity_script);
    // The image's compiled copy, which the build writes to dist/src (tsconfig.build.json).
    const imagePath = "/app/dist/src/config/deployment.js";
    expect(script.split(imagePath)).toHaveLength(2);
    const local = script.replace(imagePath, root("src/config/deployment.ts"));
    const run = Bun.spawnSync([process.execPath, "-e", local], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TARUBOT_ENVIRONMENT: "staging" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ code: run.exitCode, err: run.stderr.toString() }).toEqual({ code: 0, err: "" });
    const staging = resolveDeployment({ TARUBOT_ENVIRONMENT: "staging" });
    expect(JSON.parse(run.stdout.toString())).toEqual({
      applicationId: staging.applicationId,
      registrationScope: staging.registrationScope,
    });
    expect(staging.applicationId).toBe(deployments.devbot.applicationId);
    // No Jinja delimiter in it: Ansible passes it on as it is.
    expect(script).not.toMatch(/\{\{|\{%|\{#/u);
  });

  test("the rendered staging settings pass configuration() and the tool guard for migrate and register", async () => {
    const staging = resolveDeployment({ TARUBOT_ENVIRONMENT: "staging" });
    const rendered = await renderStaging(`sha256:${"cd".repeat(32)}`, {
      applicationId: staging.applicationId ?? "",
      registrationScope: staging.registrationScope,
    });
    // Each NAME_FILE path is the unit's mount; here it names a scratch file with a fake value and
    // the one newline Podman's copy gains.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bot-play-env-")));
    try {
      const url = `postgresql://${STAGING_DATABASE}:fake@db.example.org:27520/${STAGING_DATABASE}`;
      const fake: Record<string, string> = {
        DATABASE_URL: url,
        DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
        DISCORD_TOKEN: "fake.token.value",
        GITHUB_REPORTS_TOKEN: "github_pat_fake",
        HEALTHCHECKS_PING_URL: "https://hc-ping.example.org/fake",
      };
      const env: Record<string, string> = {};
      for (const entry of parseEnvFile(rendered.env, "tarubot.env")) {
        if (entry.value === null) throw new Error(`${entry.name} has no value`);
        const secret = /^([A-Z_]+)_FILE$/u.exec(entry.name)?.[1];
        if (secret === undefined) {
          env[entry.name] = entry.value;
          continue;
        }
        expect(entry.value).toBe(`/run/secrets/${secret.toLowerCase()}`);
        const path = join(scratch, secret.toLowerCase());
        writeFileSync(path, `${fake[secret]}\n`);
        env[entry.name] = path;
      }
      const config = configuration(env);
      expect({
        application: config.DISCORD_APPLICATION_ID,
        guild: config.TEST_GUILD_ID,
        publicReplies: config.PUBLIC_TEST_RESPONSES,
        effects: config.ENABLE_EFFECTS,
        port: config.HEALTH_PORT,
        app: config.GITHUB_APP_CLIENT_ID,
        key: config.GITHUB_APP_PRIVATE_KEY,
        url: config.DATABASE_URL,
      }).toEqual({
        application: deployments.devbot.applicationId,
        guild: deployments.devbot.guilds[0],
        publicReplies: true,
        effects: true,
        port: 3000,
        app: "",
        key: "",
        url,
      });
      // Inside the container: no env file in /app, and the secrets as files.
      const container: Launch = { execArgv: [], envFiles: [] };
      expect(
        assertToolScope(env, migrateToolScope({ restoreRehearsal: false }), container).name,
      ).toBe("staging");
      expect(
        assertToolScope(
          env,
          registerToolScope({ kind: "guild", guild: staging.registrationScope }),
          container,
        ).name,
      ).toBe("staging");
      expect(resolveDeployment(env).name).toBe("staging");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("prod declares five of FILE_SETTINGS, /suggest, the backup's five and its database (2.37.0)", async () => {
    const prod = await prodVars();
    expect(Object.keys(prod)).toEqual([
      "tarubot_secrets",
      "tarubot_suggest",
      "tarubot_backup_settings",
      "tarubot_database",
      "tarubot_settings",
    ]);
    // The GitHub App's key isn't listed: bot.yml adds it once /suggest has a client ID.
    expect(names(prod.tarubot_secrets, "tarubot_secrets")).toEqual(
      FILE_SETTINGS.filter((name) => name !== "GITHUB_APP_PRIVATE_KEY"),
    );
    expect(prod.tarubot_suggest).toBe(true);
    expect(names(prod.tarubot_backup_settings, "backup")).toEqual(BACKUP_SETTINGS);
    // The prod guard profile's own names: the database the owner renames at the cutover.
    expect(prod.tarubot_database).toEqual({ user: PROD_ROLE, names: [...PROD_DATABASES] });
    // No client ID here (bot.yml writes it from the environment), and no test scoping.
    expect(prod.tarubot_settings).toEqual({
      TARUBOT_ENVIRONMENT: "prod",
      PUBLIC_TEST_RESPONSES: "false",
    });
  });

  test("the identity script reports prod's identity: the production application, globally", async () => {
    const script = String((await botVars()).tb_identity_script).replace(
      "/app/dist/src/config/deployment.js",
      root("src/config/deployment.ts"),
    );
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TARUBOT_ENVIRONMENT: "prod" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ code: run.exitCode, err: run.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(run.stdout.toString())).toEqual({
      applicationId: deployments.production.applicationId,
      registrationScope: "global",
    });
  });

  for (const clientId of ["Iv23liInvented", ""])
    test(`the rendered prod settings pass configuration() and the tool guard (client ID ${clientId ? "set" : "empty"})`, async () => {
      const prod = resolveDeployment({ TARUBOT_ENVIRONMENT: "prod" });
      const rendered = await renderTarget(
        "prod",
        `sha256:${"cd".repeat(32)}`,
        { applicationId: prod.applicationId ?? "", registrationScope: prod.registrationScope },
        clientId,
      );
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bot-play-prod-")));
      try {
        const url = `postgresql://${PROD_ROLE}:fake@db.example.org:27520/${PROD_DATABASES[0]}`;
        const key = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----";
        const fake: Record<string, string> = {
          DATABASE_URL: url,
          DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
          DISCORD_TOKEN: "fake.token.value",
          GITHUB_REPORTS_TOKEN: "github_pat_fake",
          HEALTHCHECKS_PING_URL: "https://hc-ping.example.org/fake",
          GITHUB_APP_PRIVATE_KEY: key,
        };
        const env: Record<string, string> = {};
        for (const entry of parseEnvFile(rendered.env, "tarubot.env")) {
          if (entry.value === null) throw new Error(`${entry.name} has no value`);
          const secret = /^([A-Z_]+)_FILE$/u.exec(entry.name)?.[1];
          if (secret === undefined) {
            env[entry.name] = entry.value;
            continue;
          }
          const path = join(scratch, secret.toLowerCase());
          writeFileSync(path, `${fake[secret]}\n`);
          env[entry.name] = path;
        }
        const config = configuration(env);
        expect({
          application: config.DISCORD_APPLICATION_ID,
          guild: config.TEST_GUILD_ID,
          publicReplies: config.PUBLIC_TEST_RESPONSES,
          app: config.GITHUB_APP_CLIENT_ID,
          key: config.GITHUB_APP_PRIVATE_KEY,
          url: config.DATABASE_URL,
        }).toEqual({
          application: deployments.production.applicationId,
          guild: "",
          publicReplies: false,
          // /suggest is on only with both: the client ID and, then, the key's mount.
          app: clientId,
          key: clientId ? key : "",
          url,
        });
        const container: Launch = { execArgv: [], envFiles: [] };
        expect(
          assertToolScope(env, migrateToolScope({ restoreRehearsal: false }), container).name,
        ).toBe("prod");
        expect(assertToolScope(env, registerToolScope({ kind: "global" }), container).name).toBe(
          "prod",
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
});

/** A task found by its exact name, which must be unique in bot.yml. */
async function named(name: string): Promise<Found> {
  const found = (await allTasks()).filter(({ task }) => task.name === name);
  if (found.length !== 1) throw new Error(`${found.length} tasks named ${name}`);
  return found[0] as Found;
}
/** A phase's own tasks (its block), in file order, by name. */
async function phaseTasks(phase: string): Promise<string[]> {
  return (await allTasks())
    .filter(
      (found) => found.phase === phase && found.section === "block" && found.task.name !== phase,
    )
    .map(({ task }) => String(task.name));
}
/** Every task's name, in file order. */
const taskOrder = async () => (await allTasks()).map(({ task }) => String(task.name));

describe("the in-image settings check (2.37.0, from Codex's ce3ded7)", () => {
  test("its own phase runs after the identity and before the secrets, the first write", async () => {
    expect(PHASES.slice(PHASES.indexOf("Identity"), PHASES.indexOf("Secrets") + 1)).toEqual([
      "Identity",
      "Settings",
      "Secrets",
    ]);
    expect(await phaseTasks("Settings")).toEqual([
      "Start the settings step",
      SETTINGS_CHECK,
      SETTINGS_REFUSAL,
    ]);
    const order = await taskOrder();
    // After the settings are assembled and the token checked, before the first Podman secret.
    for (const earlier of [
      "Assemble the container's settings and mounts",
      "Refuse a Discord token of another application",
    ])
      expect(order.indexOf(earlier)).toBeLessThan(order.indexOf(SETTINGS_CHECK));
    expect(order.indexOf(SETTINGS_REFUSAL)).toBeLessThan(
      order.indexOf("Store each required value in its Podman secret"),
    );
    // Every writer and every stop comes after the refusal.
    const all = await allTasks();
    const refusal = all.findIndex(({ task }) => task.name === SETTINGS_REFUSAL);
    all.forEach(({ task }, index) => {
      const writer = [
        "ansible.builtin.copy",
        "ansible.builtin.template",
        "ansible.builtin.file",
        "ansible.builtin.systemd_service",
      ].includes(moduleOf(task));
      if (writer)
        expect({ task: task.name, after: index > refusal }).toEqual({
          task: task.name,
          after: true,
        });
    });
  });

  test("a throwaway container of the release image, with no network, no log and no privileges", async () => {
    const { task } = await named(SETTINGS_CHECK);
    expect(moduleOf(task)).toBe("ansible.builtin.command");
    expect(argsOf(task).argv).toEqual([
      "podman",
      "run",
      "--rm",
      "-i",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--env-host=false",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--log-driver=none",
      "--entrypoint",
      "bun",
      "{{ tb_image_id }}",
      "{{ tb_settings_check }}",
    ]);
    expect({
      register: task.register,
      changed: task.changed_when,
      failed: task.failed_when,
      noLog: task.no_log,
    }).toEqual({ register: "tb_check", changed: false, failed: false, noLog: true });
    // Exactly what the container gets: tarubot.env's plain lines (tb_env) and the values of the
    // secrets it mounts (tb_container_secrets, whose NAME_FILE lines are tb_files).
    expect(String(argsOf(task).stdin)).toBe(
      "{{ {'action': tarubot_action,\n    'env': (tb_env | items2dict(key_name='name', value_name='value'))\n           | combine(dict(tb_container_secrets | zip(query('ansible.builtin.env', *tb_container_secrets))))}\n   | to_json }}",
    );
    const assemble = argsOf((await named("Assemble the container's settings and mounts")).task);
    for (const key of ["tb_files", "tb_mounts"])
      expect({
        key,
        from: String(assemble[key]).match(/tarubot_secrets|tb_preflight_secrets/u),
      }).toEqual({
        key,
        from: null,
      });
    // The script is this repository's scripts/deploy-check.ts, which the build compiles into
    // dist/scripts (tsconfig.build.json takes scripts/**).
    expect((await botVars()).tb_settings_check).toBe("dist/scripts/deploy-check.js");
    expect(await Bun.file(root("scripts/deploy-check.ts")).exists()).toBe(true);
    expect(JSON.parse(await read("tsconfig.build.json")).include).toContain("scripts/**/*.ts");
  });

  test('the refusal passes only on exactly {"ok":true}, and names only a fixed word', async () => {
    const { task } = await named(SETTINGS_REFUSAL);
    expect(argsOf(task).that).toEqual([
      "tb_check.rc == 0",
      `tb_check.stdout is match('^[{]"ok":true[}]$')`,
    ]);
    const message = String(argsOf(task).fail_msg);
    // The one piece of the check's output that can reach the log: one of its three labels.
    expect(message).toContain("regex_search('(configuration|migrate|register)(?=\"[}]$)')");
    expect(message.replace(/tb_check\.stdout \| default\(''\) \| regex_search/u, "")).not.toContain(
      "tb_check.stdout",
    );
    expect(task.vars).toEqual({ tb_outcome: "refused", tb_reason: "settings-invalid" });
  });
});

describe("/suggest on prod (2.37.0, from Codex's ce3ded7)", () => {
  const CLIENT = "Check /suggest's client ID, and keep it only when well formed";

  test("the client ID is read only on a target with /suggest, for deploy and bot, into a boolean and a checked value", async () => {
    const { task } = await named(CLIENT);
    expect(task.when).toEqual([
      "tarubot_suggest | default(false)",
      "tarubot_action != 'preflight'",
    ]);
    expect(task.no_log).toBe(true);
    expect(Object.keys(argsOf(task))).toEqual(["tb_client_ok", "tb_client_id"]);
    for (const key of ["tb_client_ok", "tb_client_id"]) {
      const expression = String(argsOf(task)[key]);
      expect(expression).toContain("is match('^[A-Za-z0-9._-]{1,64}$')");
      // No surrounding whitespace, which `$` alone would let through as a trailing newline.
      expect(expression).toMatch(
        /lookup\('ansible\.builtin\.env', 'GITHUB_APP_CLIENT_ID'\)\.split\(\)\s+== \[lookup\('ansible\.builtin\.env', 'GITHUB_APP_CLIENT_ID'\)\]/u,
      );
    }
    // Their defaults, before the read: /suggest off.
    const start = argsOf((await named("Start the lists of missing and malformed settings")).task);
    expect({ ok: start.tb_client_ok, id: start.tb_client_id }).toEqual({ ok: true, id: "" });
  });

  test("the key is required and mounted only once there is a client ID", async () => {
    const mounts = argsOf((await named("Work out which secrets the container mounts")).task);
    expect(String(mounts.tb_container_secrets)).toBe(
      "{{ tb_preflight_secrets if tarubot_action == 'preflight'\n   else tarubot_secrets + (['GITHUB_APP_PRIVATE_KEY'] if tb_client_id != '' else []) }}",
    );
    const needs = argsOf((await named("Work out which secrets this action needs")).task);
    expect(needs.tb_required).toBe("{{ tb_container_secrets + tarubot_backup_settings }}");
    const order = await taskOrder();
    const at = (name: string) => order.indexOf(name);
    expect(at(CLIENT)).toBeLessThan(at("Work out which secrets the container mounts"));
    expect(at("Work out which secrets the container mounts")).toBeLessThan(
      at("Work out which secrets this action needs"),
    );
    expect(at("Work out which secrets this action needs")).toBeLessThan(
      at("List the required settings that are empty (names only)"),
    );
    // A malformed client ID is refused, naming the environment's secret, after the missing list
    // (which then names SUGGEST_APP_PRIVATE_KEY for a client ID without its key).
    expect(at("Refuse missing secrets")).toBeLessThan(
      at("Refuse a /suggest client ID that isn't one"),
    );
    const refusal = argsOf((await named("Refuse a /suggest client ID that isn't one")).task);
    expect(refusal.that).toEqual(["tb_client_ok"]);
    expect(String(refusal.fail_msg)).toContain("{{ tb_secret_names.GITHUB_APP_CLIENT_ID }}");
  });

  test("the rendered prod unit mounts the app's key and sets the client ID only with a client ID", async () => {
    const identity = { applicationId: "APPLICATION_ID", registrationScope: "global" };
    const digest = `sha256:${"ab".repeat(32)}`;
    const mount =
      "tarubot-github-app-private-key,type=mount,target=/run/secrets/github_app_private_key,uid=1000,gid=1000,mode=0400";
    const settings = (text: string) =>
      new Map(parseEnvFile(text, "tarubot.env").map((entry) => [entry.name, entry.value]));

    const on = await renderTarget("prod", digest, identity, "Iv23liInvented");
    expect(valuesOf(parseUnit(on.container, "tarubot.container"), "Container", "Secret")).toContain(
      mount,
    );
    expect(settings(on.env).get("GITHUB_APP_CLIENT_ID")).toBe("Iv23liInvented");
    expect(settings(on.env).get("GITHUB_APP_PRIVATE_KEY_FILE")).toBe(
      "/run/secrets/github_app_private_key",
    );

    const off = await renderTarget("prod", digest, identity, "");
    expect(
      valuesOf(parseUnit(off.container, "tarubot.container"), "Container", "Secret"),
    ).not.toContain(mount);
    expect(settings(off.env).get("GITHUB_APP_CLIENT_ID")).toBe("");
    expect(settings(off.env).has("GITHUB_APP_PRIVATE_KEY_FILE")).toBe(false);
    // Global registration: no test guild.
    expect(settings(off.env).get("TEST_GUILD_ID")).toBe("");

    // Staging has no /suggest: its client ID is never read, and its key never mounted.
    const staging = await renderTarget("staging", digest, identity, "Iv23liInvented");
    expect(
      valuesOf(parseUnit(staging.container, "tarubot.container"), "Container", "Secret"),
    ).not.toContain(mount);
    expect(settings(staging.env).get("GITHUB_APP_CLIENT_ID")).toBe("");
  });

  test("CI renders staging, prod with a client ID and prod without one", () => {
    expect(
      RENDERS.map(({ directory, target, clientId }) => [directory, target, clientId !== ""]),
    ).toEqual([
      ["staging", "staging", false],
      ["prod", "prod", true],
      ["prod-no-client", "prod", false],
    ]);
  });
});

describe("the backup's URLs on HTTPS (2.37.0, from Codex's ce3ded7)", () => {
  test("a boolean each, read in the checks and refused as malformed-secret after the whitespace", async () => {
    const { task, phase } = await named("Check that the backup's URLs use HTTPS (booleans only)");
    expect(phase).toBe("Checks");
    expect(task.no_log).toBe(true);
    expect(argsOf(task)).toEqual({
      tb_backup_url_ok:
        "{{ lookup('ansible.builtin.env', 'HEALTHCHECKS_BACKUP_URL') is match('^https://[^/?#]') }}",
      tb_backup_endpoint_ok:
        "{{ lookup('ansible.builtin.env', 'BACKUP_STORAGE_ENDPOINT') is match('^https://[^/?#]')\n   or '://' not in lookup('ansible.builtin.env', 'BACKUP_STORAGE_ENDPOINT') }}",
    });
    const order = await taskOrder();
    const refusal = "Refuse backup URLs that don't use HTTPS";
    expect(order.indexOf("Refuse secrets with stray whitespace")).toBeLessThan(
      order.indexOf(refusal),
    );
    expect(order.indexOf(refusal)).toBeLessThan(order.indexOf("Refuse another target's database"));
    expect(argsOf((await named(refusal)).task).that).toEqual([
      "tb_backup_url_ok",
      "tb_backup_endpoint_ok",
    ]);
    // The same rule tarubot-backup applies to the endpoint at 04:30.
    const backup = await read(`${ANSIBLE}/files/bot/tarubot-backup`);
    expect(backup).toContain("  https://*) ;;\n  *://*)");
  });
});

describe("the recovery point (2.37.0, from Codex's ce3ded7)", () => {
  test("restart, then read, keep and write the restore point, and only then check the restart", async () => {
    expect(await phaseTasks("Restart")).toEqual([
      "Start the restart step",
      "Read the time before the restart",
      "Restart the bot",
      "Read the unit's state after the restart",
      "Take the InactiveEnterTimestamp it shows",
      "Keep the restore point",
      "Write the restore point where the host keeps it",
      "Require the restart to have succeeded",
    ]);
    // The restart's failure is registered, not raised: failed_when: false would erase it (the
    // systemd module returns no rc), so the assert couldn't see it.
    const restart = (await named("Restart the bot")).task;
    expect(argsOf(restart)).toEqual({ name: "tarubot.service", state: "restarted", scope: "user" });
    expect({
      register: restart.register,
      ignore: restart.ignore_errors,
      failedWhen: restart.failed_when,
      vars: restart.vars,
    }).toEqual({ register: "tb_restart", ignore: true, failedWhen: undefined, vars: undefined });
    const check = (await named("Require the restart to have succeeded")).task;
    expect(argsOf(check).that).toEqual(["tb_restart is not failed"]);
    expect(check.vars).toEqual({ tb_reason: "restart-failed" });
    // The file, private to tarubot, holding the restore point the result carries too.
    expect(argsOf((await named("Write the restore point where the host keeps it")).task)).toEqual({
      content: "{{ tb_restore_point }}\n",
      dest: "{{ tb_home }}/.config/tarubot/recovery-point",
      mode: "0600",
    });
    const all = await allTasks();
    expect(
      all
        .filter(({ task }) => String(argsOf(task).dest ?? "").endsWith("/recovery-point"))
        .map(({ phase }) => phase),
    ).toEqual(["Restart"]);
    // Reading the state can't fail the run before the file is written.
    expect((await named("Read the unit's state after the restart")).task.failed_when).toBe(false);
    // The result reads the same fact.
    const result = mappings((await plays())[2]?.tasks, "play 2").find(
      (task) => moduleOf(task) === "ansible.builtin.set_fact",
    );
    expect(String(mapping(argsOf(result ?? {}).tb_final, "tb_final").restore_point)).toContain(
      "tb_target.tb_restore_point",
    );
  });

  test("the old instance's stop only when systemd still holds it, else the time before the restart", async () => {
    const before = (await named("Read the time before the restart")).task;
    expect(argsOf(before).argv).toEqual(["date", "-u", "+%Y-%m-%dT%H:%M:%S.%6NZ"]);
    const state = (await named("Read the unit's state after the restart")).task;
    expect(argsOf(state).argv).toEqual([
      "systemctl",
      "--user",
      "show",
      "tarubot.service",
      "--property=ActiveState",
      "--property=NRestarts",
      "--property=InactiveEnterTimestamp",
      "--timestamp=us+utc",
    ]);
    const keep = String(argsOf((await named("Keep the restore point")).task).tb_restore_point);
    for (const condition of [
      "tb_restart is not failed",
      "'ActiveState=active' in (tb_after.stdout_lines | default([]))",
      "'NRestarts=0' in (tb_after.stdout_lines | default([]))",
      "tb_stopped >= tb_before.stdout",
    ])
      expect(keep).toContain(condition);
    expect(keep).toEndWith("else tb_before.stdout }}");
  });
});

describe("the health wait stays checked (the review's B2)", () => {
  test("the wait never fails, and the asserts after it do: healthy, then the same container on the release's image", async () => {
    expect(await phaseTasks("Health")).toEqual([
      "Start the health step",
      "Wait for the bot to turn healthy",
      "Require healthy",
      "Let it run a while",
      "Check the bot again",
      "Require the same container, still healthy",
      "Require the release's own image",
    ]);
    const wait = (await named("Wait for the bot to turn healthy")).task;
    expect({ register: wait.register, failed: wait.failed_when }).toEqual({
      register: "tb_health_first",
      failed: false,
    });
    // The assert reads the wait's own result, which nothing else could stand in for.
    const [healthy] = argsOf((await named("Require healthy")).task).that as string[];
    expect(healthy).toContain("tb_health_first.rc == 0");
    expect(healthy).toContain("== 'healthy'");
    expect(argsOf((await named("Let it run a while")).task)).toEqual({
      seconds: "{{ tb_health.settle }}",
    });
    const [same] = argsOf((await named("Require the same container, still healthy")).task)
      .that as string[];
    expect(same).toContain(
      "(tb_health_again.stdout | from_json)[0].Id == (tb_health_first.stdout | from_json)[0].Id",
    );
    expect(argsOf((await named("Require the release's own image")).task).that).toEqual([
      "(tb_health_again.stdout | from_json)[0].Image == tb_image_id",
    ]);
    // Commands register only after the health phase.
    expect(PHASES.indexOf("Health")).toBeLessThan(PHASES.indexOf("Commands"));
  });
});

describe("the templar cases (tests/fixtures/bot-asserts.json)", () => {
  interface Case {
    name: string;
    task: string;
    field: string;
    vars?: Mapping;
    env?: Record<string, string>;
    expect?: unknown;
    contains?: string[];
    excludes?: string[];
    json?: boolean;
  }
  const cases = async (): Promise<Case[]> =>
    JSON.parse(await read("tests/fixtures/bot-asserts.json")).cases as Case[];
  const CONDITIONALS = ["when", "failed_when", "until", "changed_when"];

  test("every case names one task in bot.yml, and a field that task has", async () => {
    const all = await allTasks();
    const seen = new Set<string>();
    for (const item of await cases()) {
      expect({ name: item.name, repeated: seen.has(item.name) }).toEqual({
        name: item.name,
        repeated: false,
      });
      seen.add(item.name);
      const found = all.filter(({ task }) => task.name === item.task);
      expect({ name: item.name, tasks: found.length }).toEqual({ name: item.name, tasks: 1 });
      const task = found[0]?.task ?? {};
      const module = moduleOf(task);
      const has = CONDITIONALS.includes(item.field)
        ? task[item.field] !== undefined
        : item.field === "that" || item.field === "fail_msg"
          ? module === "ansible.builtin.assert" && argsOf(task)[item.field] !== undefined
          : item.field === "stdin"
            ? module === "ansible.builtin.command" && argsOf(task).stdin !== undefined
            : module === "ansible.builtin.set_fact" && argsOf(task)[item.field] !== undefined;
      expect({ name: item.name, field: item.field, has }).toEqual({
        name: item.name,
        field: item.field,
        has: true,
      });
      // Each case expects something.
      expect({
        name: item.name,
        expects: "expect" in item || (item.contains ?? []).length > 0,
      }).toEqual({ name: item.name, expects: true });
    }
  });

  test("they cover the refusals the review named, each both ways", async () => {
    const outcomes = new Map<string, Set<string>>();
    for (const item of await cases()) {
      const key = `${item.task} / ${item.field}`;
      const set = outcomes.get(key) ?? new Set<string>();
      set.add(JSON.stringify(item.expect ?? "text"));
      outcomes.set(key, set);
    }
    const both = (task: string, field: string) =>
      expect({
        task,
        field,
        outcomes: [...(outcomes.get(`${task} / ${field}`) ?? [])].sort(),
      }).toEqual({
        task,
        field,
        outcomes: ["false", "true"],
      });
    both("Check /suggest's client ID, and keep it only when well formed", "tb_client_ok");
    both("Check /suggest's client ID, and keep it only when well formed", "when");
    both("Check that the backup's URLs use HTTPS (booleans only)", "tb_backup_url_ok");
    both("Check that the backup's URLs use HTTPS (booleans only)", "tb_backup_endpoint_ok");
    both("Refuse backup URLs that don't use HTTPS", "that");
    both(SETTINGS_REFUSAL, "that");
    both("Require the restart to have succeeded", "that");
    both("Refuse a rollback across a migration while the live bot runs", "that");
    both("Require healthy", "that");
    both("Require the same container, still healthy", "that");
    // The settings check's result: ok, a refusing check, garbage and a failing status.
    const stdouts = (await cases())
      .filter((item) => item.task === SETTINGS_REFUSAL && item.field === "that")
      .map((item) => {
        const check = mapping(item.vars?.tb_check, item.name);
        return [check.rc === 0, String(check.stdout).startsWith("{"), item.expect];
      });
    expect(stdouts).toContainEqual([true, true, true]);
    expect(stdouts).toContainEqual([false, true, false]);
    expect(stdouts).toContainEqual([true, false, false]);
    // The recovery point after a failed start is the time before the restart.
    expect(
      (await cases()).some(
        (item) =>
          item.task === "Keep the restore point" &&
          mapping(item.vars?.tb_restart, item.name).failed === true &&
          item.expect === mapping(item.vars?.tb_before, item.name).stdout,
      ),
    ).toBe(true);
  });

  test("their values are invented: no Discord ID, and hosts only under example.org", async () => {
    const text = await read("tests/fixtures/bot-asserts.json");
    expect(text.match(/(?<![0-9])[1-9][0-9]{16,19}(?![0-9])/gu) ?? []).toEqual([]);
    // Every URL's host, after any user and password, in the decoded values.
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? Object.values(value).flatMap(strings)
          : [];
    const hosts = strings(JSON.parse(text))
      .flatMap((value) => [...value.matchAll(/:\/\/(?:[^@/\s]*@)?([a-z0-9.-]*)/giu)])
      .map((match) => match[1] ?? "")
      // example.org itself or a name under it; a bare suffix match would let "evilexample.org" by.
      .filter((host) => host !== "" && host !== "example.org" && !host.endsWith(".example.org"));
    expect(hosts).toEqual([]);
  });

  test("the script loads bot.yml as ansible-playbook does, and prints only names on a failure", async () => {
    const script = await read("tests/fixtures/bot-asserts.py");
    expect(script).toContain(
      'loader.load_from_file(str(ANSIBLE_DIR / "bot.yml"), trusted_as_template=True)',
    );
    expect(script).toContain("init_plugin_loader([])");
    expect(script).toContain('Templar(loader=loader, variables={**base, **case.get("vars", {})})');
    const prints = [...script.matchAll(/print\((.*)\)$/gmu)].map((match) => match[1] ?? "");
    // The failure lines, and the got: line only under BOT_ASSERTS_DEBUG=1.
    expect(prints).toContain(`f"FAIL {case['name']} ({case['task']})"`);
    expect(prints.filter((line) => line.includes("result"))).toEqual([`f"  got: {result!r}"`]);
    expect(script).toMatch(/if debug:\n\s+print\(f" {2}got: \{result!r\}"\)/u);
  });
});

describe("the bot's files", () => {
  test("the test renderer imports nothing from node_modules, so CI's Playbook job runs it bare", async () => {
    // CI renders the templates with it and with Ansible, without `bun install` (interfaces §8).
    for (const file of ["tests/fixtures/bot-render.ts", "tests/fixtures/quadlet.ts"]) {
      const sources = [...(await read(file)).matchAll(/^import .* from "([^"]+)";$/gmu)].map(
        (match) => match[1] ?? "",
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources)
        expect({ file, source, bare: /^(bun|node:.+|\.\/[a-z-]+\.js)$/u.test(source) }).toEqual({
          file,
          source,
          bare: true,
        });
    }
  });

  test("ops/ansible holds exactly the bot's files beside the host's", () => {
    expect(BOT_FILES.sort()).toEqual([
      "bot.yml",
      "files/bot/tarubot-backup",
      "files/bot/tarubot-backup.service",
      "files/bot/tarubot-backup.timer",
      "files/bot/tarubot-tool",
      "templates/bot/tarubot.container.j2",
      "templates/bot/tarubot.env.j2",
      "vars/bot.yml",
      "vars/targets/prod.yml",
      "vars/targets/staging.yml",
    ]);
  });

  test("no Discord ID, host or address in any of them", async () => {
    // Snowflakes are 17 to 20 digits; the repository's hosts may be GitHub and the registries.
    const allowed = new Set(["ghcr.io", "github.com", "docker.io"]);
    for (const file of BOT_FILES) {
      const text = await read(`${ANSIBLE}/${file}`);
      expect({ file, ids: text.match(/(?<![0-9])[1-9][0-9]{16,19}(?![0-9])/gu) ?? [] }).toEqual({
        file,
        ids: [],
      });
      const hosts = [
        ...text.matchAll(
          /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9]))/gimu,
        ),
      ]
        .map((match) => (match[1] ?? "").toLowerCase())
        .filter((host) => !allowed.has(host));
      expect({ file, hosts }).toEqual({ file, hosts: [] });
      expect({ file, ipv4: /\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(text) }).toEqual({
        file,
        ipv4: false,
      });
      const ipv6 = /[0-9a-f]*::[0-9a-f]|(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{1,4}/iu;
      expect({ file, ipv6: ipv6.test(text) }).toEqual({
        file,
        ipv6: false,
      });
    }
  });
});

/**
 * tarubot-tool against the podman stand-in (tests/fixtures/backup-stubs/podman), in a sandbox home
 * holding the rendered staging settings and an image file.
 */
describe("tarubot-tool", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bot-play-tool-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const STUBS = root("tests/fixtures/backup-stubs");
  const TOOL = root(`${ANSIBLE}/files/bot/tarubot-tool`);
  const IMAGE = `ghcr.io/deconfined/tarubot@sha256:${"ef".repeat(32)}`;
  let count = 0;

  /** A fresh sandbox; `setup` may change the home before the run. */
  async function run(
    args: string[],
    options: {
      env?: Record<string, string | undefined>;
      setup?: (home: string) => void;
      exit?: number;
    } = {},
  ) {
    const base = join(scratch, `run-${count++}`);
    const home = join(base, "home");
    const sim = join(base, "sim");
    mkdirSync(join(home, ".config/tarubot"), { recursive: true });
    mkdirSync(join(sim, "calls"), { recursive: true });
    mkdirSync(join(sim, "knob"), { recursive: true });
    const rendered = await renderStaging(`sha256:${"ef".repeat(32)}`, {
      applicationId: deployments.devbot.applicationId,
      registrationScope: deployments.devbot.registrationScope,
    });
    writeFileSync(join(home, ".config/tarubot/tarubot.env"), rendered.env, { mode: 0o600 });
    writeFileSync(join(home, ".config/tarubot/image"), `${IMAGE}\n`, { mode: 0o600 });
    if (options.exit !== undefined)
      writeFileSync(join(sim, "knob/podman-exit"), String(options.exit));
    options.setup?.(home);
    const variables: Record<string, string | undefined> = {
      PATH: `${STUBS}:/usr/bin:/bin`,
      HOME: home,
      LC_ALL: "C",
      BACKUP_SIM: sim,
      XDG_RUNTIME_DIR: join(base, "runtime"),
      ...options.env,
    };
    const result = Bun.spawnSync(["bash", TOOL, ...args], {
      env: Object.fromEntries(
        Object.entries(variables).filter((entry): entry is [string, string] => !!entry[1]),
      ),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const calls = readdirSync(join(sim, "calls"))
      .sort()
      .map((id) => {
        const directory = join(sim, "calls", id);
        const env = new Map(
          readFileSync(join(directory, "env"), "utf8")
            .split("\0")
            .slice(0, -1)
            .map((entry) => [
              entry.slice(0, entry.indexOf("=")),
              entry.slice(entry.indexOf("=") + 1),
            ]),
        );
        return {
          argv: readFileSync(join(directory, "argv"), "utf8").split("\0").slice(0, -1),
          env,
        };
      });
    return {
      code: result.exitCode,
      err: result.stderr.toString(),
      calls,
      home,
      unit: parseUnit(rendered.container, "tarubot.container"),
    };
  }

  test("is bash in strict mode", async () => {
    const tool = await read(`${ANSIBLE}/files/bot/tarubot-tool`);
    expect(tool).toStartWith("#!/usr/bin/env bash\n");
    expect(tool).toContain("set -Eeuo pipefail");
    expect(Bun.spawnSync(["bash", "-n", TOOL]).exitCode).toBe(0);
  });

  test("runs the tool in the image file's release with the settings file, the unit's secrets and hardening", async () => {
    const { code, calls, home, unit } = await run(["migrate.js"]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const secrets = unit
      .filter((line) => line.section === "Container" && line.key === "Secret")
      .flatMap((line) => ["--secret", line.value]);
    expect(secrets).toHaveLength(10);
    expect(calls[0]?.argv).toEqual([
      "run",
      "--rm",
      "--pull=never",
      "--read-only",
      "--read-only-tmpfs=false",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--env-host=false",
      "--http-proxy=false",
      "--log-driver=none",
      "--label",
      "io.tarubot.role=tool",
      "--env-file",
      join(home, ".config/tarubot/tarubot.env"),
      ...secrets,
      IMAGE,
      "bun",
      "dist/scripts/migrate.js",
    ]);
    // No --name or --replace: an operator's run never collides with the unit's own migrate.js.
    expect(calls[0]?.argv.some((arg) => /^--(name|replace)/u.test(arg))).toBe(false);
  });

  test("--image picks the release, and the tool's arguments pass through", async () => {
    const other = `ghcr.io/deconfined/tarubot@sha256:${"01".repeat(32)}`;
    const { code, calls } = await run(["--image", other, "commands.js", "list", "--guild", "x y"]);
    expect(code).toBe(0);
    expect(calls[0]?.argv.slice(-6)).toEqual([
      other,
      "bun",
      "dist/scripts/commands.js",
      "list",
      "--guild",
      "x y",
    ]);
  });

  test("the tool's exit status is the wrapper's", async () => {
    expect((await run(["migrate.js"], { exit: 7 })).code).toBe(7);
  });

  test("refuses a bad tool name or image reference before Podman runs", async () => {
    for (const args of [
      [],
      ["migrate"],
      ["Migrate.js"],
      ["../migrate.js"],
      ["migrate.js;true"],
      ["dist/scripts/migrate.js"],
      ["--image"],
      ["--image", `ghcr.io/other/tarubot@sha256:${"0".repeat(64)}`, "migrate.js"],
      ["--image", "ghcr.io/deconfined/tarubot:2.36.0", "migrate.js"],
      ["--image", `ghcr.io/deconfined/tarubot@sha256:${"0".repeat(63)}`, "migrate.js"],
      ["--image", `ghcr.io/deconfined/tarubot@sha256:${"A".repeat(64)}`, "migrate.js"],
    ]) {
      const result = await run(args);
      expect({ args, code: result.code, calls: result.calls.length }).toEqual({
        args,
        code: 64,
        calls: 0,
      });
      expect(result.err).toContain("usage: tarubot-tool");
    }
  });

  test("refuses a missing or foreign image file, a missing settings file and a stray secret line", async () => {
    const cases: [string, (home: string) => void][] = [
      ["no image file", (home) => rmSync(join(home, ".config/tarubot/image"))],
      [
        "another repository",
        (home) =>
          writeFileSync(
            join(home, ".config/tarubot/image"),
            `ghcr.io/other/tarubot@sha256:${"0".repeat(64)}\n`,
          ),
      ],
      ["no settings", (home) => rmSync(join(home, ".config/tarubot/tarubot.env"))],
      [
        "a mismatched secret line",
        (home) =>
          writeFileSync(
            join(home, ".config/tarubot/tarubot.env"),
            "DATABASE_URL_FILE=/run/secrets/discord_token\n",
          ),
      ],
    ];
    for (const [label, setup] of cases) {
      const result = await run(["migrate.js"], { setup });
      expect({ label, code: result.code, calls: result.calls.length }).toEqual({
        label,
        code: 1,
        calls: 0,
      });
    }
  });

  test("falls back to the user's runtime directory and drops systemd's notification socket", async () => {
    const { code, calls } = await run(["migrate.js"], {
      env: { XDG_RUNTIME_DIR: undefined, NOTIFY_SOCKET: "/run/user/0/systemd/notify" },
    });
    expect(code).toBe(0);
    expect(calls[0]?.env.get("XDG_RUNTIME_DIR")).toBe(`/run/user/${process.getuid?.() ?? ""}`);
    expect(calls[0]?.env.has("NOTIFY_SOCKET")).toBe(false);
  });

  test("an unrelated NAME_FILE line is left alone", async () => {
    const { code, calls } = await run(["migrate.js"], {
      setup: (home) =>
        writeFileSync(
          join(home, ".config/tarubot/tarubot.env"),
          "TEST_PLAN_FILE=test-plans/current.json\nDATABASE_URL_FILE=/run/secrets/database_url\n",
        ),
    });
    expect(code).toBe(0);
    expect(calls[0]?.argv.filter((arg) => arg.startsWith("tarubot-"))).toEqual([
      "tarubot-database-url,type=mount,target=/run/secrets/database_url,uid=1000,gid=1000,mode=0400",
    ]);
  });

  test("is installed executable by bot.yml", async () => {
    const files = (await allTasks()).find(({ task }) =>
      String(task.name).startsWith("Install tarubot-tool"),
    );
    expect(argsOf(files?.task ?? {})).toMatchObject({
      src: "files/bot/{{ item }}",
      dest: "{{ tb_home }}/.local/bin/{{ item }}",
      mode: "0755",
    });
    expect(files?.task.loop).toEqual(["tarubot-tool", "tarubot-backup"]);
  });
});
