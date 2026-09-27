/**
 * TaruBot's host playbook (#50, ops/ansible/; docs/HOSTING.md "Staging host"). From 2.33.0 the pull
 * unit applies site.yml as root on every merge, so the rules that keep code running as tarubot from
 * steering root can't rest on comments; CI's syntax check and ansible-lint don't see them. These pin:
 * - the files: exactly the allowlisted set under ops/ansible/, no links, and none of the
 *   directories Ansible loads from beside a playbook (group_vars, host_vars, roles, library,
 *   *_plugins), whatever collections_path says;
 * - ansible.cfg: facts stay under ansible_facts, only ansible.builtin loads, and pipelining is where
 *   both the ssh and the local connection read it;
 * - site.yml: two plays, the first as root with no become anywhere in it, the last as tarubot with
 *   PYTHONNOUSERSITE and nothing after it; facts gathered once; ansible.builtin modules only; no
 *   lookups, delegation or includes; a mode on every file a task writes; every source inside
 *   ops/ansible/;
 * - the kernel, sshd and root-password settings the handover relies on, checked before it;
 * - the deploy key's forced command for each role, rendered from the template;
 * - CI: ShellCheck covers every script under ops/, and the Quadlet generator image runs the
 *   playbook's minimum Podman.
 */
import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

/** A path in the repository. */
const root = (path: string) => new URL(`../../${path}`, import.meta.url).pathname;
/** A repository file's text. */
const read = (path: string) => Bun.file(root(path)).text();

const ANSIBLE = "ops/ansible";

/** Every entry under a directory, relative to it and sorted, without following links. */
function entriesUnder(directory: string): { path: string; kind: "file" | "dir" | "link" }[] {
  const found: { path: string; kind: "file" | "dir" | "link" }[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(root(join(directory, relative)))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(root(join(directory, path)));
      if (stat.isSymbolicLink()) found.push({ path, kind: "link" });
      else if (stat.isDirectory()) {
        found.push({ path, kind: "dir" });
        walk(path);
      } else found.push({ path, kind: "file" });
    }
  };
  walk("");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** A parsed YAML mapping, or a failure naming what was expected. */
type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function mapping(value: unknown, what: string): Mapping {
  if (!isMapping(value)) throw new Error(`${what} is not a mapping`);
  return value;
}

/** The two plays of site.yml. */
async function plays(): Promise<Mapping[]> {
  const parsed: unknown = YAML.parse(await read(`${ANSIBLE}/site.yml`));
  if (!Array.isArray(parsed)) throw new Error("site.yml is not a list of plays");
  return parsed.map((play, index) => mapping(play, `play ${index + 1}`));
}

/** Task keywords: every other key on a task is its module. */
const TASK_KEYWORDS = new Set([
  "name",
  "when",
  "register",
  "loop",
  "loop_control",
  "changed_when",
  "failed_when",
  "check_mode",
  "notify",
  "listen",
  "tags",
  "vars",
  "environment",
  "become",
  "become_user",
  "become_method",
  "delegate_to",
  "local_action",
  "connection",
  "remote_user",
  "run_once",
  "ignore_errors",
  "no_log",
  "diff",
  "until",
  "retries",
  "delay",
  "args",
  "block",
  "rescue",
  "always",
  "throttle",
  "timeout",
  "any_errors_fatal",
]);

/** One task with the list it came from, blocks flattened. */
interface Task {
  play: number;
  list: string;
  task: Mapping;
  module: string;
  args: Mapping;
}

