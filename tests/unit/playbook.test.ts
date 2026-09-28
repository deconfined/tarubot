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
 * - the pull unit (2.34.0): its script and units installed root-owned from files/host-config/, the
 *   timer enabled only on a bootstrapped host and never stopped, the allowed signers rendered from
 *   the host settings, the run source checked and written to the run marker first, a hand run
 *   refused unless the unit is paused, ansible-core at its floor from AppStream, and no dnf call on
 *   a run with nothing to install;
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
      "files/host-config",
      "files/skel",
      "templates",
      "vars",
    ]);
    expect(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(
      [
        ".ansible-lint",
        "ansible.cfg",
        "files/cloud-init-tarubot.cfg",
        "files/host-config/tarubot-host-config",
        "files/host-config/tarubot-host-config.service",
        "files/host-config/tarubot-host-config.timer",
        "files/host-config/timer-production.conf",
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
        "templates/allowed_signers.j2",
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
        "templates/allowed_signers.j2",
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
      // The run marker is the one copy written from content, built from run variables the first
      // play has already checked (describe "the pull unit").
      if (module === "ansible.builtin.copy" && "content" in args) {
        expect(args.src, String(task.name)).toBeUndefined();
        expect(args.dest, String(task.name)).toBe("{{ tb_pull_marker }}");
        continue;
      }
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
      // The bot's unit belongs to tarubot's user manager, which no module call reaches. The one
      // TaruBot unit root's play names is the pull unit's timer (describe "the pull unit").
      if (module === "ansible.builtin.systemd_service") {
        const unit = String(args.name ?? "");
        if (unit.includes("tarubot")) expect(unit, name).toBe("tarubot-host-config.timer");
      }
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

describe("the pull unit", () => {
  /** The root play's tasks, in order, without its pre-tasks or handlers. */
  async function rootTasks(): Promise<Task[]> {
    return (await allTasks()).filter((task) => task.play === 0 && task.list === "tasks");
  }

  /** A path argument with vars/layout.yml's tb_* names filled in, so every spelling compares. */
  async function resolver(): Promise<(path: string) => string> {
    const vars = await layout();
    return (path) =>
      path.replace(/\{\{ (tb_[a-z_]+) \}\}/gu, (whole, name: string) =>
        typeof vars[name] === "string" ? (vars[name] as string) : whole,
      );
  }

  /** Every path a writing task writes, loop items filled in. */
  function writtenPaths(task: Task): string[] {
    const writers = [
      "ansible.builtin.file",
      "ansible.builtin.copy",
      "ansible.builtin.template",
      "ansible.builtin.lineinfile",
      "ansible.builtin.blockinfile",
      "ansible.builtin.replace",
    ];
    if (!writers.includes(task.module)) return [];
    const target = String(task.args.dest ?? task.args.path ?? "");
    // A loop over a variable (the Podman masks) keeps its placeholder; none of those is ours.
    if (!target.includes("{{ item }}") || !Array.isArray(task.task.loop)) return [target];
    return task.task.loop.map((item) => target.replace("{{ item }}", String(item)));
  }

  test("the root play forces its handlers, so a later failure still leaves the reloads run", async () => {
    const [first, last] = await plays();
    expect(first?.force_handlers).toBe(true);
    // The tarubot play has no handlers to force (checked above), and sets nothing of the kind.
    expect(last?.force_handlers).toBeUndefined();
  });

  test("its paths are fixed, and the service runs the script the playbook installs", async () => {
    const vars = await layout();
    expect(vars.tb_pull_dir).toBe("/var/lib/tarubot-config");
    expect(vars.tb_pull_home).toBe(`${String(vars.tb_pull_dir)}/home`);
    expect(vars.tb_pull_state).toBe(`${String(vars.tb_pull_dir)}/state.json`);
    expect(vars.tb_pull_pause).toBe(`${String(vars.tb_pull_dir)}/pause`);
    expect(vars.tb_pull_marker).toBe(`${String(vars.tb_pull_dir)}/last-run.json`);
    expect(vars.tb_pull_script).toBe("/usr/local/sbin/tarubot-host-config");
    // The pull unit builder's service names the same script (interfaces section 15).
    const service = await read(`${ANSIBLE}/files/host-config/tarubot-host-config.service`);
    expect(service.split("\n").filter((line) => line.startsWith("ExecStart="))).toEqual([
      `ExecStart=${String(vars.tb_pull_script)} run`,
    ]);
  });

  test("the script and units are installed root-owned from files/host-config", async () => {
    const tasks = await rootTasks();
    const copies = tasks.filter(
      ({ module, args }) =>
        module === "ansible.builtin.copy" && String(args.src ?? "").startsWith("host-config/"),
    );
    expect(copies.map(({ args }) => [args.src, args.dest])).toEqual([
      ["host-config/tarubot-host-config", "{{ tb_pull_script }}"],
      [
        "host-config/tarubot-host-config.service",
        "/etc/systemd/system/tarubot-host-config.service",
      ],
      ["host-config/tarubot-host-config.timer", "/etc/systemd/system/tarubot-host-config.timer"],
      [
        "host-config/timer-production.conf",
        "/etc/systemd/system/tarubot-host-config.timer.d/10-production.conf",
      ],
    ]);
    const [script, ...units] = copies;
    // bash parses the new copy before it replaces the old one; the default context gives bin_t.
    expect(script?.args).toEqual({
      src: "host-config/tarubot-host-config",
      dest: "{{ tb_pull_script }}",
      owner: "root",
      group: "root",
      mode: "0755",
      validate: "/usr/bin/bash -n %s",
    });
    for (const unit of units) {
      const name = String(unit.task.name);
      expect(unit.args, name).toMatchObject({ owner: "root", group: "root", mode: "0644" });
      expect(unit.task.notify, name).toBe("Reload systemd");
    }
  });

  test("production's ten-minute drop-in exists only on production", async () => {
    const tasks = await rootTasks();
    const dropIn = "/etc/systemd/system/tarubot-host-config.timer.d";
    const touching = tasks.filter((task) =>
      writtenPaths(task).some((path) => path.startsWith(dropIn)),
    );
    expect(touching.map(({ args }) => [args.path ?? args.dest, args.state ?? "file"])).toEqual([
      [dropIn, "directory"],
      [`${dropIn}/10-production.conf`, "file"],
      [`${dropIn}/10-production.conf`, "absent"],
    ]);
    const [directory, copy, removal] = touching;
    expect(directory?.args).toMatchObject({ owner: "root", group: "root", mode: "0755" });
    expect(directory?.task.when).toBe("tb_role == 'production'");
    expect(copy?.task.when).toBe("tb_role == 'production'");
    // Elsewhere the file goes, and systemd reloads without it.
    expect(removal?.task.when).toBe("tb_role != 'production'");
    expect(removal?.task.notify).toBe("Reload systemd");
  });

  test("the timer is enabled only on a bootstrapped host, after the reloads, and nothing else touches the unit", async () => {
    const tasks = await rootTasks();
    const named = (await allTasks()).filter(({ task }) =>
      JSON.stringify(task).includes("tarubot-host-config."),
    );
    // The two unit copies, the drop-in's three tasks and the timer: nothing starts, stops,
    // restarts, kills, disables or masks the service or the timer, and no command names them.
    // A new task that names them must be added here on purpose.
    expect(named.map(({ module }) => module)).toEqual([
      "ansible.builtin.copy",
      "ansible.builtin.copy",
      "ansible.builtin.file",
      "ansible.builtin.copy",
      "ansible.builtin.file",
      "ansible.builtin.systemd_service",
    ]);
    for (const { module, task, args } of named) {
      const name = String(task.name);
      expect(module, name).not.toBe("ansible.builtin.command");
      if (module === "ansible.builtin.file") expect(args.src, name).toBeUndefined();
      if (module === "ansible.builtin.systemd_service") {
        expect(args, name).toEqual({
          name: "tarubot-host-config.timer",
          enabled: true,
          state: "started",
        });
      }
    }
    const timers = named.filter(({ module }) => module === "ansible.builtin.systemd_service");
    expect(timers).toHaveLength(1);
    const timer = timers[0] as Task;
    expect(timer.play).toBe(0);
    expect(timer.list).toBe("tasks");
    // The state bootstrap writes, looked at without following links; before the timer file
    // exists (a check run of the first install) systemd couldn't find the unit.
    expect(whenOf(timer.task)).toBe(
      "tb_pull_state_file.stat.exists and not (ansible_check_mode and tb_pull_timer is changed)",
    );
    const timerCopy = tasks.find(({ args }) =>
      String(args.dest ?? "").endsWith("/tarubot-host-config.timer"),
    );
    expect(timerCopy?.task.register).toBe("tb_pull_timer");
    // After a flush of handlers that follows every unit and drop-in change, so systemd has read
    // them when the timer starts.
    // (Each allTasks() call parses afresh, so the timer is found again in this list by its name.)
    const at = tasks.findIndex(({ task }) => task.name === timer.task.name);
    const flush = tasks.findIndex(
      ({ module, task }) => module === "ansible.builtin.meta" && task[module] === "flush_handlers",
    );
    const lastUnitChange = Math.max(
      ...tasks
        .map((task, index) => ({ task, index }))
        .filter(({ task }) =>
          writtenPaths(task).some((path) =>
            path.startsWith("/etc/systemd/system/tarubot-host-config"),
          ),
        )
        .map(({ index }) => index),
    );
    expect(lastUnitChange).toBeGreaterThan(0);
    expect(flush).toBeGreaterThan(lastUnitChange);
    expect(at).toBeGreaterThan(flush);
  });

  test("the allowed signers come from the host settings only, validated, under deploy.sh's REVIEWER", async () => {
    const vars = await layout();
    expect(vars.tb_allowed_signers).toBe("{{ tarubot_allowed_signers | default([], true) }}");
    expect(vars.tb_signer_principal).toBe("deconfined");
    expect(vars.tb_signer_principal).toBe(await deployConstant("REVIEWER"));
    expect(vars.tb_signer_pattern).toBe(
      "^(ssh-ed25519|sk-ssh-ed25519@openssh\\.com) AAAA[0-9A-Za-z+/]+={0,3}( [^\\r\\n]*)?$",
    );
    // Every line is checked, trimmed, before anything changes.
    const settings = (await allTasks()).find(({ task }) =>
      String(task.name).startsWith("Refuse missing or malformed host settings"),
    );
    expect(settings?.list).toBe("pre_tasks");
    expect(settings?.args.that).toEqual(
      expect.arrayContaining([
        "tb_allowed_signers is sequence and tb_allowed_signers is not string and tb_allowed_signers is not mapping",
        "tb_allowed_signers | reject('string') | list == []",
        "tb_allowed_signers | map('trim') | reject('match', tb_signer_pattern) | list == []",
      ]),
    );
    // The pattern: an Ed25519 key (a FIDO one included) with an optional comment, and nothing
    // else. Python's re.match reads it the same way on a trimmed line.
    const pattern = new RegExp(String(vars.tb_signer_pattern), "u");
    const key = "AAAAC3NzaC1lZDI1NTE5AAAAIExampleOnlyExampleOnlyExampleOnlyExampleOn";
    for (const line of [
      `ssh-ed25519 ${key}`,
      `ssh-ed25519 ${key} signer@workstation`,
      "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tExampleOnly yubikey",
    ])
      expect(pattern.test(line), line).toBe(true);
    for (const line of [
      "",
      `ssh-rsa ${key}`,
      `ecdsa-sha2-nistp256 ${key}`,
      `cert-authority ssh-ed25519 ${key}`,
      `namespaces="git" ssh-ed25519 ${key}`,
      `ssh-ed25519  ${key}`,
      `ssh-ed25519 ${key}\nssh-ed25519 ${key}`,
      `ssh-ed25519 ${key.replace("AAAAC3", "BBBBC3")}`,
    ])
      expect(pattern.test(line), JSON.stringify(line)).toBe(false);
    // Each signer's type and base64, its comment dropped, and the digest of those joined by commas:
    // what the pull unit computes from its own reading of host.yml and passes as
    // tarubot_pull_signers (host-config.test.ts pins the script's side).
    expect(vars.tb_signer_keys).toBe(
      "{{ tb_allowed_signers | map('trim') | map('split') | map('batch', 2) | map('first') | map('join', ' ') | list }}",
    );
    expect(vars.tb_signer_digest).toBe("{{ tb_signer_keys | join(',') | hash('sha256') }}");
    // The template renders exactly those, under the principal; an empty list leaves only the
    // comment header.
    const template = await read(`${ANSIBLE}/templates/allowed_signers.j2`);
    const lines = template.split("\n").filter((line) => line !== "");
    const body = lines.filter((line) => !line.startsWith("#"));
    expect(body).toEqual([
      "{% for key in tb_signer_keys %}",
      '{{ tb_signer_principal }} namespaces="git" {{ key }}',
      "{% endfor %}",
    ]);
    expect(
      [...body.join("\n").matchAll(/\b(tb_[a-z_]+|tarubot_[a-z_]+)\b/gu)].map((m) => m[1]),
    ).toEqual(["tb_signer_keys", "tb_signer_principal"]);
    // The same rendering in JavaScript, for one line with a comment.
    const render = (signer: string) =>
      `${String(vars.tb_signer_principal)} namespaces="git" ${signer.trim().split(/\s+/u).slice(0, 2).join(" ")}`;
    expect(render(` ssh-ed25519 ${key} signer@workstation `)).toBe(
      `deconfined namespaces="git" ssh-ed25519 ${key}`,
    );
    // Written root-owned and world-readable, into the directory the account section creates.
    const tasks = await rootTasks();
    const signers = tasks.findIndex(({ args }) => args.src === "allowed_signers.j2");
    expect(tasks[signers]?.args).toEqual({
      src: "allowed_signers.j2",
      dest: "/etc/tarubot/allowed_signers",
      owner: "root",
      group: "root",
      mode: "0644",
    });
    const etc = tasks.findIndex(
      ({ module, task }) =>
        module === "ansible.builtin.file" &&
        Array.isArray(task.loop) &&
        task.loop.includes("/etc/tarubot"),
    );
    expect(etc).toBeGreaterThan(-1);
    expect(signers).toBeGreaterThan(etc);
  });

  test("the run source is checked before anything changes", async () => {
    const vars = await layout();
    expect(vars.tb_source).toBe("{{ tarubot_source | default('manual') }}");
    expect(vars.tb_commit).toBe("{{ tarubot_commit | default('') }}");
    expect(vars.tb_run).toBe("{{ tarubot_run | default('') }}");
    expect(vars.tb_pull_role).toBe("{{ tarubot_pull_role | default('') }}");
    expect(vars.tb_pull_signers).toBe("{{ tarubot_pull_signers | default('') }}");
    const check = (await allTasks()).find(
      ({ task }) => task.name === "Refuse a malformed run source",
    );
    expect(check?.play).toBe(0);
    expect(check?.list).toBe("pre_tasks");
    expect(check?.task.when).toBeUndefined();
    expect(check?.args.that).toEqual([
      "tb_source in ['manual', 'pull', 'bootstrap', 'emergency']",
      // The pull unit's runs: its commit and run id, holding the lock, on its own host, and the
      // role its plain reading of host.yml found equal to Ansible's.
      "tb_source == 'manual' or tb_commit is match('^[0-9a-f]{40}$')",
      "tb_source == 'manual' or tb_run is match('^[0-9a-f]{16}$')",
      "tb_source == 'manual' or tb_lock_held | bool",
      "tb_source == 'manual' or ansible_connection == 'local'",
      "tb_source == 'manual' or tb_pull_role == tb_role",
      // The signers the script checked signatures against are the ones Ansible reads.
      "tb_source == 'manual' or tb_pull_signers == tb_signer_digest",
      // A hand run names none of them.
      "tb_source != 'manual' or (tb_commit == '' and tb_run == '' and tb_pull_role == '' and tb_pull_signers == '')",
    ]);
  });

  test("pre_tasks only look, so every refusal comes before any change", async () => {
    const [first] = await plays();
    if (!first) throw new Error("site.yml has no plays");
    const pre = tasksOf(first, 0).filter((task) => task.list === "pre_tasks");
    for (const { module, task } of pre)
      expect(["ansible.builtin.assert", "ansible.builtin.stat"], String(task.name)).toContain(
        module,
      );
  });

  test("a real hand run needs the unit paused, and the flags are never links", async () => {
    const [first] = await plays();
    if (!first) throw new Error("site.yml has no plays");
    const pre = tasksOf(first, 0).filter((task) => task.list === "pre_tasks");
    const stat = (path: string) =>
      pre.find(({ module, args }) => module === "ansible.builtin.stat" && args.path === path);
    const state = stat("{{ tb_pull_state }}");
    const pause = stat("{{ tb_pull_pause }}");
    expect(state?.args.follow).toBe(false);
    expect(pause?.args.follow).toBe(false);
    expect(state?.task.register).toBe("tb_pull_state_file");
    expect(pause?.task.register).toBe("tb_pull_pause_file");
    const links = pre.find(({ task }) => JSON.stringify(task).includes("stat.islnk"));
    expect(links?.args.that).toEqual([
      "not tb_pull_state_file.stat.exists or (tb_pull_state_file.stat.isreg and not tb_pull_state_file.stat.islnk)",
      "not tb_pull_pause_file.stat.exists or (tb_pull_pause_file.stat.isreg and not tb_pull_pause_file.stat.islnk)",
    ]);
    const guard = pre.find(
      ({ task }) => task.name === "Refuse a hand run while the pull unit is active",
    );
    // Manual runs only (the pull unit's own runs and its emergency apply go ahead while paused),
    // with the start's hand run among them; a check run changes nothing, so it isn't refused.
    expect(guard?.args.that).toEqual([
      "not (tb_source == 'manual' and tb_pull_state_file.stat.exists and not tb_pull_pause_file.stat.exists)",
    ]);
    expect(guard?.task.when).toBe("not ansible_check_mode");
    expect(guard?.task.tags).toBeUndefined();
    expect(String(guard?.args.fail_msg)).toContain("tarubot-host-config pause REASON");
    expect(String(guard?.args.fail_msg)).toContain("tarubot-host-config resume");
    // Both stats and the refusal come before the guard reads them.
    for (const task of [state, pause, links])
      expect(pre.indexOf(task as Task)).toBeLessThan(pre.indexOf(guard as Task));
  });

  test("the run marker is the first change after the lock checks, and the script's own files stay the script's", async () => {
    const tasks = await rootTasks();
    const refuse = tasks.findIndex(({ task }) => task.register === "tb_lock_probe") + 1;
    expect(tasks[refuse]?.args.that).toEqual(["tb_lock_probe.rc == 75"]);
    const [directories, marker] = tasks.slice(refuse + 1);
    expect(directories?.args).toEqual({
      path: "{{ item }}",
      state: "directory",
      owner: "root",
      group: "root",
      mode: "0700",
    });
    expect(directories?.task.loop).toEqual(["{{ tb_pull_dir }}", "{{ tb_pull_home }}"]);
    expect(marker?.module).toBe("ansible.builtin.copy");
    expect(marker?.args).toEqual({
      content: "{{ {'source': tb_source, 'commit': tb_commit, 'run': tb_run} | to_json }}\n",
      dest: "{{ tb_pull_marker }}",
      owner: "root",
      group: "root",
      mode: "0600",
    });
    // A check run writes nothing, so it shows no marker either. A new run id every pull run
    // would otherwise count as a change, and a pull run with nothing to do must report changed=0.
    expect(marker?.task.when).toBe("not ansible_check_mode");
    expect(marker?.task.changed_when).toBe(false);
    // Under /var/lib/tarubot-config the playbook writes those three paths and nothing else: the
    // clone, home/tmp, state.json and the pause and now flags are the script's alone.
    const resolve = await resolver();
    const vars = await layout();
    const dir = String(vars.tb_pull_dir);
    const written = (await allTasks()).flatMap((task) =>
      writtenPaths(task)
        .map(resolve)
        .filter((path) => path === dir || path.startsWith(`${dir}/`))
        .map((path) => [String(task.task.name), path]),
    );
    expect(written).toEqual([
      ["Create the pull unit's directory and its HOME", dir],
      ["Create the pull unit's directory and its HOME", `${dir}/home`],
      ["Write the run marker", `${dir}/last-run.json`],
    ]);
    // And no command names them (the stats and asserts only read).
    for (const { module, args, task } of await allTasks())
      if (module === "ansible.builtin.command")
        expect(JSON.stringify(args), String(task.name)).not.toMatch(/tarubot-config|tb_pull_/u);
  });

  test("the settings files the pull unit reads must be root's alone", async () => {
    const tasks = await rootTasks();
    const look = tasks.find(
      ({ module, task }) =>
        module === "ansible.builtin.stat" &&
        Array.isArray(task.loop) &&
        task.loop.includes("/etc/tarubot/host.yml"),
    );
    expect(look?.task.loop).toEqual(["/etc/tarubot/host.yml", "/etc/tarubot/host-config.env"]);
    expect(look?.args.follow).toBe(false);
    const refuse = tasks[tasks.indexOf(look as Task) + 1];
    expect(refuse?.module).toBe("ansible.builtin.assert");
    expect(refuse?.task.loop).toBe(`{{ ${String(look?.task.register)}.results }}`);
    expect(refuse?.task.when).toBe("item.stat.exists");
    expect(refuse?.args.that).toEqual([
      "item.stat.isreg and not item.stat.islnk",
      "item.stat.uid == 0 and item.stat.mode == '0600'",
    ]);
  });

  test("ansible-core comes from AppStream at the floor, and no dnf call runs when nothing is missing", async () => {
    const vars = await layout();
    // AlmaLinux's build with the CVE-2026-11332 backport, the one requirements.txt names.
    expect(vars.tb_ansible_core_floor).toBe("1:2.16.16-2.el10_2.1");
    expect(vars.tb_ansible_core).toBe("ansible-core >= {{ tb_ansible_core_floor }}");
    expect(await read(`${ANSIBLE}/requirements.txt`)).toContain("2.16.16-2.el10_2.1");
    expect(vars.tb_packages).toContain("git");
    expect(vars.tb_production_update_excludes).toContain("ansible-core");
    const tasks = await rootTasks();
    const facts = tasks.findIndex(({ module }) => module === "ansible.builtin.package_facts");
    const dnf = tasks.filter(({ module }) => module === "ansible.builtin.dnf");
    expect(dnf.map(({ args }) => args.name)).toEqual([
      "{{ tb_packages }}",
      "{{ tb_ansible_core }}",
      "{{ tb_epel_packages }}",
    ]);
    // Every one after the installed packages were read, only when they show something to do
    // (ansible-core 2.16's dnf module loads the repositories on every call), from the
    // repositories already enabled.
    for (const entry of dnf) {
      const { task, args } = entry;
      const name = String(task.name);
      expect(tasks.indexOf(entry), name).toBeGreaterThan(facts);
      expect(whenOf(task), name).toContain("ansible_facts.packages");
      expect(args, name).toMatchObject({ state: "present", lock_timeout: 300 });
      for (const key of ["enablerepo", "disablerepo", "disable_gpg_check", "update_only"])
        expect(args[key], name).toBeUndefined();
    }
    const [host, core, epel] = dnf;
    expect(host?.task.when).toBe(
      "tb_packages | reject('in', ansible_facts.packages) | list | length > 0",
    );
    expect(core?.task.when).toBe(
      "'ansible-core' not in ansible_facts.packages or tb_ansible_core_check.stdout | trim in ['low', 'missing']",
    );
    expect(epel?.task.when).toEqual([
      "tb_epel_packages | reject('in', ansible_facts.packages) | list | length > 0",
      "not (ansible_check_mode and tb_epel_repo is changed)",
    ]);
    // The comparison: RPM's own ordering, reading the database only, before the install.
    const compare = tasks.find(({ task }) => task.register === "tb_ansible_core_check");
    expect(compare?.task).toMatchObject({ changed_when: false, check_mode: false });
    expect(compare?.task.when).toBe("'ansible-core' in ansible_facts.packages");
    expect(compare?.task.failed_when).toBe(
      "tb_ansible_core_check.rc != 0 or tb_ansible_core_check.stdout | trim not in ['ok', 'low', 'missing']",
    );
    const words = argvWords(compare?.args ?? {});
    expect(words.slice(0, 3)).toEqual(["/usr/bin/python3", "-I", "-c"]);
    expect(words.slice(4)).toEqual(["{{ tb_ansible_core_floor }}"]);
    expect(words[3]).toContain('rpm.TransactionSet().dbMatch("name", "ansible-core")');
    expect(words[3]).toContain("rpm.labelCompare(evr, floor) < 0");
    expect(tasks.indexOf(compare as Task)).toBeLessThan(tasks.indexOf(core as Task));
    // Production's dnf-automatic leaves ansible-core to the floor.
    expect(await read(`${ANSIBLE}/templates/dnf-automatic.conf.j2`)).toContain(
      "excludepkgs = {{ tb_production_update_excludes | join(' ') }}",
    );
  });

  test("host.example.yml holds exactly the settings, the signers included, and names the run variables as not settings", async () => {
    const example = mapping(
      YAML.parse(await read(`${ANSIBLE}/host.example.yml`)),
      "host.example.yml",
    );
    // The settings layout.yml reads, less the variables of a single run. host-config.test.ts
    // keeps these keys equal to the pull unit's SETTINGS_KEYS, so a new host setting reaches the
    // installed script's allowlist in the release that first reads it; that release gives it a
    // default, and only a later one may require it (docs/HOSTING.md "Files and settings on a host").
    const runOnly = [
      "tarubot_start_version",
      "tarubot_start_digest",
      "tarubot_host_lock_held",
      "tarubot_source",
      "tarubot_commit",
      "tarubot_run",
      "tarubot_pull_role",
      "tarubot_pull_signers",
    ];
    const read_ = [
      ...(await read(`${ANSIBLE}/vars/layout.yml`)).matchAll(/\{\{ (tarubot_[a-z_]+) /gu),
    ]
      .map((m) => m[1] ?? "")
      .filter((name) => !runOnly.includes(name));
    expect(Object.keys(example).sort()).toEqual([...new Set(read_)].sort());
    expect(example.tarubot_allowed_signers).toEqual([]);
    const text = await read(`${ANSIBLE}/host.example.yml`);
    for (const name of runOnly) expect(text, name).toMatch(new RegExp(`^#.* -e ${name}=`, "mu"));
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
