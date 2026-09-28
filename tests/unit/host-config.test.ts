/**
 * tarubot-host-config, the pull unit (2.34.0, #50; REQUIREMENTS.md "Approved staging amendments
 * (2026-09-26)", questions 14 to 18). Root runs it on the staging and production hosts to apply
 * ops/ansible/ from its own clone of main, so the rules that keep anything tarubot can write away
 * from root are pinned here rather than left to comments:
 *
 * - Static checks pin the script's constants to ops/deploy.sh's and deploy.yml's (the same runs,
 *   reviewer, workflow, version form and host lock), the production URLs and main's host paths,
 *   the shell's shape (strict mode, a fixed PATH, no eval or source, every git, jq and curl call
 *   inside its hardened wrapper, the lock descriptors closed for every command, the only deletes),
 *   the playbook call (umask 022, --skip-tags start, the held-lock flag, the pull role, never a
 *   start variable), the service and timer units, and host.example.yml's plain form.
 * - The scenarios run the real script, sourced by tests/fixtures/host-config/run.sh with sandbox
 *   paths, against a throwaway git remote whose merges are signed with a throwaway ed25519 key that
 *   ssh-keygen makes here, with real git, jq, ssh-keygen and flock and simulated curl (GitHub's API
 *   and the health-check pings), ansible-playbook and systemctl (tests/fixtures/host-config/stubs)
 *   and a fake clock. Each run ends with exactly one result line and the exit status of the spec's
 *   table: staging's head, production's approved Deploy runs, question 14's signature rule, host
 *   settings first, runtime-only commits, the re-apply reasons, the host lock, failures and the
 *   hourly retry, pause and resume, apply-now, the emergency apply, bootstrap, and the host's own
 *   files.
 *
 * Scenarios need git, jq, ssh-keygen and flock; the image build (oven/bun, which has no git or jq)
 * skips them, and CI's checks job and the dev VM run them.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SELF_PATH = "ops/ansible/files/host-config/tarubot-host-config";
const SCRIPT = root(SELF_PATH);
const UNITS = root("ops/ansible/files/host-config");
const FIXTURES = root("tests/fixtures/host-config");
const DRIVER = join(FIXTURES, "run.sh");
const TEXT = readFileSync(SCRIPT, "utf8");
const LINES = TEXT.split("\n");
const hasBash = Bun.which("bash") !== null;
const hasTools = ["bash", "git", "jq", "ssh-keygen", "flock"].every(
  (tool) => Bun.which(tool) !== null,
);
const isRoot = process.getuid?.() === 0;
// Every scenario starts processes; the arm64 image build runs under QEMU. Two minutes only stops
// a hang.
setDefaultTimeout(120_000);

/** The result line of interfaces section 4 (groups: outcome, commit, version, changed, reason). */
const RESULT =
  /^result outcome=(applied|recorded|current|waiting|paused|failed|needs-you) commit=([0-9a-f]{12}|-) version=((?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})|-) changed=([0-9]{1,5}|-) reason=([a-z0-9-]{1,40}|-)$/u;

/** A top-level function's body, from its `name() {` line to the closing `}`. */
function body(name: string): string {
  const start = LINES.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`no function ${name}`);
  return LINES.slice(start + 1, LINES.indexOf("}", start)).join("\n");
}