/** Every task, pre-task and handler of a play, with its one module and that module's arguments. */
function tasksOf(play: Mapping, index: number): Task[] {
  const found: Task[] = [];
  const visit = (items: unknown, list: string) => {
    if (items === undefined) return;
    if (!Array.isArray(items)) throw new Error(`play ${index + 1} ${list} is not a list`);
    for (const item of items) {
      const task = mapping(item, `a task in play ${index + 1} ${list}`);
      if ("block" in task) {
        for (const key of ["block", "rescue", "always"]) visit(task[key], list);
        continue;
      }
      const modules = Object.keys(task).filter((key) => !TASK_KEYWORDS.has(key));
      if (modules.length !== 1 || modules[0] === undefined)
        throw new Error(`task ${String(task.name)} has modules ${modules.join(", ") || "none"}`);
      const module = modules[0];
      const args = isMapping(task[module]) ? (task[module] as Mapping) : {};
      found.push({ play: index, list, task, module, args });
    }
  };
  for (const list of ["pre_tasks", "tasks", "post_tasks", "handlers"]) visit(play[list], list);
  return found;
}

/** Every task of both plays. */
async function allTasks(): Promise<Task[]> {
  return (await plays()).flatMap((play, index) => tasksOf(play, index));
}

/** ansible.cfg as sections of keys, read the way Python's configparser reads this simple file. */
async function ansibleCfg(): Promise<Map<string, Map<string, string>>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of (await read(`${ANSIBLE}/ansible.cfg`)).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([a-z_]+)\]$/u.exec(line);
    if (header?.[1]) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const setting = /^([a-z_]+)\s*=\s*(.*)$/u.exec(line);
    if (!setting?.[1] || setting[2] === undefined || current === null)
      throw new Error(`ansible.cfg: unreadable line ${raw}`);
    current.set(setting[1], setting[2]);
  }
  return sections;
}

/** vars/layout.yml, which both plays load. */
async function layout(): Promise<Mapping> {
  return mapping(YAML.parse(await read(`${ANSIBLE}/vars/layout.yml`)), "vars/layout.yml");
}

