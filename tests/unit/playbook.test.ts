/**
 * TaruBot's host playbook (#50, ops/ansible/; docs/HOSTING.md "Staging host"). From 2.34.0 the pull
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
 * - the host lock (2.33.0): the root-owned file tmpfiles creates at deploy.sh's QUADLET_LOCK, its
 *   checks, every user-manager change in the tarubot play under tb_locked, and the held-lock flag
 *   honoured only when a probe finds the lock held;
 * - the backup's user units: linked from the release's ops/systemd/, the timer enabled only once
 *   the bot's unit is linked;
 * - the start tag: the only tasks that link the bot's unit, pin the image digest or start the bot,
 *   all guarded and at the end of the last play, in the order that checks before it changes;
 * - CI: ShellCheck covers every script under ops/, and the Quadlet generator image runs the
 *   playbook's minimum Podman.
 *
 * The start never runs in CI or in 2.33.0 itself (the staging bot starts at the DevBot move), so
 * these are its only automated checks; each names what the host would otherwise do.
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

/** A task's `when`, as one string: a list's conditions all apply, so they join with "and". */
const whenOf = (task: Mapping): string =>
  Array.isArray(task.when) ? task.when.map(String).join(" and ") : String(task.when ?? "");

/** True for a task tagged exactly [start], the first start's tag. */
const isStart = (task: Mapping): boolean =>
  Array.isArray(task.tags) && task.tags.length === 1 && task.tags[0] === "start";

/**
 * The words a command task runs: an argv list's items, or the quoted items of a Jinja list
 * expression such as "{{ tb_locked + ['systemctl', '--user', 'daemon-reload'] }}".
 */
function argvWords(args: Mapping): string[] {
  const argv = args.argv;
  if (Array.isArray(argv)) return argv.map(String);
  if (typeof argv === "string") return [...argv.matchAll(/'([^']*)'/gu)].map((m) => m[1] ?? "");
  return [];
}

/** The check-mode guard: tasks that read what tmpfiles creates wait for a real run to create it. */
const TMPFILES_GUARD = "not (ansible_check_mode and tb_tmpfiles is changed)";

/** The prefix every user-manager change in the tarubot play starts with (vars/layout.yml). */
const LOCKED = "{{ tb_locked + ['systemctl', '--user', ";

