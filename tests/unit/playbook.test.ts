/**
 * TaruBot's host configuration (#62, ops/ansible/site.yml; docs/HOSTING.md "Configure"). The Deploy
 * workflow's Configure step runs site.yml from main's head, as root over SSH from a GitHub runner,
 * so a merged change reaches staging's root without another step. CI's syntax check and
 * ansible-lint see its form; these pin what they can't:
 * - nothing is left of the pull unit, the host lock, the start tag or Ansible on the hosts;
 * - one play as root, with no become, that waits for cloud-init first, reads no lookup, secret or
 *   diff, and waits for dnf's lock on every dnf task;
 * - a new host (no tarubot account yet) is upgraded and rebooted once, and never again;
 * - sshd allows keys only, root only, a verified FIDO key and one host key, and sshd -T checks each;
 * - root's console password stays on the console: su needs wheel, and the polkit rule, run here
 *   against stub subjects, refuses everyone but root;
 * - dnf-automatic applies every update and reboots when needed, prod after staging (the role is
 *   staging or prod since 2.37.0, and prod's timer drop-in has the prod name);
 * - the tarubot account, and root's keys and password left to cloud-init;
 * - ansible.cfg, the hash-pinned requirements, the examples, and ShellCheck over ops/.
 * Static only: nothing here runs Ansible, since unit tests also run in the image build.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { YAML } from "bun";

/** A path in the repository, and a repository file's text. */
const root = (path: string) => new URL(`../../${path}`, import.meta.url).pathname;
const read = (path: string) => Bun.file(root(path)).text();
const ANSIBLE = "ops/ansible";
/** A list written as words separated by spaces or line breaks. */
const words = (text: string) => text.trim().split(/\s+/u);

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);
async function mappingAt(path: string): Promise<Mapping> {
  const parsed: unknown = YAML.parse(await read(path));
  if (!isMapping(parsed)) throw new Error(`${path} is not a mapping`);
  return parsed;
}

/** Every file under a directory (relative to the repository), skipping Tofu's working files. */
function filesUnder(directory: string): string[] {
  return readdirSync(root(directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    const stat = lstatSync(root(path));
    if (stat.isDirectory()) return name === ".terraform" ? [] : filesUnder(path);
    return stat.isFile() ? [path] : [];
  });
}

/** One task or handler of site.yml: its one module and that module's arguments. */
interface Task {
  list: "tasks" | "handlers";
  task: Mapping;
  module: string;
  args: Mapping;
}
/** Keywords a task may carry besides its module (every one site.yml could plausibly use). */
const KEYWORDS = new Set(
  words(`name when register loop loop_control changed_when failed_when check_mode notify listen
    tags become become_user environment no_log diff delegate_to vars`),
);

/** site.yml's plays. */
async function plays(): Promise<Mapping[]> {
  const parsed: unknown = YAML.parse(await read(`${ANSIBLE}/site.yml`));
  if (!Array.isArray(parsed) || !parsed.every(isMapping)) throw new Error("site.yml: not plays");
  return parsed;
}
/** Every task, then every handler, of site.yml's one play, blocks flattened. */
async function tasks(): Promise<Task[]> {
  const [play] = await plays();
  const found: Task[] = [];
  const visit = (items: unknown, list: Task["list"]) => {
    for (const task of Array.isArray(items) ? items : []) {
      if (!isMapping(task)) throw new Error(`site.yml: a ${list} entry is not a mapping`);
      if ("block" in task) {
        for (const key of ["block", "rescue", "always"]) visit(task[key], list);
        continue;
      }
      const modules = Object.keys(task).filter((key) => !KEYWORDS.has(key));
      const module = modules[0];
      if (modules.length !== 1 || module === undefined)
        throw new Error(`task ${String(task.name)}: modules ${modules.join(", ") || "none"}`);
      found.push({ list, task, module, args: isMapping(task[module]) ? task[module] : {} });
    }
  };
  visit(play?.tasks, "tasks");
  visit(play?.handlers, "handlers");
  return found;
}
function named(all: Task[], name: string): Task {
  const found = all.find((t) => t.task.name === name);
  if (!found) throw new Error(`site.yml has no task named ${name}`);
  return found;
}
const byModule = (all: Task[], module: string) =>
  all.filter((t) => t.module === `ansible.builtin.${module}`);

/** The sshd drop-in's directives: keyword (lowercase) and value, in order. */
async function sshdDirectives(): Promise<[string, string][]> {
  return (await read(`${ANSIBLE}/files/sshd-00-tarubot.conf`))
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => {
      const [keyword = "", ...value] = words(line);
      return [keyword.toLowerCase(), value.join(" ")];
    });
}