/** A body's commands: continuation lines joined, blank and comment lines dropped, trimmed. */
const commands = (text: string) =>
  text
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/** Every top-level function's commands, by name. */
const FUNCTIONS = new Map<string, string[]>();
for (const [index, line] of LINES.entries()) {
  const name = /^([a-z_]+)\(\) \{$/u.exec(line)?.[1];
  if (name)
    FUNCTIONS.set(name, commands(LINES.slice(index + 1, LINES.indexOf("}", index)).join("\n")));
}

/** A readonly constant's value, without its quotes. */
function constant(text: string, name: string): string {
  const match = new RegExp(`^readonly ${name}=(.*)$`, "mu").exec(text);
  if (!match?.[1]) throw new Error(`no constant ${name}`);
  return match[1].replace(/^'(.*)'$/u, "$1").replace(/^"(.*)"$/u, "$1");
}

/** Text as a literal inside a regular expression: every syntax character escaped, backslash too. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A command word appears in a line, at the start or after a separator, followed by a space. */
const calls = (line: string, tool: string) =>
  new RegExp(`(^|[\\s;|&(])${literal(tool)}\\s`, "u").test(line);

// ---------------------------------------------------------------------------------------------
// Static properties
// ---------------------------------------------------------------------------------------------

describe("the script's constants", () => {
  const deploy = readFileSync(root("ops/deploy.sh"), "utf8");

  test("equal ops/deploy.sh's: the repository, the reviewer, the workflow, versions and the lock", () => {
    for (const name of ["REPO", "REVIEWER", "REVIEWER_ID", "WORKFLOW", "VERSION"])
      expect({ name, value: constant(TEXT, name) }).toEqual({
        name,
        value: constant(deploy, name),
      });
    expect(constant(TEXT, "HOST_LOCK")).toBe(constant(deploy, "QUADLET_LOCK"));
    expect(constant(TEXT, "HOST_LOCK")).toBe("/run/tarubot/host.lock");
    expect(constant(TEXT, "REVIEWER")).toBe("deconfined");
    expect(constant(TEXT, "REVIEWER_ID")).toBe("71469756");
  });

  test("match deploy.yml's job names and run titles", () => {
    const workflow = readFileSync(root(".github/workflows/deploy.yml"), "utf8");
    const parsed = YAML.parse(workflow) as { jobs: Record<string, { name?: string }> };
    expect(parsed.jobs.deploy?.name).toBe(constant(TEXT, "DEPLOY_JOB"));
    expect(parsed.jobs["deploy-staging"]?.name).toBe("Deploy staging");
    expect(constant(deploy, "STAGING_JOB")).toBe("Deploy staging");
    // The run-name forms the script reads: a dispatch "Deploy <version>[ rollback from <from>][ to
    // staging]", an automatic run "Deploy <head_sha>".
    expect(workflow).toContain("format('Deploy {0}{1}{2}', inputs.version,");
    expect(workflow).toContain("format(' rollback from {0}', inputs.from)");
    expect(workflow).toContain("inputs.target == 'staging' && ' to staging'");
    expect(workflow).toContain("format('Deploy {0}', github.event.workflow_run.head_sha)");
    const select = body("select_production");
    expect(select).toContain("if [[ $title == *' to staging' ]]; then");
    expect(select).toContain("elif [[ $title == *' rollback from '* ]]; then");
    expect(select).toContain(
      "elif [[ $event == workflow_run && $title =~ ^Deploy\\ ([0-9a-f]{40})$ ]]; then",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
    expect(select).toContain('dispatch="^Deploy (${VERSION:1:-1})\\$"');
    expect(select).toContain("elif [[ $event == workflow_dispatch && $title =~ $dispatch ]]; then");
    // Always the title GitHub displays, never the run's name.
    const listing = select.split("\n").filter((line) => line.includes(".workflow_runs[] | ["));
    expect(listing).toHaveLength(1);
    expect(listing[0]).toContain(".event, .display_title]");
    expect(listing[0]).not.toMatch(/\.name\b/u);
    expect(select).toContain(
      "while IFS=$'\\x1f' read -r id path repo branch attempt status event title; do",
    );
  });

  test("SELF is this script's own repository path, and HOST_PATHS the playbook's tree", () => {
    expect(constant(TEXT, "SELF")).toBe(SELF_PATH);
    expect(existsSync(root(SELF_PATH))).toBe(true);
    expect(constant(TEXT, "HOST_PATHS")).toBe("ops/ansible/");
    expect(SELF_PATH.startsWith(constant(TEXT, "HOST_PATHS"))).toBe(true);
  });

  test("pin the production URLs, protocols and paths that main sets, and nothing else", () => {
    expect(constant(TEXT, "REPO_URL")).toBe("https://github.com/deconfined/tarubot.git");
    expect(constant(TEXT, "REPO_PROTOCOL")).toBe("https");
    expect(constant(TEXT, "API")).toBe("https://api.github.com");
    expect(constant(TEXT, "API_PROTOCOLS")).toBe("=https");
    expect(constant(TEXT, "PING_PROTOCOLS")).toBe("=https");
    expect(constant(TEXT, "SAFE_PATH")).toBe("/usr/sbin:/usr/bin");
    expect(constant(TEXT, "DRIFT_HOUR")).toBe("05");
    const assigned = Object.fromEntries(
      (FUNCTIONS.get("main") ?? [])
        .filter((line) => /^[A-Z_]+=/u.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const expected = {
      REMOTE: "$REPO_URL",
      REMOTE_PROTOCOL: "$REPO_PROTOCOL",
      API_BASE: "$API",
      API_PROTO: "$API_PROTOCOLS",
      PING_PROTO: "$PING_PROTOCOLS",
      STATE_DIR: "/var/lib/tarubot-config",
      CLONE: "/var/lib/tarubot-config/repo",
      HOME_DIR: "/var/lib/tarubot-config/home",
      SETTINGS: "/etc/tarubot/host.yml",
      PING_FILE: "/etc/tarubot/host-config.env",
      LOCK: "$HOST_LOCK",
      LAYOUT_TOP: "/",
      OWNER_UID: "0",
      API_DEADLINE: "180",
      PAUSE_WAIT: "3600",
    };
    expect(assigned).toEqual(expected);
    // The test driver sets every one of them (and main never runs in a test).
    const driver = readFileSync(DRIVER, "utf8");
    for (const name of Object.keys(expected))
      expect({ name, set: new RegExp(`^${name}=`, "mu").test(driver) }).toEqual({
        name,
        set: true,
      });
    expect(driver).not.toMatch(/^\s*main\b/mu);
  });

  test("the playbook's install path is the service's ExecStart", () => {
    const layout = YAML.parse(readFileSync(root("ops/ansible/vars/layout.yml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(layout.tb_pull_script).toBe("/usr/local/sbin/tarubot-host-config");
    expect(layout.tb_pull_dir).toBe("/var/lib/tarubot-config");
    expect(layout.tb_pull_marker).toBe("/var/lib/tarubot-config/last-run.json");
    expect(layout.tb_signer_principal).toBe(constant(TEXT, "REVIEWER"));
  });
});

describe("the script's shape", () => {
  test("is valid bash in strict mode, with an absolute interpreter, a fixed PATH and umask 077", () => {
    expect(Bun.spawnSync(["bash", "-n", SCRIPT], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(
      0,
    );
    expect(TEXT).toStartWith("#!/usr/bin/bash\n");
    expect(TEXT).toContain("\nset -Eeuo pipefail\n");
    const main = FUNCTIONS.get("main") ?? [];
    expect(main.slice(0, 2)).toEqual(["umask 077", "export PATH=$SAFE_PATH LC_ALL=C"]);
  });

  test("keeps only constants and functions at the top level, then the direct-run guard", () => {
    let depth = 0;
    const loose: string[] = [];
    for (const line of LINES) {
      if (depth === 0 && /^[a-z_]+\(\) \{$/u.test(line)) depth = 1;
      else if (depth === 1 && line === "}") depth = 0;
      else if (
        depth === 0 &&
        line !== "" &&
        !line.startsWith("#") &&
        !/^readonly [A-Z_]+=/u.test(line) &&
        line !== "set -Eeuo pipefail"
      )
        loose.push(line);
    }
    expect(loose).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
      'if [[ ${BASH_SOURCE[0]} == "$0" ]]; then',
      '  main "$@"',
      "  exit",
      "fi",
    ]);
  });

  test("never evaluates, sources or traces, never reads /home and never passes a start variable", () => {
    const code = commands(TEXT).join("\n");
    expect(code).not.toMatch(/\beval\b/u);
    expect(code).not.toMatch(/(^|;|&&|\|\||;\s*then|;\s*do)\s*(source|\.)\s/mu);
    expect(TEXT).not.toMatch(/set -[a-zA-Z]*x/u);
    // No path under /home (HOME_DIR is /var/lib/tarubot-config/home).
    expect(TEXT).not.toMatch(/(^|[^a-z-])\/home\b/mu);
    expect(TEXT).not.toContain("tarubot_start");
  });

  test("runs git only through g, with every hardening option, and g closes the lock descriptors", () => {
    for (const [name, lines] of FUNCTIONS)
      for (const line of lines)
        if (calls(line, "git")) expect({ name, line }).toEqual({ name: "g", line });
    const g = (FUNCTIONS.get("g") ?? []).join("\n");
    for (const option of [
      "env -i ",
      'HOME="$HOME_DIR"',
      'TMPDIR="$HOME_DIR/tmp"',
      "LC_ALL=C",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      // No system-wide attributes, and none from the checkout: the empty tree's.
      "GIT_ATTR_NOSYSTEM=1",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ASKPASS=/bin/false",
      "SSH_ASKPASS=/bin/false",
      "GIT_NO_REPLACE_OBJECTS=1",
      "GIT_OPTIONAL_LOCKS=0",
      'git -C "$CLONE"',
      "-c core.hooksPath=/dev/null",
      "-c core.fsmonitor=false",
      "-c core.untrackedCache=false",
      "-c core.pager=cat",
      '-c "attr.tree=$EMPTY_TREE"',
      "-c core.autocrlf=false",
      "-c protocol.allow=never",
      '-c "protocol.$REMOTE_PROTOCOL.allow=always"',
      "-c http.followRedirects=false",
      "-c submodule.recurse=false",
      "-c fetch.recurseSubmodules=false",
      "-c transfer.fsckObjects=true",
      "-c gc.autoDetach=false",
      "-c maintenance.auto=false",
      "-c credential.helper= ",
      "-c gpg.format=ssh",
      "-c gpg.ssh.program=/usr/bin/ssh-keygen",
      // The run's own signers file, from host.yml; never the one a playbook run rendered.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
      '-c gpg.ssh.allowedSignersFile="${ALLOWED:-/dev/null}"',
      "-c gpg.openpgp.program=/bin/false",
      "-c gpg.x509.program=/bin/false",
      '-c gpg.minTrustLevel=fully "$@" 8<&- 9<&-',
    ])
      expect({ option, found: g.includes(option) }).toEqual({ option, found: true });
    // EMPTY_TREE is git's empty tree (`git hash-object -t tree /dev/null`), which git knows
    // without the object.
    expect(constant(TEXT, "EMPTY_TREE")).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    // The fetch names the URL and the one refspec; no remote is ever configured.
    expect(body("fetch")).toContain(
      `g --limit 120 fetch -q --no-tags --no-write-fetch-head "$REMOTE" '+refs/heads/main:refs/remotes/origin/main'`,
    );
    expect(TEXT).not.toMatch(/\bremote (add|set-url)\b/u);
  });

  test("runs jq only through j, and curl only through api and ping, each under env -i", () => {
    for (const [name, lines] of FUNCTIONS)
      for (const line of lines) {
        if (calls(line, "jq")) expect({ name, line }).toEqual({ name: "j", line });
        if (calls(line, "curl")) {
          expect({ name, api: name === "api" || name === "ping" }).toEqual({ name, api: true });
          expect(line).toMatch(/env -i PATH="\$PATH" HOME="\$HOME_DIR" LC_ALL=C curl -q /u);
        }
      }
    expect((FUNCTIONS.get("j") ?? []).join("\n")).toContain(
      'env -i PATH="$PATH" HOME="$HOME_DIR" LC_ALL=C jq "$@" 8<&- 9<&-',
    );
    const api = (FUNCTIONS.get("api") ?? []).join("\n");
    for (const part of [
      '--proto "$API_PROTO"',
      "--tlsv1.2",
      "--max-time 20",
      "--retry 2 --retry-max-time 60",
      "-H 'X-GitHub-Api-Version: 2022-11-28'",
      '"$API_BASE/$1" 8<&- 9<&-',
    ])
      expect({ part, found: api.includes(part) }).toEqual({ part, found: true });
    expect(api).not.toMatch(/Authorization|If-None-Match|ETag/iu);
    // The ping URL reaches curl on stdin only.
    const ping = (FUNCTIONS.get("ping") ?? []).join("\n");
    expect(ping).toContain(`printf 'url = "%s%s"\\n' "$PING_URL" "$1" |`);
    const curl = (FUNCTIONS.get("ping") ?? []).find((line) => calls(line, "curl")) ?? "";
    expect(curl).toContain("curl -q --config - ");
    expect(curl).toContain('--proto "$PING_PROTO"');
    expect(curl).not.toContain("PING_URL");
  });

  test("closes fds 8 and 9 for every external command; only flock works on them", () => {
    const externals = [
      "git",
      "jq",
      "curl",
      "ansible-playbook",
      "tee",
      "timeout",
      "systemctl",
      "stat",
      "mktemp",
      "mv",
      "sync",
      "date",
      "od",
      "sha256sum",
      "tr",
      "wc",
      "mkdir",
      "rm",
    ];
    let checked = 0;
    // git's own subcommands after g (g rm --cached, g clean) are git's, and g closes the fds.
    const gitWords = (segment: string) =>
      segment.replace(/(^|[\s;|&(!])g (--limit \d+ )?[a-z-]+/gu, "$1g");
    for (const [name, lines] of FUNCTIONS)
      for (const line of lines) {
        if (/^(local -a )?bound=\(/u.test(line)) continue;
        for (const segment of line.split(/(?<!\|)\|(?!\|)/u).map(gitWords))
          if (externals.some((tool) => calls(segment, tool))) {
            checked++;
            expect({ name, segment, closed: segment.includes("8<&- 9<&-") }).toEqual({
              name,
              segment,
              closed: true,
            });
          }
        if (calls(line, "flock"))
          expect({
            name,
            line,
            allowed:
              /^(if !? ?)?flock (-n|-w (300|60)) [89]\b/u.test(
                line.replace(/^.*?(?=flock)/u, ""),
              ) || line.startsWith('if flock -w "$PAUSE_WAIT" "$STATE_DIR" true; then'),
          }).toEqual({ name, line, allowed: true });
      }
    expect(checked).toBeGreaterThanOrEqual(35);
    // Both lock descriptors are opened read-only, the state directory and the root-owned lock.
    expect(body("private_lock")).toContain('exec 8<"$STATE_DIR"');
    expect(body("lock_open")).toContain('exec 9<"$LOCK"');
  });

  test("runs the playbook under umask 022 with the pull unit's argv and a bounded time", () => {
    const playbook = (FUNCTIONS.get("playbook") ?? []).join("\n");
    expect(playbook).toContain("umask 022");
    for (const part of [
      'cd -- "$CLONE/ops/ansible" &&',
      "exec env -i PATH=",
      "LANG=C.UTF-8 LC_ALL=C.UTF-8",
      'ANSIBLE_CONFIG="$CLONE/ops/ansible/ansible.cfg"',
      'ANSIBLE_HOME="$HOME_DIR/.ansible"',
      'ANSIBLE_LOCAL_TEMP="$HOME_DIR/.ansible/tmp"',
      // Ansible expands the default remote temp as ~root on the local connection, not from HOME.
      'ANSIBLE_REMOTE_TMP="$HOME_DIR/.ansible/tmp"',
      "PYTHONNOUSERSITE=1",
      'timeout --kill-after=60 40m ansible-playbook -c local -i localhost, "$CLONE/ops/ansible/site.yml"',
      '-e "@$SETTINGS" -e tarubot_host_lock_held=true',
      '-e "tarubot_pull_role=$ROLE"',
      // What the script read from host.yml's signers, which the playbook compares with its own.
      '-e "tarubot_pull_signers=$SIGNERS_DIGEST" --skip-tags start --diff 8<&- 9<&-',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
      '| tee "$TMP/play.log" >&2 8<&- 9<&- || rc=${PIPESTATUS[0]}',
    ])
      expect({ part, found: playbook.includes(part) }).toEqual({ part, found: true });
  });

  test("writes state atomically, and deletes only its fixed paths and its own temporary directory", () => {
    const write = FUNCTIONS.get("state_write") ?? [];
    expect(write).toEqual([
      "local tmp",
      'tmp=$(mktemp "$STATE_DIR/.state.XXXXXX" 8<&- 9<&-)',
      'printf \'%s\\n\' "$STATE" >"$tmp"',
      'sync -- "$tmp" 8<&- 9<&-',
      'mv -f -- "$tmp" "$STATE_DIR/state.json" 8<&- 9<&-',
      'sync -- "$STATE_DIR" 8<&- 9<&-',
    ]);
    const removals = new Set<string>();
    const gitRemovals: string[] = [];
    for (const lines of FUNCTIONS.values())
      for (const line of lines)
        if (/(^|[\s;|&(!])g rm /u.test(line)) gitRemovals.push(line);
        else if (calls(line, "rm"))
          removals.add(
            line
              .replace(/^if .*?; then /u, "")
              .replace(/; fi$/u, "")
              .replace(/ 8<&- 9<&-$/u, ""),
          );
    expect([...removals].sort()).toEqual(
      [
        'rm -f -- "$lock"',
        'rm -f -- "$STATE_DIR/now"',
        'rm -f -- "$STATE_DIR/pause"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
        'rm -rf -- "${TMP:?}"',
      ].sort(),
    );
    // git's only removal is from its index, under ops/ansible/, when a checkout is repaired.
    expect(gitRemovals).toEqual([
      'g rm -r -q --cached --ignore-unmatch -- "$HOST_PATHS" >/dev/null 2>&1 || git_fail checkout',
    ]);
    // "$lock" walks only the six stale git lock files.
    expect(body("git_unlock")).toContain(
      'for lock in "$CLONE/.git/index.lock" "$CLONE/.git/HEAD.lock" "$CLONE/.git/config.lock" \\\n    "$CLONE/.git/packed-refs.lock" "$CLONE/.git/shallow.lock" "$CLONE/.git/refs/remotes/origin/main.lock"; do',
    );
  });
});

describe("the units", () => {
  /** An ini file's directives as [section, key, value] triples, comments dropped. */
  function directives(path: string): [string, string, string][] {
    let section = "";
    const found: [string, string, string][] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      const header = /^\[(.+)\]$/u.exec(line);
      if (header?.[1]) section = header[1];
      else
        found.push([section, line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
    }
    return found;
  }

  test("the service is a plain oneshot with only the allowlisted directives, no namespace option", () => {
    const service = directives(join(UNITS, "tarubot-host-config.service"));
    expect(service.map(([section, key]) => `${section}.${key}`)).toEqual([
      "Unit.Description",
      "Unit.Wants",
      "Unit.After",
      "Service.Type",
      "Service.ExecStart",
      "Service.SuccessExitStatus",
      "Service.TimeoutStartSec",
      "Service.UMask",
      "Service.Nice",
      "Service.CPUWeight",
      "Service.IOWeight",
      "Service.SyslogIdentifier",
    ]);
    const value = Object.fromEntries(service.map(([, key, v]) => [key, v]));
    expect(value).toMatchObject({
      Wants: "network-online.target",
      After: "network-online.target",
      Type: "oneshot",
      ExecStart: "/usr/local/sbin/tarubot-host-config run",
      SuccessExitStatus: "75",
      UMask: "0022",
      SyslogIdentifier: "tarubot-host-config",
    });
    // The unit's limit is above the script's own budget: the fetch, the API phase, the playbook
    // and its kill time.
    const limit = /^(\d+)min$/u.exec(String(value.TimeoutStartSec))?.[1];
    expect(Number(limit)).toBeGreaterThanOrEqual(60);
    const play = /timeout --kill-after=(\d+) (\d+)m ansible-playbook/u.exec(TEXT);
    const fetch = /g --limit (\d+) fetch/u.exec(TEXT);
    const deadline = (FUNCTIONS.get("main") ?? []).find((line) => line.startsWith("API_DEADLINE="));
    const budget =
      Number(fetch?.[1]) +
      Number(deadline?.slice("API_DEADLINE=".length)) +
      Number(play?.[2]) * 60 +
      Number(play?.[1]);
    expect(budget).toBe(120 + 180 + 40 * 60 + 60);
    expect(Number(limit) * 60).toBeGreaterThan(budget);
    const text = readFileSync(join(UNITS, "tarubot-host-config.service"), "utf8");
    const code = text
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    for (const forbidden of [
      "[Install]",
      "Environment",
      "PrivateTmp",
      "PrivateDevices",
      "PrivateMounts",
      "Protect",
      "ReadOnlyPaths",
      "ReadWritePaths",
      "InaccessiblePaths",
      "TemporaryFileSystem",
      "BindPaths",
      "BindReadOnlyPaths",
      "MountFlags",
      "RootDirectory",
      "NoNewPrivileges",
    ])
      expect({ forbidden, found: code.includes(forbidden) }).toEqual({ forbidden, found: false });
  });

  test("the timer polls every 5 minutes, and the production drop-in every 10", () => {
    const timer = directives(join(UNITS, "tarubot-host-config.timer"));
    expect(timer.filter(([section]) => section !== "Unit")).toEqual([
      ["Timer", "OnCalendar", "*:0/5"],
      ["Timer", "RandomizedDelaySec", "60"],
      ["Timer", "AccuracySec", "30s"],
      ["Install", "WantedBy", "timers.target"],
    ]);
    expect(directives(join(UNITS, "timer-production.conf"))).toEqual([
      ["Timer", "OnCalendar", ""],
      ["Timer", "OnCalendar", "*:0/10"],
    ]);
  });
});

describe("host.example.yml", () => {
  const keys = constant(TEXT, "SETTINGS_KEYS").split(" ");

  test("has exactly the keys the script allows", () => {
    const example = YAML.parse(
      readFileSync(root("ops/ansible/host.example.yml"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual([...keys].sort());
  });

  test.skipIf(!hasBash)("passes the script's plain parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-config-example-"));
    try {
      const copy = join(dir, "host.yml");
      cpSync(root("ops/ansible/host.example.yml"), copy);
      const run = Bun.spawnSync(["bash", DRIVER, "settings-check", copy], {
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          HC_SCRIPT: SCRIPT,
          HC_ROOT: dir,
          HC_REMOTE: "file:///nonexistent",
          SIM_NOW: "0",
        },
      });
      expect({ code: run.exitCode, role: run.stdout.toString().trim() }).toEqual({
        code: 0,
        role: "staging",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

type Role = "staging" | "production";
/** 2026-09-28 12:00:00 UTC, the scenarios' default clock. */
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0) / 1000;
const HOUR = 3600;
const scratch = mkdtempSync(join(tmpdir(), "host-config-"));
afterAll(() => {
  // A scenario may leave a directory read-only on purpose.
  Bun.spawnSync(["chmod", "-R", "u+rwX", scratch]);
  rmSync(scratch, { recursive: true, force: true });
});

const GIT_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  // The fixtures' own blobs are exactly the bytes written, whatever .gitattributes they carry.
  GIT_ATTR_SOURCE: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** git with an isolated configuration, failing the test on an error. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** The throwaway signing keys (private files in the scratch directory) and their public lines. */
const keys = { listed: "", other: "", listedLine: "", otherLine: "" };
/** The base history: C0 without the pull-unit script, C1 (2.34.0) with it. */
const base = { remote: "", c0: "", c1: "" };

beforeAll(() => {
  if (!hasTools) return;
  const dir = join(scratch, "keys");
  mkdirSync(dir);
  for (const name of ["listed", "other"] as const) {
    const path = join(dir, name);
    const made = Bun.spawnSync([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      name,
      "-f",
      path,
    ]);
    if (made.exitCode !== 0) throw new Error(made.stderr.toString());
    keys[name] = path;
    const line = readFileSync(`${path}.pub`, "utf8").trim().split(" ");
    keys[`${name}Line`] = `${line[0]} ${line[1]} ${name}@test`;
  }
  const work = join(scratch, "base-work");
  git(scratch, "init", "-q", "-b", "main", work);
  const files: Record<string, string> = {
    "package.json": '{"version":"2.33.0"}\n',
    "ops/ansible/site.yml": "- name: The fixture playbook\n  hosts: all\n",
    "ops/ansible/ansible.cfg": "[defaults]\n",
    "ops/ansible/files/journald-tarubot.conf": "[Journal]\n",
    "docs/README.md": "The fixture.\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Start");
  base.c0 = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "package.json"), '{"version":"2.34.0"}\n');
  mkdirSync(join(work, "ops/ansible/files/host-config"), { recursive: true });
  writeFileSync(join(work, SELF_PATH), "# The pull unit (a fixture stand-in).\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Add the pull unit");
  base.c1 = git(work, "rev-parse", "HEAD");
  base.remote = join(scratch, "base.git");
  git(scratch, "clone", "-q", "--bare", work, base.remote);
});

/** One scenario's directories: the host's / (root), the stubs, the simulation, the remote. */
interface Box {
  readonly dir: string;
  readonly root: string;
  readonly bin: string;
  readonly sim: string;
  readonly state: string;
  readonly clone: string;
  readonly home: string;
  readonly settings: string;
  readonly pingFile: string;
  readonly signers: string;
  readonly lock: string;
  readonly remote: string;
  readonly work: string;
  role: Role;
  patch: number;
}

const PING_URL = "http://ping.test/0f3c0000-test";

/** host.yml in the plain form, with the signers' public lines. */
function hostYml(role: Role, signers: string[], extra = ""): string {
  const list = signers.length
    ? `tarubot_allowed_signers:\n${signers.map((line) => `  - "${line}"`).join("\n")}\n`
    : "tarubot_allowed_signers: []\n";
  return `---\n# Host settings (a fixture).\ntarubot_role: ${role}\ntarubot_hostname: tb-test.example.org\ntarubot_deploy_key_public: ""\ntarubot_operator_keys: []\ntarubot_root_keys: []\n${list}${extra}`;
}

/** The sha256 the script passes as tarubot_pull_signers: "<type> <key>" of each, comma-joined. */
const signersDigest = (lines: string[]) =>
  createHash("sha256")
    .update(lines.map((line) => line.split(" ").slice(0, 2).join(" ")).join(","))
    .digest("hex");

/** allowed_signers as the playbook renders it. */
const signersFile = (lines: string[]) =>
  `# Rendered from host settings.\n${lines
    .map((line) => line.split(" "))
    .map(([type, key]) => `deconfined namespaces="git" ${type} ${key}\n`)
    .join("")}`;

function writeMode(path: string, content: string, mode: number) {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

let boxes = 0;
function sandbox(role: Role = "staging", signers: string[] = [keys.listedLine]): Box {
  const dir = join(scratch, `s${++boxes}`);
  const hostRoot = join(dir, "root");
  const state = join(hostRoot, "var/lib/tarubot-config");
  const box: Box = {
    dir,
    root: hostRoot,
    bin: join(dir, "bin"),
    sim: join(dir, "sim"),
    state,
    clone: join(state, "repo"),
    home: join(state, "home"),
    settings: join(hostRoot, "etc/tarubot/host.yml"),
    pingFile: join(hostRoot, "etc/tarubot/host-config.env"),
    signers: join(hostRoot, "etc/tarubot/allowed_signers"),
    lock: join(hostRoot, "run/tarubot/host.lock"),
    remote: join(dir, "remote.git"),
    work: join(dir, "work"),
    role,
    patch: 0,
  };
  for (const [path, mode] of [
    [hostRoot, 0o755],
    [join(hostRoot, "var"), 0o755],
    [join(hostRoot, "var/lib"), 0o755],
    [state, 0o700],
    [box.home, 0o700],
    [join(hostRoot, "etc"), 0o755],
    [join(hostRoot, "etc/tarubot"), 0o755],
    [join(hostRoot, "run"), 0o755],
    [join(hostRoot, "run/tarubot"), 0o755],
  ] as const) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, mode);
  }
  writeMode(box.lock, "", 0o644);
  writeMode(box.settings, hostYml(role, signers), 0o600);
  writeMode(
    box.pingFile,
    `# The staging check.\nHEALTHCHECKS_HOST_CONFIG_URL=${PING_URL}\n`,
    0o600,
  );
  writeMode(box.signers, signersFile(signers), 0o644);
  mkdirSync(box.bin);
  for (const name of ["curl", "ansible-playbook", "systemctl"]) {
    cpSync(join(FIXTURES, "stubs", name), join(box.bin, name));
    chmodSync(join(box.bin, name), 0o755);
  }
  mkdirSync(join(box.sim, "knob"), { recursive: true });
  mkdirSync(join(box.sim, "api"));
  writeFileSync(
    join(box.sim, "paths"),
    [
      `CLONE=${box.clone}`,
      `HOME_DIR=${box.home}`,
      `SETTINGS=${box.settings}`,
      `SIGNERS=${box.signers}`,
      `LOCK=${box.lock}`,
      `MARKER=${join(state, "last-run.json")}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(box.sim, "driver"), DRIVER);
  writeFileSync(join(box.sim, "ping-base"), PING_URL);
  clear(box);
  cpSync(base.remote, box.remote, { recursive: true });
  git(dir, "clone", "-q", box.remote, box.work);
  return box;
}

/** Empty the simulation's call logs, so a check sees only what follows. */
function clear(box: Box) {
  for (const name of [
    "pings",
    "ping-argv",
    "ping-stdin",
    "playbook-calls",
    "api-calls",
    "systemctl-calls",
    "start.out",
    "start.err",
  ])
    writeFileSync(join(box.sim, name), "");
  rmSync(join(box.sim, "play-started"), { force: true });
}

const simLines = (box: Box, name: string) =>
  readFileSync(join(box.sim, name), "utf8")
    .split("\n")
    .filter((line) => line !== "");
const pings = (box: Box) => simLines(box, "pings");
const plays = (box: Box) => simLines(box, "playbook-calls");
const apiCalls = (box: Box) => simLines(box, "api-calls");
const knob = (box: Box, name: string, value = "") =>
  writeFileSync(join(box.sim, "knob", name), value);
const unknob = (box: Box, name: string) => rmSync(join(box.sim, "knob", name), { force: true });

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The driver's environment: the stubs first, the sandbox, the clock, and a canary to keep out. */
function driverEnv(box: Box, now: number, env: Record<string, string>) {
  return {
    PATH: `${box.bin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: box.dir,
    LC_ALL: "C",
    HC_SCRIPT: SCRIPT,
    HC_ROOT: box.root,
    HC_REMOTE: `file://${box.remote}`,
    SIM_NOW: String(now),
    HC_CANARY: "the-caller-environment",
    ...env,
  };
}

/** One command through the driver. */
function hc(box: Box, args: string[], now = NOW, env: Record<string, string> = {}): Run {
  const result = Bun.spawnSync(["bash", DRIVER, ...args], {
    cwd: box.dir,
    env: driverEnv(box, now, env),
    stdin: "ignore",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The same, started in the background. */
function hcAsync(box: Box, args: string[], now = NOW, env: Record<string, string> = {}) {
  return Bun.spawn(["bash", DRIVER, ...args], {
    cwd: box.dir,
    env: driverEnv(box, now, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface Outcome {
  readonly outcome: string;
  readonly commit: string;
  readonly version: string;
  readonly changed: string;
  readonly reason: string;
}

/** The exit status section 4's table gives an outcome and reason. */
function exitFor(outcome: string, reason: string): number {
  if (["applied", "recorded", "current", "paused"].includes(outcome)) return 0;
  if (outcome === "waiting") return 75;
  if (outcome !== "needs-you") return 1;
  if (["layout", "settings", "state-schema", "not-root", "already-bootstrapped"].includes(reason))
    return 78;
  return reason === "bad-commit" ? 64 : 1;
}

/** The run's one result line (the last line on stdout), checked against the form. */
function outcomeOf(run: Run): Outcome {
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  const match = RESULT.exec(lines.at(-1) ?? "");
  if (lines.filter((line) => line.startsWith("result ")).length !== 1 || !match)
    throw new Error(`no single result line\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  return {
    outcome: match[1] ?? "",
    commit: match[2] ?? "",
    version: match[3] ?? "",
    changed: match[4] ?? "",
    reason: match[5] ?? "",
  };
}

/** The run ended with this outcome and reason, and the table's exit status. */
function expectOutcome(run: Run, outcome: string, reason: string): Outcome {
  const result = outcomeOf(run);
  expect(
    { outcome: result.outcome, reason: result.reason, code: run.code },
    `stderr:\n${run.stderr}`,
  ).toEqual({ outcome, reason, code: exitFor(outcome, reason) });
  return result;
}

const short = (sha: string) => sha.slice(0, 12);

interface State {
  schema: number;
  applied: { commit: string; version: string; source: string; at: number };
  last_full: {
    commit: string;
    source: string;
    run: string;
    at: number;
    settings: string;
    changed: number;
  };
  failure: null | {
    commit: string;
    settings: string;
    attempts: number;
    first_at: number;
    last_at: number;
    task: string;
  };
  busy_since: null | number;
  target: null | { commit: string; run: string };
  runs: Record<string, string>;
  last_result: string;
}
const stateOf = (box: Box): State =>
  JSON.parse(readFileSync(join(box.state, "state.json"), "utf8")) as State;
const settingsHash = (box: Box) =>
  createHash("sha256").update(readFileSync(box.settings)).digest("hex");
const marker = (box: Box) =>
  JSON.parse(readFileSync(join(box.state, "last-run.json"), "utf8")) as Record<string, string>;

/** Bootstrap at commit (C1 by default) and clear the logs. */
function bootstrap(box: Box, commit = base.c1, now = NOW) {
  expectOutcome(hc(box, ["bootstrap", commit], now), "applied", "bootstrap");
  clear(box);
}

/** Commit in the work clone, signed by a throwaway key or not at all. */
function commit(work: string, message: string, sign: "listed" | "other" | "none") {
  if (sign === "none") git(work, "commit", "-q", "-m", message);
  else
    git(
      work,
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${keys[sign]}`,
      "commit",
      "-q",
      "-S",
      "-m",
      message,
    );
}

interface MergeOptions {
  /** Files to write (null removes), besides package.json's next version. */
  readonly files?: Record<string, string | null>;
  /** A change made after `git add -A`, with its own git commands (links, submodules). */
  readonly edit?: (work: string) => void;
  /** Who signs the PR head. */
  readonly sign?: "listed" | "other" | "none";
  /** A one-parent commit on main instead of a merge. */
  readonly squash?: boolean;
  /** The merge commit changes something its head doesn't have. */
  readonly treeMismatch?: boolean;
  /** The head starts from main~1, so it doesn't contain the previous main. */
  readonly stale?: boolean;
  readonly version?: string;
}

/**
 * Merge a PR the way GitHub does: a head (signed or not) on a topic branch, then an unsigned
 * --no-ff merge commit on main, pushed to the box's remote. Returns the new main commit.
 */
function merge(box: Box, options: MergeOptions = {}): string {
  const work = box.work;
  git(work, "checkout", "-q", "-B", "topic", options.stale ? "main~1" : "main");
  box.patch += 1;
  const files: Record<string, string | null> = {
    "package.json": `${JSON.stringify({ version: options.version ?? `2.34.${box.patch}` })}\n`,
    ...options.files,
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    if (content === null) rmSync(full, { recursive: true, force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  git(work, "add", "-A");
  options.edit?.(work);
  commit(work, "Change", options.sign ?? "listed");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  if (options.squash) {
    git(work, "merge", "-q", "--squash", "topic");
    commit(work, "Squashed change", "none");
  } else if (options.stale) {
    const merged = git(
      work,
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      "main",
      "-p",
      head,
      "-m",
      "Merge",
    );
    git(work, "reset", "-q", "--hard", merged);
  } else {
    git(work, "merge", "-q", "--no-ff", "-m", "Merge pull request", "topic");
    if (options.treeMismatch) {
      writeFileSync(join(work, "ops/ansible/extra.yml"), "# Only in the merge commit.\n");
      git(work, "add", "-A");
      git(work, "commit", "-q", "--amend", "--no-edit");
    }
  }
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

/** A merge that changes the host configuration, signed by the listed key unless told otherwise. */
const hostChange = (box: Box, options: MergeOptions = {}) =>
  merge(box, { files: { "ops/ansible/site.yml": `# change ${box.patch + 1}\n` }, ...options });
/** A merge that changes only documentation. */
const docsChange = (box: Box, options: MergeOptions = {}) =>
  merge(box, { files: { "docs/README.md": `Change ${box.patch + 1}.\n` }, ...options });

/**
 * Hold a lock file from another process until killed, as a deploy holds the host lock. `flock -o`
 * keeps the lock in flock itself, so killing it frees the lock at once.
 */
function holdLock(path: string) {
  const held = `${path}.held`;
  rmSync(held, { force: true });
  const holder = Bun.spawn(
    ["flock", "-o", path, "bash", "-c", 'touch "$1"; exec sleep 30', "holder", held],
    { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore" },
  );
  for (let i = 0; i < 500 && !existsSync(held); i++) Bun.sleepSync(10);
  return holder;
}

/** Wait until a file exists (up to 20 s), letting the event loop see processes end meanwhile. */
async function waitFor(path: string) {
  for (let i = 0; i < 2000 && !existsSync(path); i++) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

// Production's GitHub answers: trimmed copies of the real anonymous answers for run 36350719753
// (tests/fixtures/host-config/api). The runs fixture's `name` is "Deploy", so a script reading it
// instead of display_title would find no commit.
const RUNS_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "api/runs.json"), "utf8")) as {
  workflow_runs: Record<string, unknown>[];
};
const JOBS_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "api/jobs.json"), "utf8")) as {
  jobs: Record<string, unknown>[];
};
const APPROVALS_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES, "api/approvals.json"), "utf8"),
) as Record<string, unknown>[];
const APPROVAL = APPROVALS_FIXTURE[0] ?? {};

interface RunSpec {
  readonly id: number;
  /** An automatic run's commit (its title is "Deploy <sha>" unless `title` says otherwise). */
  readonly sha?: string;
  readonly title?: string;
  readonly event?: string;
  readonly fields?: Record<string, unknown>;
  /** The Deploy job's conclusion; null leaves the job out. */
  readonly deploy?: string | null;
  readonly staging?: string;
  readonly approvals?: unknown[];
}

/** Serve these runs (newest created first), with their jobs and approvals. */
function publish(box: Box, runs: RunSpec[]) {
  const template = RUNS_FIXTURE.workflow_runs[0] ?? {};
  const listing = {
    total_count: runs.length,
    workflow_runs: runs.map((spec) => ({
      ...template,
      id: spec.id,
      head_sha: spec.sha ?? template.head_sha,
      display_title: spec.title ?? `Deploy ${spec.sha}`,
      event: spec.event ?? "workflow_run",
      ...spec.fields,
    })),
  };
  writeFileSync(join(box.sim, "api/runs.json"), JSON.stringify(listing));
  for (const spec of runs) {
    const jobs = JOBS_FIXTURE.jobs
      .filter((job) => !(job.name === "Deploy" && spec.deploy === null))
      .map((job) => ({
        ...job,
        run_id: spec.id,
        conclusion:
          job.name === "Deploy"
            ? (spec.deploy ?? "success")
            : job.name === "Deploy staging"
              ? (spec.staging ?? "skipped")
              : job.conclusion,
      }));
    writeFileSync(
      join(box.sim, `api/jobs-${spec.id}.json`),
      JSON.stringify({ total_count: jobs.length, jobs }),
    );
    writeFileSync(
      join(box.sim, `api/approvals-${spec.id}.json`),
      JSON.stringify(spec.approvals ?? APPROVALS_FIXTURE),
    );
  }
}

describe.skipIf(!hasTools)("the stubs refuse what the pull unit must never do", () => {
  test("curl refuses without -q first and when the caller's environment leaks in", () => {
    const box = sandbox();
    const curl = join(box.bin, "curl");
    const env = { PATH: "/usr/bin:/bin" };
    expect(Bun.spawnSync([curl, "-sS", "http://api.test/x"], { env }).exitCode).toBe(5);
    expect(
      Bun.spawnSync([curl, "-q", "http://api.test/x"], { env: { ...env, HC_CANARY: "x" } })
        .exitCode,
    ).toBe(5);
  });

  test("ansible-playbook refuses an open lock descriptor, umask 077 and a free host lock", () => {
    const box = sandbox();
    bootstrap(box);
    const args = [
      "-c",
      "local",
      "-i",
      "localhost,",
      join(box.clone, "ops/ansible/site.yml"),
      "-e",
      `@${box.settings}`,
      "-e",
      "tarubot_host_lock_held=true",
      "-e",
      "tarubot_source=pull",
      "-e",
      `tarubot_commit=${base.c1}`,
      "-e",
      "tarubot_run=0123456789abcdef",
      "-e",
      "tarubot_pull_role=staging",
      "-e",
      `tarubot_pull_signers=${signersDigest([keys.listedLine])}`,
      "--skip-tags",
      "start",
      "--diff",
    ].map((arg) => `'${arg}'`);
    const env = `env -i PATH=/usr/bin:/bin HOME=${box.home} LANG=C.UTF-8 LC_ALL=C.UTF-8 ANSIBLE_CONFIG=${box.clone}/ops/ansible/ansible.cfg ANSIBLE_HOME=${box.home}/.ansible ANSIBLE_LOCAL_TEMP=${box.home}/.ansible/tmp ANSIBLE_REMOTE_TMP=${box.home}/.ansible/tmp PYTHONNOUSERSITE=1`;
    const stub = `${env} ${join(box.bin, "ansible-playbook")} ${args.join(" ")}`;
    const shell = (script: string) =>
      Bun.spawnSync(["bash", "-c", script], { cwd: join(box.clone, "ops/ansible") });
    const locked = (inner: string) => `exec 7<'${box.lock}'; flock -n 7; ${inner}`;
    expect(shell(locked(`umask 022; exec 8</dev/null; ${stub}`)).stderr.toString()).toContain(
      "a lock descriptor is open",
    );
    expect(shell(locked(`umask 077; ${stub}`)).stderr.toString()).toContain("umask 0077");
    expect(shell(`umask 022; ${stub}`).stderr.toString()).toContain("the host lock is free");
    const good = shell(locked(`umask 022; ${stub} 7<&-`));
    expect(good.exitCode, good.stderr.toString()).toBe(0);
  });
});

describe.skipIf(!hasTools)("staging", () => {
  test("bootstrap, then a signed host change at the head is applied under the host lock", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box, { files: { "ops/ansible/site.yml": "# a change\n" } });
    knob(box, "play-changed", "3");
    const result = expectOutcome(hc(box, ["run"]), "applied", "newer");
    expect(result).toMatchObject({ commit: short(head), version: "2.34.1", changed: "3" });
    // The stub checked the lock was held, the descriptors closed and umask 022.
    expect(plays(box)).toHaveLength(1);
    expect(plays(box)[0]).toStartWith(`pull ${head} `);
    expect(pings(box)).toEqual([
      `/start pull ${short(head)} newer`,
      ` applied ${short(head)} 2.34.1 changed=3 newer`,
    ]);
    const state = stateOf(box);
    expect(state.applied).toMatchObject({ commit: head, version: "2.34.1", source: "pull" });
    expect(state.last_full).toMatchObject({ commit: head, source: "pull", changed: 3 });
    expect(state.last_full.run).toBe(marker(box).run ?? "");
    expect(marker(box)).toEqual({ source: "pull", commit: head, run: state.last_full.run });
    expect(state.last_result).toBe(
      `result outcome=applied commit=${short(head)} version=2.34.1 changed=3 reason=newer`,
    );
    // The ping URL never reached curl's argv; it went in on stdin.
    expect(readFileSync(join(box.sim, "ping-argv"), "utf8")).not.toContain("ping.test");
    expect(readFileSync(join(box.sim, "ping-stdin"), "utf8")).toContain(`url = "${PING_URL}"`);
    // The same head again is current, without the playbook.
    clear(box);
    const again = expectOutcome(hc(box, ["run"]), "current", "-");
    expect(again).toMatchObject({ commit: short(head), version: "2.34.1", changed: "-" });
    expect(plays(box)).toEqual([]);
    expect(pings(box)).toEqual([` current ${short(head)} 2.34.1`]);
    // The clone holds root's files only: private modes, no hooks directory from a template.
    expect(statSync(box.clone).mode & 0o777).toBe(0o700);
    expect(existsSync(join(box.clone, ".git/hooks"))).toBe(false);
  });

  test("a docs-only merge is recorded: no playbook, no lock, no /start", () => {
    const box = sandbox();
    bootstrap(box);
    const docs = docsChange(box);
    const holder = holdLock(box.lock);
    try {
      const result = expectOutcome(hc(box, ["run"]), "recorded", "runtime-only");
      expect(result).toMatchObject({ commit: short(docs), version: "2.34.1" });
    } finally {
      holder.kill();
    }
    expect(plays(box)).toEqual([]);
    expect(pings(box)).toEqual([` recorded ${short(docs)} 2.34.1`]);
    const state = stateOf(box);
    expect(state.applied).toMatchObject({ commit: docs, source: "pull" });
    expect(state.last_full).toMatchObject({ commit: base.c1, source: "bootstrap" });
  });

  test("a hand run re-applies with hand-run, and a killed run of this unit with interrupted", () => {
    const box = sandbox();
    bootstrap(box);
    writeMode(
      join(box.state, "last-run.json"),
      '{"source":"manual","commit":"","run":""}\n',
      0o600,
    );
    expectOutcome(hc(box, ["run"]), "applied", "hand-run");
    expect(plays(box)).toHaveLength(1);
    writeMode(
      join(box.state, "last-run.json"),
      `{"source":"pull","commit":"${base.c1}","run":"00000000000000aa"}\n`,
      0o600,
    );
    expectOutcome(hc(box, ["run"]), "applied", "interrupted");
    // A missing marker is a hand run too (a pre-2.34.0 playbook writes none).
    rmSync(join(box.state, "last-run.json"));
    expectOutcome(hc(box, ["run"]), "applied", "hand-run");
    expectOutcome(hc(box, ["run"]), "current", "-");
  });

  test("the daily re-apply comes at the first poll after 05:00 UTC", () => {
    const at = (day: number, hour: number, minute: number) =>
      Date.UTC(2026, 8, day, hour, minute) / 1000;
    const box = sandbox();
    bootstrap(box, base.c1, at(28, 4, 59));
    expectOutcome(hc(box, ["run"], at(28, 5, 1)), "applied", "drift");
    expectOutcome(hc(box, ["run"], at(28, 5, 6)), "current", "-");
    const later = sandbox();
    bootstrap(later, base.c1, at(28, 5, 1));
    expectOutcome(hc(later, ["run"], at(29, 4, 59)), "current", "-");
    // Catch-up after downtime: days later, the first poll re-applies.
    expectOutcome(hc(later, ["run"], at(31, 17, 0)), "applied", "drift");
  });

  test("a changed host.yml re-applies the applied commit first, even with a host change pending", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    writeMode(box.settings, hostYml("staging", [keys.listedLine], "# an operator note\n"), 0o600);
    const first = expectOutcome(hc(box, ["run"]), "applied", "settings-changed");
    expect(first.commit).toBe(short(base.c1));
    expect(plays(box)).toEqual([expect.stringMatching(new RegExp(`^pull ${base.c1} `, "u"))]);
    expect(stateOf(box).last_full.settings).toBe(settingsHash(box));
    const second = expectOutcome(hc(box, ["run"]), "applied", "newer");
    expect(second.commit).toBe(short(head));
  });

  test("a new signer in host.yml unblocks a head it signed (the rotation order)", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box, { sign: "other" });
    const blocked = expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change");
    expect(blocked.commit).toBe(short(head));
    expect(pings(box)).toEqual([`/fail needs-you unsigned-host-change ${short(head)}`]);
    expect(plays(box)).toEqual([]);
    writeMode(box.settings, hostYml("staging", [keys.otherLine]), 0o600);
    const rotated = expectOutcome(hc(box, ["run"]), "applied", "settings-changed");
    expect(rotated.commit).toBe(short(base.c1));
    // The playbook (the stub, from host.yml) rendered the new signer.
    expect(readFileSync(box.signers, "utf8")).toContain(keys.otherLine.split(" ")[1] ?? "?");
    expect(readFileSync(box.signers, "utf8")).not.toContain(keys.listedLine.split(" ")[1] ?? "?");
    expectOutcome(hc(box, ["run"]), "applied", "newer");
    expect(stateOf(box).applied.commit).toBe(head);
  });

  test("a hand run's rendered signers never decide a signature: the checks read host.yml", () => {
    const box = sandbox();
    bootstrap(box);
    // A paused hand run from an operator copy that still listed a rotated-out key rendered both
    // keys and left its marker; then a merge whose head that stale key signed.
    writeMode(
      join(box.state, "last-run.json"),
      '{"source":"manual","commit":"","run":""}\n',
      0o600,
    );
    writeMode(box.signers, signersFile([keys.listedLine, keys.otherLine]), 0o644);
    const head = hostChange(box, { sign: "other" });
    const run = hc(box, ["run"]);
    expect(expectOutcome(run, "needs-you", "unsigned-host-change").commit).toBe(short(head));
    expect(run.stderr).toContain(`check ${short(head)} signature-U`);
    expect(plays(box)).toEqual([]);
    expect(stateOf(box).applied.commit).toBe(base.c1);
  });

  test("with no signers a host change is no-signers, and adding one recovers the same way", () => {
    const box = sandbox("staging", []);
    bootstrap(box);
    const head = hostChange(box);
    const blocked = expectOutcome(hc(box, ["run"]), "needs-you", "no-signers");
    expect(blocked.commit).toBe(short(head));
    // A docs-only merge on top is still held back by the change below it.
    docsChange(box);
    expectOutcome(hc(box, ["run"]), "needs-you", "no-signers");
    writeMode(box.settings, hostYml("staging", [keys.listedLine]), 0o600);
    expectOutcome(hc(box, ["run"]), "applied", "settings-changed");
    expectOutcome(hc(box, ["run"]), "applied", "newer");
  });

  test("a rewritten main stops the host at history-rewritten", () => {
    const box = sandbox();
    bootstrap(box);
    const head = docsChange(box);
    expectOutcome(hc(box, ["run"]), "recorded", "runtime-only");
    git(box.work, "reset", "-q", "--hard", base.c1);
    git(box.work, "commit", "-q", "--allow-empty", "-m", "Rewritten");
    git(box.work, "push", "-q", "-f", "origin", "HEAD:main");
    const result = expectOutcome(hc(box, ["run"]), "needs-you", "history-rewritten");
    expect(result.commit).toBe(short(head));
    expect(pings(box).at(-1)).toBe(`/fail needs-you history-rewritten ${short(head)}`);
  });

  test("an unsigned host change blocks the host, and a signed merge on top doesn't carry it", () => {
    const box = sandbox();
    bootstrap(box);
    const unsigned = hostChange(box, { sign: "none" });
    expect(expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change").commit).toBe(
      short(unsigned),
    );
    hostChange(box);
    expect(expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change").commit).toBe(
      short(unsigned),
    );
    expect(stateOf(box).applied.commit).toBe(base.c1);
    expect(plays(box)).toEqual([]);
  });

  test("unsigned merges pass when they don't touch ops/ansible/, or cancel out to nothing", () => {
    const box = sandbox();
    bootstrap(box);
    docsChange(box, { sign: "none" });
    expectOutcome(hc(box, ["run"]), "recorded", "runtime-only");
    const original = readFileSync(join(box.work, "ops/ansible/site.yml"), "utf8");
    hostChange(box, { sign: "none" });
    const reverted = merge(box, { files: { "ops/ansible/site.yml": original } });
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(
      short(reverted),
    );
  });

  test.each([
    ["a squash (one-parent) commit", { squash: true }],
    ["a merge whose tree differs from its head's", { treeMismatch: true }],
    ["a head that doesn't contain the previous main", { stale: true }],
    ["a head signed by a key that isn't listed", { sign: "other" }],
  ] as const)("%s touching ops/ansible/ is needs-you", (_name, options) => {
    const box = sandbox();
    bootstrap(box);
    docsChange(box);
    const bad = hostChange(box, options);
    const result = expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change");
    expect(result.commit).toBe(short(bad));
    expect(stateOf(box).applied.commit).toBe(base.c1);
  });

  test.each<[string, (work: string) => void]>([
    [
      "a link under ops/ansible/",
      (work: string) => {
        symlinkSync("../site.yml", join(work, "ops/ansible/files/link.yml"));
        git(work, "add", "-A");
      },
    ],
    [
      "a submodule under ops/ansible/",
      (work: string) =>
        git(work, "update-index", "--add", "--cacheinfo", `160000,${base.c0},ops/ansible/sub`),
    ],
    [
      "ops/ansible as a link",
      (work: string) => {
        git(work, "rm", "-r", "-q", "ops/ansible");
        mkdirSync(join(work, "ops"), { recursive: true });
        symlinkSync("../docs", join(work, "ops/ansible"));
        git(work, "add", "-A");
      },
    ],
  ])("%s is host-config-link", (_name, edit) => {
    const box = sandbox();
    bootstrap(box);
    merge(box, { edit });
    expectOutcome(hc(box, ["run"]), "needs-you", "host-config-link");
    expect(plays(box)).toEqual([]);
  });

  test("a target without the pull-unit script is missing-pull-unit", () => {
    const box = sandbox();
    bootstrap(box);
    merge(box, { files: { [SELF_PATH]: null } });
    expectOutcome(hc(box, ["run"]), "needs-you", "missing-pull-unit");
  });
});

/** Every file under ops/ansible/ in the clone is its HEAD blob, byte for byte. */
function expectCloneFilesAreBlobs(box: Box) {
  const paths = git(box.clone, "ls-tree", "-r", "--name-only", "HEAD", "--", "ops/ansible/")
    .split("\n")
    .filter((path) => path !== "");
  expect(paths.length).toBeGreaterThan(2);
  for (const path of paths)
    expect({ path, disk: git(box.clone, "hash-object", "--no-filters", path) }).toEqual({
      path,
      disk: git(box.clone, "rev-parse", `HEAD:${path}`),
    });
}

describe.skipIf(!hasTools)("git", () => {
  test("a .gitattributes outside ops/ansible/ never changes what the playbook reads", () => {
    const box = sandbox();
    bootstrap(box);
    // Runtime-only, so it needs no signature: attributes that would re-encode ops/ansible/ at
    // checkout, from the top of the repository and from ops/.
    const attributes = merge(box, {
      files: {
        ".gitattributes": "ops/ansible/** working-tree-encoding=UTF-7\n",
        "ops/.gitattributes": "ansible/** text eol=crlf ident\n",
      },
      sign: "none",
    });
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(
      short(attributes),
    );
    // The next signed host change is applied, and the files on disk are its blobs.
    const content = "# a change with $Id$ and a+b\n";
    const head = hostChange(box, { files: { "ops/ansible/site.yml": content } });
    const run = hc(box, ["run"]);
    expect(expectOutcome(run, "applied", "newer").commit).toBe(short(head));
    expect(run.stderr).not.toContain("clone-repaired");
    expect(readFileSync(join(box.clone, "ops/ansible/site.yml"), "utf8")).toBe(content);
    expectCloneFilesAreBlobs(box);
  });

  test("a clone whose files changed behind git's index is repaired before the playbook reads it", () => {
    const box = sandbox();
    bootstrap(box);
    // What a filter applied at an earlier checkout would leave: a file rewritten on disk that
    // git's index records as up to date, with the index written well after the file, so git
    // trusts the recorded size and times and a checkout of the same commit keeps the file.
    const attributes = join(box.dir, "crlf-attributes");
    const site = join(box.clone, "ops/ansible/site.yml");
    writeFileSync(attributes, "ops/ansible/** text eol=crlf\n");
    const withAttributes = ["-c", `core.attributesFile=${attributes}`];
    rmSync(site);
    git(box.clone, ...withAttributes, "checkout", "--", "ops/ansible/site.yml");
    const past = new Date(Date.now() - 60_000);
    utimesSync(site, past, past);
    git(box.clone, ...withAttributes, "update-index", "--refresh");
    expect(readFileSync(site, "utf8")).toContain("\r\n");
    expect(git(box.clone, "diff", "--stat")).toBe("");
    writeMode(
      join(box.state, "last-run.json"),
      '{"source":"manual","commit":"","run":""}\n',
      0o600,
    );
    const run = hc(box, ["run"]);
    expectOutcome(run, "applied", "hand-run");
    expect(run.stderr).toContain("warning clone-repaired ops/ansible/");
    expect(readFileSync(site, "utf8")).not.toContain("\r");
    expectCloneFilesAreBlobs(box);
  });

  test("a GitHub error after the discovery request is waiting github-unreachable, with no ping", async () => {
    const box = sandbox();
    bootstrap(box);
    // A stand-in for GitHub's smart HTTP: the discovery GET gets a protocol v2 advertisement, and
    // the ls-refs and fetch requests that follow (POSTs) get 502, as in a GitHub hiccup.
    const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
    const advertisement = `${pkt("# service=git-upload-pack\n")}0000${[
      "version 2\n",
      "agent=git/test\n",
      "ls-refs\n",
      "fetch=shallow\n",
      "object-format=sha1\n",
    ]
      .map(pkt)
      .join("")}0000`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        request.method === "GET"
          ? new Response(advertisement, {
              headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
            })
          : new Response("", { status: 502 }),
    });
    try {
      // The server answers from this process, so the run must not block it.
      const child = hcAsync(box, ["run"], NOW, {
        HC_REMOTE: `http://127.0.0.1:${server.port}/tarubot.git`,
        HC_REMOTE_PROTOCOL: "http",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expectOutcome({ code, stdout, stderr }, "waiting", "github-unreachable");
      expect(stderr).toContain("RPC failed");
    } finally {
      server.stop(true);
    }
    expect(pings(box)).toEqual([]);
  });

  test("stale lock files from a killed run are removed and the poll goes on", () => {
    const box = sandbox();
    bootstrap(box);
    const docs = docsChange(box);
    for (const lock of [".git/index.lock", ".git/refs/remotes/origin/main.lock"])
      writeMode(join(box.clone, lock), "", 0o600);
    const run = hc(box, ["run"]);
    expect(expectOutcome(run, "recorded", "runtime-only").commit).toBe(short(docs));
    expect(run.stderr).toContain("warning stale-git-lock .git/index.lock");
    expect(run.stderr).toContain("warning stale-git-lock .git/refs/remotes/origin/main.lock");
    expect(existsSync(join(box.clone, ".git/index.lock"))).toBe(false);
  });

  test("an unreachable remote is waiting github-unreachable, with no ping", () => {
    const box = sandbox();
    bootstrap(box);
    const run = hc(box, ["run"], NOW, {
      HC_REMOTE: "http://localhost:1/tarubot.git",
      HC_REMOTE_PROTOCOL: "http",
    });
    expectOutcome(run, "waiting", "github-unreachable");
    expect(pings(box)).toEqual([]);
  });

  test.skipIf(isRoot)("a local git failure is failed git-local, with /fail", () => {
    const box = sandbox();
    bootstrap(box);
    docsChange(box);
    chmodSync(join(box.clone, ".git/objects/pack"), 0o555);
    chmodSync(join(box.clone, ".git/objects"), 0o555);
    try {
      expectOutcome(hc(box, ["run"]), "failed", "git-local");
    } finally {
      chmodSync(join(box.clone, ".git/objects"), 0o755);
      chmodSync(join(box.clone, ".git/objects/pack"), 0o755);
    }
    expect(pings(box)).toEqual(["/fail git-local fetch"]);
  });
});

describe.skipIf(!hasTools)("the host lock", () => {
  test("a deploy holding it is waiting deploy-running; three hours of it page lock-held", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    const holder = holdLock(box.lock);
    try {
      const run = hc(box, ["run"]);
      expect(expectOutcome(run, "waiting", "deploy-running").commit).toBe(short(head));
      expect(pings(box)).toEqual([" waiting deploy-running"]);
      expect(stateOf(box).busy_since).toBe(NOW);
      expect(plays(box)).toEqual([]);
      expectOutcome(hc(box, ["run"], NOW + 3 * HOUR), "waiting", "lock-held");
      expect(pings(box).at(-1)).toBe("/fail lock-held 3h");
    } finally {
      holder.kill();
    }
    expectOutcome(hc(box, ["run"], NOW + 3 * HOUR), "applied", "newer");
    expect(stateOf(box).busy_since).toBeNull();
  });

  test("only an unbroken stretch of busy polls pages: any other end closes it", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    const busy = (now: number) => {
      const holder = holdLock(box.lock);
      try {
        return expectOutcome(hc(box, ["run"], now), "waiting", "deploy-running");
      } finally {
        holder.kill();
      }
    };
    busy(NOW);
    expect(stateOf(box).busy_since).toBe(NOW);
    // A pause ends the stretch; a short deploy four hours later starts a new one.
    hc(box, ["pause", "maintenance", "--no-wait"]);
    expectOutcome(hc(box, ["run"], NOW + 60), "paused", "paused");
    expect(stateOf(box).busy_since).toBeNull();
    hc(box, ["resume"]);
    busy(NOW + 4 * HOUR);
    expect(stateOf(box).busy_since).toBe(NOW + 4 * HOUR);
    expect(pings(box).at(-1)).toBe(" waiting deploy-running");
    // So does an emergency apply.
    expectOutcome(hc(box, ["apply", head, "--emergency"], NOW + 5 * HOUR), "applied", "emergency");
    expect(stateOf(box).busy_since).toBeNull();
    // And a needs-you.
    hostChange(box);
    busy(NOW + 6 * HOUR);
    expect(stateOf(box).busy_since).toBe(NOW + 6 * HOUR);
    const tip = hostChange(box, { sign: "none" });
    expectOutcome(hc(box, ["run"], NOW + 7 * HOUR), "needs-you", "unsigned-host-change");
    expect(stateOf(box).busy_since).toBeNull();
    // Two days on, a short deploy is a short deploy.
    expectOutcome(hc(box, ["apply", tip, "--emergency"], NOW + 8 * HOUR), "applied", "emergency");
    hostChange(box);
    busy(NOW + 55 * HOUR);
    expect(stateOf(box).busy_since).toBe(NOW + 55 * HOUR);
    expect(pings(box).at(-1)).toBe(" waiting deploy-running");
  });

  test("a deploy holding the lock at a failed commit's retry keeps the failure's page", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    unknob(box, "play-fail");
    clear(box);
    const holder = holdLock(box.lock);
    try {
      expectOutcome(hc(box, ["run"], NOW + HOUR + 60), "waiting", "deploy-running");
    } finally {
      holder.kill();
    }
    expect(pings(box)).toEqual([`/fail apply-failed ${short(head)} task=Some task`]);
    // The check comes back up only when the commit applies.
    expectOutcome(hc(box, ["run"], NOW + HOUR + 120), "applied", "retry");
    expect(pings(box).at(-1)).toBe(` applied ${short(head)} 2.34.1 changed=0 retry`);
  });

  test("a failure no longer wanted is dropped at a current poll, and a later busy lock doesn't page it", () => {
    const box = sandbox();
    bootstrap(box);
    // A host.yml edit that fails in pre_tasks, before the playbook changed anything or wrote its
    // marker; then the edit is undone.
    const good = readFileSync(box.settings, "utf8");
    writeMode(box.settings, hostYml("staging", [keys.listedLine], "# a bad edit\n"), 0o600);
    knob(box, "play-fail-early", "Refuse missing or malformed host settings");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    unknob(box, "play-fail-early");
    expect(stateOf(box).failure?.task).toBe("Refuse missing or malformed host settings");
    writeMode(box.settings, good, 0o600);
    expectOutcome(hc(box, ["run"], NOW + 60), "current", "-");
    expect(stateOf(box).failure).toBeNull();
    // A deploy delaying a later host change then pings success, as with no failure at all.
    hostChange(box);
    clear(box);
    const holder = holdLock(box.lock);
    try {
      expectOutcome(hc(box, ["run"], NOW + 120), "waiting", "deploy-running");
    } finally {
      holder.kill();
    }
    expect(pings(box)).toEqual([" waiting deploy-running"]);
  });

  test("the emergency apply waits for it, or with --ignore-lock goes on and logs the holder", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box, { sign: "none" });
    const holder = holdLock(box.lock);
    try {
      expectOutcome(hc(box, ["apply", head, "--emergency"]), "waiting", "deploy-running");
      const run = hc(box, ["apply", head, "--emergency", "--ignore-lock"]);
      expectOutcome(run, "applied", "emergency");
      expect(run.stderr).toContain(`warning lock-ignored holder pid=${holder.pid} `);
    } finally {
      holder.kill();
    }
  });
});

describe.skipIf(!hasTools)("failures", () => {
  test("a failed apply keeps the last good state, backs off an hour, then retries", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    knob(box, "play-fail", "Install the host's packages");
    const failed = expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    expect(failed.commit).toBe(short(head));
    const task = "Install the host-s packages";
    expect(pings(box)).toEqual([
      `/start pull ${short(head)} newer`,
      `/fail apply-failed ${short(head)} task=${task}`,
    ]);
    let state = stateOf(box);
    expect(state.applied.commit).toBe(base.c1);
    expect(state.last_full.commit).toBe(base.c1);
    expect(state.failure).toEqual({
      commit: head,
      settings: settingsHash(box),
      attempts: 1,
      first_at: NOW,
      last_at: NOW,
      task,
    });
    // The playbook wrote its marker before it failed.
    expect(marker(box)).toMatchObject({ source: "pull", commit: head });
    clear(box);
    expectOutcome(hc(box, ["run"], NOW + 1800), "failed", "retry-later");
    expect(plays(box)).toEqual([]);
    expect(pings(box)).toEqual([`/fail apply-failed ${short(head)} task=${task}`]);
    expectOutcome(hc(box, ["run"], NOW + HOUR), "failed", "apply-failed");
    expect(stateOf(box).failure?.attempts).toBe(2);
    unknob(box, "play-fail");
    expectOutcome(hc(box, ["run"], NOW + 3 * HOUR), "applied", "retry");
    state = stateOf(box);
    expect(state.failure).toBeNull();
    expect(state.applied.commit).toBe(head);
  });

  test("a newer commit or changed settings are tried at once after a failure", () => {
    const box = sandbox();
    bootstrap(box);
    hostChange(box);
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    unknob(box, "play-fail");
    writeMode(box.settings, hostYml("staging", [keys.listedLine], "# edited\n"), 0o600);
    expectOutcome(hc(box, ["run"], NOW + 60), "applied", "settings-changed");
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["run"], NOW + 120), "failed", "apply-failed");
    unknob(box, "play-fail");
    const newer = hostChange(box);
    expect(expectOutcome(hc(box, ["run"], NOW + 180), "applied", "newer").commit).toBe(
      short(newer),
    );
  });

  test("a playbook past its time limit is recorded with task=timeout", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    // The limit is 40 minutes; this sandbox's timeout gives it one second.
    const real = Bun.which("timeout", { PATH: "/usr/bin:/bin" }) ?? "/usr/bin/timeout";
    writeMode(
      join(box.bin, "timeout"),
      `#!/usr/bin/env bash\nif [[ $1 == --kill-after=60 && $2 == 40m ]]; then exec ${real} --kill-after=1 1 "\${@:3}"; fi\nexec ${real} "$@"\n`,
      0o755,
    );
    knob(box, "play-sleep", "10");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    expect(stateOf(box).failure?.task).toBe("timeout");
    expect(pings(box).at(-1)).toBe(`/fail apply-failed ${short(head)} task=timeout`);
  });

  test.each<[string, string]>([
    ["no marker", "play-nomarker"],
    ["another run's marker", "play-badmarker"],
  ])("a successful playbook that left %s is failed marker-mismatch", (_name, which) => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box);
    knob(box, which);
    expectOutcome(hc(box, ["run"]), "failed", "marker-mismatch");
    expect(pings(box).at(-1)).toBe(`/fail apply-failed ${short(head)} task=marker`);
    expect(stateOf(box).applied.commit).toBe(base.c1);
    expect(stateOf(box).failure?.task).toBe("marker");
    expectOutcome(hc(box, ["run"], NOW + 60), "failed", "retry-later");
  });
});

describe.skipIf(!hasTools)("pause and resume", () => {
  test("paused: no fetch, no playbook, /fail paused, exit 0; resume undoes it", () => {
    const box = sandbox();
    bootstrap(box);
    const pause = hc(box, ["pause", "operator work", "--no-wait"]);
    expect(pause.code).toBe(0);
    const flag = join(box.state, "pause");
    expect(readFileSync(flag, "utf8")).toBe(`${NOW} operator work\n`);
    expect(statSync(flag).mode & 0o777).toBe(0o600);
    hostChange(box);
    expectOutcome(hc(box, ["run"]), "paused", "paused");
    expect(pings(box)).toEqual(["/fail paused operator work"]);
    expect(git(box.clone, "rev-parse", "refs/remotes/origin/main")).toBe(base.c1);
    expect(plays(box)).toEqual([]);
    expect(hc(box, ["resume"]).code).toBe(0);
    expect(existsSync(flag)).toBe(false);
    expectOutcome(hc(box, ["run"]), "applied", "newer");
    // Resuming when not paused is fine too.
    expect(hc(box, ["resume"]).code).toBe(0);
  });

  test("pause writes its flag at once and returns only after an active run ends", async () => {
    const box = sandbox();
    bootstrap(box);
    hostChange(box);
    knob(box, "play-sleep", "3");
    const poll = hcAsync(box, ["run"]);
    let pollEnded = 0;
    const polled = poll.exited.then((code) => {
      pollEnded = performance.now();
      return code;
    });
    await waitFor(join(box.sim, "play-started"));
    const pause = hcAsync(box, ["pause", "maintenance"], NOW, { HC_PAUSE_WAIT: "30" });
    let pauseEnded = 0;
    const paused = pause.exited.then((code) => {
      pauseEnded = performance.now();
      return code;
    });
    await waitFor(join(box.state, "pause"));
    // The flag is there while the run still holds the private lock, inside its playbook (whose
    // marker comes after the stub's sleep).
    expect(pollEnded).toBe(0);
    expect(await paused).toBe(0);
    expect(await polled).toBe(0);
    expect(pauseEnded).toBeGreaterThanOrEqual(pollEnded);
    expect(statSync(join(box.state, "pause")).mtimeMs).toBeLessThan(
      statSync(join(box.state, "last-run.json")).mtimeMs,
    );
    unknob(box, "play-sleep");
    expectOutcome(hc(box, ["run"]), "paused", "paused");
  });

  test("pause --no-wait returns at once while a run is active", async () => {
    const box = sandbox();
    bootstrap(box);
    hostChange(box);
    knob(box, "play-sleep", "3");
    const poll = hcAsync(box, ["run"]);
    await waitFor(join(box.sim, "play-started"));
    const started = performance.now();
    expect(hc(box, ["pause", "quick", "--no-wait"]).code).toBe(0);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(poll.exitCode).toBeNull();
    expect(await poll.exited).toBe(0);
  });

  test("a pause that appears before the host lock is taken ends the run before its checkout", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box);
    publish(box, [{ id: 3001, sha: head }]);
    knob(box, "pause-during-api", join(box.state, "pause"));
    expectOutcome(hc(box, ["run"]), "paused", "paused");
    expect(plays(box)).toEqual([]);
    expect(git(box.clone, "rev-parse", "HEAD")).toBe(base.c1);
  });

  test("pause refuses a reason that isn't printable ASCII, or none", () => {
    const box = sandbox();
    expect(hc(box, ["pause"]).code).toBe(64);
    expect(hc(box, ["pause", "tab\there"]).code).toBe(64);
    expect(hc(box, ["pause", "x".repeat(201)]).code).toBe(64);
    expect(existsSync(join(box.state, "pause"))).toBe(false);
  });
});

describe.skipIf(!hasTools)("apply-now, the emergency apply and bootstrap", () => {
  test("apply-now refuses while paused, without writing its flag", () => {
    const box = sandbox();
    bootstrap(box);
    hc(box, ["pause", "hold", "--no-wait"]);
    const run = hc(box, ["apply-now"]);
    expect({ code: run.code, out: run.stdout.trim() }).toEqual({ code: 75, out: "paused hold" });
    expect(existsSync(join(box.state, "now"))).toBe(false);
    expect(simLines(box, "systemctl-calls")).toEqual([]);
  });

  test("apply-now starts a full run past the shortcuts and the backoff, and consumes its flag", () => {
    const box = sandbox();
    bootstrap(box);
    const now = hc(box, ["apply-now"]);
    expect(now.code, now.stderr).toBe(0);
    expect(simLines(box, "systemctl-calls")[0]).toBe("start tarubot-host-config.service");
    expect(readFileSync(join(box.sim, "start.out"), "utf8")).toContain("reason=apply-now");
    expect(now.stdout).toContain("last_result=result outcome=applied");
    expect(existsSync(join(box.state, "now"))).toBe(false);
    // Within a failure's hour.
    hostChange(box);
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    unknob(box, "play-fail");
    expect(hc(box, ["apply-now"]).code).toBe(0);
    expect(stateOf(box).last_result).toContain("reason=apply-now");
    expect(stateOf(box).failure).toBeNull();
  });

  test("apply-now's flag waits for a poll that can run the playbook", () => {
    const box = sandbox();
    bootstrap(box);
    const holder = holdLock(box.lock);
    try {
      const run = hc(box, ["apply-now"]);
      expect(run.code).toBe(75);
      expect(run.stdout).toContain("apply_now=pending");
      expect(
        simLines(box, "systemctl-calls").filter((call) => call.startsWith("start")),
      ).toHaveLength(2);
      expect(existsSync(join(box.state, "now"))).toBe(true);
    } finally {
      holder.kill();
    }
    expectOutcome(hc(box, ["run"]), "applied", "apply-now");
    expect(existsSync(join(box.state, "now"))).toBe(false);
  });

  test("the emergency apply passes the signature check, works while paused, and pages", () => {
    const box = sandbox();
    bootstrap(box);
    const head = hostChange(box, { sign: "none" });
    expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change");
    hc(box, ["pause", "emergency", "--no-wait"]);
    clear(box);
    const run = hc(box, ["apply", head, "--emergency"]);
    expect(expectOutcome(run, "applied", "emergency").commit).toBe(short(head));
    expect(pings(box)).toEqual([
      `/start emergency ${short(head)} emergency`,
      `/fail emergency-apply ${short(head)} 2.34.1`,
    ]);
    expect(plays(box)[0]).toStartWith(`emergency ${head} `);
    expect(stateOf(box).applied).toMatchObject({ commit: head, source: "emergency" });
    expect(existsSync(join(box.state, "pause"))).toBe(true);
    expectOutcome(hc(box, ["run"]), "paused", "paused");
    hc(box, ["resume"]);
    expectOutcome(hc(box, ["run"]), "current", "-");
  });

  test("the emergency apply refuses a commit at or before the applied one, or off main", () => {
    const box = sandbox();
    bootstrap(box);
    hostChange(box);
    const prHead = git(box.work, "rev-parse", "HEAD^2");
    for (const commitId of [base.c1, base.c0, prHead, "not-a-commit"])
      expectOutcome(hc(box, ["apply", commitId, "--emergency"]), "needs-you", "bad-commit");
    expect(pings(box)).toEqual([]);
    expect(hc(box, ["apply", base.c1]).code).toBe(64);
    expect(hc(box, ["apply", base.c1, "--emergency", "--force"]).code).toBe(64);
  });

  test("bootstrap creates the private layout, writes the state and enables the timer", () => {
    const box = sandbox();
    rmSync(box.state, { recursive: true });
    const run = hc(box, ["bootstrap", base.c1]);
    expect(expectOutcome(run, "applied", "bootstrap").commit).toBe(short(base.c1));
    for (const dir of [box.state, box.home, join(box.home, "tmp"), box.clone])
      expect({ dir, mode: statSync(dir).mode & 0o777 }).toEqual({ dir, mode: 0o700 });
    expect(statSync(join(box.state, "state.json")).mode & 0o777).toBe(0o600);
    const state = stateOf(box);
    expect(state).toMatchObject({
      schema: 1,
      applied: { commit: base.c1, version: "2.34.0", source: "bootstrap", at: NOW },
      last_full: { commit: base.c1, source: "bootstrap", settings: settingsHash(box) },
      failure: null,
      busy_since: null,
      target: null,
      runs: {},
    });
    expect(marker(box)).toEqual({ source: "bootstrap", commit: base.c1, run: state.last_full.run });
    expect(simLines(box, "systemctl-calls")).toEqual(["enable --now tarubot-host-config.timer"]);
    expect(pings(box)).toEqual([
      `/start bootstrap ${short(base.c1)} bootstrap`,
      ` bootstrap ${short(base.c1)} 2.34.0 changed=0`,
    ]);
    expectOutcome(hc(box, ["bootstrap", base.c1]), "needs-you", "already-bootstrapped");
  });

  test("bootstrap refuses a commit off main or without the script, and a failure writes no state", () => {
    const box = sandbox();
    const prHead = (() => {
      hostChange(box);
      return git(box.work, "rev-parse", "HEAD^2");
    })();
    expectOutcome(hc(box, ["bootstrap", prHead]), "needs-you", "bad-commit");
    expectOutcome(hc(box, ["bootstrap", base.c0]), "needs-you", "missing-pull-unit");
    expect(existsSync(join(box.state, "state.json"))).toBe(false);
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["bootstrap", base.c1]), "failed", "apply-failed");
    expect(existsSync(join(box.state, "state.json"))).toBe(false);
    unknob(box, "play-fail");
    expectOutcome(hc(box, ["bootstrap", base.c1]), "applied", "bootstrap");
  });

  test("a run before bootstrap waits for it, quietly", () => {
    const box = sandbox();
    expectOutcome(hc(box, ["run"]), "waiting", "bootstrap");
    expect(pings(box)).toEqual([]);
  });
});