describe("the files", () => {
  test("ops/ansible holds exactly the playbook's files, with no links", () => {
    // A new file must be added here on purpose: Ansible loads group_vars, host_vars, library,
    // module_utils, *_plugins and roles from beside the playbook, whatever ansible.cfg says, and a
    // pull run applies whatever is here as root.
    const entries = entriesUnder(ANSIBLE);
    expect(entries.filter((entry) => entry.kind === "link")).toEqual([]);
    expect(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path)).toEqual([
      "files",
      "files/skel",
      "templates",
      "vars",
    ]);
    expect(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(
      [
        ".ansible-lint",
        "ansible.cfg",
        "files/cloud-init-tarubot.cfg",
        "files/journald-tarubot.conf",
        "files/multi-user-network-online.conf",
        "files/RPM-GPG-KEY-EPEL-10",
        "files/skel/.bash_profile",
        "files/skel/.bashrc",
        "files/sshd-00-tarubot.conf",
        "files/sysctl-tarubot.conf",
        "files/tarubot-epel.repo",
        "files/tarubot-ipv6-online",
        "files/tarubot-ipv6-online.service",
        "host.example.yml",
        "inventory.example.yml",
        "requirements-lint.txt",
        "requirements.txt",
        "site.yml",
        "templates/authorized_keys-tarubot.j2",
        "templates/dnf-automatic.conf.j2",
        "vars/layout.yml",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("ansible.cfg", () => {
  test("keeps facts out of top-level variables and loads ansible.builtin only", async () => {
    const cfg = await ansibleCfg();
    const defaults = cfg.get("defaults");
    // A task run as tarubot could otherwise return facts that override what a root task reads.
    expect(defaults?.get("inject_facts_as_vars")).toBe("False");
    // No collection or role from anywhere on the machine that runs the playbook.
    expect(defaults?.get("collections_path")).toBe("/dev/null");
    expect(defaults?.get("collections_scan_sys_path")).toBe("False");
    expect(defaults?.get("roles_path")).toBe("/dev/null");
    expect(defaults?.get("interpreter_python")).toBe("/usr/bin/python3");
    expect(defaults?.get("host_key_checking")).toBe("True");
    expect(cfg.get("inventory")?.get("unparsed_is_failed")).toBe("True");
    expect(cfg.get("privilege_escalation")?.get("become_method")).toBe("sudo");
  });

  test("sets pipelining where both the ssh and the local connection read it", async () => {
    // The local plugin (the pull unit's -c local) reads only [defaults] and [connection];
    // [ssh_connection] would leave local runs without it.
    const cfg = await ansibleCfg();
    expect(cfg.get("connection")?.get("pipelining")).toBe("True");
    expect(cfg.get("ssh_connection")?.has("pipelining") ?? false).toBe(false);
  });
});

describe("site.yml's plays", () => {
  test("two plays: root first without become, then tarubot last with PYTHONNOUSERSITE", async () => {
    const [first, last, ...more] = await plays();
    expect(more).toEqual([]);
    if (!first || !last) throw new Error("site.yml needs two plays");
    // The first play runs as root and gathers facts once, before any tarubot task.
    expect(first.become).toBe(false);
    expect(first.become_user).toBeUndefined();
    expect(first.gather_facts).toBe(true);
    // The last play runs every task in tarubot's context, and no play follows it, so no root task
    // reads what a tarubot task returned.
    expect(last.become).toBe(true);
    expect(last.become_user).toBe("tarubot");
    expect(last.gather_facts).toBe(false);
    expect(mapping(last.environment, "the last play's environment").PYTHONNOUSERSITE).toBe("1");
    expect(last.handlers).toBeUndefined();
    for (const play of [first, last]) {
      expect(play.hosts).toBe("all");
      // Settings come only through -e; vars/layout.yml reads them, and nothing else is loaded.
      expect(play.vars_files).toEqual(["vars/layout.yml"]);
      expect(play.roles).toBeUndefined();
      expect(play.connection).toBeUndefined();
      expect(play.remote_user).toBeUndefined();
    }
  });

  test("no task changes who it runs as, or where", async () => {
    for (const { task } of await allTasks())
      for (const key of [
        "become",
        "become_user",
        "become_method",
        "delegate_to",
        "local_action",
        "connection",
        "remote_user",
      ])
        expect(task[key], `${String(task.name)} sets ${key}`).toBeUndefined();
  });

  test("the tarubot play notifies nothing, so no root handler runs after it", async () => {
    for (const { task, play } of await allTasks())
      if (play === 1) expect(task.notify, String(task.name)).toBeUndefined();
  });

  test("ansible.builtin modules only, with no includes, host changes or controller files", async () => {
    const forbidden = [
      "include_tasks",
      "import_tasks",
      "include_role",
      "import_role",
      "import_playbook",
      "include_vars",
      "add_host",
      "group_by",
      "script",
      "raw",
      "fetch",
      "set_stats",
    ].map((name) => `ansible.builtin.${name}`);
    for (const { module, task } of await allTasks()) {
      expect(module, String(task.name)).toStartWith("ansible.builtin.");
      expect(forbidden, String(task.name)).not.toContain(module);
    }
  });

  test("no lookups and no template includes, so nothing is read from outside ops/ansible", async () => {
    // Lookups and template includes read files on the machine running the playbook, outside the
    // tasks' own sources.
    const texts = await Promise.all(
      [
        "site.yml",
        "vars/layout.yml",
        "templates/authorized_keys-tarubot.j2",
        "templates/dnf-automatic.conf.j2",
      ].map(async (file) => [file, await read(`${ANSIBLE}/${file}`)] as const),
    );
    for (const [file, text] of texts) {
      expect(text, file).not.toMatch(/\b(lookup|query|q)\s*\(/u);
      expect(text, file).not.toMatch(/\{%-?\s*(include|import|from|extends)\b/u);
    }
  });

  test("every file a task writes gets an explicit mode", async () => {
    for (const { module, args, task } of await allTasks()) {
      const name = String(task.name);
      if (["ansible.builtin.copy", "ansible.builtin.template"].includes(module))
        expect(args.mode, name).toMatch(/^0[0-7]{3}$/u);
      if (module === "ansible.builtin.blockinfile") expect(args.mode, name).toMatch(/^0[0-7]{3}$/u);
      // A link carries no mode of its own, and an absent path none at all.
      if (module === "ansible.builtin.file" && !["link", "absent"].includes(String(args.state)))
        expect(args.mode, name).toMatch(/^0[0-7]{3}$/u);
    }
  });

  test("copy and template sources are files shipped in ops/ansible", async () => {
    for (const { module, args, task } of await allTasks()) {
      const directory =
        module === "ansible.builtin.copy"
          ? "files"
          : module === "ansible.builtin.template"
            ? "templates"
            : null;
      if (directory === null) continue;
      const src = String(args.src);
      // A loop's items fill {{ item }}; every item must be a plain string.
      const items = src.includes("{{ item }}")
        ? (task.loop as unknown[]).map((item) => src.replace("{{ item }}", String(item)))
        : [src];
      for (const source of items) {
        expect(source, String(task.name)).not.toMatch(/^\/|\.\.|\{\{/u);
        expect(await Bun.file(root(`${ANSIBLE}/${directory}/${source}`)).exists()).toBe(true);
      }
    }
  });

  test("handlers only reload, restart journald, apply sysctl or check sshd", async () => {
    const handlers = (await plays()).flatMap((play, index) =>
      tasksOf(play, index).filter((task) => task.list === "handlers"),
    );
    expect(handlers.map(({ task }) => task.name)).toEqual([
      "Reload systemd",
      "Restart journald",
      "Move the in-memory journal to disk",
      "Apply the sysctl settings",
      "Check the whole sshd configuration",
      "Reload sshd with the checked configuration",
    ]);
    // None of them ever touches the bot's unit.
    expect(JSON.stringify(handlers)).not.toContain("tarubot.service");
  });

  test("nothing links, starts, stops or restarts the bot", async () => {
    // 2.32.0 has no start tag; it arrives with 2.33.0's first start.
    for (const { task, module, args } of await allTasks()) {
      expect(task.tags, String(task.name)).toBeUndefined();
      if (module === "ansible.builtin.systemd_service")
        expect(String(args.name ?? ""), String(task.name)).not.toContain("tarubot");
    }
  });
});

describe("the handover to tarubot", () => {
  test("the first play ends by refusing a traceable or injectable handover", async () => {
    const [first] = await plays();
    if (!first) throw new Error("site.yml has no plays");
    const tasks = tasksOf(first, 0).filter((task) => task.list === "tasks");
    const [read, check] = tasks.slice(-2);
    // The last two root tasks read the two kernel guards and assert them, so every other root
    // task, the root password lock included, comes before the handover.
    expect(read?.module).toBe("ansible.builtin.slurp");
    expect(read?.task.loop).toEqual([
      "/proc/sys/kernel/yama/ptrace_scope",
      "/proc/sys/dev/tty/legacy_tiocsti",
    ]);
    expect(check?.module).toBe("ansible.builtin.assert");
    expect(check?.args.that).toEqual([
      "tb_kernel_guards.results[0].content | b64decode | trim | int >= 1",
      "tb_kernel_guards.results[1].content | b64decode | trim == '0'",
    ]);
  });

  test("the kernel settings the handover checks are the ones the playbook installs", async () => {
    const sysctl = (await read(`${ANSIBLE}/files/sysctl-tarubot.conf`))
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(sysctl).toContain("kernel.yama.ptrace_scope = 1");
    expect(sysctl).toContain("dev.tty.legacy_tiocsti = 0");
  });

  test("root's password is locked, after the check that sshd leaves key logins to PAM", async () => {
    const tasks = (await allTasks()).filter((task) => task.play === 0 && task.list === "tasks");
    const lock = tasks.findIndex(
      ({ module, args }) =>
        module === "ansible.builtin.user" && args.name === "root" && args.password_lock === true,
    );
    const sshd = tasks.findIndex(({ task }) =>
      String(task.name).startsWith("Refuse sshd settings other than"),
    );
    expect(lock).toBeGreaterThan(-1);
    expect(sshd).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(sshd);
    expect(tasks[sshd]?.args.that).toContain("'usepam yes' in item.stdout_lines");
  });

  test("sshd forwards nothing and runs no ~/.ssh/rc, and the run checks it took effect", async () => {
    const lines = (await read(`${ANSIBLE}/files/sshd-00-tarubot.conf`)).split("\n");
    // Before the Match block, so they apply to every user.
    const match = lines.findIndex((line) => line.startsWith("Match "));
    for (const setting of ["DisableForwarding yes", "PermitUserRC no", "X11Forwarding no"]) {
      const at = lines.indexOf(setting);
      expect(at, setting).toBeGreaterThan(-1);
      expect(at, setting).toBeLessThan(match);
    }
    const check = (await allTasks()).find(({ task }) =>
      String(task.name).startsWith("Refuse sshd settings other than"),
    );
    expect(check?.args.that).toEqual(
      expect.arrayContaining([
        "'disableforwarding yes' in item.stdout_lines",
        "'permituserrc no' in item.stdout_lines",
      ]),
    );
  });
});

describe("the deploy key", () => {
  test("its line forces ops/deploy.sh in the role's Quadlet mode, restricted", async () => {
    const vars = await layout();
    const template = await read(`${ANSIBLE}/templates/authorized_keys-tarubot.j2`);
    const lines = template.split("\n").filter((line) => line.startsWith("restrict"));
    expect(lines).toEqual([
      'restrict,command="{{ tb_home }}/tarubot/ops/deploy.sh {{ tb_deploy_args }}" {{ tb_deploy_key }}',
    ]);
    // Render the one line for each role from vars/layout.yml's own values.
    const args =
      /^\{\{ \{'staging': '([a-z ]+)', 'production': '([a-z ]+)'\}\[tb_role\] \| default\(''\) \}\}$/u.exec(
        String(vars.tb_deploy_args),
      );
    if (!args?.[1] || !args[2])
      throw new Error("tb_deploy_args isn't the role map this test reads");
    const render = (role: "staging" | "production") =>
      (lines[0] ?? "")
        .replace("{{ tb_home }}", String(vars.tb_home))
        .replace("{{ tb_deploy_args }}", role === "staging" ? (args[1] ?? "") : (args[2] ?? ""))
        .replace(" {{ tb_deploy_key }}", "");
    expect(render("staging")).toBe(
      'restrict,command="/home/tarubot/tarubot/ops/deploy.sh quadlet staging"',
    );
    expect(render("production")).toBe(
      'restrict,command="/home/tarubot/tarubot/ops/deploy.sh quadlet"',
    );
    expect(vars.tb_clone).toBe(`${String(vars.tb_home)}/tarubot`);
  });
});

describe("CI", () => {
  test("ShellCheck covers every script under ops/", async () => {
    // Every file that starts with #! must be named, or matched by a glob, in a ShellCheck line.
    const ci = await read(".github/workflows/ci.yml");
    const covered = new Set<string>();
    for (const [, words] of ci.matchAll(/shellcheck -S warning ([^\n]+)/gu))
      for (const word of (words ?? "").split(" ").filter((part) => part.startsWith("ops/")))
        for (const path of new Bun.Glob(word).scanSync({ cwd: root(""), dot: true }))
          covered.add(path);
    const scripts: string[] = [];
    for (const entry of entriesUnder("ops"))
      if (
        entry.kind === "file" &&
        (await Bun.file(root(`ops/${entry.path}`)).text()).startsWith("#!")
      )
        scripts.push(`ops/${entry.path}`);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect([...covered], script).toContain(script);
  });

  test("the Quadlet generator image runs the Podman the playbook requires", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const images = [
      ...ci.matchAll(/quay\.io\/podman\/stable:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}/gu),
    ];
    expect(images).toHaveLength(1);
    expect(images[0]?.[1]).toBe(String((await layout()).tb_podman_minimum));
    // The README's recipe for running the same check locally names the same version.
    const readme = await read("ops/quadlet/README.md");
    expect(readme).toContain(
      `quay.io/podman/stable:v${String((await layout()).tb_podman_minimum)}`,
    );
  });
});
