/**
 * ops/deploy.sh, the deploy key's forced command on the production host (2.30.0, issue #41;
 * REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)").
 *
 * - Static checks pin the shell properties the key's safety rests on: strict mode, a fixed PATH and
 *   locale, main's umask first, no eval or tracing, stdout only through `say`, and a clean
 *   environment for the worker.
 * - The parser table runs the real script with hostile SSH_ORIGINAL_COMMAND values: each prints
 *   the usage line and exits 64 before any run directory, lock, git or Docker call.
 * - The log-contract tests pin the two bot log messages the recovery rule reads, in the bot's own
 *   source: an older copy of the script judges a newer release by them.
 * - The scenarios run the real worker against a throwaway git repository (a bare "origin" with
 *   one commit per release) and simulated `docker`, `curl`, `df` and `mktemp` commands on PATH
 *   (tests/fixtures/deploy-stubs), asserting the order of the calls that change something, the
 *   `.env` pin, the clone's commit and the result line: restart, migration, the modes of what git
 *   writes into the clone under main's umask, failed migration,
 *   failed health before and after the writer lease, what Compose shows after a failed start,
 *   rollback, superseded, the maintenance-window warning, already-live, the approval checked
 *   twice, host-lock contention, and every refusal before anything changes.
 * - The entry tests cover replay, starting over after a refusal before the approval, the worker
 *   cap, pruning, following a busy run, a dead worker, a conflicting request, the committed v1 run
 *   directory, the detached launch, and one request through main into the real worker.
 *
 * The Quadlet modes (2.33.0, #50: the forced command's words `quadlet` and `quadlet staging`) get
 * the same treatment against a simulated rootless Quadlet host: stubs for podman, systemctl,
 * journalctl, systemd-run and the Quadlet generator over the state in
 * tests/fixtures/deploy-stubs/sim.sh, answering in the shapes a local Podman 5.8.2 gave
 * (tests/fixtures/deploy-podman). Their tests pin the mode words, the contract level and the
 * capability words, the root-owned host lock, the staging run checks, the pin moving with the
 * evidence rule, and the separation of the two runtimes: the argument-less Compose mode calls no
 * Podman or systemd tool, and the Quadlet modes no docker.
 *
 * Scenarios need git and jq; the image build (oven/bun, which has neither) skips them, and CI's
 * checks job and the dev VM run them.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SCRIPT = root("ops/deploy.sh");
const STUBS = root("tests/fixtures/deploy-stubs");
const hasGit = Bun.which("git") !== null;
const hasJq = Bun.which("jq") !== null;
// The linux/arm64 image build runs the unit suite under QEMU, many times slower at starting
// processes, where two tests like these exceeded Bun's 5 s default (deploy-workflow.test.ts
// names them). Every test without a limit of its own gets two minutes here, which only stops a
// hang. The tests below that name a limit keep it: each bounds a wait on a real process (a lock
// holder, a detached worker, or a git scenario, which the image build skips without git and jq).
setDefaultTimeout(120_000);
/** The end-to-end entry test runs the real worker on its fixed PATH, which needs these there. */
const endToEnd = ["jq", "curl", "setsid", "flock"].every(
  (tool) => Bun.which(tool, { PATH: "/usr/local/bin:/usr/bin:/bin" }) !== null,
);
const RUN_ID = "36300000042";
/** A function body's lines without blank lines and comments, trimmed. */
const statements = (body: string) =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
/**
 * The umask main sets first: the static test pins its place and value, and a worker scenario runs
 * under it to show what git then writes into the clone.
 */
const MAIN_UMASK =
  /^main\(\) \{\n(?:\s*#[^\n]*\n)*\s*umask ([0-7]{3,4})$/mu.exec(
    readFileSync(SCRIPT, "utf8"),
  )?.[1] ?? "none";
const USAGE =
  "usage: deploy <version> <commit> <digest> <run> | rollback <version> <commit> <digest> <run> <from>";

/** Deterministic hex of a given length, so every release has stable fake digests. */
const hex = (seed: string, length = 64) =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);

const scratch = mkdtempSync(join(tmpdir(), "deploy-script-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** One test's private directories: HOME (with the script's state), the simulation and the stubs. */
interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly state: string;
  readonly sim: string;
  readonly bin: string;
}

/** The Quadlet host's tools, simulated over tests/fixtures/deploy-stubs/sim.sh. */
const QUADLET_TOOLS = [
  "podman",
  "systemctl",
  "journalctl",
  "systemd-run",
  "podman-system-generator",
];

let sandboxes = 0;
function sandbox(): Sandbox {
  const dir = join(scratch, `s${++sandboxes}`);
  const home = join(dir, "home");
  const sim = join(dir, "sim");
  const bin = join(dir, "bin");
  for (const path of [home, join(sim, "c"), join(sim, "versions"), join(sim, "knob"), bin])
    mkdirSync(path, { recursive: true });
  // Both runtimes' tools are on every sandbox's PATH, so a path that called the other runtime's
  // tools would reach a stub that logs it ($SIM/runtime).
  for (const name of ["docker", "curl", "df", "mktemp", ...QUADLET_TOOLS]) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(sim, "calls"), "");
  writeFileSync(join(sim, "runtime"), "");
  return { dir, home, state: join(home, ".local/state/tarubot-deploy"), sim, bin };
}

/** The environment every driver runs with: the stubs first, a private HOME and git config. */
const environment = (box: Sandbox, extra: Record<string, string> = {}) => ({
  HOME: box.home,
  PATH: `${box.bin}:/usr/local/bin:/usr/bin:/bin`,
  SIM: box.sim,
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  DEPLOY_SCRIPT: SCRIPT,
  DEPLOY_STATE: join(box.home, ".local/state/tarubot-deploy"),
  DEPLOY_STUBS: STUBS,
  ...extra,
});