test("nothing is left of the pull unit, the host lock, the start tag or Ansible on the hosts", async () => {
  const gone = words(`files/host-config files/tmpfiles-tarubot.conf files/cloud-init-tarubot.cfg
    files/skel files/RPM-GPG-KEY-EPEL-10 files/tarubot-epel.repo templates/allowed_signers.j2
    templates/authorized_keys-tarubot.j2`).map((path) => `${ANSIBLE}/${path}`);
  for (const path of [...gone, "tests/unit/host-config.test.ts", "tests/fixtures/host-config"])
    expect(existsSync(root(path)), path).toBe(false);
  for (const file of ["site.yml", "vars/layout.yml"]) {
    const text = await read(`${ANSIBLE}/${file}`);
    for (const remnant of words(`tags: tarubot_host_lock_held host.lock tb_locked allowed_signers
      tarubot-host-config ansible-core tarubot_start_`))
      expect(text, `${file}: ${remnant}`).not.toContain(remnant);
  }
});

describe("site.yml", () => {
  test("is one play as root, with no become, that waits for cloud-init first", async () => {
    const all = await plays();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ hosts: "all", become: false, gather_facts: false });
    const list = await tasks();
    for (const { task } of list)
      expect([task.become, task.become_user], String(task.name)).toEqual([undefined, undefined]);
    // 2 is cloud-init's "degraded": done, with a recoverable error.
    expect(list[0]?.args.argv).toEqual(["cloud-init", "status", "--wait"]);
    expect(list[0]?.task).toMatchObject({
      failed_when: "tb_cloud_init.rc not in [0, 2]",
      changed_when: false,
    });
  });

  test("reads no lookup, secret or environment, prints no diff, and waits for dnf's lock", async () => {
    const text = await read(`${ANSIBLE}/site.yml`);
    for (const word of ["lookup(", "query(", "--diff", "no_log"]) expect(text).not.toContain(word);
    const list = await tasks();
    for (const { task, module } of list) {
      expect(module, String(task.name)).toStartWith("ansible.builtin.");
      expect([task.environment, task.diff], String(task.name)).toEqual([undefined, undefined]);
    }
    const dnf = byModule(list, "dnf");
    expect(dnf.length).toBeGreaterThanOrEqual(4);
    for (const { args, task } of dnf) expect(args.lock_timeout, String(task.name)).toBe(300);
  });

  test("upgrades and reboots a new host once, keyed on the missing tarubot account", async () => {
    const list = await tasks();
    const [getent] = byModule(list, "getent");
    expect(getent?.args).toEqual({ database: "passwd", key: "{{ tb_user }}", fail_key: false });
    const [first] = byModule(list, "set_fact");
    expect(first?.args).toEqual({
      tb_first_configure: "{{ ansible_facts.getent_passwd[tb_user] is none }}",
    });
    const upgrades = byModule(list, "dnf").filter((t) => t.args.state === "latest");
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.args).toMatchObject({ name: "*", update_only: true });
    const [reboot] = byModule(list, "reboot");
    for (const t of [upgrades[0], reboot]) expect(t?.task.when).toBe("tb_first_configure");
    // The account that marks a configured host is created after the reboot, near the end.
    const order = [getent, first, upgrades[0], reboot, byModule(list, "user")[0]];
    const at = order.map((t) => list.indexOf(t as Task));
    expect(at[0]).toBeGreaterThan(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  test("installs what the host and bot.yml need, and nothing the pull unit needed", async () => {
    const layout = await mappingAt(`${ANSIBLE}/vars/layout.yml`);
    expect(layout.tb_packages).toEqual(
      words(`podman crun passt container-selinux acl chrony dnf-automatic dnf-plugins-core polkit
        python3-libselinux sudo`),
    );
    expect(layout.tb_epel_packages).toEqual(["age"]);
    // The one setting, read once; nothing else comes from outside.
    const settings = (await read(`${ANSIBLE}/vars/layout.yml`)).matchAll(/tarubot_[a-z_]+/gu);
    expect([...new Set([...settings].map((m) => m[0]))]).toEqual(["tarubot_role"]);
    expect(layout.tb_role).toBe("{{ tarubot_role | default('') }}");
  });

  test("the role is staging or prod (2.37.0), checked before anything changes", async () => {
    const list = await tasks();
    const check = named(
      list,
      "Refuse anything but root on AlmaLinux 10 with SELinux enforcing, or an unknown role",
    );
    expect(check.module).toBe("ansible.builtin.assert");
    const that = check.args.that as unknown[];
    expect(that.filter((item) => String(item).includes("tb_role"))).toEqual([
      "tb_role in ['staging', 'prod']",
    ]);
    expect(String(check.args.fail_msg)).toContain("tarubot_role must be staging or prod.");
    // It runs before the account lookup, and so before every task that changes the host.
    expect(list.indexOf(check)).toBeLessThan(list.indexOf(byModule(list, "getent")[0] as Task));
    // The hand-run example names a role site.yml accepts.
    const example = await mappingAt(`${ANSIBLE}/host.example.yml`);
    expect(["staging", "prod"]).toContain(String(example.tarubot_role));
  });
});

