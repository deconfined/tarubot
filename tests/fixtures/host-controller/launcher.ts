/**
 * Pinned, local-only controller fixture launcher. There is no argv/env-selected transport,
 * playbook, inventory or runtime pin. Core's source aggregate is verified here; interpreter,
 * console script and transitive dependencies remain the explicitly trusted native-test
 * capability. Operational installation still needs its independently hash-pinned closure.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import type {
  HostBridgeHandlerIO,
  HostBridgeHandlers,
} from "../../../scripts/host-bridge-adapter.js";
import { startFixtureIPC } from "./transport.js";

export const controllerPin = Object.freeze({
  schema: 1,
  version: "2.21.4",
  wheel_sha256: "ebe74d9c8fadcb41ad2151e031bf1e785e3098aaa015019b4e19a0a96f0dcc4f",
  source_manifest_sha256: "fb06391038b33843a09651d29bc8f389bb80e24abf1f4229014fc2e2b3780087",
});
export interface FixtureController {
  readonly playbook: string;
  readonly python: string;
  readonly source: string;
}
export type ControllerFixture =
  | "modules"
  | "files"
  | "sudo"
  | "bad-marker"
  | "overrides"
  | "reset"
  | "reboot"
  | "abandoned";
export interface ControllerFixtureResult {
  readonly status: "passed" | "refused";
  readonly code: number;
  readonly allocations: number;
  readonly completed: number;
  readonly handlers: number;
  readonly fenced: boolean;
  readonly sudo_inputs: number;
  readonly trap_called: boolean;
  readonly death_fenced: boolean;
  /** An owned invented local fixture directory; raw controller output never becomes public. */
  readonly directory: string;
}
const failure = "host-controller-fixture-failed";
const pluginRoot = resolve(import.meta.dir, "../../../ops/ansible/connection_plugins");
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error(failure);
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function verifyFixtureController(controller: FixtureController): void {
  const files: [string, string][] = [];
  let bytes = 0;
  const visit = (relative: string) => {
    const path = join(controller.source, relative);
    const info = lstatSync(path);
    requireValue(!info.isSymbolicLink());
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (name !== "__pycache__" && !name.endsWith(".pyc"))
          visit(relative ? `${relative}/${name}` : name);
      }
    } else {
      requireValue(info.isFile() && info.size <= 4 * 1024 * 1024 && ++bytes > 0);
      bytes += info.size;
      requireValue(bytes <= 32 * 1024 * 1024 && files.length < 2048);
      const content = readFileSync(path);
      const after = lstatSync(path);
      requireValue(
        info.ino === after.ino &&
          info.dev === after.dev &&
          info.size === content.length &&
          info.mtimeMs === after.mtimeMs,
      );
      files.push([relative, digest(content)]);
    }
  };
  visit("");
  files.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  requireValue(
    files.length === 801 &&
      digest(Buffer.from(JSON.stringify(files))) === controllerPin.source_manifest_sha256,
  );
}
function capturedController(value: FixtureController): FixtureController {
  const fields = Object.getOwnPropertyDescriptors(value);
  requireValue(Object.keys(fields).sort().join(",") === "playbook,python,source");
  const output: Record<string, string> = {};
  for (const key of ["playbook", "python", "source"]) {
    const field = fields[key];
    requireValue(
      field &&
        Object.hasOwn(field, "value") &&
        typeof field.value === "string" &&
        resolve(field.value) === field.value &&
        field.value.length <= 4096,
    );
    output[key] = field.value;
  }
  return Object.freeze(output) as unknown as FixtureController;
}
function privateWrite(path: string, content: string | Uint8Array, mode = 0o600): void {
  writeFileSync(path, content, { flag: "wx", mode });
}
async function collect(input: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = input.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      requireValue(size <= 8 * 1024 * 1024);
      parts.push(Buffer.from(value.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
async function output(io: HostBridgeHandlerIO, text: string, kind: "stdout" | "stderr" = "stdout") {
  if (text) await io[kind](Buffer.from(text));
}
function fixturePlay(root: string, name: ControllerFixture): object[] {
  const target = "tarubot_fixture_target";
  const play: Record<string, unknown> = { hosts: "all", gather_facts: false, tasks: [] };
  let tasks: object[];
  switch (name) {
    case "modules":
      tasks = [
        { "ansible.builtin.ping": {} },
        {
          "ansible.builtin.command": {
            argv: ["/bin/sh", "-c", "printf fixture-stdout; printf fixture-stderr >&2; exit 7"],
          },
          register: "ordinary",
          failed_when: false,
        },
        {
          "ansible.builtin.assert": {
            that: [
              "ordinary.rc == 7",
              "ordinary.stdout == 'fixture-stdout'",
              "ordinary.stderr == 'fixture-stderr'",
            ],
          },
        },
      ];
      break;
    case "files":
      tasks = [
        {
          "ansible.builtin.copy": {
            src: join(root, "source.bin"),
            dest: join(root, "remote.bin"),
            mode: "0600",
          },
        },
        {
          "ansible.builtin.fetch": {
            src: join(root, "remote.bin"),
            dest: join(root, "fetched.bin"),
            flat: true,
          },
        },
      ];
      break;
    case "sudo":
      tasks = [
        { "ansible.builtin.ping": {}, become: true },
        { "ansible.builtin.ping": {}, become: true },
      ];
      break;
    case "bad-marker":
      tasks = [{ "ansible.builtin.ping": {}, become: true }];
      break;
    case "overrides":
      play.connection = "local";
      play.vars = {
        ansible_connection: "local",
        ansible_become_method: "su",
        ansible_python_interpreter: "/invalid/fixture-interpreter",
      };
      tasks = [
        { "ansible.builtin.set_fact": { ansible_connection: "local" } },
        { "ansible.builtin.ping": {}, connection: "local", vars: { ansible_connection: "local" } },
      ];
      break;
    case "reset":
      tasks = [
        { "ansible.builtin.raw": "fixture-only-refusal", ignore_unreachable: true },
        { "ansible.builtin.meta": "reset_connection" },
        { "ansible.builtin.raw": "fixture-only-next-worker", ignore_unreachable: true },
      ];
      break;
    case "reboot":
      tasks = [
        {
          "ansible.builtin.reboot": {
            reboot_command: "/tarubot-fixture-only-never-executed",
            boot_time_command: "fixture-only-boot-id",
            reboot_timeout: 1,
            connect_timeout: 1,
            test_command: "fixture-only-readiness",
          },
        },
      ];
      break;
    case "abandoned":
      tasks = [{ "ansible.builtin.ping": {} }];
      break;
  }
  play.tasks = tasks;
  return [
    play,
    {
      hosts: "localhost",
      gather_facts: false,
      tasks: [
        {
          "ansible.builtin.assert": {
            that: [`"${target}" in hostvars`, "ansible_connection == 'ansible.builtin.local'"],
          },
        },
      ],
    },
  ];
}
async function runChild(
  cmd: string[],
  root: string,
  env: Record<string, string>,
  timeout: number,
  label: string,
  onDeath: () => void,
  killBeforeAccept = false,
): Promise<{ code: number; stdout: Buffer }> {
  const child = spawn(cmd[0] as string, cmd.slice(1), {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (killBeforeAccept) child.once("spawn", () => child.kill("SIGKILL"));
  child.stdin.end();
  let bytes = 0;
  let refused = false;
  const timer = setTimeout(() => {
    refused = true;
    onDeath();
    child.kill("SIGKILL");
  }, timeout);
  const parts: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  const drain = async (kind: "stdout" | "stderr") => {
    for await (const chunk of child[kind]) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        refused = true;
        onDeath();
        child.kill("SIGKILL");
        throw new Error(failure);
      }
      parts[kind].push(Buffer.from(chunk));
    }
  };
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(signal || code === null ? 255 : code));
  });
  try {
    const [code] = await Promise.all([exit, drain("stdout"), drain("stderr")]);
    if (code !== 0) onDeath();
    for (const kind of ["stdout", "stderr"] as const)
      privateWrite(join(root, `${label}.${kind}`), Buffer.concat(parts[kind]));
    requireValue(!refused);
    return { code, stdout: Buffer.concat(parts.stdout) };
  } catch {
    onDeath();
    child.kill("SIGKILL");
    await exit.catch(() => {});
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
  }
}
async function localModule(
  command: readonly string[],
  io: HostBridgeHandlerIO,
  root: string,
): Promise<number> {
  requireValue(command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c");
  const child: ChildProcessWithoutNullStreams = spawn("/bin/sh", ["-c", command[2] as string], {
    cwd: root,
    env: {
      PATH: `${join(root, "traps")}:/usr/bin:/bin`,
      HOME: root,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = Readable.fromWeb(
    io.input as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  stream.on("error", () => child.kill("SIGKILL"));
  child.stdin.on("error", () => {});
  stream.pipe(child.stdin);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const drain = async (kind: "stdout" | "stderr") => {
    for await (const bytes of child[kind]) {
      const chunk = Buffer.from(bytes);
      for (let at = 0; at < chunk.length; at += 65536)
        await io[kind](chunk.subarray(at, at + 65536));
    }
  };
  const exited = new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept(signal || code === null ? 255 : code));
  });
  try {
    const [code] = await Promise.all([exited, drain("stdout"), drain("stderr")]);
    return code;
  } finally {
    clearTimeout(timer);
    stream.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
  }
}
/** Fixed scenario names are data, not arbitrary playbook or process/transport selectors. */
export async function runHostControllerFixture(
  value: FixtureController,
  name: ControllerFixture,
): Promise<ControllerFixtureResult> {
  let stop: (() => Promise<void>) | undefined;
  try {
    requireValue(
      [
        "modules",
        "files",
        "sudo",
        "bad-marker",
        "overrides",
        "reset",
        "reboot",
        "abandoned",
      ].includes(name),
    );
    const controller = capturedController(value);
    const started = performance.now();
    verifyFixtureController(controller);
    const root = mkdtempSync(join(tmpdir(), "tb-controller-"));
    chmodSync(root, 0o700);
    for (const directory of ["plugins", "home", "tmp", "remote", "traps", "empty"])
      mkdirSync(join(root, directory), { mode: 0o700 });
    for (const file of ["tarubot_guarded.py", "_tarubot_frames.py"]) {
      const content = readFileSync(join(pluginRoot, file));
      privateWrite(join(root, "plugins", file), content);
      requireValue(digest(readFileSync(join(root, "plugins", file))) === digest(content));
    }
    for (const executable of ["ssh", "scp", "sftp"])
      privateWrite(
        join(root, "traps", executable),
        `#!/bin/sh\nprintf invoked > '${join(root, "trap-called")}'\nexit 97\n`,
        0o700,
      );
    const config = join(root, "ansible.cfg");
    privateWrite(
      config,
      `[defaults]\ninventory=${join(root, "inventory.json")}\nconnection_plugins=${join(root, "plugins")}\nroles_path=${join(root, "empty")}\ncollections_path=${join(root, "empty")}\nlibrary=${join(root, "empty")}\naction_plugins=${join(root, "empty")}\nlookup_plugins=${join(root, "empty")}\ncallback_plugins=${join(root, "empty")}\nstdout_callback=default\nbin_ansible_callbacks=False\nretry_files_enabled=False\nhost_key_checking=True\ninterpreter_python=/usr/bin/python3\nlocal_tmp=${join(root, "tmp")}\nremote_tmp=${join(root, "remote")}\nforks=1\npipelining=True\n[ssh_connection]\npipelining=True\n[privilege_escalation]\nbecome_allow_same_user=True\n`,
    );
    const env = {
      PATH: `${join(root, "traps")}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      ANSIBLE_CONFIG: config,
    };
    const version = await runChild(
      [controller.playbook, "--version"],
      root,
      env,
      3000,
      "version",
      () => {},
    );
    requireValue(
      version.code === 0 &&
        version.stdout.toString().startsWith(`ansible-playbook [core ${controllerPin.version}]\n`),
    );
    privateWrite(
      join(root, "source.bin"),
      Uint8Array.from({ length: 1024 }, (_, index) => index % 256),
    );
    let handlers = 0;
    let sudoInputs = 0;
    const capabilities: HostBridgeHandlers = {
      async exec(io) {
        handlers++;
        if (name === "reset") throw new Error(failure);
        if (name === "sudo" || name === "bad-marker") {
          const command = io.command[2] ?? "";
          const found = command.match(/BECOME-SUCCESS-[a-z]{32}/gu);
          requireValue(found?.length === 1 && command.includes("sudo -H -S -n"));
          const marker = found[0] as string;
          if (name === "bad-marker") {
            await output(io, "BECOME-SUCCESS-wrong", "stderr");
            await output(io, `${marker}\n`);
            await collect(io.input);
            return 0;
          }
          const channel = handlers === 1 ? "stdout" : "stderr";
          await output(io, marker.slice(0, 17), channel);
          await Bun.sleep(5);
          await output(io, `${marker.slice(17)}\r`, channel);
          await Bun.sleep(5);
          await output(io, "\n", channel);
          const input = await collect(io.input);
          requireValue(input.length > 0);
          sudoInputs++;
          await output(io, '{"changed":false,"ping":"pong"}\n');
          return 0;
        }
        if (name === "reboot") {
          // Scripted actor: no command here is executed, including the invented reboot path.
          await collect(io.input);
          if (handlers === 1) {
            await output(
              io,
              '{"ansible_facts":{"ansible_distribution":"AlmaLinux","ansible_distribution_version":"10","ansible_os_family":"RedHat"}}\n',
            );
            return 0;
          }
          if (handlers === 2) {
            await output(io, "invented-boot-id\n");
            return 0;
          }
          throw new Error(failure);
        }
        return localModule(io.command, io, root);
      },
      async put(io) {
        handlers++;
        requireValue(dirname(io.path).startsWith(root) && resolve(io.path).startsWith(`${root}/`));
        const bytes = await collect(io.input);
        writeFileSync(io.path, bytes, { mode: 0o600 });
        return 0;
      },
      async fetch(io) {
        handlers++;
        requireValue(
          resolve(io.path).startsWith(`${root}/`) &&
            lstatSync(io.path).isFile() &&
            !lstatSync(io.path).isSymbolicLink(),
        );
        await collect(io.input);
        const bytes = readFileSync(io.path);
        requireValue(bytes.length <= 8 * 1024 * 1024);
        for (let at = 0; at < bytes.length; at += 65536)
          await io.file(bytes.subarray(at, at + 65536));
        return 0;
      },
    };
    const ipc = await startFixtureIPC(root, capabilities);
    stop = () => ipc.stop();
    privateWrite(
      join(root, "inventory.json"),
      JSON.stringify({
        all: {
          hosts: {
            tarubot_fixture_target: {
              ansible_connection: "local",
              ansible_host: "tarubot_fixture_target",
            },
          },
        },
      }),
    );
    privateWrite(
      join(root, "extra.json"),
      JSON.stringify({
        ansible_connection:
          "{{ 'ansible.builtin.local' if inventory_hostname == 'localhost' else 'tarubot_guarded' }}",
        ansible_user: "root",
        ansible_host: "tarubot_fixture_target",
        ansible_port: 22,
        ansible_shell_type: "sh",
        ansible_shell_executable: "/bin/sh",
        ansible_python_interpreter:
          "{{ ansible_playbook_python if inventory_hostname == 'localhost' else '/usr/bin/python3' }}",
        ansible_become_method: "sudo",
        ansible_become_exe: "/usr/bin/sudo",
        ansible_become_flags: "-H -S -n",
        ansible_become_pass: "",
        ansible_become_user: "root",
        ansible_ssh_executable: join(root, "traps", "ssh"),
        ansible_remote_tmp: join(root, "remote"),
      }),
    );
    privateWrite(join(root, "playbook.json"), JSON.stringify(fixturePlay(root, name)));
    let deathFenced = false;
    if (name === "abandoned") {
      ipc.coordinator.allocate("exec");
      // Same coordinator, separate actual controller worker. Death before the allocated
      // socket is accepted cannot quietly reset the ticket; the next controller still refuses.
      const death = await runChild(
        [
          controller.playbook,
          "--forks",
          "1",
          "--inventory",
          join(root, "inventory.json"),
          "--extra-vars",
          `@${join(root, "extra.json")}`,
          join(root, "playbook.json"),
        ],
        root,
        { ...env, TARUBOT_FIXTURE_BOOTSTRAP: ipc.bootstrap },
        3000,
        "abandoned-controller",
        () => ipc.coordinator.fence(),
        true,
      );
      deathFenced = death.code === 255 && ipc.coordinator.fenced;
      requireValue(deathFenced);
    }
    const ran = await runChild(
      [
        controller.playbook,
        "--forks",
        "1",
        "--inventory",
        join(root, "inventory.json"),
        "--extra-vars",
        `@${join(root, "extra.json")}`,
        join(root, "playbook.json"),
      ],
      root,
      { ...env, TARUBOT_FIXTURE_BOOTSTRAP: ipc.bootstrap },
      Math.max(1, 60_000 - (performance.now() - started)),
      "controller",
      () => ipc.coordinator.fence(),
    );
    const fenced = ipc.coordinator.fenced;
    const expectedRefusal = ["bad-marker", "reset", "reboot", "abandoned"].includes(name);
    const status = expectedRefusal
      ? fenced
        ? "passed"
        : "refused"
      : ran.code === 0 && !fenced
        ? "passed"
        : "refused";
    const result = Object.freeze({
      status,
      code: ran.code,
      allocations: ipc.allocations(),
      completed: ipc.completed(),
      handlers,
      fenced,
      sudo_inputs: sudoInputs,
      trap_called: (() => {
        try {
          lstatSync(join(root, "trap-called"));
          return true;
        } catch {
          return false;
        }
      })(),
      death_fenced: deathFenced,
      directory: root,
    });
    await ipc.stop();
    return result;
  } catch {
    await stop?.();
    throw new Error(failure);
  }
}
