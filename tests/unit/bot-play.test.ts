/**
 * The release's bot deploy (#62): ops/ansible/bot.yml, its vars, and the tarubot-tool wrapper it
 * installs. host.yml's Bot step runs the play from the release commit as root over SSH; the bot
 * runs as a rootless Quadlet unit of the tarubot user. These pin, statically and with stand-ins
 * (no Ansible, Podman or network: unit tests run in the image build):
 * - the play's shape: three plays, the phases in order, a rescue, the result written on the runner
 *   by the last play with the final assert, no meta: end_*, no play-level ansible_remote_tmp;
 * - the secrets: lookup('ansible.builtin.env', NAME) only in no_log tasks, only in the five
 *   set_facts of names and booleans and in a secret's own stdin, never in vars, environment or a
 *   template, and only with operations that can't raise on a value (an exception's text reaches
 *   the log's [ERROR] line even under no_log); the secret task's argv, stdin and label; the
 *   refusals as plain asserts, whose names reach the log, each declaring its outcome and reason
 *   for the rescue; no_log on every tool run and container inspect; no debug and no diff;
 * - the writes: tarubot.env, the unit and the image file only in the preflight and unit phases,
 *   the unit only after Quadlet's dry run;
 * - the settings against the code: the staging lists against src/config/secrets.ts and
 *   deployment.ts, the identity script against src/config/deployment.ts, and the rendered staging
 *   settings through configuration() and the tool guard;
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
  resolveDeployment,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import { configuration } from "../../src/config/env.js";
import { FILE_SETTINGS } from "../../src/config/secrets.js";
import { renderStaging } from "../fixtures/bot-render.js";
import { filesUnder, parseEnvFile, parseUnit, read, root, single } from "../fixtures/quadlet.js";

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
/** The set_fact keys that may hold an env lookup: names and booleans only. */
const LOOKUP_FACTS = ["tb_db_ok", "tb_malformed", "tb_missing", "tb_token_absent", "tb_token_ok"];
/** The phases of the second play, in order. */
const PHASES = [
  "Checks",
  "Live",
  "Decide",
  "Image",
  "Migrations",
  "Identity",
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
      ["Decide", "Refuse another target's database", "refused", "database-not-this-target"],
      ["Decide", "Refuse a preflight on a host that runs a bot", "refused", "bot-exists"],
      ["Image", "Refuse an image that isn't the release's", "refused", "image-mismatch"],
      [
        "Migrations",
        "Refuse a rollback across a migration",
        "refused",
        "rollback-across-migration",
      ],
      [
        "Identity",
        "Refuse a Discord token of another application",
        "refused",
        "token-application-mismatch",
      ],
      ["Preflight", "Require Schema ready.", "failed", "schema-not-ready"],
      ["Preflight", "Run one backup", "failed", "backup-failed"],
      ["Unit", "Refuse a unit Quadlet can't turn into tarubot.service", "failed", "unit-invalid"],
      ["Restart", "Restart the bot", "failed", "restart-failed"],
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
  test("an env lookup appears only in no_log set_facts of names and booleans and in a secret's stdin", async () => {
    const holding = new Set<string>();
    for (const { task } of await allTasks()) {
      const own = ownText(task);
      if (!own.includes("lookup(")) continue;
      const where = String(task.name);
      // Only the env lookup, spelled in full; no other lookup or query reaches the play.
      expect({ where, other: own.replaceAll(LOOKUP, "").includes("lookup(") }).toEqual({
        where,
        other: false,
      });
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
        // The one command: the value is its stdin, never its arguments.
        const { stdin, ...rest } = argsOf(task);
        expect(stdin).toBe(`{{ ${LOOKUP}, item) }}`);
        expect(JSON.stringify(rest)).not.toContain("lookup(");
      }
    }
    expect([...holding].sort()).toEqual(LOOKUP_FACTS);
  });

  test("a secret's value meets only operations that can't raise on any string", async () => {
    // ansible-core 2.19 and later censor a no_log task's result, but not the [ERROR] line of an
    // exception raised while templating, which can quote the value (urlsplit's "Port could not
    // be cast to integer value as '<start of the password>'", for one). So an expression that
    // reads a value may use only these filters and tests, and .split() as its one method.
    const FILTERS = ["b64decode", "first", "join", "length", "map", "regex_escape"];
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
      for (const expression of strings(own).filter((text) => text.includes(LOOKUP))) {
        const filters = [...expression.matchAll(/\|\s*([a-z0-9_]+)/gu)].map((m) => m[1] ?? "");
        const tests = [...expression.matchAll(/\bis\s+(?:not\s+)?([a-z_]+)/gu)].map(
          (m) => m[1] ?? "",
        );
        const methods = [...expression.matchAll(/\)\s*\.([a-z_]+)\(/gu)].map((m) => m[1] ?? "");
        expect({ where, odd: filters.filter((f) => !FILTERS.includes(f)) }).toEqual({
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
    for (const play of await plays())
      for (const key of ["vars", "vars_files", "environment", "vars_prompt"])
        expect(text(play[key])).not.toContain("lookup(");
    for (const { task } of await allTasks())
      if (moduleOf(task) === "block")
        for (const key of ["vars", "environment"])
          expect({ block: task.name, key, lookup: text(task[key]).includes("lookup(") }).toEqual({
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
        lookup: uncommented(await read(`${ANSIBLE}/${file}`)).includes("lookup("),
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
    // The identity run, migrate.js, register.js, commands.js list and both health inspects.
    expect(runs.length).toBe(6);
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

  test("nothing but image pulls and throwaway containers runs before the secrets phase", async () => {
    // Pulls, inspects, `image exists` and --rm containers with no network: no write the host keeps.
    const before = (await allTasks()).filter(({ phase }) =>
      ["Checks", "Live", "Decide", "Image", "Migrations", "Identity"].includes(phase ?? ""),
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
        const allowed =
          (argv[1] === "image" && ["exists", "inspect"].includes(argv[2] ?? "")) ||
          argv[1] === "pull" ||
          (argv[1] === "run" && argv.includes("--rm") && argv.includes("--network=none"));
        expect({ task: task.name, allowed }).toEqual({ task: task.name, allowed: true });
      }
    }
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
      "tb_multiline_secrets",
      "tb_preflight_secrets",
      "tb_base_settings",
      "tb_health",
      "tb_prune_until",
      "tb_image_source",
      "tb_identity_script",
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