describe("sshd", () => {
  test("the drop-in allows keys only, root only, a verified FIDO key and one host key", async () => {
    expect(Object.fromEntries(await sshdDirectives())).toEqual({
      passwordauthentication: "no",
      kbdinteractiveauthentication: "no",
      gssapiauthentication: "no",
      permitrootlogin: "prohibit-password",
      allowusers: "root",
      pubkeyauthoptions: "verify-required",
      x11forwarding: "no",
      disableforwarding: "yes",
      permituserrc: "no",
      hostkey: "/etc/ssh/ssh_host_ed25519_key",
    });
    const [install] = byModule(await tasks(), "copy").filter((t) =>
      String(t.args.dest).startsWith("/etc/ssh/"),
    );
    expect(install?.args).toMatchObject({
      src: "sshd-00-tarubot.conf",
      dest: "/etc/ssh/sshd_config.d/00-tarubot.conf",
      mode: "0600",
      validate: "/usr/sbin/sshd -t -f %s",
    });
    expect(install?.task.notify).toBe("Reload sshd");
  });

  test("sshd -T checks every directive, and the reload checks the whole configuration first", async () => {
    const list = await tasks();
    expect(named(list, "Read sshd's effective settings for root").args.argv).toEqual([
      "/usr/sbin/sshd",
      "-T",
      "-C",
      "user=root,host=localhost,addr=127.0.0.1",
    ]);
    const checks = JSON.stringify(
      named(list, "Refuse sshd settings other than the drop-in's").args,
    );
    for (const [keyword, value] of await sshdDirectives()) {
      // sshd -T prints prohibit-password under its older name.
      const shown = keyword === "permitrootlogin" ? "without-password" : value;
      expect(checks, keyword).toContain(`${keyword} ${shown}`);
    }
    const reload = list.filter((t) => t.list === "handlers" && t.task.listen === "Reload sshd");
    expect(reload.map((t) => t.args.argv ?? t.args.state)).toEqual([
      ["/usr/sbin/sshd", "-t"],
      "reloaded",
    ]);
  });
});

describe("root's console password stays on the console", () => {
  test("su needs the wheel group", async () => {
    const [su] = byModule(await tasks(), "lineinfile");
    expect(su?.args.path).toBe("/etc/pam.d/su");
    const line = String(su?.args.line);
    expect(line).toMatch(/^auth\s+required\s+pam_wheel\.so use_uid$/u);
    // EL10's own su file: its commented line is replaced in place, and the "trust" line left alone.
    const regexp = new RegExp(String(su?.args.regexp));
    expect(regexp.test("#auth\t\trequired\tpam_wheel.so use_uid")).toBe(true);
    expect(regexp.test(line)).toBe(true);
    expect(regexp.test("#auth\t\tsufficient\tpam_wheel.so trust use_uid")).toBe(false);
    const after = new RegExp(String(su?.args.insertafter));
    expect(after.test("auth\t\tsufficient\tpam_rootok.so")).toBe(true);
  });

  test("the polkit rule refuses every subject but root, at once", async () => {
    const source = await read(`${ANSIBLE}/files/polkit-10-tarubot.rules`);
    // EL10's polkit runs rules in Duktape, an ES5 engine: no later syntax in the code.
    const code = source.replace(/^\s*\/\/.*$/gmu, "");
    for (const later of ["=>", "let ", "const ", "`"]) expect(code).not.toContain(later);
    type Rule = (action: unknown, subject: { user: string }) => unknown;
    const rules: Rule[] = [];
    const polkit = { Result: { NO: "no", YES: "yes" }, addRule: (rule: Rule) => rules.push(rule) };
    runInNewContext(source, { polkit });
    expect(rules).toHaveLength(1);
    const [rule] = rules as [Rule];
    const action = { id: "org.freedesktop.policykit.exec" };
    // Root falls through to polkit's defaults; tarubot, a subordinate UID and anyone else get "no".
    expect(rule(action, { user: "root" })).toBeUndefined();
    for (const user of ["tarubot", "100000", "almalinux", ""])
      expect(rule(action, { user }), user).toBe("no");
    expect(named(await tasks(), "Refuse every polkit request from anyone but root").args).toEqual({
      src: "polkit-10-tarubot.rules",
      dest: "/etc/polkit-1/rules.d/10-tarubot.rules",
      owner: "root",
      group: "root",
      mode: "0644",
    });
  });

  test("no task writes root's keys or password: cloud-init owns them", async () => {
    for (const { task, args } of await tasks()) {
      for (const key of ["path", "dest"])
        expect(String(args[key] ?? ""), String(task.name)).not.toStartWith("/root/");
      expect([args.password, args.name === "root"], String(task.name)).toEqual([undefined, false]);
    }
    const text = await read(`${ANSIBLE}/site.yml`);
    for (const word of ["authorized_keys", "chpasswd", "/etc/shadow"])
      expect(text).not.toContain(word);
  });
});