/** Run a command to completion and return its status and output. */
function run(argv: string[], env: Record<string, string>, cwd = scratch) {
  const result = Bun.spawnSync(argv, { env, cwd, stdin: "ignore" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Hold a lock file from another process until killed, as a running deploy or worker holds it.
 * `flock -o` keeps the lock in flock itself, so killing it frees the lock at once.
 */
function holdLock(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const held = `${path}.held`;
  const holder = Bun.spawn(
    ["flock", "-o", path, "bash", "-c", 'touch "$1"; exec sleep 10', "holder", held],
    { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore" },
  );
  for (let i = 0; i < 300 && !existsSync(held); i++) Bun.sleepSync(10);
  return holder;
}

/** Run git with an isolated configuration, failing the test on an error. */
function git(cwd: string, ...args: string[]): string {
  const result = run(
    ["git", ...args],
    {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
    cwd,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// Static properties
// ---------------------------------------------------------------------------------------------

describe("the script's shape", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const lines = text.split("\n");
  /** The body of one top-level function, from its `name() {` line to the closing `}`. */
  const body = (name: string) => {
    const start = lines.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`no function ${name}`);
    const end = lines.indexOf("}", start);
    return lines.slice(start + 1, end).join("\n");
  };

  test("is valid bash in strict mode, with a fixed PATH, locale and private files in main", () => {
    expect(run(["bash", "-n", SCRIPT], { PATH: "/usr/bin:/bin" }).code).toBe(0);
    expect(text).toStartWith("#!/usr/bin/env bash\n");
    expect(text).toContain("\nset -Eeuo pipefail\n");
    expect(text).toContain("readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin\n");
    const main = body("main");
    // The mask is main's first statement, before the state directory, the entry log or a run
    // directory exists, and before git writes into the clone (the worker starts through main).
    expect(statements(main)[0]).toBe(`umask ${MAIN_UMASK}`);
    expect(MAIN_UMASK).toBe("077");
    expect(main).toContain("export LC_ALL=C PATH=$SAFE_PATH");
    expect(main).toContain('exec 2>>"$STATE/entry.log"');
    // The worker points its stderr at its own log.
    expect(body("worker")).toContain('exec 2>>"$RUN/worker.log"');
  });

  test("keeps only constants and functions at the top level, then the direct-run guard", () => {
    let depth = 0;
    const loose: string[] = [];
    for (const line of lines) {
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

  test("bounds every docker call with timeout(1), so a hung daemon can't hold the locks", () => {
    const calls = lines.filter((line) => !/^\s*#/u.test(line) && /\bdocker [a-z]/u.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const line of calls)
      expect({ line, bounded: /timeout (?:60|"\$limit") docker [a-z]/u.test(line) }).toEqual({
        line,
        bounded: true,
      });
  });

  test("never evaluates text, traces, or prints Compose's resolved configuration", () => {
    expect(text).not.toMatch(/\beval\b/u);
    expect(text).not.toMatch(/set -[a-zA-Z]*x/u);
    expect(text).not.toMatch(/\becho\b/u);
    for (const match of text.matchAll(/compose \d+ config[^\n]*/gu))
      expect(match[0]).toContain("config --quiet");
    // Every one-off and exec in the container runs without a TTY.
    const containerCalls = [...text.matchAll(/compose \d+ (run|exec)\b[^\n]*/gu)];
    expect(containerCalls.length).toBeGreaterThanOrEqual(3);
    for (const [call] of containerCalls) expect(call).toContain(" -T ");
  });

  test("the entry writes the client's stdout only through say", () => {
    for (const name of [
      "entry",
      "conflict",
      "too_many_workers",
      "refuse_unstarted",
      "retryable",
      "start_over",
      "emit_new",
      "replay",
      "follow",
      "worker_died",
      "prune",
    ])
      for (const line of body(name).split("\n"))
        if (/\bprintf\b/u.test(line))
          expect({ name, line, private: /\$\(printf|>/u.test(line) }).toEqual({
            name,
            line,
            private: true,
          });
    // The worker starts with a clean environment in its own session, its output in its log.
    const launch = body("launch");
    expect(launch).toContain('env -i HOME="$HOME" PATH="$SAFE_PATH" LC_ALL=C');
    expect(launch).toContain('setsid -f "$SELF" __worker');
    expect(launch).toContain('</dev/null >>"$RUN/worker.log" 2>&1');
  });
});

// ---------------------------------------------------------------------------------------------
// The Quadlet modes' static properties and seams
// ---------------------------------------------------------------------------------------------

/** The owner's account, as GitHub's API names it. */
const OWNER = { login: "deconfined", id: 71469756 };
/** The bot's six secrets (REQUIREMENTS.md, #50 question 8 as amended). */
const SECRETS = [
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_PING_URL",
];
/** The 14 names tarubot.service's UnsetEnvironment= drops, in the unit's order. */
const UNSET = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "BACKUP_STORAGE_REGION",
  "HEALTHCHECKS_BACKUP_URL",
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_PING_URL",
  "POSTGRES_PASSWORD",
  "RESTORE_DATABASE_CA_CERT",
  "RESTORE_DATABASE_URL",
];

describe("the Quadlet modes' shape", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const lines = text.split("\n");
  /** The script's commands: continuation lines joined, comment lines left out. */
  const commands = text
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line));
  /** Every top-level function's body, without its comment lines. */
  const functions = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const name = /^([a-z_]+)\(\) \{$/u.exec(lines[i] ?? "")?.[1];
    if (!name) continue;
    const end = lines.indexOf("}", i);
    functions.set(
      name,
      lines
        .slice(i + 1, end)
        .filter((line) => !/^\s*#/u.test(line))
        .join("\n"),
    );
  }
  /** A single-quoted constant's words. */
  const words = (name: string) =>
    (new RegExp(`^readonly ${name}='([^']*)'$`, "mu").exec(text)?.[1] ?? "").split(" ");
  /** The tools only a Quadlet host has, as a command would name them. */
  const QUADLET_CALL = /\b(podman|systemctl|journalctl|systemd-run) |"\$GENERATOR"/u;

  test("pins the two contract levels, the capability declaration and the host's fixed names", () => {
    // Compose keeps its floor; the Quadlet modes have their own.
    expect(text).toContain("\nreadonly FLOOR=2.30.0\n");
    expect(text).toContain("\nreadonly QUADLET_FLOOR=2.33.0\n");
    // Exactly one declaration, in the form the workflow and the playbook read.
    const declaration = /^readonly CAPABILITIES="([a-z0-9]+( [a-z0-9]+)*)"$/gmu;
    expect([...text.matchAll(declaration)].map((m) => m[1])).toEqual(["staging quadlet"]);
    // Targets are checked with the same pattern.
    expect(text).toContain(`\nreadonly CAPABILITY_LINE='${declaration.source}'\n`);
    expect(text).toContain("\nreadonly QUADLET_LOCK=/run/tarubot/host.lock\n");
    expect(text).toContain(
      "\nreadonly GENERATOR=/usr/lib/systemd/system-generators/podman-system-generator\n",
    );
    expect(text).toContain("\nreadonly STAGING_JOB='Deploy staging'\n");
    // The real generator call, which run-worker.sh swaps for the stand-in.
    expect(functions.get("q_generate")?.trim()).toBe('timeout 60 "$GENERATOR" --user --dryrun');
  });

  test("lists the six secrets and the 14 names the unit unsets, in the unit's order", () => {
    expect(words("SECRET_SETTINGS")).toEqual(SECRETS);
    expect([...SECRETS].sort()).toEqual(SECRETS);
    expect(words("UNSET_SETTINGS")).toEqual(UNSET);
    expect(new Set(UNSET).size).toBe(14);
    for (const name of SECRETS)
      expect({ name, unset: UNSET.includes(name) }).toEqual({ name, unset: true });
  });

  test("bounds every Podman, systemd and generator call with timeout(1), always as the user", () => {
    let count = 0;
    for (const line of commands) {
      for (const match of line.matchAll(new RegExp(QUADLET_CALL.source, "gu"))) {
        count++;
        const before = line.slice(0, match.index);
        expect({ line, bounded: /timeout \d+ $/u.test(before) }).toEqual({ line, bounded: true });
        const tool = match[1] ?? "generator";
        const after = line.slice((match.index ?? 0) + match[0].length);
        if (tool === "systemctl" || tool === "journalctl" || tool === "systemd-run")
          expect({ line, user: after.startsWith("--user ") }).toEqual({ line, user: true });
        if (tool === "systemd-run")
          expect({ line, literal: after.includes(" --expand-environment=no ") }).toEqual({
            line,
            literal: true,
          });
        if (tool === "podman" && /^(exec|run) /u.test(after))
          expect({ line, tty: /(^| )-(t|it|ti)( |$)|--tty/u.test(after) }).toEqual({
            line,
            tty: false,
          });
      }
    }
    expect(count).toBeGreaterThanOrEqual(25);
  });

  test("never reaches a remote Podman or its API socket, whose absence is a host check", () => {
    for (const forbidden of ["--remote", "CONTAINER_HOST", "DOCKER_HOST", "system service"])
      expect({ forbidden, found: text.includes(forbidden) }).toEqual({ forbidden, found: false });
    expect(lines.filter((line) => line.includes("podman.sock"))).toEqual([
      "  [[ ! -e $XDG_RUNTIME_DIR/podman/podman.sock ]] || refuse host",
    ]);
  });

  test("keeps the runtimes apart: Compose functions call no Quadlet tool, q_ functions no docker", () => {
    expect(functions.size).toBeGreaterThan(80);
    for (const [name, body] of functions) {
      if (name.startsWith("q_"))
        expect({ name, docker: /\b(docker|compose)\b/u.test(body) }).toEqual({
          name,
          docker: false,
        });
      else expect({ name, quadlet: QUADLET_CALL.test(body) }).toEqual({ name, quadlet: false });
    }
  });

  test("every runtime step has both twins, and every other q_ function is a named helper", () => {
    const twins = [
      "check_env",
      "check_host",
      "read_live",
      "wait_for_backup",
      "check_target",
      "stage",
      "already_live",
      "restart_path",
      "migration_path",
      "stop_one_offs",
      "verify_started",
      "run_commands",
      "evidence",
      "recover_restart",
      "restore_previous",
      "pin_env",
    ];
    // The seams tests may replace, and the helpers only the Quadlet path needs.
    const helpers = [
      "q_runtime_dir",
      "q_lingering",
      "q_lock_trusted",
      "q_session",
      "q_links_ok",
      "q_unit_state",
      "q_hardened",
      "q_generate",
      "q_quadlet_config",
      "q_mark",
      "q_pinned",
      "q_wait_healthy",
      "q_restarts",
      "q_register",
    ];
    for (const name of twins)
      expect({ name, compose: functions.has(name), quadlet: functions.has(`q_${name}`) }).toEqual({
        name,
        compose: true,
        quadlet: true,
      });
    const quadlet = [...functions.keys()].filter((name) => name.startsWith("q_")).sort();
    expect(quadlet).toEqual([...twins.map((name) => `q_${name}`), ...helpers].sort());
    // The worker and preflight call each step by the runtime's prefix, never by eval.
    for (const name of ["already_live", "stage", "restart_path", "migration_path"])
      expect(functions.get("worker")).toContain(`"\${RT}${name}"`);
    for (const name of ["check_env", "check_host", "read_live", "wait_for_backup", "check_target"])
      expect(functions.get("preflight")).toContain(`"\${RT}${name}"`);
    expect(functions.get("commands_then")).toContain(`if "\${RT}run_commands"; then`);
  });

  test("closes both locks for the backup and the tool, whose containers may leave a conmon behind", () => {
    const calls = commands.filter((line) => /ops\/(backup\.sh|quadlet\/run-tool\.sh)"/u.test(line));
    expect(calls.length).toBe(3);
    for (const line of calls) {
      if (line.includes("backup.sh") && !line.includes(" quadlet")) {
        // Compose's call, unchanged.
        expect(line).toContain('out=$(timeout 900 "$ROOT/ops/backup.sh"); then');
        continue;
      }
      expect({ line, closed: / 8>&- 9<&-\)/u.test(line) }).toEqual({ line, closed: true });
    }
    expect(functions.get("q_migration_path")).toContain(
      'if out=$(timeout 900 "$ROOT/ops/backup.sh" quadlet 8>&- 9<&-); then ok=1; fi',
    );
  });

  test("preflight picks the lock by mode: Compose's own file, or the root-owned one read-only", () => {
    const preflight = statements(functions.get("preflight") ?? "");
    expect(preflight).toEqual([
      "check_approval",
      "if [[ $MODE == compose ]]; then",
      'exec 9>>"$STATE/lock"',
      "else",
      'q_lock_trusted "$HOST_LOCK" || refuse host',
      'exec 9<"$HOST_LOCK" || refuse host',
      "fi",
      "flock -w 300 9 || refuse busy",
      "check_clone",
      ...["check_env", "check_host", "read_live", "wait_for_backup", "check_target"].map(
        (step) => `"\${RT}${step}"`,
      ),
    ]);
    // main sets the Quadlet host's real paths, which the tests point at a sandbox.
    expect(functions.get("main")).toContain(
      "HOST_LOCK=$QUADLET_LOCK LINGER_DIR=/var/lib/systemd/linger RUNTIME_ROOT=/run/user",
    );
  });

  test("the header lists every surface of the quadlet contract", () => {
    const header = lines
      .slice(0, lines.indexOf("set -Eeuo pipefail"))
      .join("\n")
      .replace(/\n#\s*/gu, " ");
    for (const surface of [
      "quadlet staging",
      "~/.config/containers/systemd",
      "tarubot-target",
      "tarubot.service",
      "TARUBOT_IMAGE_TAG=<version>",
      "TARUBOT_IMAGE_DIGEST=sha256:<index digest>",
      "/run/tarubot/host.lock",
      "tarubot_host_lock_held=true",
      "ops/quadlet/check-env.sh",
      "ops/quadlet/secrets.sh (check|sync ENV [NAME...])",
      "ops/quadlet/run-tool.sh (TARGET DIGEST NAME COMMAND...)",
      "SECRET_SETTINGS and UNSET_SETTINGS",
      "PODMAN_SYSTEMD_UNIT=tarubot.service",
      "io.tarubot.role=tool",
      "io.tarubot.role=backup",
      "tarubot-backup.service",
      "`ops/backup.sh quadlet`",
      "BACKUP_DONE",
      "CONTAINER_ID_FULL",
      "---tarubot.service---",
      "Loading source unit file",
      "Loading source drop-in file",
      ".State.Health.Status",
      'register.js --guild "$TEST_GUILD_ID"',
      "replaces the word `quadlet`",
    ])
      expect({ surface, listed: header.includes(surface) }).toEqual({ surface, listed: true });
  });

  test("the contract list names what the generator, hardening and registration checks rely on", () => {
    const header = lines
      .slice(0, lines.indexOf("set -Eeuo pipefail"))
      .join("\n")
      .replace(/\n#\s*/gu, " ");
    // Each check runs against another release's unit and container, so what it expects is part
    // of the contract: a change to one of these functions must touch the header's list too.
    for (const name of ["q_quadlet_config", "q_hardened", "q_run_commands", "q_register"])
      expect({ name, listed: header.includes(name) }).toEqual({ name, listed: true });
    // Every inspect field the hardening read-back reads, found in the function itself.
    const hardened = functions.get("q_hardened") ?? "";
    const fields = [...new Set(hardened.match(/(?<![\w\]])\.[A-Z]\w*(?:\.[A-Z]\w*)*/gu))];
    expect(fields.sort()).toEqual(
      [
        ".Config.Env",
        ".EffectiveCaps",
        ".HostConfig.Binds",
        ".HostConfig.CapAdd",
        ".HostConfig.ReadonlyRootfs",
        ".HostConfig.SecurityOpt",
        ".Mounts",
      ].sort(),
    );
    for (const field of [...fields, "no-new-privileges", "UNSET_SETTINGS"])
      expect({ field, listed: header.includes(field) }).toEqual({ field, listed: true });
    expect(hardened).toContain('"no-new-privileges"');
    expect(hardened).toContain('--arg unset "$UNSET_SETTINGS"');
    // The health status every wait reads.
    for (const name of ["q_wait_healthy", "q_verify_started", "q_already_live"])
      expect({ name, health: functions.get(name)?.includes(".State.Health.Status") }).toEqual({
        name,
        health: true,
      });
    // The generator's output, as q_quadlet_config matches it and as the header describes it.
    const config = functions.get("q_quadlet_config") ?? "";
    for (const [inFunction, inHeader] of [
      ["[[ $headers == ---tarubot.service--- ]]", "---tarubot.service---"],
      [
        "--env-file %h/tarubot/ops/quadlet/units/tarubot[.]env (.* )?--env-file %h/tarubot/ops/quadlet/$TARGET/target[.]env",
        "--env-file %h/tarubot/ops/quadlet/units/tarubot.env and then --env-file %h/tarubot/ops/quadlet/<target>/target.env",
      ],
      [
        `" $IMAGE@\\\${TARUBOT_IMAGE_DIGEST}"`,
        `ghcr.io/deconfined/tarubot@\${TARUBOT_IMAGE_DIGEST}`,
      ],
      ["Loading source (unit|drop-in) file", "Loading source unit file"],
      ['"$root/ops/quadlet/units/"*', "units/ or <target>/"],
      ['"$root/ops/quadlet/$TARGET/"*', "units/ or <target>/"],
    ] as const)
      expect({
        inFunction,
        inHeader,
        found: config.includes(inFunction),
        listed: header.includes(inHeader),
      }).toEqual({ inFunction, inHeader, found: true, listed: true });
    // The registration commands, run in the container with its own environment.
    const register = `${functions.get("q_register") ?? ""}\n${functions.get("q_run_commands") ?? ""}`;
    for (const command of [
      "bun dist/scripts/register.js --global",
      'bun dist/scripts/register.js --guild "$TEST_GUILD_ID"',
      "bun dist/scripts/commands.js list",
    ]) {
      expect({ command, run: register.includes(command) }).toEqual({ command, run: true });
      const words = command.replace("bun dist/scripts/", "");
      expect({ words, listed: header.includes(words) }).toEqual({ words, listed: true });
    }
  });
});

describe("the mode words and the Quadlet seams", () => {
  const call = (env: Record<string, string>, ...args: string[]) =>
    run(["bash", join(STUBS, "call.sh"), ...args], environment(sandbox(), env));

  test("select Compose, production's Quadlet mode or staging, and nothing else", () => {
    const mode = (...args: string[]) => {
      const done = call({}, "mode", ...args);
      return done.code === 0 ? done.stdout.trim() : done.code;
    };
    expect(mode()).toBe("compose|production||");
    expect(mode("quadlet")).toBe("quadlet|production|q_|quadlet");
    expect(mode("quadlet", "staging")).toBe("staging|staging|q_|quadlet staging");
    for (const bad of [
      ["staging"],
      ["podman"],
      ["quadlet", "x"],
      ["quadlet", "staging", "x"],
      ["staging", "quadlet"],
      ["quadlet staging"],
      ["QUADLET"],
      [""],
    ])
      expect({ bad, result: mode(...bad) }).toEqual({ bad, result: 64 });
  });

  test("the runtime directory is /run/user/<uid>, and linger is the user's file", () => {
    expect(call({}, "q_runtime_dir").stdout).toBe(`/run/user/${process.getuid?.()}`);
    const linger = join(sandbox().dir, "linger");
    mkdirSync(linger);
    const lingering = () =>
      call({ DEPLOY_LINGER_DIR: linger, USER: userInfo().username }, "q_lingering").code;
    expect(lingering()).not.toBe(0);
    writeFileSync(join(linger, userInfo().username), "");
    expect(lingering()).toBe(0);
  });

  test("only a root-owned regular file, not a link, is a trusted lock", () => {
    const box = sandbox();
    const trusted = (path: string) => call({}, "q_lock_trusted", path).code === 0;
    // A root-owned regular file every system has.
    expect(trusted("/etc/passwd")).toBe(true);
    const link = join(box.dir, "lock-link");
    symlinkSync("/etc/passwd", link);
    expect(trusted(link)).toBe(false);
    expect(trusted(join(box.dir, "missing"))).toBe(false);
    expect(trusted("/etc")).toBe(false);
    const own = join(box.dir, "own");
    writeFileSync(own, "");
    expect(trusted(own)).toBe(process.getuid?.() === 0);
  });

  // The hardening check runs jq, which the image build's stage lacks.
  test.skipIf(!hasJq)("the captured Podman 5.8.2 answers read back as the stubs serve them", () => {
    const fixtures = root("tests/fixtures/deploy-podman");
    // The container the unit's flags made reads back as hardened, through the real check.
    const container = readFileSync(join(fixtures, "container.json"), "utf8");
    expect(call({}, "q_hardened", container).code).toBe(0);
    const parsed = JSON.parse(container)[0];
    // Its secrets show only in Config.Secrets, never as mounts, so the check allows no mount at
    // all: one where a secret's file goes (a host file, or a volume) could stand in for it.
    expect(parsed.Config.Secrets.map((secret: { Name: string }) => secret.Name)).toEqual([
      "tarubot-database-url",
      "tarubot-database-ca-cert",
    ]);
    expect({ mounts: parsed.Mounts, binds: parsed.HostConfig.Binds }).toEqual({
      mounts: [],
      binds: [],
    });
    for (const [mount, bind] of [
      [
        { Type: "bind", Source: "/srv/url", Destination: "/run/secrets/database_url" },
        "/srv/url:/run/secrets/database_url:ro,rprivate,rbind",
      ],
      [
        { Type: "volume", Name: "tokens", Destination: "/run/secrets/discord_token" },
        "tokens:/run/secrets/discord_token:ro,rprivate,rbind",
      ],
    ] as const) {
      const changed = JSON.parse(container);
      changed[0].Mounts = [mount];
      changed[0].HostConfig.Binds = [bind];
      expect({ mount, hardened: call({}, "q_hardened", JSON.stringify(changed)).code }).toEqual({
        mount,
        hardened: 1,
      });
      // Either field alone is enough.
      changed[0].Mounts = [];
      expect(call({}, "q_hardened", JSON.stringify(changed)).code).toBe(1);
    }
    expect(parsed.Image).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.Id).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.State.Health.Status).toBe("healthy");
    // A pull by index digest leaves that digest in RepoDigests, and a bare hex Id.
    const image = JSON.parse(readFileSync(join(fixtures, "image.json"), "utf8"))[0];
    expect(image.RepoDigests).toContain(`ghcr.io/deconfined/tarubot@${image.Digest}`);
    expect(image.Id).toMatch(/^[0-9a-f]{64}$/u);
    expect(image.Config.Labels["org.opencontainers.image.version"]).toMatch(/^\d+\.\d+\.\d+$/u);
    // Events: one JSON object a line, with the fields the evidence reads.
    const events = readFileSync(join(fixtures, "events.jsonl"), "utf8").trim().split("\n");
    expect(events.map((line) => JSON.parse(line).Status)).toEqual(["start", "died"]);
    for (const line of events) {
      const event = JSON.parse(line);
      expect(event).toMatchObject({ Name: "tarubot", Type: "container" });
      expect(event.ID).toMatch(/^[0-9a-f]{64}$/u);
      expect(event.Image).toMatch(/^ghcr\.io\/deconfined\/tarubot@sha256:[0-9a-f]{64}$/u);
      expect(typeof event.timeNano).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The bot's log messages the recovery rule reads
// ---------------------------------------------------------------------------------------------

describe("the log messages the recovery rule reads", () => {
  const script = readFileSync(SCRIPT, "utf8");
  /** The message text of a `readonly NAME='"msg":"…"'` constant. */
  const message = (name: string) => {
    const found = new RegExp(`readonly ${name}='"msg":"([^"]+)"'`, "u").exec(script)?.[1];
    if (!found) throw new Error(`no ${name}`);
    return found;
  };
  const lease = message("LEASE_LINE");
  const modules = message("MODULES_LINE");
  const lifecycle = readFileSync(root("src/application/lifecycle.ts"), "utf8");
  const main = readFileSync(root("src/main.ts"), "utf8");
  /** How often a string literal with exactly this text appears anywhere in src/. */
  const inSource = (text: string) => {
    let count = 0;
    for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: root("") }))
      count += readFileSync(root(file), "utf8").split(`"${text}"`).length - 1;
    return count;
  };
  /** A pino info call on `receiver` whose message is exactly `text`. */
  const infoCall = (receiver: string, text: string) =>
    new RegExp(`${receiver}\\.info\\(\\s*\\{[^}]*\\},\\s*"${text}",?\\s*\\)`, "u");

  test("the lifecycle logs the lease message at info, on its one lease path", () => {
    expect(lease).toBe("Database writer lease acquired");
    expect(inSource(lease)).toBe(1);
    // The lifecycle takes one session lock, and the info call follows it before the return.
    expect(lifecycle.split("pg_try_advisory_lock").length - 1).toBe(1);
    const lock = lifecycle.indexOf('"SELECT pg_try_advisory_lock($1::bigint) AS locked"');
    const call = infoCall("this\\.log", lease).exec(lifecycle);
    expect(lock).toBeGreaterThan(0);
    expect(call?.index ?? -1).toBeGreaterThan(lock);
    expect(lifecycle.slice(lock, call?.index)).not.toContain("return");
  });

  test("main logs 'Modules loaded' at info before it asks for the lease", () => {
    expect(modules).toBe("Modules loaded");
    expect(inSource(modules)).toBe(1);
    const call = infoCall("\\blog", modules).exec(main);
    const prepare = main.indexOf("await lifecycle.prepare()");
    expect(call).not.toBeNull();
    expect(prepare).toBeGreaterThan(0);
    expect(call?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(prepare);
  });
});

// ---------------------------------------------------------------------------------------------
// The request parser
// ---------------------------------------------------------------------------------------------

describe("the request parser", () => {
  const commit = hex("commit", 40);
  const digest = `sha256:${hex("digest")}`;
  const valid = `deploy 2.30.1 ${commit} ${digest} ${RUN_ID}`;

  /** Run the real script (main) as sshd would, with a request and the caller's locale. */
  function asForcedCommand(request: string, locale = "C.UTF-8") {
    const box = sandbox();
    const result = run(["bash", SCRIPT], {
      HOME: box.home,
      PATH: "/usr/bin:/bin",
      LC_ALL: locale,
      SSH_ORIGINAL_COMMAND: request,
    });
    const runs = existsSync(join(box.state, "runs")) ? readdirSync(join(box.state, "runs")) : [];
    const log = readFileSync(join(box.state, "entry.log"), "utf8");
    return { ...result, runs, log };
  }

  const hostile: [string, string][] = [
    ["empty", ""],
    ["a shell", "bash"],
    ["sftp", "internal-sftp"],
    ["scp", "scp -t ."],
    ["a chained command", `${valid}; id`],
    ["a newline", `${valid}\nid`],
    ["a trailing space", `${valid} `],
    ["a 39-digit commit", `deploy 2.30.1 ${commit.slice(1)} ${digest} ${RUN_ID}`],
    ["uppercase hex", `deploy 2.30.1 ${commit.toUpperCase()} ${digest} ${RUN_ID}`],
    ["a leading zero", `deploy 02.30.1 ${commit} ${digest} ${RUN_ID}`],
    ["a pre-release", `deploy 2.30.1-rc.1 ${commit} ${digest} ${RUN_ID}`],
    ["a status query", "status"],
    ["a rollback without from", `rollback 2.30.0 ${commit} ${digest} ${RUN_ID}`],
    ["a deploy with from", `${valid} 2.30.0`],
    ["run id zero", `deploy 2.30.1 ${commit} ${digest} 0`],
    ["a digest without its algorithm", `deploy 2.30.1 ${commit} ${hex("digest")} ${RUN_ID}`],
    ["201 bytes", `${valid} ${"x".repeat(200 - valid.length)}`],
    ["Arabic-Indic digits", `deploy ٢.٣٠.١ ${commit} ${digest} ${RUN_ID}`],
    ["a quoted field", `deploy '2.30.1' ${commit} ${digest} ${RUN_ID}`],
  ];

  test.each(hostile)("refuses %s with the usage line, before any run or tool", (_, request) => {
    const result = asForcedCommand(request);
    expect(result.code).toBe(64);
    expect(result.stdout).toBe(`${USAGE}\n`);
    expect(result.runs).toEqual([]);
    // The log keeps a sanitized, single-line copy: newlines and anything else unusual become ?.
    const logged = result.log.trim().split("\n");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/refused request:(?: [A-Za-z0-9 ._:?-]{0,200})?$/u);
  });

  test("the forced command's mode words: only none, quadlet and quadlet staging reach the request", () => {
    /** main with these words and request, as sshd runs the forced command. */
    const forced = (words: string[], request: string) => {
      const box = sandbox();
      const result = run(["bash", SCRIPT, ...words], {
        HOME: box.home,
        PATH: "/usr/bin:/bin",
        LC_ALL: "C.UTF-8",
        SSH_ORIGINAL_COMMAND: request,
      });
      const runs = existsSync(join(box.state, "runs")) ? readdirSync(join(box.state, "runs")) : [];
      const log = readFileSync(join(box.state, "entry.log"), "utf8").trim().split("\n");
      return { ...result, runs, log };
    };
    // Accepted words reach the request parser, which refuses a status query as it always has.
    for (const words of [[], ["quadlet"], ["quadlet", "staging"]]) {
      const accepted = forced(words, "status");
      expect({ words, code: accepted.code, stdout: accepted.stdout, runs: accepted.runs }).toEqual({
        words,
        code: 64,
        stdout: `${USAGE}\n`,
        runs: [],
      });
      expect({ words, log: accepted.log.map((l) => l.replace(/^\S+ /u, "")) }).toEqual({
        words,
        log: ["refused request: status"],
      });
    }
    // Any other words stop main before the request is read: even a valid one gets no run
    // directory, lock, git or runtime call.
    for (const words of [
      ["staging"],
      ["podman"],
      ["quadlet", "x"],
      ["quadlet", "staging", "x"],
      ["staging", "quadlet"],
      ["quadlet staging"],
      ["__worker"],
    ]) {
      const refused = forced(words, valid);
      expect({ words, code: refused.code, stdout: refused.stdout, runs: refused.runs }).toEqual({
        words,
        code: 64,
        stdout: words[0] === "__worker" ? "" : `${USAGE}\n`,
        runs: [],
      });
      if (words[0] !== "__worker")
        expect({ words, log: refused.log.map((l) => l.replace(/^\S+ /u, "")) }).toEqual({
          words,
          log: ["unknown mode words"],
        });
    }
  });

  test("the 201-byte limit counts bytes, and 200 bytes of padding-free input is the maximum", () => {
    expect(`${valid} ${"x".repeat(200 - valid.length)}`).toHaveLength(201);
    // The longest valid rollback is well inside the limit.
    const longest = `rollback 9999.9999.9999 ${commit} ${digest} ${"9".repeat(20)} 9999.9999.9999`;
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(200);
  });

  test("reads the fields from BASH_REMATCH at the pinned indices", () => {
    const box = sandbox();
    const parse = (request: string) =>
      run(["bash", join(STUBS, "call.sh"), "parse", request], environment(box)).stdout.trim();
    expect(parse(valid)).toBe(`deploy|2.30.1|${commit}|${digest}|${RUN_ID}|-`);
    expect(parse(`rollback 2.30.0 ${commit} ${digest} ${RUN_ID} 2.30.1`)).toBe(
      `rollback|2.30.0|${commit}|${digest}|${RUN_ID}|2.30.1`,
    );
    expect(parse(`deploy 9999.0.10 ${commit} ${digest} ${"9".repeat(20)}`)).toBe(
      `deploy|9999.0.10|${commit}|${digest}|${"9".repeat(20)}|-`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

describe("the helpers", () => {
  /** Call one script function; returns its status and output. */
  const call = (...args: string[]) =>
    run(["bash", join(STUBS, "call.sh"), ...args], environment(sandbox()));

  test("versions compare numerically", () => {
    const older = (a: string, b: string) => call("version_lt", a, b).code === 0;
    expect(older("2.9.0", "2.10.0")).toBe(true);
    expect(older("2.30.0", "2.30.0")).toBe(false);
    expect(older("2.30.1", "2.30.0")).toBe(false);
    expect(older("2.29.2", "2.30.0")).toBe(true);
    expect(older("3.0.0", "2.99.99")).toBe(false);
  });

  test("migration changes classify as none, added or changed", () => {
    const kind = (diff: string) => call("migration_kind", diff).stdout;
    expect(kind("")).toBe("none");
    expect(kind("A\tmigrations/011_x.sql")).toBe("added");
    expect(kind("A\tmigrations/011_x.sql\nA\tmigrations/012_y.sql")).toBe("added");
    expect(kind("M\tmigrations/001_init.sql")).toBe("changed");
    expect(kind("A\tmigrations/011_x.sql\nD\tmigrations/010_old.sql")).toBe("changed");
    expect(kind("T\tmigrations/001_init.sql")).toBe("changed");
  });

  test("the log level must keep info-level lines", () => {
    const ok = (value: string) => call("log_level_ok", value).code === 0;
    for (const value of ["", "info", "debug", "trace", '"info"', "'debug'"])
      expect({ value, ok: ok(value) }).toEqual({ value, ok: true });
    for (const value of ["warn", "error", "fatal", "silent", "INFO", '"warn"'])
      expect({ value, ok: ok(value) }).toEqual({ value, ok: false });
  });

  test("tokens that don't match their pattern print as ?", () => {
    const token = (...args: string[]) => call("token", ...args).stdout;
    expect(token("version", "2.30.0")).toBe("2.30.0");
    expect(token("version", "2.30.0\nx")).toBe("?");
    expect(token("version", "-")).toBe("?");
    expect(token("version", "-", "dash")).toBe("-");
    expect(token("reason", "worker-died")).toBe("worker-died");
    expect(token("reason", "Worker died")).toBe("?");
    expect(token("int", "31")).toBe("31");
    expect(token("int", "123456")).toBe("?");
    expect(token("backup", "daily/tarubot-20260929T193000Z.dump.age")).toBe(
      "daily/tarubot-20260929T193000Z.dump.age",
    );
    expect(token("backup", "daily/../x")).toBe("?");
    expect(token("unknown", "x")).toBe("?");
  });

  test("the restore point is normalized to UTC with microseconds", () => {
    const point = (text: string) => call("restore_point", text).stdout;
    expect(
      point(
        "Migration writer lease acquired at 2026-09-29 19:30:05.123456+00; applied 011_x.sql; committing at 2026-09-29 19:30:06+00.\nSchema ready.",
      ),
    ).toBe("2026-09-29T19:30:05.123456Z");
    expect(
      point("Migration writer lease acquired at 2026-09-29 21:30:05.1+02; applied a; committing"),
    ).toBe("2026-09-29T19:30:05.100000Z");
    expect(point("Schema ready.")).toBe("-");
    expect(point("Migration writer lease acquired at yesterday-ish; applied a")).toBe("-");
  });
});

// ---------------------------------------------------------------------------------------------
// Worker scenarios against a throwaway repository and simulated Docker
// ---------------------------------------------------------------------------------------------

/** One release of the fixture repository and its fake registry identity. */
interface Release {
  readonly version: string;
  readonly commit: string;
  readonly digest: string;
  readonly image: string;
}
const releases = new Map<string, Release>();
let origin = "";

beforeAll(() => {
  if (!hasGit || !hasJq) return;
  origin = join(scratch, "origin.git");
  const work = join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "-b", "main", origin);
  git(scratch, "init", "--quiet", "-b", "main", work);
  mkdirSync(join(work, "ops"));
  mkdirSync(join(work, "migrations"));
  cpSync(join(STUBS, "backup.sh"), join(work, "ops/backup.sh"));
  chmodSync(join(work, "ops/backup.sh"), 0o755);
  writeFileSync(join(work, "docker-compose.production.yml"), "services: {}\n");
  writeFileSync(join(work, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(work, "migrations/001_init.sql"), "CREATE TABLE t (id int);\n");
  const release = (version: string, message: string) => {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
    git(work, "add", "-A");
    git(work, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
    releases.set(version, {
      version,
      commit: git(work, "rev-parse", "HEAD"),
      digest: `sha256:${hex(`digest ${version}`)}`,
      image: `sha256:${hex(`image ${version}`)}`,
    });
  };
  release("2.29.2", "Below the floor");
  release("2.30.0", "The floor");
  release("2.30.1", "A restart release");
  writeFileSync(join(work, "migrations/002_more.sql"), "ALTER TABLE t ADD COLUMN n int;\n");
  release("2.31.0", "A migration release");
  writeFileSync(join(work, "migrations/001_init.sql"), "CREATE TABLE t (id bigint);\n");
  release("2.31.1", "An edited applied migration");
  // The Quadlet releases (2.33.0, #50): the stand-ins for ops/quadlet, and an ops/deploy.sh that
  // holds only the release's declaration, which the Quadlet modes read at the target commit.
  cpSync(join(STUBS, "quadlet"), join(work, "ops/quadlet"), { recursive: true });
  for (const name of ["check-env.sh", "secrets.sh", "run-tool.sh"])
    chmodSync(join(work, "ops/quadlet", name), 0o755);
  const declares = (line: string) =>
    writeFileSync(
      join(work, "ops/deploy.sh"),
      `#!/usr/bin/env bash\n# A stand-in for this release's ops/deploy.sh (tests/unit/deploy-script.test.ts).\n${line}\n`,
    );
  declares("readonly FLOOR=2.30.0");
  release("2.32.0", "Without the Quadlet contract");
  declares('readonly CAPABILITIES="staging quadlet"');
  release("2.33.0", "The Quadlet floor");
  release("2.33.1", "A Quadlet restart release");
  declares('readonly CAPABILITIES="quadlet"');
  release("2.33.2", "Production's Quadlet mode only");
  declares('# readonly CAPABILITIES="staging quadlet"\nCAPABILITIES="staging quadlet"');
  release("2.33.3", "The words only in a comment and a plain assignment");
  declares('readonly CAPABILITIES="staging quadlet"');
  writeFileSync(join(work, "migrations/003_more.sql"), "ALTER TABLE t ADD COLUMN m int;\n");
  release("2.34.0", "A Quadlet migration release");
  git(work, "push", "--quiet", origin, "main");
});

/** What a scenario sets up, beyond a healthy live release and an approved dispatch. */
interface Scenario {
  /** The live release. */
  readonly live: string;
  /** "deploy V", "rollback V from F", optionally with "@<commit>" to override the commit. */
  readonly request: string;
  readonly knobs?: Record<string, string>;
  readonly env?: string;
  readonly envMode?: number;
  /** .env is a symlink to a file with the same content. */
  readonly envSymlink?: boolean;
  readonly liveStatus?: string;
  readonly liveHealth?: string;
  readonly run?: Record<string, unknown>;
  readonly approvals?: unknown;
  /** The run's jobs answer (a string is written as it is); by default Deploy is in progress. */
  readonly jobs?: unknown;
  /** How GitHub answers for the run from its second request on (a change while it waited). */
  readonly runLater?: Record<string, unknown>;
  /** Another process holds the host lock while the worker runs. */
  readonly holdHostLock?: boolean;
  readonly now?: string;
  readonly dirty?: boolean;
  /**
   * The worker runs under this umask, as main sets it for the real worker. The clone's files then
   * start group-writable (664, scripts 775), as a hand `git pull` under the host user's 0002
   * leaves them.
   */
  readonly umask?: string;
}

/** The fields of a result line. */
type Result = Record<string, string>;

function scenario(s: Scenario) {
  const box = sandbox();
  const repo = join(box.dir, "root");
  git(box.dir, "clone", "--quiet", origin, repo);
  const live = releases.get(s.live);
  if (!live) throw new Error(`no release ${s.live}`);
  git(repo, "reset", "--quiet", "--hard", live.commit);
  // Set, not added: files 664 and scripts and directories 775 whatever the test runner's own umask
  // gave the clone (under 077, `g+w` alone left 620).
  if (s.umask) run(["chmod", "-R", "u=rwX,g=rwX,o=rX", repo], { PATH: "/usr/bin:/bin" });
  if (s.dirty) writeFileSync(join(repo, "docker-compose.production.yml"), "services: {x: 1}\n");
  const envPath = s.envSymlink ? join(box.dir, "real.env") : join(repo, ".env");
  writeFileSync(
    envPath,
    s.env ??
      `TARUBOT_IMAGE_TAG=${s.live}\nDATABASE_URL=postgresql://x\nDATABASE_CA_CERT="-----BEGIN CERTIFICATE-----\nMIIBCgKCAQEAinsideAquotedValue=\n-----END CERTIFICATE-----"\n`,
  );
  chmodSync(envPath, s.envMode ?? 0o600);
  if (s.envSymlink) symlinkSync(envPath, join(repo, ".env"));
  for (const r of releases.values())
    writeFileSync(join(box.sim, "versions", r.version), `${r.commit} ${r.digest} ${r.image}\n`);
  // The live container: healthy unless the scenario says otherwise, with the lease in its logs.
  const cid = "c0ffee000000";
  writeFileSync(
    join(box.sim, "c", `${cid}.json`),
    JSON.stringify([
      {
        Id: cid,
        Image: live.image,
        RestartCount: 0,
        State: { Status: s.liveStatus ?? "running", Health: { Status: s.liveHealth ?? "healthy" } },
        Config: {
          Labels: {
            "org.opencontainers.image.version": live.version,
            "org.opencontainers.image.revision": live.commit,
            "com.docker.compose.project": "tarubot",
          },
        },
      },
    ]),
  );
  writeFileSync(join(box.sim, "c", `${cid}.logs`), '{"msg":"Database writer lease acquired"}\n');
  writeFileSync(join(box.sim, "current"), `${cid}\n`);
  for (const [name, value] of Object.entries(s.knobs ?? {}))
    writeFileSync(join(box.sim, "knob", name), value);
  // The request, and GitHub's answer for an approved dispatch of it.
  const [, action, version, from, override] =
    /^(deploy|rollback) (\S+)(?: from (\S+))?(?: @(\S+))?$/u.exec(s.request) ?? [];
  if (!action || !version) throw new Error(`bad request ${s.request}`);
  const target = releases.get(version);
  const commit = override ?? target?.commit ?? hex(`commit ${version}`, 40);
  const digest = target?.digest ?? `sha256:${hex(`digest ${version}`)}`;
  const request = `${action} ${version} ${commit} ${digest} ${RUN_ID}${from ? ` ${from}` : ""}`;
  const title = from ? `Deploy ${version} rollback from ${from}` : `Deploy ${version}`;
  const runAnswer = {
    id: Number(RUN_ID),
    path: ".github/workflows/deploy.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_repository: { full_name: "deconfined/tarubot" },
    status: "in_progress",
    run_attempt: 1,
    display_title: title,
    ...s.run,
  };
  writeFileSync(join(box.sim, "run.json"), JSON.stringify(runAnswer));
  if (s.runLater)
    writeFileSync(join(box.sim, "run.later.json"), JSON.stringify({ ...runAnswer, ...s.runLater }));
  writeFileSync(
    join(box.sim, "jobs.json"),
    typeof s.jobs === "string"
      ? s.jobs
      : JSON.stringify(
          s.jobs ?? {
            total_count: 3,
            jobs: [
              { name: "Plan", status: "completed", conclusion: "success", run_attempt: 1 },
              { name: "Deploy", status: "in_progress", conclusion: null, run_attempt: 1 },
            ],
          },
        ),
  );
  // A string is written as it is (an answer that isn't JSON).
  writeFileSync(
    join(box.sim, "approvals.json"),
    typeof s.approvals === "string"
      ? s.approvals
      : JSON.stringify(
          s.approvals ?? [
            {
              state: "approved",
              comment: "",
              user: { login: "deconfined", id: 71469756 },
              environments: [{ name: "production" }],
            },
          ],
        ),
  );
  const holder = s.holdHostLock ? holdLock(join(box.state, "lock")) : undefined;
  // run-worker.sh calls the worker directly, not through main, so a scenario's umask is set here.
  const driver = join(STUBS, "run-worker.sh");
  const outcome = run(
    s.umask
      ? ["bash", "-c", 'umask "$1" && exec bash "$2"', "with-umask", s.umask, driver]
      : ["bash", driver],
    environment(box, { DEPLOY_ROOT: repo, REQUEST: request, SIM_NOW: s.now ?? "4 12" }),
  );
  holder?.kill();
  const runDir = join(box.state, "runs", RUN_ID);
  const publicLines = readFileSync(join(runDir, "public.log"), "utf8").trim().split("\n");
  const resultLine = publicLines.at(-1) ?? "";
  const result: Result = Object.fromEntries(
    resultLine
      .replace(/^result /u, "")
      .split(" ")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const envFile = readFileSync(join(repo, ".env"), "utf8");
  return {
    ...outcome,
    result,
    resultLine,
    publicLines,
    resultFile: readFileSync(join(runDir, "result"), "utf8").trim(),
    calls: readFileSync(join(box.sim, "calls"), "utf8").trim().split("\n").filter(Boolean),
    apiCalls: existsSync(join(box.sim, "api-calls"))
      ? readFileSync(join(box.sim, "api-calls"), "utf8").trim().split("\n")
      : [],
    /** Every call to either runtime's tools, "<tool> <arguments>" (the stubs log them all). */
    runtime: readFileSync(join(box.sim, "runtime"), "utf8").trim().split("\n").filter(Boolean),
    pin: /^TARUBOT_IMAGE_TAG=(.*)$/mu.exec(envFile)?.[1],
    envFile,
    envMode: Bun.spawnSync(["stat", "-c", "%a", join(repo, ".env")])
      .stdout.toString()
      .trim(),
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "symbolic-ref", "--short", "HEAD"),
    worker: readFileSync(join(runDir, "worker.log"), "utf8"),
    /** The octal mode of a file in the clone after the run, as stat prints it. */
    modeOf: (path: string) =>
      Bun.spawnSync(["stat", "-c", "%a", join(repo, path)])
        .stdout.toString()
        .trim(),
  };
}

/** The commit of a fixture release. */
const commitOf = (version: string): string => {
  const release = releases.get(version);
  if (!release) throw new Error(`no release ${version}`);
  return release.commit;
};
/** A pattern the whole result line must match: ops/deploy.sh's own RESULT_FORM. */
const RESULT_FORM = new RegExp(
  /readonly RESULT_FORM='([^']+)'/u.exec(readFileSync(SCRIPT, "utf8"))?.[1] ?? "^$",
  "u",
);

describe.skipIf(!hasGit || !hasJq)("worker scenarios", () => {
  const slow = 30_000;

  test(
    "a release without migration files restarts, then pins, registers and reads back",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.30.1",
        previous: "2.30.0",
        path: "plain",
        commands: "registered",
        backup: "-",
        restore_point: "-",
        reason: "-",
      });
      expect(s.result.downtime).toMatch(/^\d+$/u);
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.publicLines).toEqual([
        "step preflight",
        "step pull",
        "step up",
        "step commands",
        s.resultLine,
      ]);
      expect(s.resultFile).toBe("deployed");
      // .env pins the new release (mode 600, the quoted CA untouched); the clone sits at its commit.
      expect(s.pin).toBe("2.30.1");
      expect(s.envMode).toBe("600");
      expect(s.envFile).toContain("MIIBCgKCAQEAinsideAquotedValue=\n-----END CERTIFICATE-----");
      expect(s.head).toBe(commitOf("2.30.1"));
      expect(s.branch).toBe("main");
      // Anonymous API calls only: the run, its jobs and its approvals, then the run and its jobs
      // again just before the restart.
      const api = `https://api.github.com/repos/deconfined/tarubot/actions/runs/${RUN_ID}`;
      expect(s.apiCalls).toEqual([api, `${api}/jobs`, `${api}/approvals`, api, `${api}/jobs`]);
    },
    slow,
  );

  test(
    "added migration files: stop, back up, migrate in the new image, pin, then start",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.31.0",
        previous: "2.30.1",
        path: "migration",
        commands: "registered",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "2026-09-29T19:30:05.123456Z",
        reason: "-",
      });
      // The migration runs in the new image while .env still pins the old release; the pin moves
      // before the start.
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose run tag=2.31.0 pin=2.30.1",
        "compose up tag=- pin=2.31.0 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.publicLines.slice(0, -1)).toEqual([
        "step preflight",
        "step pull",
        "step stop",
        "step backup",
        "step migrate",
        "step migrated",
        "step up",
        "step commands",
      ]);
      expect(s.pin).toBe("2.31.0");
      expect(s.head).toBe(commitOf("2.31.0"));
    },
    slow,
  );

  test(
    "under main's umask, what git writes into the clone is private, whatever the session's mask",
    () => {
      // 2.30.0 went out by hand under the host user's umask 0002, which left ops/deploy.sh
      // group-writable. The migration release changes package.json and adds a migration file.
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0", umask: MAIN_UMASK });
      expect(s.result.outcome).toBe("deployed");
      expect(s.head).toBe(commitOf("2.31.0"));
      for (const path of ["package.json", "migrations/002_more.sql"])
        expect({ path, mode: s.modeOf(path) }).toEqual({ path, mode: "600" });
      // A file the deploy doesn't write keeps the mode it had: only git's own writes follow it.
      expect(s.modeOf("docker-compose.production.yml")).toBe("664");
      expect(s.envMode).toBe("600");
    },
    slow,
  );

  test(
    "a migration in the Tuesday maintenance window warns and still runs",
    () => {
      const inWindow = scenario({ live: "2.30.1", request: "deploy 2.31.0", now: "2 20" });
      expect(inWindow.result.outcome).toBe("deployed");
      expect(inWindow.publicLines).toContain("warning db-maintenance-window");
      expect(inWindow.publicLines.indexOf("warning db-maintenance-window")).toBeLessThan(
        inWindow.publicLines.indexOf("step stop"),
      );
      // After 23:00, on another day, or for a restart: no warning.
      for (const [live, request, now] of [
        ["2.30.1", "deploy 2.31.0", "2 23"],
        ["2.30.1", "deploy 2.31.0", "3 20"],
        ["2.30.0", "deploy 2.30.1", "2 20"],
      ] as const) {
        const s = scenario({ live, request, now });
        expect({
          now,
          request,
          lines: s.publicLines.filter((l) => l.startsWith("warning")),
        }).toEqual({ now, request, lines: [] });
      }
    },
    slow,
  );

  test(
    "a failed backup puts the previous release back with the unchanged .env",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0", knobs: { backup: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.30.1",
        path: "migration",
        backup: "-",
        reason: "backup-failed",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose up tag=- pin=2.30.1 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a failed migration stops its one-off container, then the previous release returns",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { migrate: "fail", oneoff: "1" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        reason: "migration-failed",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "-",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose run tag=2.31.0 pin=2.30.1",
        "stop-oneoff",
        "compose up tag=- pin=2.30.1 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a failed migration whose previous release won't start asks for the owner",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { migrate: "fail", "up.2.30.1": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "migration-may-have-committed",
      });
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a new release that fails after its migration committed stays, pinned, for the owner",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { "up.2.31.0": "fail-after-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "new-release-failed",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "2026-09-29T19:30:05.123456Z",
        commands: "skipped",
      });
      expect(s.calls.at(-1)).toBe("compose up tag=- pin=2.31.0 orphans");
      expect(s.pin).toBe("2.31.0");
    },
    slow,
  );

  test(
    "health fails before the writer lease: stop, count again, put the previous release back",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.30.0",
        path: "plain",
        reason: "did-not-start",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
        "compose stop",
        "compose up tag=- pin=2.30.0 orphans",
      ]);
      expect(s.pin).toBe("2.30.0");
      expect(s.head).toBe(commitOf("2.30.0"));
    },
    slow,
  );

  test(
    "a new container that never appeared: the previous release is put back",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-no-container" },
      });
      expect(s.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(s.calls).not.toContain("compose stop");
      expect(s.pin).toBe("2.30.0");
    },
    slow,
  );

  test(
    "health fails after the writer lease: no stop, no reset, and .env pins the new release",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-after-lease" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "logs without 'Modules loaded' are incomplete evidence: treated like the lease",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-no-modules" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "lease-evidence-incomplete" });
      expect(s.calls).not.toContain("compose stop");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a lease that appears by the stop keeps the new release",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease", lease_after_stop: "1" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
      expect(s.calls.slice(-2)).toEqual(["compose stop", "compose up tag=2.30.1 pin=2.30.0"]);
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a release that restarts within the stability minute is pinned and reported",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "unstable" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "unstable" });
      expect(s.calls).not.toContain("exec register");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a failed registration leaves the release live and asks for a retry",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", knobs: { register: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "commands-failed",
        commands: "failed",
      });
      expect(s.calls.at(-1)).toBe("exec register");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a rollback on the same schema restarts onto the older release",
    () => {
      const s = scenario({ live: "2.30.1", request: "rollback 2.30.0 from 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.30.0",
        previous: "2.30.1",
        path: "rollback",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.0",
        "compose config tag=2.30.0",
        "compose up tag=2.30.0 pin=2.30.1 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.pin).toBe("2.30.0");
      expect(s.head).toBe(commitOf("2.30.0"));
    },
    slow,
  );

  test(
    "rollbacks across a migration, from a version that isn't live, or forward are refused",
    () => {
      for (const [live, request, reason] of [
        ["2.31.0", "rollback 2.30.1 from 2.31.0", "rollback-across-migration"],
        ["2.30.1", "rollback 2.30.0 from 2.31.0", "live-changed"],
        ["2.30.0", "rollback 2.30.1 from 2.30.0", "rollback-not-older"],
      ] as const) {
        const s = scenario({ live, request });
        expect({
          request,
          result: s.result.outcome,
          reason: s.result.reason,
          calls: s.calls,
        }).toEqual({ request, result: "refused", reason, calls: [] });
        expect(s.pin).toBe(live);
      }
    },
    slow,
  );

  test(
    "an older release than the live one is superseded, with nothing changed",
    () => {
      const s = scenario({ live: "2.31.0", request: "deploy 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "superseded",
        version: "2.30.1",
        previous: "2.31.0",
        path: "none",
        commands: "skipped",
      });
      expect(s.calls).toEqual([]);
      expect(s.resultFile).toBe("superseded");
    },
    slow,
  );

  test(
    "the live release is verified and its commands registered, with no pull or restart",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.30.1" });
      expect(s.result).toMatchObject({
        outcome: "already-live",
        previous: "2.30.1",
        path: "none",
        commands: "registered",
        downtime: "-",
      });
      expect(s.calls).toEqual(["exec register", "exec list"]);
      const unhealthy = scenario({
        live: "2.30.1",
        request: "deploy 2.30.1",
        liveHealth: "unhealthy",
      });
      expect(unhealthy.result).toMatchObject({ outcome: "needs-you", reason: "live-unhealthy" });
      expect(unhealthy.calls).toEqual([]);
      const failing = scenario({
        live: "2.30.1",
        request: "deploy 2.30.1",
        knobs: { list: "fail" },
      });
      expect(failing.result).toMatchObject({ outcome: "needs-you", reason: "commands-failed" });
    },
    slow,
  );

  test(
    "no single container of either release after a failed start: nothing restored or pinned",
    () => {
      for (const [what, knobs] of [
        ["ps fails", { ps_after_up: "fail" }],
        ["two containers", { ps_after_up: "two" }],
        ["an unreadable container", { inspect_after_up: "fail" }],
      ] as const) {
        const s = scenario({
          live: "2.30.0",
          request: "deploy 2.30.1",
          knobs: { "up.2.30.1": "fail-before-lease", ...knobs },
        });
        expect({
          what,
          outcome: s.result.outcome,
          reason: s.result.reason,
          calls: s.calls,
          pin: s.pin,
          head: s.head,
        }).toEqual({
          what,
          outcome: "needs-you",
          reason: "lease-evidence-incomplete",
          calls: [
            "compose pull tag=2.30.1",
            "compose config tag=2.30.1",
            "compose up tag=2.30.1 pin=2.30.0 orphans",
          ],
          pin: "2.30.0",
          head: commitOf("2.30.1"),
        });
      }
      // Compose listing no container at all means the target never ran: the previous release
      // returns.
      const none = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease", ps_after_up: "none" },
      });
      expect(none.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(none.calls.at(-1)).toBe("compose up tag=- pin=2.30.0 orphans");
      expect(none.pin).toBe("2.30.0");
    },
    slow,
  );

  test(
    "a stop that fails on the migration path puts the previous release back",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0", knobs: { stop: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        path: "migration",
        backup: "-",
        reason: "stop-failed",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "compose up tag=- pin=2.30.1 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a previous release that won't come back after a failed restart asks for the owner",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease", "up.2.30.0": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        path: "plain",
        reason: "previous-failed",
      });
      expect(s.calls.slice(-2)).toEqual(["compose stop", "compose up tag=- pin=2.30.0 orphans"]);
      expect(s.pin).toBe("2.30.0");
      expect(s.head).toBe(commitOf("2.30.0"));
    },
    slow,
  );

  test(
    "a rollback target that fails before the lease puts the newer release back",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "rollback 2.30.0 from 2.30.1",
        knobs: { "up.2.30.0": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        version: "2.30.0",
        previous: "2.30.1",
        path: "rollback",
        reason: "did-not-start",
      });
      expect(s.calls.slice(-3)).toEqual([
        "compose up tag=2.30.0 pin=2.30.1 orphans",
        "compose stop",
        "compose up tag=- pin=2.30.1 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a pin that can't be written leaves the started release for the owner",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", knobs: { pin: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "pin-failed",
        commands: "skipped",
      });
      expect(s.calls.at(-1)).toBe("compose up tag=2.30.1 pin=2.30.0 orphans");
      expect(s.pin).toBe("2.30.0");
    },
    slow,
  );

  test(
    "a migration run that applies nothing reports no restore point and still deploys",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0", knobs: { migrate: "none" } });
      expect(s.result).toMatchObject({
        outcome: "deployed",
        path: "migration",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "-",
      });
      expect(s.pin).toBe("2.31.0");
    },
    slow,
  );

  test(
    "another deploy holding the host lock past the wait is refused busy, with nothing changed",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", holdHostLock: true });
      expect(s.result).toMatchObject({ outcome: "refused", reason: "busy" });
      expect(s.calls).toEqual([]);
      expect(s.head).toBe(commitOf("2.30.0"));
      expect(s.pin).toBe("2.30.0");
    },
    slow,
  );

  test(
    "a run cancelled while the worker waited stops it before the first change",
    () => {
      const later = { status: "completed", conclusion: "cancelled" };
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", runLater: later });
      expect(s.result).toMatchObject({ outcome: "refused", reason: "not-approved" });
      expect(s.calls).toEqual(["compose pull tag=2.30.1", "compose config tag=2.30.1"]);
      expect(s.head).toBe(commitOf("2.30.0"));
      expect(s.pin).toBe("2.30.0");
      // The migration path and the already-live check ask again too.
      const migration = scenario({ live: "2.30.1", request: "deploy 2.31.0", runLater: later });
      expect(migration.result.reason).toBe("not-approved");
      expect(migration.calls).not.toContain("compose stop");
      expect(migration.head).toBe(commitOf("2.30.1"));
      const live = scenario({ live: "2.30.1", request: "deploy 2.30.1", runLater: later });
      expect(live.result.reason).toBe("not-approved");
      expect(live.calls).toEqual([]);
    },
    slow,
  );

  test("refusals before anything changes leave the pin, the clone and the containers alone", () => {
    const cases: [string, Scenario, string][] = [
      [
        "an edited applied migration",
        { live: "2.31.0", request: "deploy 2.31.1" },
        "applied-migration-changed",
      ],
      [
        "a manual change",
        { live: "2.30.0", request: "deploy 2.30.1", env: "TARUBOT_IMAGE_TAG=2.30.1\n" },
        "manual-change-in-progress",
      ],
      [
        "a stopped bot",
        { live: "2.30.0", request: "deploy 2.30.1", liveStatus: "exited" },
        "bot-not-running",
      ],
      [
        "a warn log level",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nLOG_LEVEL=warn\n",
        },
        "log-level",
      ],
      [
        "two pins",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nTARUBOT_IMAGE_TAG=2.30.0\n",
        },
        "env-file",
      ],
      [
        "an image override",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nTARUBOT_IMAGE=evil/image\n",
        },
        "env-file",
      ],
      ["a readable .env", { live: "2.30.0", request: "deploy 2.30.1", envMode: 0o644 }, "env-file"],
      [
        "a symlinked .env",
        { live: "2.30.0", request: "deploy 2.30.1", envSymlink: true },
        "env-file",
      ],
      [
        "a changed clone",
        { live: "2.30.0", request: "deploy 2.30.1", dirty: true },
        "clone-not-clean",
      ],
      [
        "a commit not on main",
        { live: "2.30.0", request: `deploy 2.32.0 @${"f".repeat(40)}` },
        "not-on-main",
      ],
      [
        "a version the commit doesn't carry",
        { live: "2.30.0", request: `deploy 2.30.2 @${commitOf("2.30.1")}` },
        "version-mismatch",
      ],
      ["a release below the floor", { live: "2.30.0", request: "deploy 2.29.2" }, "below-floor"],
      [
        "a backup that keeps running",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { backup_running: "100" } },
        "busy",
      ],
      [
        "an image that won't pull",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { pull: "fail" } },
        "pull-failed",
      ],
      [
        "another digest",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { "digest.2.30.1": "wrong" } },
        "digest-mismatch",
      ],
      [
        "a Compose file the .env can't satisfy",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { config: "fail" } },
        "compose-config",
      ],
    ];
    for (const [what, setup, reason] of cases) {
      const s = scenario(setup);
      expect({ what, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        what,
        outcome: "refused",
        reason,
      });
      expect({ what, changes: s.calls.filter((c) => !/^compose (pull|config)/u.test(c)) }).toEqual({
        what,
        changes: [],
      });
      expect({ what, head: s.head }).toEqual({ what, head: commitOf(setup.live) });
      expect(s.resultLine).toMatch(RESULT_FORM);
    }
  }, 120_000);

  test(
    "a backup that finishes within the wait lets the deploy go ahead",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { backup_running: "2" },
      });
      expect(s.result.outcome).toBe("deployed");
    },
    slow,
  );

  test("the host checks the approval with GitHub and fails closed", () => {
    const approved = {
      state: "approved",
      user: { login: "deconfined", id: 71469756 },
      environments: [{ name: "production" }],
    };
    const cases: [string, Partial<Scenario>, string][] = [
      [
        "another reviewer",
        { approvals: [{ ...approved, user: { login: "someone" } }] },
        "not-approved",
      ],
      [
        "the owner's login on another account id",
        { approvals: [{ ...approved, user: { login: "deconfined", id: 1 } }] },
        "not-approved",
      ],
      ["a rejection", { approvals: [{ ...approved, state: "rejected" }] }, "not-approved"],
      [
        "a Deploy job that isn't running (it failed; notify runs)",
        {
          jobs: {
            total_count: 3,
            jobs: [
              { name: "Plan", status: "completed", conclusion: "success" },
              { name: "Deploy", status: "completed", conclusion: "failure" },
              { name: "Notify", status: "in_progress", conclusion: null },
            ],
          },
        },
        "not-approved",
      ],
      [
        "a jobs answer that isn't JSON",
        { jobs: "<html>rate limited</html>" },
        "approval-unverified",
      ],
      [
        "another environment",
        { approvals: [{ ...approved, environments: [{ name: "notify" }] }] },
        "not-approved",
      ],
      ["no approval", { approvals: [] }, "not-approved"],
      ["a finished run", { run: { status: "completed" } }, "not-approved"],
      ["a re-run", { run: { run_attempt: 2 } }, "not-approved"],
      ["another workflow", { run: { path: ".github/workflows/ci.yml" } }, "not-approved"],
      ["another branch", { run: { head_branch: "feature" } }, "not-approved"],
      ["a fork", { run: { head_repository: { full_name: "someone/tarubot" } } }, "not-approved"],
      ["another target in the title", { run: { display_title: "Deploy 2.30.0" } }, "not-approved"],
      ["a pull-request event", { run: { event: "pull_request" } }, "not-approved"],
      ["an unreachable API", { knobs: { curl: "1" } }, "approval-unverified"],
      [
        "an answer that isn't JSON",
        { approvals: "<html>rate limited</html>" },
        "approval-unverified",
      ],
    ];
    for (const [what, setup, reason] of cases) {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", ...setup });
      expect({ what, outcome: s.result.outcome, reason: s.result.reason, calls: s.calls }).toEqual({
        what,
        outcome: "refused",
        reason,
        calls: [],
      });
    }
    // An automatic run is titled with the commit and can only deploy, never roll back.
    const automatic = (request: string, title: string) =>
      scenario({
        live: "2.30.0",
        request,
        run: { event: "workflow_run", display_title: title },
      }).result;
    expect(automatic("deploy 2.30.1", `Deploy ${commitOf("2.30.1")}`).outcome).toBe("deployed");
    expect(automatic("deploy 2.30.1", "Deploy 2.30.1").reason).toBe("not-approved");
    const rollback = scenario({
      live: "2.30.1",
      request: "rollback 2.30.0 from 2.30.1",
      run: { event: "workflow_run", display_title: `Deploy ${commitOf("2.30.0")}` },
    });
    expect(rollback.result.reason).toBe("not-approved");
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The Quadlet modes (2.33.0, #50) against a simulated rootless Quadlet host
// ---------------------------------------------------------------------------------------------

/** A fixture release, or an error. */
const releaseOf = (version: string): Release => {
  const found = releases.get(version);
  if (!found) throw new Error(`no release ${version}`);
  return found;
};

/**
 * A Quadlet host's .env pinned to `version`: the tag and digest lines, and a marker value for every
 * name the unit unsets, so a test can show that none reaches an argument or the settings check.
 */
const quadletEnv = (version: string, digest = releaseOf(version).digest) =>
  [
    `TARUBOT_IMAGE_TAG=${version}`,
    `TARUBOT_IMAGE_DIGEST=${digest}`,
    ...UNSET.filter((name) => name !== "DATABASE_CA_CERT").map(
      (name) => `${name}=marker-${name.toLowerCase()}`,
    ),
    'DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----',
    "MIIBCgKCAQEAinsideAquotedValue=",
    '-----END CERTIFICATE-----"',
    "",
  ].join("\n");

/** Container ids as Podman prints them: 64 hex digits. */
const LIVE_ID = `c0ffee${"a".repeat(58)}`;
const OLD_ID = `c0ffee${"b".repeat(58)}`;

/** What a Quadlet scenario sets up, beyond a healthy live release and an approved (or, on staging, owner-dispatched) run. */
interface QuadletScenario {
  /** The forced command's words: staging by default. */
  readonly mode?: "quadlet" | "quadlet staging";
  /** The live release (2.33.0 or later: the clone must hold ops/quadlet for the links). */
  readonly live: string;
  /** "deploy V", "rollback V from F", optionally with "@<commit>" to override the commit. */
  readonly request: string;
  /** The request's digest instead of the release's. */
  readonly requestDigest?: string;
  readonly knobs?: Record<string, string>;
  readonly env?: string;
  readonly envMode?: number;
  /** tarubot.service's "ActiveState SubState": "active running" by default. */
  readonly unit?: string;
  /** false: the unit between restarts, with no container. */
  readonly liveContainer?: boolean;
  readonly liveHealth?: string;
  /** The live container's hardening, as sim.sh's `container` takes it: ok by default. */
  readonly liveHardening?: string;
  /** The live container runs this release's image instead of the pinned one. */
  readonly liveImageOf?: string;
  readonly run?: Record<string, unknown>;
  readonly approvals?: unknown;
  readonly jobs?: unknown;
  readonly runLater?: Record<string, unknown>;
  /** Another process holds the host lock while the worker runs. */
  readonly holdHostLock?: boolean;
  /**
   * The host lock: a sandbox file under run-worker.sh's stand-in check (the default), or the real
   * q_lock_trusted on a lock that is missing, owned by the test user, or a link to a root-owned file.
   */
  readonly lock?: "sandbox" | "missing" | "owned" | "symlink";
  /** The runtime directory: mode 700 (the default), open (755) or missing. */
  readonly runtime?: "ok" | "open" | "missing";
  /** The user lingers (the default). */
  readonly linger?: boolean;
  /**
   * ~/.config/containers/systemd: the mode's two links (the default), the other target's, an extra
   * link, a copy of the units instead of a link, or nothing.
   */
  readonly links?: "ok" | "other" | "extra" | "copy" | "missing";
  /** A Podman API socket in the runtime directory. */
  readonly socket?: boolean;
  readonly now?: string;
  readonly dirty?: boolean;
}

function quadletScenario(s: QuadletScenario) {
  const box = sandbox();
  const mode = s.mode ?? "quadlet staging";
  const staging = mode === "quadlet staging";
  const target = staging ? "staging" : "production";
  const other = staging ? "production" : "staging";
  // The clone where the unit's %h paths look, pinned to the live release.
  const repo = join(box.home, "tarubot");
  git(box.dir, "clone", "--quiet", origin, repo);
  const live = releaseOf(s.live);
  git(repo, "reset", "--quiet", "--hard", live.commit);
  if (s.dirty) writeFileSync(join(repo, "ops/quadlet/units/tarubot.container"), "[Container]\n");
  writeFileSync(join(repo, ".env"), s.env ?? quadletEnv(s.live));
  chmodSync(join(repo, ".env"), s.envMode ?? 0o600);
  // The links the playbook's start tag makes.
  const links = join(box.home, ".config/containers/systemd");
  mkdirSync(links, { recursive: true });
  const link = (to: string, name: string) =>
    symlinkSync(join(repo, "ops/quadlet", to), join(links, name));
  const shape = s.links ?? "ok";
  if (shape === "copy") {
    cpSync(join(repo, "ops/quadlet/units"), join(links, "tarubot"), { recursive: true });
    link(target, "tarubot-target");
  } else if (shape !== "missing") {
    link("units", "tarubot");
    link(shape === "other" ? other : target, "tarubot-target");
    if (shape === "extra") link(other, "tarubot-other");
  }
  // The runtime directory, the linger flag and the host lock, in the sandbox.
  const runtimeRoot = join(box.dir, "run-user");
  const runtime = join(runtimeRoot, String(process.getuid?.() ?? 0));
  mkdirSync(runtimeRoot);
  if (s.runtime !== "missing") {
    mkdirSync(runtime);
    chmodSync(runtime, s.runtime === "open" ? 0o755 : 0o700);
  }
  if (s.socket) {
    mkdirSync(join(runtime, "podman"));
    writeFileSync(join(runtime, "podman/podman.sock"), "");
  }
  const linger = join(box.dir, "linger");
  mkdirSync(linger);
  if (s.linger ?? true) writeFileSync(join(linger, userInfo().username), "");
  const lock = join(box.dir, "host.lock");
  if (s.lock === "symlink") symlinkSync("/etc/passwd", lock);
  else if (s.lock !== "missing") writeFileSync(lock, "");
  // The simulated host: every release, the unit active on the live one with its container.
  for (const r of releases.values())
    writeFileSync(join(box.sim, "versions", r.version), `${r.commit} ${r.digest} ${r.image}\n`);
  mkdirSync(join(box.sim, "graph"));
  writeFileSync(join(box.sim, "unit"), `${s.unit ?? "active running"}\n`);
  writeFileSync(join(box.sim, "nrestarts"), "0\n");
  writeFileSync(join(box.sim, "live"), `${LIVE_ID}\n`);
  const sim = (...args: string[]) => {
    const done = run(["bash", join(STUBS, "sim.sh"), ...args], environment(box));
    if (done.code !== 0) throw new Error(`sim.sh ${args.join(" ")}: ${done.stderr}`);
  };
  if (s.liveContainer ?? true) {
    sim(
      "container",
      LIVE_ID,
      s.liveImageOf ?? s.live,
      "running",
      s.liveHealth ?? "healthy",
      "lease",
      s.liveHardening ?? "ok",
    );
    writeFileSync(join(box.sim, "current"), `${LIVE_ID}\n`);
  } else writeFileSync(join(box.sim, "current"), "");
  for (const [name, value] of Object.entries(s.knobs ?? {}))
    writeFileSync(join(box.sim, "knob", name), value);
  // The request, and GitHub's answer for it.
  const [, action, version, from, override] =
    /^(deploy|rollback) (\S+)(?: from (\S+))?(?: @(\S+))?$/u.exec(s.request) ?? [];
  if (!action || !version) throw new Error(`bad request ${s.request}`);
  const wanted = releases.get(version);
  // An old container of the requested release, from long before this run, whose lines hold the
  // lease: the evidence starts at the run's mark, so it must never count.
  if (wanted) {
    sim("container", OLD_ID, version, "exited", "unhealthy", "lease");
    sim("event", "start", OLD_ID, version, "1000000000000000000");
    sim("event", "died", OLD_ID, version, "1000000000000000001");
    rmSync(join(box.sim, "c", `${OLD_ID}.json`));
  }
  const commit = override ?? wanted?.commit ?? hex(`commit ${version}`, 40);
  const digest = s.requestDigest ?? wanted?.digest ?? `sha256:${hex(`digest ${version}`)}`;
  const request = `${action} ${version} ${commit} ${digest} ${RUN_ID}${from ? ` ${from}` : ""}`;
  const title = `${from ? `Deploy ${version} rollback from ${from}` : `Deploy ${version}`}${staging ? " to staging" : ""}`;
  const runAnswer = {
    id: Number(RUN_ID),
    path: ".github/workflows/deploy.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_repository: { full_name: "deconfined/tarubot" },
    status: "in_progress",
    run_attempt: 1,
    display_title: title,
    actor: OWNER,
    triggering_actor: OWNER,
    ...s.run,
  };
  writeFileSync(join(box.sim, "run.json"), JSON.stringify(runAnswer));
  if (s.runLater)
    writeFileSync(join(box.sim, "run.later.json"), JSON.stringify({ ...runAnswer, ...s.runLater }));
  const job = staging ? "Deploy staging" : "Deploy";
  writeFileSync(
    join(box.sim, "jobs.json"),
    JSON.stringify(
      s.jobs ?? {
        total_count: 2,
        jobs: [
          { name: "Plan", status: "completed", conclusion: "success" },
          { name: job, status: "in_progress", conclusion: null },
        ],
      },
    ),
  );
  writeFileSync(
    join(box.sim, "approvals.json"),
    JSON.stringify(
      s.approvals ?? [
        {
          state: "approved",
          comment: "",
          user: OWNER,
          environments: [{ name: "production" }],
        },
      ],
    ),
  );
  const holder = s.holdHostLock ? holdLock(lock) : undefined;
  const outcome = run(
    ["bash", join(STUBS, "run-worker.sh")],
    environment(box, {
      DEPLOY_ROOT: repo,
      REQUEST: request,
      SIM_NOW: s.now ?? "4 12",
      DEPLOY_MODE: mode,
      DEPLOY_HOST_LOCK: lock,
      DEPLOY_LINGER_DIR: linger,
      DEPLOY_RUNTIME_ROOT: runtimeRoot,
      ...(s.lock && s.lock !== "sandbox" ? { DEPLOY_REAL_LOCK_CHECK: "1" } : {}),
    }),
  );
  holder?.kill();
  const runDir = join(box.state, "runs", RUN_ID);
  const publicLines = readFileSync(join(runDir, "public.log"), "utf8").trim().split("\n");
  const resultLine = publicLines.at(-1) ?? "";
  const result: Result = Object.fromEntries(
    resultLine
      .replace(/^result /u, "")
      .split(" ")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const envFile = readFileSync(join(repo, ".env"), "utf8");
  const lines = (name: string) =>
    existsSync(join(box.sim, name))
      ? readFileSync(join(box.sim, name), "utf8").trim().split("\n").filter(Boolean)
      : [];
  return {
    ...outcome,
    result,
    resultLine,
    publicLines,
    resultFile: readFileSync(join(runDir, "result"), "utf8").trim(),
    calls: lines("calls"),
    apiCalls: lines("api-calls"),
    /** Every sleep the worker made, in seconds (the simulated host's clock). */
    sleeps: lines("sleeps"),
    /** Every runtime tool call, "<tool> <arguments>". */
    runtime: lines("runtime"),
    /** The UnsetEnvironment= list systemd-run got. */
    unset: lines("systemd-run-unset")[0]?.split(" "),
    pin: /^TARUBOT_IMAGE_TAG=(.*)$/mu.exec(envFile)?.[1],
    digestPin: /^TARUBOT_IMAGE_DIGEST=(.*)$/mu.exec(envFile)?.[1],
    envFile,
    envMode: Bun.spawnSync(["stat", "-c", "%a", join(repo, ".env")])
      .stdout.toString()
      .trim(),
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "symbolic-ref", "--short", "HEAD"),
    worker: readFileSync(join(runDir, "worker.log"), "utf8"),
  };
}

/** The read-only checks the target's configuration gets before anything stops (staging). */
const stageCalls = (version: string) => [
  `podman pull ${version}`,
  "generator",
  "check-env --syntax",
  "systemd-run check-env.sh",
  "check-env environment secrets=none",
  "secrets check",
];
/** The pin a release leaves in .env. */
const pinned = (version: string) => ({ pin: version, digestPin: releaseOf(version).digest });

describe.skipIf(!hasGit || !hasJq)("Quadlet worker scenarios", () => {
  const slow = 60_000;
  const api = `https://api.github.com/repos/deconfined/tarubot/actions/runs/${RUN_ID}`;

  test(
    "staging: a release without migration files pins, reloads, restarts and registers in the test guild",
    () => {
      const s = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.33.1",
        previous: "2.33.0",
        path: "plain",
        commands: "registered",
        backup: "-",
        restore_point: "-",
        reason: "-",
      });
      expect(s.result.downtime).toMatch(/^\d+$/u);
      // The target's own checks run before anything changes; the pin (tag and digest together)
      // moves before the reload and the restart, since systemd starts whatever .env names.
      expect(s.calls).toEqual([
        ...stageCalls("2.33.1"),
        "daemon-reload",
        "unit restart pin=2.33.1",
        "exec register --guild",
        "exec list",
      ]);
      expect(s.publicLines).toEqual([
        "step preflight",
        "step pull",
        "step up",
        "step commands",
        s.resultLine,
      ]);
      expect(s).toMatchObject(pinned("2.33.1"));
      expect(s.envMode).toBe("600");
      expect(s.envFile).toContain("MIIBCgKCAQEAinsideAquotedValue=\n-----END CERTIFICATE-----");
      expect(s.head).toBe(commitOf("2.33.1"));
      expect(s.branch).toBe("main");
      // Staging has no approval to query: the run and its jobs, twice.
      expect(s.apiCalls).toEqual([api, `${api}/jobs`, api, `${api}/jobs`]);
      // systemd-run gave the settings check the unit's whole unset list.
      expect(s.unset).toEqual(UNSET);
    },
    slow,
  );

  test(
    "production's Quadlet mode keeps the approval and registers globally",
    () => {
      const s = quadletScenario({ mode: "quadlet", live: "2.33.0", request: "deploy 2.33.1" });
      expect(s.result).toMatchObject({
        outcome: "deployed",
        path: "plain",
        commands: "registered",
      });
      expect(s.calls).toEqual([
        ...stageCalls("2.33.1"),
        "daemon-reload",
        "unit restart pin=2.33.1",
        "exec register --global",
        "exec list",
      ]);
      expect(s.apiCalls).toEqual([api, `${api}/jobs`, `${api}/approvals`, api, `${api}/jobs`]);
      expect(s).toMatchObject(pinned("2.33.1"));
    },
    slow,
  );

  test(
    "the runtimes stay apart: every tool call is Podman's or systemd's, with --user, and carries no setting",
    () => {
      const s = quadletScenario({ live: "2.33.1", request: "deploy 2.34.0" });
      expect(s.result.outcome).toBe("deployed");
      const tools = new Set(s.runtime.map((line) => line.slice(0, line.indexOf(" "))));
      expect([...tools].sort()).toEqual([
        "journalctl",
        "podman",
        "podman-system-generator",
        "systemctl",
        "systemd-run",
      ]);
      // systemctl and journalctl always talk to the user's manager and journal.
      for (const line of s.runtime.filter((l) => /^(systemctl|journalctl|systemd-run) /u.test(l)))
        expect({ line, user: /^[a-z-]+ --user /u.test(line) }).toEqual({ line, user: true });
      // No value from .env appears in any argument (the markers of every unset name).
      expect(s.runtime.filter((line) => line.includes("marker-") || line.includes("MIIB"))).toEqual(
        [],
      );
    },
    slow,
  );

  test(
    "added migration files: stop, a Quadlet backup, migrate.js through the target's run-tool.sh, then the pin",
    () => {
      const s = quadletScenario({ live: "2.33.1", request: "deploy 2.34.0" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.34.0",
        previous: "2.33.1",
        path: "migration",
        commands: "registered",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "2026-09-29T19:30:05.123456Z",
        reason: "-",
      });
      // The backup and the tool get neither lock (no fd8, no fd9), and the tool runs while .env
      // still pins the old release; the pin moves after "Schema ready.".
      expect(s.calls).toEqual([
        ...stageCalls("2.34.0"),
        "unit stop",
        "backup quadlet",
        `run-tool staging 2.34.0 tarubot-migrate-${RUN_ID} pin=2.33.1 bun dist/scripts/migrate.js`,
        "daemon-reload",
        "unit start pin=2.34.0",
        "exec register --guild",
        "exec list",
      ]);
      expect(s.publicLines.slice(0, -1)).toEqual([
        "step preflight",
        "step pull",
        "step stop",
        "step backup",
        "step migrate",
        "step migrated",
        "step up",
        "step commands",
      ]);
      expect(s).toMatchObject(pinned("2.34.0"));
      expect(s.head).toBe(commitOf("2.34.0"));
      // Production's mode runs the tool in production's configuration.
      const production = quadletScenario({
        mode: "quadlet",
        live: "2.33.1",
        request: "deploy 2.34.0",
      });
      expect(production.calls).toContain(
        `run-tool production 2.34.0 tarubot-migrate-${RUN_ID} pin=2.33.1 bun dist/scripts/migrate.js`,
      );
    },
    slow,
  );

  test(
    "a migration in the maintenance window warns; a failed backup puts the previous release back",
    () => {
      const inWindow = quadletScenario({ live: "2.33.1", request: "deploy 2.34.0", now: "2 20" });
      expect(inWindow.result.outcome).toBe("deployed");
      expect(inWindow.publicLines.indexOf("warning db-maintenance-window")).toBeLessThan(
        inWindow.publicLines.indexOf("step stop"),
      );
      expect(inWindow.publicLines).toContain("warning db-maintenance-window");
      const s = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { backup: "fail" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.33.1",
        path: "migration",
        backup: "-",
        reason: "backup-failed",
      });
      expect(s.calls.slice(-4)).toEqual([
        "unit stop",
        "backup quadlet",
        "daemon-reload",
        "unit restart pin=2.33.1",
      ]);
      expect(s).toMatchObject(pinned("2.33.1"));
      expect(s.head).toBe(commitOf("2.33.1"));
      // .env still pins the live release there, so a pin that can't be written doesn't matter.
      const unpinnable = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { backup: "fail", pin: "fail" },
      });
      expect(unpinnable.result).toMatchObject({ outcome: "recovered", reason: "backup-failed" });
    },
    slow,
  );

  test(
    "a failed migration stops its one-off container, then the previous release returns",
    () => {
      const s = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { migrate: "fail", oneoff: "1" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        reason: "migration-failed",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "-",
      });
      expect(s.calls.slice(-4)).toEqual([
        `run-tool staging 2.34.0 tarubot-migrate-${RUN_ID} pin=2.33.1 bun dist/scripts/migrate.js`,
        "stop-oneoff",
        "daemon-reload",
        "unit restart pin=2.33.1",
      ]);
      expect(s).toMatchObject(pinned("2.33.1"));
      expect(s.head).toBe(commitOf("2.33.1"));
      // When the previous release won't come back either, the owner is asked.
      const stuck = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { migrate: "fail", "up.2.33.1": "fail-before-lease" },
      });
      expect(stuck.result).toMatchObject({
        outcome: "needs-you",
        reason: "migration-may-have-committed",
      });
      expect(stuck).toMatchObject(pinned("2.33.1"));
    },
    slow,
  );

  test(
    "a new release that fails after its migration committed stays, pinned, for the owner",
    () => {
      const s = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { "up.2.34.0": "fail-after-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "new-release-failed",
        restore_point: "2026-09-29T19:30:05.123456Z",
        commands: "skipped",
      });
      expect(s.calls.at(-1)).toBe("unit start pin=2.34.0");
      expect(s).toMatchObject(pinned("2.34.0"));
      // A migration that applied nothing still deploys, with no restore point.
      const none = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.34.0",
        knobs: { migrate: "none" },
      });
      expect(none.result).toMatchObject({ outcome: "deployed", restore_point: "-" });
    },
    slow,
  );

  test(
    "health fails before the writer lease: stop, count again, put the previous release back and its pin",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { "up.2.33.1": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.33.0",
        path: "plain",
        reason: "did-not-start",
      });
      expect(s.calls.slice(6)).toEqual([
        "daemon-reload",
        "unit restart pin=2.33.1",
        "unit stop",
        "daemon-reload",
        "unit restart pin=2.33.0",
      ]);
      expect(s).toMatchObject(pinned("2.33.0"));
      expect(s.head).toBe(commitOf("2.33.0"));
    },
    slow,
  );

  test(
    "the health check's start period: the wait polls through `starting`, then the release deploys",
    () => {
      // A real bot reports `starting` for most of its first minute (HealthStartPeriod=60s).
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { "up.2.33.1": "starting:12" },
      });
      expect(s.result).toMatchObject({
        outcome: "deployed",
        path: "plain",
        commands: "registered",
      });
      // Twelve polls five seconds apart saw `starting`, the thirteenth `healthy`; then the
      // stability minute.
      expect(s.sleeps.filter((seconds) => seconds === "5")).toHaveLength(12);
      expect(s.sleeps).toContain("60");
      expect(s).toMatchObject(pinned("2.33.1"));
    },
    slow,
  );

  test(
    "a target still `starting` after three minutes never took the lease: the previous release is put back",
    () => {
      // Waiting for a writer lease another bot holds: "Modules loaded", no lease line.
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { "up.2.33.1": "starting-forever" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.33.0",
        path: "plain",
        reason: "did-not-start",
      });
      // The whole 180 s: 36 polls five seconds apart, then no stability minute.
      expect(s.sleeps.filter((seconds) => seconds === "5")).toHaveLength(36);
      expect(s.sleeps).not.toContain("60");
      expect(s.calls.slice(6)).toEqual([
        "daemon-reload",
        "unit restart pin=2.33.1",
        "unit stop",
        "daemon-reload",
        "unit restart pin=2.33.0",
      ]);
      expect(s).toMatchObject(pinned("2.33.0"));
      expect(s.head).toBe(commitOf("2.33.0"));
    },
    slow,
  );

  test(
    "a target that never started (no start event, the start failed) goes straight back",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { "up.2.33.1": "fail-no-container" },
      });
      expect(s.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(s.calls).not.toContain("unit stop");
      expect(s.calls.at(-1)).toBe("unit restart pin=2.33.0");
      expect(s).toMatchObject(pinned("2.33.0"));
    },
    slow,
  );

  test(
    "lease evidence keeps the target, pinned: the lease, a crash loop after it, or a lease by the stop",
    () => {
      for (const [what, knobs, reason, last] of [
        [
          "the lease",
          { "up.2.33.1": "fail-after-lease" },
          "new-release-took-lease",
          "unit restart pin=2.33.1",
        ],
        [
          "a crash loop after the lease",
          { "up.2.33.1": "crashloop-after-lease" },
          "new-release-took-lease",
          "unit restart pin=2.33.1",
        ],
        [
          "a lease by the stop",
          { "up.2.33.1": "fail-before-lease", lease_after_stop: "1" },
          "new-release-took-lease",
          "unit start-no-block pin=2.33.1",
        ],
      ] as const) {
        const s = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1", knobs });
        expect({
          what,
          outcome: s.result.outcome,
          reason: s.result.reason,
          last: s.calls.at(-1),
        }).toEqual({
          what,
          outcome: "needs-you",
          reason,
          last,
        });
        expect({ what, pin: s.pin, digestPin: s.digestPin }).toEqual({ what, ...pinned("2.33.1") });
        expect({ what, head: s.head }).toEqual({ what, head: commitOf("2.33.1") });
      }
    },
    slow,
  );

  test("incomplete evidence keeps the target and restores nothing", () => {
    for (const [what, knobs] of [
      ["no 'Modules loaded'", { "up.2.33.1": "fail-no-modules" }],
      ["a crash loop without it", { "up.2.33.1": "crashloop-no-modules" }],
      ["a start event with no lines", { "up.2.33.1": "start-empty" }],
      ["an unreadable event log", { "up.2.33.1": "fail-before-lease", events: "fail" }],
      ["an event log that isn't JSON", { "up.2.33.1": "fail-before-lease", events: "garbage" }],
      ["an unreadable journal", { "up.2.33.1": "fail-before-lease", journal: "fail" }],
    ] as const) {
      const s = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1", knobs });
      expect({ what, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        what,
        outcome: "needs-you",
        reason: "lease-evidence-incomplete",
      });
      // Nothing stopped or restored: .env and the clone still name the target.
      expect({ what, stop: s.calls.includes("unit stop"), last: s.calls.at(-1) }).toEqual({
        what,
        stop: false,
        last: "unit restart pin=2.33.1",
      });
      expect({ what, pin: s.pin, digestPin: s.digestPin, head: s.head }).toEqual({
        what,
        ...pinned("2.33.1"),
        head: commitOf("2.33.1"),
      });
    }
  }, 120_000);

  test(
    "a live bot between restarts leaves no died event: a failed start is then unknown, never restored",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        unit: "activating auto-restart",
        liveContainer: false,
        knobs: { "up.2.33.1": "fail-no-container" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "lease-evidence-incomplete" });
      expect(s).toMatchObject(pinned("2.33.1"));
    },
    slow,
  );

  test(
    "a release that restarts or is replaced within the stability minute is reported, pinned",
    () => {
      for (const mode of ["unstable", "unstable-id"]) {
        const s = quadletScenario({
          live: "2.33.0",
          request: "deploy 2.33.1",
          knobs: { "up.2.33.1": mode },
        });
        expect({ mode, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
          mode,
          outcome: "needs-you",
          reason: "unstable",
        });
        expect({ mode, registered: s.calls.some((c) => c.startsWith("exec register")) }).toEqual({
          mode,
          registered: false,
        });
        expect({ mode, pin: s.pin }).toEqual({ mode, pin: "2.33.1" });
      }
    },
    slow,
  );

  test("a started container whose hardening doesn't read back is reported, pinned", () => {
    for (const hardening of ["rw", "cap", "bind", "secretbind", "secretvolume", "nnp", "env"]) {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { "hardening.2.33.1": hardening },
      });
      expect({ hardening, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        hardening,
        outcome: "needs-you",
        reason: "hardening-mismatch",
      });
      expect({ hardening, pin: s.pin }).toEqual({ hardening, pin: "2.33.1" });
    }
  }, 120_000);

  test(
    "a failed registration leaves the release live and asks for a retry",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { register: "fail" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "commands-failed",
        commands: "failed",
      });
      expect(s.calls.at(-1)).toBe("exec register --guild");
      expect(s.pin).toBe("2.33.1");
    },
    slow,
  );

  test(
    "a rollback restarts onto the older release, and one that fails is put back without counting old lines",
    () => {
      const s = quadletScenario({ live: "2.33.1", request: "rollback 2.33.0 from 2.33.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.33.0",
        previous: "2.33.1",
        path: "rollback",
      });
      expect(s.calls.slice(-4)).toEqual([
        "daemon-reload",
        "unit restart pin=2.33.0",
        "exec register --guild",
        "exec list",
      ]);
      expect(s).toMatchObject(pinned("2.33.0"));
      expect(s.head).toBe(commitOf("2.33.0"));
      // 2.33.0's old container, from before the run's mark, held the lease; it must not count.
      const failed = quadletScenario({
        live: "2.33.1",
        request: "rollback 2.33.0 from 2.33.1",
        knobs: { "up.2.33.0": "fail-before-lease" },
      });
      expect(failed.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(failed).toMatchObject(pinned("2.33.1"));
      expect(failed.head).toBe(commitOf("2.33.1"));
      // Across a migration it is refused.
      const across = quadletScenario({ live: "2.34.0", request: "rollback 2.33.1 from 2.34.0" });
      expect(across.result).toMatchObject({
        outcome: "refused",
        reason: "rollback-across-migration",
      });
    },
    slow,
  );

  test(
    "superseded and already-live change nothing; already-live checks the digest and health",
    () => {
      const superseded = quadletScenario({ live: "2.34.0", request: "deploy 2.33.1" });
      expect(superseded.result).toMatchObject({ outcome: "superseded", previous: "2.34.0" });
      expect(superseded.calls).toEqual([]);
      const live = quadletScenario({ live: "2.33.1", request: "deploy 2.33.1" });
      expect(live.result).toMatchObject({
        outcome: "already-live",
        path: "none",
        commands: "registered",
        downtime: "-",
      });
      expect(live.calls).toEqual(["exec register --guild", "exec list"]);
      const unhealthy = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.33.1",
        liveHealth: "unhealthy",
      });
      expect(unhealthy.result).toMatchObject({ outcome: "needs-you", reason: "live-unhealthy" });
      expect(unhealthy.calls).toEqual([]);
      // The approved digest must be the pinned one: another build of the same release isn't live.
      const other = quadletScenario({
        live: "2.33.1",
        request: "deploy 2.33.1",
        requestDigest: `sha256:${hex("another build of 2.33.1")}`,
      });
      expect(other.result).toMatchObject({ outcome: "refused", reason: "digest-mismatch" });
      expect(other.calls).toEqual([]);
    },
    slow,
  );

  test(
    "a live bot between restarts (activating, no container) is read from the pinned image",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        unit: "activating auto-restart",
        liveContainer: false,
      });
      expect(s.result).toMatchObject({ outcome: "deployed", previous: "2.33.0" });
      // Re-read once before it is accepted.
      expect(
        s.runtime.filter(
          (l) => l === "systemctl --user show -p ActiveState -p SubState tarubot.service",
        ),
      ).toHaveLength(2);
      for (const unit of ["inactive dead", "failed failed", "deactivating stop-sigterm"]) {
        const stopped = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1", unit });
        expect({ unit, reason: stopped.result.reason }).toEqual({
          unit,
          reason: "bot-not-running",
        });
      }
    },
    slow,
  );

  test("the target's configuration must hold before anything stops, or the clone goes back", () => {
    const cases: [string, Record<string, string>, string][] = [
      ["a generator failure", { generator: "fail" }, "quadlet-config"],
      ["an empty dry run", { generator: "empty" }, "quadlet-config"],
      ["a stray unit", { generator: "stray" }, "quadlet-config"],
      ["a stray drop-in", { generator: "dropin" }, "quadlet-config"],
      ["the file's lines", { check_syntax: "1" }, "settings-missing"],
      ["the settings systemd reads", { check_environment: "1" }, "settings-missing"],
      ["the secrets", { secrets_check: "1" }, "settings-missing"],
    ];
    for (const [what, knobs, reason] of cases) {
      const s = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1", knobs });
      expect({ what, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        what,
        outcome: "refused",
        reason,
      });
      expect({ what, head: s.head, pin: s.pin, digestPin: s.digestPin }).toEqual({
        what,
        head: commitOf("2.33.0"),
        ...pinned("2.33.0"),
      });
      expect({ what, changed: s.calls.filter((c) => /^(daemon-reload|unit )/u.test(c)) }).toEqual({
        what,
        changed: [],
      });
    }
  }, 120_000);

  test(
    "a pin that can't be written refuses with nothing restarted, or is put back after a failed reload",
    () => {
      const s = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { pin: "fail" },
      });
      expect(s.result).toMatchObject({ outcome: "refused", reason: "pin-failed" });
      expect(s.calls.filter((c) => /^(daemon-reload|unit )/u.test(c))).toEqual([]);
      expect(s).toMatchObject(pinned("2.33.0"));
      expect(s.head).toBe(commitOf("2.33.0"));
      // A reload that fails: the live release is put back the full way (pin, clone, reload).
      const reload = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { daemon_reload: "fail-once" },
      });
      expect(reload.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(reload.calls.slice(-3)).toEqual([
        "daemon-reload",
        "daemon-reload",
        "unit restart pin=2.33.0",
      ]);
      expect(reload).toMatchObject(pinned("2.33.0"));
    },
    slow,
  );

  test("refusals before anything changes leave the pin, the clone and the unit alone", () => {
    const [target, digest] = ["2.33.1", releaseOf("2.33.1").digest];
    const cases: [string, Partial<QuadletScenario>, string][] = [
      ["a writable root", { liveHardening: "rw" }, "hardening-mismatch"],
      ["an added capability", { liveHardening: "cap" }, "hardening-mismatch"],
      ["a bind mount", { liveHardening: "bind" }, "hardening-mismatch"],
      // Podman never lists a secret there, so a mount where a secret's file goes is a stand-in.
      ["a host file where a secret goes", { liveHardening: "secretbind" }, "hardening-mismatch"],
      ["a volume where a secret goes", { liveHardening: "secretvolume" }, "hardening-mismatch"],
      ["no no-new-privileges", { liveHardening: "nnp" }, "hardening-mismatch"],
      ["a secret in the environment", { liveHardening: "env" }, "hardening-mismatch"],
      ["a missing lock (the real check)", { lock: "missing" }, "host"],
      ["a lock linked to a root-owned file (the real check)", { lock: "symlink" }, "host"],
      ["another deploy holding the lock", { holdHostLock: true }, "busy"],
      ["the other target's link", { links: "other" }, "host"],
      ["an extra link", { links: "extra" }, "host"],
      ["a copy instead of a link", { links: "copy" }, "host"],
      ["no links", { links: "missing" }, "host"],
      ["an open runtime directory", { runtime: "open" }, "host"],
      ["no runtime directory", { runtime: "missing" }, "host"],
      ["no linger", { linger: false }, "host"],
      ["a Podman API socket", { socket: true }, "host"],
      ["Podman not answering", { knobs: { podman_info: "fail" } }, "host"],
      ["another event logger", { knobs: { event_logger: "file" } }, "host"],
      ["a stopping user manager", { knobs: { system_state: "stopping" } }, "host"],
      ["an empty user journal", { knobs: { journal_host: "empty" } }, "host"],
      ["a unit listing two containers", { knobs: { ps_unit: "two" } }, "bot-not-running"],
      ["an unreadable live container", { knobs: { inspect_live: "fail" } }, "bot-not-running"],
      [
        "the live container on another image",
        { liveImageOf: "2.33.0", live: "2.33.1" },
        "manual-change-in-progress",
      ],
      [
        "a tag pin the digest doesn't carry",
        {
          env: quadletEnv("2.33.0").replace("TARUBOT_IMAGE_TAG=2.33.0", "TARUBOT_IMAGE_TAG=2.32.0"),
        },
        "manual-change-in-progress",
      ],
      [
        "two digest pins",
        { env: `${quadletEnv("2.33.0")}TARUBOT_IMAGE_DIGEST=${digest}\n` },
        "env-file",
      ],
      [
        "a quoted digest pin",
        {
          env: quadletEnv("2.33.0").replace(
            /^TARUBOT_IMAGE_DIGEST=(.*)$/mu,
            'TARUBOT_IMAGE_DIGEST="$1"',
          ),
        },
        "env-file",
      ],
      [
        "no digest pin",
        { env: quadletEnv("2.33.0").replace(/^TARUBOT_IMAGE_DIGEST=.*\n/mu, "") },
        "env-file",
      ],
      [
        "a file form of a secret in .env",
        { env: `${quadletEnv("2.33.0")}DATABASE_URL_FILE=/run/secrets/database_url\n` },
        "env-file",
      ],
      ["a readable .env", { envMode: 0o644 }, "env-file"],
      ["a warn log level", { env: `${quadletEnv("2.33.0")}LOG_LEVEL=warn\n` }, "log-level"],
      ["a changed clone", { dirty: true }, "clone-not-clean"],
      [
        "a release below the Quadlet floor",
        { request: "deploy 2.32.0", live: "2.33.0" },
        "below-floor",
      ],
      ["the words only in a comment", { request: "deploy 2.33.3" }, "below-floor"],
      ["production's words only, on staging", { request: "deploy 2.33.2" }, "below-floor"],
      ["a backup that keeps running", { knobs: { backup_running: "100" } }, "busy"],
      ["a backup unit that keeps running", { knobs: { backup_unit: "activating:100" } }, "busy"],
      ["an image that won't pull", { knobs: { pull: "fail" } }, "pull-failed"],
      ["another digest", { knobs: { [`digest.${target}`]: "wrong" } }, "digest-mismatch"],
    ];
    // Owned by the test user is refused only when the test user isn't root.
    if (process.getuid?.() !== 0)
      cases.push(["a lock the test user owns (the real check)", { lock: "owned" }, "host"]);
    for (const [what, setup, reason] of cases) {
      const live = setup.live ?? "2.33.0";
      const s = quadletScenario({ live, request: `deploy ${target}`, ...setup });
      expect({ what, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        what,
        outcome: "refused",
        reason,
      });
      expect({
        what,
        changes: s.calls.filter((c) => /^(daemon-reload|unit |backup|run-tool|exec)/u.test(c)),
        head: s.head,
      }).toEqual({ what, changes: [], head: commitOf(live) });
      expect(s.resultLine).toMatch(RESULT_FORM);
    }
    // Production's Quadlet mode takes a release that declares only its word.
    const production = quadletScenario({
      mode: "quadlet",
      live: "2.33.1",
      request: "deploy 2.33.2",
    });
    expect(production.result.outcome).toBe("deployed");
    const comment = quadletScenario({ mode: "quadlet", live: "2.33.1", request: "deploy 2.33.3" });
    expect(comment.result.reason).toBe("below-floor");
  }, 300_000);

  test(
    "a backup waits the deploy: its container, then tarubot-backup.service while activating",
    () => {
      const polls = (s: ReturnType<typeof quadletScenario>, what: string) =>
        s.runtime.filter((line) => line.includes(what)).length;
      const container = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { backup_running: "2" },
      });
      expect(container.result.outcome).toBe("deployed");
      expect(polls(container, "label=io.tarubot.role=backup")).toBe(3);
      const unit = quadletScenario({
        live: "2.33.0",
        request: "deploy 2.33.1",
        knobs: { backup_unit: "activating:2" },
      });
      expect(unit.result.outcome).toBe("deployed");
      expect(polls(unit, "is-active tarubot-backup.service")).toBe(3);
      for (const answer of ["inactive", "failed", "unknown"]) {
        const idle = quadletScenario({
          live: "2.33.0",
          request: "deploy 2.33.1",
          knobs: { backup_unit: answer },
        });
        expect({ answer, outcome: idle.result.outcome, polls: polls(idle, "is-active") }).toEqual({
          answer,
          outcome: "deployed",
          polls: 1,
        });
      }
    },
    slow,
  );
});