describe.skipIf(!hasTools)("production", () => {
  test("an approved automatic run whose Deploy succeeded is applied", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box);
    publish(box, [{ id: 4001, sha: head }]);
    const result = expectOutcome(hc(box, ["run"]), "applied", "newer");
    expect(result.commit).toBe(short(head));
    expect(apiCalls(box)).toEqual([
      // 31 days back: past GitHub's 30 days for a reviewer to approve a waiting run.
      "http://api.test/repos/deconfined/tarubot/actions/workflows/deploy.yml/runs?branch=main&status=completed&per_page=100&created=%3E%3D2026-08-28",
      "http://api.test/repos/deconfined/tarubot/actions/runs/4001/jobs",
      "http://api.test/repos/deconfined/tarubot/actions/runs/4001/approvals",
    ]);
    const state = stateOf(box);
    expect(state.runs).toEqual({ "4001": `candidate:${head}` });
    expect(state.target).toBeNull();
    // Decided runs are cached: the next poll reads the listing only.
    clear(box);
    expectOutcome(hc(box, ["run"]), "current", "-");
    expect(apiCalls(box)).toHaveLength(1);
  });

  test("runs that don't qualify are skipped and cached, without needs-you", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(box, [
      { id: 5001, sha: head, deploy: "failure" },
      { id: 5002, sha: head, deploy: "cancelled" },
      { id: 5003, sha: head, deploy: "skipped" },
      { id: 5004, sha: head, deploy: null, staging: "success" },
      { id: 5005, event: "workflow_dispatch", title: "Deploy 2.34.1 rollback from 2.34.2" },
      { id: 5006, event: "workflow_dispatch", title: "Deploy 2.34.1 to staging" },
      { id: 5007, sha: head, fields: { run_attempt: 2 } },
      { id: 5008, sha: head, fields: { path: ".github/workflows/other.yml" } },
      { id: 5009, sha: head, fields: { head_branch: "feature" } },
      { id: 5010, sha: head, fields: { head_repository: { full_name: "someone/tarubot" } } },
      { id: 5011, sha: head, title: "Deploy", fields: { name: `Deploy ${head}` } },
      { id: 5012, sha: head, fields: { status: "in_progress" } },
      { id: 5013, sha: head, event: "workflow_dispatch" },
    ]);
    const result = expectOutcome(hc(box, ["run"]), "current", "-");
    expect(result.commit).toBe(short(base.c1));
    expect(pings(box)).toEqual([` current ${short(base.c1)} 2.34.0`]);
    expect(stateOf(box).runs).toEqual({
      "5001": "skip:deploy-failure",
      "5002": "skip:deploy-cancelled",
      "5003": "skip:deploy-skipped",
      "5004": "skip:deploy-missing",
      "5005": "skip:rollback",
      "5006": "skip:staging",
      "5007": "skip:shape",
      "5008": "skip:shape",
      "5009": "skip:shape",
      "5010": "skip:shape",
      "5011": "skip:title",
      "5012": "skip:shape",
      "5013": "skip:title",
    });
  });

  test("a Deploy that succeeded without @deconfined's approval for production pages each poll", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    for (const approvals of [
      [],
      [{ ...APPROVAL, user: { login: "someone-else", id: 71469756 } }],
      [{ ...APPROVAL, user: { login: "deconfined", id: 1 } }],
      [{ ...APPROVAL, environments: [{ id: 1, name: "staging" }] }],
      [{ ...APPROVAL, state: "rejected" }],
    ]) {
      clear(box);
      publish(box, [{ id: 6001, sha: head, approvals }]);
      const result = expectOutcome(hc(box, ["run"]), "needs-you", "approval-mismatch");
      expect(result.commit).toBe(short(head));
      expect(pings(box)).toEqual([`/fail needs-you approval-mismatch ${short(head)}`]);
      expect(apiCalls(box).at(-1)).toEndWith("/runs/6001/approvals");
      expect(stateOf(box).runs).toEqual({});
      expect(stateOf(box).applied.commit).toBe(base.c1);
    }
    // A newer verified candidate passes it. The poll that first finds the mismatch behind a
    // candidate still pages, and caches the run as reported; the next goes on to the candidate.
    const newer = docsChange(box);
    publish(box, [
      { id: 6002, sha: newer },
      { id: 6001, sha: head, approvals: [] },
    ]);
    clear(box);
    expect(expectOutcome(hc(box, ["run"]), "needs-you", "approval-mismatch").commit).toBe(
      short(head),
    );
    expect(stateOf(box).runs).toEqual({
      "6001": "skip:mismatch-reported",
      "6002": `candidate:${newer}`,
    });
    expect(stateOf(box).target).toEqual({ commit: newer, run: "6002" });
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(short(newer));
    expectOutcome(hc(box, ["run"]), "current", "-");
  });

  test("a mismatch behind a newer approved candidate pages once, then the candidate applies", () => {
    const box = sandbox("production");
    bootstrap(box);
    const older = docsChange(box);
    const newer = docsChange(box);
    publish(box, [
      { id: 6102, sha: newer },
      { id: 6101, sha: older, approvals: [] },
    ]);
    const first = expectOutcome(hc(box, ["run"]), "needs-you", "approval-mismatch");
    expect(first.commit).toBe(short(older));
    expect(pings(box)).toEqual([`/fail needs-you approval-mismatch ${short(older)}`]);
    expect(stateOf(box).applied.commit).toBe(base.c1);
    expect(stateOf(box).runs).toEqual({
      "6101": "skip:mismatch-reported",
      "6102": `candidate:${newer}`,
    });
    clear(box);
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(short(newer));
    // Reported once: the listing only, and no second page.
    expect(apiCalls(box)).toHaveLength(1);
    expect(pings(box)).toEqual([` recorded ${short(newer)} 2.34.2`]);
  });

  test("a run approved weeks after it was created is still listed, up to GitHub's 30 days", () => {
    const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box);
    // A request that waited 20 days for approval: its run was created then.
    publish(box, [{ id: 9901, sha: head, fields: { created_at: iso(NOW - 20 * 86400) } }]);
    expect(expectOutcome(hc(box, ["run"]), "applied", "newer").commit).toBe(short(head));
    // One created 32 days ago is past the window, so GitHub leaves it out.
    const late = sandbox("production");
    bootstrap(late);
    hostChange(late);
    publish(late, [{ id: 9902, sha: head, fields: { created_at: iso(NOW - 32 * 86400) } }]);
    expectOutcome(hc(late, ["run"]), "current", "-");
    expect(stateOf(late).runs).toEqual({});
  });

  test("a dispatch maps its version to the unique first-parent commit; a duplicate is ambiguous", () => {
    const box = sandbox("production");
    bootstrap(box);
    const first = docsChange(box);
    docsChange(box);
    publish(box, [{ id: 7001, event: "workflow_dispatch", title: "Deploy 2.34.1" }]);
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(short(first));
    docsChange(box, { version: "2.34.2" });
    publish(box, [{ id: 7002, event: "workflow_dispatch", title: "Deploy 2.34.2" }]);
    expectOutcome(hc(box, ["run"]), "needs-you", "ambiguous-version");
    expect(stateOf(box).runs["7002"]).toBeUndefined();
  });

  test("runs complete out of order: the newest commit wins, whenever its run was created", () => {
    const box = sandbox("production");
    bootstrap(box);
    const older = docsChange(box);
    const newer = docsChange(box);
    publish(box, [
      { id: 8002, sha: older },
      { id: 8001, sha: newer },
    ]);
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(short(newer));
  });

  test("runs at or before the applied commit, or not fetched yet, cost no job or approval call", () => {
    const box = sandbox("production");
    bootstrap(box);
    const unknown = "0123456789abcdef0123456789abcdef01234567";
    publish(box, [
      { id: 9001, sha: base.c1 },
      { id: 9002, sha: base.c0 },
      { id: 9003, sha: unknown },
    ]);
    expectOutcome(hc(box, ["run"]), "current", "-");
    expect(apiCalls(box)).toHaveLength(1);
    expect(stateOf(box).runs).toEqual({ "9001": "skip:not-newer", "9002": "skip:not-newer" });
  });

  test("at most five new runs reach GitHub per poll", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(
      box,
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: 9100 + n, sha: head, deploy: "failure" })),
    );
    expectOutcome(hc(box, ["run"]), "current", "-");
    expect(apiCalls(box)).toHaveLength(6);
    expect(Object.keys(stateOf(box).runs)).toHaveLength(5);
    clear(box);
    expectOutcome(hc(box, ["run"]), "current", "-");
    expect(apiCalls(box)).toHaveLength(3);
    expect(Object.keys(stateOf(box).runs)).toHaveLength(7);
  });

  test("the approved target outlives its run's listing, and clears once applied", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box);
    publish(box, [{ id: 9201, sha: head }]);
    knob(box, "play-fail", "Some task");
    expectOutcome(hc(box, ["run"]), "failed", "apply-failed");
    expect(stateOf(box).target).toEqual({ commit: head, run: "9201" });
    publish(box, []);
    unknob(box, "play-fail");
    expect(expectOutcome(hc(box, ["run"], NOW + 2 * HOUR), "applied", "retry").commit).toBe(
      short(head),
    );
    const state = stateOf(box);
    expect(state.target).toBeNull();
    expect(state.runs).toEqual({});
  });

  test("an unreachable, malformed or redirected API waits, uncached and without a ping", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(box, [{ id: 9301, sha: head }]);
    for (const [name, value] of [
      ["api-down", ""],
      ["api-listing-body", "{}\n"],
      ["api-listing-body", '{"total_count":1,"workflow_runs":{}}\n'],
      ["api-301", ""],
      ["api-status", "502"],
    ] as const) {
      clear(box);
      knob(box, name, value);
      expectOutcome(hc(box, ["run"]), "waiting", "github-unreachable");
      unknob(box, name);
      expect(pings(box)).toEqual([]);
      expect(apiCalls(box)).toHaveLength(1);
      expect(stateOf(box).runs).toEqual({});
    }
  });

  test("a rate limit (fewer than 20 left, 403 or 429) stops the calls", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(box, [{ id: 9401, sha: head }]);
    for (const [name, value] of [
      ["api-remaining", "19"],
      ["api-status", "403"],
      ["api-status", "429"],
    ] as const) {
      clear(box);
      knob(box, name, value);
      expectOutcome(hc(box, ["run"]), "waiting", "rate-limited");
      unknob(box, name);
      expect(apiCalls(box)).toHaveLength(1);
      expect(pings(box)).toEqual([]);
    }
    knob(box, "api-remaining", "20");
    expectOutcome(hc(box, ["run"]), "recorded", "runtime-only");
  });

  test("a poll stopped partway keeps the cached runs it hadn't reached", () => {
    const box = sandbox("production");
    bootstrap(box);
    const first = docsChange(box);
    publish(box, [
      { id: 9551, sha: first, deploy: "failure" },
      { id: 9552, sha: base.c0 },
    ]);
    expectOutcome(hc(box, ["run"]), "current", "-");
    const second = docsChange(box);
    publish(box, [
      { id: 9553, sha: second },
      { id: 9551, sha: first, deploy: "failure" },
      { id: 9552, sha: base.c0 },
    ]);
    knob(box, "api-status-jobs", "429");
    expectOutcome(hc(box, ["run"]), "waiting", "rate-limited");
    expect(stateOf(box).runs).toEqual({ "9551": "skip:deploy-failure", "9552": "skip:not-newer" });
    unknob(box, "api-status-jobs");
    expect(expectOutcome(hc(box, ["run"]), "recorded", "runtime-only").commit).toBe(short(second));
  });

  test("past the API deadline no call is made and undecided runs stay uncached", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(box, [{ id: 9501, sha: head }]);
    knob(box, "api-sleep", "1.2");
    expectOutcome(hc(box, ["run"], NOW, { HC_API_DEADLINE: "1" }), "waiting", "github-unreachable");
    expect(apiCalls(box)).toHaveLength(1);
    expect(stateOf(box).runs).toEqual({});
  });

  test("a listing over 100 runs reads a second page, and no more", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = docsChange(box);
    publish(box, [{ id: 9701, sha: base.c0 }]);
    const first = JSON.parse(readFileSync(join(box.sim, "api/runs.json"), "utf8"));
    writeFileSync(join(box.sim, "api/runs.json"), JSON.stringify({ ...first, total_count: 250 }));
    publish(box, [{ id: 9702, sha: head }]);
    const second = JSON.parse(readFileSync(join(box.sim, "api/runs.json"), "utf8"));
    writeFileSync(
      join(box.sim, "api/runs-2.json"),
      JSON.stringify({ ...second, total_count: 250 }),
    );
    writeFileSync(join(box.sim, "api/runs.json"), JSON.stringify({ ...first, total_count: 250 }));
    const run = hc(box, ["run"]);
    expect(expectOutcome(run, "recorded", "runtime-only").commit).toBe(short(head));
    expect(run.stderr).toContain("warning runs-truncated");
    expect(apiCalls(box).filter((url) => url.includes("/workflows/"))).toHaveLength(2);
    expect(apiCalls(box)[1]).toEndWith("&page=2");
  });

  test("settings-changed polls and the emergency apply make no API call", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box, { sign: "none" });
    publish(box, [{ id: 9801, sha: head }]);
    writeMode(box.settings, hostYml("production", [keys.listedLine], "# edited\n"), 0o600);
    expectOutcome(hc(box, ["run"]), "applied", "settings-changed");
    expect(apiCalls(box)).toEqual([]);
    expectOutcome(hc(box, ["apply", head, "--emergency"]), "applied", "emergency");
    expect(apiCalls(box)).toEqual([]);
  });

  test("an approved release that changes ops/ansible/ unsigned is still needs-you", () => {
    const box = sandbox("production");
    bootstrap(box);
    const head = hostChange(box, { sign: "none" });
    publish(box, [{ id: 9601, sha: head }]);
    expect(expectOutcome(hc(box, ["run"]), "needs-you", "unsigned-host-change").commit).toBe(
      short(head),
    );
    expect(stateOf(box).target).toEqual({ commit: head, run: "9601" });
  });
});