/** A readonly single-quoted or bare constant from ops/deploy.sh (the deploysh builder's file). */
async function deployConstant(name: string): Promise<string> {
  const text = await read("ops/deploy.sh");
  const found = new RegExp(`^readonly ${name}=(?:'([^']*)'|(\\S+))$`, "mu").exec(text);
  if (!found) throw new Error(`ops/deploy.sh has no readonly ${name}= line`);
  return found[1] ?? found[2] ?? "";
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
        "files/tmpfiles-tarubot.conf",
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
      if (["ansible.builtin.blockinfile", "ansible.builtin.lineinfile"].includes(module))
        expect(args.mode, name).toMatch(/^0[0-7]{3}$/u);
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

  test("only the start tag links the bot's unit, pins its digest or starts it, and nothing stops it", async () => {
    // A normal run (and the pull unit's, which always skips the start tag) never changes what runs:
    // deploy.sh moves releases. Every task is untagged or tagged exactly [start].
    const writers = [
      "ansible.builtin.file",
      "ansible.builtin.copy",
      "ansible.builtin.template",
      "ansible.builtin.lineinfile",
      "ansible.builtin.blockinfile",
      "ansible.builtin.replace",
    ];
    let guarded = 0;
    for (const { task, module, args } of await allTasks()) {
      const name = String(task.name);
      if (task.tags !== undefined) expect(task.tags, name).toEqual(["start"]);
      const words = argvWords(args);
      const linksBot =
        writers.includes(module) &&
        `${String(args.dest ?? "")}${String(args.path ?? "")}`.startsWith("{{ tb_links_dir }}");
      const pinsDigest =
        writers.includes(module) && JSON.stringify(args).includes("TARUBOT_IMAGE_DIGEST");
      const startsBot = words.includes("start") && words.includes("tarubot.service");
      if (linksBot || pinsDigest || startsBot) {
        expect(isStart(task), name).toBe(true);
        guarded++;
      }
      // Nothing stops, restarts or kills the bot, tagged or not.
      if (words.includes("tarubot.service"))
        for (const verb of ["stop", "restart", "try-restart", "reload-or-restart", "kill"])
          expect(words, name).not.toContain(verb);
      if (module === "ansible.builtin.systemd_service")
        expect(String(args.name ?? ""), name).not.toContain("tarubot");
    }
    // Two Quadlet links (one looped task), the digest pin and the start.
    expect(guarded).toBe(3);
  });

  test("the start tasks are the guarded end of the last play", async () => {
    const [first, last] = await plays();
    if (!first || !last) throw new Error("site.yml needs two plays");
    expect(tasksOf(first, 0).filter(({ task }) => isStart(task))).toEqual([]);
    const tasks = tasksOf(last, 1).filter((task) => task.list === "tasks");
    const begin = tasks.findIndex(({ task }) => isStart(task));
    expect(begin).toBeGreaterThan(0);
    // One contiguous block at the end: an untagged task after it would run in the start's
    // absence with the start's variables undefined, and a start task before it would run before
    // the host layer's own checks of the home.
    for (const [index, { task }] of tasks.entries())
      expect(isStart(task), String(task.name)).toBe(index >= begin);
    for (const { task } of tasks.slice(begin))
      expect(whenOf(task), String(task.name)).toStartWith("tb_start_digest != ''");
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

describe("the host lock", () => {
  test("tmpfiles declares exactly the root-owned lock deploy.sh opens", async () => {
    const lines = (await read(`${ANSIBLE}/files/tmpfiles-tarubot.conf`))
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(lines).toEqual([
      "d /run/tarubot 0755 root root -",
      "f /run/tarubot/host.lock 0644 root root -",
    ]);
    // One path everywhere: the playbook's, deploy.sh's QUADLET_LOCK and the file tmpfiles makes.
    const lock = String((await layout()).tb_host_lock);
    expect(lock).toBe("/run/tarubot/host.lock");
    expect(await deployConstant("QUADLET_LOCK")).toBe(lock);
    expect(lines[1]?.split(" ")[1]).toBe(lock);
    expect(lines[0]?.split(" ")[1]).toBe(lock.slice(0, lock.lastIndexOf("/")));
  });

  test("the root play installs it first, creates it, and checks it before anyone relies on it", async () => {
    const tasks = (await allTasks()).filter((task) => task.play === 0 && task.list === "tasks");
    const [copy, create, lookDir, lookFile, check, probe, refuse] = tasks;
    // First, so that a caller claiming to hold the lock is checked before anything else changes.
    expect(copy?.module).toBe("ansible.builtin.copy");
    expect(copy?.args).toEqual({
      src: "tmpfiles-tarubot.conf",
      dest: "/etc/tmpfiles.d/tarubot.conf",
      owner: "root",
      group: "root",
      mode: "0644",
    });
    expect(copy?.task.register).toBe("tb_tmpfiles");
    // Every real run: it also puts back a lock removed since the boot.
    expect(create?.args.argv).toEqual([
      "systemd-tmpfiles",
      "--create",
      "/etc/tmpfiles.d/tarubot.conf",
    ]);
    expect(create?.task.changed_when).toBe("tb_tmpfiles is changed");
    expect(create?.task.check_mode).toBeUndefined();
    // Looked at without following links, and refused unless root owns both, as tmpfiles made them.
    expect(lookDir?.args).toMatchObject({ path: "{{ tb_host_lock | dirname }}", follow: false });
    expect(lookFile?.args).toMatchObject({ path: "{{ tb_host_lock }}", follow: false });
    expect(check?.module).toBe("ansible.builtin.assert");
    expect(check?.args.that).toEqual([
      "tb_lock_dir.stat.isdir | default(false) and not tb_lock_dir.stat.islnk",
      "tb_lock_dir.stat.uid == 0 and tb_lock_dir.stat.mode == '0755'",
      "tb_lock_file.stat.isreg | default(false) and not tb_lock_file.stat.islnk",
      "tb_lock_file.stat.uid == 0 and tb_lock_file.stat.mode == '0644'",
    ]);
    // In a check run before the first real one the lock doesn't exist yet, so these wait for it.
    for (const task of [lookDir, lookFile, check, probe, refuse])
      expect(whenOf(task?.task ?? {}), String(task?.task.name)).toContain(TMPFILES_GUARD);
  });

  test("tarubot_host_lock_held only drops the lock when a probe finds it held", async () => {
    const vars = await layout();
    expect(vars.tb_lock_held).toBe("{{ tarubot_host_lock_held | default(false) | bool }}");
    expect(vars.tb_locked).toBe(
      "{{ [] if tb_lock_held | bool else ['flock', '-w', '300', tb_host_lock] }}",
    );
    const tasks = (await allTasks()).filter((task) => task.play === 0 && task.list === "tasks");
    const probe = tasks.findIndex(({ task }) => task.register === "tb_lock_probe");
    const [found, refuse] = [tasks[probe], tasks[probe + 1]];
    // flock exits 75 only when another open file holds the lock; free, it takes it and exits 0.
    expect(found?.args.argv).toEqual([
      "flock",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      "{{ tb_host_lock }}",
      "true",
    ]);
    expect(found?.task).toMatchObject({ changed_when: false, check_mode: false });
    expect(refuse?.module).toBe("ansible.builtin.assert");
    expect(refuse?.args.that).toEqual(["tb_lock_probe.rc == 75"]);
    for (const task of [found, refuse]) {
      expect(whenOf(task?.task ?? {})).toStartWith("tb_lock_held | bool and ");
      expect(whenOf(task?.task ?? {})).toContain(TMPFILES_GUARD);
    }
    // Before the root play changes anything but the tmpfiles line itself.
    const hostname = tasks.findIndex(({ module }) => module === "ansible.builtin.hostname");
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(hostname);
  });

  test("every change to tarubot's user manager takes the lock, and root's play makes none", async () => {
    const changes = [
      "daemon-reload",
      "enable",
      "start",
      "restart",
      "stop",
      "reload",
      "disable",
      "reenable",
      "mask",
      "unmask",
      "kill",
      "reset-failed",
    ];
    let locked = 0;
    for (const { task, module, args, play } of await allTasks()) {
      const name = String(task.name);
      // No user-scope module call anywhere: it would bypass the lock.
      if (module === "ansible.builtin.systemd_service") {
        expect(play, name).toBe(0);
        expect(args.scope, name).toBeUndefined();
      }
      if (module !== "ansible.builtin.command") continue;
      // Commands run from argv only, so every word is visible here.
      expect(isMapping(task[module]) && "argv" in args, name).toBe(true);
      const words = argvWords(args);
      if (!words.includes("systemctl") || !words.includes("--user")) continue;
      if (!words.some((word) => changes.includes(word))) continue;
      expect(play, name).toBe(1);
      expect(String(args.argv), name).toStartWith(LOCKED);
      locked++;
    }
    // Two reloads, the bot's start and two timer enables (untagged and the start's).
    expect(locked).toBe(5);
  });
});

describe("the backup units", () => {
  test("they are the release's own files, linked into tarubot's user unit directory", async () => {
    const vars = await layout();
    expect(vars.tb_backup_units).toEqual(["tarubot-backup.service", "tarubot-backup.timer"]);
    expect(vars.tb_user_units_dir).toBe(`${String(vars.tb_home)}/.config/systemd/user`);
    // The backup builder's files: each link points at one the release ships.
    for (const unit of vars.tb_backup_units as string[])
      expect(await Bun.file(root(`ops/systemd/${unit}`)).exists(), unit).toBe(true);
    const links = (await allTasks()).filter(
      ({ module, args }) =>
        module === "ansible.builtin.file" &&
        args.state === "link" &&
        String(args.dest).startsWith("{{ tb_user_units_dir }}/"),
    );
    expect(links.map(({ task }) => isStart(task))).toEqual([false, true]);
    const [every, first] = links;
    // Every run links what the clone has; the start links both from the commit it starts.
    expect(every?.args).toMatchObject({
      src: "{{ tb_clone }}/ops/systemd/{{ item.item }}",
      dest: "{{ tb_user_units_dir }}/{{ item.item }}",
      follow: false,
    });
    expect(every?.task.loop).toBe("{{ tb_backup_sources.results }}");
    expect(every?.task.when).toBe("item.stat.exists");
    expect(every?.task.register).toBe("tb_backup_links");
    expect(first?.args).toMatchObject({
      src: "{{ tb_clone }}/ops/systemd/{{ item }}",
      dest: "{{ tb_user_units_dir }}/{{ item }}",
    });
    expect(first?.task.loop).toBe("{{ tb_backup_units }}");
  });

  test("a new link reloads the user manager, and the timer waits for the bot's unit", async () => {
    const tasks = (await allTasks()).filter((task) => task.play === 1 && !isStart(task.task));
    const reload = tasks.find(({ args }) => String(args.argv).includes("'daemon-reload'"));
    expect(whenOf(reload?.task ?? {})).toBe(
      "(tb_global_user_masks is changed or tb_backup_links is changed) and not ansible_check_mode",
    );
    // Both links, pointing into the clone, before the timer counts as linked.
    const record = tasks.find(({ args }) => "tb_backup_linked" in args);
    expect(String(record?.args.tb_backup_linked)).toContain("map(attribute='stat.lnk_target')");
    expect(String(record?.args.tb_backup_linked)).toContain(
      "tb_backup_units | map('regex_replace', '^', tb_clone ~ '/ops/systemd/')",
    );
    const enable = tasks.filter(({ args }) =>
      String(args.argv).includes("'enable', '--now', 'tarubot-backup.timer'"),
    );
    expect(enable).toHaveLength(1);
    expect(whenOf(enable[0]?.task ?? {})).toStartWith(
      "tb_linked | bool and tb_backup_linked | bool and ",
    );
    // It never disables the timer.
    for (const { args, task } of await allTasks())
      expect(argvWords(args), String(task.name)).not.toContain("disable");
  });

  test("every run checks .env's secrets with the release's own secrets.sh", async () => {
    const check = (await allTasks()).find(
      ({ args, task }) =>
        !isStart(task) && JSON.stringify(args.argv ?? "").includes("{{ tb_quadlet }}/secrets.sh"),
    );
    expect(check?.args.argv).toEqual([
      "{{ tb_quadlet }}/secrets.sh",
      "check",
      "{{ tb_clone }}/.env",
    ]);
    expect(check?.task).toMatchObject({ changed_when: false, check_mode: false });
    expect(whenOf(check?.task ?? {})).toBe(
      "tb_env.stat.exists and tb_secrets_check.stat.executable | default(false)",
    );
  });
});

describe("the start tag", () => {
  /** The start tasks of the last play, in order. */
  async function startTasks(): Promise<Task[]> {
    return (await allTasks()).filter(({ task }) => isStart(task));
  }

  test("the inputs are checked before anything changes, against deploy.sh's own patterns", async () => {
    const vars = await layout();
    expect(vars.tb_start_version).toBe("{{ tarubot_start_version | default('') }}");
    expect(vars.tb_start_digest).toBe("{{ tarubot_start_digest | default('') }}");
    expect(vars.tb_version_pattern).toBe(await deployConstant("VERSION"));
    expect(vars.tb_digest_pattern).toBe("^sha256:[0-9a-f]{64}$");
    const check = (await allTasks()).find(
      ({ task, list }) => list === "pre_tasks" && String(task.when).includes("tb_start_version"),
    );
    expect(check?.play).toBe(0);
    expect(check?.task.when).toBe("tb_start_version != '' or tb_start_digest != ''");
    expect(check?.args.that).toEqual([
      "tb_start_version is string and tb_start_version is match(tb_version_pattern)",
      "tb_start_digest is string and tb_start_digest is match(tb_digest_pattern)",
      // --skip-tags start would drop the start silently.
      "'start' not in ansible_skip_tags",
      // The pull unit holds the lock and never starts the bot.
      "not tb_lock_held | bool",
    ]);
    // The patterns behave as deploy.sh's do.
    const version = new RegExp(String(vars.tb_version_pattern), "u");
    expect(["2.33.0", "0.0.0", "10.200.3000"].every((v) => version.test(v))).toBe(true);
    expect(["2.33", "02.33.0", "2.33.0-rc1", "v2.33.0"].some((v) => version.test(v))).toBe(false);
  });

  test("its first check refuses a second start, the held-lock flag and a partial run", async () => {
    const tasks = await startTasks();
    const at = tasks.findIndex(({ task }) => JSON.stringify(task).includes("ansible_run_tags"));
    const refuse = tasks[at];
    expect(refuse?.module).toBe("ansible.builtin.assert");
    expect(refuse?.args.that).toEqual([
      "ansible_run_tags == ['all']",
      "not tb_lock_held | bool",
      "not tb_linked | bool",
      "tb_start_container.rc == 1",
      "tb_env.stat.exists and (tb_env_counts.stdout.split() | map('int') | list)[:2] == [1, 0]",
      "tb_start_lock is skipped or tb_start_lock.rc == 0",
      "tb_start_clone.rc == 0 and tb_start_clone.stdout_lines == ['main']",
    ]);
    // Only reads come before it, and they run in a check run too.
    expect(at).toBe(3);
    for (const { task, module } of tasks.slice(0, at)) {
      expect(module, String(task.name)).toBe("ansible.builtin.command");
      expect(task, String(task.name)).toMatchObject({ changed_when: false, check_mode: false });
    }
    const [container, lock, clone] = tasks;
    expect(container?.args.argv).toEqual([
      "timeout",
      "60",
      "podman",
      "container",
      "exists",
      "tarubot",
    ]);
    expect(container?.task.failed_when).toBe("tb_start_container.rc not in [0, 1]");
    // As tarubot, the same probe as root's: exit 0 means the lock was free.
    expect(lock?.args.argv).toEqual([
      "flock",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      "{{ tb_host_lock }}",
      "true",
    ]);
    expect(whenOf(lock?.task ?? {})).toContain(TMPFILES_GUARD);
    expect(argvWords(clone?.args ?? {})[2]).toBe(
      "git symbolic-ref --quiet --short HEAD && git status --porcelain --untracked-files=no",
    );
    // Everything after it, but the check run's note, waits for a real run: its reads depend on
    // the fetch, pull and reset before them.
    for (const { task, module } of tasks.slice(at + 1))
      if (module === "ansible.builtin.debug")
        expect(whenOf(task)).toBe("tb_start_digest != '' and ansible_check_mode");
      else
        expect(whenOf(task), String(task.name)).toStartWith(
          "tb_start_digest != '' and not ansible_check_mode",
        );
  });

  test("it checks before it changes, and links, reloads, starts, waits and enables in order", async () => {
    const tasks = await startTasks();
    const find = (label: string, match: (task: Task) => boolean): number => {
      const found = tasks.filter(match);
      expect(found.length, label).toBe(1);
      return tasks.indexOf(found[0] as Task);
    };
    const argv = (task: Task) => JSON.stringify(task.args.argv ?? "");
    const order = [
      find("refusal", ({ task }) => JSON.stringify(task).includes("ansible_run_tags")),
      find("fetch", (task) => argv(task).includes("git fetch")),
      find("pull", (task) => argvWords(task.args).includes("pull")),
      find(
        "image check",
        ({ module, args }) =>
          module === "ansible.builtin.assert" && JSON.stringify(args).includes("RepoDigests"),
      ),
      find("commit check", ({ task }) => JSON.stringify(task).includes("tb_start_on_main.rc == 0")),
      find("reset", (task) => argv(task).includes("git reset")),
      find("syntax check", (task) => argvWords(task.args).includes("--syntax")),
      find("secrets check", (task) => argv(task).includes("secrets.sh")),
      find("version pin", ({ args }) => String(args.line).startsWith("TARUBOT_IMAGE_TAG=")),
      find("digest pin", ({ args }) => String(args.line).startsWith("TARUBOT_IMAGE_DIGEST=")),
      find("settings check", (task) => argvWords(task.args).includes("systemd-run")),
      find("Quadlet links", ({ args }) => String(args.dest).startsWith("{{ tb_links_dir }}/")),
      find("backup links", ({ args }) => String(args.dest).startsWith("{{ tb_user_units_dir }}/")),
      find("dry run", (task) => argvWords(task.args).includes("{{ tb_generator }}")),
      find("reload", (task) => argv(task).includes("'daemon-reload'")),
      find("start", (task) => argv(task).includes("'start', '--no-block', 'tarubot.service'")),
      find("wait", ({ task }) => task.until !== undefined),
      find("timer", (task) => argv(task).includes("'enable', '--now', 'tarubot-backup.timer'")),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Before the reset only the fetch and the pull write, and neither changes what runs: every
    // other command there only reads, so a refused image or commit leaves the host as it was.
    const pull = tasks[order[2] ?? -1];
    for (const task of tasks.slice(0, order[5]))
      if (task.module === "ansible.builtin.command" && task !== pull)
        expect(task.task.changed_when, String(task.task.name)).toBe(false);
  });

  test("the image must be the verified digest of the version, and its commit must speak quadlet", async () => {
    const vars = await layout();
    expect(vars.tb_image).toBe(await deployConstant("IMAGE"));
    // deploy.sh's CAPABILITY_LINE (§2 of the 2.33.0 spec), never a copied floor number.
    expect(vars.tb_capability_line).toBe('^readonly CAPABILITIES="([a-z0-9]+( [a-z0-9]+)*)"$');
    expect(vars.tb_capability_line).toBe(await deployConstant("CAPABILITY_LINE"));
    const tasks = await startTasks();
    const image = tasks.find(({ args }) => JSON.stringify(args).includes("RepoDigests"));
    expect(image?.args.that).toEqual([
      "(tb_image ~ '@' ~ tb_start_digest) in (tb_start_inspect.RepoDigests | default([], true))",
      "tb_start_labels['org.opencontainers.image.version'] | default('') == tb_start_version",
      "tb_start_labels['org.opencontainers.image.revision'] | default('') is match('^[0-9a-f]{40}$')",
    ]);
    const commit = tasks.find(({ task }) =>
      JSON.stringify(task).includes("tb_start_on_main.rc == 0"),
    );
    expect(commit?.args.that).toEqual([
      "tb_start_on_main.rc == 0",
      "tb_start_files.results | map(attribute='rc') | list == [0, 0]",
      "(tb_start_files.results[0].stdout | from_json).version | default('') == tb_start_version",
      "tb_start_capabilities | length == 1",
      "'quadlet' in tb_start_words.split(' ')",
      "tb_role != 'staging' or 'staging' in tb_start_words.split(' ')",
    ]);
    const words = mapping(commit?.task.vars, "the commit check's vars");
    expect(words.tb_start_capabilities).toBe(
      "{{ tb_start_files.results[1].stdout_lines | select('match', tb_capability_line) | list }}",
    );
    expect(String(words.tb_start_words).trim()).toBe(
      "{{ tb_start_capabilities | first | default('') | regex_replace('^readonly CAPABILITIES=\"|\"$', '') }}",
    );
    // The same reading in JavaScript: this release's deploy.sh passes on both roles, a comment or
    // a line with more after it doesn't count, and a release without the line fails.
    const line = new RegExp(String(vars.tb_capability_line), "u");
    const declared = (text: string) => {
      const found = text.split("\n").filter((l) => line.test(l));
      const spoken = (found[0] ?? "").replace(/^readonly CAPABILITIES="|"$/gu, "").split(" ");
      return { count: found.length, spoken };
    };
    const current = declared(await read("ops/deploy.sh"));
    expect(current.count).toBe(1);
    expect(current.spoken).toEqual(expect.arrayContaining(["quadlet", "staging"]));
    expect(declared('# readonly CAPABILITIES="staging quadlet"').count).toBe(0);
    expect(declared('readonly CAPABILITIES="staging quadlet" # later').count).toBe(0);
    expect(declared('readonly CAPABILITIES="quadlet"').spoken).not.toContain("staging");
    // The commit it reads is the image's own revision label, on main after a fetch.
    const onMain = tasks.find(({ task }) => task.register === "tb_start_on_main");
    expect(onMain?.args.argv).toEqual([
      "git",
      "merge-base",
      "--is-ancestor",
      "{{ tb_start_commit }}",
      "origin/main",
    ]);
    const commitFact = tasks.find(({ args }) => "tb_start_commit" in args);
    expect(String(commitFact?.args.tb_start_commit)).toContain(
      "Config.Labels['org.opencontainers.image.revision']",
    );
  });

  test("git writes run under umask 077 and keep the clone on main", async () => {
    const writes =
      /\bgit (fetch|reset|checkout|switch|pull|merge|rebase|clean|commit|am|apply|stash)\b/u;
    const found: string[] = [];
    for (const { task, module, args } of await allTasks()) {
      // The clone itself is ansible.builtin.git, once, with umask 0077 and update off.
      if (module === "ansible.builtin.git") {
        expect(args).toMatchObject({ update: false, umask: "0077", version: "main" });
        continue;
      }
      const words = argvWords(args);
      const script = words.find((word) => writes.test(word));
      if (script === undefined) continue;
      found.push(script);
      expect(isStart(task), String(task.name)).toBe(true);
      expect(words[words.indexOf(script) - 2], String(task.name)).toBe("sh");
      expect(words[words.indexOf(script) - 1], String(task.name)).toBe("-c");
      expect(script, String(task.name)).toStartWith("umask 077 && exec git ");
    }
    expect(found).toEqual([
      "umask 077 && exec git fetch --quiet origin main",
      // --keep moves main and refuses to lose a local change; the commit arrives as $1.
      'umask 077 && exec git reset --quiet --keep "$1"',
    ]);
  });

  test("the pin writes .env's two lines without logging or diffing .env", async () => {
    const pins = (await allTasks()).filter(({ module }) => module === "ansible.builtin.lineinfile");
    expect(pins.map(({ args }) => args.line)).toEqual([
      "TARUBOT_IMAGE_TAG={{ tb_start_version }}",
      "TARUBOT_IMAGE_DIGEST={{ tb_start_digest }}",
    ]);
    for (const { task, args } of pins) {
      expect(isStart(task)).toBe(true);
      expect(task.no_log, String(task.name)).toBe(true);
      expect(task.diff, String(task.name)).toBe(false);
      expect(args.path).toBe("{{ tb_clone }}/.env");
      expect(args.mode).toBe("0600");
    }
    expect(pins.map(({ args }) => args.regexp)).toEqual([
      "^TARUBOT_IMAGE_TAG=",
      "^TARUBOT_IMAGE_DIGEST=",
    ]);
    // The digest goes beside the tag line.
    expect(pins[1]?.args.insertafter).toBe("^TARUBOT_IMAGE_TAG=");
  });

  test("the unit's settings are checked the way a deploy checks them", async () => {
    // The 14 names the unit's [Service] drops (the secrets builder's unit), deploy.sh's
    // UNSET_SETTINGS and the playbook's copy are one list.
    const names = String((await layout()).tb_unset_settings).split(/\s+/u);
    expect(names).toHaveLength(14);
    expect(names).toEqual((await deployConstant("UNSET_SETTINGS")).split(" "));
    const unit = [
      ...(await read("ops/quadlet/units/tarubot.container")).matchAll(/^UnsetEnvironment=(.*)$/gmu),
    ];
    expect(unit).toHaveLength(1);
    expect(unit[0]?.[1]?.split(" ")).toEqual(names);
    const check = (await startTasks()).find(({ args }) => argvWords(args).includes("systemd-run"));
    expect(check?.args.argv).toEqual([
      "timeout",
      "120",
      "systemd-run",
      "--user",
      "--pipe",
      "--wait",
      "--collect",
      "--quiet",
      "--expand-environment=no",
      "-p",
      "EnvironmentFile={{ tb_clone }}/.env",
      "-p",
      "UnsetEnvironment={{ tb_unset_settings }}",
      "--",
      "{{ tb_quadlet }}/check-env.sh",
    ]);
  });

  test("the dry run must give tarubot.service alone, running the pinned digest", async () => {
    const check = (await startTasks()).find(({ task }) =>
      JSON.stringify(task).includes("tb_start_exec"),
    );
    expect(check?.args.that).toEqual([
      "tb_start_generator.rc == 0",
      "tb_start_generator.stdout_lines | select('match', '^---.*---$') | list == ['---tarubot.service---']",
      "tb_start_exec | length == 1",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: systemd's ${...}, which Jinja leaves alone.
      "(tb_start_exec | first).endswith(' ' ~ tb_image ~ '@${TARUBOT_IMAGE_DIGEST}')",
    ]);
    // The unit's Image= really is that reference.
    const unit = await read("ops/quadlet/units/tarubot.container");
    expect(unit).toContain(
      `\nImage=${String((await layout()).tb_image)}@\${TARUBOT_IMAGE_DIGEST}\n`,
    );
  });

  test("it waits three minutes for a healthy bot or the lifecycle's own lease-wait message", async () => {
    const marker = String((await layout()).tb_start_marker);
    expect(marker).toBe("Waiting for the database writer lease");
    expect(await read("src/application/lifecycle.ts")).toContain(marker);
    const wait = (await startTasks()).find(({ task }) => task.until !== undefined);
    // Up to 37 reads, 5 seconds apart: 180 seconds of waiting, and only reads.
    expect(Number(wait?.task.retries) * Number(wait?.task.delay)).toBe(180);
    expect(wait?.task.changed_when).toBe(false);
    expect(wait?.task.until).toBe(
      "'health healthy' in tb_start_wait.stdout_lines or 'lease-wait' in tb_start_wait.stdout_lines",
    );
    const words = argvWords(wait?.args ?? {});
    expect(words.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(words.slice(3)).toEqual([
      "sh",
      "{{ tb_start_marker }}",
      "{{ tb_start_since.stdout | trim }}",
    ]);
    const script = words[2] ?? "";
    expect(script).toContain("podman container inspect tarubot");
    expect(script).toContain(".[0].State.Health.Status");
    // Only this start's lines: the unit's journal since the moment before the start.
    expect(script).toContain('journalctl --user --unit tarubot.service --since "@$2"');
    expect(script).toContain('grep -qF -e "$1"');
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