describe.skipIf(!hasGit || !hasJq)("the run checks by mode", () => {
  const slow = 120_000;
  const waitingDeploy = { name: "Deploy", status: "waiting", conclusion: null };
  const runningStaging = { name: "Deploy staging", status: "in_progress", conclusion: null };
  const runningDeploy = { name: "Deploy", status: "in_progress", conclusion: null };
  const plan = { name: "Plan", status: "completed", conclusion: "success" };
  const jobs = (...list: unknown[]) => ({ total_count: list.length, jobs: list });
  const bot = { login: "github-actions[bot]", id: 41898282 };

  test(
    "staging takes an automatic run while Deploy staging runs, in_progress or waiting, and the owner's dispatches",
    () => {
      for (const status of ["in_progress", "waiting"]) {
        const s = quadletScenario({
          live: "2.33.0",
          request: "deploy 2.33.1",
          run: {
            event: "workflow_run",
            status,
            display_title: `Deploy ${commitOf("2.33.1")}`,
            actor: bot,
            triggering_actor: bot,
          },
          jobs: jobs(plan, waitingDeploy, runningStaging),
        });
        expect({ status, outcome: s.result.outcome }).toEqual({ status, outcome: "deployed" });
      }
      // A dispatch titled for staging, by the owner as actor and triggering actor; a rollback too.
      expect(quadletScenario({ live: "2.33.0", request: "deploy 2.33.1" }).result.outcome).toBe(
        "deployed",
      );
      expect(
        quadletScenario({ live: "2.33.1", request: "rollback 2.33.0 from 2.33.1" }).result.outcome,
      ).toBe("deployed");
    },
    slow,
  );

  test(
    "staging refuses other dispatchers, production's titles and jobs, re-runs and other branches",
    () => {
      const cases: [string, Partial<QuadletScenario>][] = [
        ["github-actions[bot] as the actor", { run: { actor: bot } }],
        ["github-actions[bot] as the triggering actor", { run: { triggering_actor: bot } }],
        ["the owner's login on another id", { run: { actor: { login: "deconfined", id: 1 } } }],
        [
          "the owner's login on another id, re-run",
          { run: { triggering_actor: { login: "deconfined", id: 1 } } },
        ],
        ["someone else", { run: { actor: { login: "someone", id: 71469756 } } }],
        ["no actor", { run: { actor: null, triggering_actor: null } }],
        ["a production title", { run: { display_title: "Deploy 2.33.1" } }],
        ["only Deploy running", { jobs: jobs(plan, runningDeploy) }],
        ["a re-run", { run: { run_attempt: 2 } }],
        ["another branch", { run: { head_branch: "feature" } }],
        ["a finished run", { run: { status: "completed" } }],
        [
          "a rollback titled for production",
          {
            request: "rollback 2.33.0 from 2.33.1",
            live: "2.33.1",
            run: { display_title: "Deploy 2.33.0 rollback from 2.33.1" },
          },
        ],
        [
          "an automatic rollback",
          {
            request: "rollback 2.33.0 from 2.33.1",
            live: "2.33.1",
            run: { event: "workflow_run", display_title: `Deploy ${commitOf("2.33.0")}` },
          },
        ],
      ];
      for (const [what, setup] of cases) {
        const s = quadletScenario({ live: "2.33.0", request: "deploy 2.33.1", ...setup });
        expect({
          what,
          outcome: s.result.outcome,
          reason: s.result.reason,
          calls: s.calls,
        }).toEqual({
          what,
          outcome: "refused",
          reason: "not-approved",
          calls: [],
        });
        // Staging never asks for approvals.
        expect({ what, approvals: s.apiCalls.filter((u) => u.endsWith("/approvals")) }).toEqual({
          what,
          approvals: [],
        });
      }
    },
    slow,
  );

  test(
    "production modes refuse staging titles, a waiting run and a run where only Deploy staging runs",
    () => {
      // Each case for Compose (2.30.0 to 2.30.1) and production's Quadlet mode (2.33.0 to 2.33.1),
      // with the owner's production approval in place.
      const cases: [string, (v: string) => Partial<Scenario & QuadletScenario>][] = [
        ["a staging title", (v) => ({ run: { display_title: `Deploy ${v} to staging` } })],
        ["a waiting run", () => ({ run: { status: "waiting" } })],
        [
          "only Deploy staging running",
          () => ({ jobs: jobs(plan, waitingDeploy, runningStaging) }),
        ],
      ];
      for (const [what, setup] of cases) {
        const compose = scenario({ live: "2.30.0", request: "deploy 2.30.1", ...setup("2.30.1") });
        const quadlet = quadletScenario({
          mode: "quadlet",
          live: "2.33.0",
          request: "deploy 2.33.1",
          ...setup("2.33.1"),
        });
        expect({ what, compose: compose.result.reason, quadlet: quadlet.result.reason }).toEqual({
          what,
          compose: "not-approved",
          quadlet: "not-approved",
        });
        expect({ what, compose: compose.calls, quadlet: quadlet.calls }).toEqual({
          what,
          compose: [],
          quadlet: [],
        });
      }
    },
    slow,
  );

  test(
    "Compose calls no Podman or systemd tool on any path",
    () => {
      for (const [live, request, knobs] of [
        ["2.30.0", "deploy 2.30.1", {}],
        ["2.30.1", "deploy 2.31.0", {}],
        ["2.30.0", "deploy 2.30.1", { "up.2.30.1": "fail-before-lease" }],
        ["2.30.1", "deploy 2.30.1", {}],
      ] as const) {
        const s = scenario({ live, request, knobs });
        const tools = [...new Set(s.runtime.map((line) => line.slice(0, line.indexOf(" "))))];
        expect({ request, knobs, tools }).toEqual({ request, knobs, tools: ["docker"] });
      }
    },
    slow,
  );
});