describe("updates", () => {
  test("dnf-automatic applies every update and reboots when needed, on both roles alike", async () => {
    const conf = await read(`${ANSIBLE}/templates/dnf-automatic.conf.j2`);
    for (const line of ["upgrade_type = default", "apply_updates = yes", "reboot = when-needed"])
      expect(conf).toMatch(new RegExp(`^${line}$`, "mu"));
    expect(conf.match(/^reboot = /gmu)).toHaveLength(1);
    for (const word of ["excludepkgs", "{%"]) expect(conf).not.toContain(word);
  });

  test("prod's timer runs after staging's whole window, and staging has no drop-in", async () => {
    // Renamed for prod in 2.37.0: the production-named file is gone.
    expect(existsSync(root(`${ANSIBLE}/files/dnf-automatic-timer-production.conf`))).toBe(false);
    const dropIn = await read(`${ANSIBLE}/files/dnf-automatic-timer-prod.conf`);
    const calendars = [...dropIn.matchAll(/^OnCalendar=(.*)$/gmu)].map((m) => m[1]);
    // The first, empty, clears the unit's own 06:00; staging keeps that, plus up to an hour
    // (RandomizedDelaySec=60m), so prod starts at 07:00 or later.
    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toBe("");
    const time = /^\*-\*-\* (\d{2}):(\d{2}):\d{2} UTC$/u.exec(calendars[1] ?? "");
    expect(Number(time?.[1]) * 60 + Number(time?.[2])).toBeGreaterThanOrEqual(7 * 60);
    const layout = await mappingAt(`${ANSIBLE}/vars/layout.yml`);
    expect(layout.tb_prod_timer).toBe("/etc/systemd/system/dnf-automatic.timer.d/50-tarubot.conf");
    expect(layout).not.toHaveProperty("tb_production_timer");
    const list = await tasks();
    const directory = named(list, "Create the dnf-automatic timer's drop-in directory (prod)");
    const install = named(list, "Run prod's updates at 10:00 UTC, after staging's");
    const remove = named(list, "Keep staging on the timer's own schedule (06:00 UTC)");
    expect([directory.args.path, directory.task.when]).toEqual([
      "{{ tb_prod_timer | dirname }}",
      "tb_role == 'prod'",
    ]);
    expect([install.args.src, install.args.dest, install.task.when]).toEqual([
      "dnf-automatic-timer-prod.conf",
      "{{ tb_prod_timer }}",
      "tb_role == 'prod'",
    ]);
    expect([remove.args.path, remove.args.state, remove.task.when]).toEqual([
      "{{ tb_prod_timer }}",
      "absent",
      "tb_role == 'staging'",
    ]);
    // Only the two roles, and nothing in site.yml or its layout still says production.
    for (const file of ["site.yml", "vars/layout.yml"])
      expect(await read(`${ANSIBLE}/${file}`), file).not.toMatch(/production/u);
    for (const t of [install, remove])
      expect(t.task.notify).toEqual(["Reload systemd", "Restart the dnf-automatic timer"]);
    // Handlers run in the order they are defined: systemd reads the drop-in before the restart.
    const handlers = list.filter((t) => t.list === "handlers").map((t) => t.task.name);
    expect(handlers.indexOf("Reload systemd")).toBeLessThan(
      handlers.indexOf("Restart the dnf-automatic timer"),
    );
  });
});

