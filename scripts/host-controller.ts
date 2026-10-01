/**
 * Native local controller ownership. Software declarations are data; only this fixed native
 * build/save/compare path mints an image capability, and only its captured engine launch
 * mints a paused-child capability. No callback, caller command, digest echo or phase tree
 * releases Ansible or authorizes exec/put/fetch. The local kernel/Docker daemon/runtime are
 * explicitly trusted prerequisites, not proved by their version text or child self-report.
 */
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  controllerBytes,
  controllerDigest,
  controllerJson,
  deriveControllerClosure,
  verifyControllerImage,
  reviewedControllerCatalogue,
  type ControllerClosure,
  type ControllerPublicBytes,
  type ControllerRecipeBytes,
} from "./host-controller-closure.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";

const failure = "host-controller-failed";
const nativeSpawn = spawn;
const nativeKill = ChildProcess.prototype.kill;
const nativeOn = EventEmitter.prototype.on;
const nativeThen = Promise.prototype.then;
const nativeWall = Date.now.bind(Date);
const nativePhysical = performance.now.bind(performance);
const root = resolve(import.meta.dir, "..");
const socket = "unix:///var/run/docker.sock";
const executable = "/usr/bin/docker";
// The shared JSON module is not a mutable runtime selector or authority source.
const pins = reviewedControllerCatalogue();
const images = new WeakMap<object, ImageState>();
const children = new WeakMap<object, ChildState>();
let activeHook: Window | undefined;
export interface BuiltHostController {
  readonly kind: "built-host-controller";
}
export interface PausedHostController {
  readonly kind: "paused-host-controller";
}
export interface HostControllerPhaseDeclaration {
  schema: 1;
  purpose: "tarubot-host-controller-phase-v1";
  target: "staging";
  action: "deploy";
  phase: "site" | "bot" | "accept";
  phase_number: 0 | 1 | 2;
  accept_release: true;
  configuration: { commit: string };
  release: ReleaseIdentity;
}
export interface HostControllerPhaseInput {
  declaration: HostControllerPhaseDeclaration;
  configuration_files: Readonly<Record<string, Uint8Array>>;
  release_files: Readonly<Record<string, Uint8Array>>;
}
export interface HostControllerInspection {
  schema: 1;
  kind: "built" | "paused" | "stopped";
  platform: "linux/amd64";
  rootfs_sha256: string;
  recipe_sha256: string;
  configuration_sha256?: string;
  release_sha256?: string;
  declaration?: Readonly<HostControllerPhaseDeclaration>;
  /** These copied declarations have no Git-object/event provenance or host authority. */
  source_authority: "untrusted-phase-declarations";
  worker_origin?: "native-pidfd-scm-credentials";
  descendant_isolation?: true;
}
const configurationFiles = [
  "ops/ansible/site.yml",
  "ops/ansible/vars/layout.yml",
  "ops/ansible/templates/dnf-automatic.conf.j2",
  "ops/ansible/files/dnf-automatic-timer-production.conf",
  "ops/ansible/files/sysctl-tarubot.conf",
  "ops/ansible/files/journald-tarubot.conf",
  "ops/ansible/files/multi-user-network-online.conf",
  "ops/ansible/files/tarubot-ipv6-online",
  "ops/ansible/files/tarubot-ipv6-online.service",
  "ops/ansible/files/sshd-00-tarubot.conf",
  "ops/ansible/files/polkit-10-tarubot.rules",
];
const releaseFiles = [
  "ops/ansible/bot.yml",
  "ops/ansible/accept.yml",
  "ops/ansible/vars/bot.yml",
  "ops/ansible/vars/targets/staging.yml",
  "ops/ansible/templates/bot/tarubot.env.j2",
  "ops/ansible/templates/bot/tarubot.container.j2",
  "ops/ansible/files/bot/tarubot-tool",
  "ops/ansible/files/bot/tarubot-backup",
  "ops/ansible/files/bot/tarubot-backup.service",
  "ops/ansible/files/bot/tarubot-backup.timer",
  "ops/age-recipients.txt",
];
function valid(value: unknown): asserts value {
  if (!value) throw new Error(failure);
}
function drain(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* No then getter. */
  }
}
function entry(value?: unknown): void {
  if (activeHook) {
    activeHook.stop();
    if (value && typeof value === "object") children.get(value)?.window.stop();
    throw new Error(failure);
  }
}
/** Original local-resource window: sticky FIRST epoch, hook costs and all held timers. */
class Window {
  #fenced = false;
  #checking = false;
  #last = 0;
  #wallEnd = 0;
  #physicalEnd: number;
  #anchors: number[] = [];
  #waits = new Set<{ timer: ReturnType<typeof setTimeout> | undefined; reject: () => void }>();
  #stoppers = new Set<() => unknown>();
  #refusal: (() => unknown) | undefined;
  constructor(milliseconds: number, refusal?: () => unknown) {
    this.#physicalEnd = nativePhysical() + milliseconds;
    this.#refusal = refusal;
    const before = nativePhysical();
    const now = this.#clock();
    valid(Number.isSafeInteger(now));
    this.#last = now;
    this.#wallEnd = now + milliseconds;
    this.#physicalEnd = Math.min(this.#physicalEnd, before + milliseconds);
    this.check();
  }
  #alive(): void {
    valid(!this.#fenced && nativePhysical() < this.#physicalEnd);
  }
  #clock(): number {
    this.#alive();
    const prior = activeHook;
    activeHook = this;
    let result: unknown;
    try {
      result = nativeWall();
      this.#alive();
      if (typeof result !== "number") {
        drain(result);
        throw new Error(failure);
      }
      return result;
    } catch {
      drain(result);
      this.stop();
      throw new Error(failure);
    } finally {
      activeHook = prior;
    }
  }
  #observe(before: number): void {
    this.#alive();
    const now = this.#clock();
    valid(Number.isSafeInteger(now) && now >= this.#last && now < this.#wallEnd);
    this.#last = now;
    this.#physicalEnd = Math.min(
      this.#physicalEnd,
      before + this.#wallEnd - now,
      ...this.#anchors.map((anchor) => anchor + this.#wallEnd - now),
    );
    this.#alive();
    this.#rearm();
  }
  #rearm(): void {
    for (const wait of this.#waits) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.timer = setTimeout(
        () => this.stop(),
        Math.max(1, Math.ceil(this.#physicalEnd - nativePhysical())),
      );
    }
  }
  check(): void {
    let owns = false;
    try {
      this.#alive();
      valid(!this.#checking);
      this.#checking = true;
      owns = true;
      this.#observe(nativePhysical());
      if (this.#refusal) {
        const before = nativePhysical(),
          prior = activeHook;
        activeHook = this;
        this.#anchors.push(before);
        let result: unknown;
        try {
          result = this.#refusal();
          if (result !== undefined) {
            drain(result);
            throw new Error(failure);
          }
        } finally {
          try {
            this.#observe(before);
          } finally {
            this.#anchors.pop();
            activeHook = prior;
          }
        }
      }
      this.#observe(nativePhysical());
    } catch {
      this.stop();
      throw new Error(failure);
    } finally {
      if (owns) this.#checking = false;
    }
  }
  capture<T>(work: () => T): T {
    this.check();
    const before = nativePhysical(),
      prior = activeHook;
    activeHook = this;
    this.#anchors.push(before);
    let result: T | undefined,
      returned = false;
    try {
      result = work();
      returned = true;
      this.check();
      return result;
    } catch {
      if (returned) drain(result);
      this.stop();
      throw new Error(failure);
    } finally {
      this.#anchors.pop();
      activeHook = prior;
    }
  }
  remaining(): number {
    try {
      this.check();
      const value = Math.floor(this.#physicalEnd - nativePhysical());
      valid(value > 0);
      return value;
    } catch {
      this.stop();
      throw new Error(failure);
    }
  }
  stop(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    for (const wait of this.#waits) {
      if (wait.timer !== undefined) clearTimeout(wait.timer);
      wait.reject();
    }
    this.#waits.clear();
    for (const stop of this.#stoppers) {
      try {
        drain(stop());
      } catch {
        /* Owned accepted-resource cleanup. */
      }
    }
    this.#stoppers.clear();
  }
  onStop(stop: () => unknown): () => void {
    if (this.#fenced) {
      drain(stop());
      return () => {};
    }
    this.#stoppers.add(stop);
    return () => this.#stoppers.delete(stop);
  }
  watch(stop: () => void): () => void {
    const wait = { timer: undefined as ReturnType<typeof setTimeout> | undefined, reject: stop };
    this.#waits.add(wait);
    this.#rearm();
    return () => {
      this.#waits.delete(wait);
      if (wait.timer !== undefined) clearTimeout(wait.timer);
    };
  }
  async wait<T>(task: Promise<T>): Promise<T> {
    this.check();
    let rejectOwned: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      rejectOwned = () => reject(new Error(failure));
    });
    drain(timeout);
    valid(rejectOwned);
    const wait = {
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      reject: rejectOwned,
    };
    this.#waits.add(wait);
    this.#rearm();
    try {
      const result = await Promise.race([task, timeout]);
      this.check();
      return result;
    } catch {
      this.stop();
      drain(task);
      throw new Error(failure);
    } finally {
      this.#waits.delete(wait);
      if (wait.timer !== undefined) clearTimeout(wait.timer);
    }
  }
}
function fields(value: unknown, expected?: readonly string[]): PropertyDescriptorMap {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  valid(
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.getOwnPropertySymbols(value).length === 0,
  );
  const output = Object.getOwnPropertyDescriptors(value);
  valid(Object.values(output).every((field) => field.enumerable && Object.hasOwn(field, "value")));
  if (expected) valid(Object.keys(output).sort().join("\0") === [...expected].sort().join("\0"));
  return output;
}
function plain(value: unknown, depth = 0): unknown {
  valid(depth <= 16);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    valid(Number.isFinite(value));
    return value;
  }
  const input = fields(value);
  valid(Object.keys(input).length <= 32);
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(input))
    Object.defineProperty(output, key, { enumerable: true, value: plain(field.value, depth + 1) });
  return Object.freeze(output);
}
function phase(
  value: unknown,
  window: Window,
): {
  declaration: HostControllerPhaseDeclaration;
  configuration: Record<string, Buffer>;
  release: Record<string, Buffer>;
} {
  return window.capture(() => {
    const input = fields(value, ["declaration", "configuration_files", "release_files"]);
    const declaration = plain(input.declaration?.value) as HostControllerPhaseDeclaration;
    fields(declaration, [
      "schema",
      "purpose",
      "target",
      "action",
      "phase",
      "phase_number",
      "accept_release",
      "configuration",
      "release",
    ]);
    valid(
      declaration.schema === 1 &&
        declaration.purpose === "tarubot-host-controller-phase-v1" &&
        declaration.target === "staging" &&
        declaration.action === "deploy" &&
        declaration.accept_release === true,
    );
    valid(["site", "bot", "accept"].indexOf(declaration.phase) === declaration.phase_number);
    fields(declaration.configuration, ["commit"]);
    const release = releaseIdentity(declaration.release);
    valid(
      /^[0-9a-f]{40}$/u.test(declaration.configuration.commit) &&
        release.config_commit === declaration.configuration.commit &&
        release.commit === release.config_commit,
    );
    const capture = (raw: unknown, names: string[]): Record<string, Buffer> => {
      const descriptors = fields(raw, names),
        output: Record<string, Buffer> = Object.create(null);
      let total = 0;
      for (const name of names) {
        const bytes = controllerBytes(descriptors[name]?.value, 2 * 1024 * 1024);
        total += bytes.length;
        valid(total <= 8 * 1024 * 1024);
        output[name] = bytes;
        window.check();
      }
      return output;
    };
    return {
      declaration,
      configuration: capture(input.configuration_files?.value, configurationFiles),
      release: capture(input.release_files?.value, releaseFiles),
    };
  });
}
function publicBytes(value: unknown, window: Window): ControllerPublicBytes {
  return window.capture(() => {
    const input = fields(value, ["manifest", "config", "layers", "wheels"]);
    const rawLayers = input.layers?.value;
    valid(Array.isArray(rawLayers) && rawLayers.length === 4);
    const descriptors = Object.getOwnPropertyDescriptors(
      rawLayers,
    ) as unknown as PropertyDescriptorMap;
    valid(Object.keys(descriptors).length === 5 && descriptors.length?.value === 4);
    const layers = Array.from({ length: 4 }, (_, i) => {
      const field = descriptors[String(i)];
      valid(field?.enumerable && Object.hasOwn(field, "value"));
      return controllerBytes(field.value);
    });
    const wheelFields = fields(
      input.wheels?.value,
      pins.wheels.map((wheel) => wheel.filename),
    );
    const wheels: Record<string, Buffer> = Object.create(null);
    for (const wheel of pins.wheels) {
      wheels[wheel.filename] = controllerBytes(
        wheelFields[wheel.filename]?.value,
        32 * 1024 * 1024,
      );
      window.check();
    }
    return {
      manifest: controllerBytes(input.manifest?.value, 2 * 1024 * 1024),
      config: controllerBytes(input.config?.value, 2 * 1024 * 1024),
      layers,
      wheels,
    };
  });
}
function privateRoot(own: (path: string) => void): string {
  const path = mkdtempSync(join(tmpdir(), "tarubot-controller-"));
  // Record accepted ownership before chmod or an original post-hook check can withhold it.
  own(path);
  chmodSync(path, 0o700);
  return path;
}
function ownedRead(path: string, maximum: number, window: Window): Buffer {
  return window.capture(() => {
    // Node/Bun native open sets close-on-exec; no caller FD is inherited by the engine.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      window.check();
      const before = fstatSync(fd);
      valid(before.isFile() && before.nlink === 1 && before.size <= maximum);
      const result = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < result.length) {
        window.check();
        const count = readSync(fd, result, offset, result.length - offset, null);
        valid(count > 0);
        offset += count;
        window.check();
      }
      const after = fstatSync(fd);
      window.check();
      valid(
        before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs,
      );
      return result;
    } finally {
      closeSync(fd);
    }
  });
}
function recipe(window: Window): ControllerRecipeBytes {
  const output: Record<string, Buffer> = Object.create(null);
  for (const name of [
    "Containerfile",
    "assemble.py",
    "launcher.py",
    "pins.json",
    "tarubot_guarded.py",
    "_tarubot_frames.py",
  ])
    output[name] = ownedRead(
      join(
        root,
        name.endsWith("guarded.py") || name.startsWith("_tarubot")
          ? "ops/ansible/connection_plugins"
          : "ops/host-controller",
        name,
      ),
      2 * 1024 * 1024,
      window,
    );
  return output as unknown as ControllerRecipeBytes;
}
function writeOwned(path: string, bytes: Uint8Array, window: Window, mode = 0o600): void {
  window.capture(() => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    window.check();
    writeFileSync(path, bytes, { flag: "wx", mode });
    window.check();
  });
}
function environment(directory: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory };
}
interface EngineResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}
function boxed<T>(value: T): { value: T } {
  const box = Object.create(null) as { value: T };
  Object.defineProperty(box, "value", { value });
  return box;
}
function method(
  child: ChildProcessWithoutNullStreams,
  surface: "stdout" | "stderr" | "stdin" | "child",
  key: string,
  args: unknown[],
  window: Window,
): void {
  window.capture(() => {
    const object = surface === "child" ? child : child[surface];
    const fn: unknown = Reflect.get(object, key);
    valid(typeof fn === "function");
    window.check();
    const returned: unknown = Reflect.apply(fn, object, args);
    drain(returned);
    window.check();
  });
}
function engine(
  directory: string,
  args: string[],
  window: Window,
  maximum = 2 * 1024 * 1024,
  cleanupOutcome = false,
): Promise<{ value: EngineResult }> {
  const config = join(directory, "docker-config");
  window.capture(() => mkdirSync(config, { recursive: true, mode: 0o700 }));
  const argv = ["--host", socket, "--config", config, ...args],
    env = environment(directory);
  const task = new Promise<{ value: EngineResult }>((resolveTask, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let detach: (() => void) | undefined;
    let total = 0;
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const refuse = () => {
      window.stop();
      reject(new Error(failure));
    };
    try {
      window.capture(() => {
        window.check();
        child = nativeSpawn(executable, argv, {
          cwd: directory,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Own the returned child BEFORE any post-offer clock/callback can refuse it.
        const accepted = child;
        try {
          ownedErrors(accepted, refuse);
        } finally {
          detach = window.onStop(() => {
            kill(accepted);
            reject(new Error(failure));
          });
        }
        window.check();
      });
      valid(child);
      const collect = (parts: Buffer[]) => (chunk: unknown) => {
        try {
          window.check();
          const copy = controllerBytes(chunk, maximum);
          total += copy.length;
          valid(total <= maximum);
          parts.push(copy);
          window.check();
        } catch {
          refuse();
        }
      };
      method(child, "stdout", "on", ["data", collect(stdout)], window);
      method(child, "stderr", "on", ["data", collect(stderr)], window);
      for (const surface of ["stdin", "stdout", "stderr"] as const)
        method(child, surface, "on", ["error", refuse], window);
      method(child, "child", "on", ["error", refuse], window);
      method(
        child,
        "child",
        "on",
        [
          "close",
          (code: number | null) => {
            try {
              detach?.();
              window.check();
              valid(
                code === 0 ||
                  (cleanupOutcome &&
                    Number.isSafeInteger(code) &&
                    code !== null &&
                    code >= 0 &&
                    code <= 255),
              );
              const result = Object.assign(Object.create(null), {
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
                code,
              });
              window.check();
              resolveTask(boxed(result));
            } catch {
              refuse();
            }
          },
        ],
        window,
      );
      method(child, "stdin", "end", [], window);
    } catch {
      refuse();
    }
  });
  drain(task);
  return window.wait(task);
}
function tar(files: Record<string, Buffer>): Buffer {
  const output: Buffer[] = [];
  for (const [path, data] of Object.entries(files)) {
    valid(/^[A-Za-z0-9_.\-/]+$/u.test(path) && path.length < 100);
    const header = Buffer.alloc(512);
    header.write(path);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    output.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  output.push(Buffer.alloc(1024));
  return Buffer.concat(output);
}
interface ImageState {
  image: string;
  tag: string;
  closure: ControllerClosure;
  inspection: HostControllerInspection;
}
interface ChildState {
  window: Window;
  directory: string;
  image: ImageState;
  process: ChildProcessWithoutNullStreams;
  nonce: string;
  name: string;
  inspection: HostControllerInspection;
  stopped: boolean;
  unwatch: () => void;
  stoppedPromise: Promise<void>;
  dispose: () => Promise<void>;
  stopOperation: Promise<void> | undefined;
  phase: "preparing" | "validating" | "paused" | "stopping" | "stopped";
}
function kill(child: ChildProcessWithoutNullStreams): void {
  try {
    Reflect.apply(nativeKill, child, ["SIGKILL"]);
  } catch {
    /* Never consult a caller kill getter. */
  }
}
function ownedErrors(child: ChildProcessWithoutNullStreams, refuse: () => void): void {
  // Passive error sinks belong to accepted native resource cleanup. Install them before
  // any post-offer clock can withhold the child; no facade on/then getter is consulted.
  Reflect.apply(nativeOn, child, ["error", refuse]);
  for (const surface of ["stdin", "stdout", "stderr"] as const) {
    const owned = Object.getOwnPropertyDescriptor(child, surface);
    valid(owned && Object.hasOwn(owned, "value") && owned.value);
    Reflect.apply(nativeOn, owned.value, ["error", refuse]);
  }
}
async function removeOwned(
  directory: string,
  kind: "container" | "image",
  name: string,
): Promise<boolean> {
  const cleanupWindow = new Window(10_000);
  try {
    const outcome = await engine(
      directory,
      kind === "container" ? ["container", "rm", "--force", name] : ["image", "rm", name],
      cleanupWindow,
      2 * 1024 * 1024,
      true,
    );
    if (outcome.value.code === 0) return true;
    if (kind === "container") {
      const absent = await engine(
        directory,
        ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
        cleanupWindow,
      );
      return absent.value.stdout.length === 0;
    }
    return false;
  } catch {
    if (kind === "container") {
      // --rm may have removed this exact owned name already. Failure/unknown ACK does
      // not unlock bind trees unless one actual bounded native absence read confirms it.
      try {
        const absent = await engine(
          directory,
          ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
          cleanupWindow,
        );
        return absent.value.stdout.length === 0;
      } catch {
        /* Uncertain cleanup remains permanently fenced. */
      }
    }
    return false;
  } finally {
    cleanupWindow.stop();
  }
}
interface OwnedDirectory {
  path: string;
  dev: number;
  ino: number;
}
function removePrivatePhaseTree(directory: string, directories: readonly OwnedDirectory[]): void {
  // After the native container removal completes, restore only our bounded, statically
  // enumerated directories. No caller path, symlink target or recursive chmod is accepted.
  valid(directories.length <= 64);
  for (const owned of directories) {
    let fd: number | undefined;
    try {
      fd = openSync(owned.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      valid(info.dev === owned.dev && info.ino === owned.ino);
      fchmodSync(fd, 0o700);
    } catch {
      /* An absent/uncertain owned directory is never followed or substituted. */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
/** The public input is verified software bytes, never an engine/source path or command. */
export async function buildOwnedHostController(
  input: ControllerPublicBytes,
  refusal?: () => unknown,
): Promise<BuiltHostController> {
  entry();
  const window = new Window(600_000, refusal);
  let directory: string | undefined;
  // Containerd's OCI importer takes the descriptor name literally; fully qualify our
  // fresh tags so Docker's normalized lookup and cleanup address the same owned name.
  const baseTag = `docker.io/library/tarubot-controller-base:${randomBytes(16).toString("hex")}`;
  const tag = `docker.io/library/tarubot-controller:${randomBytes(16).toString("hex")}`;
  let baseOffered = false,
    outputOffered = false,
    delivered = false;
  try {
    window.capture(() =>
      privateRoot((owned) => {
        directory = owned;
      }),
    );
    valid(directory);
    const allocatedDirectory = directory;
    const bytes = publicBytes(input, window),
      sources = recipe(window);
    const closure = window.capture(() => deriveControllerClosure(bytes, sources));
    for (const fresh of [baseTag, tag]) {
      const prior = await engine(
        directory,
        ["image", "ls", "--filter", `reference=${fresh}`, "--format", "{{.ID}}"],
        window,
      );
      valid(prior.value.stdout.length === 0);
    }
    const baseFiles: Record<string, Buffer> = Object.create(null);
    // Preserve the exact independently pinned OCI config/manifest/compressed-layer bytes.
    // Docker-save conversion may normalize the original config; no observed conversion
    // is permitted to replace the reviewed expected base identity.
    baseFiles["oci-layout"] = Buffer.from('{"imageLayoutVersion":"1.0.0"}');
    baseFiles["index.json"] = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: `sha256:${pins.base.manifest_sha256}`,
            size: bytes.manifest.length,
            platform: { architecture: "amd64", os: "linux" },
            annotations: {
              "org.opencontainers.image.ref.name": baseTag,
              "io.containerd.image.name": baseTag,
            },
          },
        ],
      }),
    );
    baseFiles[`blobs/sha256/${pins.base.manifest_sha256}`] = controllerBytes(bytes.manifest);
    baseFiles[`blobs/sha256/${pins.base.config_sha256}`] = controllerBytes(bytes.config);
    for (const [i, part] of bytes.layers.entries()) {
      const layer = pins.base.layers[i];
      valid(layer);
      baseFiles[`blobs/sha256/${layer.sha256}`] = controllerBytes(part);
    }
    writeOwned(
      join(directory, "base.tar"),
      window.capture(() => tar(baseFiles)),
      window,
    );
    baseOffered = true;
    await engine(directory, ["image", "load", "--input", join(directory, "base.tar")], window);
    const base = await engine(
      directory,
      ["image", "inspect", baseTag, "--format", "{{.Id}}"],
      window,
    );
    // Classic stores identify a config; containerd stores identify the target manifest.
    // Both acceptable identities are independently pinned before any engine request.
    const baseIdentity = base.value.stdout.toString().trim();
    valid(
      [`sha256:${pins.base.config_sha256}`, `sha256:${pins.base.manifest_sha256}`].includes(
        baseIdentity,
      ),
    );
    const context = join(directory, "context");
    window.capture(() => mkdirSync(context, { mode: 0o700 }));
    for (const [name, content] of Object.entries(sources))
      writeOwned(join(context, name), content, window);
    for (const [name, content] of Object.entries(bytes.wheels))
      writeOwned(join(context, "wheels", name), content, window);
    // This sole, reviewed substitution uses the verified newly-owned local base tag. The
    // static original remains in context for assembler pin checking; there is no implicit pull.
    const original = controllerBytes(sources.Containerfile).toString("utf8");
    valid(original.split(pins.base.reference).length === 2);
    writeOwned(
      join(context, ".engine.Containerfile"),
      Buffer.from(original.replace(pins.base.reference, baseTag)),
      window,
    );
    const retainedBase = await engine(
      directory,
      ["image", "inspect", baseTag, "--format", "{{.Id}}"],
      window,
    );
    valid(retainedBase.value.stdout.toString().trim() === baseIdentity);
    // No implicit BuildKit attestation graph: verify only our single-platform artifact.
    outputOffered = true;
    await engine(
      directory,
      [
        "build",
        "--network=none",
        "--pull=false",
        "--no-cache",
        "--provenance=false",
        "--sbom=false",
        "--platform=linux/amd64",
        "--file",
        join(context, ".engine.Containerfile"),
        "--tag",
        tag,
        context,
      ],
      window,
      8 * 1024 * 1024,
    );
    const observed = await engine(
      directory,
      ["image", "inspect", tag, "--format", "{{.Id}}"],
      window,
    );
    const image = observed.value.stdout.toString().trim();
    valid(/^sha256:[0-9a-f]{64}$/u.test(image));
    await engine(
      directory,
      ["image", "save", "--output", join(directory, "image.tar"), image],
      window,
    );
    const checked = window.capture(() =>
      verifyControllerImage(
        ownedRead(join(allocatedDirectory, "image.tar"), 512 * 1024 * 1024, window),
        closure,
      ),
    );
    // Containerd identifies the authenticated OCI target DAG; classic Docker saves use
    // their authenticated config identity. The verifier selects a strict archive profile.
    valid(checked.native_image_ids.includes(image));
    const cap = Object.freeze(Object.create(null)) as BuiltHostController;
    const inspection = Object.freeze({
      schema: 1,
      kind: "built",
      platform: "linux/amd64",
      rootfs_sha256: closure.rootfs_sha256,
      recipe_sha256: closure.recipe_sha256,
      source_authority: "untrusted-phase-declarations",
    }) as HostControllerInspection;
    // All awaited cleanup precedes final original-window delivery. It cannot be swallowed
    // in finally while an already selected return value escapes after original expiry.
    await engine(directory, ["image", "rm", baseTag], window);
    baseOffered = false;
    window.capture(() => rmSync(allocatedDirectory, { recursive: true, force: true }));
    window.check();
    images.set(cap, { image, tag, closure, inspection });
    delivered = true;
    return cap;
  } catch {
    window.stop();
    throw new Error(failure);
  } finally {
    // Tags are ours; never remove a shared immutable image ID or any pre-existing tag.
    window.stop();
    if (directory !== undefined) {
      if (baseOffered) await removeOwned(directory, "image", baseTag);
      if (outputOffered && !delivered) await removeOwned(directory, "image", tag);
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* Owned cleanup. */
      }
    }
  }
}
function materializePhase(
  directory: string,
  files: Record<string, Buffer>,
  window: Window,
  ownership: OwnedDirectory[],
): string {
  window.capture(() => mkdirSync(directory, { mode: 0o700 }));
  const entries: [string, string, number][] = [];
  for (const [name, bytes] of Object.entries(files)) {
    writeOwned(join(directory, name), bytes, window, 0o444);
    entries.push([name, controllerDigest(bytes), bytes.length]);
  }
  // Bind roots are internally owned. Container UID can read them; no public caller path is
  // mounted. Only these exact reviewed YAML/template/data files exist, never Python plugins.
  const directories = new Set<string>([directory]);
  for (const name of Object.keys(files))
    for (
      let path = dirname(join(directory, name));
      path.startsWith(directory);
      path = dirname(path)
    ) {
      directories.add(path);
      if (path === directory) break;
    }
  for (const path of directories)
    window.capture(() => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd);
        ownership.push({ path, dev: info.dev, ino: info.ino });
        window.check();
        fchmodSync(fd, 0o555);
        window.check();
      } finally {
        closeSync(fd);
      }
    });
  entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return controllerDigest(Buffer.from(JSON.stringify(entries)));
}
function encodeFrame(value: object): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  valid(data.length > 0 && data.length <= 32768);
  const header = Buffer.alloc(8);
  header.write("HCP1");
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
function offer(child: ChildProcessWithoutNullStreams, value: object, window: Window): void {
  const bytes = window.capture(() => encodeFrame(value));
  method(child, "stdin", "write", [bytes], window);
}
function receive(
  child: ChildProcessWithoutNullStreams,
  window: Window,
  accepted?: () => void,
): Promise<{ value: Record<string, unknown> }> {
  const task = new Promise<{ value: Record<string, unknown> }>((resolveTask, reject) => {
    let data = Buffer.alloc(0),
      settled = false;
    const refuse = () => {
      if (settled) return;
      settled = true;
      window.stop();
      reject(new Error(failure));
    };
    const handler = (raw: unknown) => {
      try {
        window.check();
        valid(!settled);
        const bytes = controllerBytes(raw, 32776);
        data = Buffer.concat([data, bytes]);
        valid(data.length <= 32776);
        if (data.length < 8) return;
        valid(data.subarray(0, 4).toString() === "HCP1");
        const size = data.readUInt32BE(4);
        valid(size > 0 && size <= 32768 && data.length <= size + 8);
        if (data.length === size + 8) {
          const result = window.capture(() => controllerJson(data.subarray(8))) as Record<
            string,
            unknown
          >;
          settled = true;
          method(child, "stdout", "off", ["data", handler], window);
          if (accepted) window.capture(accepted);
          window.check();
          resolveTask(boxed(result));
        }
      } catch {
        refuse();
      }
    };
    method(child, "stdout", "on", ["data", handler], window);
    method(child, "stdout", "once", ["end", refuse], window);
    method(child, "child", "once", ["error", refuse], window);
  });
  drain(task);
  return window.wait(task);
}
function fixedMounts(
  directory: string,
  configuration: string,
  release: string,
  window: Window,
): string[] {
  const mounts: string[] = [];
  for (const [file, text] of [
    ["hosts", "127.0.0.1 localhost\n::1 localhost\n"],
    ["hostname", "tarubot-controller\n"],
    ["resolv.conf", ""],
  ]) {
    valid(file !== undefined && text !== undefined);
    const path = join(directory, "runtime", file);
    writeOwned(path, Buffer.from(text), window, 0o444);
    mounts.push("--mount", `type=bind,source=${path},target=/etc/${file},readonly`);
  }
  mounts.push(
    "--mount",
    `type=bind,source=${configuration},target=/phase/config,readonly`,
    "--mount",
    `type=bind,source=${release},target=/phase/release,readonly`,
  );
  return mounts;
}
/** Inspect exact actual engine configuration, not a child-supplied mount/options report. */
async function verifyRuntime(state: ChildState, window: Window): Promise<void> {
  const result = await engine(state.directory, ["container", "inspect", state.name], window);
  const list = window.capture(() => controllerJson(result.value.stdout)) as Record<
    string,
    unknown
  >[];
  valid(Array.isArray(list) && list.length === 1);
  const item = list[0];
  valid(item);
  const config = item.Config as Record<string, unknown>,
    host = item.HostConfig as Record<string, unknown>;
  const runtimeState = item.State as Record<string, unknown>;
  valid(
    runtimeState.Running === true && runtimeState.Paused === false && runtimeState.Dead === false,
  );
  valid(
    item.Image === state.image.image &&
      config.User === pins.runtime.user &&
      config.Hostname === pins.runtime.hostname &&
      config.Tty === false &&
      config.WorkingDir === "/" &&
      JSON.stringify(config.Entrypoint) === JSON.stringify(pins.runtime.entrypoint) &&
      (config.Cmd === undefined || config.Cmd === null || JSON.stringify(config.Cmd) === "[]") &&
      item.Path === pins.runtime.entrypoint[0] &&
      JSON.stringify(item.Args) === JSON.stringify(pins.runtime.entrypoint.slice(1)),
  );
  valid(
    host.ReadonlyRootfs === true &&
      host.NetworkMode === "none" &&
      host.Privileged === false &&
      host.Init !== true &&
      host.PidMode === "" &&
      host.IpcMode === "private" &&
      host.UTSMode === "" &&
      host.CgroupnsMode === "private" &&
      host.Memory === pins.runtime.memory_limit &&
      host.PidsLimit === pins.runtime.pids_limit &&
      host.NanoCpus === 1_000_000_000 &&
      host.ShmSize === pins.runtime.shm_limit &&
      JSON.stringify(host.CapDrop) === '["ALL"]' &&
      JSON.stringify(host.CapAdd ?? null) === "null" &&
      JSON.stringify(host.SecurityOpt) === '["no-new-privileges"]' &&
      JSON.stringify(host.LogConfig) === '{"Type":"none","Config":{}}',
  );
  const mounts = item.Mounts as Record<string, unknown>[];
  valid(Array.isArray(mounts));
  const expected = new Map([
    ["/phase/config", join(state.directory, "configuration")],
    ["/phase/release", join(state.directory, "release")],
    ["/etc/hosts", join(state.directory, "runtime/hosts")],
    ["/etc/hostname", join(state.directory, "runtime/hostname")],
    ["/etc/resolv.conf", join(state.directory, "runtime/resolv.conf")],
  ]);
  valid(mounts.length === expected.size);
  for (const mount of mounts) {
    valid(
      typeof mount.Destination === "string" &&
        expected.get(mount.Destination) === mount.Source &&
        mount.Type === "bind" &&
        mount.RW === false &&
        mount.Propagation === "rprivate",
    );
    expected.delete(mount.Destination);
  }
  const tmpfs = host.Tmpfs as Record<string, unknown>;
  valid(
    Object.keys(tmpfs).length === 1 &&
      tmpfs["/run/tarubot"] === "rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=10000,gid=10000",
  );
  window.check();
}
/** Declared source trees are copied and measured, but have no authenticated Git provenance. */
export async function prepareOwnedHostController(
  artifact: BuiltHostController,
  input: HostControllerPhaseInput,
  refusal?: () => unknown,
): Promise<PausedHostController> {
  entry(artifact);
  const image = images.get(artifact);
  valid(image);
  const window = new Window(60_000, refusal);
  let directory: string | undefined;
  const nonce = randomBytes(32).toString("hex"),
    name = `tarubot-controller-${randomBytes(16).toString("hex")}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let state: ChildState | undefined,
    launchOffered = false,
    disposal: Promise<void> | undefined;
  const ownership: OwnedDirectory[] = [];
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      if (state) {
        state.stopped = true;
        state.phase = "stopped";
        state.unwatch();
      }
      if (child) kill(child);
      if (launchOffered) {
        valid(directory);
        valid(await removeOwned(directory, "container", name));
      }
      try {
        if (directory !== undefined) removePrivatePhaseTree(directory, ownership);
      } catch {
        /* Owned private tree only. */
      }
    })();
    drain(disposal);
    return disposal;
  };
  window.onStop(dispose);
  try {
    window.capture(() =>
      privateRoot((owned) => {
        directory = owned;
      }),
    );
    valid(directory);
    const allocatedDirectory = directory;
    const captured = phase(input, window);
    const configuration_sha256 = materializePhase(
      join(directory, "configuration"),
      captured.configuration,
      window,
      ownership,
    );
    const release_sha256 = materializePhase(
      join(directory, "release"),
      captured.release,
      window,
      ownership,
    );
    // Reopen actual immutable software bytes before launch; this is software validation,
    // never a refreshed host/owner/current-job proof or a caller digest approval.
    await engine(
      directory,
      ["image", "save", "--output", join(directory, "image.tar"), image.image],
      window,
    );
    window.capture(() => {
      const reopened = verifyControllerImage(
        ownedRead(join(allocatedDirectory, "image.tar"), 512 * 1024 * 1024, window),
        image.closure,
      );
      valid(reopened.native_image_ids.includes(image.image));
    });
    const mounts = fixedMounts(
      directory,
      join(directory, "configuration"),
      join(directory, "release"),
      window,
    );
    const prior = await engine(
      directory,
      ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      window,
    );
    valid(prior.value.stdout.length === 0);
    const config = join(directory, "docker-config");
    window.capture(() => mkdirSync(config, { recursive: true, mode: 0o700 }));
    const args = [
      "--host",
      socket,
      "--config",
      config,
      "run",
      "--rm",
      "--name",
      name,
      "--pull=never",
      "--read-only",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=10000:10000",
      "--ipc=private",
      "--cgroupns=private",
      "--hostname=tarubot-controller",
      "--pids-limit=64",
      "--memory=512m",
      "--cpus=1",
      "--shm-size=16m",
      "--log-driver=none",
      "--tmpfs",
      " /run/tarubot:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=10000,gid=10000".trim(),
      ...mounts,
      "-i",
      image.image,
    ];
    const env = environment(directory);
    window.capture(() => {
      window.check();
      launchOffered = true;
      child = nativeSpawn(executable, args, {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const accepted = child;
      try {
        ownedErrors(accepted, () => window.stop());
      } finally {
        window.onStop(() => kill(accepted));
      }
      window.check();
    });
    valid(child);
    let stderr = 0;
    const process = child;
    method(
      process,
      "stderr",
      "on",
      [
        "data",
        (raw: unknown) => {
          try {
            window.check();
            stderr += controllerBytes(raw, 65536).length;
            valid(stderr <= 65536);
          } catch {
            window.stop();
            kill(process);
          }
        },
      ],
      window,
    );
    for (const surface of ["stdin", "stdout", "stderr"] as const)
      method(process, surface, "on", ["error", () => window.stop()], window);
    method(process, "child", "on", ["error", () => window.stop()], window);
    const stoppedPromise = new Promise<void>((resolveStopped) =>
      method(
        process,
        "child",
        "once",
        [
          "close",
          () => {
            resolveStopped();
            if (state?.phase !== "stopping") window.stop();
          },
        ],
        window,
      ),
    );
    const inspection = Object.freeze({
      schema: 1,
      kind: "paused",
      platform: "linux/amd64",
      rootfs_sha256: image.closure.rootfs_sha256,
      recipe_sha256: image.closure.recipe_sha256,
      configuration_sha256,
      release_sha256,
      declaration: captured.declaration,
      source_authority: "untrusted-phase-declarations",
      worker_origin: "native-pidfd-scm-credentials",
      descendant_isolation: true,
    }) as HostControllerInspection;
    state = {
      window,
      directory,
      image,
      process,
      nonce,
      name,
      inspection,
      stopped: false,
      unwatch: () => {},
      stoppedPromise,
      dispose,
      stopOperation: undefined,
      phase: "preparing",
    };
    state.unwatch = window.watch(() => {
      void dispose();
    });
    const unsolicited = () => {
      if (state?.phase === "validating" || state?.phase === "paused") window.stop();
    };
    method(process, "stdout", "on", ["end", unsolicited], window);
    method(process, "stdout", "on", ["data", unsolicited], window);
    offer(
      process,
      {
        schema: 1,
        kind: "prepare",
        nonce,
        recipe_sha256: image.closure.recipe_sha256,
        rootfs_sha256: image.closure.rootfs_sha256,
        configuration_sha256,
        release_sha256,
      },
      window,
    );
    const reply = await receive(process, window, () => {
      valid(state);
      state.phase = "validating";
    });
    window.capture(() => {
      const output = reply.value;
      fields(output, [
        "schema",
        "kind",
        "nonce",
        "recipe_sha256",
        "configuration_sha256",
        "release_sha256",
        "worker_origin",
        "descendant_isolation",
        "paused",
      ]);
      valid(
        output.schema === 1 &&
          output.kind === "prepared" &&
          output.nonce === nonce &&
          output.recipe_sha256 === image.closure.recipe_sha256 &&
          output.configuration_sha256 === configuration_sha256 &&
          output.release_sha256 === release_sha256 &&
          output.worker_origin === "native-pidfd-scm-credentials" &&
          output.descendant_isolation === true &&
          output.paused === true,
      );
    });
    await verifyRuntime(state, window);
    window.check();
    state.phase = "paused";
    const cap = Object.freeze(Object.create(null)) as PausedHostController;
    children.set(cap, state);
    return cap;
  } catch {
    window.stop();
    await dispose();
    throw new Error(failure);
  }
}
async function cleanup(state: ChildState): Promise<void> {
  state.window.stop();
  await state.dispose();
}
export function inspectOwnedHostController(
  value: BuiltHostController | PausedHostController,
): HostControllerInspection {
  entry(value);
  const image = images.get(value);
  if (image) return image.inspection;
  const child = children.get(value);
  valid(child);
  child.window.check();
  valid(!child.stopped && child.phase === "paused");
  return child.inspection;
}
export async function stopOwnedHostController(value: PausedHostController): Promise<void> {
  entry(value);
  const state = children.get(value);
  valid(state);
  if (state.stopped) {
    await state.dispose();
    return;
  }
  if (state.stopOperation) {
    await state.stopOperation;
    return;
  }
  // Reserve before protocol/callback hooks. Concurrent callers share one owned stop.
  state.phase = "stopping";
  state.stopOperation = (async () => {
    try {
      const reply = receive(state.process, state.window);
      offer(state.process, { schema: 1, kind: "stop", nonce: state.nonce }, state.window);
      const response = await reply;
      state.window.capture(() => {
        fields(response.value, ["schema", "kind", "nonce"]);
        valid(
          response.value.schema === 1 &&
            response.value.kind === "stopped" &&
            response.value.nonce === state.nonce,
        );
      });
      await state.window.wait(state.stoppedPromise);
    } catch {
      /* Stopping never restores or delivers authority. */
    } finally {
      await cleanup(state);
    }
  })();
  drain(state.stopOperation);
  await state.stopOperation;
}