// ---------------------------------------------------------------------------------------------
// The entry: attach, replay, a dead worker, and the detached launch
// ---------------------------------------------------------------------------------------------

describe("the entry", () => {
  const commit = hex("entry commit", 40);
  const digest = `sha256:${hex("entry digest")}`;
  const request = `deploy 2.30.1 ${commit} ${digest} ${RUN_ID}`;
  const result = (outcome: string, reason = "-") =>
    `result outcome=${outcome} version=2.30.1 previous=2.30.0 path=plain downtime=4 commands=registered backup=- restore_point=- reason=${reason}`;

  /** A run directory with the given files. */
  function runDir(box: Sandbox, files: Record<string, string>) {
    const dir = join(box.state, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  const entry = (box: Sandbox, command = request, self = join(box.bin, "worker"), mode = "") =>
    run(
      ["bash", join(STUBS, "run-entry.sh")],
      environment(box, { SSH_ORIGINAL_COMMAND: command, DEPLOY_SELF: self, DEPLOY_MODE: mode }),
    );

  test("a finished run replays its public lines only, and exits by its outcome", () => {
    const box = sandbox();
    runDir(box, {
      request: `${request}\n`,
      "public.log": `step preflight\nstep up\n::error::not a public line\nstep commands\n${result("deployed")}\n`,
      result: "deployed\n",
    });
    const replay = entry(box);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe(`step preflight\nstep up\nstep commands\n${result("deployed")}\n`);
    const refusedBox = sandbox();
    runDir(refusedBox, {
      request: `${request}\n`,
      "public.log": `${result("refused", "busy")}\n`,
      result: "refused\n",
    });
    expect(entry(refusedBox).code).toBe(1);
  });

  test("the committed v1 run directory still replays", () => {
    // The Quadlet modes keep the command format and the layout: their entry replays it too.
    for (const mode of ["", "quadlet", "quadlet staging"]) {
      const box = sandbox();
      const fixture = root("tests/fixtures/deploy-runs/v1/36300000001");
      const dir = join(box.state, "runs", "36300000001");
      mkdirSync(dir, { recursive: true });
      // public.log is stored as public.log.fixture: .gitignore and .dockerignore leave out *.log.
      cpSync(join(fixture, "request"), join(dir, "request"));
      cpSync(join(fixture, "result"), join(dir, "result"));
      cpSync(join(fixture, "public.log.fixture"), join(dir, "public.log"));
      const replay = entry(
        box,
        readFileSync(join(fixture, "request"), "utf8").trim(),
        join(box.bin, "worker"),
        mode,
      );
      expect({ mode, code: replay.code }).toEqual({ mode, code: 0 });
      expect(replay.stdout).toBe(readFileSync(join(fixture, "public.log.fixture"), "utf8"));
      // Its result line is what the workflow parses.
      expect(replay.stdout.trim().split("\n").at(-1)).toMatch(RESULT_FORM);
    }
  });

  test("a different request under the same run id is refused", () => {
    const box = sandbox();
    runDir(box, { request: `deploy 2.30.2 ${commit} ${digest} ${RUN_ID}\n` });
    const attempt = entry(box);
    expect(attempt.code).toBe(64);
    expect(attempt.stdout).toBe(`${USAGE}\n`);
  });

  test("a free run lock with a step and no result reports the dead worker", () => {
    const box = sandbox();
    const dir = runDir(box, {
      request: `${request}\n`,
      step: "up\n",
      "public.log": "step preflight\nstep pull\nstep up\n",
    });
    const died = entry(box);
    expect(died.code).toBe(1);
    const line =
      "result outcome=needs-you version=2.30.1 previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=worker-died";
    expect(died.stdout).toBe(`step preflight\nstep pull\nstep up\nstep up\n${line}\n`);
    expect(line).toMatch(RESULT_FORM);
    expect(readFileSync(join(dir, "result"), "utf8")).toBe("needs-you\n");
  });

  test("a busy run lock is followed until the worker's result", async () => {
    const box = sandbox();
    const dir = runDir(box, { request: `${request}\n`, "public.log": "step preflight\n" });
    // A stand-in worker holds the run lock, writes two more lines and the result, then exits.
    const holder = Bun.spawn(
      [
        "flock",
        join(dir, "lock"),
        "bash",
        "-c",
        'touch "$1/held"; sleep 0.4; printf "step up\\n" >>"$1/public.log"; sleep 0.4; printf "%s\\n" "$2" >>"$1/public.log"; printf "deployed\\n" >"$1/result"',
        "holder",
        dir,
        result("deployed"),
      ],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    for (let i = 0; i < 100 && !existsSync(join(dir, "held")); i++) await Bun.sleep(20);
    const followed = entry(box);
    await holder.exited;
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe(`step preflight\nstep up\n${result("deployed")}\n`);
  }, 20_000);

  test("a new run launches the worker and, if it never starts, says nothing changed", () => {
    const box = sandbox();
    // A worker that exits at once without writing a step.
    const quiet = join(box.bin, "quiet-worker");
    writeFileSync(quiet, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(quiet, 0o755);
    const attempt = entry(box, request, quiet);
    expect(attempt.code).toBe(1);
    const line =
      "result outcome=refused version=2.30.1 previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=worker-not-started";
    expect(attempt.stdout).toBe(`${line}\n`);
    expect(readFileSync(join(box.state, "runs", RUN_ID, "request"), "utf8")).toBe(`${request}\n`);
  }, 20_000);

  /** A refusal's result line, as the worker or the entry writes it for this request. */
  const refused = (reason: string, previous = "-") =>
    `result outcome=refused version=2.30.1 previous=${previous} path=none downtime=- commands=skipped backup=- restore_point=- reason=${reason}`;
  /** A worker that exits at once without writing a step. */
  const quietWorker = (box: Sandbox) => {
    const path = join(box.bin, "quiet-worker");
    writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path, 0o755);
    return path;
  };

  test("a run refused before its approval was confirmed starts over, even for a new request", () => {
    const box = sandbox();
    const dir = runDir(box, {
      request: `${request}\n`,
      step: "preflight\n",
      "public.log": `step preflight\n${refused("not-approved", "2.30.0")}\n`,
      result: "refused\n",
    });
    // The same request launches a new worker (this one never writes a step), and the old refusal
    // isn't replayed.
    const again = entry(box, request, quietWorker(box));
    expect(again.code).toBe(1);
    expect(again.stdout).toBe(`${refused("worker-not-started")}\n`);
    // A different request for that run id is taken too: nothing happened under the old one.
    const other = `deploy 2.30.1 ${commit} sha256:${hex("another digest")} ${RUN_ID}`;
    const taken = entry(box, other, quietWorker(box));
    expect(taken.code).toBe(1);
    expect(readFileSync(join(dir, "request"), "utf8")).toBe(`${other}\n`);
    // run-entry.sh leaves the entry's log on stderr (main points it at entry.log).
    expect(taken.stderr).toContain(
      `run ${RUN_ID}: starting over after a refusal before the approval was confirmed`,
    );
    // Any other finished run still keeps its request.
    const kept = sandbox();
    runDir(kept, {
      request: `${request}\n`,
      "public.log": `${result("deployed")}\n`,
      result: "deployed\n",
    });
    const conflicting = entry(kept, other);
    expect(conflicting.code).toBe(64);
    expect(conflicting.stdout).toBe(`${USAGE}\n`);
    const busy = sandbox();
    runDir(busy, {
      request: `${request}\n`,
      "public.log": `${refused("busy")}\n`,
      result: "refused\n",
    });
    expect(entry(busy, request).stdout).toBe(`${refused("busy")}\n`);
  }, 20_000);

  test("with four workers running, a new run is refused before it gets a directory", () => {
    const box = sandbox();
    const holders = [1, 2, 3, 4].map((n) =>
      holdLock(join(box.state, "runs", `3630000010${n}`, "lock")),
    );
    const attempt = entry(box);
    for (const holder of holders) holder.kill();
    expect(attempt.code).toBe(1);
    expect(attempt.stdout).toBe(`${refused("too-many-runs")}\n`);
    expect(refused("too-many-runs")).toMatch(RESULT_FORM);
    expect(existsSync(join(box.state, "runs", RUN_ID))).toBe(false);
  }, 20_000);

  test("prune drops retryable runs after 10 minutes and keeps other finished runs", () => {
    const box = sandbox();
    const make = (id: string, line: string, outcome: string, minutes: number) => {
      const dir = join(box.state, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "request"), `deploy 2.30.1 ${commit} ${digest} ${id}\n`);
      writeFileSync(join(dir, "public.log"), `${line}\n`);
      writeFileSync(join(dir, "result"), `${outcome}\n`);
      const when = new Date(Date.now() - minutes * 60_000);
      utimesSync(dir, when, when);
      return dir;
    };
    const stale = make("36300000201", refused("not-approved"), "refused", 20);
    const fresh = make("36300000202", refused("approval-unverified"), "refused", 1);
    const deployed = make("36300000203", result("deployed"), "deployed", 20);
    const busy = make("36300000204", refused("busy"), "refused", 20);
    entry(box, request, quietWorker(box));
    expect({
      stale: existsSync(stale),
      fresh: existsSync(fresh),
      deployed: existsSync(deployed),
      busy: existsSync(busy),
    }).toEqual({ stale: false, fresh: true, deployed: true, busy: true });
  }, 20_000);

  test.skipIf(!endToEnd)(
    "a request runs through main into the real, detached worker",
    () => {
      const box = sandbox();
      const ops = join(box.dir, "root", "ops");
      mkdirSync(ops, { recursive: true });
      cpSync(SCRIPT, join(ops, "deploy.sh"));
      chmodSync(join(ops, "deploy.sh"), 0o755);
      // The worker runs on the fixed PATH, where no stub is, but its curl reads HOME's .curlrc: a
      // closed local proxy makes GitHub's API unreachable without leaving this machine.
      writeFileSync(join(box.home, ".curlrc"), 'proxy = "http://127.0.0.1:9"\n');
      // Each call starts from a session umask of 0002, the host user's.
      const direct = (env: Record<string, string>, ...args: string[]) =>
        run(
          [
            "bash",
            "-c",
            'umask 0002 && exec bash "$@"',
            "session",
            join(ops, "deploy.sh"),
            ...args,
          ],
          { HOME: box.home, PATH: "/usr/bin:/bin", ...env },
        );
      const first = direct({ SSH_ORIGINAL_COMMAND: request });
      expect(first.code).toBe(1);
      expect(first.stdout).toBe(`step preflight\n${refused("approval-unverified")}\n`);
      const dir = join(box.state, "runs", RUN_ID);
      // main's umask covers the entry and the detached worker: the state stays private.
      const mode = (path: string) =>
        Bun.spawnSync(["stat", "-c", "%a", path]).stdout.toString().trim();
      expect({
        state: mode(box.state),
        run: mode(dir),
        entryLog: mode(join(box.state, "entry.log")),
        files: ["request", "lock", "public.log", "worker.log", "step", "result"].map((file) =>
          mode(join(dir, file)),
        ),
      }).toEqual({ state: "700", run: "700", entryLog: "600", files: Array(6).fill("600") });
      expect(readFileSync(join(dir, "worker.log"), "utf8")).toContain("step preflight");
      expect(readFileSync(join(box.state, "entry.log"), "utf8")).toContain(
        `run ${RUN_ID}: deploy 2.30.1 started`,
      );
      // main hands exactly seven arguments to the worker. With the run directory there but its
      // lock free, the worker itself refuses to start (70); any other count stops in main (64).
      const worker = (...extra: string[]) =>
        direct({}, "__worker", "deploy", "2.30.1", commit, digest, RUN_ID, ...extra).code;
      expect(worker("-")).toBe(70);
      expect(readFileSync(join(dir, "worker.log"), "utf8")).toContain("the run lock is not held");
      expect(worker()).toBe(64);
      expect(worker("-", "x")).toBe(64);
    },
    30_000,
  );

  test.skipIf(!endToEnd)(
    "a request runs through main into the real worker in both Quadlet modes",
    () => {
      for (const words of [["quadlet"], ["quadlet", "staging"]]) {
        const box = sandbox();
        const ops = join(box.dir, "root", "ops");
        mkdirSync(ops, { recursive: true });
        cpSync(SCRIPT, join(ops, "deploy.sh"));
        chmodSync(join(ops, "deploy.sh"), 0o755);
        // As above: a closed local proxy stands in for GitHub's API.
        writeFileSync(join(box.home, ".curlrc"), 'proxy = "http://127.0.0.1:9"\n');
        const direct = (env: Record<string, string>, ...args: string[]) =>
          run(["bash", join(ops, "deploy.sh"), ...args], {
            HOME: box.home,
            PATH: "/usr/bin:/bin",
            ...env,
          });
        // The forced command's words reach the detached worker, which asks GitHub first.
        const first = direct({ SSH_ORIGINAL_COMMAND: request }, ...words);
        expect({ words, code: first.code, stdout: first.stdout }).toEqual({
          words,
          code: 1,
          stdout: `step preflight\n${refused("approval-unverified")}\n`,
        });
        // The worker takes seven arguments plus the words; with its lock free it refuses (70),
        // and any other words or count stop it or main (64).
        const worker = (...extra: string[]) =>
          direct({}, "__worker", "deploy", "2.30.1", commit, digest, RUN_ID, ...extra).code;
        expect({ words, valid: worker("-", ...words) }).toEqual({ words, valid: 70 });
        for (const extra of [["x"], ["staging"], ["quadlet", "x"], ["quadlet", "staging", "x"]])
          expect({ extra, code: worker("-", ...extra) }).toEqual({ extra, code: 64 });
      }
    },
    60_000,
  );

  /**
   * Start the stand-in worker through the real launch, then hang up the launching process group as
   * sshd's teardown would (run-launch.sh waits until the worker has started, at most 60 s). The
   * worker records its arguments, environment and fd 8 in HOME; the result is how long it took to
   * write stub-started and stub-done (false when it never did).
   */
  async function launchAndHangUp(box: Sandbox, mode = "") {
    const self = join(box.bin, "worker");
    cpSync(join(STUBS, "worker"), self);
    chmodSync(self, 0o755);
    const launched = Bun.spawn(["setsid", "-w", "bash", join(STUBS, "run-launch.sh")], {
      env: environment(box, {
        DEPLOY_SELF: self,
        DEPLOY_MODE: mode,
        REQUEST: request,
        SSH_ORIGINAL_COMMAND: request,
        // What sshd could pass on, and what Compose would read: none of it reaches the worker.
        DOCKER_HOST: "tcp://attacker.invalid:2375",
        TARUBOT_IMAGE_TAG: "9.9.9",
        DEPLOY_TEST_SECRET: "must-not-reach-the-worker",
      }),
      stdin: "ignore",
    });
    await launched.exited;
    const lock = join(box.state, "runs", RUN_ID, "lock");
    const wait = async (name: string) => {
      for (let i = 0; i < 600 && !existsSync(join(box.home, name)); i++) await Bun.sleep(100);
      return existsSync(join(box.home, name));
    };
    const started = await wait("stub-started");
    // While the worker runs, it holds the run lock the entry took.
    const heldWhileRunning = run(["flock", "-n", lock, "true"], { PATH: "/usr/bin:/bin" }).code;
    const done = await wait("stub-done");
    await Bun.sleep(200);
    const freeAfter = run(["flock", "-n", lock, "true"], { PATH: "/usr/bin:/bin" }).code;
    return { started, heldWhileRunning, done, freeAfter };
  }

  test("the worker survives the SSH session's hangup, with a clean environment and the run lock", async () => {
    const box = sandbox();
    const launched = await launchAndHangUp(box);
    expect(launched.started).toBe(true);
    // While the worker runs, it holds the run lock the entry took.
    expect(launched.heldWhileRunning).toBe(1);
    expect(launched.done).toBe(true);
    expect(launched.freeAfter).toBe(0);
    expect(readFileSync(join(box.home, "stub-args"), "utf8").trim().split("\n")).toEqual([
      "__worker",
      "deploy",
      "2.30.1",
      commit,
      digest,
      RUN_ID,
      "-",
    ]);
    expect(readFileSync(join(box.home, "stub-fd8"), "utf8")).toBe("open\n");
    // env -i: only HOME, the fixed PATH and the C locale, plus what bash itself sets.
    const names = readFileSync(join(box.home, "stub-env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
      .sort();
    expect(names).toEqual(["HOME", "LC_ALL", "PATH"]);
    const env = readFileSync(join(box.home, "stub-env"), "utf8");
    expect(env).toContain("PATH=/usr/local/bin:/usr/bin:/bin\n");
    expect(env).toContain("LC_ALL=C\n");
  }, 120_000);

  test("the launch appends the forced command's mode words, and nothing else changes", async () => {
    const box = sandbox();
    const launched = await launchAndHangUp(box, "quadlet staging");
    expect(launched).toEqual({ started: true, heldWhileRunning: 1, done: true, freeAfter: 0 });
    expect(readFileSync(join(box.home, "stub-args"), "utf8").trim().split("\n")).toEqual([
      "__worker",
      "deploy",
      "2.30.1",
      commit,
      digest,
      RUN_ID,
      "-",
      "quadlet",
      "staging",
    ]);
    const names = readFileSync(join(box.home, "stub-env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
      .sort();
    expect(names).toEqual(["HOME", "LC_ALL", "PATH"]);
  }, 120_000);
});