test("the tarubot account has umask 0022, no groups, a locked password and lingering", async () => {
  const layout = await mappingAt(`${ANSIBLE}/vars/layout.yml`);
  expect([layout.tb_user, layout.tb_home]).toEqual(["tarubot", "/home/tarubot"]);
  const list = await tasks();
  expect(byModule(list, "user")[0]?.args).toMatchObject({
    name: "{{ tb_user }}",
    comment: "TaruBot,umask=0022",
    home: "{{ tb_home }}",
    shell: "/bin/bash",
    groups: [],
    append: false,
    password_lock: true,
  });
  const linger = byModule(list, "command").find((t) => t.task.name?.toString().includes("login"));
  expect(linger?.args).toEqual({
    argv: ["loginctl", "enable-linger", "{{ tb_user }}"],
    creates: "/var/lib/systemd/linger/{{ tb_user }}",
  });
});

describe("the controller", () => {
  test("ansible.cfg checks host keys, pipelines, and keeps module arguments off the host", async () => {
    const cfg = await read(`${ANSIBLE}/ansible.cfg`);
    const section = (name: string) => (cfg.split(`[${name}]`)[1] ?? "").split(/^\[/mu)[0] ?? "";
    for (const [name, setting] of [
      ["defaults", "host_key_checking = True"],
      ["defaults", "no_target_syslog = True"],
      ["defaults", "inject_facts_as_vars = False"],
      ["defaults", "collections_path = /dev/null"],
      ["connection", "pipelining = True"],
      ["ssh_connection", "retries = 3"],
    ] as const)
      expect(section(name), setting).toMatch(new RegExp(`^${setting}$`, "mu"));
  });

  test("every requirement is hash-pinned, and the runner's pins equal CI's", async () => {
    const pins = async (file: string) => {
      const lines = (await read(`${ANSIBLE}/${file}`))
        .split("\n")
        .filter((l) => /^[a-z ]/u.test(l));
      const found = new Map<string, string>();
      for (const [index, line] of lines.entries()) {
        if (line.startsWith(" ")) {
          expect(line, file).toMatch(/^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/u);
          continue;
        }
        const pin = /^([a-z0-9._-]+)==([0-9][0-9a-z.]*) \\$/u.exec(line);
        expect(pin, `${file}: ${line}`).not.toBeNull();
        expect(lines[index + 1], `${file}: ${line}`).toStartWith("    --hash=sha256:");
        found.set(pin?.[1] ?? "", pin?.[2] ?? "");
      }
      return found;
    };
    const [runner, lint] = [await pins("requirements.txt"), await pins("requirements-lint.txt")];
    expect(runner.get("ansible-core")).toMatch(/^2\.\d+\.\d+$/u);
    for (const name of ["ansible-lint", "ansible-compat"]) expect(lint.has(name), name).toBe(true);
    // ansible-core, and everything it pulls in, is the same version in both files.
    for (const [name, version] of runner) expect(lint.get(name), name).toBe(version);
  });

  test("the examples reach one host, target, as root, and name only example.org", async () => {
    const hosts = ((await mappingAt(`${ANSIBLE}/inventory.example.yml`)).all as Mapping).hosts;
    expect(Object.keys(hosts as Mapping)).toEqual(["target"]);
    const target = (hosts as Mapping).target as Mapping;
    expect([target.ansible_host, target.ansible_user]).toEqual(["staging.example.org", "root"]);
    const options = words(String(target.ansible_ssh_common_args));
    for (const option of words(`IdentitiesOnly=yes StrictHostKeyChecking=yes HostKeyAlias=target
      AddressFamily=any`))
      expect(options).toContain(option);
    expect(await mappingAt(`${ANSIBLE}/host.example.yml`)).toEqual({ tarubot_role: "staging" });
    for (const file of ["inventory.example.yml", "host.example.yml"]) {
      const text = await read(`${ANSIBLE}/${file}`);
      for (const [name] of text.matchAll(/[a-z0-9-]+(\.[a-z0-9-]+)*\.(org|com|net|io|dev|app)\b/gu))
        expect(name, file).toMatch(/(^|\.)example\.org$/u);
      expect(text, file).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/u);
    }
  });
});

test("ShellCheck in CI covers every script under ops/", async () => {
  // Every file that starts with #! must be named, or matched by a glob, in a ShellCheck line.
  const ci = await read(".github/workflows/ci.yml");
  const covered = new Set<string>();
  for (const [, line] of ci.matchAll(/shellcheck -S warning ([^\n]+)/gu))
    for (const word of words(line ?? "").filter((part) => part.startsWith("ops/")))
      for (const path of new Bun.Glob(word).scanSync({ cwd: root(""), dot: true }))
        covered.add(path);
  const scripts: string[] = [];
  for (const path of filesUnder("ops"))
    if ((await Bun.file(root(path)).slice(0, 2).text()) === "#!") scripts.push(path);
  expect(scripts).toContain(`${ANSIBLE}/files/tarubot-ipv6-online`);
  for (const script of scripts) expect([...covered], script).toContain(script);
});