describe.skipIf(!hasTools)("the host's own files", () => {
  test("a group-writable state directory, or one above it, is needs-you layout, with /fail", () => {
    const box = sandbox();
    bootstrap(box);
    chmodSync(box.state, 0o770);
    expectOutcome(hc(box, ["run"]), "needs-you", "layout");
    expect(pings(box)).toEqual(["/fail needs-you layout -"]);
    chmodSync(box.state, 0o700);
    chmodSync(join(box.root, "var"), 0o775);
    expectOutcome(hc(box, ["run"]), "needs-you", "layout");
    chmodSync(join(box.root, "var"), 0o755);
    chmodSync(box.clone, 0o755);
    expectOutcome(hc(box, ["run"]), "needs-you", "layout");
    chmodSync(box.clone, 0o700);
    chmodSync(join(box.root, "etc/tarubot"), 0o775);
    expectOutcome(hc(box, ["run"]), "needs-you", "layout");
    chmodSync(join(box.root, "etc/tarubot"), 0o755);
    // The rendered signers file is for people: the checks never read it, so its mode is no stop.
    chmodSync(box.signers, 0o664);
    expectOutcome(hc(box, ["run"]), "current", "-");
    chmodSync(box.signers, 0o644);
  });

  const VALID = [
    "---",
    "# Host settings.",
    "tarubot_role: 'production'  # the role",
    'tarubot_hostname: "tb-test.example.org"',
    "tarubot_deploy_key_public: ''",
    "tarubot_operator_keys: []",
    "tarubot_root_keys:",
    '  - "sk-ssh-ed25519@openssh.com AAAAtest break-glass"',
    "tarubot_allowed_signers:",
    "  # one key",
    "  - 'ssh-ed25519 AAAAtest signer'",
    "",
  ].join("\n");

  test.each<[string, string]>([
    ["an unknown key", `${VALID}tarubot_extra: x\n`],
    ["an anchor", VALID.replace("tarubot_operator_keys: []", "tarubot_operator_keys: &keys")],
    ["an indented anchor", VALID.replace('  - "sk-', '  - &k "sk-')],
    ["an alias", VALID.replace("tarubot_operator_keys: []", "tarubot_operator_keys: *keys")],
    [
      "an indented alias",
      VALID.replace("tarubot_operator_keys: []", "tarubot_operator_keys:\n  - *k"),
    ],
    ["a merge key", `${VALID}<<: *keys\n`],
    ["an indented merge key", VALID.replace("  # one key", "  <<: *keys")],
    ["a second document", `${VALID}---\ntarubot_role: staging\n`],
    ["a tab", VALID.replace("# Host settings.", "#\tHost settings.")],
    ["a CR", VALID.replaceAll("\n", "\r\n")],
    ["a flow mapping", VALID.replace("tarubot_operator_keys: []", "tarubot_operator_keys: {a: b}")],
    ["an indented flow mapping", VALID.replace("  # one key", "  {a: b}")],
    ["a tag", VALID.replace("tarubot_role: 'production'", "tarubot_role: !!str production")],
    [
      "a block scalar",
      VALID.replace('tarubot_hostname: "tb-test.example.org"', "tarubot_hostname: |"),
    ],
    ["two role lines", `${VALID}tarubot_role: staging\n`],
    ["no role", VALID.replace("tarubot_role: 'production'  # the role\n", "")],
    ["an unknown role", VALID.replace("'production'", "'testing'")],
    ["an unquoted value with spaces", VALID.replace('"tb-test.example.org"', "tb test")],
    ["a value line before any key", VALID.replace("---\n", "---\n  - x\n")],
    ["--- after a key", VALID.replace("---\n", "tarubot_hostname: x\n---\n")],
    // YAML breaks lines at LS (U+2028), NEL (U+0085) and PS (U+2029) too, so each would hide a
    // top-level key from this parse that Ansible reads as an extra variable.
    [
      "an LS line break after a signer",
      VALID.replace("signer'\n", "signer'\u2028ansible_python_interpreter: /home/tarubot/py\n"),
    ],
    [
      "an LS line break after a root key",
      VALID.replace(
        'break-glass"\n',
        'break-glass"\u2028ansible_python_interpreter: /home/tarubot/py\n',
      ),
    ],
    [
      "a NEL line break",
      VALID.replace("# Host settings.", "# Host settings.\u0085tarubot_extra: x"),
    ],
    [
      "a PS line break",
      VALID.replace("# Host settings.", "# Host settings.\u2029tarubot_extra: x"),
    ],
    ["any other non-ASCII byte", VALID.replace("# Host settings.", "# Host séttings.")],
    [
      "a value continued on the next line",
      VALID.replace(
        'tarubot_hostname: "tb-test.example.org"',
        "tarubot_hostname: tb-test\n  example.org",
      ),
    ],
    [
      "one signer as a single value",
      VALID.replace(
        "tarubot_allowed_signers:\n  # one key\n  - 'ssh-ed25519 AAAAtest signer'",
        "tarubot_allowed_signers: 'ssh-ed25519 AAAAtest signer'",
      ),
    ],
    [
      "an unquoted signer",
      VALID.replace("  - 'ssh-ed25519 AAAAtest signer'", "  - ssh-ed25519 AAAAtest signer"),
    ],
    ["an RSA signer", VALID.replace("'ssh-ed25519 AAAAtest signer'", "'ssh-rsa AAAAtest signer'")],
    [
      "a signer with options",
      VALID.replace("'ssh-ed25519 AAAAtest signer'", "'cert-authority ssh-ed25519 AAAAtest'"),
    ],
    [
      "a signer with two spaces",
      VALID.replace("'ssh-ed25519 AAAAtest signer'", "'ssh-ed25519  AAAAtest'"),
    ],
    [
      "a signer list after []",
      VALID.replace("tarubot_allowed_signers:\n", "tarubot_allowed_signers: []\n"),
    ],
  ])("host.yml with %s is refused", (_name, text) => {
    const box = sandbox();
    const path = join(box.dir, "host.yml");
    writeMode(path, text, 0o600);
    expect(hc(box, ["settings-check", path]).code).toBe(78);
  });

  test("host.yml with [], quoted values, comments and block lists passes", () => {
    const box = sandbox();
    const path = join(box.dir, "host.yml");
    writeMode(path, VALID, 0o600);
    const run = hc(box, ["settings-check", path]);
    expect({ code: run.code, role: run.stdout.trim() }).toEqual({ code: 0, role: "production" });
  });

  test("the signers read are each line's type and key, and their digest what the playbook checks", () => {
    const box = sandbox();
    const path = join(box.dir, "host.yml");
    const listed = keys.listedLine.split(" ");
    writeMode(
      path,
      VALID.replace(
        "  - 'ssh-ed25519 AAAAtest signer'",
        `  - 'ssh-ed25519 AAAAtest signer'\n  - "${listed[0]} ${listed[1]} a comment"  # note`,
      ),
      0o600,
    );
    const run = hc(box, ["signers-check", path]);
    const expected = ["ssh-ed25519 AAAAtest", `${listed[0]} ${listed[1]}`];
    expect({ code: run.code, out: run.stdout.trim().split("\n") }).toEqual({
      code: 0,
      out: [...expected, `digest=${signersDigest(expected)}`],
    });
    // No signers: the digest of nothing, as the playbook's for an empty list.
    writeMode(path, hostYml("staging", []), 0o600);
    expect(hc(box, ["signers-check", path]).stdout.trim()).toBe(
      `digest=${createHash("sha256").update("").digest("hex")}`,
    );
  });

  test("a refused host.yml stops the poll with needs-you settings and /fail", () => {
    const box = sandbox();
    bootstrap(box);
    writeMode(box.settings, `${hostYml("staging", [keys.listedLine])}tarubot_extra: x\n`, 0o600);
    expectOutcome(hc(box, ["run"]), "needs-you", "settings");
    expect(pings(box)).toEqual(["/fail needs-you settings -"]);
  });

  test("a ping file with another scheme or mode is needs-you settings with no ping; none means no pings", () => {
    const box = sandbox();
    bootstrap(box);
    writeMode(box.pingFile, "HEALTHCHECKS_HOST_CONFIG_URL=https://ping.test/x\n", 0o600);
    expectOutcome(hc(box, ["run"]), "needs-you", "settings");
    writeMode(box.pingFile, `HEALTHCHECKS_HOST_CONFIG_URL=${PING_URL}\n`, 0o644);
    expectOutcome(hc(box, ["run"]), "needs-you", "settings");
    writeMode(box.pingFile, `HEALTHCHECKS_HOST_CONFIG_URL=${PING_URL}\nOTHER=1\n`, 0o600);
    expectOutcome(hc(box, ["run"]), "needs-you", "settings");
    expect(pings(box)).toEqual([]);
    rmSync(box.pingFile);
    expectOutcome(hc(box, ["run"]), "current", "-");
    writeMode(box.pingFile, "HEALTHCHECKS_HOST_CONFIG_URL=\n", 0o600);
    expectOutcome(hc(box, ["run"]), "current", "-");
    expect(pings(box)).toEqual([]);
  });

  test.each<[string, (state: string) => string]>([
    ["schema 2", (state: string) => state.replace('"schema":1', '"schema":2')],
    ["invalid JSON", (state: string) => state.slice(0, 20)],
    ["zero length", () => ""],
    ["a missing key", (state: string) => state.replace(/,"busy_since":null/u, "")],
  ])("state.json with %s is needs-you state-schema", (_name, edit) => {
    const box = sandbox();
    bootstrap(box);
    const path = join(box.state, "state.json");
    writeMode(path, edit(readFileSync(path, "utf8")), 0o600);
    expectOutcome(hc(box, ["run"]), "needs-you", "state-schema");
  });

  test("only OWNER_UID may run it, and unknown words are the usage line", () => {
    const box = sandbox();
    expectOutcome(hc(box, ["run"], NOW, { HC_OWNER_UID: "99999" }), "needs-you", "not-root");
    const status = hc(box, ["status"], NOW, { HC_OWNER_UID: "99999" });
    expect({ code: status.code, err: status.stderr.trim() }).toEqual({
      code: 78,
      err: "needs-you not-root",
    });
    const usage = hc(box, ["run", "extra"]);
    expect(usage.code).toBe(64);
    expect(usage.stderr).toStartWith("usage: tarubot-host-config ");
    expect(usage.stdout).toBe("");
  });

  test("status reports the state read-only, never the ping URL", () => {
    const box = sandbox();
    bootstrap(box);
    const before = readFileSync(join(box.state, "state.json"), "utf8");
    const run = hc(box, ["status"]);
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines).toContain("role=staging");
    expect(lines).toContain(`applied=${base.c1} 2.34.0 bootstrap 2026-09-28T12:00:00Z`);
    expect(lines).toContain("failure=none");
    expect(lines).toContain("paused=no");
    expect(lines).toContain("signers=1");
    expect(lines).toContain("ping=yes");
    expect(lines).toContain("service=inactive");
    expect(run.stdout).not.toContain("ping.test");
    expect(readFileSync(join(box.state, "state.json"), "utf8")).toBe(before);
    for (const line of lines) expect(line).toMatch(/^[a-z_]+=/u);
  });
});
